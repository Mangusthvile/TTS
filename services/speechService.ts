import { Rule, RuleType, AudioChunkMetadata, PlaybackMetadata } from '../types';
import { getDriveAudioObjectUrl, revokeObjectUrl } from "../services/driveService";
import { trace, traceError } from '../utils/trace';
import { isMobileMode } from '../utils/platform';

// Phase 2 local-first progress (SQLite-backed on Android via StorageDriver)
import { commitProgressLocal, loadProgressLocal } from "../services/progressStore";

function getSpeechSynthesisSafe(): SpeechSynthesis | null {
  try {
    const ss = (window as any)?.speechSynthesis as SpeechSynthesis | undefined;
    if (!ss) return null;
    return ss;
  } catch {
    return null;
  }
}

function safeSpeechCancel(): void {
  const ss = getSpeechSynthesisSafe();
  if (ss && typeof ss.cancel === "function") ss.cancel();
}

function safeSpeechPause(): void {
  const ss = getSpeechSynthesisSafe();
  if (ss && typeof ss.pause === "function") ss.pause();
}

function safeSpeechResume(): void {
  const ss = getSpeechSynthesisSafe();
  if (ss && typeof ss.resume === "function") ss.resume();
}

function isSpeechSpeaking(): boolean {
  const ss = getSpeechSynthesisSafe();
  return !!(ss && (ss as any).speaking);
}

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
  private intervalId: any = null; // For smoothing loop

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

  // Highlight buffer to account for synthesis pauses and speech pacing
  private readonly HIGHLIGHT_DELAY_SEC = 0.5;

  // Local progress commit guard (extra protection; commitProgressLocal also throttles)
  private lastLocalCommitAt = 0;

  // Lifecycle listeners bound once
  private lifecycleBound = false;

  constructor() {
    this.audio = new Audio();
    this.audio.volume = 1.0;
    this.audio.preload = 'auto';
    this.isMobileOptimized = isMobileMode();

    this.setupAudioListeners();
    this.bindLifecycleListeners();
  }

  // Update sync strategy on the fly
  public setMobileMode(isMobile: boolean) {
    if (this.isMobileOptimized === isMobile) return;
    this.isMobileOptimized = isMobile;
    trace('speech:mode_changed', { isMobile });

    if (this.audio.src && !this.audio.paused) {
      this.stopSyncLoop();
      this.startSyncLoop();
    }
  }

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

  public getMetadata(): PlaybackMetadata {
    return {
      currentTime: this.audio.currentTime,
      duration: this.audio.duration,
      charOffset: Math.floor(this.renderedOffset),
      textLength: this.currentTextLength
    };
  }

  // ----------------------------
  // Local-first progress helpers
  // ----------------------------

  private getActiveChapterId(): string | null {
    return this.context?.chapterId ?? null;
  }

  private commitLocalProgress(completed: boolean, reason: string) {
    const chapterId = this.getActiveChapterId();
    if (!chapterId) {
      // Make missing-context failures visible (this was a common “silent” reason resume failed)
      if (reason === "resume_seeked" || reason === "timeupdate" || reason === "pause" || reason === "ended") {
        traceError("progress:commit_local:no_context", new Error(`No context.chapterId for reason=${reason}`));
      }
      return;
    }

    // Guard against super-spam (commitProgressLocal already throttles per chapter too)
    const now = Date.now();
    if (now - this.lastLocalCommitAt < 500) return;
    this.lastLocalCommitAt = now;

    const t = (Number.isFinite(this.audio.currentTime) ? this.audio.currentTime : this.lastKnownTime) || 0;
    const dur = Number.isFinite(this.audio.duration) ? this.audio.duration : undefined;

    void commitProgressLocal({
      chapterId,
      timeSec: Math.max(0, t),
      durationSec: dur,
      isComplete: completed ? true : undefined,
    });

    trace('progress:commit_local', { reason, chapterId, t, dur, completed });
  }

  // Ensure we flush progress when app backgrounds / tab hidden
  private bindLifecycleListeners() {
    if (this.lifecycleBound) return;
    this.lifecycleBound = true;

    const flush = (reason: string) => {
      // commit even if paused; lastKnownTime should be correct
      this.commitLocalProgress(false, reason);
    };

    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") flush("visibilitychange:hidden");
      });
    }

    if (typeof window !== "undefined") {
      window.addEventListener("pagehide", () => flush("pagehide"));
      window.addEventListener("beforeunload", () => flush("beforeunload"));
    }
  }

  // ----------------------------
  // Audio listeners
  // ----------------------------

  private setupAudioListeners() {
    if (!this.audioEventsBound) {
      const events = ['loadstart', 'loadedmetadata', 'canplay', 'canplaythrough', 'play', 'playing', 'pause', 'waiting', 'stalled', 'ended', 'error', 'abort', 'emptied'];

      this.audio.addEventListener('seeking', () => {
        trace('audio:event:seeking', { t: this.audio.currentTime });
      });

      this.audio.addEventListener('seeked', () => {
        trace('audio:event:seeked', { t: this.audio.currentTime });
        this.lastKnownTime = this.audio.currentTime || this.lastKnownTime;

        // Snap smoothing instantly
        this.updateTargetOffset(this.lastKnownTime);
        this.renderedOffset = this.targetOffset;
        this.emitSyncTick();

        // Persist seek result locally (resume reliability)
        this.commitLocalProgress(false, "seeked");
      });

      events.forEach(e => {
        this.audio.addEventListener(e, () => {
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

      // Force full progress visually
      this.renderedOffset = this.currentTextLength;
      this.emitSyncTick(true);

      // Save completion locally
      this.commitLocalProgress(true, "ended");

      this.stopSyncLoop();
      if (this.onEndCallback) setTimeout(() => this.onEndCallback?.(), 0);
    };

    this.audio.onplay = () => {
      const t = this.audio.currentTime;
      trace('audio:onplay', { t });

      if (t > 0) this.lastKnownTime = t;
      this.applyRequestedSpeed();
      this.startSyncLoop();

      if (this.onFetchStateChange) this.onFetchStateChange(false);

      this.emitSyncTick();
      this.commitLocalProgress(false, "play");
    };

    this.audio.onpause = () => {
      const t = this.audio.currentTime;
      trace('audio:onpause', { t });

      this.lastKnownTime = t || this.lastKnownTime;
      this.emitSyncTick();
      this.stopSyncLoop();

      // Persist paused time locally (critical for resume)
      this.commitLocalProgress(false, "pause");
    };

    // Timeupdate: nudge time + persist progress
    this.audio.ontimeupdate = () => {
      const t = this.audio.currentTime;
      if (t > 0) this.lastKnownTime = t;

      // Keep target in sync as a "clock nudge"
      this.updateTargetOffset(this.lastKnownTime);

      // Persist progress locally (throttled inside commitProgressLocal)
      this.commitLocalProgress(false, "timeupdate");
    };

    this.audio.onerror = () => {
      traceError('audio:onerror', this.audio.error);
      if (this.onFetchStateChange) this.onFetchStateChange(false);
    };
  }

  // ----------------------------
  // Smoothing / highlight logic
  // ----------------------------

  private updateTargetOffset(time: number) {
    this.targetOffset = this.getOffsetFromTime(time, this.audio.duration);
  }

  private smoothTick(deltaMs: number) {
    if (!this.syncCallback) return;

    // Use lastKnownTime as the authoritative clock when mobile throttles events
    const t = (Number.isFinite(this.audio.currentTime) ? this.audio.currentTime : this.lastKnownTime) || 0;
    if (t > 0) this.lastKnownTime = t;

    // Always refresh target from clock (not just from timeupdate)
    this.updateTargetOffset(this.lastKnownTime);

    // 1) Intro/title: keep highlight at 0
    if (this.lastKnownTime < this.currentIntroDurSec) {
      this.renderedOffset = 0;
      this.emitSyncTick();
      return;
    }

    // 2) Backward jump: snap instantly
    if (this.targetOffset < this.renderedOffset) {
      this.renderedOffset = this.targetOffset;
      this.emitSyncTick();
      return;
    }

    // 3) Forward: smooth toward target with easing (reduces “skipping words”)
    const diff = this.targetOffset - this.renderedOffset;
    if (diff <= 0) {
      this.emitSyncTick();
      return;
    }

    const duration = (Number.isFinite(this.audio.duration) ? this.audio.duration : 0) || 0;
    const contentDur = Math.max(1, duration - this.currentIntroDurSec);
    const cps = this.currentTextLength > 0 ? (this.currentTextLength / contentDur) : 20;

    // Base step based on time and speed
    const baseStep = cps * (deltaMs / 1000) * Math.max(0.5, this.requestedSpeed);

    // Easing factor (more responsive when behind, but still smooth)
    const behindSec = cps > 0 ? diff / cps : 0;
    const alpha =
      behindSec > 2.5 ? 0.35 :
      behindSec > 1.5 ? 0.28 :
      behindSec > 0.8 ? 0.22 : 0.16;

    let step = diff * alpha;

    // Clamp to avoid big jumps that look like word-skips
    const maxStep = Math.max(1, baseStep * 1.5);
    step = Math.max(1, Math.min(step, maxStep));

    this.renderedOffset += step;

    this.emitSyncTick();
  }

  public emitSyncTick(completed = false) {
    if (this.syncCallback) {
      this.syncCallback({
        currentTime: this.audio.currentTime,
        duration: this.audio.duration,
        charOffset: Math.floor(this.renderedOffset),
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
    // Also persist locally whenever the app requests a save tick
    this.commitLocalProgress(!!completed, completed ? "saveProgress:completed" : "saveProgress");
  }

  private startSyncLoop() {
    this.stopSyncLoop();

    // 20fps smoothing loop (50ms)
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

  // ----------------------------
  // Robust event waiting / seeking
  // ----------------------------

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

  // ----------------------------
  // Load + play (Drive/local URL)
  // ----------------------------

  async loadAndPlayDriveFile(
    token: string,
    fileId: string,
    totalContentChars: number,
    introDurSec: number,
    chunkMap: AudioChunkMetadata[] | undefined,
    startTimeSec = 0,
    playbackRate = 1.0,
    onEnd: () => void,
    onSync: ((meta: PlaybackMetadata & { completed?: boolean }) => void) | null,
    localUrl?: string,
    onPlayStart?: () => void,
    ctx?: { bookId: string; chapterId: string } // ✅ Optional: prevents “silent resume failure”
  ) {
    // If caller passed context, set it immediately so resume works
    if (ctx) this.setContext(ctx);

    this.sessionToken++;
    this.seekNonce++;
    const session = this.sessionToken;
    const isCurrentSession = () => this.sessionToken === session;

    trace('audio:load:start', { fileId: fileId || localUrl, startTimeSec, session });

    this.requestedSpeed = playbackRate;

    // Flush local progress for previous chapter before we wipe audio
    this.commitLocalProgress(false, "before_load_new_audio");

    this.audio.pause();
    this.audio.removeAttribute("src");
    this.audio.src = "";
    this.audio.load();

    // Always try to revoke previous object URL safely (no-op for non-blob urls)
    revokeObjectUrl(this.currentBlobUrl);
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
        revokeObjectUrl(url);
        trace('audio:load:aborted', { reason: 'stale_session' });
        return;
      }

      this.currentBlobUrl = url || null;
      this.audio.src = url || '';
      this.audio.load();

      await this.waitForEvent(this.audio, 'loadedmetadata', 8000, isCurrentSession);

      // ----------------------------
      // RESUME: prefer local SQLite progress if it exists and differs meaningfully
      // ----------------------------
      let resumeTime = startTimeSec;
      const chapterId = this.getActiveChapterId();

      if (!chapterId) {
        traceError("audio:resume:no_context", new Error("Missing context.chapterId before resume"));
      } else {
        try {
          const local = await loadProgressLocal(chapterId);
          if (local?.timeSec != null && local.timeSec > 0) {
            // Prefer local resume unless caller explicitly asked for a different time
            if (resumeTime <= 0.01 || Math.abs(local.timeSec - resumeTime) > 2) {
              resumeTime = local.timeSec;
              trace('audio:resume:local', { chapterId, resumeTime });
            }
          }
        } catch (e: any) {
          traceError('audio:resume:local_failed', e);
        }
      }

      if (Number.isFinite(this.audio.duration)) {
        resumeTime = Math.min(resumeTime, Math.max(0, this.audio.duration - 0.5));
      }

      if (resumeTime > 0) {
        trace('audio:seeking', { resumeTime });
        this.audio.currentTime = resumeTime;
        this.lastKnownTime = resumeTime;

        this.updateTargetOffset(resumeTime);
        this.renderedOffset = this.targetOffset;

        await this.waitForEvent(this.audio, 'seeked', 6000, isCurrentSession);

        // Persist resumed position locally (so it never snaps back)
        this.commitLocalProgress(false, "resume_seeked");
      } else {
        // Ensure intro highlight starts at 0
        this.lastKnownTime = 0;
        this.updateTargetOffset(0);
        this.renderedOffset = 0;
        this.emitSyncTick();
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

  // ----------------------------
  // Playback controls
  // ----------------------------

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
    this.commitLocalProgress(false, "seekTo");
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
      targetTime =
        effectiveIntroEnd +
        (Math.max(0, Math.min(1, offset / this.currentTextLength)) *
          Math.max(0.001, duration - effectiveIntroEnd));
    }

    this.seekTo(targetTime).catch(e => traceError('seek:offset:failed', e));
  }

  speak(text: string, voiceName: string | undefined, rate: number, offset: number, onEnd: () => void, isIntro: boolean = false) {
    this.audio.pause();
    this.stopSyncLoop();
    safeSpeechCancel();

    const ss = getSpeechSynthesisSafe();
    const UtteranceCtor = (window as any)?.SpeechSynthesisUtterance;
    if (!ss || !UtteranceCtor) {
      trace("tts:unavailable");
      onEnd();
      return;
    }

    const executeUtterance = (txt: string, delay: number, callback: () => void) => {
      const utterance = new UtteranceCtor(txt);
      const voices = typeof ss.getVoices === "function" ? ss.getVoices() : [];
      const voice = voices.find((v: any) => v.name === voiceName);
      if (voice) utterance.voice = voice;
      utterance.rate = rate;
      utterance.onend = () => {
        if (delay > 0) setTimeout(callback, delay * 1000);
        else callback();
      };
      ss.speak(utterance);
    };

    executeUtterance(text, 0, onEnd);
  }

  pause() {
    this.audio.pause();
    this.lastKnownTime = this.audio.currentTime || this.lastKnownTime;
    this.emitSyncTick();
    this.commitLocalProgress(false, "pause(method)");
    safeSpeechPause();
  }

  resume() {
    if (this.audio.src) {
      this.applyRequestedSpeed();
      if (this.audio.currentTime === 0 && this.lastKnownTime > 0) {
        this.audio.currentTime = this.lastKnownTime;
      }
      this.audio.play().catch(e => traceError('resume:error', e));
      this.commitLocalProgress(false, "resume(method)");
    }
    safeSpeechResume();
  }

  stop() {
    trace('audio:stop');
    this.commitLocalProgress(false, "stop");

    this.sessionToken++;
    this.seekNonce++;
    this.stopSyncLoop();
    this.audio.pause();
    this.audio.removeAttribute("src");
    this.audio.src = "";
    this.audio.load();

    revokeObjectUrl(this.currentBlobUrl);
    this.currentBlobUrl = null;
    this.lastKnownTime = 0;
    this.renderedOffset = 0;
    if (this.onFetchStateChange) this.onFetchStateChange(false);
    safeSpeechCancel();
  }

  safeStop() {
    trace('audio:safeStop');
    this.commitLocalProgress(false, "safeStop");

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
    safeSpeechCancel();
  }

  setPlaybackRate(rate: number) { this.requestedSpeed = rate; if (this.audio.src) this.applyRequestedSpeed(); }
  get isPaused() { return this.audio.paused && !isSpeechSpeaking(); }
  get currentTime() { return this.audio.currentTime; }
  get duration() { return this.audio.duration; }
}

export const speechController = new SpeechController();
