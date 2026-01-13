// services/storageSingleton.ts
import { createStorageDriver } from "./storageDriver";
import type { StorageDriver } from "./storageDriver";

declare global {
  interface Window {
    __TALEVOX_STORAGE__?: StorageDriver;
  }
}

let driver: StorageDriver | null = null;
let initPromise: Promise<StorageDriver> | null = null;

export async function initStorage(): Promise<StorageDriver> {
  if (driver) return driver;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const d = createStorageDriver();
    const res = await d.init();
    driver = d;

    // Expose for debugging in Chrome inspect:
    // window.__TALEVOX_STORAGE__.loadChapterProgress("chapterId")
    if (typeof window !== "undefined") {
      window.__TALEVOX_STORAGE__ = d;
      console.log("[TaleVox][Storage] init:", res);
    }

    return d;
  })();

  return initPromise;
}

export function getStorage(): StorageDriver {
  if (!driver) {
    throw new Error(
      "Storage not initialized. Call initStorage() once at app startup."
    );
  }
  return driver;
}
