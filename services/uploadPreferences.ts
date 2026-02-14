export type UploadPreferences = {
  wifiOnly: boolean;
  requiresCharging: boolean;
  autoStart: boolean;
  retryBaseMs: number;
  retryMaxMs: number;
  maxRetries: number;
};

const PREFS_KEY = "talevox_upload_prefs_v1";

const DEFAULT_PREFS: UploadPreferences = {
  wifiOnly: false,
  requiresCharging: false,
  autoStart: true,
  retryBaseMs: 5_000,
  retryMaxMs: 120_000,
  maxRetries: 5,
};

let cached: UploadPreferences | null = null;
const listeners = new Set<(prefs: UploadPreferences) => void>();

function readPrefs(): UploadPreferences {
  if (cached) return cached;
  if (typeof window === "undefined") {
    cached = { ...DEFAULT_PREFS };
    return cached;
  }
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) {
      cached = { ...DEFAULT_PREFS };
      return cached;
    }
    const parsed = JSON.parse(raw) as Partial<UploadPreferences>;
    cached = {
      ...DEFAULT_PREFS,
      ...parsed,
      wifiOnly: !!parsed.wifiOnly,
      requiresCharging: !!parsed.requiresCharging,
      autoStart: parsed.autoStart !== false,
      retryBaseMs: Number.isFinite(Number(parsed.retryBaseMs)) ? Number(parsed.retryBaseMs) : DEFAULT_PREFS.retryBaseMs,
      retryMaxMs: Number.isFinite(Number(parsed.retryMaxMs)) ? Number(parsed.retryMaxMs) : DEFAULT_PREFS.retryMaxMs,
      maxRetries: Number.isFinite(Number(parsed.maxRetries)) ? Number(parsed.maxRetries) : DEFAULT_PREFS.maxRetries,
    };
    return cached;
  } catch {
    cached = { ...DEFAULT_PREFS };
    return cached;
  }
}

function writePrefs(next: UploadPreferences) {
  cached = next;
  if (typeof window !== "undefined") {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(next));
    } catch {
      // ignore
    }
  }
  for (const listener of listeners) listener(next);
}

export function getUploadPreferences(): UploadPreferences {
  return readPrefs();
}

export function updateUploadPreferences(patch: Partial<UploadPreferences>): UploadPreferences {
  const current = readPrefs();
  const next: UploadPreferences = {
    ...current,
    ...patch,
    wifiOnly: patch.wifiOnly ?? current.wifiOnly,
    requiresCharging: patch.requiresCharging ?? current.requiresCharging,
    autoStart: patch.autoStart ?? current.autoStart,
    retryBaseMs: Number.isFinite(Number(patch.retryBaseMs)) ? Number(patch.retryBaseMs) : current.retryBaseMs,
    retryMaxMs: Number.isFinite(Number(patch.retryMaxMs)) ? Number(patch.retryMaxMs) : current.retryMaxMs,
    maxRetries: Number.isFinite(Number(patch.maxRetries)) ? Number(patch.maxRetries) : current.maxRetries,
  };
  writePrefs(next);
  return next;
}

export function subscribeUploadPreferences(listener: (prefs: UploadPreferences) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
