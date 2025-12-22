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
  } catch {}
}

export function clearStoredToken() {
  accessToken = null;
  expiresAt = 0;
  localStorage.removeItem(LS_KEY);
}

function isTokenValid() {
  // 60s safety buffer
  return !!accessToken && expiresAt > Date.now() + 60_000;
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
 * - interactive=false: silent refresh (prompt: '')
 * - interactive=true: forces UI (prompt: 'consent')
 */
export async function getValidDriveToken(opts?: { interactive?: boolean }): Promise<string> {
  if (!tokenClient) {
    // Attempt lazy init if we have a client ID in the environment
    const envId = (import.meta as any).env?.VITE_GOOGLE_CLIENT_ID;
    if (envId) initDriveAuth(envId);
    else throw new Error("Drive auth not initialized.");
  }

  if (isTokenValid() && !opts?.interactive) return accessToken!;

  return new Promise<string>((resolve, reject) => {
    tokenClient.callback = (resp: TokenResponse & { error?: string }) => {
      if (resp?.error) {
        clearStoredToken();
        reject(new Error(resp.error));
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
  const token = await getValidDriveToken({ interactive: false });

  const doFetch = async (t: string) => {
    const headers = new Headers(init.headers || {});
    headers.set("Authorization", `Bearer ${t}`);
    return fetch(input, { ...init, headers });
  };

  let res = await doFetch(token);

  if (res.status === 401) {
    clearStoredToken();
    try {
      const fresh = await getValidDriveToken({ interactive: false });
      res = await doFetch(fresh);
    } catch (e) {
      throw new Error("Reconnect Google Drive");
    }
  }

  if (res.status === 401) {
    clearStoredToken();
    throw new Error("Reconnect Google Drive");
  }

  return res;
}
