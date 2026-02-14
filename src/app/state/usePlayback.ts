import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppState, Chapter, CueMap, ParagraphMap, PlaybackMetadata, PlaybackPhase } from '../../../types';
import type { PlaybackAdapter, PlaybackItem } from '../../../services/playbackAdapter';
import { DesktopPlaybackAdapter } from '../../../services/playbackAdapter';
import { speechController } from '../../../services/speechService';
import { computeProgressUpdate, ProgressCommitReason } from '../../../utils/progressCommit';
import { clamp, isNearCompletion } from '../../../utils/progress';
import { readProgressStore, writeProgressStore } from '../../../services/progressStore';
import { normalizeChapterOrder } from '../../../services/chapterOrderingService';
import { trace, traceError } from '../../../utils/trace';
import { buildSpeakTextFromContent } from '../../../utils/markdownBlockParser';
import { getEffectivePrefixLen, normalizeChunkMapForChapter, computeIntroMs } from '../../../utils/chapterBookUtils';
import { generateAudioKey, getAudioFromCache, saveAudioToCache } from '../../../services/audioCache';
import { persistChapterAudio, resolveChapterAudioLocalPath, resolveChapterAudioUrl } from '../../../services/audioStorage';
import { fetchDriveBinary } from '../../../services/driveService';
import { cueMapFromChunkMap, generateFallbackCueMap } from '../../../services/cueMaps';
import { getCueMap, saveCueMap, getParagraphMap, saveParagraphMap, buildParagraphMap } from '../../../services/highlightMaps';
import { Capacitor } from '@capacitor/core';
import type { Notice } from '../../../services/notificationManager';

type CommitProgressFn = (
  bookId: string,
  chapterId: string,
  meta: PlaybackMetadata & { completed?: boolean },
  reason: ProgressCommitReason,
  force?: boolean,
  bypassThrottle?: boolean,
  allowDecrease?: boolean
) => void;

export function usePlayback(args: {
  stateRef: React.MutableRefObject<AppState>;
  setState: React.Dispatch<React.SetStateAction<AppState>>;
  pushNotice: (n: Notice) => void;
  effectiveMobileMode: boolean;
  isAuthorized: boolean;
  playbackAdapter: PlaybackAdapter | null;
  markDirty: () => void;
  handleManualScrub: (chapterId: string, index: number, total: number, opts?: any) => void;
  handleChapterEnd: (...args: any[]) => void;
  handleSkip: (...args: any[]) => void;
  chapterSessionRef: React.MutableRefObject<number>;
  chapterTextCacheRef: React.MutableRefObject<Map<string, string>>;
  ensureChapterContentLoaded: (bookId: string, chapterId: string, session: number) => Promise<string | null>;
  getEffectivePlaybackSpeed: () => number;
  isOnline: boolean;
  setActiveCueMap: (map: CueMap | null) => void;
  setActiveParagraphMap: (map: ParagraphMap | null) => void;
  setCueMeta: (meta: { method?: string; count?: number } | null) => void;
  pendingCueFallbackRef: React.MutableRefObject<{ chapterId: string; text: string; prefixLen: number } | null>;
  activeSpeakTextRef: React.MutableRefObject<{ chapterId: string; text: string; prefixLen: number } | null>;
  cueIntegrityRef: React.MutableRefObject<{ chapterId: string; driftCount: number; lastRebuildAt: number; lastNoticeAt: number }>;
  cueDurationRef: React.MutableRefObject<{ chapterId: string; lastDurationMs: number; lastRebuildAt: number }>;
  isInIntroRef: React.MutableRefObject<boolean>;
  onSyncMeta?: (
    meta: PlaybackMetadata & { completed?: boolean },
    ctx: { currentIntroDurSec: number; setCurrentIntroDurSec: (next: number) => void }
  ) => void;
}) {
  const {
    stateRef,
    setState,
    pushNotice,
    effectiveMobileMode,
    isAuthorized,
    playbackAdapter,
    markDirty,
    handleManualScrub,
    handleChapterEnd,
    handleSkip,
    chapterSessionRef,
    chapterTextCacheRef,
    ensureChapterContentLoaded,
    getEffectivePlaybackSpeed,
    isOnline,
    setActiveCueMap,
    setActiveParagraphMap,
    setCueMeta,
    pendingCueFallbackRef,
    activeSpeakTextRef,
    cueIntegrityRef,
    cueDurationRef,
    isInIntroRef,
    onSyncMeta,
  } = args;

  const [playbackPhase, setPlaybackPhase] = useState<PlaybackPhase>('IDLE');
  const [lastPlaybackError, setLastPlaybackError] = useState<string | null>(null);
  const [currentIntroDurSec, setCurrentIntroDurSec] = useState(5);
  const [isScrubbing, setIsScrubbing] = useState(false);
  const [playbackSnapshot, setPlaybackSnapshot] = useState<{ chapterId: string; percent: number } | null>(null);
  const lastSnapshotRef = useRef(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLoadingChapter, setIsLoadingChapter] = useState(false);
  const isPlayingRef = useRef(isPlaying);
  const [audioDuration, setAudioDuration] = useState(0);
  const [audioCurrentTime, setAudioCurrentTime] = useState(0);
  const [seekNudge, setSeekNudge] = useState(0);
  const [sleepTimerSeconds, setSleepTimerSeconds] = useState<number | null>(null);
  const [stopAfterChapter, setStopAfterChapter] = useState(false);
  const [autoplayBlocked, setAutoplayBlocked] = useState(false);

  const lastProgressCommitTime = useRef(0);
  const lastProgressWarnRef = useRef(0);
  const isScrubbingRef = useRef(false);
  const scrubPreviewSecRef = useRef(0);
  const itemChangeInFlightRef = useRef<string | null>(null);
  const wasPlayingBeforeScrubRef = useRef(false);
  const resumeAfterScrubRef = useRef(false);
  const isUserScrubbingRef = useRef(false);
  const seekTxnRef = useRef<{ id: number; inFlight: boolean; targetMs: number; reason: string }>({
    id: 0,
    inFlight: false,
    targetMs: 0,
    reason: '',
  });
  const seekIdRef = useRef(0);
  const gestureArmedRef = useRef(false);
  const lastGestureAt = useRef(0);
  const sleepTimerEndsAtRef = useRef<number | null>(null);
  const sleepTimerRemainingRef = useRef<number | null>(null);
  const sleepTimerIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const manualStopRef = useRef(false);
  const sleepStopRef = useRef(false);
  const handleNextChapterRef = useRef<(autoTrigger?: boolean) => void>(() => {});

  useEffect(() => { isPlayingRef.current = isPlaying; }, [isPlaying]);

  useEffect(() => {
    if (playbackPhase === 'SEEKING') {
      const timer = setTimeout(() => {
        trace('watchdog:seek_timeout');
        setPlaybackPhase('READY');
        pushNotice({ message: 'Seek timed out', type: 'error' });
      }, 6000);
      return () => clearTimeout(timer);
    }
  }, [playbackPhase, pushNotice]);

  useEffect(() => {
    if (!playbackAdapter?.onState) return;
    const unsubscribe = playbackAdapter.onState((playbackState) => {
      setIsPlaying(playbackState.isPlaying);
    });
    return () => {
      if (unsubscribe) unsubscribe();
    };
  }, [playbackAdapter]);

  const updatePhase = useCallback((p: PlaybackPhase) => {
    const validPhases: PlaybackPhase[] = [
      'IDLE',
      'LOADING_TEXT',
      'READY',
      'LOADING_AUDIO',
      'SEEKING',
      'SCRUBBING',
      'PLAYING_INTRO',
      'PLAYING_BODY',
      'ENDING_SETTLE',
      'TRANSITIONING',
      'ERROR',
    ];
    if (validPhases.includes(p)) {
      trace('phase:change', { from: playbackPhase, to: p });
    }
    setPlaybackPhase(p);
  }, [playbackPhase]);

  const canAutoPlay = useCallback(() => {
    const timeSinceGesture = Date.now() - lastGestureAt.current;
    return gestureArmedRef.current && timeSinceGesture <= 60000;
  }, []);

  const commitProgressUpdate: CommitProgressFn = useCallback((
    bookId,
    chapterId,
    meta,
    reason,
    force = false,
    bypassThrottle = false,
    allowDecrease = false
  ) => {
    if (!chapterId) {
      const now = Date.now();
      if (now - lastProgressWarnRef.current > 2000) {
        lastProgressWarnRef.current = now;
        console.warn('[Progress] skipped commit with missing chapterId', { reason, bookId });
      }
      return;
    }
    const now = Date.now();
    const throttleMs = effectiveMobileMode ? 800 : 250;

    const s = stateRef.current;
    const bIdx = s.books.findIndex((b) => b.id === bookId);
    if (bIdx === -1) return;
    const book = s.books[bIdx];

    if (book.currentChapterId && book.currentChapterId !== chapterId) {
      if (now - lastProgressWarnRef.current > 2000) {
        lastProgressWarnRef.current = now;
        console.warn('[Progress] commit for non-active chapter', {
          reason,
          bookId,
          chapterId,
          activeChapterId: book.currentChapterId,
        });
      }
    }

    const effectiveReason: ProgressCommitReason = meta.completed ? 'ended' : reason;
    const isCompletionReason =
      effectiveReason === 'ended' || effectiveReason === 'scrubToEnd' || effectiveReason === 'seekToNearEnd';

    if (!force && !bypassThrottle && !isCompletionReason && now - lastProgressCommitTime.current < throttleMs) {
      return;
    }
    lastProgressCommitTime.current = now;

    const cIdx = book.chapters.findIndex((c) => c.id === chapterId);
    if (cIdx === -1) {
      if (now - lastProgressWarnRef.current > 2000) {
        lastProgressWarnRef.current = now;
        console.warn('[Progress] skipped commit; chapter not found', { reason, bookId, chapterId });
      }
      return;
    }

    const chapter = book.chapters[cIdx];

    const canClearCompletion = effectiveReason === 'reset';
    const lockCompleted = chapter.isCompleted && !canClearCompletion;
    const effectiveAllowDecrease = lockCompleted ? false : allowDecrease;

    const { next } = computeProgressUpdate({
      current: {
        progress: chapter.progress,
        progressSec: chapter.progressSec,
        durationSec: chapter.durationSec,
        progressChars: chapter.progressChars,
        textLength: chapter.textLength ?? chapter.content?.length,
        isCompleted: chapter.isCompleted,
      },
      timeSec: meta.currentTime,
      durationSec: meta.duration,
      progressChars: meta.charOffset,
      textLength: meta.textLength,
      reason: effectiveReason,
      completed: meta.completed,
      allowDecrease: effectiveAllowDecrease,
    });

    const updated: Chapter = {
      ...chapter,
      progress: next.progress,
      progressSec: next.progressSec,
      progressChars: typeof next.progressChars === 'number' ? next.progressChars : chapter.progressChars,
      durationSec: next.durationSec ?? chapter.durationSec,
      textLength: next.textLength ?? chapter.textLength,
      isCompleted: next.isCompleted,
    };

    if (
      force ||
      updated.isCompleted !== chapter.isCompleted ||
      Math.abs(updated.progress - chapter.progress) > 0.01 ||
      Math.abs((updated.progressSec || 0) - (chapter.progressSec || 0)) > 2
    ) {
      setState((prev) => {
        const newBooks = [...prev.books];
        const newChapters = [...newBooks[bIdx].chapters];
        newChapters[cIdx] = {
          ...updated,
          updatedAt: now,
        };
        newBooks[bIdx] = { ...newBooks[bIdx], chapters: newChapters };
        return { ...prev, books: newBooks };
      });

      const shouldPersistProgress = !['scrub', 'scrubToEnd', 'seek', 'seekToNearEnd', 'ended'].includes(effectiveReason);
      if (shouldPersistProgress) {
        try {
          const store = readProgressStore();
          const books = { ...store.books };
          if (!books[bookId]) books[bookId] = {};
          const nextEntry = {
            timeSec: updated.progressSec,
            durationSec: updated.durationSec,
            percent: updated.progress,
            completed: updated.isCompleted,
            updatedAt: now,
          };
          const prevEntry = books[bookId][chapterId];
          const isSame =
            prevEntry &&
            Math.abs((prevEntry.timeSec ?? 0) - (nextEntry.timeSec ?? 0)) < 0.0001 &&
            Math.abs((prevEntry.durationSec ?? 0) - (nextEntry.durationSec ?? 0)) < 0.0001 &&
            Math.abs((prevEntry.percent ?? 0) - (nextEntry.percent ?? 0)) < 0.0001 &&
            prevEntry.completed === nextEntry.completed;
          if (!isSame) {
            books[bookId][chapterId] = nextEntry;
            writeProgressStore({ ...store, books });
          }
        } catch (e) {
          console.warn('Progress write failed', e);
        }
      }

      if (stateRef.current.debugMode) {
        console.debug('[Progress] commit', {
          reason: effectiveReason,
          bookId,
          chapterId,
          timeSec: updated.progressSec,
          durationSec: updated.durationSec,
          percentBefore: chapter.progress,
          percentAfter: updated.progress,
          completedBefore: chapter.isCompleted,
          completedAfter: updated.isCompleted,
        });
      }

      markDirty();
    }
  }, [effectiveMobileMode, markDirty, setState, stateRef]);

  const resolveProgressInput = useCallback((
    chapterId: string,
    meta: PlaybackMetadata,
    overrides?: { timeSec?: number; durationSec?: number; charOffset?: number }
  ) => {
    const s = stateRef.current;
    const book = s.activeBookId ? s.books.find((bk) => bk.id === s.activeBookId) : null;
    const chapter = book?.chapters.find((c) => c.id === chapterId);
    const durationSec =
      typeof overrides?.durationSec === 'number'
        ? overrides.durationSec
        : meta.duration > 0
          ? meta.duration
          : audioDuration || chapter?.durationSec || 0;
    const timeSec =
      typeof overrides?.timeSec === 'number'
        ? overrides.timeSec
        : typeof meta.currentTime === 'number'
          ? meta.currentTime
          : 0;
    const textLength =
      typeof meta.textLength === 'number' && meta.textLength > 0
        ? meta.textLength
        : typeof chapter?.textLength === 'number' && chapter.textLength > 0
          ? chapter.textLength
          : typeof chapter?.content === 'string'
            ? chapter.content.length
            : 0;
    const offsetCandidate = typeof overrides?.charOffset === 'number' ? overrides.charOffset : meta.charOffset;
    const hasOffset = typeof offsetCandidate === 'number' && Number.isFinite(offsetCandidate);
    let index = hasOffset ? offsetCandidate : 0;
    if (!hasOffset && durationSec > 0 && textLength > 0) {
      index = Math.round((timeSec / durationSec) * textLength);
    }
    if (textLength > 0) {
      index = clamp(index, 0, textLength);
    } else {
      index = Math.max(0, index);
    }
    const total = textLength > 0 ? textLength : Math.max(0, index);
    return { index, total, timeSec, durationSec };
  }, [audioDuration, stateRef]);

  const handleSyncUpdate = useCallback((meta: PlaybackMetadata & { completed?: boolean }) => {
    if (isScrubbingRef.current) return;
    if (meta.duration > 0) {
      if (!audioDuration || Math.abs(meta.duration - audioDuration) > 0.1) {
        setAudioDuration(meta.duration);
      }
    }

    if (['LOADING_AUDIO', 'SEEKING', 'TRANSITIONING', 'LOADING_TEXT', 'SCRUBBING'].includes(playbackPhase)) {
      if (playbackPhase === 'SEEKING') {
        const now = Date.now();
        if (now - lastSnapshotRef.current > 50) {
          const percent = meta.duration > 0 ? meta.currentTime / meta.duration : 0;
          const s = stateRef.current;
          const b = s.books.find((bk) => bk.id === s.activeBookId);
          if (b && b.currentChapterId) {
            setPlaybackSnapshot({ chapterId: b.currentChapterId, percent });
          }
          lastSnapshotRef.current = now;
        }
      }
      if (playbackPhase === 'SEEKING' && meta.currentTime > 0) {
        setAudioCurrentTime(meta.currentTime);
      }
      return;
    }

    if (
      !seekTxnRef.current.inFlight &&
      (playbackPhase === 'READY' || playbackPhase === 'PLAYING_INTRO' || playbackPhase === 'PLAYING_BODY')
    ) {
      if (meta.currentTime > (currentIntroDurSec + 0.6) && playbackPhase !== 'PLAYING_BODY') {
        updatePhase('PLAYING_BODY');
        isInIntroRef.current = false;
      } else if (meta.currentTime <= (currentIntroDurSec + 0.6) && playbackPhase !== 'PLAYING_INTRO') {
        updatePhase('PLAYING_INTRO');
        isInIntroRef.current = true;
      }
    }

    if (meta.currentTime > 0 || meta.duration > 0) {
      setAudioCurrentTime(meta.currentTime);
      const s = stateRef.current;
      if (s.activeBookId && s.books) {
        const b = s.books.find((bk) => bk.id === s.activeBookId);
        const chapterId = meta.chapterId ?? b?.currentChapterId;
        if (b && chapterId) {
          const now = Date.now();
          if (now - lastSnapshotRef.current > 100) {
            const percent = meta.duration > 0 ? meta.currentTime / meta.duration : 0;
            setPlaybackSnapshot({ chapterId, percent });
            lastSnapshotRef.current = now;
          }
          const chapter = b.chapters.find((c) => c.id === chapterId);
          if (
            chapter &&
            meta.currentTime <= 0.01 &&
            (chapter.progressSec ?? 0) > 1 &&
            !meta.completed &&
            !['PLAYING_BODY', 'PLAYING_INTRO'].includes(playbackPhase)
          ) {
            return;
          }

          const reason: ProgressCommitReason = meta.completed ? 'ended' : 'tick';
          commitProgressUpdate(b.id, chapterId, meta, reason);
        }
      }
    }
    if (onSyncMeta) {
      onSyncMeta(meta, { currentIntroDurSec, setCurrentIntroDurSec });
    }
  }, [
    audioDuration,
    commitProgressUpdate,
    currentIntroDurSec,
    onSyncMeta,
    playbackPhase,
    setCurrentIntroDurSec,
    stateRef,
    updatePhase,
    isInIntroRef,
  ]);

  useEffect(() => {
    speechController.setSyncCallback(handleSyncUpdate);
  }, [handleSyncUpdate]);

  useEffect(() => {
    const handleVisChange = () => {
      if (document.visibilityState === 'visible') {
        speechController.emitSyncTick();
      } else {
        const s = stateRef.current;
        if (s.activeBookId && s.books) {
          const b = s.books.find((bk) => bk.id === s.activeBookId);
          if (b) {
            const meta = speechController.getMetadata();
            const chapterId = meta.chapterId ?? b.currentChapterId;
            if (chapterId) {
              commitProgressUpdate(b.id, chapterId, meta, 'sceneChange', false, true);
            }
          }
        }
      }
    };
    document.addEventListener('visibilitychange', handleVisChange);
    return () => document.removeEventListener('visibilitychange', handleVisChange);
  }, [commitProgressUpdate, stateRef]);

  useEffect(() => {
    const handleUnload = () => {
      const s = stateRef.current;
      if (s.activeBookId && s.books) {
        const b = s.books.find((bk) => bk.id === s.activeBookId);
        if (b) {
          const meta = speechController.getMetadata();
          const chapterId = meta.chapterId ?? b.currentChapterId;
          if (chapterId) {
            commitProgressUpdate(b.id, chapterId, meta, 'sceneChange', false, true);
          }
        }
      }
    };
    window.addEventListener('beforeunload', handleUnload);
    return () => window.removeEventListener('beforeunload', handleUnload);
  }, [commitProgressUpdate, stateRef]);

  useEffect(() => {
    const armGesture = () => {
      gestureArmedRef.current = true;
      lastGestureAt.current = Date.now();
    };
    window.addEventListener('pointerdown', armGesture, { capture: true });
    window.addEventListener('keydown', armGesture, { capture: true });
    return () => {
      window.removeEventListener('pointerdown', armGesture, { capture: true });
      window.removeEventListener('keydown', armGesture, { capture: true });
    };
  }, []);

  const waitForMs = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

  const confirmSeekLanding = useCallback(async (targetMs: number, seekId: number) => {
    const adapter = playbackAdapter ?? speechController.getPlaybackAdapter();
    if (!adapter) return false;
    for (let i = 0; i < 20; i += 1) {
      if (seekTxnRef.current.id !== seekId) return false;
      const state = adapter.getState();
      const positionMs = Number.isFinite(state.positionMs)
        ? state.positionMs
        : Math.floor((state.currentTime || 0) * 1000);
      if (Math.abs(positionMs - targetMs) <= 350) {
        return true;
      }
      await waitForMs(50);
    }
    return false;
  }, [playbackAdapter]);

  const performSeekToMs = useCallback(async (targetMs: number, reason: string) => {
    if (!Number.isFinite(targetMs)) return false;
    if (targetMs < 0) targetMs = 0;

    if (isUserScrubbingRef.current && reason !== 'user_scrub') {
      return false;
    }

    const adapter = playbackAdapter ?? speechController.getPlaybackAdapter();
    if (!adapter) return false;

    const seekId = ++seekIdRef.current;
    seekTxnRef.current = { id: seekId, inFlight: true, targetMs, reason };

    updatePhase('SEEKING');

    try {
      await speechController.seekTo(targetMs / 1000);
    } catch (e: any) {
      traceError('seek:failed', e);
    }

    let landed = await confirmSeekLanding(targetMs, seekId);

    if (!landed && seekTxnRef.current.id === seekId && !(adapter instanceof DesktopPlaybackAdapter)) {
      try {
        await adapter.play();
      } catch {}
      await waitForMs(50);
      try {
        await adapter.seek(targetMs);
      } catch {}
      landed = await confirmSeekLanding(targetMs, seekId);
    }

    if (seekTxnRef.current.id !== seekId) return false;
    seekTxnRef.current.inFlight = false;
    speechController.emitSyncTick();
    return landed;
  }, [confirmSeekLanding, playbackAdapter, updatePhase]);

  const resumePlaybackAfterSeek = useCallback(async (shouldResume: boolean) => {
    if (!shouldResume) {
      setIsPlaying(false);
      updatePhase('READY');
      return false;
    }
    try {
      const res = await speechController.safePlay();
      if (res === 'blocked') {
        setAutoplayBlocked(true);
        setIsPlaying(false);
        updatePhase('READY');
        return false;
      }
      setAutoplayBlocked(false);
      setIsPlaying(true);
      updatePhase('PLAYING_BODY');
      return true;
    } catch {
      setAutoplayBlocked(true);
      setIsPlaying(false);
      updatePhase('READY');
      return false;
    }
  }, [updatePhase]);

  const handleSeekByDelta = (delta: number) => {
    const wasPlaying = isPlayingRef.current;
    const t = speechController.getCurrentTime() + delta;
    const targetMs = Math.round(t * 1000);
    void (async () => {
      if (wasPlaying) {
        speechController.pause();
        setIsPlaying(false);
      }
      const landed = await performSeekToMs(targetMs, 'seek_delta');
      if (landed) {
        const meta = speechController.getMetadata();
        const s = stateRef.current;
        const book = s.activeBookId ? s.books.find((b) => b.id === s.activeBookId) : null;
        const chapterId = meta.chapterId ?? book?.currentChapterId ?? null;
        if (chapterId) {
          const input = resolveProgressInput(chapterId, meta, { timeSec: targetMs / 1000 });
          handleManualScrub(chapterId, input.index, input.total, {
            timeSec: input.timeSec,
            durationSec: input.durationSec,
          });
        }
        setSeekNudge((n) => n + 1);
      }
      await resumePlaybackAfterSeek(wasPlaying);
    })();
  };

  const handleJumpToOffset = useCallback(async (offset: number) => {
    const targetSec = speechController.getTimeForOffset(offset);
    if (targetSec == null) return;
    const wasPlaying = isPlayingRef.current;
    const targetMs = Math.round(targetSec * 1000);
    if (wasPlaying) {
      speechController.pause();
      setIsPlaying(false);
    }
    const landed = await performSeekToMs(targetMs, 'jump_offset');
    if (landed) {
      const meta = speechController.getMetadata();
      const s = stateRef.current;
      const book = s.activeBookId ? s.books.find((b) => b.id === s.activeBookId) : null;
      const chapterId = meta.chapterId ?? book?.currentChapterId ?? null;
      if (chapterId) {
        const input = resolveProgressInput(chapterId, meta, {
          timeSec: targetSec,
          charOffset: offset,
        });
        handleManualScrub(chapterId, input.index, input.total, {
          timeSec: input.timeSec,
          durationSec: input.durationSec,
        });
      }
      setSeekNudge((n) => n + 1);
    }
    await resumePlaybackAfterSeek(wasPlaying);
  }, [handleManualScrub, performSeekToMs, resolveProgressInput, resumePlaybackAfterSeek, stateRef]);

  const handleSeekCommit = useCallback(async (targetMs: number) => {
    isScrubbingRef.current = false;
    setIsScrubbing(false);
    const wasPlaying = resumeAfterScrubRef.current;
    resumeAfterScrubRef.current = false;
    wasPlayingBeforeScrubRef.current = false;
    let landed = false;
    try {
      landed = await performSeekToMs(targetMs, 'user_scrub');
      if (landed) {
        const meta = speechController.getMetadata();
        const s = stateRef.current;
        const book = s.activeBookId ? s.books.find((b) => b.id === s.activeBookId) : null;
        const chapterId = meta.chapterId ?? book?.currentChapterId ?? null;
        if (chapterId) {
          const input = resolveProgressInput(chapterId, meta, { timeSec: targetMs / 1000 });
          handleManualScrub(chapterId, input.index, input.total, {
            timeSec: input.timeSec,
            durationSec: input.durationSec,
          });
        }
        setSeekNudge((n) => n + 1);
      }
    } finally {
      isUserScrubbingRef.current = false;
    }
    await resumePlaybackAfterSeek(wasPlaying);
  }, [handleManualScrub, performSeekToMs, resolveProgressInput, resumePlaybackAfterSeek, stateRef]);

  const handleSeekOffsetCommit = useCallback(async (offset: number) => {
    isScrubbingRef.current = false;
    setIsScrubbing(false);
    const wasPlaying = resumeAfterScrubRef.current;
    resumeAfterScrubRef.current = false;
    wasPlayingBeforeScrubRef.current = false;
    const targetSec = speechController.getTimeForOffset(offset);
    if (targetSec == null) {
      isUserScrubbingRef.current = false;
      await resumePlaybackAfterSeek(wasPlaying);
      return;
    }
    const targetMs = Math.round(targetSec * 1000);
    let landed = false;
    try {
      landed = await performSeekToMs(targetMs, 'user_scrub');
      if (landed) {
        const meta = speechController.getMetadata();
        const s = stateRef.current;
        const book = s.activeBookId ? s.books.find((b) => b.id === s.activeBookId) : null;
        const chapterId = meta.chapterId ?? book?.currentChapterId ?? null;
        if (chapterId) {
          const input = resolveProgressInput(chapterId, meta, {
            timeSec: targetSec,
            charOffset: offset,
          });
          handleManualScrub(chapterId, input.index, input.total, {
            timeSec: input.timeSec,
            durationSec: input.durationSec,
          });
        }
        setSeekNudge((n) => n + 1);
      }
    } finally {
      isUserScrubbingRef.current = false;
    }
    await resumePlaybackAfterSeek(wasPlaying);
  }, [handleManualScrub, performSeekToMs, resolveProgressInput, resumePlaybackAfterSeek, stateRef]);

  const clearSleepTimerInterval = useCallback(() => {
    if (sleepTimerIntervalRef.current) {
      clearInterval(sleepTimerIntervalRef.current);
      sleepTimerIntervalRef.current = null;
    }
  }, []);

  const handleManualPause = useCallback(() => {
    speechController.pause();
    setIsPlaying(false);
    updatePhase('IDLE');

    const s = stateRef.current;
    if (s.activeBookId && s.books) {
      const b = s.books.find((bk) => bk.id === s.activeBookId);
      if (b) {
        const meta = speechController.getMetadata();
        const chapterId = meta.chapterId ?? b.currentChapterId;
        if (chapterId) {
          commitProgressUpdate(b.id, chapterId, meta, 'pause', false, true);
        }
      }
    }
  }, [commitProgressUpdate, stateRef, updatePhase]);

  const handleSleepTimerPause = useCallback(() => {
    sleepStopRef.current = true;
    speechController.pause();
    setIsPlaying(false);
    updatePhase('IDLE');

    const s = stateRef.current;
    if (s.activeBookId && s.books) {
      const b = s.books.find((bk) => bk.id === s.activeBookId);
      if (b) {
        const meta = speechController.getMetadata();
        const chapterId = meta.chapterId ?? b.currentChapterId;
        if (chapterId) {
          commitProgressUpdate(b.id, chapterId, meta, 'pause', false, true);
        }
      }
    }
  }, [commitProgressUpdate, stateRef, updatePhase]);

  const handleManualStop = useCallback(() => {
    manualStopRef.current = true;
    speechController.stop();
    setIsPlaying(false);
    updatePhase('IDLE');
  }, [updatePhase]);

  useEffect(() => {
    if (sleepTimerSeconds == null) {
      clearSleepTimerInterval();
      sleepTimerEndsAtRef.current = null;
      sleepTimerRemainingRef.current = null;
      return;
    }

    if (!isPlaying) {
      if (sleepTimerEndsAtRef.current != null) {
        sleepTimerRemainingRef.current = Math.max(0, sleepTimerEndsAtRef.current - Date.now());
      } else if (sleepTimerRemainingRef.current == null) {
        sleepTimerRemainingRef.current = sleepTimerSeconds * 1000;
      }
      clearSleepTimerInterval();
      return;
    }

    const remainingMs = sleepTimerRemainingRef.current ?? sleepTimerSeconds * 1000;
    sleepTimerEndsAtRef.current = Date.now() + remainingMs;
    clearSleepTimerInterval();
    sleepTimerIntervalRef.current = setInterval(() => {
      const endsAt = sleepTimerEndsAtRef.current;
      if (!endsAt) return;
      if (Date.now() >= endsAt) {
        clearSleepTimerInterval();
        sleepTimerEndsAtRef.current = null;
        sleepTimerRemainingRef.current = null;
        setSleepTimerSeconds(null);
        handleSleepTimerPause();
      }
    }, 500);

    return () => clearSleepTimerInterval();
  }, [sleepTimerSeconds, isPlaying, clearSleepTimerInterval, handleSleepTimerPause]);

  const handleScrubStart = useCallback(() => {
    isScrubbingRef.current = true;
    setIsScrubbing(true);
    isUserScrubbingRef.current = true;
    wasPlayingBeforeScrubRef.current = isPlayingRef.current;
    resumeAfterScrubRef.current = isPlayingRef.current;
    if (resumeAfterScrubRef.current) {
      speechController.pause();
    }
    setIsPlaying(false);
    updatePhase('SCRUBBING');
  }, [updatePhase]);

  const handleScrubMove = useCallback((time: number) => {
    scrubPreviewSecRef.current = time;
  }, []);

  const handleScrubEnd = useCallback((targetMs: number) => {
    void handleSeekCommit(targetMs);
  }, [handleSeekCommit]);

  const handleScrubEndOffset = useCallback((offset: number) => {
    void handleSeekOffsetCommit(offset);
  }, [handleSeekOffsetCommit]);

  const loadChapterSession = useCallback(async (targetChapterId: string, reason: 'user' | 'auto') => {
    const session = ++chapterSessionRef.current;
    setIsLoadingChapter(true);
    const s = stateRef.current;
    const book = s.books.find((b) => b.id === s.activeBookId);
    if (!book) {
      setIsLoadingChapter(false);
      return;
    }
    const chapter = book.chapters.find((c) => c.id === targetChapterId);
    if (!chapter) {
      setIsLoadingChapter(false);
      return;
    }

    setPlaybackPhase('LOADING_TEXT');
    trace('chapter:load:start', { targetChapterId, reason, session });

    speechController.safeStop();
    setAutoplayBlocked(false);

    const content = await ensureChapterContentLoaded(book.id, chapter.id, session);
    if (session !== chapterSessionRef.current) {
      setIsLoadingChapter(false);
      return;
    }

    const chapterCacheKey = `${book.id}:${chapter.id}`;
    const cached = chapterTextCacheRef.current.get(chapterCacheKey);
    const stateContent =
      typeof chapter.content === 'string' && chapter.content.length > 0 ? chapter.content : null;
    const effectiveContent =
      (typeof content === 'string' && content.length > 0 ? content : null) ??
      (cached && cached.length > 0 ? cached : null) ??
      stateContent;

    if (!effectiveContent) {
      pushNotice({ message: 'Unable to load chapter text. Keeping previous content.', type: 'info', ms: 4000 });
      setPlaybackPhase('READY');
      setIsLoadingChapter(false);
      return;
    }

    chapterTextCacheRef.current.set(chapterCacheKey, effectiveContent);

    setState((p) => ({
      ...p,
      books: p.books.map((b) => (b.id === book.id ? { ...b, currentChapterId: targetChapterId } : b)),
      currentOffsetChars: 0,
    }));
    setActiveCueMap(null);
    setCueMeta(null);
    pendingCueFallbackRef.current = null;
    setAudioCurrentTime(0);
    setAudioDuration(0);
    setPlaybackSnapshot(null);

    setPlaybackPhase('LOADING_AUDIO');

    const uiMode = s.readerSettings?.uiMode ?? 'auto';
    const voice = book.settings.defaultVoiceId || 'en-US-Standard-C';
    const allRules = [...s.globalRules, ...book.rules];
    const isMarkdown =
      chapter.contentFormat === 'markdown' || (chapter.filename ?? '').toLowerCase().endsWith('.md');
    const textToSpeak = buildSpeakTextFromContent(
      effectiveContent,
      isMarkdown,
      allRules,
      !!s.readerSettings?.reflowLineBreaks
    );

    try {
      let paragraphMap = await getParagraphMap(chapter.id);
      if (!paragraphMap || !paragraphMap.paragraphs || paragraphMap.paragraphs.length === 0) {
        paragraphMap = buildParagraphMap(textToSpeak, chapter.id);
        await saveParagraphMap(chapter.id, paragraphMap);
        console.log('[Highlight] paragraph map generated', {
          chapterId: chapter.id,
          paragraphCount: paragraphMap.paragraphs.length,
        });
      }
      setActiveParagraphMap(paragraphMap);
    } catch (e) {
      console.warn('[Highlight] paragraph map generation failed', e);
      setActiveParagraphMap(null);
    }

    const speakIntro = s.readerSettings?.speakChapterIntro !== false;
    const introTitle = (chapter.title || '').trim();
    const rawIntro = introTitle.length > 0 ? `Chapter ${chapter.index}. ${introTitle}. ` : `Chapter ${chapter.index}. `;
    const introText = buildSpeakTextFromContent(rawIntro, false, allRules, !!s.readerSettings?.reflowLineBreaks);
    const prefixLen = getEffectivePrefixLen(chapter, introText.length);
    activeSpeakTextRef.current = { chapterId: chapter.id, text: textToSpeak, prefixLen };
    cueIntegrityRef.current = { chapterId: chapter.id, driftCount: 0, lastRebuildAt: 0, lastNoticeAt: 0 };
    cueDurationRef.current = { chapterId: chapter.id, lastDurationMs: 0, lastRebuildAt: 0 };
    const { chunkMap: normalizedChunkMap, introMsFromChunk } = normalizeChunkMapForChapter(
      chapter.audioChunkMap,
      textToSpeak.length,
      prefixLen
    );
    const introMs = computeIntroMs({
      audioIntroDurSec: chapter.audioIntroDurSec,
      audioPrefixLen: prefixLen,
      textLen: textToSpeak.length,
      introMsFromChunk,
    });
    const introSec = introMs / 1000;
    setCurrentIntroDurSec(introSec);

    const audioCacheKey = generateAudioKey(introText + textToSpeak, voice, 1.0);
    let audioBlob = await getAudioFromCache(audioCacheKey);
    const driveAudioId = chapter.cloudAudioFileId || chapter.audioDriveId;

    if (!audioBlob && driveAudioId && isAuthorized) {
      try {
        audioBlob = await fetchDriveBinary(driveAudioId);
        if (audioBlob) await saveAudioToCache(audioCacheKey, audioBlob);
      } catch (e) {
        console.warn('[Audio] Drive fetch failed', e);
      }
    }

    if (session !== chapterSessionRef.current) {
      setIsLoadingChapter(false);
      return;
    }

    const isNativePlatform = Capacitor.isNativePlatform?.() ?? false;
    const shouldUseLocalAudio = isNativePlatform || effectiveMobileMode;
    const effectiveSpeed = getEffectivePlaybackSpeed();

    let playbackUrl: string | null = null;
    if (isNativePlatform) {
      playbackUrl = await resolveChapterAudioLocalPath(chapter.id);
      if (!playbackUrl && audioBlob && audioBlob.size > 0) {
        playbackUrl = (await persistChapterAudio(chapter.id, audioBlob, uiMode)) ?? null;
      }
    } else {
      const localPlaybackUrl = shouldUseLocalAudio ? await resolveChapterAudioUrl(chapter.id, uiMode) : null;
      playbackUrl = localPlaybackUrl ?? null;
      if (!playbackUrl && audioBlob && audioBlob.size > 0) {
        playbackUrl = URL.createObjectURL(audioBlob);
      }
      if (shouldUseLocalAudio && audioBlob) {
        await persistChapterAudio(chapter.id, audioBlob, uiMode);
      }
    }

    if (!playbackUrl) {
      pushNotice({ message: 'Audio not found. Try generating it.', type: 'info', ms: 3000 });
      setPlaybackPhase('READY');
      setIsPlaying(false);
      setIsLoadingChapter(false);
      return;
    }

    speechController.setContext({ bookId: book.id, chapterId: chapter.id });
    speechController.updateMetadata(textToSpeak.length, introSec, normalizedChunkMap);

    try {
      const existingCue = await getCueMap(chapter.id);
      let cueToUse: CueMap | null = existingCue;
      const existingIntro = existingCue?.introOffsetMs ?? 0;
      const maxExistingEnd = existingCue?.cues?.length
        ? Math.max(...existingCue.cues.map((c) => c.endChar))
        : 0;
      const needsRebuild =
        !existingCue ||
        !existingCue.cues?.length ||
        maxExistingEnd > textToSpeak.length + 2 ||
        (introMs > 0 && Math.abs(existingIntro - introMs) > 500) ||
        (introMs === 0 && existingIntro > 0);

      if (needsRebuild) {
        let builtCue: CueMap | null = null;
        if (normalizedChunkMap.length > 0) {
          builtCue = cueMapFromChunkMap(chapter.id, normalizedChunkMap, introMs);
        } else if (textToSpeak.length > 0 && audioDuration > 0) {
          builtCue = generateFallbackCueMap({
            chapterId: chapter.id,
            text: textToSpeak,
            durationMs: Math.floor(audioDuration * 1000),
            introOffsetMs: introMs,
          });
        } else if (textToSpeak.length > 0) {
          pendingCueFallbackRef.current = { chapterId: chapter.id, text: textToSpeak, prefixLen };
        }
        if (builtCue) {
          await saveCueMap(chapter.id, builtCue);
          cueToUse = builtCue;
          pendingCueFallbackRef.current = null;
        }
      } else {
        pendingCueFallbackRef.current = null;
      }

      if (cueToUse) {
        setActiveCueMap(cueToUse);
        setCueMeta({ method: cueToUse.method, count: cueToUse.cues.length });
        console.log('[Highlight] cue map loaded', {
          chapterId: chapter.id,
          cueCount: cueToUse.cues.length,
          method: cueToUse.method,
          durationMs: audioDuration > 0 ? Math.floor(audioDuration * 1000) : undefined,
        });
      }
    } catch (e) {
      console.warn('Cue map load/build failed', e);
    }

    let mobileQueue: PlaybackItem[] | undefined;
    if (shouldUseLocalAudio) {
      const mediaArtist = book.title || undefined;
      const mediaAlbum = book.title || undefined;
      const artworkUrl =
        typeof book.coverImage === 'string' && book.coverImage && !book.coverImage.startsWith('data:')
          ? book.coverImage
          : undefined;
      const sorted = normalizeChapterOrder(book.chapters || []);
      const currentIdx = sorted.findIndex((c) => c.id === chapter.id);
      const queueItems: PlaybackItem[] = [
        { id: chapter.id, url: playbackUrl, title: chapter.title, artist: mediaArtist, album: mediaAlbum, artworkUrl },
      ];
      const maxQueue = 5;
      for (let i = currentIdx + 1; i < sorted.length && queueItems.length < maxQueue; i += 1) {
        const next = sorted[i];
        if (next.isCompleted) continue;
        let nextUrl = isNativePlatform
          ? await resolveChapterAudioLocalPath(next.id)
          : await resolveChapterAudioUrl(next.id, uiMode);
        if (!nextUrl) {
          let nextBlob: Blob | null = null;
          if (next.audioSignature) {
            nextBlob = await getAudioFromCache(next.audioSignature);
          }
          const nextDriveAudioId = next.cloudAudioFileId || next.audioDriveId;
          if (!nextBlob && nextDriveAudioId && isAuthorized) {
            try {
              nextBlob = await fetchDriveBinary(nextDriveAudioId);
            } catch (e) {
              nextBlob = null;
            }
          }
          if (nextBlob && nextBlob.size > 0) {
            if (isNativePlatform) {
              nextUrl = (await persistChapterAudio(next.id, nextBlob, uiMode)) ?? null;
            } else {
              nextUrl = URL.createObjectURL(nextBlob);
              if (shouldUseLocalAudio) {
                await persistChapterAudio(next.id, nextBlob, uiMode);
              }
            }
          }
        }
        if (nextUrl) {
          queueItems.push({ id: next.id, url: nextUrl, title: next.title, artist: mediaArtist, album: mediaAlbum, artworkUrl });
        }
      }
      mobileQueue = queueItems.length > 0 ? queueItems : undefined;
    }

    let startSec = 0;
    if (!chapter.isCompleted) {
      if (typeof chapter.progressSec === 'number' && Number.isFinite(chapter.progressSec)) {
        startSec = Math.max(0, chapter.progressSec);
      } else if (chapter.progress && chapter.durationSec && chapter.progress < 0.99) {
        startSec = chapter.durationSec * chapter.progress;
      }
    }

    if (!Number.isFinite(startSec) || startSec < 0) startSec = 0;
    if (!speakIntro && introSec > 0 && startSec < introSec - 0.05) {
      startSec = introSec;
    }

    try {
      await speechController.loadAndPlayDriveFile(
        '',
        'LOCAL_ID',
        textToSpeak.length,
        introSec,
        normalizedChunkMap,
        startSec,
        effectiveSpeed,
        () => {
          if (session === chapterSessionRef.current) {
            setPlaybackPhase('ENDING_SETTLE');
            const meta = speechController.getMetadata();
            const durationSec =
              meta.duration > 0 ? meta.duration : audioDuration || chapter.durationSec || 0;
            const totalChars = textToSpeak.length;
            handleChapterEnd(chapter.id, totalChars, totalChars, {
              timeSec: durationSec,
              durationSec,
            });
            setTimeout(() => {
              if (session === chapterSessionRef.current) {
                handleNextChapterRef.current(true);
              }
            }, 300);
          }
        },
        null,
        playbackUrl,
        () => {
          if (session === chapterSessionRef.current) {
            if (!speakIntro) {
              setPlaybackPhase('PLAYING_BODY');
              isInIntroRef.current = false;
            } else if (startSec > 1) {
              setPlaybackPhase('PLAYING_BODY');
              isInIntroRef.current = false;
            } else {
              setPlaybackPhase('PLAYING_INTRO');
              isInIntroRef.current = true;
            }
          }
        },
        undefined,
        mobileQueue,
        0
      );
    } catch (e: any) {
      if (session !== chapterSessionRef.current) {
        setIsLoadingChapter(false);
        return;
      }
      console.warn('audio:load:failed', e);
      setIsPlaying(false);
      setAutoplayBlocked(false);
      setPlaybackPhase('READY');
      const msg = !isOnline
        ? 'Offline: audio could not load. Try again once you’re online.'
        : `Audio load failed${e?.message ? `: ${e.message}` : ''}`;
      pushNotice({ message: msg, type: 'error', ms: 3500 });
      setIsLoadingChapter(false);
      return;
    }

    if (session !== chapterSessionRef.current) {
      setIsLoadingChapter(false);
      return;
    }

    if (effectiveMobileMode && reason === 'auto') {
      if (!canAutoPlay()) {
        setAutoplayBlocked(true);
        setIsPlaying(false);
        setPlaybackPhase('READY');
        setIsLoadingChapter(false);
        return;
      }
    }

    try {
      const result = await speechController.safePlay();
      if (result === 'blocked') {
        setAutoplayBlocked(true);
        setIsPlaying(false);
        setPlaybackPhase('READY');
      } else {
        setAutoplayBlocked(false);
        setIsPlaying(true);
        setPlaybackPhase('PLAYING_BODY');
        speechController.setPlaybackRate(effectiveSpeed);
      }
    } catch (e: any) {
      setAutoplayBlocked(true);
      setIsPlaying(false);
      setPlaybackPhase('READY');
    }
    setIsLoadingChapter(false);
  }, [
    activeSpeakTextRef,
    audioDuration,
    canAutoPlay,
    chapterSessionRef,
    chapterTextCacheRef,
    cueDurationRef,
    cueIntegrityRef,
    effectiveMobileMode,
    ensureChapterContentLoaded,
    getEffectivePlaybackSpeed,
    handleChapterEnd,
    isInIntroRef,
    isAuthorized,
    isOnline,
    normalizeChapterOrder,
    pendingCueFallbackRef,
    pushNotice,
    setActiveCueMap,
    setActiveParagraphMap,
    setAudioCurrentTime,
    setAudioDuration,
    setAutoplayBlocked,
    setCueMeta,
    setCurrentIntroDurSec,
    setIsLoadingChapter,
    setIsPlaying,
    setPlaybackPhase,
    setPlaybackSnapshot,
    setState,
  ]);

  const handlePlaybackItemChanged = useCallback((nextId: string | null, _prevId: string | null) => {
    if (!nextId) return;
    if (isUserScrubbingRef.current || seekTxnRef.current.inFlight) return;
    const s = stateRef.current;
    const book = s.books.find((b) => b.id === s.activeBookId);
    if (!book) return;
    if (book.currentChapterId === nextId) return;
    if (itemChangeInFlightRef.current === nextId) return;
    itemChangeInFlightRef.current = nextId;
    loadChapterSession(nextId, 'auto').finally(() => {
      if (itemChangeInFlightRef.current === nextId) {
        itemChangeInFlightRef.current = null;
      }
    });
  }, [loadChapterSession, stateRef]);

  useEffect(() => {
    speechController.setItemChangedCallback(handlePlaybackItemChanged);
    return () => speechController.setItemChangedCallback(null);
  }, [handlePlaybackItemChanged]);

  const handleManualPlay = useCallback(() => {
    gestureArmedRef.current = true;
    lastGestureAt.current = Date.now();
    manualStopRef.current = false;
    sleepStopRef.current = false;
    const effectiveSpeed = stateRef.current.playbackSpeed;
    speechController.setPlaybackRate(effectiveSpeed);

    const s = stateRef.current;
    const book = s.books.find((b) => b.id === s.activeBookId);
    const chapterId = book?.currentChapterId;
    if (chapterId && !speechController.hasAudioSource) {
      loadChapterSession(chapterId, 'user');
      return;
    }

    speechController.safePlay().then((res) => {
      if (res === 'blocked') {
        setAutoplayBlocked(true);
        setIsPlaying(false);
      } else {
        setAutoplayBlocked(false);
        setIsPlaying(true);
        updatePhase('PLAYING_BODY');
      }
    }).catch(() => {
      if (chapterId) {
        loadChapterSession(chapterId, 'user');
        return;
      }
      setAutoplayBlocked(false);
      setIsPlaying(false);
      updatePhase('READY');
    });
  }, [loadChapterSession, stateRef, updatePhase]);

  const handleNextChapter = useCallback((autoTrigger = false) => {
    if (autoTrigger && isUserScrubbingRef.current) return;
    if (seekTxnRef.current.inFlight) return;
    const s = stateRef.current;
    const book = s.books.find((b) => b.id === s.activeBookId);
    if (!book || !book.currentChapterId) return;
    const sorted = normalizeChapterOrder(book.chapters || []);
    const idx = sorted.findIndex((c) => c.id === book.currentChapterId);
    const normalizeVolumeName = (chapter: Chapter | undefined): string | null => {
      const name = typeof (chapter as any)?.volumeName === 'string' ? String((chapter as any).volumeName).trim() : '';
      if (!name) return null;
      if (name.toLowerCase() === 'ungrouped') return null;
      return name;
    };
    if (!autoTrigger) {
      const meta = speechController.getMetadata();
      const chapterId = meta.chapterId ?? book.currentChapterId;
      if (chapterId) {
        const input = resolveProgressInput(chapterId, meta);
        handleSkip(chapterId, input.index, input.total, undefined, {
          timeSec: input.timeSec,
          durationSec: input.durationSec,
        });
      }
    }

    if (autoTrigger && (stopAfterChapter || manualStopRef.current || sleepStopRef.current)) {
      setIsPlaying(false);
      updatePhase('IDLE');
      if (stopAfterChapter) {
        pushNotice({ message: 'Stopped after chapter', type: 'info' });
      }
      return;
    }

    if (idx >= 0 && idx < sorted.length - 1) {
      if (autoTrigger) {
        const nextIncomplete = sorted.slice(idx + 1).find((c) => !c.isCompleted);
        if (!nextIncomplete) {
          setIsPlaying(false);
          updatePhase('IDLE');
          pushNotice({ message: 'End of book', type: 'success', ms: 3000 });
          return;
        }
        const currentVol = normalizeVolumeName(sorted[idx]);
        const nextVol = normalizeVolumeName(nextIncomplete);
        const base = `Next: Chapter ${nextIncomplete.index}`;
        pushNotice({
          message: currentVol && nextVol && currentVol !== nextVol ? `Moving onto ${nextVol} - ${base}` : base,
          type: 'info',
        });
        loadChapterSession(nextIncomplete.id, 'auto');
        return;
      }
      const next = sorted[idx + 1];
      const currentVol = normalizeVolumeName(sorted[idx]);
      const nextVol = normalizeVolumeName(next);
      const base = `Next: Chapter ${next.index}`;
      pushNotice({
        message: currentVol && nextVol && currentVol !== nextVol ? `Moving onto ${nextVol} - ${base}` : base,
        type: 'info',
      });
      loadChapterSession(next.id, 'user');
    } else {
      setIsPlaying(false);
      updatePhase('IDLE');
      pushNotice({ message: 'End of book', type: 'success', ms: 3000 });
    }
  }, [handleSkip, loadChapterSession, pushNotice, resolveProgressInput, stopAfterChapter, updatePhase, stateRef]);

  useEffect(() => { handleNextChapterRef.current = handleNextChapter; }, [handleNextChapter]);

  const handlePrevChapter = useCallback(() => {
    const s = stateRef.current;
    const book = s.books.find((b) => b.id === s.activeBookId);
    if (!book || !book.currentChapterId) return;
    const sorted = normalizeChapterOrder(book.chapters || []);
    const idx = sorted.findIndex((c) => c.id === book.currentChapterId);
    if (idx > 0) {
      const meta = speechController.getMetadata();
      const chapterId = meta.chapterId ?? book.currentChapterId;
      if (chapterId) {
        const input = resolveProgressInput(chapterId, meta);
        handleSkip(chapterId, input.index, input.total, undefined, {
          timeSec: input.timeSec,
          durationSec: input.durationSec,
        });
      }
      const prev = sorted[idx - 1];
      loadChapterSession(prev.id, 'user');
    }
  }, [handleSkip, loadChapterSession, resolveProgressInput, stateRef]);

  return {
    playbackPhase,
    isPlaying,
    isLoadingChapter,
    audioDuration,
    audioCurrentTime,
    seekNudge,
    isScrubbing,
    sleepTimerSeconds,
    stopAfterChapter,
    autoplayBlocked,
    playbackSnapshot,
    currentIntroDurSec,
    lastPlaybackError,
    handleManualPlay,
    handleManualPause,
    handleManualStop,
    handleNextChapter,
    handlePrevChapter,
    handleNextChapterRef,
    handleJumpToOffset,
    handleSeekByDelta,
    handleScrubStart,
    handleScrubMove,
    handleScrubEnd,
    handleScrubEndOffset,
    loadChapterSession,
    commitProgressUpdate,
    setPlaybackSnapshot,
    setPlaybackPhase: updatePhase,
    setIsPlaying,
    setAutoplayBlocked,
    setAudioCurrentTime,
    setAudioDuration,
    setCurrentIntroDurSec,
    canAutoPlay,
    setSleepTimerSeconds,
    setStopAfterChapter,
  };
}
