
import { Rule, RuleType } from '../types';
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
         // Fire callback asynchronously to avoid stack issues during state transitions
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
      console.error("[AudioEngine] Error:", {
        error: this.audio.error,
        src: this.audio.src,
        networkState: this.audio.networkState
      });
      if (this.onFetchStateChange) this.onFetchStateChange(false);
    });
  }

  private startSyncLoop() {
    const sync = () => {
      if (this.syncCallback && this.audio.duration && !this.audio.paused) {
        const ratio = Math.min(1, this.audio.currentTime / this.audio.duration);
        const totalChars = this.currentTextLength;
        const prefixChars = this.currentPrefixLength;
        const rawCharPos = Math.floor(totalChars * ratio);
        
        // Offset is strictly content-based. Clamp intro portion to 0.
        const contentOffset = Math.max(0, rawCharPos - prefixChars);
        
        this.syncCallback({
          currentTime: this.audio.currentTime,
          duration: this.audio.duration,
          charOffset: contentOffset
        });
      }
      this.rafId = requestAnimationFrame(sync);
    };
    this.stopSyncLoop();
    this.rafId = requestAnimationFrame(sync);
  }

  private stopSyncLoop() {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  async loadAndPlayDriveFile(
    token: string,
    fileId: string,
    totalTextLength: number,
    prefixLength: number,
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

    if (this.onFetchStateChange) this.onFetchStateChange(true);

    try {
      const { url, blob } = await getDriveAudioObjectUrl(token, fileId);
      if (this.sessionToken !== session) {
        revokeObjectUrl(url);
        return;
      }

      console.log("[AudioEngine] Drive MP3 loaded:", { size: blob.size, fileId });
      this.currentBlobUrl = url;
      this.audio.src = url;

      await new Promise<void>((resolve, reject) => {
        const onReady = () => { cleanup(); resolve(); };
        const onErr = () => { cleanup(); reject(this.audio.error || new Error("AUDIO_ELEMENT_ERROR")); };
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

      if (Number.isFinite(startTimeSec) && startTimeSec > 0) {
        const dur = this.audio.duration || 0;
        if (dur > 0) {
          this.audio.currentTime = Math.min(startTimeSec, Math.max(0, dur - 0.1));
          console.debug("[AudioEngine] Resuming at time:", this.audio.currentTime);
        }
      }

      await this.audio.play();
    } catch (err) {
      console.error("[AudioEngine] Playback failed:", err);
      if (this.onFetchStateChange) this.onFetchStateChange(false);
      throw err;
    }
  }

  seekToOffset(offset: number) {
    if (this.audio.duration && this.currentTextLength > 0) {
      const totalChars = this.currentTextLength;
      const prefixChars = this.currentPrefixLength;
      const seekTargetChar = prefixChars + offset;
      const ratio = Math.max(0, Math.min(1, seekTargetChar / totalChars));
      this.audio.currentTime = ratio * this.audio.duration;
    }
  }

  speak(
    text: string,
    voiceName: string | undefined,
    rate: number,
    offset: number,
    onEnd: () => void
  ) {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    const voices = window.speechSynthesis.getVoices();
    const voice = voices.find(v => v.name === voiceName);
    if (voice) utterance.voice = voice;
    utterance.rate = rate;
    utterance.onend = () => onEnd();
    window.speechSynthesis.speak(utterance);
  }

  pause() {
    this.audio.pause();
    window.speechSynthesis.pause();
  }

  resume() {
    if (this.audio.src) {
      this.audio.playbackRate = this.requestedSpeed;
      this.audio.play().catch(err => console.warn("[AudioEngine] Resume blocked:", err));
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

  setPlaybackRate(rate: number) {
    this.requestedSpeed = rate;
    if (this.audio.src) {
      this.audio.playbackRate = rate;
    }
  }

  get isPaused() {
    return this.audio.paused && !window.speechSynthesis.speaking;
  }

  get currentTime() {
    return this.audio.currentTime;
  }

  get duration() {
    return this.audio.duration;
  }
}

export const speechController = new SpeechController();
