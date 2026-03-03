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
  /** Batched into one object so we get a single setState (one re-render) per tick. */
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
  throttleMs = 100,
  onOffsetChange,
}: HighlightSyncParams): HighlightSyncState {
  const [highlightState, setHighlightState] = useState<{
    /** Single state object = one re-render per tick (not three). */
    activeCueIndex: number | null;
    activeParagraphIndex: number | null;
    activeCueRange: { start: number; end: number } | null;
  }>({
    activeCueIndex: null,
    activeParagraphIndex: null,
    activeCueRange: null,
  });

  const cueReady = !!cueMap && cueMap.cues?.length > 0;
  const textLength = text.length;

  const lastRef = useRef({
    lastUpdateAt: 0,
    lastPosMs: 0,
    cueIndex: null as number | null,
    paragraphIndex: null as number | null,
  });
  const playRef = useRef({ isPlaying: false });
  const warnRef = useRef<{ chapterId: string | null; warned: boolean }>({
    chapterId: null,
    warned: false,
  });

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
        if (lastRef.current.cueIndex !== null || lastRef.current.paragraphIndex !== null) {
          lastRef.current.cueIndex = null;
          lastRef.current.paragraphIndex = null;
          setHighlightState({
            activeCueIndex: null,
            activeParagraphIndex: null,
            activeCueRange: null,
          });
        }
        return;
      }

      const positionMs =
        typeof state.positionMs === "number"
          ? state.positionMs
          : Math.floor((state.currentTime ?? 0) * 1000);
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
        if (lastRef.current.cueIndex !== null || lastRef.current.paragraphIndex !== null) {
          lastRef.current.cueIndex = null;
          lastRef.current.paragraphIndex = null;
          setHighlightState({
            activeCueIndex: null,
            activeParagraphIndex: null,
            activeCueRange: null,
          });
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

      const cueIndexChanged = idx !== lastRef.current.cueIndex;
      if (cueIndexChanged) {
        lastRef.current.cueIndex = idx;
        if (onOffsetChange) onOffsetChange(range.start);
        console.log("[Highlight] cueIndex", {
          chapterId,
          cueIndex: idx,
          cueCount: cueMap.cues.length,
          positionMs,
        });
      }
      if (nextParagraphIndex !== lastRef.current.paragraphIndex) {
        lastRef.current.paragraphIndex = nextParagraphIndex;
      }

      setHighlightState((prev) => {
        const next = {
          activeCueIndex: idx,
          activeParagraphIndex: nextParagraphIndex,
          activeCueRange: range,
        };
        if (
          prev.activeCueIndex === next.activeCueIndex &&
          prev.activeParagraphIndex === next.activeParagraphIndex &&
          prev.activeCueRange?.start === next.activeCueRange?.start &&
          prev.activeCueRange?.end === next.activeCueRange?.end
        ) {
          return prev;
        }
        return next;
      });
    };

    const unsubscribe = playbackAdapter.onState((state) => updateFromState(state));
    updateFromState(playbackAdapter.getState(), true);

    const poll = setInterval(
      () => {
        const state = playbackAdapter.getState();
        if (state.isPlaying) {
          updateFromState(state, true);
        }
      },
      Math.max(80, throttleMs)
    );

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
  ]);

  // Reset on chapter change or cue map invalidation
  useEffect(() => {
    setHighlightState({
      activeCueIndex: null,
      activeParagraphIndex: null,
      activeCueRange: null,
    });
    lastRef.current.cueIndex = null;
    lastRef.current.paragraphIndex = null;
    lastRef.current.lastPosMs = 0;
    lastRef.current.lastUpdateAt = 0;
    warnRef.current = { chapterId, warned: false };
  }, [chapterId, cueMap?.chapterId]);

  useEffect(() => {
    if (!enabled) {
      setHighlightState({
        activeCueIndex: null,
        activeParagraphIndex: null,
        activeCueRange: null,
      });
      lastRef.current.cueIndex = null;
      lastRef.current.paragraphIndex = null;
    }
  }, [enabled]);

  return useMemo(
    () => ({
      activeCueIndex: highlightState.activeCueIndex,
      activeParagraphIndex: highlightState.activeParagraphIndex,
      activeCueRange: highlightState.activeCueRange,
      isCueReady: cueReady,
    }),
    [highlightState.activeCueIndex, highlightState.activeParagraphIndex, highlightState.activeCueRange, cueReady]
  );
}
