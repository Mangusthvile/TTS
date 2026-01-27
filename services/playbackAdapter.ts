export type PlaybackItem = { id: string; url: string; title?: string };

export type PlaybackState = {
  currentTime: number;
  duration: number;
  isPlaying: boolean;
  speed: number;
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
  }
}

export class MobilePlaybackAdapter implements PlaybackAdapter {
  private state: PlaybackState = {
    currentTime: 0,
    duration: 0,
    isPlaying: false,
    speed: 1,
  };
  private stateListeners = new Set<PlaybackStateListener>();
  private itemListeners = new Set<PlaybackItemListener>();
  private endedListeners = new Set<() => void>();
  private errorListeners = new Set<PlaybackErrorListener>();
  private nativeListenersBound = false;

  constructor(private plugin: typeof import('./nativePlayer').NativePlayer) {
    void this.bindNativeListeners();
  }

  async load(item: PlaybackItem) {
    await this.plugin.load({ item });
    this.itemListeners.forEach((listener) => listener(item));
  }

  async loadQueue(items: PlaybackItem[], startIndex: number) {
    await this.plugin.loadQueue({ items, startIndex });
    const current = items[startIndex] ?? null;
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
    return { ...this.state };
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
      };
      this.emitState();
    });

    await this.plugin.addListener('itemChanged', (event: any) => {
      const item = event?.item ?? null;
      this.itemListeners.forEach((listener) => listener(item));
    });

    await this.plugin.addListener('ended', () => {
      this.endedListeners.forEach((listener) => listener());
    });

    await this.plugin.addListener('error', (event: any) => {
      const error = event?.error ?? new Error('NativePlayer error');
      this.errorListeners.forEach((listener) => listener(error));
    });
  }
}
