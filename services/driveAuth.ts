/**
 * Talevox Google Drive Authentication Wrapper
 * Delegates to AuthManager for state and token handling.
 */

import { authManager } from './authManager';

export class AuthError extends Error {
  code: 'expired' | 'interactive_required';
  constructor(code: 'expired' | 'interactive_required', message: string) {
    super(message);
    this.code = code;
  }
}

export function isTokenValid() {
  return !!authManager.getToken();
}

export function getAuthSessionInfo() {
  const state = authManager.getState();
  return {
    authorized: state.status === 'signed_in',
    expiresAt: state.expiresAt,
    hasToken: !!state.accessToken
  };
}

export function initDriveAuth(clientId: string) {
  authManager.init(clientId);
}

export async function getValidDriveToken(opts?: { interactive?: boolean }): Promise<string> {
  return ensureValidToken(!!opts?.interactive);
}

export function clearStoredToken() {
  authManager.signOut();
}

export async function ensureValidToken(interactive: boolean): Promise<string> {
  const mode = interactive ? 'interactive' : 'silent';
  console.log(`[TaleVox][Auth] ensureValidToken (${mode})`);
  try {
    const token = await authManager.ensureValidToken(interactive);
    console.log(`[TaleVox][Auth] ensureValidToken (${mode}) success`);
    return token;
  } catch (e: any) {
    authManager.markExpired(e?.message || 'Reconnect required');
    console.log(`[TaleVox][Auth] ensureValidToken (${mode}) failed`);
    throw new AuthError(interactive ? 'interactive_required' : 'expired', e?.message || 'Reconnect required');
  }
}

/**
 * Wrapper for Drive API calls that handles Authorization and 401 retries.
 */
export async function driveFetch(input: RequestInfo, init: RequestInit = {}): Promise<Response> {
  const doFetch = async (t: string) => {
    const headers = new Headers(init.headers || {});
    headers.set("Authorization", `Bearer ${t}`);
    return fetch(input, { ...init, headers });
  };

  let token = await ensureValidToken(false);
  let res = await doFetch(token);

  if (res.status === 401) {
    console.log('[TaleVox][Auth] driveFetch 401, attempting silent refresh');
    token = await ensureValidToken(false);
    res = await doFetch(token);
    if (res.status === 401) {
      console.log('[TaleVox][Auth] driveFetch retry 401, marking expired');
      authManager.markExpired('Reconnect required');
      window.dispatchEvent(new CustomEvent('talevox_auth_invalid'));
      throw new AuthError('expired', 'Reconnect required');
    }
    console.log('[TaleVox][Auth] driveFetch retry success');
  }

  return res;
}
