import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type ChapterProgress = {
  chapterId: string;
  index: number;
  total: number;
  percent: number;
  isCompleted: boolean;
  updatedAt: number;
  timeSec?: number;
  durationSec?: number;
};

export type ReaderChapter = {
  id: string;
  textLength?: number | null;
};

export type ProgressMap = Record<string, ChapterProgress>;

type UseReaderProgressOptions = {
  chapters: ReaderChapter[];
  currentChapterId: string | null;
  setCurrentChapterId?: (chapterId: string) => void;
  autoplay?: boolean;
  onAutoplayNext?: (chapterId: string) => void;
  storageKey?: string;
  debounceMs?: number;
  completionThreshold?: number; // percent, default 0.98
  externalProgress?: ProgressMap;
  persist?: (progressMap: ProgressMap) => void;
  onCommit?: (chapterId: string, next: ChapterProgress, prev?: ChapterProgress) => void;
};

type UseReaderProgressResult = {
  progressByChapter: ProgressMap;
  getChapterProgress: (chapterId: string) => ChapterProgress | null;
  updateProgress: (
    chapterId: string,
    index: number,
    total: number,
    opts?: { timeSec?: number; durationSec?: number }
  ) => void;
  handleManualScrub: (
    chapterId: string,
    index: number,
    total: number,
    opts?: { timeSec?: number; durationSec?: number }
  ) => void;
  handleChapterEnd: (
    chapterId: string,
    index: number,
    total: number,
    opts?: { timeSec?: number; durationSec?: number }
  ) => void;
  handleSkip: (
    chapterId: string,
    index: number,
    total: number,
    nextChapterId?: string,
    opts?: { timeSec?: number; durationSec?: number }
  ) => void;
  resetProgress: (chapterId?: string) => void;
};

const DEFAULT_STORAGE_KEY = "talevox_reader_progress";
const LEGACY_STORAGE_KEYS = ["talevox_reader_progress_v1"];
const DEFAULT_DEBOUNCE_MS = 2500;
const DEFAULT_COMPLETE_THRESHOLD = 0.995;

const clamp = (value: number, min: number, max: number) => {
  if (value < min) return min;
  if (value > max) return max;
  return value;
};

const computePercent = (index: number, total: number) => {
  if (!Number.isFinite(total) || total <= 0) return 0;
  return clamp(index / total, 0, 1);
};

const isNearEnd = (index: number, total: number, threshold: number) => {
  if (!Number.isFinite(total) || total <= 0) return false;
  const percent = computePercent(index, total);
  if (percent >= threshold) return true;
  const remaining = total - index;
  return remaining <= Math.max(2, Math.round(total * (1 - threshold)));
};

const safeNumber = (value: number, fallback: number) =>
  Number.isFinite(value) ? value : fallback;

export function useReaderProgress(options: UseReaderProgressOptions): UseReaderProgressResult {
  const {
    chapters,
    currentChapterId,
    setCurrentChapterId,
    autoplay = true,
    onAutoplayNext,
    storageKey = DEFAULT_STORAGE_KEY,
    debounceMs = DEFAULT_DEBOUNCE_MS,
    completionThreshold = DEFAULT_COMPLETE_THRESHOLD,
    externalProgress,
    persist,
    onCommit,
  } = options;

  const loadProgress = useCallback((): ProgressMap => {
    if (typeof window === "undefined") return {};
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw && storageKey === DEFAULT_STORAGE_KEY) {
        for (const legacyKey of LEGACY_STORAGE_KEYS) {
          const legacyRaw = localStorage.getItem(legacyKey);
          if (!legacyRaw) continue;
          const legacyParsed = JSON.parse(legacyRaw) as ProgressMap;
          if (legacyParsed && typeof legacyParsed === "object") {
            localStorage.setItem(storageKey, JSON.stringify(legacyParsed));
            return legacyParsed;
          }
        }
        return {};
      }
      if (!raw) return {};
      const parsed = JSON.parse(raw) as ProgressMap;
      if (!parsed || typeof parsed !== "object") return {};
      return parsed;
    } catch {
      return {};
    }
  }, [storageKey]);

  const [progressByChapter, setProgressByChapter] = useState<ProgressMap>(() => loadProgress());
  const progressRef = useRef(progressByChapter);
  const saveTimerRef = useRef<number | null>(null);
  const pendingCommitRef = useRef<{
    chapterId: string;
    next: ChapterProgress;
    prev?: ChapterProgress;
  } | null>(null);
  const pendingSaveRef = useRef<ProgressMap | null>(null);

  useEffect(() => {
    progressRef.current = progressByChapter;
  }, [progressByChapter]);

  const scheduleSave = useCallback((nextMap?: ProgressMap) => {
    if (typeof window === "undefined") return;
    if (nextMap) {
      progressRef.current = nextMap;
    }
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      try {
        if (persist) {
          persist(progressRef.current);
        } else {
          localStorage.setItem(storageKey, JSON.stringify(progressRef.current));
        }
      } catch {
        // ignore write errors
      }
    }, debounceMs);
  }, [debounceMs, persist, storageKey]);

  const shallowEqualProgress = (a: ProgressMap, b: ProgressMap) => {
    if (a === b) return true;
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    for (const key of aKeys) {
      const av = a[key];
      const bv = b[key];
      if (!bv) return false;
      if (
        av.index !== bv.index ||
        av.total !== bv.total ||
        av.percent !== bv.percent ||
        av.isCompleted !== bv.isCompleted ||
        av.timeSec !== bv.timeSec ||
        av.durationSec !== bv.durationSec
      ) {
        return false;
      }
    }
    return true;
  };

  useEffect(() => {
    if (!externalProgress) return;
    setProgressByChapter((prev) =>
      shallowEqualProgress(prev, externalProgress) ? prev : externalProgress
    );
  }, [externalProgress]);

  const updateEntry = useCallback(
    (
      chapterId: string,
      index: number,
      total: number,
      opts?: {
        markComplete?: boolean;
        allowComplete?: boolean;
        allowDecrease?: boolean;
        timeSec?: number;
        durationSec?: number;
      }
    ) => {
      if (!chapterId) return;
      setProgressByChapter((prev) => {
        const existing = prev[chapterId];
        const allowDecrease = opts?.allowDecrease ?? false;
        const safeTotal =
          Number.isFinite(total) && total > 0
            ? total
            : safeNumber(existing?.total ?? 0, 0);
        const rawIndex = safeTotal > 0 ? clamp(index, 0, safeTotal) : Math.max(0, index);
        let safeIndex = rawIndex;
        if (!allowDecrease && existing) {
          const nextIndex = Math.max(existing.index, rawIndex);
          safeIndex = safeTotal > 0 ? clamp(nextIndex, 0, safeTotal) : Math.max(0, nextIndex);
        }
        const percentFromIndex = safeTotal > 0 ? computePercent(safeIndex, safeTotal) : 0;
        const fallbackTimeSec = safeNumber(existing?.timeSec ?? 0, 0);
        const fallbackDurationSec = safeNumber(existing?.durationSec ?? 0, 0);
        const rawTimeSec = typeof opts?.timeSec === "number" ? opts.timeSec : fallbackTimeSec;
        const nextTimeSec =
          !allowDecrease && existing ? Math.max(existing.timeSec ?? 0, rawTimeSec) : rawTimeSec;
        const nextDurationSec =
          typeof opts?.durationSec === "number" ? opts.durationSec : fallbackDurationSec;
        const percentFromTime =
          nextDurationSec > 0 ? computePercent(nextTimeSec, nextDurationSec) : 0;
        let nextPercent = safeTotal > 0 ? percentFromIndex : percentFromTime;
        if (!allowDecrease && existing) {
          nextPercent = Math.max(existing.percent, nextPercent);
        }

        let nextCompleted = existing?.isCompleted ?? false;
        if (opts?.markComplete) nextCompleted = true;
        if (
          opts?.allowComplete &&
          (isNearEnd(safeIndex, safeTotal, completionThreshold) || nextPercent >= completionThreshold)
        ) {
          nextCompleted = true;
        }

        let finalIndex = safeIndex;
        let finalPercent = nextPercent;
        if (nextCompleted) {
          if (safeTotal > 0) {
            finalIndex = safeTotal;
          }
          finalPercent = 1;
        }

        const updated: ChapterProgress = {
          chapterId,
          index: finalIndex,
          total: safeTotal,
          percent: finalPercent,
          isCompleted: nextCompleted,
          updatedAt: Date.now(),
          timeSec: nextTimeSec || undefined,
          durationSec: nextDurationSec || undefined,
        };

        if (
          existing &&
          existing.index === updated.index &&
          existing.total === updated.total &&
          existing.percent === updated.percent &&
          existing.isCompleted === updated.isCompleted
        ) {
          return prev;
        }

        const next = { ...prev, [chapterId]: updated };
        pendingCommitRef.current = { chapterId, next: updated, prev: existing };
        pendingSaveRef.current = next;
        return next;
      });
    },
    [completionThreshold]
  );

  const updateProgress = useCallback(
    (chapterId: string, index: number, total: number, opts?: { timeSec?: number; durationSec?: number }) => {
      updateEntry(chapterId, index, total, {
        allowComplete: index >= total && total > 0,
        timeSec: opts?.timeSec,
        durationSec: opts?.durationSec,
      });
    },
    [updateEntry]
  );

  const handleManualScrub = useCallback(
    (chapterId: string, index: number, total: number, opts?: { timeSec?: number; durationSec?: number }) => {
      updateEntry(chapterId, index, total, {
        allowComplete: true,
        timeSec: opts?.timeSec,
        durationSec: opts?.durationSec,
      });
    },
    [updateEntry]
  );

  const handleChapterEnd = useCallback(
    (chapterId: string, index: number, total: number, opts?: { timeSec?: number; durationSec?: number }) => {
      updateEntry(chapterId, index, total, {
        markComplete: true,
        allowComplete: true,
        timeSec: opts?.timeSec,
        durationSec: opts?.durationSec,
      });
    },
    [updateEntry]
  );

  const handleSkip = useCallback(
    (
      chapterId: string,
      index: number,
      total: number,
      nextChapterId?: string,
      opts?: { timeSec?: number; durationSec?: number }
    ) => {
      updateEntry(chapterId, index, total, {
        allowComplete: false,
        timeSec: opts?.timeSec,
        durationSec: opts?.durationSec,
      });
      if (nextChapterId && setCurrentChapterId) {
        setCurrentChapterId(nextChapterId);
      }
    },
    [setCurrentChapterId, updateEntry]
  );

  const resetProgress = useCallback(
    (chapterId?: string) => {
      if (!chapterId) {
        setProgressByChapter({});
        scheduleSave();
        return;
      }
      setProgressByChapter((prev) => {
        if (!prev[chapterId]) return prev;
        const next = { ...prev };
        next[chapterId] = {
          chapterId,
          index: 0,
          total: next[chapterId].total,
          percent: 0,
          isCompleted: false,
          updatedAt: Date.now(),
        };
        scheduleSave();
        return next;
      });
    },
    [scheduleSave]
  );

  useEffect(() => {
    if (!chapters.length) return;
    setProgressByChapter((prev) => {
      let changed = false;
      const next: ProgressMap = { ...prev };
      for (const chapter of chapters) {
        const entry = next[chapter.id];
        if (!entry) continue;
        const nextTotal = safeNumber(chapter.textLength ?? entry.total, entry.total);
        if (nextTotal <= 0) continue;
        if (entry.total !== nextTotal) {
          const clampedIndex = clamp(entry.index, 0, nextTotal);
          const percent = computePercent(clampedIndex, nextTotal);
          next[chapter.id] = {
            ...entry,
            total: nextTotal,
            index: entry.isCompleted ? nextTotal : clampedIndex,
            percent: entry.isCompleted ? 1 : percent,
          };
          changed = true;
        }
      }
      if (changed) {
        pendingSaveRef.current = next;
      }
      return changed ? next : prev;
    });
  }, [chapters]);

  useEffect(() => {
    const pendingCommit = pendingCommitRef.current;
    if (pendingCommit && onCommit) {
      pendingCommitRef.current = null;
      onCommit(pendingCommit.chapterId, pendingCommit.next, pendingCommit.prev);
    }
    if (pendingSaveRef.current) {
      const nextMap = pendingSaveRef.current;
      pendingSaveRef.current = null;
      scheduleSave(nextMap);
    }
  }, [onCommit, scheduleSave, progressByChapter]);

  const chapterOrder = useMemo(
    () => chapters.map((chapter) => chapter.id),
    [chapters]
  );

  useEffect(() => {
    if (!autoplay || !currentChapterId || !setCurrentChapterId) return;
    const current = progressByChapter[currentChapterId];
    if (!current?.isCompleted) return;
    const currentIndex = chapterOrder.indexOf(currentChapterId);
    if (currentIndex < 0) return;
    let nextId: string | null = null;
    for (let i = currentIndex + 1; i < chapterOrder.length; i += 1) {
      const candidateId = chapterOrder[i];
      const candidate = progressByChapter[candidateId];
      if (!candidate?.isCompleted) {
        nextId = candidateId;
        break;
      }
    }
    if (!nextId) return;
    setCurrentChapterId(nextId);
    if (onAutoplayNext) onAutoplayNext(nextId);
  }, [
    autoplay,
    chapterOrder,
    currentChapterId,
    onAutoplayNext,
    progressByChapter,
    setCurrentChapterId,
  ]);

  const getChapterProgress = useCallback(
    (chapterId: string) => progressByChapter[chapterId] ?? null,
    [progressByChapter]
  );

  return {
    progressByChapter,
    getChapterProgress,
    updateProgress,
    handleManualScrub,
    handleChapterEnd,
    handleSkip,
    resetProgress,
  };
}
