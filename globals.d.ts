declare global {
  // Vite compile-time injected globals (see vite.config.ts `define`).
  const __APP_VERSION__: string;
  const __ANDROID_ONLY__: boolean;

  // Screen Wake Lock API (prevent screen sleep when "Keep Awake" is on)
  interface WakeLockSentinel {
    release(): Promise<void>;
    readonly released: boolean;
    addEventListener(
      type: "release",
      listener: () => void,
      options?: boolean | AddEventListenerOptions
    ): void;
    removeEventListener(type: "release", listener: () => void): void;
  }
  interface WakeLockManager {
    request(type: "screen"): Promise<WakeLockSentinel>;
  }
  interface Navigator {
    wakeLock?: WakeLockManager;
  }

  interface Window {
    __APP_VERSION__: string;
    gapi?: {
      load: (name: string, callback: () => void) => void;
      client?: {
        drive?: {
          files?: any;
        };
      };
    };
    google?: {
      picker?: any;
    };
    __TALEVOX_FATAL_ERROR__?: {
      message: string;
      stack?: string;
      info?: string;
      timestamp?: number;
      version?: string;
      userAgent?: string;
    };
  }
}

export {};
