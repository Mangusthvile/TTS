import { Capacitor } from "@capacitor/core";
import { PROGRESS_STORE_KEY, PROGRESS_STORE_LEGACY_KEYS } from "./speechService";
import { safeSetLocalStorage } from "../utils/safeStorage";
import { idbGet, idbSet } from "./storageService";
import { dbExecute, dbExecuteSet, dbQuery, dbRun } from "./sqliteConnectionManager";
import { appConfig } from "../src/config/appConfig";

export type ProgressStoreEntry = {
  timeSec?: number;
  durationSec?: number;
  percent?: number;
  completed?: boolean;
  updatedAt?: number;
  /**
   * Optional explicit reset marker. When present in an incoming payload, merge
   * logic may allow regression instead of preserving the higher local value.
   */
  resetReason?: string;
};

export type ProgressStorePayload = {
  schemaVersion: number;
  books: Record<string, Record<string, ProgressStoreEntry>>;
};

const PROGRESS_STORE_SCHEMA_VERSION = 1;
const DURABLE_KV_KEY = "progress_store";
const CHAPTER_PROGRESS_MIGRATED_KEY = "progress_migrated_v2";
const PROGRESS_COMPARE_TIME_TOLERANCE_SEC = 2;
const PROGRESS_COMPARE_PERCENT_TOLERANCE = 0.01;

export const MAJOR_MISMATCH_TIME_DELTA_SEC = 30;
export const MAJOR_MISMATCH_NEAR_ZERO_SEC = 3;

export type ProgressMergeOptions = {
  /** Allow incoming entries to intentionally regress local progress. */
  allowIncomingRegression?: boolean;
};

export type ProgressMismatchReason = "completion_mismatch" | "time_delta" | "advanced_vs_missing";

export type ProgressMismatchSample = {
  bookId: string;
  chapterId: string;
  reason: ProgressMismatchReason;
  localTimeSec: number;
  durableTimeSec: number;
  localCompleted: boolean;
  durableCompleted: boolean;
  localUpdatedAt: number;
  durableUpdatedAt: number;
};

export type ProgressMismatchAnalysis = {
  isMajorMismatch: boolean;
  mismatchCount: number;
  reasons: ProgressMismatchReason[];
  samples: ProgressMismatchSample[];
};

export type StartupProgressConflict = {
  eventId: string;
  detectedAt: number;
  analysis: ProgressMismatchAnalysis;
  local: ProgressStorePayload;
  durable: ProgressStorePayload;
};

/** Key for the tiny session-delta (current chapter only). Safe to write synchronously on beforeunload. */
export const SESSION_DELTA_KEY = "talevox_session_delta";

/** Single-chapter progress saved during session; merged at hydration. Kept tiny to avoid quota on beforeunload. */
export type SessionDelta = {
  bookId: string;
  chapterId: string;
  entry: ProgressStoreEntry;
  savedAt?: number;
};

function parseSessionDelta(raw: string | null): SessionDelta | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const bookId =
      typeof (parsed as SessionDelta).bookId === "string" ? (parsed as SessionDelta).bookId : "";
    const chapterId =
      typeof (parsed as SessionDelta).chapterId === "string"
        ? (parsed as SessionDelta).chapterId
        : "";
    const entry = (parsed as SessionDelta).entry;
    if (!chapterId || !entry || typeof entry !== "object") return null;
    const e = entry as ProgressStoreEntry;
    return {
      bookId: bookId || "unknown",
      chapterId,
      entry: {
        timeSec: e.timeSec,
        durationSec: e.durationSec,
        percent: e.percent,
        completed: e.completed,
        updatedAt: typeof e.updatedAt === "number" ? e.updatedAt : Date.now(),
      },
      savedAt:
        typeof (parsed as SessionDelta).savedAt === "number"
          ? (parsed as SessionDelta).savedAt
          : undefined,
    };
  } catch {
    return null;
  }
}

/** Merge a session delta into a store (mutates store.books). */
function mergeSessionDeltaIntoStore(store: ProgressStorePayload, delta: SessionDelta): void {
  const { bookId, chapterId, entry } = delta;
  if (!store.books[bookId]) store.books[bookId] = {};
  const existing = store.books[bookId][chapterId];
  const best = bestChapterProgress(existing, entry);
  if (best) store.books[bookId][chapterId] = best;
}

/** In-memory cache for web so we can read sync and persist async to IndexedDB (avoids localStorage quota). */
let progressStoreCache: ProgressStorePayload | null = null;
let startupProgressConflict: StartupProgressConflict | null = null;

/**
 * Phase 2: Hydration guard. No native progress write may run until durable storage
 * has been loaded at least once. Set by bootstrap after hydrateProgressFromDurable +
 * hydrateProgressFromIndexedDB (each is a no-op on the other platform).
 * Prevents "mass reset" on reload: without this, React state would initialize to 0
 * and a write could overwrite SQLite with zeros for every chapter before load completes.
 */
let progressStoreHydrated = false;

export function isProgressStoreHydrated(): boolean {
  return progressStoreHydrated;
}

/** Called only from useAppBootstrap after hydration completes. */
export function setProgressStoreHydrated(): void {
  progressStoreHydrated = true;
}

/** Reset cache and hydration flag (for tests only). */
export function __clearProgressStoreCacheForTests(): void {
  progressStoreCache = null;
  startupProgressConflict = null;
  progressStoreHydrated = false;
  chapterProgressTableEnsured = false;
}

/** Max chapter progress entries per book in localStorage.
 * 10000 × ~150 bytes ≈ 1.5 MB per book — well within the 5 MB Android WebView limit.
 * SQLite (chapter_progress table) holds ALL entries without limit.
 * This cap only applies to the localStorage write-back path (writeProgressStore / syncDurableToLocalStorage).
 */
const MAX_CHAPTER_PROGRESS_ENTRIES_PER_BOOK = 10000;

function isNative(): boolean {
  return (
    typeof window !== "undefined" && !!(window as any).Capacitor && Capacitor.isNativePlatform?.()
  );
}

function toBoolInt(v: boolean): number {
  return v ? 1 : 0;
}

function fromBoolInt(v: any): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return v.toLowerCase() === "true" || v === "1";
  return false;
}

let chapterProgressTableEnsured = false;

/** Ensure chapter_progress table exists. Single source of truth for progress on native.
 * Uses transaction: false to avoid Android SQLiteConnection leak. Idempotent; runs once per session. */
async function ensureChapterProgressTable(): Promise<void> {
  if (!isNative()) return;
  if (chapterProgressTableEnsured) return;
  const name = appConfig.db.name;
  const version = appConfig.db.version;
  const noTxn = { transaction: false as const };
  await dbExecute(
    name,
    version,
    `CREATE TABLE IF NOT EXISTS chapter_progress (
      bookId TEXT NOT NULL,
      chapterId TEXT NOT NULL,
      timeSec REAL NOT NULL,
      durationSec REAL,
      percent REAL,
      isComplete INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL,
      PRIMARY KEY (bookId, chapterId)
    )`,
    noTxn
  );
  await dbExecute(
    name,
    version,
    `CREATE INDEX IF NOT EXISTS idx_chapter_progress_chapterId ON chapter_progress(chapterId)`,
    noTxn
  );
  chapterProgressTableEnsured = true;
}

/** Ensure kv table exists for legacy migration. Uses transaction: false to avoid Android leak. */
async function ensureProgressKvTable(): Promise<void> {
  if (!isNative()) return;
  const name = appConfig.db.name;
  const version = appConfig.db.version;
  await dbExecute(
    name,
    version,
    `CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY,
      json TEXT NOT NULL,
      updatedAt INTEGER NOT NULL
    )`,
    { transaction: false }
  );
}

/** One-time migration: kv progress_store and old progress table -> chapter_progress. */
async function migrateToChapterProgress(): Promise<void> {
  if (typeof window === "undefined") return;
  if (localStorage.getItem(CHAPTER_PROGRESS_MIGRATED_KEY)) return;
  if (!isNative()) {
    localStorage.setItem(CHAPTER_PROGRESS_MIGRATED_KEY, "1");
    return;
  }
  try {
    await ensureChapterProgressTable();
    await ensureProgressKvTable();
    const name = appConfig.db.name;
    const version = appConfig.db.version;

    // Migrate from kv progress_store
    const kvRes = await dbQuery(name, version, "SELECT json FROM kv WHERE key = ?", [
      DURABLE_KV_KEY,
    ]);
    const kvRow = kvRes?.values?.[0];
    if (kvRow && kvRow.json) {
      const parsed = JSON.parse(String(kvRow.json));
      const books = parsed?.books && typeof parsed.books === "object" ? parsed.books : {};
      for (const bookId of Object.keys(books)) {
        const chapters = books[bookId];
        if (!chapters || typeof chapters !== "object") continue;
        for (const chapterId of Object.keys(chapters)) {
          const e = chapters[chapterId];
          if (!e || typeof e !== "object") continue;
          const timeSec = Number(e.timeSec ?? 0);
          const durationSec = e.durationSec != null ? Number(e.durationSec) : null;
          const percent = e.percent != null ? Number(e.percent) : null;
          const completed = e.completed === true || e.completed === 1;
          const updatedAt = Number(e.updatedAt ?? Date.now());
          await dbRun(
            name,
            version,
            `INSERT OR REPLACE INTO chapter_progress (bookId, chapterId, timeSec, durationSec, percent, isComplete, updatedAt)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
              bookId,
              chapterId,
              timeSec,
              durationSec,
              percent ?? (durationSec && durationSec > 0 ? Math.min(1, timeSec / durationSec) : 0),
              toBoolInt(completed),
              updatedAt,
            ],
            { transaction: false }
          );
        }
      }
    }

    // Migrate from old progress table (chapterId only -> bookId '')
    try {
      const progRes = await dbQuery(
        name,
        version,
        "SELECT chapterId, timeSec, durationSec, percent, isComplete, updatedAt FROM progress",
        []
      );
      const rows = (progRes?.values ?? []) as any[];
      for (const r of rows) {
        const chapterId = String(r?.chapterId ?? "");
        if (!chapterId) continue;
        const timeSec = Number(r?.timeSec ?? 0);
        const durationSec = r?.durationSec != null ? Number(r.durationSec) : null;
        const percent = r?.percent != null ? Number(r.percent) : null;
        const isComplete = fromBoolInt(r?.isComplete);
        const updatedAt = Number(r?.updatedAt ?? Date.now());
        await dbRun(
          name,
          version,
          `INSERT OR REPLACE INTO chapter_progress (bookId, chapterId, timeSec, durationSec, percent, isComplete, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            "",
            chapterId,
            timeSec,
            durationSec,
            percent ?? (durationSec && durationSec > 0 ? Math.min(1, timeSec / durationSec) : 0),
            toBoolInt(isComplete),
            updatedAt,
          ],
          { transaction: false }
        );
      }
    } catch {
      // progress table may not exist
    }

    localStorage.setItem(CHAPTER_PROGRESS_MIGRATED_KEY, "1");
  } catch {
    // migration best-effort
  }
}

/** Read all progress from chapter_progress table into books structure. */
async function readChapterProgressDurable(): Promise<ProgressStorePayload | null> {
  if (!isNative()) return null;
  try {
    await ensureChapterProgressTable();
    const name = appConfig.db.name;
    const version = appConfig.db.version;
    const res = await dbQuery(
      name,
      version,
      "SELECT bookId, chapterId, timeSec, durationSec, percent, isComplete, updatedAt FROM chapter_progress",
      []
    );
    const rows = (res?.values ?? []) as any[];
    const books: Record<string, Record<string, ProgressStoreEntry>> = {};
    for (const r of rows) {
      const bookId = String(r?.bookId ?? "") || "unknown";
      const chapterId = String(r?.chapterId ?? "");
      if (!chapterId) continue;
      if (!books[bookId]) books[bookId] = {};
      books[bookId][chapterId] = {
        timeSec: Number(r?.timeSec ?? 0),
        durationSec: r?.durationSec != null ? Number(r.durationSec) : undefined,
        percent: r?.percent != null ? Number(r.percent) : undefined,
        completed: fromBoolInt(r?.isComplete),
        updatedAt: Number(r?.updatedAt ?? 0),
      };
    }
    return { schemaVersion: PROGRESS_STORE_SCHEMA_VERSION, books };
  } catch {
    return null;
  }
}

/** Phase 3: Threshold (seconds) above which stored position is treated as real; incoming 0/low = glitch unless forceReset. */
export const IMPLAUSIBLE_RESET_THRESHOLD_SEC = 10;

/**
 * Phase 3: Pure monotonicity rules (unit-testable). Returns true if the write should be skipped.
 */
export function shouldSkipProgressWrite(
  existingTimeSec: number,
  existingComplete: boolean,
  incomingTimeSec: number,
  incomingComplete: boolean,
  forceReset: boolean
): boolean {
  if (forceReset) return false;
  if (existingComplete && !incomingComplete) return true;
  if (
    incomingTimeSec <= IMPLAUSIBLE_RESET_THRESHOLD_SEC &&
    existingTimeSec > IMPLAUSIBLE_RESET_THRESHOLD_SEC
  ) {
    return true;
  }
  return false;
}

/**
 * Phase 3: Single place for completion lock + implausible-reset guard.
 * Returns true if the write was performed, false if skipped by guard.
 */
async function persistChapterProgressRow(
  name: string,
  version: number,
  bookId: string,
  chapterId: string,
  timeSec: number,
  durationSec: number | null,
  percent: number,
  completed: boolean,
  updatedAt: number,
  options?: { forceReset?: boolean }
): Promise<boolean> {
  try {
    const res = await dbQuery(
      name,
      version,
      "SELECT timeSec, isComplete FROM chapter_progress WHERE bookId = ? AND chapterId = ?",
      [bookId || "unknown", chapterId]
    );
    const row = res?.values?.[0] as { timeSec?: number; isComplete?: number } | undefined;
    const existingTimeSec = typeof row?.timeSec === "number" ? row.timeSec : 0;
    const existingComplete = fromBoolInt(row?.isComplete);

    if (
      shouldSkipProgressWrite(
        existingTimeSec,
        existingComplete,
        timeSec,
        completed,
        options?.forceReset === true
      )
    ) {
      return false;
    }

    await dbRun(
      name,
      version,
      `INSERT OR REPLACE INTO chapter_progress (bookId, chapterId, timeSec, durationSec, percent, isComplete, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        bookId || "unknown",
        chapterId,
        timeSec,
        durationSec,
        percent,
        toBoolInt(completed),
        updatedAt,
      ],
      { transaction: false }
    );
    return true;
  } catch {
    return false;
  }
}

/** Build existing map from a durable payload (so we don't need extra SELECTs). */
function existingMapFromDurable(
  durable: ProgressStorePayload | null
): Map<string, { timeSec: number; isComplete: boolean }> {
  const map = new Map<string, { timeSec: number; isComplete: boolean }>();
  if (!durable?.books) return map;
  for (const [bookId, chapters] of Object.entries(durable.books)) {
    if (!chapters || typeof chapters !== "object") continue;
    const bid = bookId || "unknown";
    for (const [chapterId, e] of Object.entries(chapters)) {
      if (!e || typeof e !== "object") continue;
      map.set(`${bid}|${chapterId}`, {
        timeSec: Number((e as ProgressStoreEntry).timeSec ?? 0),
        isComplete: (e as ProgressStoreEntry).completed === true,
      });
    }
  }
  return map;
}

/** Write progress from books structure to chapter_progress table. Uses UPSERT only (no DELETE).
 * When existingFromDurable is provided, no SELECTs are run (1 executeSet only). Otherwise one full SELECT + 1 executeSet.
 * Never writes rows with timeSec=0 and completed=false, so we never overwrite real progress with zeros. */
async function writeChapterProgressDurable(
  store: ProgressStorePayload,
  existingFromDurable?: Map<string, { timeSec: number; isComplete: boolean }>
): Promise<void> {
  if (!isNative()) return;
  try {
    await ensureChapterProgressTable();
    const name = appConfig.db.name;
    const version = appConfig.db.version;
    const books = store.books ?? {};
    type Entry = {
      bookId: string;
      chapterId: string;
      timeSec: number;
      durationSec: number | null;
      percent: number;
      completed: boolean;
      updatedAt: number;
    };
    const entries: Entry[] = [];
    for (const bookId of Object.keys(books)) {
      const chapters = books[bookId];
      if (!chapters || typeof chapters !== "object") continue;
      const bid = bookId || "unknown";
      for (const chapterId of Object.keys(chapters)) {
        const e = chapters[chapterId];
        if (!e || typeof e !== "object") continue;
        const timeSec = Number(e.timeSec ?? 0);
        const durationSec = e.durationSec != null ? Number(e.durationSec) : null;
        const percent =
          e.percent != null
            ? Number(e.percent)
            : durationSec && durationSec > 0
              ? Math.min(1, timeSec / durationSec)
              : 0;
        const completed = e.completed === true;
        const updatedAt = Number(e.updatedAt ?? Date.now());
        entries.push({
          bookId: bid,
          chapterId,
          timeSec,
          durationSec,
          percent,
          completed,
          updatedAt,
        });
      }
    }
    if (entries.length === 0) return;

    let existingByKey: Map<string, { timeSec: number; isComplete: boolean }>;
    if (existingFromDurable != null) {
      existingByKey = existingFromDurable;
    } else {
      existingByKey = new Map<string, { timeSec: number; isComplete: boolean }>();
      const res = await dbQuery(
        name,
        version,
        "SELECT bookId, chapterId, timeSec, isComplete FROM chapter_progress",
        []
      );
      const rows = (res?.values ?? []) as Array<{
        bookId?: string;
        chapterId?: string;
        timeSec?: number;
        isComplete?: number;
      }>;
      for (const row of rows) {
        const bid = row.bookId != null ? String(row.bookId) : "unknown";
        const cid = row.chapterId;
        if (cid == null) continue;
        existingByKey.set(`${bid}|${cid}`, {
          timeSec: typeof row.timeSec === "number" ? row.timeSec : 0,
          isComplete: fromBoolInt(row.isComplete),
        });
      }
    }

    const set: Array<{ statement: string; values: any[] }> = [];
    const insertSql = `INSERT OR REPLACE INTO chapter_progress (bookId, chapterId, timeSec, durationSec, percent, isComplete, updatedAt)
 VALUES (?, ?, ?, ?, ?, ?, ?)`;
    for (const entry of entries) {
      if (entry.timeSec === 0 && !entry.completed) continue;
      const key = `${entry.bookId}|${entry.chapterId}`;
      const existing = existingByKey.get(key);
      const existingTimeSec = existing?.timeSec ?? 0;
      const existingComplete = existing?.isComplete ?? false;
      if (
        shouldSkipProgressWrite(
          existingTimeSec,
          existingComplete,
          entry.timeSec,
          entry.completed,
          false
        )
      )
        continue;
      set.push({
        statement: insertSql,
        values: [
          entry.bookId,
          entry.chapterId,
          entry.timeSec,
          entry.durationSec,
          entry.percent,
          toBoolInt(entry.completed),
          entry.updatedAt,
        ],
      });
    }
    if (set.length > 0) await dbExecuteSet(name, version, set, { transaction: false });
  } catch {
    // best-effort
  }
}

/**
 * Replace durable chapter progress with the provided payload.
 * Used only for explicit startup conflict source selection.
 */
async function replaceChapterProgressDurable(store: ProgressStorePayload): Promise<void> {
  if (!isNative()) return;
  try {
    await ensureChapterProgressTable();
    const name = appConfig.db.name;
    const version = appConfig.db.version;
    await dbExecute(name, version, "DELETE FROM chapter_progress", { transaction: false });

    const set: Array<{ statement: string; values: any[] }> = [];
    const insertSql = `INSERT OR REPLACE INTO chapter_progress (bookId, chapterId, timeSec, durationSec, percent, isComplete, updatedAt)
 VALUES (?, ?, ?, ?, ?, ?, ?)`;

    for (const [bookId, chapters] of Object.entries(store.books ?? {})) {
      if (!chapters || typeof chapters !== "object") continue;
      const resolvedBookId = bookId || "unknown";
      for (const [chapterId, entry] of Object.entries(chapters)) {
        if (!entry || typeof entry !== "object") continue;
        const timeSec = Math.max(0, Number(entry.timeSec ?? 0));
        const durationSec = entry.durationSec != null ? Number(entry.durationSec) : null;
        const percent =
          entry.percent != null
            ? Number(entry.percent)
            : durationSec && durationSec > 0
              ? Math.min(1, timeSec / durationSec)
              : 0;
        const completed = entry.completed === true;
        const updatedAt = Number(entry.updatedAt ?? Date.now());
        set.push({
          statement: insertSql,
          values: [
            resolvedBookId,
            chapterId,
            timeSec,
            durationSec,
            percent,
            toBoolInt(completed),
            updatedAt,
          ],
        });
      }
    }

    if (set.length > 0) {
      await dbExecuteSet(name, version, set, { transaction: false });
    }
  } catch {
    // best-effort
  }
}

/**
 * Non-regressive chapter progress comparison.
 * Returns > 0 when current is ahead, < 0 when incoming is ahead, and 0 when equivalent.
 */
export function compareChapterProgressNonRegressive(
  current: ProgressStoreEntry | undefined | null,
  incoming: ProgressStoreEntry | undefined | null
): number {
  const getMetrics = (entry: ProgressStoreEntry | undefined | null) => {
    if (!entry) {
      return { timeSec: 0, percent: 0, updatedAt: 0, completed: false };
    }
    const timeSec = Math.max(0, Number.isFinite(Number(entry.timeSec)) ? Number(entry.timeSec) : 0);
    const updatedAt = Math.max(
      0,
      Number.isFinite(Number(entry.updatedAt)) ? Number(entry.updatedAt) : 0
    );
    const completed = entry.completed === true;
    const derivedPercent =
      typeof entry.durationSec === "number" && entry.durationSec > 0
        ? Math.max(0, Math.min(1, timeSec / entry.durationSec))
        : 0;
    const percent = Math.max(
      0,
      Math.min(1, typeof entry.percent === "number" ? entry.percent : derivedPercent)
    );
    return { timeSec, percent, updatedAt, completed };
  };

  const a = getMetrics(current);
  const b = getMetrics(incoming);

  if (a.completed !== b.completed) return a.completed ? 1 : -1;

  const timeDelta = a.timeSec - b.timeSec;
  if (Math.abs(timeDelta) > PROGRESS_COMPARE_TIME_TOLERANCE_SEC) {
    return timeDelta > 0 ? 1 : -1;
  }

  const percentDelta = a.percent - b.percent;
  if (Math.abs(percentDelta) > PROGRESS_COMPARE_PERCENT_TOLERANCE) {
    return percentDelta > 0 ? 1 : -1;
  }

  return 0;
}

/**
 * Canonical merge rule for two chapter progress entries.
 * Default behavior is non-regressive: more advanced progress wins even if older.
 */
export function bestChapterProgress(
  current: ProgressStoreEntry | undefined | null,
  incoming: ProgressStoreEntry | undefined | null,
  options?: ProgressMergeOptions
): ProgressStoreEntry | undefined | null {
  if (current == null) return incoming;
  if (incoming == null) return current;

  const incomingExplicitReset =
    options?.allowIncomingRegression === true ||
    (typeof incoming.resetReason === "string" && incoming.resetReason.toLowerCase() === "explicit");

  const currentTs = Number.isFinite(Number(current.updatedAt)) ? Number(current.updatedAt) : 0;
  const incomingTs = Number.isFinite(Number(incoming.updatedAt)) ? Number(incoming.updatedAt) : 0;

  if (incomingExplicitReset) {
    if (incomingTs !== currentTs) {
      return incomingTs >= currentTs ? incoming : current;
    }
    const cmpReset = compareChapterProgressNonRegressive(current, incoming);
    return cmpReset <= 0 ? incoming : current;
  }

  const cmp = compareChapterProgressNonRegressive(current, incoming);
  if (cmp > 0) return current;
  if (cmp < 0) return incoming;

  if (incomingTs !== currentTs) {
    return incomingTs >= currentTs ? incoming : current;
  }

  return incoming;
}

/**
 * Merge two progress stores using bestChapterProgress per chapter.
 */
export function mergeStores(
  local: ProgressStorePayload,
  incoming: ProgressStorePayload,
  options?: ProgressMergeOptions
): ProgressStorePayload {
  try {
    const books: Record<string, Record<string, ProgressStoreEntry>> = { ...local.books };
    const incBooks = incoming.books ?? {};
    for (const bookId of Object.keys(incBooks)) {
      const incChapters = incBooks[bookId];
      if (!incChapters || typeof incChapters !== "object") continue;
      if (!books[bookId]) books[bookId] = {};
      for (const chapterId of Object.keys(incChapters)) {
        const incEntry = incChapters[chapterId];
        if (!incEntry || typeof incEntry !== "object") continue;
        const localEntry = books[bookId][chapterId];
        const best = bestChapterProgress(localEntry, incEntry, options);
        if (best) books[bookId][chapterId] = best;
      }
    }
    return { schemaVersion: PROGRESS_STORE_SCHEMA_VERSION, books };
  } catch (e) {
    console.error("[progressStore] mergeStores failed:", e);
    return local;
  }
}

type ChapterProgressRecord = {
  bookId: string;
  chapterId: string;
  entry: ProgressStoreEntry;
};

function collectProgressRecords(store: ProgressStorePayload): Map<string, ChapterProgressRecord> {
  const map = new Map<string, ChapterProgressRecord>();
  for (const [bookId, chapters] of Object.entries(store.books ?? {})) {
    if (!chapters || typeof chapters !== "object") continue;
    for (const [chapterId, entry] of Object.entries(chapters)) {
      if (!entry || typeof entry !== "object") continue;
      const resolvedBookId = bookId || "unknown";
      map.set(`${resolvedBookId}|${chapterId}`, {
        bookId: resolvedBookId,
        chapterId,
        entry,
      });
    }
  }
  return map;
}

function buildProgressConflictEventId(
  analysis: ProgressMismatchAnalysis,
  local: ProgressStorePayload,
  durable: ProgressStorePayload
): string {
  const getMaxUpdatedAt = (store: ProgressStorePayload) => {
    let maxTs = 0;
    for (const chapters of Object.values(store.books ?? {})) {
      if (!chapters || typeof chapters !== "object") continue;
      for (const entry of Object.values(chapters)) {
        const ts = Number.isFinite(Number((entry as ProgressStoreEntry).updatedAt))
          ? Number((entry as ProgressStoreEntry).updatedAt)
          : 0;
        if (ts > maxTs) maxTs = ts;
      }
    }
    return maxTs;
  };

  return [
    analysis.mismatchCount,
    analysis.reasons.slice().sort().join(","),
    getMaxUpdatedAt(local),
    getMaxUpdatedAt(durable),
  ].join(":");
}

/**
 * Detect whether local and durable stores diverged enough to require an explicit source choice.
 */
export function analyzeProgressMismatch(
  local: ProgressStorePayload,
  durable: ProgressStorePayload,
  options?: {
    majorDeltaSec?: number;
    nearZeroSec?: number;
    maxSamples?: number;
  }
): ProgressMismatchAnalysis {
  const majorDeltaSec = Math.max(
    1,
    Number(options?.majorDeltaSec ?? MAJOR_MISMATCH_TIME_DELTA_SEC)
  );
  const nearZeroSec = Math.max(0, Number(options?.nearZeroSec ?? MAJOR_MISMATCH_NEAR_ZERO_SEC));
  const maxSamples = Math.max(1, Number(options?.maxSamples ?? 8));

  const localMap = collectProgressRecords(local);
  const durableMap = collectProgressRecords(durable);
  const keys = new Set<string>([...localMap.keys(), ...durableMap.keys()]);
  const samples: ProgressMismatchSample[] = [];
  const reasonSet = new Set<ProgressMismatchReason>();
  let mismatchCount = 0;

  for (const key of keys) {
    const localRec = localMap.get(key);
    const durableRec = durableMap.get(key);
    const localEntry = localRec?.entry ?? null;
    const durableEntry = durableRec?.entry ?? null;

    const localTime = Math.max(
      0,
      Number.isFinite(Number(localEntry?.timeSec)) ? Number(localEntry?.timeSec) : 0
    );
    const durableTime = Math.max(
      0,
      Number.isFinite(Number(durableEntry?.timeSec)) ? Number(durableEntry?.timeSec) : 0
    );
    const localCompleted = localEntry?.completed === true;
    const durableCompleted = durableEntry?.completed === true;
    const localUpdatedAt = Number.isFinite(Number(localEntry?.updatedAt))
      ? Number(localEntry?.updatedAt)
      : 0;
    const durableUpdatedAt = Number.isFinite(Number(durableEntry?.updatedAt))
      ? Number(durableEntry?.updatedAt)
      : 0;
    const bookId = localRec?.bookId ?? durableRec?.bookId ?? "unknown";
    const chapterId = localRec?.chapterId ?? durableRec?.chapterId ?? "";

    let reason: ProgressMismatchReason | null = null;

    if (localEntry && durableEntry) {
      if (localCompleted !== durableCompleted) {
        reason = "completion_mismatch";
      } else if (Math.abs(localTime - durableTime) >= majorDeltaSec) {
        reason = "time_delta";
      } else {
        const localAhead = compareChapterProgressNonRegressive(localEntry, durableEntry);
        const durableAhead = compareChapterProgressNonRegressive(durableEntry, localEntry);
        const localNearZero = localTime <= nearZeroSec;
        const durableNearZero = durableTime <= nearZeroSec;
        const localMaterial = localCompleted || localTime >= majorDeltaSec;
        const durableMaterial = durableCompleted || durableTime >= majorDeltaSec;
        if (
          (localAhead > 0 && localMaterial && durableNearZero) ||
          (durableAhead > 0 && durableMaterial && localNearZero)
        ) {
          reason = "advanced_vs_missing";
        }
      }
    } else {
      const presentTime = localEntry ? localTime : durableTime;
      const presentCompleted = localEntry ? localCompleted : durableCompleted;
      if (presentCompleted || presentTime >= majorDeltaSec) {
        reason = "advanced_vs_missing";
      }
    }

    if (!reason || !chapterId) continue;
    mismatchCount += 1;
    reasonSet.add(reason);
    if (samples.length < maxSamples) {
      samples.push({
        bookId,
        chapterId,
        reason,
        localTimeSec: localTime,
        durableTimeSec: durableTime,
        localCompleted,
        durableCompleted,
        localUpdatedAt,
        durableUpdatedAt,
      });
    }
  }

  return {
    isMajorMismatch: reasonSet.size > 0,
    mismatchCount,
    reasons: Array.from(reasonSet),
    samples,
  };
}

export function getPendingStartupProgressConflict(): StartupProgressConflict | null {
  return startupProgressConflict;
}

export function clearPendingStartupProgressConflict(): void {
  startupProgressConflict = null;
}

export function resolveStartupConflictChoice(
  choice: "durable" | "local" | null | undefined
): "durable" | "local" {
  return choice === "local" ? "local" : "durable";
}

/**
 * Apply external progress (e.g. from snapshot restore) into progressStore.
 * Merges with local using bestChapterProgress, writes to both SQLite and localStorage.
 */
export function applyExternalProgress(
  incoming: Record<string, unknown> | ProgressStorePayload | null
): void {
  if (typeof window === "undefined") return;
  if (!incoming || typeof incoming !== "object") return;
  try {
    const normalized = normalizeProgressStore(incoming);
    if (!normalized) return;
    const local = readProgressStore();
    const merged = mergeStores(local, normalized);
    writeProgressStore(merged);
  } catch (e) {
    console.error("[progressStore] applyExternalProgress failed:", e);
  }
}

export const normalizeProgressStore = (value: any): ProgressStorePayload | null => {
  if (!value || typeof value !== "object") return null;
  const books =
    value.books && typeof value.books === "object"
      ? value.books
      : typeof value === "object" && !Array.isArray(value)
        ? value
        : {};
  const schemaVersion =
    "schemaVersion" in value &&
    Number.isFinite(Number((value as ProgressStorePayload).schemaVersion))
      ? Number((value as ProgressStorePayload).schemaVersion)
      : PROGRESS_STORE_SCHEMA_VERSION;
  return { schemaVersion, books };
};

function syncDurableToLocalStorage(store: ProgressStorePayload): void {
  if (typeof window === "undefined") return;
  const trimmed = trimProgressStorePayload(store);
  const payload = JSON.stringify({ ...trimmed, schemaVersion: PROGRESS_STORE_SCHEMA_VERSION });
  safeSetLocalStorage(PROGRESS_STORE_KEY, payload);
}

/** Persist progress to IndexedDB (web only). Avoids localStorage 5MB quota. */
function persistProgressToIndexedDB(store: ProgressStorePayload): void {
  if (typeof window === "undefined" || isNative()) return;
  const payload = JSON.stringify({ ...store, schemaVersion: PROGRESS_STORE_SCHEMA_VERSION });
  void idbSet(PROGRESS_STORE_KEY, payload).catch((e) => {
    console.warn("[progressStore] IndexedDB write failed:", e);
  });
}

/**
 * Hydrate in-memory cache from IndexedDB (web only). Call once at bootstrap before progress-dependent code.
 * If IDB is empty, migrates from localStorage and writes to IDB.
 * Session delta: if talevox_session_delta exists, merge it into the store, persist to IDB, then delete the key.
 */
export async function hydrateProgressFromIndexedDB(): Promise<void> {
  if (typeof window === "undefined" || isNative()) return;
  let store: ProgressStorePayload;
  let loadedFromIdb = false;
  try {
    const raw = await idbGet<string>(PROGRESS_STORE_KEY);
    if (raw != null && typeof raw === "string") {
      const parsed = normalizeProgressStore(JSON.parse(raw) as ProgressStorePayload);
      if (parsed) {
        store = parsed;
        loadedFromIdb = true;
      } else {
        store = readProgressStoreFromLocalStorage();
      }
    } else {
      store = readProgressStoreFromLocalStorage();
    }
  } catch (e) {
    console.warn("[progressStore] hydrateProgressFromIndexedDB read failed:", e);
    store = readProgressStoreFromLocalStorage();
  }
  const deltaRaw = localStorage.getItem(SESSION_DELTA_KEY);
  if (deltaRaw) {
    const delta = parseSessionDelta(deltaRaw);
    if (delta) {
      mergeSessionDeltaIntoStore(store, delta);
      persistProgressToIndexedDB(store);
      try {
        localStorage.removeItem(SESSION_DELTA_KEY);
      } catch {}
    }
  } else if (!loadedFromIdb) {
    persistProgressToIndexedDB(store);
  }
  progressStoreCache = store;
}

/** Read from localStorage only (used for migration and when cache not yet hydrated). */
function readProgressStoreFromLocalStorage(): ProgressStorePayload {
  const tryParse = (raw: string | null) => {
    if (!raw) return null;
    try {
      return normalizeProgressStore(JSON.parse(raw) as ProgressStorePayload);
    } catch {
      return null;
    }
  };
  const stable = tryParse(localStorage.getItem(PROGRESS_STORE_KEY));
  if (stable) return stable;
  for (const legacyKey of PROGRESS_STORE_LEGACY_KEYS) {
    const legacy = tryParse(localStorage.getItem(legacyKey));
    if (legacy && Object.keys(legacy.books ?? {}).length > 0) {
      return { ...legacy, schemaVersion: PROGRESS_STORE_SCHEMA_VERSION };
    }
  }
  return { schemaVersion: PROGRESS_STORE_SCHEMA_VERSION, books: {} };
}

/**
 * Returns the latest updatedAt across all chapter entries (for Drive vs local timestamp comparison).
 */
export function getLocalProgressLastUpdated(): number {
  const store = readProgressStore();
  let max = 0;
  for (const chapters of Object.values(store.books ?? {})) {
    if (!chapters || typeof chapters !== "object") continue;
    for (const e of Object.values(chapters)) {
      const ts = Number((e as ProgressStoreEntry).updatedAt ?? 0);
      if (ts > max) max = ts;
    }
  }
  return max;
}

/**
 * Hydrate localStorage from SQLite chapter_progress so readProgressStore() sees durable progress.
 * Call once at app bootstrap before any progress-dependent code.
 *
 * Merges SQLite data with existing localStorage instead of overwriting, so that progress
 * written to localStorage but not yet flushed to SQLite (e.g. after a hard-close) is preserved.
 * bestChapterProgress rules (completed > newer timestamp > higher percent) pick the winner
 * per chapter, so whichever store has the more advanced data wins.
 *
 * Returns true if we successfully read from SQLite and wrote to localStorage (or had nothing to load).
 * On native, only set progressStoreHydrated when this returns true so we never flush empty localStorage
 * into SQLite and overwrite real progress (see docs/progress-persistence-issue-explained.md).
 */
export async function hydrateProgressFromDurable(): Promise<boolean> {
  if (!isNative()) return true;
  try {
    await migrateToChapterProgress();
    const durable = await readChapterProgressDurable();
    const count = durable
      ? Object.values(durable.books ?? {}).reduce((n, ch) => n + Object.keys(ch ?? {}).length, 0)
      : 0;
    console.log("[TaleVox] Progress LOAD from SQLite", { chapterCount: count });

    startupProgressConflict = null;

    if (durable && Object.keys(durable.books ?? {}).length > 0) {
      const local = readProgressStore();
      const hasLocalData = Object.keys(local.books ?? {}).length > 0;

      let selected = durable;
      if (hasLocalData) {
        const analysis = analyzeProgressMismatch(local, durable);
        if (analysis.isMajorMismatch) {
          startupProgressConflict = {
            eventId: buildProgressConflictEventId(analysis, local, durable),
            detectedAt: Date.now(),
            analysis,
            local,
            durable,
          };
          // Safe default before user confirms: keep durable source.
          selected = durable;
        } else {
          selected = mergeStores(durable, local);
        }
      }

      // Write the full selected payload directly ? do NOT trim here.
      // On native, SQLite is the source of truth and may have thousands of chapter
      // entries. Trimming at hydration time means readProgressStore() (called
      // synchronously during bootstrap) would miss most chapters, making progress
      // appear completely gone for large books.
      const payload = { ...selected, schemaVersion: PROGRESS_STORE_SCHEMA_VERSION };
      safeSetLocalStorage(PROGRESS_STORE_KEY, JSON.stringify(payload));
      progressStoreCache = payload;
      return true;
    }

    return true;
  } catch {
    return false;
  }
}

export const readProgressStore = (): ProgressStorePayload => {
  if (typeof window === "undefined") {
    return { schemaVersion: PROGRESS_STORE_SCHEMA_VERSION, books: {} };
  }
  if (isNative()) {
    const tryParse = (raw: string | null) => {
      if (!raw) return null;
      try {
        return normalizeProgressStore(JSON.parse(raw) as ProgressStorePayload);
      } catch {
        return null;
      }
    };
    const stable = tryParse(localStorage.getItem(PROGRESS_STORE_KEY));
    if (stable) return stable;
    for (const legacyKey of PROGRESS_STORE_LEGACY_KEYS) {
      const legacy = tryParse(localStorage.getItem(legacyKey));
      if (legacy && Object.keys(legacy.books ?? {}).length > 0) {
        safeSetLocalStorage(
          PROGRESS_STORE_KEY,
          JSON.stringify({ ...legacy, schemaVersion: PROGRESS_STORE_SCHEMA_VERSION })
        );
        return legacy;
      }
    }
    const empty = { schemaVersion: PROGRESS_STORE_SCHEMA_VERSION, books: {} };
    safeSetLocalStorage(PROGRESS_STORE_KEY, JSON.stringify(empty));
    return empty;
  }
  if (progressStoreCache !== null) return progressStoreCache;
  progressStoreCache = readProgressStoreFromLocalStorage();
  return progressStoreCache;
};

/**
 * On native, returns progress merged with SQLite so cloud save and snapshots
 * include all progress (avoids missing chapters that are only in SQLite).
 * On web, returns readProgressStore().
 */
export async function readProgressStoreForSave(): Promise<ProgressStorePayload> {
  const local = readProgressStore();
  if (!isNative()) return local;
  try {
    const durable = await readChapterProgressDurable();
    if (!durable || Object.keys(durable.books ?? {}).length === 0) return local;
    return mergeStores(local, durable);
  } catch {
    return local;
  }
}

export async function applyStartupProgressConflictChoice(
  choice: "durable" | "local"
): Promise<ProgressStorePayload | null> {
  const conflict = startupProgressConflict;
  if (!conflict) return null;
  const resolvedChoice = resolveStartupConflictChoice(choice);
  const selected = resolvedChoice === "local" ? conflict.local : conflict.durable;
  const payload: ProgressStorePayload = {
    ...selected,
    schemaVersion: PROGRESS_STORE_SCHEMA_VERSION,
  };

  try {
    safeSetLocalStorage(PROGRESS_STORE_KEY, JSON.stringify(payload));
    progressStoreCache = payload;
    if (isNative()) {
      await replaceChapterProgressDurable(payload);
    }
  } catch {
    // best-effort
  } finally {
    startupProgressConflict = null;
  }

  return payload;
}

function trimProgressStorePayload(store: ProgressStorePayload): ProgressStorePayload {
  const books: Record<string, Record<string, ProgressStoreEntry>> = {};
  for (const [bookId, chapters] of Object.entries(store.books || {})) {
    if (!chapters || typeof chapters !== "object") continue;
    const entries = Object.entries(chapters);
    if (entries.length <= MAX_CHAPTER_PROGRESS_ENTRIES_PER_BOOK) {
      books[bookId] = chapters;
      continue;
    }
    const byUpdated = entries
      .map(([cid, e]) => ({
        chapterId: cid,
        entry: e,
        updatedAt: Number((e as ProgressStoreEntry).updatedAt ?? 0),
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_CHAPTER_PROGRESS_ENTRIES_PER_BOOK);
    books[bookId] = Object.fromEntries(byUpdated.map(({ chapterId, entry }) => [chapterId, entry]));
  }
  return { ...store, books, schemaVersion: store.schemaVersion ?? PROGRESS_STORE_SCHEMA_VERSION };
}

/**
 * Phase 5: On native, update only localStorage (no SQLite). Keeps in-memory store current
 * without triggering SQLite writes on every tick.
 */
function writeProgressStoreNativeLocalOnly(store: ProgressStorePayload): void {
  if (!isNative()) return;
  const trimmed = trimProgressStorePayload(store);
  safeSetLocalStorage(
    PROGRESS_STORE_KEY,
    JSON.stringify({ ...trimmed, schemaVersion: PROGRESS_STORE_SCHEMA_VERSION })
  );
}

/**
 * On native, we must merge the incoming store with the current SQLite state before
 * writing. Otherwise a read-modify-write race can drop the latest chapter: e.g.
 * usePlayback writes progress for chapter 3575, then a late commitProgressLocal
 * (from a timeupdate for 3574) reads localStorage before that write, then writes
 * back 1–3574, overwriting and losing 3575. Merging with SQLite first ensures we
 * never write a payload that omits chapters that already exist in SQLite.
 */
function writeProgressStoreNative(store: ProgressStorePayload): void {
  if (!isNative()) return;
  if (!progressStoreHydrated) {
    if (typeof import.meta !== "undefined" && import.meta.env?.DEV) {
      console.warn("[progressStore] Skipping native write before hydration.");
    }
    return;
  }
  void (async () => {
    try {
      const durable = await readChapterProgressDurable();
      const merged = mergeStores(
        durable ?? { schemaVersion: PROGRESS_STORE_SCHEMA_VERSION, books: {} },
        store
      );
      const trimmed = trimProgressStorePayload(merged);
      safeSetLocalStorage(
        PROGRESS_STORE_KEY,
        JSON.stringify({ ...trimmed, schemaVersion: PROGRESS_STORE_SCHEMA_VERSION })
      );
      const existingMap = existingMapFromDurable(durable);
      await writeChapterProgressDurable(merged, existingMap);
    } catch {
      // fallback: write incoming store without merge (one full SELECT + executeSet)
      const payloadForStorage = trimProgressStorePayload(store);
      safeSetLocalStorage(
        PROGRESS_STORE_KEY,
        JSON.stringify({ ...payloadForStorage, schemaVersion: PROGRESS_STORE_SCHEMA_VERSION })
      );
      await writeChapterProgressDurable(store);
    }
  })();
}

export type WriteProgressStoreOptions = {
  /** When false (native only), update localStorage but do not write to SQLite. Phase 5: throttle. */
  persistToNative?: boolean;
};

export const writeProgressStore = (
  store: ProgressStorePayload,
  options?: WriteProgressStoreOptions
) => {
  if (typeof window === "undefined") return;
  if (isNative()) {
    if (options?.persistToNative === false) {
      writeProgressStoreNativeLocalOnly(store);
      return;
    }
    writeProgressStoreNative(store);
    return;
  }
  progressStoreCache = store;
  persistProgressToIndexedDB(store);
};

/**
 * Write a single chapter's progress directly to SQLite.
 * Phase 3: uses persistChapterProgressRow (completion lock + implausible-reset guard).
 * Pass forceReset: true when the user explicitly resets the chapter (e.g. reset button).
 */
export async function upsertSingleChapterProgress(
  bookId: string,
  chapterId: string,
  entry: ProgressStoreEntry,
  options?: { forceReset?: boolean }
): Promise<void> {
  if (!isNative()) return;
  if (!progressStoreHydrated) {
    if (typeof import.meta !== "undefined" && import.meta.env?.DEV) {
      console.warn("[progressStore] Skipping upsertSingleChapterProgress before hydration.");
    }
    return;
  }
  try {
    await ensureChapterProgressTable();
    const name = appConfig.db.name;
    const version = appConfig.db.version;
    const timeSec = Number(entry.timeSec ?? 0);
    const durationSec = entry.durationSec != null ? Number(entry.durationSec) : null;
    const percent =
      entry.percent != null
        ? Number(entry.percent)
        : durationSec && durationSec > 0
          ? Math.min(1, timeSec / durationSec)
          : 0;
    const completed = entry.completed === true;
    const updatedAt = Number(entry.updatedAt ?? Date.now());
    await persistChapterProgressRow(
      name,
      version,
      bookId || "unknown",
      chapterId,
      timeSec,
      durationSec,
      percent,
      completed,
      updatedAt,
      { forceReset: options?.forceReset ?? false }
    );
  } catch {
    // best-effort
  }
}

/** Mutex: only one flush runs at a time to avoid Android SQLiteConnection leak from concurrent execute/query/executeSet. */
let flushMutexPromise: Promise<void> = Promise.resolve();

const FLUSH_DEBOUNCE_MS = 1200;
let flushDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let flushDebouncePromise: Promise<void> | null = null;
let flushDebounceResolve: (() => void) | null = null;

/**
 * Flush current progress from localStorage to SQLite (native only).
 * Serialized so concurrent calls don't overload the DB.
 * Debounced: non-immediate calls coalesce into one flush after FLUSH_DEBOUNCE_MS.
 * Use { immediate: true } for app pause/background so we persist before process may be killed.
 */
export async function flushProgressStoreToDurable(options?: {
  immediate?: boolean;
}): Promise<void> {
  if (!isNative()) return;
  const immediate = options?.immediate === true;

  const runFlush = async (): Promise<void> => {
    if (!progressStoreHydrated) {
      if (typeof import.meta !== "undefined" && import.meta.env?.DEV) {
        console.warn("[progressStore] Skipping flushProgressStoreToDurable before hydration.");
      }
      return;
    }
    const raw = typeof window !== "undefined" ? localStorage.getItem(PROGRESS_STORE_KEY) : null;
    const parsed = raw
      ? (() => {
          try {
            return normalizeProgressStore(JSON.parse(raw));
          } catch {
            return null;
          }
        })()
      : null;
    if (!parsed) return;

    const count = Object.values(parsed.books ?? {}).reduce(
      (n, ch) => n + Object.keys(ch ?? {}).length,
      0
    );
    if (count === 0) return;

    let hasNonZero = false;
    for (const chapters of Object.values(parsed.books ?? {})) {
      if (!chapters || typeof chapters !== "object") continue;
      for (const e of Object.values(chapters)) {
        const ent = e as ProgressStoreEntry;
        if ((typeof ent.timeSec === "number" && ent.timeSec > 0) || ent.completed === true) {
          hasNonZero = true;
          break;
        }
      }
      if (hasNonZero) break;
    }
    if (count > 15 && !hasNonZero) {
      if (typeof import.meta !== "undefined" && import.meta.env?.DEV) {
        console.warn(
          "[progressStore] Skipping flush: payload is all zeros (would overwrite progress)."
        );
      }
      return;
    }

    const prev = flushMutexPromise;
    let resolveMutex: () => void;
    flushMutexPromise = new Promise<void>((r) => {
      resolveMutex = r;
    });
    try {
      await prev;
      const durable = await readChapterProgressDurable();
      const existingMap = existingMapFromDurable(durable);
      console.log("[TaleVox] Progress SAVE flush to SQLite", { chapterCount: count });
      await writeChapterProgressDurable(parsed, existingMap);
    } finally {
      resolveMutex!();
    }
  };

  if (immediate) {
    if (flushDebounceTimer != null) {
      clearTimeout(flushDebounceTimer);
      flushDebounceTimer = null;
      flushDebouncePromise = null;
      flushDebounceResolve = null;
    }
    await runFlush();
    return;
  }

  if (flushDebounceTimer != null) {
    return flushDebouncePromise ?? Promise.resolve();
  }

  flushDebouncePromise = new Promise<void>((r) => {
    flushDebounceResolve = r;
  });
  flushDebounceTimer = setTimeout(() => {
    flushDebounceTimer = null;
    const p = flushDebouncePromise;
    const resolve = flushDebounceResolve;
    flushDebouncePromise = null;
    flushDebounceResolve = null;
    runFlush()
      .then(() => resolve?.())
      .catch(() => resolve?.());
  }, FLUSH_DEBOUNCE_MS);

  return flushDebouncePromise;
}

/**
 * Persist current playback position for one chapter (e.g. from timeupdate/pause/ended).
 * Does not enforce monotonicity: stores the given position as-is so seek-back is persisted.
 */
export async function commitProgressLocal(args: {
  bookId?: string | null;
  chapterId: string;
  timeSec: number;
  durationSec?: number;
  isComplete?: boolean;
  updatedAt?: number;
}): Promise<void> {
  if (typeof window === "undefined") return;
  const { bookId, chapterId, timeSec, durationSec, isComplete, updatedAt } = args;
  try {
    const store = readProgressStore();
    const books = { ...store.books };
    const resolvedBookId =
      bookId ?? Object.keys(books).find((id) => books[id] && books[id][chapterId]) ?? "unknown";
    if (!books[resolvedBookId]) books[resolvedBookId] = {};
    const prev = books[resolvedBookId][chapterId] || {};
    const durSec = durationSec ?? prev.durationSec;
    const percent =
      isComplete === true
        ? 1
        : durSec != null && durSec > 0 && timeSec != null
          ? Math.min(1, timeSec / durSec)
          : (prev.percent ?? 0);
    books[resolvedBookId][chapterId] = {
      ...prev,
      timeSec,
      durationSec: durationSec ?? prev.durationSec,
      percent,
      completed: isComplete ?? prev.completed,
      updatedAt: updatedAt ?? Date.now(),
    };
    writeProgressStore({ ...store, books });
  } catch {
    // ignore
  }
}

export async function loadProgressLocal(
  chapterId: string,
  bookId?: string | null
): Promise<ProgressStoreEntry | null> {
  if (typeof window === "undefined") return null;
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
