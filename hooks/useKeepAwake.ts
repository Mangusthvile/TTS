import { useEffect, useRef } from "react";
import { Capacitor } from "@capacitor/core";
import { KeepAwake } from "@capacitor-community/keep-awake";

/**
 * Keeps the screen on when keepAwake is true.
 * - Native (Android/iOS): uses @capacitor-community/keep-awake (FLAG_KEEP_SCREEN_ON).
 * - Web / WebView fallback: uses Screen Wake Lock API (navigator.wakeLock).
 */
export function useKeepAwake(keepAwake: boolean): void {
  const sentinelRef = useRef<WakeLockSentinel | null>(null);

  useEffect(() => {
    if (!keepAwake) {
      if (sentinelRef.current) {
        sentinelRef.current.release().catch(() => {});
        sentinelRef.current = null;
      }
      KeepAwake.allowSleep().catch(() => {});
      return;
    }

    const isNative = Capacitor.isNativePlatform?.() ?? false;

    if (isNative) {
      KeepAwake.keepAwake().catch(() => {});
      return () => {
        KeepAwake.allowSleep().catch(() => {});
      };
    }

    const nav = navigator as Navigator;
    const hasWakeLock = typeof nav.wakeLock?.request === "function";
    if (!hasWakeLock) return;

    const requestLock = () => {
      if (document.visibilityState !== "visible") return;
      nav.wakeLock!.request("screen").then(
        (s) => {
          sentinelRef.current = s;
        },
        () => {}
      );
    };

    const releaseLock = () => {
      if (sentinelRef.current) {
        sentinelRef.current.release().catch(() => {});
        sentinelRef.current = null;
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") requestLock();
      else releaseLock();
    };

    if (document.visibilityState === "visible") requestLock();
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      releaseLock();
    };
  }, [keepAwake]);
}
