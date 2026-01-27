import { registerPlugin } from '@capacitor/core';

export type NativePlayerItem = { id: string; url: string; title?: string };

export type NativePlayerState = {
  currentTime: number;
  duration: number;
  isPlaying: boolean;
  speed: number;
  currentItemId?: string | null;
};

export interface NativePlayerPlugin {
  load: (options: { item: NativePlayerItem }) => Promise<void>;
  loadQueue: (options: { items: NativePlayerItem[]; startIndex: number }) => Promise<void>;
  play: () => Promise<void>;
  pause: () => Promise<void>;
  stop: () => Promise<void>;
  seekTo: (options: { ms: number }) => Promise<void>;
  setSpeed: (options: { rate: number }) => Promise<void>;
  next: () => Promise<void>;
  previous: () => Promise<void>;
  getState: () => Promise<NativePlayerState>;
  addListener: (
    eventName: 'state' | 'itemChanged' | 'ended' | 'error',
    listenerFunc: (event: any) => void
  ) => Promise<{ remove: () => Promise<void> }>;
  removeAllListeners: () => Promise<void>;
}

export const NativePlayer = registerPlugin<NativePlayerPlugin>('NativePlayer');
