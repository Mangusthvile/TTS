
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

export interface NextSegment {
  announcementPrefix: string;
  content: string;
  bookTitle: string;
  chapterTitle: string;
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
  private rafId: number | null = null;
  
  private onEndCallback: (() => void) | null = null;
  private syncCallback: ((meta: PlaybackMetadata) => void) | null = null;
  private onFetchStateChange: ((isFetching: boolean) => void) | null = null;
  
  private sessionToken: number = 0;
  private getNextSegment: (() => Promise<NextSegment | null>) | null = null;

  constructor() {
    this.audio = new Audio();
    this.audio.volume = 1.0;
    this.audio.preload = 'auto';
    this.setupAudioListeners();
  }

  setFetchStateListener(cb: (isFetching: boolean) => void) {
    this.onFetchStateChange = cb;
  }

  private setupAudioListeners() {
    this.audio.addEventListener('ended', async () => {
      console.info("[Audio] Chapter ended.");
      if (this.getNextSegment) {
        // Handle auto-advance logic if needed, but for v2.5.5 we let App.tsx handle it via onEnd
      }
      this.stopSyncLoop();
      if (this.onEndCallback) this.onEndCallback();
    });

    this.audio.addEventListener('play', () => {
      this.startSyncLoop();
      if (this.onFetchStateChange) this.onFetchStateChange(false);
    });

    this.audio.addEventListener('pause', () => {
      this.stopSyncLoop();
    });

    this.audio.addEventListener('error', () => {
      console.error("[Audio] Error:", {
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
        this.syncCallback({
          currentTime: this.audio.currentTime,
          duration: this.audio.duration,
          charOffset: Math.floor(this.currentTextLength * ratio)
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
    textLength: number,
    startTimeSec = 0,
    playbackRate = 1.0,
    onEnd: () => void,
    onSync: (meta: PlaybackMetadata) => void
  ) {
    this.sessionToken++;
    const session = this.sessionToken;
    
    // Cleanup
    this.audio.pause();
    this.audio.removeAttribute("src");
    this.audio.load();
    revokeObjectUrl(this.currentBlobUrl);
    this.currentBlobUrl = null;

    this.onEndCallback = onEnd;
    this.syncCallback = onSync;
    this.currentTextLength = textLength;

    if (this.onFetchStateChange) this.onFetchStateChange(true);

    try {
      const { url, blob } = await getDriveAudioObjectUrl(token, fileId);
      if (this.sessionToken !== session) {
        revokeObjectUrl(url);
        return;
      }

      console.log("[Audio] Drive MP3 loaded:", { size: blob.size, type: blob.type, fileId });
      this.currentBlobUrl = url;
      this.audio.src = url;
      this.audio.playbackRate = playbackRate;

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

      if (Number.isFinite(startTimeSec) && startTimeSec > 0) {
        const dur = this.audio.duration || 0;
        if (dur > 0) this.audio.currentTime = Math.min(startTimeSec, Math.max(0, dur - 0.1));
      }

      await this.audio.play();
    } catch (err) {
      console.error("[Audio] Playback setup failed:", err);
      if (this.onFetchStateChange) this.onFetchStateChange(false);
      throw err;
    }
  }

  seekToOffset(offset: number) {
    if (this.audio.duration && this.currentTextLength > 0) {
      const ratio = Math.max(0, Math.min(1, offset / this.currentTextLength));
      this.audio.currentTime = ratio * this.audio.duration;
    }
  }

  // Speak method added to support direct text-to-speech for rule testing
  speak(
    text: string,
    voiceName: string | undefined,
    rate: number,
    offset: number,
    onEnd: () => void,
    onStart?: () => void,
    onBoundary?: (offset: number) => void
  ) {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    const voices = window.speechSynthesis.getVoices();
    const voice = voices.find(v => v.name === voiceName);
    if (voice) utterance.voice = voice;
    utterance.rate = rate;
    
    if (onStart) utterance.onstart = () => onStart();
    utterance.onend = () => onEnd();
    if (onBoundary) {
      utterance.onboundary = (event) => {
        if (event.name === 'word') onBoundary(event.charIndex);
      };
    }
    
    window.speechSynthesis.speak(utterance);
  }

  pause() {
    this.audio.pause();
    window.speechSynthesis.pause();
  }

  resume() {
    if (this.audio.src) {
      this.audio.play().catch(err => console.warn("[Audio] Resume blocked:", err));
    }
    window.speechSynthesis.resume();
  }

  // Updated stop method to cancel both audio element and speech synthesis
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
    this.audio.playbackRate = rate;
  }

  get isPaused() {
    return this.audio.paused && !window.speechSynthesis.speaking;
  }

  get currentTime() {
    return this.audio.currentTime;
  }
}

export const speechController = new SpeechController();
