
import { Rule, RuleType, AudioChunkMetadata } from '../types';
import { getDriveAudioObjectUrl, revokeObjectUrl } from "../services/driveService";

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

export interface PlaybackMetadata {
  currentTime: number;
  duration: number;
  charOffset: number;
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
  private syncCallback: ((meta: PlaybackMetadata) => void) | null = null;
  private onFetchStateChange: ((isFetching: boolean) => void) | null = null;
  private sessionToken: number = 0;
  private context: { bookId: string; chapterId: string } | null = null;
  
  // Track time manually to prevent browser GC resetting playhead on mobile
  private lastKnownTime: number = 0;
  private lastSaveTime: number = 0;

  // Highlight buffer to account for synthesis pauses and speech pacing (350ms -> 600ms)
  private readonly HIGHLIGHT_DELAY_SEC = 0.6;

  constructor() {
    this.audio = new Audio();
    this.audio.volume = 1.0;
    this.audio.preload = 'auto'; // Ensure metadata loads
    this.setupAudioListeners();
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
    this.audio.onended = () => {
      this.lastKnownTime = this.audio.duration || this.lastKnownTime;
      this.saveProgress(true);
      this.stopSyncLoop();
      if (this.onEndCallback) setTimeout(() => this.onEndCallback?.(), 0);
    };
    this.audio.onplay = () => { 
      this.applyRequestedSpeed(); 
      this.startSyncLoop(); 
      if (this.onFetchStateChange) this.onFetchStateChange(false); 
    };
    this.audio.onpause = () => { 
      this.lastKnownTime = this.audio.currentTime;
      this.saveProgress(); 
      this.stopSyncLoop(); 
    };
    this.audio.ontimeupdate = () => { 
      // Keep track of time locally to survive browser aggressive memory management
      const t = this.audio.currentTime;
      if (t > 0) this.lastKnownTime = t;
      
      // Throttle saves to every 2 seconds
      const now = Date.now();
      if (now - this.lastSaveTime > 2000) {
        this.saveProgress(); 
        this.lastSaveTime = now;
      }

      // Fallback sync for mobile / non-autoplay transitions
      // Some mobile browsers throttle requestAnimationFrame; use timeupdate to move the highlight
      if (this.syncCallback && this.audio.duration && (('ontouchstart' in window) || navigator.maxTouchPoints > 0)) {
        const dur = this.audio.duration;
        this.syncCallback({
          currentTime: t,
          duration: dur,
          charOffset: this.getOffsetFromTime(t, dur),
        });
      }
    };
    this.audio.onerror = () => { if (this.onFetchStateChange) this.onFetchStateChange(false); };
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

  async loadAndPlayDriveFile(
    token: string, fileId: string, totalContentChars: number, introDurSec: number, chunkMap: AudioChunkMetadata[] | undefined, startTimeSec = 0, playbackRate = 1.0, onEnd: () => void, onSync: (meta: PlaybackMetadata) => void, localUrl?: string
  ) {
    this.sessionToken++;
    const session = this.sessionToken;
    this.requestedSpeed = playbackRate;
    
    // Explicit reset for mobile browsers
    this.audio.pause();
    this.audio.removeAttribute("src");
    this.audio.src = "";
    
    if (!localUrl) revokeObjectUrl(this.currentBlobUrl);
    this.currentBlobUrl = null;
    
    this.onEndCallback = onEnd;
    this.syncCallback = onSync;
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
      
      if (this.sessionToken !== session) { 
        if (!localUrl) revokeObjectUrl(url); 
        return; 
      }
      
      this.currentBlobUrl = url || null;
      this.audio.src = url || '';
      this.audio.load(); // Required to reset buffer on some Android/iOS webviews

      const storeRaw = localStorage.getItem(PROGRESS_STORE_V4);
      const store = storeRaw ? JSON.parse(storeRaw) : {};
      const saved = this.context ? store[this.context.bookId]?.[this.context.chapterId] : null;
      
      let resumeTime = startTimeSec;
      if (saved?.completed) {
        resumeTime = 0; 
      } else if (saved?.timeSec > 0) {
        resumeTime = saved.timeSec;
      }

      const applyResumeTime = () => {
        if (resumeTime > 0 && isFinite(this.audio.duration)) {
           const target = Math.min(resumeTime, Math.max(0, this.audio.duration - 0.5));
           this.audio.currentTime = target;
           this.lastKnownTime = target;
        }
      };

      if (this.audio.readyState >= 1) {
        applyResumeTime();
      } else {
        this.audio.addEventListener('loadedmetadata', applyResumeTime, { once: true });
      }

      // Try playing. If it fails due to interaction, it will throw.
      await this.audio.play();
      this.applyRequestedSpeed();

    } catch (err) {
      if (this.onFetchStateChange) this.onFetchStateChange(false);
      throw err; // Propagate error (including NotAllowedError)
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
      this.audio.play().catch(() => {}); 
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