import { trace, traceError } from "../utils/trace";
import { Capacitor } from "@capacitor/core";
import { SocialLogin } from "@capgo/capacitor-social-login";
import { initStorage } from "./storageSingleton";

export type AuthStatus = "signed_out" | "signing_in" | "signed_in" | "expired" | "error";

export interface AuthState {
  status: AuthStatus;
  accessToken: string | null;
  userEmail?: string;
  lastError?: string;
  expiresAt: number;
}

type AuthListener = (state: AuthState) => void;

class AuthManager {
  private clientId: string | null = null;
  private initRetries = 0;
  private initRetryTimer: any = null;

  private state: AuthState = {
    status: "signed_out",
    accessToken: null,
    expiresAt: 0,
  };

  private listeners: Set<AuthListener> = new Set();
  private tokenClient: any = null;
  private validationAbortController: AbortController | null = null;
  private lastStatus: AuthStatus | null = null;
  private nativeSignInInFlight: Promise<string | null> | null = null;
  private nativeSignInInFlightIsInteractive = false;
  private lastSilentSignInFailedAt = 0;
  private static readonly SILENT_SIGNIN_COOLDOWN_MS = 15_000; // 15s between silent retries

  constructor() {
    void this.loadFromStorage();
  }

  private async loadFromStorage() {
    try {
      const driver = await initStorage();
      const res = await driver.loadAuthSession();
      const data = res.ok ? res.value : null;
      if (data?.accessToken && data.expiresAt > Date.now()) {
        this.state = {
          ...this.state,
          accessToken: data.accessToken,
          expiresAt: data.expiresAt,
          status: "signed_in",
          userEmail: data.userEmail,
        };
        this.notify();
        const secondsRemaining = Math.max(0, Math.floor((data.expiresAt - Date.now()) / 1000));
        console.log(
          `[TaleVox][Auth] Loaded token (expiresAt=${data.expiresAt}, remaining=${secondsRemaining}s, source=${res.where})`
        );
        setTimeout(() => this.validateToken(), 1000);
        return;
      }

      if (!data) {
        console.log(`[TaleVox][Auth] No stored token found (source=${res.where})`);
      }
    } catch (e) {
      traceError("auth:load_failed", e);
    }
  }

  private async saveToStorage() {
    try {
      const driver = await initStorage();
      if (this.state.accessToken) {
        await driver.saveAuthSession({
          accessToken: this.state.accessToken,
          expiresAt: this.state.expiresAt,
          userEmail: this.state.userEmail,
          status: this.state.status,
        });
      } else {
        await driver.clearAuthSession();
      }
    } catch (e) {
      traceError("auth:save_failed", e);
    }
  }

  public markExpired(reason?: string) {
    this.updateState({ status: "expired", lastError: reason });
  }

  public subscribe(listener: AuthListener) {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  private notify() {
    this.listeners.forEach((l) => l(this.state));
  }

  public init(clientId: string) {
    this.clientId = clientId;

    if (Capacitor.isNativePlatform()) {
      trace("auth:init:native");
      return;
    }

    if (__ANDROID_ONLY__) {
      trace("auth:init:web_skipped_android_only");
      this.updateState({
        status: "signed_out",
        lastError: "Web sign-in disabled in Android-only build",
      });
      return;
    }

    if (this.tokenClient) return;

    const script =
      typeof document !== "undefined"
        ? document.querySelector('script[src*="gsi/client"]')
        : null;
    if (script && !(window as any).google?.accounts?.oauth2) {
      script.addEventListener("load", () => this.tryInit(), { once: true });
      return;
    }
    if (script && (window as any).google?.accounts?.oauth2) {
      this.tryInit();
      return;
    }

    this.tryInit();
  }

  private tryInit() {
    const clientId = this.clientId;
    if (!clientId) return;
    if (this.tokenClient) return;

    if (!(window as any).google?.accounts?.oauth2) {
      this.initRetries += 1;
      if (this.initRetries <= 20) {
        this.initRetryTimer = setTimeout(() => this.tryInit(), 500);
      } else {
        traceError(
          "auth:init_failed_no_gis",
          new Error(
            "Google Identity Services not available (window.google.accounts.oauth2 missing)"
          )
        );
        this.updateState({ status: "error", lastError: "Google Sign-In script not loaded" });
      }
      return;
    }

    if (this.initRetryTimer != null) {
      clearTimeout(this.initRetryTimer);
      this.initRetryTimer = null;
    }

    try {
      this.tokenClient = (window as any).google.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope:
          "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.metadata.readonly https://www.googleapis.com/auth/drive.readonly",
        callback: (resp: any) => this.handleTokenResponse(resp),
        error_callback: (err: any) => {
          traceError("auth:gis_error", err);
          this.updateState({
            status: "error",
            lastError: err.message || "Auth initialization error",
          });
        },
      });
      trace("auth:initialized");
    } catch (e) {
      traceError("auth:init_exception", e);
      this.updateState({ status: "error", lastError: "Auth init failed" });
    }
  }

  private handleTokenResponse(resp: any) {
    if (resp.error) {
      traceError("auth:token_error", resp);
      this.updateState({ status: "error", lastError: resp.error });
      return;
    }

    const expiresIn = Number(resp.expires_in) || 3600;
    this.updateState({
      accessToken: resp.access_token,
      expiresAt: Date.now() + expiresIn * 1000,
      status: "signed_in",
      lastError: undefined,
    });
    void this.saveToStorage();
    this.validateToken();
    trace("auth:token_received");
  }

  public async ensureValidToken(interactive: boolean): Promise<string> {
    console.log(`[TaleVox][Auth] ensureValidToken ${interactive ? "interactive" : "silent"}`);
    const token = this.getToken();
    if (token) {
      return token;
    }

    if (Capacitor.isNativePlatform()) {
      const tokenFromNative = await this.nativeSignIn({
        interactive,
        filterByAuthorizedAccounts: !interactive,
        autoSelectEnabled: !interactive,
        forceRefreshToken: !interactive,
      });
      if (tokenFromNative) {
        this.updateState({ status: "signed_in" });
        return tokenFromNative;
      }
      const reason = this.state.lastError || "Reconnect required";
      this.markExpired(reason);
      throw new Error(reason);
    }

    if (__ANDROID_ONLY__) {
      this.markExpired("Web sign-in disabled in Android-only build");
      throw new Error("AUTH_DISABLED_ANDROID_ONLY_WEB");
    }

    if (interactive) {
      this.signIn();
      return new Promise((resolve, reject) => {
        let unsub: (() => void) | null = null;
        unsub = this.subscribe((state) => {
          if (state.status === "signed_in" && state.accessToken) {
            const cleanup = unsub;
            unsub = null;
            cleanup?.();
            resolve(state.accessToken);
          } else if (state.status === "expired" || state.status === "error") {
            const cleanup = unsub;
            unsub = null;
            cleanup?.();
            this.markExpired(state.lastError || "Reconnect required");
            reject(new Error(state.lastError || "Reconnect required"));
          }
        });
      });
    }

    this.markExpired("Reconnect required");
    throw new Error("AUTH_EXPIRED");
  }

  public signIn() {
    if (Capacitor.isNativePlatform()) {
      void this.nativeSignIn({ interactive: true });
      return;
    }

    if (__ANDROID_ONLY__) {
      this.updateState({
        status: "error",
        lastError: "Web sign-in disabled in Android-only build",
      });
      return;
    }

    if (!this.tokenClient) {
      this.updateState({ status: "error", lastError: "Google Sign-In not initialized" });
      trace("auth:signin_fail_no_client", {}, "error");
      if (this.clientId) this.init(this.clientId);
      return;
    }

    this.updateState({ status: "signing_in", lastError: undefined });
    trace("auth:signin_start");

    let timeoutCount = 0;
    const SIGNIN_TIMEOUT_MS = 15000;
    const RETRY_DELAY_MS = 2000;

    const scheduleTimeout = () => {
      setTimeout(() => {
        if (this.state.status !== "signing_in") return;
        timeoutCount += 1;
        if (timeoutCount === 1) {
          trace("auth:signin_timeout_retry");
          setTimeout(() => {
            if (this.state.status !== "signing_in") return;
            this.tokenClient?.requestAccessToken({ prompt: "" });
            scheduleTimeout();
          }, RETRY_DELAY_MS);
        } else {
          this.updateState({
            status: "error",
            lastError: "Sign-in timed out. Popup may have been blocked.",
          });
        }
      }, SIGNIN_TIMEOUT_MS);
    };
    scheduleTimeout();

    // Use empty prompt so Google only shows the chooser when the user hasn't previously
    // authorized. Forcing 'consent' every time is what caused 4 repeated popups.
    this.tokenClient.requestAccessToken({ prompt: "" });
  }

  /** Force interactive sign-in with account picker (e.g. when popup was blocked or timeout). */
  public signInWithPrompt() {
    if (Capacitor.isNativePlatform()) {
      void this.nativeSignIn({ interactive: true });
      return;
    }
    if (__ANDROID_ONLY__) {
      this.updateState({
        status: "error",
        lastError: "Web sign-in disabled in Android-only build",
      });
      return;
    }
    if (!this.tokenClient) {
      this.updateState({ status: "error", lastError: "Google Sign-In not initialized" });
      if (this.clientId) this.init(this.clientId);
      return;
    }
    this.updateState({ status: "signing_in", lastError: undefined });
    trace("auth:signin_start:with_prompt");
    setTimeout(() => {
      if (this.state.status === "signing_in") {
        this.updateState({
          status: "error",
          lastError: "Sign-in timed out. Popup may have been blocked.",
        });
      }
    }, 25000);
    this.tokenClient.requestAccessToken({ prompt: "select_account" });
  }

  private async nativeSignIn(opts?: {
    interactive?: boolean;
    filterByAuthorizedAccounts?: boolean;
    autoSelectEnabled?: boolean;
    forceRefreshToken?: boolean;
  }): Promise<string | null> {
    const isInteractive = !!opts?.interactive;

    if (this.nativeSignInInFlight) {
      // If the in-flight call is interactive (showing a picker), always reuse it —
      // we don't want a second picker. If it's non-interactive (silent) and a new
      // interactive request arrives, wait for the silent one to finish then start
      // a fresh interactive sign-in.
      if (this.nativeSignInInFlightIsInteractive || !isInteractive) {
        return this.nativeSignInInFlight;
      }
      // Non-interactive in-flight, but interactive requested: chain after the silent one.
      return this.nativeSignInInFlight.then(() => this.nativeSignIn(opts));
    }

    this.nativeSignInInFlightIsInteractive = isInteractive;
    this.nativeSignInInFlight = this._doNativeSignIn(opts).finally(() => {
      this.nativeSignInInFlight = null;
      this.nativeSignInInFlightIsInteractive = false;
    });
    return this.nativeSignInInFlight;
  }

  private async _doNativeSignIn(opts?: {
    interactive?: boolean;
    filterByAuthorizedAccounts?: boolean;
    autoSelectEnabled?: boolean;
    forceRefreshToken?: boolean;
  }) {
    // If this is a silent (non-interactive) attempt and the last one just failed,
    // skip it to avoid spamming the user with repeated popups/choosers.
    if (!opts?.interactive) {
      const now = Date.now();
      if (now - this.lastSilentSignInFailedAt < AuthManager.SILENT_SIGNIN_COOLDOWN_MS) {
        this.markExpired("Reconnect required");
        return null;
      }
    }

    this.updateState({ status: "signing_in", lastError: undefined });
    trace("auth:signin_start:native");

    // Clear any cached expired session so the plugin shows a fresh account picker
    if (opts?.interactive) {
      try {
        await (SocialLogin as any).logout?.({ provider: "google" });
      } catch {
        // ignore
      }
    }

    const watchdog = setTimeout(() => {
      if (this.state.status === "signing_in") {
        this.updateState({ status: "error", lastError: "Sign-in timed out." });
      }
    }, 20000);

    try {
      const scopes = [
        "https://www.googleapis.com/auth/drive.file",
        "https://www.googleapis.com/auth/drive.metadata.readonly",
        "https://www.googleapis.com/auth/drive.readonly",
      ];

      const raw: any = await (SocialLogin as any).login({
        provider: "google",
        options: {
          scopes,
          filterByAuthorizedAccounts: !!opts?.filterByAuthorizedAccounts,
          autoSelectEnabled: !!opts?.autoSelectEnabled,
          forceRefreshToken: !!opts?.forceRefreshToken,
        },
      });

      // Some versions wrap everything inside `result`
      const res: any = raw?.result ?? raw;

      // accessToken might be a string OR an object like { token: "ya29..." }
      const tokenCandidate =
        res?.accessToken ??
        res?.access_token ??
        res?.authentication?.accessToken ??
        res?.authentication?.access_token ??
        res?.credential?.accessToken ??
        res?.credential?.access_token;

      let accessToken: string | undefined;

      if (typeof tokenCandidate === "string") {
        accessToken = tokenCandidate;
      } else if (tokenCandidate && typeof tokenCandidate === "object") {
        accessToken =
          tokenCandidate.token || tokenCandidate.accessToken || tokenCandidate.access_token;
      }

      const expiresIn = Number(
        (tokenCandidate &&
          typeof tokenCandidate === "object" &&
          (tokenCandidate.expiresIn || tokenCandidate.expires_in)) ??
          res?.expiresIn ??
          res?.expires_in ??
          3600
      );

      if (!accessToken) {
        traceError("auth:native_no_access_token", raw);
        if (opts?.interactive) {
          this.updateState({
            status: "error",
            lastError: "Google sign-in returned no access token",
          });
        } else {
          this.markExpired("Google sign-in returned no access token");
        }
        return null;
      }

      this.updateState({
        accessToken,
        expiresAt: Date.now() + expiresIn * 1000,
        status: "signed_in",
        lastError: undefined,
      });

      this.lastSilentSignInFailedAt = 0; // clear cooldown on success
      void this.saveToStorage();
      await this.validateToken();
      trace("auth:token_received:native");
      return accessToken;
    } catch (e: any) {
      const parts = [
        e?.message,
        e?.error?.message,
        typeof e?.code === "number" ? `(code ${e.code})` : e?.code,
      ].filter(Boolean);
      const message = parts.length > 0 ? parts.join(" ") : "Native sign-in failed";
      traceError("auth:native_signin_failed", e);
      if (typeof console !== "undefined" && console.error) {
        console.error("[TaleVox][Auth] native_signin_failed:", message, e);
      }
      if (opts?.interactive) {
        this.updateState({ status: "error", lastError: message });
      } else {
        this.lastSilentSignInFailedAt = Date.now();
        this.markExpired(message);
      }
      return null;
    } finally {
      clearTimeout(watchdog);
    }
  }

  public signOut() {
    this.updateState({
      status: "signed_out",
      accessToken: null,
      expiresAt: 0,
      userEmail: undefined,
    });
    void this.saveToStorage();

    if (Capacitor.isNativePlatform()) {
      void (SocialLogin as any).logout?.({ provider: "google" }).catch(() => {});
    }

    try {
      localStorage.removeItem("talevox_drive_token_v2");
    } catch {}
    trace("auth:signed_out");
  }

  public async validateToken() {
    if (!this.state.accessToken) return false;

    if (this.validationAbortController) this.validationAbortController.abort();
    this.validationAbortController = new AbortController();

    try {
      const token = await this.ensureValidToken(false);
      const res = await fetch("https://www.googleapis.com/drive/v3/about?fields=user", {
        headers: { Authorization: `Bearer ${token}` },
        signal: this.validationAbortController.signal,
      });

      if (!res.ok) {
        if (res.status === 401) {
          this.markExpired("Session expired");
        } else {
          trace("auth:validate_http_error", { status: res.status });
        }
        return false;
      }

      const data = await res.json();
      this.updateState({
        status: "signed_in",
        userEmail: data.user?.emailAddress,
      });
      void this.saveToStorage();
      trace("auth:validated", { email: data.user?.emailAddress });
      return true;
    } catch (e: any) {
      if (e.name === "AbortError") return;
      // Network errors (fetch failed, timeout, etc.) do NOT mean the token is invalid.
      // Only a real 401 should expire the session. Silently fail so the user stays signed in.
      traceError("auth:validate_failed", e);
      return false;
    }
  }

  public getToken() {
    if (this.state.accessToken && Date.now() < this.state.expiresAt) {
      return this.state.accessToken;
    }
    return null;
  }

  public getState() {
    return this.state;
  }

  private updateState(partial: Partial<AuthState>) {
    this.state = { ...this.state, ...partial };
    if (partial.status && partial.status !== this.lastStatus) {
      this.lastStatus = partial.status;
      console.log(`[TaleVox][Auth] status -> ${partial.status}`);
    }
    this.notify();
  }
}

export const authManager = new AuthManager();
