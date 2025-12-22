
import { Rule, RuleType, AudioChunkMetadata } from '../types';
import { getDriveAudioObjectUrl, revokeObjectUrl } from "../services/driveService";

/**
 * MOBILE QA CHECKLIST v2.6.3:
 * 1. Audio: playbackRate + defaultPlaybackRate set on every load + change.
 * 2. Lifecycle: visibilitychange + pagehide + beforeunload all trigger saveProgress.
 * 3. High-precision: Highlight mapping uses audio.currentTime strictly > introDurSec.
 * 4. Touch: Reader double-tap uses move-threshold to distinguish from scroll.
 * 5. PWA: Base path /TTS/ handles favicon/manifest correctly.
 */

export const PROGRESS_STORE_V4 = 'talevox_progress_v4';

export function applyRules(text: string, rules: Rule[]): string {
  let processedText = text;
  const activeRules = [...rules]
    .filter(r => r.enabled)
    .sort((a, b) => b.priority - a.priority);

  activeRules.forEach(rule => {
    let flags = 'g';
    if (!rule.matchCase) flags += 'i';
    
    let pattern = rule.matchExpression 
      ? rule.find 
      : rule.find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    if (rule.wholeWord && !rule.matchExpression) {
      pattern = `\\b${pattern}\\b`;
    }

    try {
      const regex = new RegExp(pattern, flags);
      const replacement = rule.ruleType === RuleType.REPLACE ? "" : (rule.speakAs || "");
      processedText = processedText.replace(regex, replacement);
    } catch (e) {
      console.warn("Invalid regex for rule:", rule.find);
    }
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
  private lastSaveTime: number = 0;

  constructor() {
    this.audio = new Audio();
    this.audio.volume = 1.0;
    this.audio.preload = 'auto';
    this.setupAudioListeners();
  }

  public setFetchStateListener(cb: (isFetching: boolean) => void) {
    this.onFetchStateChange = cb;
  }

  public updateMetadata(textLen: number, introDurSec: number, chunkMap: AudioChunkMetadata[]) {
    this.currentTextLength = textLen;
    this.currentIntroDurSec = introDurSec;
    this.currentChunkMap = chunkMap || null;
  }

  setContext(ctx: { bookId: string; chapterId: string } | null) {
    if (this.context && (this.context.chapterId !== ctx?.chapterId)) {
      this.saveProgress();
    }
    this.context = ctx;
    console.debug("[AudioEngine] Context updated:", ctx);
  }

  private setupAudioListeners() {
    this.audio.onended = () => {
      console.info("[AudioEngine] Playback ended.");
      this.saveProgress(true);
      this.stopSyncLoop();
      if (this.onEndCallback) {
         setTimeout(() => this.onEndCallback?.(), 0);
      }
    };

    this.audio.onplay = () => {
      // Mobile sync: some browsers reset speed on play
      this.applyRequestedSpeed();
      this.startSyncLoop();
      if (this.onFetchStateChange) this.onFetchStateChange(false);
    };

    this.audio.onpause = () => {
      this.saveProgress();
      this.stopSyncLoop();
    };

    this.audio.ontimeupdate = () => {
      const now = Date.now();
      if (now - this.lastSaveTime > 2000) { // Throttle slightly more for mobile battery
        this.saveProgress();
      }
    };

    this.audio.onseeking = () => this.saveProgress();
    this.audio.onseeked = () => this.saveProgress();

    this.audio.onerror = () => {
      console.error("[AudioEngine] Error:", this.audio.error);
      if (this.onFetchStateChange) this.onFetchStateChange(false);
    };

    // Mobile-hardened listeners
    window.addEventListener('beforeunload', () => this.saveProgress());
    window.addEventListener('pagehide', () => this.saveProgress());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.saveProgress();
    });
  }

  private applyRequestedSpeed() {
    // Mobile browsers often need both set to stick
    this.audio.defaultPlaybackRate = this.requestedSpeed;
    this.audio.playbackRate = this.requestedSpeed;
  }

  public saveProgress(completed: boolean = false) {
    if (!this.context || !this.context.bookId || !this.context.chapterId) return;
    
    const curTime = this.audio.currentTime;
    const duration = isFinite(this.audio.duration) && this.audio.duration > 0 ? this.audio.duration : 0;
    
    if (duration === 0 && !completed) return;

    const finalTime = completed ? duration : Math.min(curTime, duration || Infinity);
    const percent = duration > 0 ? Math.min(1, Math.max(0, finalTime / duration)) : (completed ? 1 : 0);

    const storeRaw = localStorage.getItem(PROGRESS_STORE_V4);
    const store = storeRaw ? JSON.parse(storeRaw) : {};
    
    if (!store[this.context.bookId]) store[this.context.bookId] = {};
    
    const existing = store[this.context.bookId][this.context.chapterId];
    const finalDur = duration > 0 ? duration : (existing?.durationSec || 0);

    const progressUpdate = {
      timeSec: finalTime,
      durationSec: finalDur,
      percent: percent,
      completed: completed || existing?.completed || false,
      updatedAt: Date.now()
    };

    store[this.context.bookId][this.context.chapterId] = progressUpdate;
    localStorage.setItem(PROGRESS_STORE_V4, JSON.stringify(store));
    this.lastSaveTime = Date.now();

    window.dispatchEvent(new CustomEvent('talevox_progress_updated', { detail: this.context }));
  }

  private startSyncLoop() {
    const sync = () => {
      if (this.syncCallback && this.audio.duration && !this.audio.paused) {
        const t = this.audio.currentTime;
        const charOffset = this.getOffsetFromTime(t, this.audio.duration);
        
        this.syncCallback({
          currentTime: t,
          duration: this.audio.duration,
          charOffset: charOffset
        });
      }
      this.rafId = requestAnimationFrame(sync);
    };
    this.stopSyncLoop();
    this.rafId = requestAnimationFrame(sync);
  }

  public getOffsetFromTime(t: number, dur?: number): number {
    const duration = dur || this.audio.duration || 0;
    // Highlight is 0 during intro announcement
    if (duration === 0 || t < this.currentIntroDurSec) return 0;
    
    const contentTime = t - this.currentIntroDurSec;

    if (this.currentChunkMap && this.currentChunkMap.length > 0) {
      const mapTotalDur = this.currentChunkMap.reduce((acc, c) => acc + c.durSec, 0);
      const totalContentDur = Math.max(0.1, duration - this.currentIntroDurSec);
      const scale = totalContentDur / Math.max(0.1, mapTotalDur);
      
      let cumulativeTime = 0;
      for (const chunk of this.currentChunkMap) {
        const scaledDur = chunk.durSec * scale;
        if (contentTime >= cumulativeTime && contentTime < cumulativeTime + scaledDur) {
          const withinRatio = (contentTime - cumulativeTime) / Math.max(0.001, scaledDur);
          const contentPos = chunk.startChar + (chunk.endChar - chunk.startChar) * withinRatio;
          return Math.max(0, Math.floor(contentPos));
        }
        cumulativeTime += scaledDur;
      }
    }

    const contentPortion = Math.max(0.001, duration - this.currentIntroDurSec);
    const ratio = Math.min(1, contentTime / contentPortion);
    return Math.max(0, Math.floor(this.currentTextLength * ratio));
  }

  async loadAndPlayDriveFile(
    token: string,
    fileId: string,
    totalContentChars: number,
    introDurSec: number,
    chunkMap: AudioChunkMetadata[] | undefined,
    startTimeSec = 0,
    playbackRate = 1.0,
    onEnd: () => void,
    onSync: (meta: PlaybackMetadata) => void
  ) {
    this.sessionToken++;
    const session = this.sessionToken;
    this.requestedSpeed = playbackRate;
    
    this.audio.pause();
    this.audio.removeAttribute("src");
    this.audio.load();
    revokeObjectUrl(this.currentBlobUrl);
    this.currentBlobUrl = null;

    this.onEndCallback = onEnd;
    this.syncCallback = onSync;
    this.currentTextLength = totalContentChars;
    this.currentIntroDurSec = introDurSec;
    this.currentChunkMap = chunkMap || null;

    if (this.onFetchStateChange) this.onFetchStateChange(true);

    try {
      // Fix: getDriveAudioObjectUrl expects 1 argument (fileId), not 2.
      const { url } = await getDriveAudioObjectUrl(fileId);
      if (this.sessionToken !== session) {
        revokeObjectUrl(url);
        return;
      }

      this.currentBlobUrl = url;
      this.audio.src = url;

      await new Promise<void>((resolve, reject) => {
        const onReady = () => { cleanup(); resolve(); };
        const onErr = () => { 
          cleanup(); 
          console.error("[AudioEngine] Load Error Detail:", this.audio.error);
          reject(this.audio.error || new Error("AUDIO_LOAD_ERROR")); 
        };
        const cleanup = () => {
          this.audio.removeEventListener("canplay", onReady);
          this.audio.removeEventListener("error", onErr);
        };
        this.audio.addEventListener("canplay", onReady, { once: true });
        this.audio.addEventListener("error", onErr, { once: true });
        this.audio.load();
      });

      if (this.sessionToken !== session) return;

      this.applyRequestedSpeed();
      
      const storeRaw = localStorage.getItem(PROGRESS_STORE_V4);
      const store = storeRaw ? JSON.parse(storeRaw) : {};
      const saved = this.context ? store[this.context.bookId]?.[this.context.chapterId] : null;
      
      const resumeTime = saved?.timeSec ?? startTimeSec;
      if (resumeTime > 0) {
        const dur = this.audio.duration || 0;
        this.audio.currentTime = Math.min(resumeTime, Math.max(0, dur - 0.25));
      }

      await this.audio.play();
    } catch (err) {
      console.error("[AudioEngine] Playback failed:", err);
      if (this.onFetchStateChange) this.onFetchStateChange(false);
      throw err;
    }
  }

  public seekToTime(seconds: number) {
    if (!isFinite(seconds) || seconds < 0) return;
    const duration = this.audio.duration;
    if (duration > 0) {
      const target = Math.min(seconds, duration);
      this.audio.currentTime = target;
      if (this.syncCallback) {
        this.syncCallback({
          currentTime: target,
          duration: duration,
          charOffset: this.getOffsetFromTime(target, duration)
        });
      }
    }
  }

  public seekToOffset(offset: number) {
    const duration = this.audio.duration;
    if (!duration || this.currentTextLength <= 0) return;
    
    let targetTime = 0;
    if (this.currentChunkMap && this.currentChunkMap.length > 0) {
      const mapTotalDur = this.currentChunkMap.reduce((acc, c) => acc + c.durSec, 0);
      const totalContentDur = Math.max(0.1, duration - this.currentIntroDurSec);
      const scale = totalContentDur / Math.max(0.1, mapTotalDur);
      
      let cumulativeTime = 0;
      for (const chunk of this.currentChunkMap) {
        if (offset >= chunk.startChar && offset <= chunk.endChar) {
          const withinRatio = (offset - chunk.startChar) / Math.max(1, chunk.endChar - chunk.startChar);
          const timeInContent = cumulativeTime + (withinRatio * chunk.durSec * scale);
          targetTime = this.currentIntroDurSec + timeInContent;
          break;
        }
        cumulativeTime += chunk.durSec * scale;
      }
    } else {
      const contentPortion = Math.max(0.001, duration - this.currentIntroDurSec);
      const ratio = Math.max(0, Math.min(1, offset / this.currentTextLength));
      targetTime = this.currentIntroDurSec + (ratio * contentPortion);
    }

    this.audio.currentTime = targetTime;
    if (this.syncCallback) {
      this.syncCallback({ currentTime: targetTime, duration, charOffset: offset });
    }
  }

  private stopSyncLoop() {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  speak(text: string, voiceName: string | undefined, rate: number, offset: number, onEnd: () => void) {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    const voice = window.speechSynthesis.getVoices().find(v => v.name === voiceName);
    if (voice) utterance.voice = voice;
    utterance.rate = rate;
    utterance.onend = () => onEnd();
    window.speechSynthesis.speak(utterance);
  }

  pause() { this.audio.pause(); window.speechSynthesis.pause(); }
  resume() { 
    if (this.audio.src) {
      this.applyRequestedSpeed();
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
    if (this.onFetchStateChange) this.onFetchStateChange(false);
    window.speechSynthesis.cancel();
  }
  setPlaybackRate(rate: number) { 
    this.requestedSpeed = rate; 
    if (this.audio.src) {
      this.applyRequestedSpeed();
    }
  }
  get isPaused() { return this.audio.paused && !window.speechSynthesis.speaking; }
  get currentTime() { return this.audio.currentTime; }
  get duration() { return this.audio.duration; }
}

export const speechController = new SpeechController();
