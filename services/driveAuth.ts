/**
 * Talevox Google Drive Authentication Wrapper
 * Delegates to AuthManager for state and token handling.
 */

import { authManager } from './authManager';

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
  const token = authManager.getToken();
  if (token) return token;

  if (opts?.interactive) {
    authManager.signIn();
    // Return a promise that resolves when signed in
    return new Promise((resolve, reject) => {
      const unsub = authManager.subscribe((state) => {
        if (state.status === 'signed_in' && state.accessToken) {
          unsub();
          resolve(state.accessToken);
        } else if (state.status === 'error') {
          unsub();
          reject(new Error(state.lastError || 'Sign-in failed'));
        }
      });
    });
  }

  throw new Error("No valid token");
}

export function clearStoredToken() {
  authManager.signOut();
}

/**
 * Wrapper for Drive API calls that handles Authorization and 401 retries.
 */
export async function driveFetch(input: RequestInfo, init: RequestInit = {}): Promise<Response> {
  let token = authManager.getToken();
  if (!token) {
     throw new Error("No valid token");
  }

  const doFetch = async (t: string) => {
    const headers = new Headers(init.headers || {});
    headers.set("Authorization", `Bearer ${t}`);
    return fetch(input, { ...init, headers });
  };

  let res = await doFetch(token);

  if (res.status === 401) {
    authManager.signOut();
    window.dispatchEvent(new CustomEvent('talevox_auth_invalid'));
    throw new Error("Reconnect Google Drive");
  }

  return res;
}