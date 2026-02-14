import { PROGRESS_STORE_KEY, PROGRESS_STORE_LEGACY_KEYS } from './speechService';
import { safeSetLocalStorage } from '../utils/safeStorage';

export type ProgressStoreEntry = {
  timeSec?: number;
  durationSec?: number;
  percent?: number;
  completed?: boolean;
  updatedAt?: number;
};

export type ProgressStorePayload = {
  schemaVersion: number;
  books: Record<string, Record<string, ProgressStoreEntry>>;
};

const PROGRESS_STORE_SCHEMA_VERSION = 1;

export const normalizeProgressStore = (value: any): ProgressStorePayload | null => {
  if (!value || typeof value !== 'object') return null;
  if ('schemaVersion' in value) {
    const schemaVersion = Number((value as ProgressStorePayload).schemaVersion);
    const books = value.books && typeof value.books === 'object' ? value.books : {};
    return { schemaVersion: Number.isFinite(schemaVersion) ? schemaVersion : PROGRESS_STORE_SCHEMA_VERSION, books };
  }
  return { schemaVersion: PROGRESS_STORE_SCHEMA_VERSION, books: value as ProgressStorePayload['books'] };
};

export const readProgressStore = (): ProgressStorePayload => {
  if (typeof window === 'undefined') {
    return { schemaVersion: PROGRESS_STORE_SCHEMA_VERSION, books: {} };
  }
  const tryParse = (raw: string | null) => {
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      return normalizeProgressStore(parsed);
    } catch {
      return null;
    }
  };

  const stable = tryParse(localStorage.getItem(PROGRESS_STORE_KEY));
  if (stable) return stable;

  for (const legacyKey of PROGRESS_STORE_LEGACY_KEYS) {
    const legacy = tryParse(localStorage.getItem(legacyKey));
    if (legacy && Object.keys(legacy.books ?? {}).length > 0) {
      safeSetLocalStorage(PROGRESS_STORE_KEY, JSON.stringify({ ...legacy, schemaVersion: PROGRESS_STORE_SCHEMA_VERSION }));
      return legacy;
    }
  }

  const empty = { schemaVersion: PROGRESS_STORE_SCHEMA_VERSION, books: {} };
  safeSetLocalStorage(PROGRESS_STORE_KEY, JSON.stringify(empty));
  return empty;
};

export const writeProgressStore = (store: ProgressStorePayload) => {
  if (typeof window === 'undefined') return;
  safeSetLocalStorage(PROGRESS_STORE_KEY, JSON.stringify({ ...store, schemaVersion: PROGRESS_STORE_SCHEMA_VERSION }));
};

export async function commitProgressLocal(args: {
  bookId?: string | null;
  chapterId: string;
  timeSec: number;
  durationSec?: number;
  isComplete?: boolean;
  updatedAt?: number;
}): Promise<void> {
  if (typeof window === 'undefined') return;
  const { bookId, chapterId, timeSec, durationSec, isComplete, updatedAt } = args;
  try {
    const store = readProgressStore();
    const books = { ...store.books };
    const resolvedBookId =
      bookId ??
      Object.keys(books).find((id) => books[id] && books[id][chapterId]) ??
      "unknown";
    if (!books[resolvedBookId]) books[resolvedBookId] = {};
    const prev = books[resolvedBookId][chapterId] || {};
    books[resolvedBookId][chapterId] = {
      ...prev,
      timeSec,
      durationSec: durationSec ?? prev.durationSec,
      completed: isComplete ?? prev.completed,
      updatedAt: updatedAt ?? Date.now(),
    };
    writeProgressStore({ ...store, books });
  } catch {
    // ignore
  }
}

export async function loadProgressLocal(chapterId: string, bookId?: string | null): Promise<ProgressStoreEntry | null> {
  if (typeof window === 'undefined') return null;
  try {
    const store = readProgressStore();
    if (bookId && store.books[bookId] && store.books[bookId][chapterId]) {
      return store.books[bookId][chapterId] ?? null;
    }
    for (const id of Object.keys(store.books)) {
      const entry = store.books[id]?.[chapterId];
      if (entry) return entry;
    }
    return null;
  } catch {
    return null;
  }
}
