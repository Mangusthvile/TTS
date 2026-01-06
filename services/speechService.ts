
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

  // Highlight buffer to account for synthesis pauses and speech pacing (350ms)
  private readonly HIGHLIGHT_DELAY_SEC = 0.35;

  constructor() {
    this.audio = new Audio();
    this.audio.volume = 1.0;
    this.audio.preload = 'auto';
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
      if (this.audio.currentTime > 0) this.lastKnownTime = this.audio.currentTime;
      if (Date.now() - this.lastSaveTime > 2000) this.saveProgress(); 
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
    // This happens when mobile browsers unload the media resource while paused.
    let curTime = this.audio.currentTime;
    if (curTime === 0 && this.lastKnownTime > 1 && !completed) {
      curTime = this.lastKnownTime;
    }

    const duration = isFinite(this.audio.duration) && this.audio.duration > 0 ? this.audio.duration : 0;
    if (duration === 0 && !completed) return;
    
    const finalTime = completed ? duration : Math.min(curTime, duration || Infinity);
    const percent = duration > 0 ? Math.min(1, Math.max(0, finalTime / duration)) : (completed ? 1 : 0);
    
    // Safety: Don't overwrite valid progress with 0 unless we are at the very start
    if (finalTime === 0 && !completed && this.lastKnownTime > 5) return;

    const storeRaw = localStorage.getItem(PROGRESS_STORE_V4);
    const store = storeRaw ? JSON.parse(storeRaw) : {};
    if (!store[this.context.bookId]) store[this.context.bookId] = {};
    
    const existing = store[this.context.bookId][this.context.chapterId];
    
    store[this.context.bookId][this.context.chapterId] = { 
      timeSec: finalTime, 
      durationSec: duration > 0 ? duration : (existing?.durationSec || 0), 
      percent, 
      completed: completed || existing?.completed || false, 
      updatedAt: Date.now() 
    };
    
    localStorage.setItem(PROGRESS_STORE_V4, JSON.stringify(store));
    this.lastSaveTime = Date.now();
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
    this.audio.pause();
    this.audio.removeAttribute("src");
    this.audio.load();
    
    if (!localUrl) revokeObjectUrl(this.currentBlobUrl);
    this.currentBlobUrl = null;
    
    this.onEndCallback = onEnd;
    this.syncCallback = onSync;
    this.currentTextLength = totalContentChars;
    this.currentIntroDurSec = introDurSec;
    this.currentChunkMap = chunkMap || null;
    
    // Reset internal timer for new file
    this.lastKnownTime = startTimeSec;

    if (this.onFetchStateChange) this.onFetchStateChange(true);

    try {
      let url = localUrl;
      if (!url) {
        const res = await getDriveAudioObjectUrl(fileId);
        url = res.url;
      }
      if (this.sessionToken !== session) { if (!localUrl) revokeObjectUrl(url); return; }
      
      this.currentBlobUrl = url || null;
      this.audio.src = url || '';
      
      await new Promise<void>((resolve, reject) => {
        const onReady = () => { cleanup(); resolve(); };
        const onErr = () => { cleanup(); reject(new Error("AUDIO_LOAD_ERROR")); };
        const cleanup = () => { this.audio.removeEventListener("canplay", onReady); this.audio.removeEventListener("error", onErr); };
        this.audio.addEventListener("canplay", onReady, { once: true });
        this.audio.addEventListener("error", onErr, { once: true });
        this.audio.load();
      });
      
      if (this.sessionToken !== session) return;
      this.applyRequestedSpeed();
      
      const storeRaw = localStorage.getItem(PROGRESS_STORE_V4);
      const store = storeRaw ? JSON.parse(storeRaw) : {};
      const saved = this.context ? store[this.context.bookId]?.[this.context.chapterId] : null;
      
      // Fix: If the chapter was marked completed, force start from beginning to avoid loop
      if (saved?.completed) {
        this.audio.currentTime = 0;
        this.lastKnownTime = 0;
      } else {
        const resumeTime = saved?.timeSec ?? startTimeSec;
        if (resumeTime > 0) {
          this.audio.currentTime = Math.min(resumeTime, Math.max(0, this.audio.duration - 0.25));
          this.lastKnownTime = this.audio.currentTime;
        }
      }

      await this.audio.play();
    } catch (err) {
      if (this.onFetchStateChange) this.onFetchStateChange(false);
      throw err;
    }
  }

  public seekToTime(seconds: number) {
    if (!isFinite(seconds) || seconds < 0) return;
    this.lastKnownTime = Math.min(seconds, this.audio.duration); // Update tracking immediately
    
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
    
    this.lastKnownTime = targetTime; // Update tracking immediately
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
    this.lastKnownTime = this.audio.currentTime; // Save state explicitly
    window.speechSynthesis.pause(); 
  }
  
  resume() { 
    if (this.audio.src) { 
      this.applyRequestedSpeed(); 
      // Paranoid Resume: Mobile browsers often lose position. Restore from internal tracker if playhead is 0 but shouldn't be.
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
    this.audio.load();
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
