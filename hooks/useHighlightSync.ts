import { useEffect, useMemo, useRef, useState } from "react";
import type { CueMap, ParagraphMap } from "../types";
import type { PlaybackAdapter, PlaybackState } from "../services/playbackAdapter";
import { findCueIndex } from "../services/cueMaps";
import { findParagraphIndex } from "../services/highlightMaps";

type HighlightSyncParams = {
  chapterId: string | null;
  text: string;
  cueMap: CueMap | null;
  paragraphMap: ParagraphMap | null;
  playbackAdapter: PlaybackAdapter | null;
  enabled?: boolean;
  throttleMs?: number;
  onOffsetChange?: (offset: number) => void;
};

type HighlightSyncState = {
  activeCueIndex: number | null;
  activeParagraphIndex: number | null;
  activeCueRange: { start: number; end: number } | null;
  isCueReady: boolean;
};

function clampCueRange(start: number, end: number, textLength: number) {
  const s = Math.max(0, Math.min(start, textLength));
  const e = Math.max(s, Math.min(end, textLength));
  return { start: s, end: e };
}

export function useHighlightSync({
  chapterId,
  text,
  cueMap,
  paragraphMap,
  playbackAdapter,
  enabled = true,
  throttleMs = 250,
  onOffsetChange,
}: HighlightSyncParams): HighlightSyncState {
  const [activeCueIndex, setActiveCueIndex] = useState<number | null>(null);
  const [activeParagraphIndex, setActiveParagraphIndex] = useState<number | null>(null);
  const [activeCueRange, setActiveCueRange] = useState<{ start: number; end: number } | null>(null);

  const cueReady = !!cueMap && cueMap.cues?.length > 0;
  const textLength = text.length;

  const lastRef = useRef({
    lastUpdateAt: 0,
    lastPosMs: 0,
    cueIndex: null as number | null,
    paragraphIndex: null as number | null,
  });
  const playRef = useRef({ isPlaying: false });
  const warnRef = useRef<{ chapterId: string | null; warned: boolean }>({ chapterId: null, warned: false });

  useEffect(() => {
    if (!enabled) return;
    if (!playbackAdapter) return;

    const updateFromState = (state: PlaybackState, force = false) => {
      if (state.isPlaying !== playRef.current.isPlaying) {
        playRef.current.isPlaying = state.isPlaying;
        console.log("[Highlight] state", {
          isPlaying: state.isPlaying,
          positionMs: state.positionMs,
          durationMs: state.durationMs,
        });
      }
      if (!cueMap || !cueMap.cues || cueMap.cues.length === 0 || !chapterId) {
        if (lastRef.current.cueIndex !== null || activeCueRange !== null) {
          lastRef.current.cueIndex = null;
          lastRef.current.paragraphIndex = null;
          setActiveCueIndex(null);
          setActiveParagraphIndex(null);
          setActiveCueRange(null);
        }
        return;
      }

      const positionMs =
        typeof state.positionMs === "number" ? state.positionMs : Math.floor((state.currentTime ?? 0) * 1000);
      const now = performance.now();
      const jump = Math.abs(positionMs - lastRef.current.lastPosMs) > 1200;
      const allow =
        force || !state.isPlaying || jump || now - lastRef.current.lastUpdateAt >= throttleMs;
      if (!allow) return;

      lastRef.current.lastUpdateAt = now;
      lastRef.current.lastPosMs = positionMs;

      const idx = findCueIndex(cueMap.cues, positionMs);
      const cue = cueMap.cues[idx];
      if (!cue) return;

      const introMs = cueMap.introOffsetMs ?? 0;
      if (introMs > 0 && positionMs < introMs) {
        if (lastRef.current.cueIndex !== null || activeCueRange !== null) {
          lastRef.current.cueIndex = null;
          lastRef.current.paragraphIndex = null;
          setActiveCueIndex(null);
          setActiveParagraphIndex(null);
          setActiveCueRange(null);
        }
        return;
      }

      const range = clampCueRange(cue.startChar, cue.endChar, textLength);
      if (!warnRef.current.warned || warnRef.current.chapterId !== chapterId) {
        if (cue.endChar > textLength || cue.startChar < 0) {
          console.warn("[Highlight] cue range out of bounds", {
            chapterId,
            cueStart: cue.startChar,
            cueEnd: cue.endChar,
            textLength,
          });
          warnRef.current = { chapterId, warned: true };
        }
      }

      let nextParagraphIndex: number | null = null;
      if (paragraphMap?.paragraphs?.length) {
        nextParagraphIndex = findParagraphIndex(paragraphMap.paragraphs, range.start);
      }

      if (idx !== lastRef.current.cueIndex) {
        lastRef.current.cueIndex = idx;
        setActiveCueIndex(idx);
        setActiveCueRange(range);
        if (onOffsetChange) onOffsetChange(range.start);
        console.log("[Highlight] cueIndex", {
          chapterId,
          cueIndex: idx,
          cueCount: cueMap.cues.length,
          positionMs,
        });
      } else if (
        activeCueRange &&
        (activeCueRange.start !== range.start || activeCueRange.end !== range.end)
      ) {
        setActiveCueRange(range);
      }

      if (nextParagraphIndex !== lastRef.current.paragraphIndex) {
        lastRef.current.paragraphIndex = nextParagraphIndex;
        setActiveParagraphIndex(nextParagraphIndex);
      }
    };

    const unsubscribe = playbackAdapter.onState((state) => updateFromState(state));
    updateFromState(playbackAdapter.getState(), true);

    const poll = setInterval(() => {
      const state = playbackAdapter.getState();
      if (state.isPlaying) {
        updateFromState(state, true);
      }
    }, Math.max(150, throttleMs));

    return () => {
      unsubscribe();
      clearInterval(poll);
    };
  }, [
    enabled,
    playbackAdapter,
    cueMap,
    paragraphMap,
    chapterId,
    textLength,
    throttleMs,
    onOffsetChange,
    activeCueRange,
  ]);

  // Reset on chapter change or cue map invalidation
  useEffect(() => {
    setActiveCueIndex(null);
    setActiveParagraphIndex(null);
    setActiveCueRange(null);
    lastRef.current.cueIndex = null;
    lastRef.current.paragraphIndex = null;
    lastRef.current.lastPosMs = 0;
    lastRef.current.lastUpdateAt = 0;
    warnRef.current = { chapterId, warned: false };
  }, [chapterId, cueMap?.chapterId]);

  useEffect(() => {
    if (!enabled) {
      setActiveCueIndex(null);
      setActiveParagraphIndex(null);
      setActiveCueRange(null);
      lastRef.current.cueIndex = null;
      lastRef.current.paragraphIndex = null;
    }
  }, [enabled]);

  return useMemo(
    () => ({
      activeCueIndex,
      activeParagraphIndex,
      activeCueRange,
      isCueReady: cueReady,
    }),
    [activeCueIndex, activeParagraphIndex, activeCueRange, cueReady]
  );
}
