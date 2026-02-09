import { Rule, RuleType, AudioChunkMetadata, PlaybackMetadata } from '../types';
import { getDriveAudioObjectUrl, revokeObjectUrl } from "../services/driveService";
import { persistChapterAudio, resolveChapterAudioLocalPath } from "./audioStorage";
import { trace, traceError } from '../utils/trace';
import { isMobileMode } from '../utils/platform';
import { Capacitor } from '@capacitor/core';
import { DesktopPlaybackAdapter, MobilePlaybackAdapter, PlaybackAdapter, PlaybackItem } from './playbackAdapter';
import { NativePlayer } from './nativePlayer';

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
  private adapter: PlaybackAdapter;
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
  private adapterUnsubscribers: Array<() => void> = [];

  // Seek coordination
  private seekNonce = 0;

  // Track time manually to prevent browser GC resetting playhead on mobile
  private lastKnownTime: number = 0;

  // Smoothing State
  private renderedOffset: number = 0;
  private targetOffset: number = 0;
  private isMobileOptimized: boolean = false;

  // Highlight buffer to account for synthesis pauses and speech pacing
  private readonly HIGHLIGHT_DELAY_SEC = 0;
  private readonly CUE_PREFIX = 'talevox_cuemap_';

  // Local progress commit guard (extra protection; commitProgressLocal also throttles)
  private lastLocalCommitAt = 0;
  private lastLoadFailed = false;

  // Lifecycle listeners bound once
  private lifecycleBound = false;

  private loadStoredCueMap(chapterId: string): AudioChunkMetadata[] | null {
    try {
      const raw = localStorage.getItem(`${this.CUE_PREFIX}${chapterId}`);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed as AudioChunkMetadata[];
    } catch { /* ignore */ }
    return null;
  }

  constructor() {
    const desktopAdapter = new DesktopPlaybackAdapter();
    this.adapter = desktopAdapter;
    this.audio = desktopAdapter.getAudioElement();
    this.audio.volume = 1.0;
    this.isMobileOptimized = isMobileMode();
    this.setMobileMode(this.isMobileOptimized);

    this.setupAudioListeners();
    this.bindLifecycleListeners();
    this.bindAdapterListeners();
  }

  public setPlaybackAdapter(adapter: PlaybackAdapter) {
    this.adapter = adapter;
    if (adapter instanceof DesktopPlaybackAdapter) {
      this.audio = adapter.getAudioElement();
    }
    this.bindAdapterListeners();
  }

  public getPlaybackAdapter() {
    return this.adapter;
  }

  // Update sync strategy on the fly
  public setMobileMode(isMobile: boolean) {
    const wantsNative = isMobile && (Capacitor.isNativePlatform?.() ?? false);
    const hasNativeAdapter = !(this.adapter instanceof DesktopPlaybackAdapter);
    if (this.isMobileOptimized === isMobile && wantsNative === hasNativeAdapter) return;
    this.isMobileOptimized = isMobile;
    trace('speech:mode_changed', { isMobile });

    if (wantsNative) {
      if (!hasNativeAdapter) {
        this.setPlaybackAdapter(new MobilePlaybackAdapter(NativePlayer));
      }
    } else if (hasNativeAdapter) {
      this.setPlaybackAdapter(new DesktopPlaybackAdapter(this.audio));
    }

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
    const ctx = this.context;
    if (ctx?.chapterId && chunkMap && chunkMap.length > 0) {
      try {
        localStorage.setItem(`talevox_cuemap_${ctx.chapterId}`, JSON.stringify(chunkMap));
      } catch { /* ignore storage errors */ }
    }
    this.renderedOffset = 0;
    this.targetOffset = 0;
  }

  setContext(ctx: { bookId: string; chapterId: string } | null) {
    this.context = ctx;
  }

  get currentContext() { return this.context; }
  get hasAudioSource() {
    if (this.lastLoadFailed) return false;
    if (this.adapter instanceof DesktopPlaybackAdapter) {
      return !!this.audio.src && this.audio.src !== '' && this.audio.src !== window.location.href;
    }
    const state = this.adapter.getState();
    return !!state.currentItemId;
  }

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
      // Only surface missing context for resume/save paths that should never run without a chapter.
      if (reason === "resume_seeked" || reason === "saveProgress" || reason === "saveProgress:completed") {
        traceError("progress:commit_local:no_context", new Error(`No context.chapterId for reason=${reason}`));
      }
      return;
    }

    // Guard against super-spam (commitProgressLocal already throttles per chapter too)
    const now = Date.now();
    if (now - this.lastLocalCommitAt < 500) return;
    this.lastLocalCommitAt = now;

    const { currentTime, duration } = this.getCurrentTimeAndDuration();
    const t = (Number.isFinite(currentTime) ? currentTime : this.lastKnownTime) || 0;
    const dur = Number.isFinite(duration) ? duration : undefined;

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
    const { duration } = this.getCurrentTimeAndDuration();
    this.targetOffset = this.getOffsetFromTime(time, duration);
  }

  private smoothTick(deltaMs: number) {
    if (!this.syncCallback) return;

    const { currentTime, duration } = this.getCurrentTimeAndDuration();
    const t = (Number.isFinite(currentTime) ? currentTime : this.lastKnownTime) || 0;
    if (t > 0) this.lastKnownTime = t;

    this.targetOffset = this.getOffsetFromTime(this.lastKnownTime, duration);
    this.renderedOffset = this.targetOffset;
    this.emitSyncTick();
  }

  public emitSyncTick(completed = false) {
    if (!this.syncCallback) return;
    const state = this.adapter.getState();
    const currentTime = (state.positionMs ?? state.currentTime * 1000) / 1000;
    const duration = (state.durationMs ?? state.duration * 1000) / 1000;
    const offset = Math.floor(this.renderedOffset);
    this.syncCallback({
      currentTime,
      duration,
      charOffset: offset,
      textLength: this.currentTextLength,
      completed
    });
  }

  private applyRequestedSpeed() {
    this.audio.defaultPlaybackRate = this.requestedSpeed;
    this.audio.playbackRate = this.requestedSpeed;
  }

  private getCurrentTimeAndDuration(): { currentTime: number; duration: number } {
    if (this.adapter instanceof DesktopPlaybackAdapter) {
      return {
        currentTime: this.audio.currentTime || 0,
        duration: Number.isFinite(this.audio.duration) ? this.audio.duration : 0,
      };
    }
    const state = this.adapter.getState();
    return { currentTime: state.currentTime ?? 0, duration: state.duration ?? 0 };
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
    ctx?: { bookId: string; chapterId: string }, // ✅ Optional: prevents “silent resume failure”
    queueItems?: PlaybackItem[],
    queueStartIndex?: number
  ) {
    // If caller passed context, set it immediately so resume works
    if (ctx) this.setContext(ctx);

    this.sessionToken++;
    this.seekNonce++;
    const session = this.sessionToken;
    const isCurrentSession = () => this.sessionToken === session;

    this.lastLoadFailed = false;
    trace('audio:load:start', { fileId: fileId || localUrl, startTimeSec, session });

    this.requestedSpeed = playbackRate;

    // Flush local progress for previous chapter before we wipe audio
    this.commitLocalProgress(false, "before_load_new_audio");

    if (this.adapter instanceof DesktopPlaybackAdapter) {
      this.audio.pause();
      this.audio.removeAttribute("src");
      this.audio.src = "";
      this.audio.load();
    } else {
      this.adapter.stop();
    }

    // Always try to revoke previous object URL safely (no-op for non-blob urls)
    revokeObjectUrl(this.currentBlobUrl);
    this.currentBlobUrl = null;

    this.onEndCallback = onEnd;
    this.onPlayStartCallback = onPlayStart || null;

    if (onSync) this.syncCallback = onSync;

    this.currentTextLength = totalContentChars;
    this.currentIntroDurSec = introDurSec;
    let effectiveChunkMap = chunkMap || null;
    if ((!effectiveChunkMap || effectiveChunkMap.length === 0) && ctx?.chapterId) {
      effectiveChunkMap = this.loadStoredCueMap(ctx.chapterId);
    }
    this.currentChunkMap = effectiveChunkMap;
    this.lastKnownTime = startTimeSec;

    // Reset offset smoothing
    this.renderedOffset = 0;
    this.targetOffset = 0;

    if (this.onFetchStateChange) this.onFetchStateChange(true);

    try {
      const isNativeAdapter = !(this.adapter instanceof DesktopPlaybackAdapter);
      const shouldFetchDrive = !!fileId && fileId !== 'LOCAL_ID';
      let url = localUrl ?? null;
      let blobUrlToRevoke: string | null = null;

      if (isNativeAdapter && Capacitor.isNativePlatform()) {
        if ((!url || url.startsWith("http")) && ctx?.chapterId) {
          const localPath = await resolveChapterAudioLocalPath(ctx.chapterId);
          if (localPath) url = localPath;
        }
        if (!url && shouldFetchDrive) {
          const res = await getDriveAudioObjectUrl(fileId);
          if (ctx?.chapterId) {
            const persisted = await persistChapterAudio(ctx.chapterId, res.blob, "mobile");
            if (persisted) url = persisted;
          }
          if (!url) {
            url = res.url;
            blobUrlToRevoke = res.url;
          } else {
            revokeObjectUrl(res.url);
          }
        }
      } else if (!url && shouldFetchDrive) {
        const res = await getDriveAudioObjectUrl(fileId);
        url = res.url;
        blobUrlToRevoke = res.url;
      }

      if (!url) {
        throw new Error("Missing audio URL");
      }

      if (!isCurrentSession()) {
        revokeObjectUrl(blobUrlToRevoke);
        trace('audio:load:aborted', { reason: 'stale_session' });
        return;
      }

      this.currentBlobUrl = blobUrlToRevoke;
      if (this.adapter instanceof DesktopPlaybackAdapter) {
        let desktopUrl = url || '';
        if (
          typeof desktopUrl === "string" &&
          (desktopUrl.startsWith("file://") || desktopUrl.startsWith("content://")) &&
          typeof (Capacitor as any).convertFileSrc === "function"
        ) {
          desktopUrl = (Capacitor as any).convertFileSrc(desktopUrl);
        }
        this.audio.src = desktopUrl;
        this.audio.load();

        await this.waitForEvent(this.audio, 'loadedmetadata', 8000, isCurrentSession);
      } else {
        const queue = queueItems && queueItems.length > 0 ? queueItems : undefined;
        if (queue) {
          await this.adapter.loadQueue(queue, queueStartIndex ?? 0);
        } else {
          await this.adapter.load({ id: fileId || 'local', url: url || '', title: '' });
        }
      }

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
        if (this.adapter instanceof DesktopPlaybackAdapter) {
          this.audio.currentTime = resumeTime;
        } else {
          await this.adapter.seek(resumeTime * 1000);
        }
        this.lastKnownTime = resumeTime;

        this.updateTargetOffset(resumeTime);
        this.renderedOffset = this.targetOffset;

        if (this.adapter instanceof DesktopPlaybackAdapter) {
          await this.waitForEvent(this.audio, 'seeked', 6000, isCurrentSession);
        }

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
        await this.adapter.play();
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
      this.lastLoadFailed = true;
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
    if (!this.audio.src && this.adapter instanceof DesktopPlaybackAdapter) throw new Error('No audio source');
    try {
      await this.adapter.play();
      this.adapter.setSpeed(this.requestedSpeed);
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
    if (!(this.adapter instanceof DesktopPlaybackAdapter)) {
      await this.adapter.seek(Math.max(0, targetSec * 1000));
      this.lastKnownTime = targetSec;
      this.emitSyncTick();
      this.commitLocalProgress(false, "seekTo");
      return;
    }
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
    if (this.adapter instanceof DesktopPlaybackAdapter) return this.audio.currentTime;
    return this.adapter.getState().currentTime;
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
    this.adapter.pause();
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
      Promise.resolve(this.adapter.play()).catch((err: unknown) => traceError('resume:error', err));
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
    this.adapter.stop();
    if (this.adapter instanceof DesktopPlaybackAdapter) {
      this.audio.pause();
      this.audio.removeAttribute("src");
      this.audio.src = "";
      this.audio.load();
    }

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
    this.adapter.stop();
    if (this.adapter instanceof DesktopPlaybackAdapter) {
      this.audio.pause();
      this.audio.src = "";
      this.audio.removeAttribute("src");
      this.audio.load();
    }

    revokeObjectUrl(this.currentBlobUrl);
    this.currentBlobUrl = null;
    this.lastKnownTime = 0;
    this.renderedOffset = 0;
    if (this.onFetchStateChange) this.onFetchStateChange(false);
    safeSpeechCancel();
  }

  setPlaybackRate(rate: number) {
    this.requestedSpeed = rate;
    this.adapter.setSpeed(rate);
    if (this.audio.src) this.applyRequestedSpeed();
  }
  get isPaused() {
    if (this.adapter instanceof DesktopPlaybackAdapter) {
      return this.audio.paused && !isSpeechSpeaking();
    }
    return !this.adapter.getState().isPlaying && !isSpeechSpeaking();
  }
  get currentTime() {
    if (this.adapter instanceof DesktopPlaybackAdapter) return this.audio.currentTime;
    return this.adapter.getState().currentTime;
  }
  get duration() {
    if (this.adapter instanceof DesktopPlaybackAdapter) return this.audio.duration;
    return this.adapter.getState().duration;
  }

  private bindAdapterListeners() {
    this.adapterUnsubscribers.forEach((unsub) => unsub());
    this.adapterUnsubscribers = [];
    if (!(this.adapter instanceof DesktopPlaybackAdapter)) {
      const onEnded = this.adapter.onEnded(() => {
        const state = this.adapter.getState();
        const duration = state.duration ?? 0;
        if (duration > 0) this.lastKnownTime = duration;
        this.renderedOffset = this.currentTextLength;
        this.emitSyncTick(true);
        this.commitLocalProgress(true, "ended");
        this.stopSyncLoop();
        if (this.onEndCallback) setTimeout(() => this.onEndCallback?.(), 0);
      });
      this.adapterUnsubscribers.push(onEnded);
    }
    const onState = this.adapter.onState((state) => {
      this.lastKnownTime = state.currentTime;
      this.updateTargetOffset(this.lastKnownTime);
      this.renderedOffset = this.targetOffset;
      if (this.syncCallback) this.emitSyncTick();
    });
    this.adapterUnsubscribers.push(onState);
  }
}

export const speechController = new SpeechController();

