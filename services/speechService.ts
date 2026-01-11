import { Rule, RuleType, AudioChunkMetadata, PlaybackMetadata } from '../types';
import { getDriveAudioObjectUrl, revokeObjectUrl } from "../services/driveService";
import { trace, traceError } from '../utils/trace';
import { isMobileMode } from '../utils/platform';

export const PROGRESS_STORE_V4 = 'talevox_progress_v4';

export function applyRules(text: string, rules: Rule[]): string {
  let processedText = text;
  const activeRules = [...rules].filter(r => r.enabled).sort((a, b) => b.priority - a.priority);
  activeRules.forEach(rule => {
    let flags = 'g';
    if (!rule.matchCase) flags += 'i';
    let pattern = rule.matchExpression ? rule.find : rule.find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (rule.wholeWord && !rule.matchExpression) pattern = `\\b${pattern}\\b`;
    try {
      const regex = new RegExp(pattern, flags);
      const replacement = rule.ruleType === RuleType.DELETE ? "" : (rule.speakAs || "");
      processedText = processedText.replace(regex, replacement);
    } catch (e) {}
  });
  return processedText;
}

class SpeechController {
  private audio: HTMLAudioElement;
  private currentBlobUrl: string | null = null;
  private currentTextLength: number = 0;
  private currentIntroDurSec: number = 0;
  private currentChunkMap: AudioChunkMetadata[] | null = null;
  private rafId: number | null = null;
  private requestedSpeed: number = 1.0;
  private onEndCallback: (() => void) | null = null;
  private onPlayStartCallback: (() => void) | null = null;
  private syncCallback: ((meta: PlaybackMetadata & { completed?: boolean }) => void) | null = null;
  private onFetchStateChange: ((isFetching: boolean) => void) | null = null;
  private sessionToken: number = 0;
  private context: { bookId: string; chapterId: string } | null = null;
  private audioEventsBound = false;
  
  // Seek coordination
  private seekNonce = 0;
  
  // Track time manually to prevent browser GC resetting playhead on mobile
  private lastKnownTime: number = 0;
  private lastSaveTime: number = 0;
  private lastThrottleTime: number = 0;
  
  // Dynamic Mobile Mode
  private isMobileOptimized: boolean = false;

  // Highlight buffer to account for synthesis pauses and speech pacing (0.5s for smoother transition)
  private readonly HIGHLIGHT_DELAY_SEC = 0.5;

  constructor() {
    this.audio = new Audio();
    this.audio.volume = 1.0;
    this.audio.preload = 'auto'; // Ensure metadata loads
    // Initialize default mode based on environment
    this.isMobileOptimized = isMobileMode();
    this.setupAudioListeners();
  }

  // Update sync strategy on the fly
  public setMobileMode(isMobile: boolean) {
    if (this.isMobileOptimized === isMobile) return;
    this.isMobileOptimized = isMobile;
    trace('speech:mode_changed', { isMobile });
    
    // If playing, switch strategies immediately
    if (this.audio.src && !this.audio.paused) {
      if (this.isMobileOptimized) {
        this.stopSyncLoop(); // Stop rAF, switch to timeupdate
      } else {
        this.startSyncLoop(); // Start rAF
      }
    }
    // Force immediate update to UI
    this.emitSyncTick();
  }

  // Register a persistent callback for UI updates
  public setSyncCallback(cb: ((meta: PlaybackMetadata & { completed?: boolean }) => void) | null) {
    this.syncCallback = cb;
  }

  public setFetchStateListener(cb: (isFetching: boolean) => void) { this.onFetchStateChange = cb; }
  public updateMetadata(textLen: number, introDurSec: number, chunkMap: AudioChunkMetadata[]) {
    this.currentTextLength = textLen;
    this.currentIntroDurSec = introDurSec;
    this.currentChunkMap = chunkMap || null;
  }

  setContext(ctx: { bookId: string; chapterId: string } | null) {
    // Context switch logic if needed
    this.context = ctx;
  }

  get currentContext() { return this.context; }
  get hasAudioSource() { return !!this.audio.src && this.audio.src !== '' && this.audio.src !== window.location.href; }

  private setupAudioListeners() {
    if (!this.audioEventsBound) {
      const events = ['loadstart', 'loadedmetadata', 'canplay', 'canplaythrough', 'play', 'playing', 'pause', 'waiting', 'stalled', 'ended', 'error', 'abort', 'emptied'];
      
      // Explicit tracing for seek events
      this.audio.addEventListener('seeking', () => trace('audio:event:seeking', { t: this.audio.currentTime }));
      this.audio.addEventListener('seeked', () => {
        trace('audio:event:seeked', { t: this.audio.currentTime });
        this.emitSyncTick(); // Ensure UI updates immediately after seek
      });
      
      events.forEach(e => {
        this.audio.addEventListener(e, (evt) => {
          if (e === 'error') {
            traceError(`audio:event:${e}`, this.audio.error);
          } else {
            // trace(`audio:event:${e}`, { t: this.audio.currentTime, ready: this.audio.readyState });
          }
        });
      });
      this.audioEventsBound = true;
    }

    this.audio.onended = () => {
      trace('audio:ended');
      this.lastKnownTime = this.audio.duration || this.lastKnownTime;
      // Mark completed in the emit
      this.emitSyncTick(true);
      this.stopSyncLoop();
      if (this.onEndCallback) setTimeout(() => this.onEndCallback?.(), 0);
    };
    this.audio.onplay = () => { 
      trace('audio:onplay', { t: this.audio.currentTime });
      this.applyRequestedSpeed(); 
      this.startSyncLoop(); 
      if (this.onFetchStateChange) this.onFetchStateChange(false);
      
      // Force immediate sync update
      this.emitSyncTick();
    };
    this.audio.onpause = () => { 
      trace('audio:onpause', { t: this.audio.currentTime });
      this.lastKnownTime = this.audio.currentTime;
      this.emitSyncTick(); // Force update on pause
      this.stopSyncLoop(); 
    };
    this.audio.ontimeupdate = () => { 
      // Keep track of time locally to survive browser aggressive memory management
      const t = this.audio.currentTime;
      if (t > 0) this.lastKnownTime = t;
      
      const now = Date.now();

      // Mobile Sync Strategy: Use timeupdate instead of rAF to save battery and avoid background throttling
      if (this.isMobileOptimized) {
        if (this.syncCallback && this.audio.duration && !this.audio.paused) {
          // Throttle to ~10fps (100ms) to avoid overwhelming main thread on weak devices
          if (now - this.lastThrottleTime > 100) {
            this.emitSyncTick();
            this.lastThrottleTime = now;
          }
        }
      }
    };
    this.audio.onerror = () => { 
      traceError('audio:onerror', this.audio.error);
      if (this.onFetchStateChange) this.onFetchStateChange(false); 
    };
  }

  public emitSyncTick(completed = false) {
    if (this.syncCallback) {
       this.syncCallback({ 
           currentTime: this.audio.currentTime, 
           duration: this.audio.duration, 
           charOffset: this.getOffsetFromTime(this.audio.currentTime, this.audio.duration),
           textLength: this.currentTextLength,
           completed
       });
    }
  }

  private applyRequestedSpeed() {
    this.audio.defaultPlaybackRate = this.requestedSpeed;
    this.audio.playbackRate = this.requestedSpeed;
  }

  // Deprecated direct save - logic moved to App.tsx via sync callback
  public saveProgress(completed: boolean = false) {
     this.emitSyncTick(completed);
  }

  private startSyncLoop() {
    // Desktop: High precision rAF loop
    // Mobile: Rely on timeupdate (handled in setupAudioListeners) to save battery/resources
    if (this.isMobileOptimized) return;

    const sync = () => {
      if (this.syncCallback && this.audio.duration && !this.audio.paused) {
        this.emitSyncTick();
      }
      this.rafId = requestAnimationFrame(sync);
    };
    this.stopSyncLoop();
    this.rafId = requestAnimationFrame(sync);
  }

  public getOffsetFromTime(t: number, dur?: number): number {
    const duration = dur || this.audio.duration || 0;
    const effectiveIntroEnd = this.currentIntroDurSec > 0 ? (this.currentIntroDurSec + this.HIGHLIGHT_DELAY_SEC) : 0;
    
    // Only move highlighting if we are PAST the intro
    if (duration === 0 || t < effectiveIntroEnd) return 0;
    
    const contentTime = t - effectiveIntroEnd;
    if (this.currentChunkMap && this.currentChunkMap.length > 0) {
      const mapTotalDur = this.currentChunkMap.reduce((acc, c) => acc + c.durSec, 0);
      const totalContentDur = Math.max(0.1, duration - effectiveIntroEnd);
      const scale = totalContentDur / Math.max(0.1, mapTotalDur);
      let cumulativeTime = 0;
      for (const chunk of this.currentChunkMap) {
        const scaledDur = chunk.durSec * scale;
        if (contentTime >= cumulativeTime && contentTime < cumulativeTime + scaledDur) {
          const ratio = (contentTime - cumulativeTime) / Math.max(0.001, scaledDur);
          return Math.max(0, Math.floor(chunk.startChar + (chunk.endChar - chunk.startChar) * ratio));
        }
        cumulativeTime += scaledDur;
      }
    }
    const contentPortion = Math.max(0.001, duration - effectiveIntroEnd);
    return Math.max(0, Math.floor(this.currentTextLength * Math.min(1, contentTime / contentPortion)));
  }

  // --- Robust Event Waiter ---
  private waitForAudioEvent(event: string, timeoutMs: number, nonce: number): Promise<void> {
    return new Promise((resolve, reject) => {
        let timer: any;
        const handler = () => {
            cleanup();
            if (nonce === this.seekNonce) resolve();
            else reject(new Error("Seek cancelled by newer operation"));
        };
        const cleanup = () => {
            clearTimeout(timer);
            this.audio.removeEventListener(event, handler);
        };
        timer = setTimeout(() => {
            cleanup();
            reject(new Error(`Timeout waiting for ${event}`));
        }, timeoutMs);

        // Pre-check
        if (nonce !== this.seekNonce) {
            cleanup();
            reject(new Error("Seek cancelled before wait"));
            return;
        }

        this.audio.addEventListener(event, handler, { once: true });
    });
  }

  // --- Existing waitForEvent (legacy/internal usage) ---
  private waitForEvent(target: EventTarget, event: string, timeoutMs: number, tokenCheck?: () => boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      let timer: any;
      const handler = () => {
        cleanup();
        resolve();
      };
      const cleanup = () => {
        clearTimeout(timer);
        target.removeEventListener(event, handler);
      };
      
      timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timeout waiting for ${event}`));
      }, timeoutMs);

      if (tokenCheck && !tokenCheck()) {
        cleanup();
        return reject(new Error("Playback session preempted"));
      }

      target.addEventListener(event, handler, { once: true });
    });
  }

  async loadAndPlayDriveFile(
    token: string, fileId: string, totalContentChars: number, introDurSec: number, chunkMap: AudioChunkMetadata[] | undefined, startTimeSec = 0, playbackRate = 1.0, onEnd: () => void, onSync: ((meta: PlaybackMetadata & { completed?: boolean }) => void) | null, localUrl?: string, onPlayStart?: () => void
  ) {
    this.sessionToken++;
    this.seekNonce++; // Invalidate pending seeks
    const session = this.sessionToken;
    const isCurrentSession = () => this.sessionToken === session;

    trace('audio:load:start', { fileId: fileId || localUrl, startTimeSec, session });

    this.requestedSpeed = playbackRate;
    
    // Explicit reset
    this.audio.pause();
    this.audio.removeAttribute("src");
    this.audio.src = "";
    this.audio.load(); // Important for mobile buffering reset
    
    if (!localUrl) revokeObjectUrl(this.currentBlobUrl);
    this.currentBlobUrl = null;
    
    this.onEndCallback = onEnd;
    this.onPlayStartCallback = onPlayStart || null;
    
    // Only replace if a specific callback was provided, otherwise respect the persistent one
    if (onSync) this.syncCallback = onSync;
    
    this.currentTextLength = totalContentChars;
    this.currentIntroDurSec = introDurSec;
    this.currentChunkMap = chunkMap || null;
    this.lastKnownTime = startTimeSec;

    if (this.onFetchStateChange) this.onFetchStateChange(true);

    try {
      let url = localUrl;
      if (!url) {
        const res = await getDriveAudioObjectUrl(fileId);
        url = res.url;
      }
      
      if (!isCurrentSession()) { 
        if (!localUrl) revokeObjectUrl(url); 
        trace('audio:load:aborted', { reason: 'stale_session' });
        return; 
      }
      
      this.currentBlobUrl = url || null;
      this.audio.src = url || '';
      this.audio.load();
      
      // Wait for metadata
      await this.waitForEvent(this.audio, 'loadedmetadata', 8000, isCurrentSession);

      // Seek logic has moved to App.tsx / Caller mostly, but if startTimeSec is passed, use it.
      // NOTE: We no longer read from localStorage here. We trust the caller (App.tsx) provided correct startTimeSec.
      
      let resumeTime = startTimeSec;
      
      // Clamp resume time
      if (isFinite(this.audio.duration)) {
         resumeTime = Math.min(resumeTime, Math.max(0, this.audio.duration - 0.5));
      }

      if (resumeTime > 0) {
         trace('audio:seeking', { resumeTime });
         this.audio.currentTime = resumeTime;
         this.lastKnownTime = resumeTime;
         // Only wait for seeked if we actually moved the playhead
         await this.waitForEvent(this.audio, 'seeked', 6000, isCurrentSession);
      }

      if (this.onPlayStartCallback) {
         this.onPlayStartCallback();
         this.onPlayStartCallback = null;
      }

      // Try playing. If it fails due to interaction, it will throw.
      await this.audio.play();
      this.applyRequestedSpeed();
      trace('audio:load:success');

    } catch (err: any) {
      if (err.name === 'NotAllowedError') {
         trace('audio:load:interaction_required');
         throw err; 
      }
      if (err.message === 'Playback session preempted') {
         trace('audio:load:preempted');
         return; // Silent exit
      }
      traceError('audio:load:failed', err);
      // Ensure we don't leave zombie audio loading
      this.audio.src = ""; 
      throw err;
    } finally {
      // CRITICAL: Always clear loading state
      if (this.onFetchStateChange) this.onFetchStateChange(false);
    }
  }

  // --- Robust SeekTo (replaces old logic) ---
  public async seekTo(targetSec: number): Promise<void> {
    const audio = this.audio;
    const nonce = ++this.seekNonce;

    // Ensure we have metadata first
    if (!Number.isFinite(audio.duration) || audio.duration <= 0) {
        if (!audio.src) throw new Error("No audio source to seek");
        trace('audio:seek:waiting_metadata', { nonce });
        try {
            await this.waitForAudioEvent('loadedmetadata', 6000, nonce);
        } catch (e) {
            if (nonce !== this.seekNonce) return; // Silent preemption
            throw e;
        }
    }

    // Check nonce again
    if (nonce !== this.seekNonce) return;

    const dur = audio.duration;
    if (!Number.isFinite(dur) || dur <= 0) throw new Error('seekTo: duration unavailable');

    const clamped = Math.min(Math.max(targetSec, 0), Math.max(dur - 0.05, 0));
    const current = audio.currentTime;

    // NO-OP seek optimization
    if (Math.abs(clamped - current) < 0.05) {
        this.emitSyncTick();
        return;
    }

    trace('audio:seek:start', { from: current, to: clamped, dur, nonce });

    audio.currentTime = clamped;
    this.lastKnownTime = clamped;

    try {
        await this.waitForAudioEvent('seeked', 5000, nonce);
    } catch (e) {
        if (nonce !== this.seekNonce) return;
        
        // Fallback Poll: iOS sometimes swallows 'seeked' event but updates currentTime
        // We poll for convergence to target time
        trace('audio:seek:polling_fallback', { nonce });
        const pollStart = Date.now();
        let converged = false;
        while (Date.now() - pollStart < 800) { // 800ms max poll
            if (Math.abs(audio.currentTime - clamped) < 0.25) {
               converged = true;
               break;
            }
            await new Promise(r => setTimeout(r, 50));
            if (nonce !== this.seekNonce) return;
        }
        
        if (!converged) {
           throw e; // Rethrow timeout if we didn't converge
        }
    }

    if (nonce !== this.seekNonce) return;

    trace('audio:seek:done', { now: audio.currentTime, target: clamped, nonce });
    this.emitSyncTick();
  }

  // Backwards compat / alias
  public async seekToTime(seconds: number): Promise<void> {
      return this.seekTo(seconds);
  }

  public getCurrentTime() {
      return this.audio.currentTime;
  }

  public seekToOffset(offset: number) {
    const duration = this.audio.duration;
    if (!duration || this.currentTextLength <= 0) return;
    
    let targetTime = 0;
    const effectiveIntroEnd = this.currentIntroDurSec > 0 ? (this.currentIntroDurSec + this.HIGHLIGHT_DELAY_SEC) : 0;
    
    if (this.currentChunkMap && this.currentChunkMap.length > 0) {
      const mapTotalDur = this.currentChunkMap.reduce((acc, c) => acc + c.durSec, 0);
      const totalContentDur = Math.max(0.1, duration - effectiveIntroEnd);
      const scale = totalContentDur / Math.max(0.1, mapTotalDur);
      let cumulativeTime = 0;
      for (const chunk of this.currentChunkMap) {
        if (offset >= chunk.startChar && offset <= chunk.endChar) {
          const ratio = (offset - chunk.startChar) / Math.max(1, chunk.endChar - chunk.startChar);
          targetTime = effectiveIntroEnd + cumulativeTime + (ratio * chunk.durSec * scale);
          break;
        }
        cumulativeTime += chunk.durSec * scale;
      }
    } else {
      targetTime = effectiveIntroEnd + (Math.max(0, Math.min(1, offset / this.currentTextLength)) * Math.max(0.001, duration - effectiveIntroEnd));
    }
    
    this.seekTo(targetTime).catch(e => traceError('seek:offset:failed', e));
  }

  private stopSyncLoop() { if (this.rafId !== null) { cancelAnimationFrame(this.rafId); this.rafId = null; } }

  speak(text: string, voiceName: string | undefined, rate: number, offset: number, onEnd: () => void, isIntro: boolean = false) {
    window.speechSynthesis.cancel();
    const executeUtterance = (txt: string, delay: number, callback: () => void) => {
      const utterance = new SpeechSynthesisUtterance(txt);
      const voice = window.speechSynthesis.getVoices().find(v => v.name === voiceName);
      if (voice) utterance.voice = voice;
      utterance.rate = rate;
      utterance.onend = () => { if (delay > 0) setTimeout(callback, delay * 1000); else callback(); };
      window.speechSynthesis.speak(utterance);
    };
    executeUtterance(text, 0, onEnd);
  }

  pause() { 
    this.audio.pause(); 
    this.lastKnownTime = this.audio.currentTime;
    this.emitSyncTick();
    window.speechSynthesis.pause(); 
  }
  
  resume() { 
    if (this.audio.src) { 
      this.applyRequestedSpeed(); 
      // Paranoid Resume: Mobile browsers often lose position.
      if (this.audio.currentTime === 0 && this.lastKnownTime > 0) {
        this.audio.currentTime = this.lastKnownTime;
      }
      this.audio.play().catch(e => traceError('resume:error', e)); 
    } 
    window.speechSynthesis.resume(); 
  }
  
  stop() {
    // Note: Removed saveProgress() call from here to rely on App.tsx commit logic
    this.sessionToken++;
    this.seekNonce++;
    this.stopSyncLoop();
    this.audio.pause();
    this.audio.removeAttribute("src");
    // Don't call .load() on stop/unload on mobile as it might trigger errors if backgrounded
    revokeObjectUrl(this.currentBlobUrl);
    this.currentBlobUrl = null;
    this.lastKnownTime = 0;
    if (this.onFetchStateChange) this.onFetchStateChange(false);
    window.speechSynthesis.cancel();
  }

  // Safe stop ensures we completely reset before starting something new
  safeStop() {
    trace('audio:safeStop');
    // Note: Removed saveProgress() call from here
    this.sessionToken++;
    this.seekNonce++;
    this.stopSyncLoop();
    this.audio.pause();
    this.audio.src = "";
    this.audio.removeAttribute("src");
    this.audio.load(); // Force buffer reset to avoid glitching when starting new chapter
    // Only revoke if we created it
    revokeObjectUrl(this.currentBlobUrl);
    this.currentBlobUrl = null;
    this.lastKnownTime = 0;
    if (this.onFetchStateChange) this.onFetchStateChange(false);
    window.speechSynthesis.cancel();
  }
  
  setPlaybackRate(rate: number) { this.requestedSpeed = rate; if (this.audio.src) this.applyRequestedSpeed(); }
  get isPaused() { return this.audio.paused && !window.speechSynthesis.speaking; }
  get currentTime() { return this.audio.currentTime; }
  get duration() { return this.audio.duration; }
}

export const speechController = new SpeechController();