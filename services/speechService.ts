
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
  private intervalId: any = null; // For mobile smoothing loop
  
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
  
  // Smoothing State
  private renderedOffset: number = 0;
  private targetOffset: number = 0;
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
    
    // Restart loop if playing to switch strategies
    if (this.audio.src && !this.audio.paused) {
      this.stopSyncLoop();
      this.startSyncLoop();
    }
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
    this.renderedOffset = 0;
    this.targetOffset = 0;
  }

  setContext(ctx: { bookId: string; chapterId: string } | null) {
    this.context = ctx;
  }

  get currentContext() { return this.context; }
  get hasAudioSource() { return !!this.audio.src && this.audio.src !== '' && this.audio.src !== window.location.href; }

  private setupAudioListeners() {
    if (!this.audioEventsBound) {
      const events = ['loadstart', 'loadedmetadata', 'canplay', 'canplaythrough', 'play', 'playing', 'pause', 'waiting', 'stalled', 'ended', 'error', 'abort', 'emptied'];
      
      this.audio.addEventListener('seeking', () => trace('audio:event:seeking', { t: this.audio.currentTime }));
      this.audio.addEventListener('seeked', () => {
        trace('audio:event:seeked', { t: this.audio.currentTime });
        // On seek, jump smoothing instantly
        this.updateTargetOffset(this.audio.currentTime);
        this.renderedOffset = this.targetOffset; 
        this.emitSyncTick(); 
      });
      
      events.forEach(e => {
        this.audio.addEventListener(e, (evt) => {
          if (e === 'error') {
            traceError(`audio:event:${e}`, this.audio.error);
          }
        });
      });
      this.audioEventsBound = true;
    }

    this.audio.onended = () => {
      trace('audio:ended');
      this.lastKnownTime = this.audio.duration || this.lastKnownTime;
      // Mark completed in the emit
      this.renderedOffset = this.currentTextLength; // Force full progress visually
      this.emitSyncTick(true);
      this.stopSyncLoop();
      if (this.onEndCallback) setTimeout(() => this.onEndCallback?.(), 0);
    };
    this.audio.onplay = () => { 
      trace('audio:onplay', { t: this.audio.currentTime });
      this.applyRequestedSpeed(); 
      this.startSyncLoop(); 
      if (this.onFetchStateChange) this.onFetchStateChange(false);
      this.emitSyncTick();
    };
    this.audio.onpause = () => { 
      trace('audio:onpause', { t: this.audio.currentTime });
      this.lastKnownTime = this.audio.currentTime;
      this.emitSyncTick(); 
      this.stopSyncLoop(); 
    };
    
    // Use timeupdate to drive the target offset, serving as a "clock nudge"
    this.audio.ontimeupdate = () => { 
      const t = this.audio.currentTime;
      if (t > 0) this.lastKnownTime = t;
      this.updateTargetOffset(t);
    };
    
    this.audio.onerror = () => { 
      traceError('audio:onerror', this.audio.error);
      if (this.onFetchStateChange) this.onFetchStateChange(false); 
    };
  }

  // --- Smoothing Logic ---
  
  private updateTargetOffset(time: number) {
    this.targetOffset = this.getOffsetFromTime(time, this.audio.duration);
  }

  // Called frequently (by rAF or Interval) to interpolate renderedOffset
  private smoothTick(deltaMs: number) {
    if (!this.syncCallback) return;
    
    // 1. If in intro, stay at 0
    if (this.audio.currentTime < this.currentIntroDurSec) {
        this.renderedOffset = 0;
        this.emitSyncTick();
        return;
    }

    // 2. If jumped backward (loop/seek), snap instantly
    if (this.targetOffset < this.renderedOffset) {
        this.renderedOffset = this.targetOffset;
    } 
    // 3. Otherwise, smooth forward
    else if (this.targetOffset > this.renderedOffset) {
        const diff = this.targetOffset - this.renderedOffset;
        
        // Estimate chars per second
        const contentDur = Math.max(1, (this.audio.duration || 0) - this.currentIntroDurSec);
        const cps = this.currentTextLength / contentDur;
        
        // Allowed step: proportional to speed, clamped to avoid jumps
        // Slightly fast (1.5x) to catch up if lagging
        const maxStep = Math.max(1, cps * (deltaMs / 1000) * this.requestedSpeed * 1.5);
        
        // Move towards target, but don't overshoot
        const step = Math.min(diff, Math.max(1, maxStep));
        this.renderedOffset += step;
    }
    
    this.emitSyncTick();
  }

  public emitSyncTick(completed = false) {
    if (this.syncCallback) {
       this.syncCallback({ 
           currentTime: this.audio.currentTime, 
           duration: this.audio.duration, 
           charOffset: Math.floor(this.renderedOffset), // Emit smoothed value
           textLength: this.currentTextLength,
           completed
       });
    }
  }

  private applyRequestedSpeed() {
    this.audio.defaultPlaybackRate = this.requestedSpeed;
    this.audio.playbackRate = this.requestedSpeed;
  }

  public saveProgress(completed: boolean = false) {
     this.emitSyncTick(completed);
  }

  private startSyncLoop() {
    this.stopSyncLoop();
    
    // Always use interval for smoothing logic, even on desktop, to decouple render from audio events
    // 20fps (50ms) is good balance of smoothness and battery
    this.intervalId = setInterval(() => {
        if (!this.audio.paused) {
            this.smoothTick(50);
        }
    }, 50);
  }

  private stopSyncLoop() {
    if (this.rafId !== null) { cancelAnimationFrame(this.rafId); this.rafId = null; }
    if (this.intervalId !== null) { clearInterval(this.intervalId); this.intervalId = null; }
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
    this.seekNonce++; 
    const session = this.sessionToken;
    const isCurrentSession = () => this.sessionToken === session;

    trace('audio:load:start', { fileId: fileId || localUrl, startTimeSec, session });

    this.requestedSpeed = playbackRate;
    
    this.audio.pause();
    this.audio.removeAttribute("src");
    this.audio.src = "";
    this.audio.load();
    
    if (!localUrl) revokeObjectUrl(this.currentBlobUrl);
    this.currentBlobUrl = null;
    
    this.onEndCallback = onEnd;
    this.onPlayStartCallback = onPlayStart || null;
    
    if (onSync) this.syncCallback = onSync;
    
    this.currentTextLength = totalContentChars;
    this.currentIntroDurSec = introDurSec;
    this.currentChunkMap = chunkMap || null;
    this.lastKnownTime = startTimeSec;
    // Reset offset smoothing
    this.renderedOffset = 0;
    this.targetOffset = 0;

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
      
      await this.waitForEvent(this.audio, 'loadedmetadata', 8000, isCurrentSession);

      let resumeTime = startTimeSec;
      
      if (isFinite(this.audio.duration)) {
         resumeTime = Math.min(resumeTime, Math.max(0, this.audio.duration - 0.5));
      }

      if (resumeTime > 0) {
         trace('audio:seeking', { resumeTime });
         this.audio.currentTime = resumeTime;
         this.lastKnownTime = resumeTime;
         // Pre-calculate target offset so highlight starts correctly
         this.updateTargetOffset(resumeTime);
         this.renderedOffset = this.targetOffset;
         await this.waitForEvent(this.audio, 'seeked', 6000, isCurrentSession);
      }

      if (this.onPlayStartCallback) {
         this.onPlayStartCallback();
         this.onPlayStartCallback = null;
      }

      try {
        await this.audio.play();
      } catch (e: any) {
        if (e.name === 'NotAllowedError') {
           throw new Error('Playback blocked');
        }
        throw e;
      }
      
      this.applyRequestedSpeed();
      trace('audio:load:success');

    } catch (err: any) {
      if (err.name === 'NotAllowedError' || err.message === 'Playback blocked') {
         trace('audio:load:interaction_required');
         throw err; 
      }
      if (err.message === 'Playback session preempted') {
         trace('audio:load:preempted');
         return; 
      }
      traceError('audio:load:failed', err);
      this.audio.src = ""; 
      throw err;
    } finally {
      if (this.onFetchStateChange) this.onFetchStateChange(false);
    }
  }

  // --- Mobile Safe Play ---
  public async safePlay(): Promise<'playing' | 'blocked'> {
    if (!this.audio.src) throw new Error('No audio source');
    try {
      await this.audio.play();
      this.applyRequestedSpeed();
      return 'playing';
    } catch (err: any) {
      if (err.name === 'NotAllowedError') {
        return 'blocked';
      }
      throw err;
    }
  }

  // --- Robust SeekTo ---
  public async seekTo(targetSec: number): Promise<void> {
    const audio = this.audio;
    const nonce = ++this.seekNonce;

    if (!Number.isFinite(audio.duration) || audio.duration <= 0) {
        if (!audio.src) throw new Error("No audio source to seek");
        trace('audio:seek:waiting_metadata', { nonce });
        try {
            await this.waitForAudioEvent('loadedmetadata', 6000, nonce);
        } catch (e) {
            if (nonce !== this.seekNonce) return; 
            throw e;
        }
    }

    if (nonce !== this.seekNonce) return;

    const dur = audio.duration;
    const clamped = Math.min(Math.max(targetSec, 0), Math.max(dur - 0.05, 0));
    
    trace('audio:seek:start', { to: clamped, nonce });

    audio.currentTime = clamped;
    this.lastKnownTime = clamped;
    
    // Snap highlight instantly
    this.updateTargetOffset(clamped);
    this.renderedOffset = this.targetOffset;
    this.emitSyncTick();

    try {
        await this.waitForAudioEvent('seeked', 5000, nonce);
    } catch (e) {
        if (nonce !== this.seekNonce) return;
        traceError('audio:seek:converge_failed_but_proceeding', { actual: audio.currentTime, target: clamped });
    }

    if (nonce !== this.seekNonce) return;
    this.emitSyncTick();
  }

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

  speak(text: string, voiceName: string | undefined, rate: number, offset: number, onEnd: () => void, isIntro: boolean = false) {
    this.audio.pause();
    this.stopSyncLoop();
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
      if (this.audio.currentTime === 0 && this.lastKnownTime > 0) {
        this.audio.currentTime = this.lastKnownTime;
      }
      this.audio.play().catch(e => traceError('resume:error', e)); 
    } 
    window.speechSynthesis.resume(); 
  }
  
  stop() {
    this.sessionToken++;
    this.seekNonce++;
    this.stopSyncLoop();
    this.audio.pause();
    this.audio.removeAttribute("src");
    revokeObjectUrl(this.currentBlobUrl);
    this.currentBlobUrl = null;
    this.lastKnownTime = 0;
    this.renderedOffset = 0;
    if (this.onFetchStateChange) this.onFetchStateChange(false);
    window.speechSynthesis.cancel();
  }

  safeStop() {
    trace('audio:safeStop');
    this.sessionToken++;
    this.seekNonce++;
    this.stopSyncLoop();
    this.audio.pause();
    this.audio.src = "";
    this.audio.removeAttribute("src");
    this.audio.load();
    revokeObjectUrl(this.currentBlobUrl);
    this.currentBlobUrl = null;
    this.lastKnownTime = 0;
    this.renderedOffset = 0;
    if (this.onFetchStateChange) this.onFetchStateChange(false);
    window.speechSynthesis.cancel();
  }
  
  setPlaybackRate(rate: number) { this.requestedSpeed = rate; if (this.audio.src) this.applyRequestedSpeed(); }
  get isPaused() { return this.audio.paused && !window.speechSynthesis.speaking; }
  get currentTime() { return this.audio.currentTime; }
  get duration() { return this.audio.duration; }
}

export const speechController = new SpeechController();
