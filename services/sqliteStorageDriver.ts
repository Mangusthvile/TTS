// services/sqliteStorageDriver.ts
/* eslint-disable @typescript-eslint/no-explicit-any */

import { Capacitor } from "@capacitor/core";
import type { SQLiteDBConnection } from "@capacitor-community/sqlite";
import { getSqliteDb, closeSqliteDb } from "./sqliteConnectionManager";
import { appConfig } from "../src/config/appConfig";

import type {
  AppState,
  SettingsState,
  RulesState,
  AuthSession,
  ChapterProgress,
  StorageDriver,
  StorageInitResult,
  LoadResult,
  SaveResult,
  DriveUploadQueuedItem,
} from "./storageDriver";
import type { JobRecord, JobType } from "../types";

/**
 * Phase 2.3 — SqliteStorageDriver
 *
 * This is the durable, local-first storage layer for Android (Capacitor native).
 * It stores:
 *  - app state blob (key-value JSON)
 *  - settings JSON
 *  - rules JSON
 *  - per-chapter progress rows (fast updates)
 *
 * NOTE:
 * - We are not wiring the app to use this driver yet in Phase 2.3.
 * - Next step will hook it into App boot + progress commits.
 */

const DB_NAME = appConfig.db.name;
const DB_VERSION = appConfig.db.version;

// KV keys
const KEY_APP_STATE = "app_state";
const KEY_SETTINGS = "settings";
const KEY_RULES = "rules";
const KEY_SMALL_BACKUP = "small_backup";
const KEY_AUTH_SESSION = "auth_session";

const LIBRARY_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS books (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    author TEXT,
    coverImage TEXT,
    backend TEXT NOT NULL,
    driveFolderId TEXT,
    driveFolderName TEXT,
    currentChapterId TEXT,
    settingsJson TEXT,
    rulesJson TEXT,
    updatedAt INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS chapters (
    id TEXT PRIMARY KEY,
    bookId TEXT NOT NULL,
    idx INTEGER NOT NULL,
    title TEXT NOT NULL,
    filename TEXT NOT NULL,
    sourceUrl TEXT,
    cloudTextFileId TEXT,
    cloudAudioFileId TEXT,
    audioDriveId TEXT,
    audioStatus TEXT,
    audioSignature TEXT,
    durationSec REAL,
    textLength INTEGER,
    wordCount INTEGER,
    isFavorite INTEGER,
    updatedAt INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_chapters_book_idx ON chapters(bookId, idx);

  CREATE TABLE IF NOT EXISTS chapter_text (
    chapterId TEXT PRIMARY KEY,
    bookId TEXT NOT NULL,
    content TEXT NOT NULL,
    localPath TEXT,
    updatedAt INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_chapter_text_bookId ON chapter_text(bookId);

  CREATE TABLE IF NOT EXISTS chapter_cue_maps (
    chapterId TEXT PRIMARY KEY,
    cueJson TEXT NOT NULL,
    updatedAt INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS chapter_paragraph_maps (
    chapterId TEXT PRIMARY KEY,
    paragraphJson TEXT NOT NULL,
    updatedAt INTEGER NOT NULL
  );
`;

function nowMs() {
  return Date.now();
}

function toBoolInt(v: boolean | undefined): number {
  return v ? 1 : 0;
}
function fromBoolInt(v: any): boolean {
  return v === 1 || v === true;
}

export class SqliteStorageDriver implements StorageDriver {
  name = "sqlite";

  private db: SQLiteDBConnection | null = null;
  private initInFlight: Promise<StorageInitResult> | null = null;

  async init(): Promise<StorageInitResult> {
    if (this.initInFlight) return this.initInFlight;
    this.initInFlight = this.initInternal().catch((err) => {
      this.initInFlight = null;
      throw err;
    });
    return this.initInFlight;
  }

  private async initInternal(): Promise<StorageInitResult> {
    if (!Capacitor.isNativePlatform()) {
      // Safety: this driver is only meant for native (Android).
      return { driverName: this.name, mode: "unknown" };
    }

    if (this.db) {
      return { driverName: this.name, mode: "sqlite" };
    }

    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        this.db = await getSqliteDb(DB_NAME, DB_VERSION);
        await this.ensureSchema();
        lastErr = null;
        break;
      } catch (e: any) {
        lastErr = e;
        const msg = String(e?.message ?? e).toLowerCase();
        if (msg.includes("does not exist") || msg.includes("not opened")) {
          await closeSqliteDb(DB_NAME);
          await new Promise((resolve) => setTimeout(resolve, 150));
          continue;
        }
        throw e;
      }
    }
    if (lastErr) {
      this.db = null;
      throw lastErr;
    }

    return { driverName: this.name, mode: "sqlite" };
  }

  async close(): Promise<void> {
    try {
      if (this.db) {
        await closeSqliteDb(DB_NAME);
      }
    } finally {
      this.db = null;
      this.initInFlight = null;
    }
  }

  public getDb(): SQLiteDBConnection {
    if (!this.db) throw new Error("SQLite DB not open");
    return this.db;
  }

  // -----------------------
  // App state (blob)
  // -----------------------

  async loadAppState(): Promise<LoadResult<AppState>> {
    return this.loadKvJson<AppState>(KEY_APP_STATE);
  }

  async saveAppState(state: AppState): Promise<SaveResult> {
    return this.saveKvJson(KEY_APP_STATE, state);
  }

  // -----------------------
  // Settings / Rules
  // -----------------------

  async loadSettings(): Promise<LoadResult<SettingsState>> {
    return this.loadKvJson<SettingsState>(KEY_SETTINGS);
  }

  async saveSettings(settings: SettingsState): Promise<SaveResult> {
    return this.saveKvJson(KEY_SETTINGS, settings);
  }

  async loadRules(): Promise<LoadResult<RulesState>> {
    return this.loadKvJson<RulesState>(KEY_RULES);
  }

  async saveRules(rules: RulesState): Promise<SaveResult> {
    return this.saveKvJson(KEY_RULES, rules);
  }

  async loadAuthSession(): Promise<LoadResult<AuthSession | null>> {
    const res = await this.loadKvJson<AuthSession>(KEY_AUTH_SESSION);
    if (!res.ok) return { ok: true, where: "sqlite", value: null };
    return { ok: true, where: "sqlite", value: res.value ?? null };
  }

  async saveAuthSession(session: AuthSession): Promise<SaveResult> {
    return this.saveKvJson(KEY_AUTH_SESSION, session);
  }

  async clearAuthSession(): Promise<SaveResult> {
    return this.saveKvJson(KEY_AUTH_SESSION, null);
  }

  // -----------------------
  // Chapter Progress (row)
  // -----------------------

  async loadChapterProgress(
    chapterId: string
  ): Promise<LoadResult<ChapterProgress | null>> {
    const db = await this.dbConn();

    try {
      const res = await db.query(
        `SELECT chapterId, timeSec, durationSec, percent, isComplete, updatedAt
         FROM progress
         WHERE chapterId = ?`,
        [chapterId]
      );

      const row = (res.values?.[0] ?? null) as any;
      if (!row) return { ok: true, where: "sqlite", value: null };

      const value: ChapterProgress = {
        chapterId: String(row.chapterId),
        timeSec: Number(row.timeSec) || 0,
        durationSec: row.durationSec == null ? undefined : Number(row.durationSec),
        percent: row.percent == null ? undefined : Number(row.percent),
        isComplete: fromBoolInt(row.isComplete),
        updatedAt: Number(row.updatedAt) || 0,
      };

      return { ok: true, where: "sqlite", value };
    } catch (e: any) {
      return { ok: false, where: "sqlite", error: e?.message ?? String(e) };
    }
  }

  async saveChapterProgress(progress: ChapterProgress): Promise<SaveResult> {
    const db = await this.dbConn();

    const updatedAt = progress.updatedAt || nowMs();
    const durationSec =
      typeof progress.durationSec === "number" ? progress.durationSec : null;

    const percent =
      typeof progress.percent === "number"
        ? progress.percent
        : durationSec && durationSec > 0
        ? Math.max(0, Math.min(1, progress.timeSec / durationSec))
        : null;

    const isComplete =
      typeof progress.isComplete === "boolean"
        ? progress.isComplete
        : typeof percent === "number"
        ? percent >= 0.995
        : false;

    try {
      // SQLite UPSERT keeps this safe and atomic
      await db.run(
        `INSERT INTO progress (chapterId, timeSec, durationSec, percent, isComplete, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(chapterId) DO UPDATE SET
           timeSec     = excluded.timeSec,
           durationSec = excluded.durationSec,
           percent     = excluded.percent,
           isComplete  = excluded.isComplete,
           updatedAt   = excluded.updatedAt`,
        [
          progress.chapterId,
          progress.timeSec,
          durationSec,
          percent,
          toBoolInt(isComplete),
          updatedAt,
        ]
      );

      return { ok: true, where: "sqlite" };
    } catch (e: any) {
      return { ok: false, where: "sqlite", error: e?.message ?? String(e) };
    }
  }

  // -----------------------
  // Small backup snapshot
  // -----------------------

  async saveSmallBackupSnapshot(snapshot: Record<string, any>): Promise<SaveResult> {
    return this.saveKvJson(KEY_SMALL_BACKUP, snapshot);
  }

  async loadSmallBackupSnapshot(): Promise<LoadResult<Record<string, any> | null>> {
    const res = await this.loadKvJson<Record<string, any>>(KEY_SMALL_BACKUP);
    if (!res.ok) return { ok: true, where: "sqlite", value: null };
    return { ok: true, where: "sqlite", value: res.value ?? null };
  }

  // -----------------------
  // Jobs (WorkManager)
  // -----------------------

  async createJob(job: JobRecord): Promise<SaveResult> {
    const db = await this.dbConn();
    try {
      await db.run(
        `INSERT INTO jobs (jobId, type, status, payloadJson, progressJson, error, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          job.jobId,
          job.type,
          job.status,
          JSON.stringify(job.payloadJson ?? null),
          job.progressJson ? JSON.stringify(job.progressJson) : null,
          job.error ?? null,
          job.createdAt,
          job.updatedAt,
        ]
      );
      return { ok: true, where: "sqlite" };
    } catch (e: any) {
      return { ok: false, where: "sqlite", error: e?.message ?? String(e) };
    }
  }

  async updateJob(jobId: string, patch: Partial<Omit<JobRecord, "jobId" | "createdAt">>): Promise<SaveResult> {
    const existing = await this.getJob(jobId);
    if (!existing.ok || !existing.value) return { ok: false, where: "sqlite", error: "missing" };

    const next: JobRecord = {
      ...existing.value,
      ...patch,
      jobId,
      createdAt: existing.value.createdAt,
      updatedAt: patch.updatedAt ?? nowMs(),
    };

    const db = await this.dbConn();
    try {
      await db.run(
        `UPDATE jobs
         SET type = ?, status = ?, payloadJson = ?, progressJson = ?, error = ?, updatedAt = ?
         WHERE jobId = ?`,
        [
          next.type,
          next.status,
          JSON.stringify(next.payloadJson ?? null),
          next.progressJson ? JSON.stringify(next.progressJson) : null,
          next.error ?? null,
          next.updatedAt,
          jobId,
        ]
      );
      return { ok: true, where: "sqlite" };
    } catch (e: any) {
      return { ok: false, where: "sqlite", error: e?.message ?? String(e) };
    }
  }

  async getJob(jobId: string): Promise<LoadResult<JobRecord | null>> {
    const db = await this.dbConn();
    try {
      const res = await db.query(
        `SELECT jobId, type, status, payloadJson, progressJson, error, createdAt, updatedAt
         FROM jobs
         WHERE jobId = ?`,
        [jobId]
      );

      const row = (res.values?.[0] ?? null) as any;
      if (!row) return { ok: true, where: "sqlite", value: null };

      const value: JobRecord = {
        jobId: String(row.jobId),
        type: String(row.type) as JobType,
        status: String(row.status) as JobRecord["status"],
        payloadJson: row.payloadJson ? JSON.parse(String(row.payloadJson)) : null,
        progressJson: row.progressJson ? JSON.parse(String(row.progressJson)) : undefined,
        error: row.error == null ? undefined : String(row.error),
        createdAt: Number(row.createdAt) || 0,
        updatedAt: Number(row.updatedAt) || 0,
      };

      return { ok: true, where: "sqlite", value };
    } catch (e: any) {
      return { ok: false, where: "sqlite", error: e?.message ?? String(e) };
    }
  }

  async listJobs(type?: JobType): Promise<LoadResult<JobRecord[]>> {
    const db = await this.dbConn();
    try {
      const res = await db.query(
        `SELECT jobId, type, status, payloadJson, progressJson, error, createdAt, updatedAt
         FROM jobs
         ${type ? "WHERE type = ?" : ""}
         ORDER BY createdAt DESC`,
        type ? [type] : []
      );

      const rows = (res.values ?? []) as any[];
      const jobs = rows.map((row) => ({
        jobId: String(row.jobId),
        type: String(row.type) as JobType,
        status: String(row.status) as JobRecord["status"],
        payloadJson: row.payloadJson ? JSON.parse(String(row.payloadJson)) : null,
        progressJson: row.progressJson ? JSON.parse(String(row.progressJson)) : undefined,
        error: row.error == null ? undefined : String(row.error),
        createdAt: Number(row.createdAt) || 0,
        updatedAt: Number(row.updatedAt) || 0,
      }));

      return { ok: true, where: "sqlite", value: jobs };
    } catch (e: any) {
      return { ok: false, where: "sqlite", error: e?.message ?? String(e) };
    }
  }

  async setChapterAudioPath(chapterId: string, localPath: string, sizeBytes: number): Promise<SaveResult> {
    const db = await this.dbConn();
    try {
      await db.run(
        `INSERT INTO chapter_audio_files (chapterId, localPath, sizeBytes, updatedAt)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(chapterId) DO UPDATE SET
           localPath = excluded.localPath,
           sizeBytes = excluded.sizeBytes,
           updatedAt = excluded.updatedAt`,
        [chapterId, localPath, sizeBytes, Date.now()]
      );
      return { ok: true, where: "sqlite" };
    } catch (e: any) {
      return { ok: false, where: "sqlite", error: e?.message ?? String(e) };
    }
  }

  async getChapterAudioPath(chapterId: string): Promise<LoadResult<{ localPath: string; sizeBytes: number; updatedAt: number } | null>> {
    const db = await this.dbConn();
    try {
      const res = await db.query(
        `SELECT localPath, sizeBytes, updatedAt FROM chapter_audio_files WHERE chapterId = ?`,
        [chapterId]
      );
      const row = (res.values?.[0] ?? null) as any;
      if (!row) return { ok: true, where: "sqlite", value: null };
      return {
        ok: true,
        where: "sqlite",
        value: {
          localPath: String(row.localPath),
          sizeBytes: Number(row.sizeBytes) || 0,
          updatedAt: Number(row.updatedAt) || 0,
        },
      };
    } catch (e: any) {
      return { ok: false, where: "sqlite", error: e?.message ?? String(e) };
    }
  }

  async deleteChapterAudioPath(chapterId: string): Promise<SaveResult> {
    const db = await this.dbConn();
    try {
      await db.run(`DELETE FROM chapter_audio_files WHERE chapterId = ?`, [chapterId]);
      return { ok: true, where: "sqlite" };
    } catch (e: any) {
      return { ok: false, where: "sqlite", error: e?.message ?? String(e) };
    }
  }

  async enqueueUpload(item: DriveUploadQueuedItem): Promise<SaveResult> {
    const db = await this.dbConn();
    try {
      await db.run(
        `INSERT INTO drive_upload_queue (id, chapterId, bookId, localPath, status, attempts, nextAttemptAt, lastError, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(chapterId) DO UPDATE SET
           status = excluded.status,
           localPath = excluded.localPath,
           nextAttemptAt = excluded.nextAttemptAt,
           updatedAt = excluded.updatedAt`,
        [
          item.id,
          item.chapterId,
          item.bookId,
          item.localPath,
          item.status,
          item.attempts,
          item.nextAttemptAt,
          item.lastError ?? null,
          item.createdAt,
          item.updatedAt,
        ]
      );
      return { ok: true, where: "sqlite" };
    } catch (e: any) {
      return { ok: false, where: "sqlite", error: e?.message ?? String(e) };
    }
  }

  async getNextReadyUpload(now: number): Promise<LoadResult<DriveUploadQueuedItem | null>> {
    const db = await this.dbConn();
    try {
      const res = await db.query(
        `SELECT * FROM drive_upload_queue
         WHERE (status = 'queued' OR status = 'failed') AND nextAttemptAt <= ?
         ORDER BY nextAttemptAt ASC, createdAt ASC
         LIMIT 1`,
        [now]
      );
      const row = (res.values?.[0] ?? null) as any;
      if (!row) return { ok: true, where: "sqlite", value: null };
      return {
        ok: true,
        where: "sqlite",
        value: {
          id: String(row.id),
          chapterId: String(row.chapterId),
          bookId: String(row.bookId),
          localPath: String(row.localPath),
          status: String(row.status) as DriveUploadQueuedItem['status'],
          attempts: Number(row.attempts) || 0,
          nextAttemptAt: Number(row.nextAttemptAt) || 0,
          lastError: row.lastError == null ? undefined : String(row.lastError),
          createdAt: Number(row.createdAt) || 0,
          updatedAt: Number(row.updatedAt) || 0,
        },
      };
    } catch (e: any) {
      return { ok: false, where: "sqlite", error: e?.message ?? String(e) };
    }
  }

  async markUploadUploading(id: string, nextAttemptAt: number): Promise<SaveResult> {
    const db = await this.dbConn();
    try {
      await db.run(
        `UPDATE drive_upload_queue
         SET status = 'uploading',
             attempts = attempts + 1,
             nextAttemptAt = ?,
             updatedAt = ?
         WHERE id = ?`,
        [nextAttemptAt, Date.now(), id]
      );
      return { ok: true, where: "sqlite" };
    } catch (e: any) {
      return { ok: false, where: "sqlite", error: e?.message ?? String(e) };
    }
  }

  async markUploadDone(id: string): Promise<SaveResult> {
    const db = await this.dbConn();
    try {
      await db.run(`DELETE FROM drive_upload_queue WHERE id = ?`, [id]);
      return { ok: true, where: "sqlite" };
    } catch (e: any) {
      return { ok: false, where: "sqlite", error: e?.message ?? String(e) };
    }
  }

  async markUploadFailed(id: string, error: string, nextAttemptAt: number): Promise<SaveResult> {
    const db = await this.dbConn();
    try {
      await db.run(
        `UPDATE drive_upload_queue
         SET status = 'failed',
             lastError = ?,
             nextAttemptAt = ?,
             attempts = attempts + 1,
             updatedAt = ?
         WHERE id = ?`,
        [error, nextAttemptAt, Date.now(), id]
      );
      return { ok: true, where: "sqlite" };
    } catch (e: any) {
      return { ok: false, where: "sqlite", error: e?.message ?? String(e) };
    }
  }

  async countQueuedUploads(): Promise<LoadResult<number>> {
    const db = await this.dbConn();
    try {
      const res = await db.query(
        `SELECT COUNT(*) AS cnt FROM drive_upload_queue WHERE status IN ('queued', 'failed')`
      );
      const row = (res.values?.[0] ?? null) as any;
      return { ok: true, where: "sqlite", value: Number(row?.cnt ?? 0) };
    } catch (e: any) {
      return { ok: false, where: "sqlite", error: e?.message ?? String(e) };
    }
  }

  async listQueuedUploads(limit?: number): Promise<LoadResult<DriveUploadQueuedItem[]>> {
    const db = await this.dbConn();
    try {
      const res = await db.query(
        `SELECT id, chapterId, bookId, localPath, status, attempts, nextAttemptAt, lastError, createdAt, updatedAt
         FROM drive_upload_queue
         WHERE status IN ('queued', 'failed')
         ORDER BY createdAt DESC
         ${typeof limit === "number" ? `LIMIT ${limit}` : ""}`
      );
      const rows = (res.values ?? []) as any[];
      const items = rows.map((row) => ({
        id: String(row.id),
        chapterId: String(row.chapterId),
        bookId: String(row.bookId),
        localPath: String(row.localPath),
        status: String(row.status) as DriveUploadQueuedItem["status"],
        attempts: Number(row.attempts) || 0,
        nextAttemptAt: Number(row.nextAttemptAt) || 0,
        lastError: row.lastError == null ? undefined : String(row.lastError),
        createdAt: Number(row.createdAt) || 0,
        updatedAt: Number(row.updatedAt) || 0,
      }));
      return { ok: true, where: "sqlite", value: items };
    } catch (e: any) {
      return { ok: false, where: "sqlite", error: e?.message ?? String(e) };
    }
  }

  async deleteJob(jobId: string): Promise<SaveResult> {
    const db = await this.dbConn();
    try {
      await db.run(`DELETE FROM jobs WHERE jobId = ?`, [jobId]);
      return { ok: true, where: "sqlite" };
    } catch (e: any) {
      return { ok: false, where: "sqlite", error: e?.message ?? String(e) };
    }
  }

  async clearJobs(statuses: string[]): Promise<SaveResult> {
    const db = await this.dbConn();
    if (!statuses.length) return { ok: true, where: "sqlite" };
    const placeholders = statuses.map(() => "?").join(",");
    try {
      await db.run(`DELETE FROM jobs WHERE status IN (${placeholders})`, statuses);
      return { ok: true, where: "sqlite" };
    } catch (e: any) {
      return { ok: false, where: "sqlite", error: e?.message ?? String(e) };
    }
  }

  // -----------------------
  // Internals
  // -----------------------

  private async dbConn(): Promise<SQLiteDBConnection> {
    this.db = await getSqliteDb(DB_NAME, DB_VERSION);
    try {
      await (this.db as any).open?.();
    } catch {
      // open is idempotent; ignore errors like "already open"
    }
    return this.db;
  }

  private async ensureSchema(): Promise<void> {
    const db = await this.dbConn();

    // Keep schema small & clear. We can expand later (offline_cache, books, chapters tables).
    await db.execute(`
      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        json TEXT NOT NULL,
        updatedAt INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS progress (
        chapterId TEXT PRIMARY KEY,
        timeSec REAL NOT NULL,
        durationSec REAL,
        percent REAL,
        isComplete INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS jobs (
        jobId TEXT PRIMARY KEY,
        type TEXT,
        status TEXT,
        payloadJson TEXT,
        progressJson TEXT,
        error TEXT,
        createdAt INTEGER,
        updatedAt INTEGER
      );

      CREATE TABLE IF NOT EXISTS chapter_audio_files (
        chapterId TEXT PRIMARY KEY,
        localPath TEXT,
        sizeBytes INTEGER,
        updatedAt INTEGER
      );

      CREATE TABLE IF NOT EXISTS drive_upload_queue (
        id TEXT PRIMARY KEY,
        chapterId TEXT,
        bookId TEXT,
        localPath TEXT,
        status TEXT,
        attempts INTEGER,
        nextAttemptAt INTEGER,
        lastError TEXT,
        createdAt INTEGER,
        updatedAt INTEGER
      );
    `);

    await this.db!.execute(LIBRARY_SCHEMA_SQL);
    try {
      await this.db!.execute(`ALTER TABLE chapter_text ADD COLUMN localPath TEXT`);
    } catch {
      // Column already exists
    }
  }

  private async loadKvJson<T>(key: string): Promise<LoadResult<T>> {
    const db = await this.dbConn();

    try {
      const res = await db.query(
        `SELECT json FROM kv WHERE key = ?`,
        [key]
      );

      const row = (res.values?.[0] ?? null) as any;
      if (!row || row.json == null) return { ok: false, where: "sqlite", error: "missing" };

      const parsed = JSON.parse(String(row.json)) as T;
      return { ok: true, where: "sqlite", value: parsed };
    } catch (e: any) {
      return { ok: false, where: "sqlite", error: e?.message ?? String(e) };
    }
  }

  private async saveKvJson(key: string, value: any): Promise<SaveResult> {
    const db = await this.dbConn();

    try {
      const raw = JSON.stringify(value);
      const t = nowMs();

      await db.run(
        `INSERT INTO kv (key, json, updatedAt)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           json = excluded.json,
           updatedAt = excluded.updatedAt`,
        [key, raw, t]
      );

      return { ok: true, where: "sqlite" };
    } catch (e: any) {
      return { ok: false, where: "sqlite", error: e?.message ?? String(e) };
    }
  }
}
