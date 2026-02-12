
import { trace } from '../utils/trace';

export type PlaybackItem = {
  id: string;
  url: string;
  title?: string;
  artist?: string;
  album?: string;
  artworkUrl?: string;
};

export type PlaybackState = {
  currentTime: number;
  duration: number;
  isPlaying: boolean;
  speed: number;
  positionMs: number;
  durationMs: number;
  playbackRate: number;
  currentItemId?: string | null;
};

export type PlaybackStateListener = (state: PlaybackState) => void;
export type PlaybackItemListener = (item: PlaybackItem | null) => void;
export type PlaybackErrorListener = (error: unknown) => void;

export interface PlaybackAdapter {
  load: (item: PlaybackItem) => void | Promise<void>;
  loadQueue: (items: PlaybackItem[], startIndex: number) => void | Promise<void>;
  play: () => void | Promise<void>;
  pause: () => void;
  stop: () => void;
  seek: (ms: number) => void | Promise<void>;
  setSpeed: (rate: number) => void;
  getState: () => PlaybackState;
  onState: (listener: PlaybackStateListener) => () => void;
  onItemChanged: (listener: PlaybackItemListener) => () => void;
  onEnded: (listener: () => void) => () => void;
  onError: (listener: PlaybackErrorListener) => () => void;
};

export class DesktopPlaybackAdapter implements PlaybackAdapter {
  private audio: HTMLAudioElement;
  private queue: PlaybackItem[] = [];
  private currentIndex = -1;
  private stateListeners = new Set<PlaybackStateListener>();
  private itemListeners = new Set<PlaybackItemListener>();
  private endedListeners = new Set<() => void>();
  private errorListeners = new Set<PlaybackErrorListener>();
  private stateInterval: any = null;

  constructor(audio?: HTMLAudioElement) {
    this.audio = audio ?? new Audio();
    this.audio.preload = 'auto';
    this.bindEvents();
  }

  getAudioElement() {
    return this.audio;
  }

  load(item: PlaybackItem) {
    this.queue = [item];
    this.currentIndex = 0;
    this.applyItem(item);
  }

  loadQueue(items: PlaybackItem[], startIndex: number) {
    this.queue = items;
    const clamped = Math.max(0, Math.min(startIndex, items.length - 1));
    this.currentIndex = items.length > 0 ? clamped : -1;
    const item = this.currentIndex >= 0 ? items[this.currentIndex] : null;
    if (item) this.applyItem(item);
  }

  play() {
    return this.audio.play();
  }

  pause() {
    this.audio.pause();
  }

  stop() {
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.src = '';
    this.audio.load();
    this.emitState();
  }

  seek(ms: number) {
    this.audio.currentTime = Math.max(0, ms / 1000);
  }

  setSpeed(rate: number) {
    this.audio.defaultPlaybackRate = rate;
    this.audio.playbackRate = rate;
    this.emitState();
  }

  getState(): PlaybackState {
    return {
      currentTime: this.audio.currentTime || 0,
      duration: Number.isFinite(this.audio.duration) ? this.audio.duration : 0,
      isPlaying: !this.audio.paused,
      speed: this.audio.playbackRate || 1,
      positionMs: Math.floor((this.audio.currentTime || 0) * 1000),
      durationMs: Math.floor(((Number.isFinite(this.audio.duration) ? this.audio.duration : 0) || 0) * 1000),
      playbackRate: this.audio.playbackRate || 1,
      currentItemId: this.queue[this.currentIndex]?.id ?? null,
    };
  }

  onState(listener: PlaybackStateListener) {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  onItemChanged(listener: PlaybackItemListener) {
    this.itemListeners.add(listener);
    return () => this.itemListeners.delete(listener);
  }

  onEnded(listener: () => void) {
    this.endedListeners.add(listener);
    return () => this.endedListeners.delete(listener);
  }

  onError(listener: PlaybackErrorListener) {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  private bindEvents() {
    const emit = () => this.emitState();
    this.audio.addEventListener('timeupdate', emit);
    this.audio.addEventListener('play', emit);
    this.audio.addEventListener('pause', emit);
    this.audio.addEventListener('loadedmetadata', emit);
    this.audio.addEventListener('ratechange', emit);
    this.audio.addEventListener('ended', () => {
      this.emitState();
      this.endedListeners.forEach((listener) => listener());
    });
    this.audio.addEventListener('error', () => {
      const err = this.audio.error ?? new Error('Playback error');
      this.errorListeners.forEach((listener) => listener(err));
    });
  }

  private applyItem(item: PlaybackItem) {
    this.audio.src = item.url;
    this.audio.load();
    this.itemListeners.forEach((listener) => listener(item));
    this.emitState();
  }

  private emitState() {
    const state = this.getState();
    this.stateListeners.forEach((listener) => listener(state));

    // Throttle state emit while playing
    if (state.isPlaying && this.stateInterval === null) {
      this.stateInterval = setInterval(() => {
        const s = this.getState();
        this.stateListeners.forEach((listener) => listener(s));
        if (!s.isPlaying) {
          clearInterval(this.stateInterval);
          this.stateInterval = null;
        }
      }, 250);
    } else if (!state.isPlaying && this.stateInterval !== null) {
      clearInterval(this.stateInterval);
      this.stateInterval = null;
    }
  }
}

export class MobilePlaybackAdapter implements PlaybackAdapter {
  private state: PlaybackState = {
    currentTime: 0,
    duration: 0,
    isPlaying: false,
    speed: 1,
    positionMs: 0,
    durationMs: 0,
    playbackRate: 1,
  };
  private stateListeners = new Set<PlaybackStateListener>();
  private itemListeners = new Set<PlaybackItemListener>();
  private endedListeners = new Set<() => void>();
  private errorListeners = new Set<PlaybackErrorListener>();
  private nativeListenersBound = false;
  private pollTimer: any = null;
  private currentItemId: string | null = null;
  private lastLoggedIsPlaying: boolean | null = null;
  private lastLoggedItemId: string | null = null;

  constructor(private plugin: typeof import('./nativePlayer').NativePlayer) {
    void this.bindNativeListeners();
  }

  async load(item: PlaybackItem) {
    await this.plugin.load({ item });
    this.currentItemId = item.id;
    this.itemListeners.forEach((listener) => listener(item));
  }

  async loadQueue(items: PlaybackItem[], startIndex: number) {
    await this.plugin.loadQueue({ items, startIndex });
    const current = items[startIndex] ?? null;
    this.currentItemId = current?.id ?? null;
    this.itemListeners.forEach((listener) => listener(current));
  }

  play() {
    return this.plugin.play();
  }

  pause() {
    void this.plugin.pause();
  }

  stop() {
    void this.plugin.stop();
  }

  seek(ms: number) {
    return this.plugin.seekTo({ ms });
  }

  setSpeed(rate: number) {
    this.state.speed = rate;
    void this.plugin.setSpeed({ rate });
    this.emitState();
  }

  getState(): PlaybackState {
    return {
      ...this.state,
      positionMs: Math.floor((this.state.currentTime ?? 0) * 1000),
      durationMs: Math.floor((this.state.duration ?? 0) * 1000),
      playbackRate: this.state.speed ?? 1,
      currentItemId: this.currentItemId,
    };
  }

  onState(listener: PlaybackStateListener) {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  onItemChanged(listener: PlaybackItemListener) {
    this.itemListeners.add(listener);
    return () => this.itemListeners.delete(listener);
  }

  onEnded(listener: () => void) {
    this.endedListeners.add(listener);
    return () => this.endedListeners.delete(listener);
  }

  onError(listener: PlaybackErrorListener) {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  private emitState() {
    const state = this.getState();
    this.stateListeners.forEach((listener) => listener(state));
    this.logStateTransition(state);
  }

  private logStateTransition(state: PlaybackState) {
    const nextItemId = state.currentItemId ?? null;
    const isPlayingChanged =
      this.lastLoggedIsPlaying === null || this.lastLoggedIsPlaying !== state.isPlaying;
    const itemChanged = this.lastLoggedItemId !== nextItemId;

    if (isPlayingChanged || itemChanged) {
      trace('playback:state', {
        isPlaying: state.isPlaying,
        positionMs: state.positionMs,
        durationMs: state.durationMs,
        currentItemId: state.currentItemId ?? null,
      });
      this.lastLoggedIsPlaying = state.isPlaying;
      this.lastLoggedItemId = nextItemId;
    }
  }

  private async bindNativeListeners() {
    if (this.nativeListenersBound) return;
    this.nativeListenersBound = true;

    await this.plugin.addListener('state', (event: any) => {
      this.state = {
        currentTime: event?.currentTime ?? 0,
        duration: event?.duration ?? 0,
        isPlaying: !!event?.isPlaying,
        speed: event?.speed ?? this.state.speed,
        positionMs: Math.floor((event?.currentTime ?? 0) * 1000),
        durationMs: Math.floor((event?.duration ?? 0) * 1000),
        playbackRate: event?.speed ?? this.state.speed ?? 1,
      };
      this.handlePolling();
      this.emitState();
    });

    await this.plugin.addListener('itemChanged', (event: any) => {
      const item = event?.item ?? null;
      this.currentItemId = item?.id ?? null;
      this.itemListeners.forEach((listener) => listener(item));
      trace('playback:item', { currentItemId: this.currentItemId });
    });

    await this.plugin.addListener('ended', () => {
      this.endedListeners.forEach((listener) => listener());
      trace('playback:ended', { currentItemId: this.currentItemId });
    });

    await this.plugin.addListener('error', (event: any) => {
      const error = event?.error ?? new Error('NativePlayer error');
      this.errorListeners.forEach((listener) => listener(error));
    });
  }

  private handlePolling() {
    if (this.state.isPlaying) {
      if (this.pollTimer == null) {
        this.pollTimer = setInterval(async () => {
          try {
            const res = await this.plugin.getState();
            this.state = {
              currentTime: res?.currentTime ?? this.state.currentTime,
              duration: res?.duration ?? this.state.duration,
              isPlaying: res?.isPlaying ?? this.state.isPlaying,
              speed: res?.speed ?? this.state.speed,
              positionMs: Math.floor((res?.currentTime ?? this.state.currentTime ?? 0) * 1000),
              durationMs: Math.floor((res?.duration ?? this.state.duration ?? 0) * 1000),
              playbackRate: res?.speed ?? this.state.speed ?? 1,
            };
            this.emitState();
            if (!this.state.isPlaying) {
              clearInterval(this.pollTimer);
              this.pollTimer = null;
            }
          } catch {
            // ignore transient errors
          }
        }, 250);
      }
    } else if (this.pollTimer != null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }
}
