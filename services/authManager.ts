import { trace, traceError } from '../utils/trace';
import { Capacitor } from '@capacitor/core';
import { SocialLogin } from '@capgo/capacitor-social-login';

export type AuthStatus = 'signed_out' | 'signing_in' | 'signed_in' | 'error';

export interface AuthState {
  status: AuthStatus;
  accessToken: string | null;
  userEmail?: string;
  lastError?: string;
  expiresAt: number;
}

type AuthListener = (state: AuthState) => void;

const SESSION_KEY = "talevox_drive_session_v3";

class AuthManager {
  private clientId: string | null = null;
  private initRetries = 0;
  private initRetryTimer: any = null;

  private state: AuthState = {
    status: 'signed_out',
    accessToken: null,
    expiresAt: 0
  };

  private listeners: Set<AuthListener> = new Set();
  private tokenClient: any = null;
  private validationAbortController: AbortController | null = null;

  constructor() {
    this.loadFromStorage();
  }

  private loadFromStorage() {
    try {
      const raw = sessionStorage.getItem(SESSION_KEY);
      if (raw) {
        const data = JSON.parse(raw);
        if (data.accessToken && data.expiresAt > Date.now()) {
          this.state = {
            ...this.state,
            accessToken: data.accessToken,
            expiresAt: data.expiresAt,
            status: 'signed_in',
            userEmail: data.userEmail
          };
          setTimeout(() => this.validateToken(), 1000);
        }
      }
    } catch (e) {
      traceError('auth:load_failed', e);
    }
  }

  private saveToStorage() {
    try {
      if (this.state.accessToken) {
        sessionStorage.setItem(SESSION_KEY, JSON.stringify({
          accessToken: this.state.accessToken,
          expiresAt: this.state.expiresAt,
          userEmail: this.state.userEmail
        }));
      } else {
        sessionStorage.removeItem(SESSION_KEY);
      }
    } catch (e) {
      traceError('auth:save_failed', e);
    }
  }

  public subscribe(listener: AuthListener) {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  private notify() {
    this.listeners.forEach(l => l(this.state));
  }

  public init(clientId: string) {
    this.clientId = clientId;

    if (Capacitor.isNativePlatform()) {
      trace('auth:init:native');
      return;
    }

    if (this.tokenClient) return;

    const tryInit = () => {
      if (!(window as any).google?.accounts?.oauth2) {
        this.initRetries += 1;
        if (this.initRetries <= 20) {
          this.initRetryTimer = setTimeout(tryInit, 500);
        } else {
          traceError('auth:init_failed_no_gis', new Error('Google Identity Services not available (window.google.accounts.oauth2 missing)'));
          this.updateState({ status: 'error', lastError: 'Google Sign-In script not loaded' });
        }
        return;
      }

      try {
        this.tokenClient = (window as any).google.accounts.oauth2.initTokenClient({
          client_id: clientId,
          scope: 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.metadata.readonly https://www.googleapis.com/auth/drive.readonly',
          callback: (resp: any) => this.handleTokenResponse(resp),
          error_callback: (err: any) => {
            traceError('auth:gis_error', err);
            this.updateState({ status: 'error', lastError: err.message || 'Auth initialization error' });
          }
        });
        trace('auth:initialized');
      } catch (e) {
        traceError('auth:init_exception', e);
        this.updateState({ status: 'error', lastError: 'Auth init failed' });
      }
    };

    tryInit();
  }

  private handleTokenResponse(resp: any) {
    if (resp.error) {
      traceError('auth:token_error', resp);
      this.updateState({ status: 'error', lastError: resp.error });
      return;
    }

    const expiresIn = Number(resp.expires_in) || 3600;
    this.updateState({
      accessToken: resp.access_token,
      expiresAt: Date.now() + (expiresIn * 1000),
      status: 'signed_in',
      lastError: undefined
    });
    this.saveToStorage();
    this.validateToken();
    trace('auth:token_received');
  }

  public signIn() {
    if (Capacitor.isNativePlatform()) {
      void this.nativeSignIn();
      return;
    }

    if (!this.tokenClient) {
      this.updateState({ status: 'error', lastError: 'Google Sign-In not initialized' });
      trace('auth:signin_fail_no_client', {}, 'error');
      if (this.clientId) this.init(this.clientId);
      return;
    }

    this.updateState({ status: 'signing_in', lastError: undefined });
    trace('auth:signin_start');

    setTimeout(() => {
      if (this.state.status === 'signing_in') {
        this.updateState({ status: 'error', lastError: 'Sign-in timed out. Popup may have been blocked.' });
      }
    }, 15000);

    this.tokenClient.requestAccessToken({ prompt: 'consent' });
  }

  private async nativeSignIn() {
    this.updateState({ status: 'signing_in', lastError: undefined });
    trace('auth:signin_start:native');

    const watchdog = setTimeout(() => {
      if (this.state.status === 'signing_in') {
        this.updateState({ status: 'error', lastError: 'Sign-in timed out.' });
      }
    }, 20000);

    try {
      const scopes = [
        'https://www.googleapis.com/auth/drive.file',
        'https://www.googleapis.com/auth/drive.metadata.readonly',
        'https://www.googleapis.com/auth/drive.readonly'
      ];

      const raw: any = await (SocialLogin as any).login({
        provider: 'google',
        options: { scopes }
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

      if (typeof tokenCandidate === 'string') {
        accessToken = tokenCandidate;
      } else if (tokenCandidate && typeof tokenCandidate === 'object') {
        accessToken =
          tokenCandidate.token ||
          tokenCandidate.accessToken ||
          tokenCandidate.access_token;
      }

      const expiresIn = Number(
        (tokenCandidate && typeof tokenCandidate === 'object' && (tokenCandidate.expiresIn || tokenCandidate.expires_in)) ??
        res?.expiresIn ??
        res?.expires_in ??
        3600
      );

      if (!accessToken) {
        traceError('auth:native_no_access_token', raw);
        this.updateState({ status: 'error', lastError: 'Google sign-in returned no access token' });
        return;
      }

      this.updateState({
        accessToken,
        expiresAt: Date.now() + (expiresIn * 1000),
        status: 'signed_in',
        lastError: undefined
      });

      this.saveToStorage();
      await this.validateToken();
      trace('auth:token_received:native');

    } catch (e: any) {
      traceError('auth:native_signin_failed', e);
      this.updateState({ status: 'error', lastError: e?.message || 'Native sign-in failed' });
    } finally {
      clearTimeout(watchdog);
    }
  }

  public signOut() {
    this.updateState({ status: 'signed_out', accessToken: null, expiresAt: 0, userEmail: undefined });
    this.saveToStorage();

    if (Capacitor.isNativePlatform()) {
      void (SocialLogin as any).logout?.({ provider: 'google' }).catch(() => {});
    }

    try { localStorage.removeItem('talevox_drive_token_v2'); } catch {}
    trace('auth:signed_out');
  }

  public async validateToken() {
    if (!this.state.accessToken) return;

    if (this.validationAbortController) this.validationAbortController.abort();
    this.validationAbortController = new AbortController();

    try {
      const res = await fetch('https://www.googleapis.com/drive/v3/about?fields=user', {
        headers: { Authorization: `Bearer ${this.state.accessToken}` },
        signal: this.validationAbortController.signal
      });

      if (!res.ok) {
        if (res.status === 401) {
          this.signOut();
          this.updateState({ lastError: 'Session expired' });
        } else {
          trace('auth:validate_http_error', { status: res.status });
        }
        return;
      }

      const data = await res.json();
      this.updateState({
        status: 'signed_in',
        userEmail: data.user?.emailAddress
      });
      this.saveToStorage();
      trace('auth:validated', { email: data.user?.emailAddress });

    } catch (e: any) {
      if (e.name === 'AbortError') return;
      traceError('auth:validate_failed', e);
    }
  }

  public getToken() {
    if (this.state.accessToken && Date.now() < this.state.expiresAt) {
      return this.state.accessToken;
    }
    return null;
  }

  public getState() { return this.state; }

  private updateState(partial: Partial<AuthState>) {
    this.state = { ...this.state, ...partial };
    this.notify();
  }
}

export const authManager = new AuthManager();
