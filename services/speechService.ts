
import { Rule, RuleType, AudioChunkMetadata, PlaybackMetadata } from '../types';
import { getDriveAudioObjectUrl, revokeObjectUrl } from "../services/driveService";
import { trace, traceError } from '../utils/trace';

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
  private syncCallback: ((meta: PlaybackMetadata) => void) | null = null;
  private onFetchStateChange: ((isFetching: boolean) => void) | null = null;
  private sessionToken: number = 0;
  private context: { bookId: string; chapterId: string } | null = null;
  private audioEventsBound = false;
  
  // Track time manually to prevent browser GC resetting playhead on mobile
  private lastKnownTime: number = 0;
  private lastSaveTime: number = 0;
  private lastThrottleTime: number = 0;

  // Highlight buffer to account for synthesis pauses and speech pacing (0.5s for smoother transition)
  private readonly HIGHLIGHT_DELAY_SEC = 0.5;

  constructor() {
    this.audio = new Audio();
    this.audio.volume = 1.0;
    this.audio.preload = 'auto'; // Ensure metadata loads
    this.setupAudioListeners();
  }

  // Register a persistent callback for UI updates
  public setSyncCallback(cb: ((meta: PlaybackMetadata) => void) | null) {
    this.syncCallback = cb;
  }

  public setFetchStateListener(cb: (isFetching: boolean) => void) { this.onFetchStateChange = cb; }
  public updateMetadata(textLen: number, introDurSec: number, chunkMap: AudioChunkMetadata[]) {
    this.currentTextLength = textLen;
    this.currentIntroDurSec = introDurSec;
    this.currentChunkMap = chunkMap || null;
  }

  setContext(ctx: { bookId: string; chapterId: string } | null) {
    if (this.context && (this.context.chapterId !== ctx?.chapterId)) this.saveProgress();
    this.context = ctx;
  }

  get currentContext() { return this.context; }
  get hasAudioSource() { return !!this.audio.src && this.audio.src !== '' && this.audio.src !== window.location.href; }

  private setupAudioListeners() {
    if (!this.audioEventsBound) {
      const events = ['loadstart', 'loadedmetadata', 'canplay', 'canplaythrough', 'play', 'playing', 'pause', 'seeking', 'seeked', 'waiting', 'stalled', 'ended', 'error', 'abort', 'emptied'];
      events.forEach(e => {
        this.audio.addEventListener(e, (evt) => {
          if (e === 'error') {
            traceError(`audio:event:${e}`, this.audio.error);
          } else if (e !== 'timeupdate') {
            // Uncomment for super verbose debug
            // trace(`audio:event:${e}`, { t: this.audio.currentTime, ready: this.audio.readyState });
          }
        });
      });
      this.audioEventsBound = true;
    }

    this.audio.onended = () => {
      trace('audio:ended');
      this.lastKnownTime = this.audio.duration || this.lastKnownTime;
      this.saveProgress(true);
      this.stopSyncLoop();
      if (this.onEndCallback) setTimeout(() => this.onEndCallback?.(), 0);
    };
    this.audio.onplay = () => { 
      trace('audio:onplay', { t: this.audio.currentTime });
      this.applyRequestedSpeed(); 
      this.startSyncLoop(); 
      if (this.onFetchStateChange) this.onFetchStateChange(false);
      
      // Force immediate sync update
      if (this.syncCallback && this.audio.duration) {
         this.syncCallback({ currentTime: this.audio.currentTime, duration: this.audio.duration, charOffset: this.getOffsetFromTime(this.audio.currentTime, this.audio.duration) });
      }
    };
    this.audio.onpause = () => { 
      trace('audio:onpause', { t: this.audio.currentTime });
      this.lastKnownTime = this.audio.currentTime;
      this.saveProgress(); 
      this.stopSyncLoop(); 
    };
    this.audio.ontimeupdate = () => { 
      // Keep track of time locally to survive browser aggressive memory management
      const t = this.audio.currentTime;
      if (t > 0) this.lastKnownTime = t;
      
      const now = Date.now();
      // Throttle saves to every 2 seconds
      if (now - this.lastSaveTime > 2000) {
        this.saveProgress(); 
        this.lastSaveTime = now;
      }

      // Fallback sync for mobile / non-autoplay transitions
      // Throttle to ~10fps (100ms) to avoid overwhelming main thread
      if (this.syncCallback && this.audio.duration && !this.audio.paused) {
        if (now - this.lastThrottleTime > 100) {
          const dur = this.audio.duration;
          this.syncCallback({
            currentTime: t,
            duration: dur,
            charOffset: this.getOffsetFromTime(t, dur),
          });
          this.lastThrottleTime = now;
        }
      }
    };
    this.audio.onerror = () => { 
      traceError('audio:onerror', this.audio.error);
      if (this.onFetchStateChange) this.onFetchStateChange(false); 
    };
  }

  private applyRequestedSpeed() {
    this.audio.defaultPlaybackRate = this.requestedSpeed;
    this.audio.playbackRate = this.requestedSpeed;
  }

  public saveProgress(completed: boolean = false) {
    if (!this.context) return;
    
    // Safety: If audio.currentTime reports 0 but we have a significant lastKnownTime, use that.
    let curTime = this.audio.currentTime;
    if ((curTime === 0 || isNaN(curTime)) && this.lastKnownTime > 1 && !completed) {
      curTime = this.lastKnownTime;
    }

    const duration = (isFinite(this.audio.duration) && this.audio.duration > 0) ? this.audio.duration : 0;
    
    // Even if duration is unknown (0), save the timestamp if we have progress
    if (duration === 0 && curTime === 0 && !completed) return; 
    
    const isEnd = completed || (duration > 0 && curTime >= duration - 0.5);
    const finalTime = isEnd ? duration : Math.min(curTime, duration || Infinity);
    const percent = duration > 0 ? Math.min(1, Math.max(0, finalTime / duration)) : (isEnd ? 1 : 0);
    
    // Safety: Don't overwrite valid progress with 0 unless we are at the very start
    if (finalTime === 0 && !isEnd && this.lastKnownTime > 5) return;

    const storeRaw = localStorage.getItem(PROGRESS_STORE_V4);
    const store = storeRaw ? JSON.parse(storeRaw) : {};
    if (!store[this.context.bookId]) store[this.context.bookId] = {};
    
    const existing = store[this.context.bookId][this.context.chapterId];
    const wasCompleted = existing?.completed || false;
    
    store[this.context.bookId][this.context.chapterId] = { 
      timeSec: finalTime, 
      durationSec: duration > 0 ? duration : (existing?.durationSec || 0), 
      percent, 
      completed: isEnd || wasCompleted, 
      updatedAt: Date.now() 
    };
    
    localStorage.setItem(PROGRESS_STORE_V4, JSON.stringify(store));
    window.dispatchEvent(new CustomEvent('talevox_progress_updated', { detail: this.context }));
  }

  private startSyncLoop() {
    const sync = () => {
      if (this.syncCallback && this.audio.duration && !this.audio.paused) {
        const t = this.audio.currentTime;
        this.syncCallback({ currentTime: t, duration: this.audio.duration, charOffset: this.getOffsetFromTime(t, this.audio.duration) });
      }
      this.rafId = requestAnimationFrame(sync);
    };
    this.stopSyncLoop();
    this.rafId = requestAnimationFrame(sync);
  }

  public getOffsetFromTime(t: number, dur?: number): number {
    const duration = dur || this.audio.duration || 0;
    const effectiveIntroEnd = this.currentIntroDurSec > 0 ? (this.currentIntroDurSec + this.HIGHLIGHT_DELAY_SEC) : 0;
    
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
    token: string, fileId: string, totalContentChars: number, introDurSec: number, chunkMap: AudioChunkMetadata[] | undefined, startTimeSec = 0, playbackRate = 1.0, onEnd: () => void, onSync: ((meta: PlaybackMetadata) => void) | null, localUrl?: string, onPlayStart?: () => void
  ) {
    this.sessionToken++;
    const session = this.sessionToken;
    const isCurrentSession = () => this.sessionToken === session;

    trace('audio:load:start', { fileId: fileId || localUrl, startTimeSec, session });

    this.requestedSpeed = playbackRate;
    
    // Explicit reset
    this.audio.pause();
    this.audio.removeAttribute("src");
    this.audio.src = "";
    
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

      const storeRaw = localStorage.getItem(PROGRESS_STORE_V4);
      const store = storeRaw ? JSON.parse(storeRaw) : {};
      const saved = this.context ? store[this.context.bookId]?.[this.context.chapterId] : null;
      
      let resumeTime = startTimeSec;
      if (saved?.completed) {
        resumeTime = 0; 
      } else if (saved?.timeSec > 0) {
        resumeTime = saved.timeSec;
      }

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
         // We allow the app to handle this via catch rethrow, but we should probably 
         // NOT treat it as a hard failure that needs full reset, just a pause state.
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

  public seekToTime(seconds: number) {
    if (!isFinite(seconds) || seconds < 0) return;
    this.lastKnownTime = Math.min(seconds, this.audio.duration || Infinity);
    
    if (this.audio.duration > 0) {
      this.audio.currentTime = this.lastKnownTime;
      this.syncCallback?.({ currentTime: this.audio.currentTime, duration: this.audio.duration, charOffset: this.getOffsetFromTime(this.audio.currentTime) });
      this.saveProgress();
    }
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
    
    this.lastKnownTime = targetTime;
    this.audio.currentTime = targetTime;
    this.syncCallback?.({ currentTime: targetTime, duration, charOffset: offset });
    this.saveProgress(); 
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
    this.saveProgress();
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
    this.saveProgress();
    this.sessionToken++;
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
    this.saveProgress();
    this.sessionToken++;
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