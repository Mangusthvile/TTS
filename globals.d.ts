declare global {
  // Vite compile-time injected globals (see vite.config.ts `define`).
  const __APP_VERSION__: string;
  const __ANDROID_ONLY__: boolean;

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
