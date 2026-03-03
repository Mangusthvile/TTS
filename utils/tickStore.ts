/**
 * External mutable store for high-frequency playback tick state.
 *
 * By keeping audioCurrentTime and playbackSnapshot outside React state, only
 * components that explicitly subscribe (via usePlaybackTick / useSyncExternalStore)
 * re-render on each tick. App itself — which calls usePlayback — does not re-render.
 */

export type TickPlaybackSnapshot = { chapterId: string; percent: number } | null;

export type TickState = {
  audioCurrentTime: number;
  playbackSnapshot: TickPlaybackSnapshot;
};

let state: TickState = { audioCurrentTime: 0, playbackSnapshot: null };
const listeners = new Set<() => void>();

function notify(): void {
  listeners.forEach((l) => l());
}

export const tickStore = {
  getSnapshot(): TickState {
    return state;
  },

  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  setAudioCurrentTime(t: number): void {
    if (state.audioCurrentTime === t) return;
    state = { ...state, audioCurrentTime: t };
    notify();
  },

  setPlaybackSnapshot(s: TickPlaybackSnapshot): void {
    if (state.playbackSnapshot === s) return;
    state = { ...state, playbackSnapshot: s };
    notify();
  },

  /** Atomically reset both values on chapter load to emit a single notification. */
  resetTick(): void {
    if (state.audioCurrentTime === 0 && state.playbackSnapshot === null) return;
    state = { audioCurrentTime: 0, playbackSnapshot: null };
    notify();
  },
};
