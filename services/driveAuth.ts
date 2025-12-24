
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
  // Refresh if less than 5 mins left
  return !!accessToken && expiresAt > Date.now() + 300_000;
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
        reject(new Error(resp.error));
        return;
      }
      accessToken = resp.access_token;
      const ttlMs = (resp.expires_in ?? 3600) * 1000;
      expiresAt = Date.now() + ttlMs;
      saveToStorage();
      resolve(accessToken!);
    };
    // Use prompt: none for silent if possible, but Google often requires 'consent' or 'select_account'
    // if a session isn't explicitly active.
    tokenClient.requestAccessToken({ prompt: opts?.interactive ? "consent" : "" });
  });
}

/**
 * Wrapper for Drive API calls that handles Authorization and 401 retries.
 */
export async function driveFetch(input: RequestInfo, init: RequestInit = {}): Promise<Response> {
  // Pre-emptive refresh
  if (!isTokenValid()) {
    try { await getValidDriveToken({ interactive: false }); } catch(e) {}
  }

  const doFetch = async () => {
    const headers = new Headers(init.headers || {});
    if (accessToken) headers.set("Authorization", `Bearer ${accessToken}`);
    return fetch(input, { ...init, headers });
  };

  let res = await doFetch();

  if (res.status === 401) {
    clearStoredToken();
    try {
      await getValidDriveToken({ interactive: false });
      res = await doFetch();
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
