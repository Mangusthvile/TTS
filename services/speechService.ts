
import { Rule, RuleType, AudioChunkMetadata } from '../types';
import { getDriveAudioObjectUrl, revokeObjectUrl } from "../services/driveService";

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
  private currentPrefixLength: number = 0;
  private currentChunkMap: AudioChunkMetadata[] | null = null;
  private rafId: number | null = null;
  private requestedSpeed: number = 1.0;
  
  private onEndCallback: (() => void) | null = null;
  private syncCallback: ((meta: PlaybackMetadata) => void) | null = null;
  private onFetchStateChange: ((isFetching: boolean) => void) | null = null;
  
  private sessionToken: number = 0;
  private context: { bookId: string; chapterId: string } | null = null;

  constructor() {
    this.audio = new Audio();
    this.audio.volume = 1.0;
    this.audio.preload = 'auto';
    this.setupAudioListeners();
  }

  setContext(ctx: { bookId: string; chapterId: string } | null) {
    this.context = ctx;
    console.debug("[AudioEngine] Context updated:", ctx);
  }

  setFetchStateListener(cb: (isFetching: boolean) => void) {
    this.onFetchStateChange = cb;
  }

  private setupAudioListeners() {
    this.audio.addEventListener('ended', () => {
      console.info("[AudioEngine] Playback ended.");
      this.stopSyncLoop();
      if (this.onEndCallback) {
         setTimeout(() => this.onEndCallback?.(), 0);
      }
    });

    this.audio.addEventListener('play', () => {
      this.startSyncLoop();
      if (this.onFetchStateChange) this.onFetchStateChange(false);
    });

    this.audio.addEventListener('pause', () => {
      this.stopSyncLoop();
    });

    this.audio.addEventListener('error', () => {
      console.error("[AudioEngine] Error:", this.audio.error);
      if (this.onFetchStateChange) this.onFetchStateChange(false);
    });
  }

  private startSyncLoop() {
    const sync = () => {
      if (this.syncCallback && this.audio.duration && !this.audio.paused) {
        const t = this.audio.currentTime;
        const charOffset = this.getOffsetFromTime(t);
        
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

  private getOffsetFromTime(t: number): number {
    const duration = this.audio.duration || 1;
    
    // v2.5.10: Precision Mapping
    if (this.currentChunkMap && this.currentChunkMap.length > 0) {
      const mapTotalDur = this.currentChunkMap.reduce((acc, c) => acc + c.durSec, 0);
      const scale = duration / Math.max(0.1, mapTotalDur);
      
      let cumulativeTime = 0;
      for (const chunk of this.currentChunkMap) {
        const scaledDur = chunk.durSec * scale;
        if (t >= cumulativeTime && t < cumulativeTime + scaledDur) {
          const withinRatio = (t - cumulativeTime) / scaledDur;
          const rawPos = chunk.startChar + (chunk.endChar - chunk.startChar) * withinRatio;
          return Math.max(0, Math.floor(rawPos) - this.currentPrefixLength);
        }
        cumulativeTime += scaledDur;
      }
    }

    // Fallback: Linear
    const ratio = Math.min(1, t / duration);
    return Math.max(0, Math.floor(this.currentTextLength * ratio) - this.currentPrefixLength);
  }

  async loadAndPlayDriveFile(
    token: string,
    fileId: string,
    totalTextLength: number,
    prefixLength: number,
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
    this.currentTextLength = totalTextLength;
    this.currentPrefixLength = prefixLength;
    this.currentChunkMap = chunkMap || null;

    if (this.onFetchStateChange) this.onFetchStateChange(true);

    try {
      const { url } = await getDriveAudioObjectUrl(token, fileId);
      if (this.sessionToken !== session) {
        revokeObjectUrl(url);
        return;
      }

      this.currentBlobUrl = url;
      this.audio.src = url;

      await new Promise<void>((resolve, reject) => {
        const onReady = () => { cleanup(); resolve(); };
        const onErr = () => { cleanup(); reject(this.audio.error || new Error("AUDIO_LOAD_ERROR")); };
        const cleanup = () => {
          this.audio.removeEventListener("canplay", onReady);
          this.audio.removeEventListener("error", onErr);
        };
        this.audio.addEventListener("canplay", onReady, { once: true });
        this.audio.addEventListener("error", onErr, { once: true });
        this.audio.load();
      });

      if (this.sessionToken !== session) return;

      this.audio.playbackRate = this.requestedSpeed;
      if (startTimeSec > 0) {
        const dur = this.audio.duration || 0;
        this.audio.currentTime = Math.min(startTimeSec, Math.max(0, dur - 0.1));
      }

      await this.audio.play();
    } catch (err) {
      console.error("[AudioEngine] Playback failed:", err);
      if (this.onFetchStateChange) this.onFetchStateChange(false);
      throw err;
    }
  }

  seekToOffset(offset: number) {
    const duration = this.audio.duration;
    if (!duration || this.currentTextLength <= 0) return;
    
    const rawTargetChar = this.currentPrefixLength + offset;

    // v2.5.10: Precision Seeking
    if (this.currentChunkMap && this.currentChunkMap.length > 0) {
      const mapTotalDur = this.currentChunkMap.reduce((acc, c) => acc + c.durSec, 0);
      const scale = duration / Math.max(0.1, mapTotalDur);
      
      let cumulativeTime = 0;
      for (const chunk of this.currentChunkMap) {
        if (rawTargetChar >= chunk.startChar && rawTargetChar <= chunk.endChar) {
          const withinRatio = (rawTargetChar - chunk.startChar) / Math.max(1, chunk.endChar - chunk.startChar);
          this.audio.currentTime = cumulativeTime + (withinRatio * chunk.durSec * scale);
          return;
        }
        cumulativeTime += chunk.durSec * scale;
      }
    }

    // Fallback: Linear
    const ratio = Math.max(0, Math.min(1, rawTargetChar / this.currentTextLength));
    this.audio.currentTime = ratio * duration;
  }

  getTimeFromOffset(offset: number): number {
    const duration = this.audio.duration || 0;
    if (duration === 0) return 0;
    
    const rawTargetChar = this.currentPrefixLength + offset;

    if (this.currentChunkMap && this.currentChunkMap.length > 0) {
      const mapTotalDur = this.currentChunkMap.reduce((acc, c) => acc + c.durSec, 0);
      const scale = duration / Math.max(0.1, mapTotalDur);
      
      let cumulativeTime = 0;
      for (const chunk of this.currentChunkMap) {
        if (rawTargetChar >= chunk.startChar && rawTargetChar <= chunk.endChar) {
          const withinRatio = (rawTargetChar - chunk.startChar) / Math.max(1, chunk.endChar - chunk.startChar);
          return cumulativeTime + (withinRatio * chunk.durSec * scale);
        }
        cumulativeTime += chunk.durSec * scale;
      }
    }
    
    const ratio = Math.max(0, Math.min(1, rawTargetChar / Math.max(1, this.currentTextLength)));
    return ratio * duration;
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
      this.audio.playbackRate = this.requestedSpeed;
      this.audio.play().catch(() => {});
    }
    window.speechSynthesis.resume(); 
  }
  stop() {
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
  setPlaybackRate(rate: number) { this.requestedSpeed = rate; if (this.audio.src) this.audio.playbackRate = rate; }
  get isPaused() { return this.audio.paused && !window.speechSynthesis.speaking; }
  get currentTime() { return this.audio.currentTime; }
  get duration() { return this.audio.duration; }
}

export const speechController = new SpeechController();
