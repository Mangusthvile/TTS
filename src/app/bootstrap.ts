import { Capacitor } from "@capacitor/core";
import { SocialLogin } from "@capgo/capacitor-social-login";
import { initStorage } from "../../services/storageSingleton";
import { migrateLegacyLocalStorageIfNeeded } from "../../services/libraryMigration";
import { authManager } from "../../services/authManager";

declare global {
  interface Window {
    __TALEVOX_SOCIALLOGIN_READY__?: Promise<void>;
  }
}

let dbReady: Promise<void> | null = null;
let authReady: Promise<void> | null = null;
let syncReady: Promise<void> | null = null;

export function ensureDbReady(): Promise<void> {
  if (!dbReady) {
    dbReady = initStorage().then(() => undefined);
  }
  return dbReady;
}

export function ensureAuthReady(clientId?: string): Promise<void> {
  if (authReady) return authReady;
  authReady = (async () => {
    if (!Capacitor.isNativePlatform()) {
      if (clientId) authManager.init(clientId);
      return;
    }

    const webClientId =
      (import.meta as any).env?.VITE_GOOGLE_WEB_CLIENT_ID || clientId || "";

    if (!webClientId) {
      console.warn(
        "[TaleVox][Auth] Missing VITE_GOOGLE_WEB_CLIENT_ID (Google login will fail)"
      );
      return;
    }

    await SocialLogin.initialize({
      google: {
        webClientId,
        mode: "online",
      },
    });
    console.log("[TaleVox][Auth] SocialLogin initialized");
  })().catch((err) => {
    authReady = null;
    throw err;
  });

  if (typeof window !== "undefined") {
    window.__TALEVOX_SOCIALLOGIN_READY__ = authReady;
  }

  return authReady;
}

export function ensureSyncReady(): Promise<void> {
  if (!syncReady) {
    syncReady = migrateLegacyLocalStorageIfNeeded().then(() => undefined);
  }
  return syncReady;
}

export async function bootstrapCore(clientId?: string): Promise<void> {
  await ensureDbReady();
  await ensureAuthReady(clientId);
  await ensureSyncReady();
}
