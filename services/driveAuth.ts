
/**
 * Talevox Google Drive Authentication Manager
 * Implements self-healing OAuth2 flow with Google Identity Services.
 */

type TokenResponse = {
  access_token: string;
  expires_in?: number;
};

let tokenClient: any | null = null;
let accessToken: string | null = null;
let expiresAt = 0;

const LS_KEY = "talevox_drive_token_v2";

function loadFromStorage() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (parsed?.accessToken && typeof parsed.expiresAt === "number") {
      accessToken = parsed.accessToken;
      expiresAt = parsed.expiresAt;
    }
  } catch {}
}

function saveToStorage() {
  try {
    if (!accessToken) return;
    localStorage.setItem(LS_KEY, JSON.stringify({ accessToken, expiresAt }));
    window.dispatchEvent(new CustomEvent('talevox_auth_changed', { detail: { authorized: true } }));
  } catch {}
}

export function clearStoredToken() {
  accessToken = null;
  expiresAt = 0;
  localStorage.removeItem(LS_KEY);
  window.dispatchEvent(new CustomEvent('talevox_auth_changed', { detail: { authorized: false } }));
}

/**
 * Checks if we have a locally valid, non-expired token.
 */
export function isTokenValid() {
  // Buffer of 60 seconds to prevent race conditions during requests
  return !!accessToken && expiresAt > Date.now() + 60_000;
}

/**
 * Returns session info for UI display
 */
export function getAuthSessionInfo() {
  return {
    authorized: isTokenValid(),
    expiresAt,
    hasToken: !!accessToken
  };
}

export function initDriveAuth(clientId: string) {
  if (tokenClient) return;
  loadFromStorage();

  if (!(window as any).google?.accounts?.oauth2) {
    console.warn("Google Identity Services not loaded yet.");
    return;
  }

  tokenClient = (window as any).google.accounts.oauth2.initTokenClient({
    client_id: clientId,
    scope: 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.metadata.readonly https://www.googleapis.com/auth/drive.readonly',
    callback: '', // assigned per-request
  });
}

/**
 * Get a valid token.
 */
export async function getValidDriveToken(opts?: { interactive?: boolean }): Promise<string> {
  if (!tokenClient) {
    const envId = (import.meta as any).env?.VITE_GOOGLE_CLIENT_ID;
    if (envId) initDriveAuth(envId);
    else throw new Error("Drive auth not initialized.");
  }

  if (isTokenValid() && !opts?.interactive) return accessToken!;

  return new Promise<string>((resolve, reject) => {
    tokenClient.callback = (resp: TokenResponse & { error?: string }) => {
      if (resp?.error) {
        clearStoredToken();
        if (!opts?.interactive) {
           reject(new Error(resp.error));
        } else {
           reject(new Error("Login required"));
        }
        return;
      }
      accessToken = resp.access_token;
      const ttlMs = (resp.expires_in ?? 3600) * 1000;
      expiresAt = Date.now() + ttlMs;
      saveToStorage();
      resolve(accessToken!);
    };
    
    tokenClient.requestAccessToken({ prompt: opts?.interactive ? "consent" : "" });
  });
}

/**
 * Wrapper for Drive API calls that handles Authorization and 401 retries.
 */
export async function driveFetch(input: RequestInfo, init: RequestInit = {}): Promise<Response> {
  const doFetch = async () => {
    const headers = new Headers(init.headers || {});
    if (accessToken) headers.set("Authorization", `Bearer ${accessToken}`);
    return fetch(input, { ...init, headers });
  };

  if (!isTokenValid()) {
    try { await getValidDriveToken({ interactive: false }); } catch(e) {}
  }

  let res = await doFetch();

  // If unauthorized, token might have been revoked or expired early
  if (res.status === 401) {
    clearStoredToken();
    try {
      // Attempt one silent refresh
      await getValidDriveToken({ interactive: false });
      res = await doFetch();
    } catch (err) {
      window.dispatchEvent(new CustomEvent('talevox_auth_invalid'));
      throw new Error("Reconnect Google Drive");
    }
  }

  return res;
}
