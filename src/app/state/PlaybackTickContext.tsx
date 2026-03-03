import { useSyncExternalStore } from "react";
import { tickStore } from "../../../utils/tickStore";

export type PlaybackTickSnapshot = { chapterId: string; percent: number } | null;

export type PlaybackTickContextValue = {
  audioCurrentTime: number;
  playbackSnapshot: PlaybackTickSnapshot;
};

/**
 * Subscribe to high-frequency playback tick state without triggering App re-renders.
 * Reads from tickStore via useSyncExternalStore — only the calling component re-renders.
 * App does not call this hook; tick is consumed only by Player, ChapterSidebar, and
 * PlaybackDiagnosticsOverlay, so the rest of the tree (including App) stays stable on tick.
 */
export function usePlaybackTick(): PlaybackTickContextValue {
  return useSyncExternalStore(tickStore.subscribe, tickStore.getSnapshot);
}
