// services/sqliteStorageDriver.ts
/* eslint-disable @typescript-eslint/no-explicit-any */

import { Capacitor } from "@capacitor/core";
import type { SQLiteDBConnection, SQLiteConnection } from "@capacitor-community/sqlite";
import { CapacitorSQLite } from "@capacitor-community/sqlite";

import type { StorageDriver, ChapterProgressRecord } from "./storageDriver";

function nowMs(): number {
  return Date.now();
}

function toBoolInt(v: boolean | undefined): number {
  return v ? 1 : 0;
}

function fromBoolInt(v: any): boolean {
  return v === 1 || v === true;
}

export class SqliteStorageDriver implements StorageDriver {
  public name: StorageDriver["name"] = "sqlite";

  private sqlite: SQLiteConnection;
  private db: SQLiteDBConnection | null = null;
  private isReady: boolean = false;

  constructor() {
    this.sqlite = new SQLiteConnection(CapacitorSQLite);
  }

  public async init(): Promise<void> {
    if (this.isReady) return;

    const isNative = Capacitor.isNativePlatform();
    if (!isNative) {
      // This driver is only for native.
      return;
    }

    this.db = await this.sqlite.createConnection("talevox", false, "no-encryption", 1, false);
    await this.db.open();

    await this.ensureSchema();

    this.isReady = true;
  }

  private mustDb(): SQLiteDBConnection {
    if (!this.db) throw new Error("SQLite DB not initialized. Did you call initStorage()?");
    return this.db;
  }

  /**
   * Phase One: expose the live DB connection for feature stores (books/chapters).
   * This stays internal to the app codebase and is not used by UI directly.
   */
  public getDb(): SQLiteDBConnection {
    return this.mustDb();
  }

  private async ensureSchema(): Promise<void> {
    const db = this.mustDb();

    // Phase One: library schema for books/chapters/text (paged).
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

      -- Phase One 3.0 library tables
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
        updatedAt INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_chapter_text_bookId ON chapter_text(bookId);
    `);
  }

  public async saveJson(key: string, value: unknown): Promise<void> {
    await this.init();
    const db = this.mustDb();
    await db.run(
      `INSERT INTO kv (key, json, updatedAt)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         json = excluded.json,
         updatedAt = excluded.updatedAt`,
      [key, JSON.stringify(value), nowMs()]
    );
  }

  public async loadJson<T>(key: string, fallback: T): Promise<T> {
    await this.init();
    const db = this.mustDb();
    const res = await db.query(`SELECT json FROM kv WHERE key = ?`, [key]);
    const row = res.values?.[0] as any;
    if (!row || !row.json) return fallback;

    try {
      return JSON.parse(row.json) as T;
    } catch {
      return fallback;
    }
  }

  public async deleteKey(key: string): Promise<void> {
    await this.init();
    const db = this.mustDb();
    await db.run(`DELETE FROM kv WHERE key = ?`, [key]);
  }

  public async saveChapterProgress(record: ChapterProgressRecord): Promise<void> {
    await this.init();
    const db = this.mustDb();
    await db.run(
      `INSERT INTO progress (chapterId, timeSec, durationSec, percent, isComplete, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(chapterId) DO UPDATE SET
         timeSec = excluded.timeSec,
         durationSec = excluded.durationSec,
         percent = excluded.percent,
         isComplete = excluded.isComplete,
         updatedAt = excluded.updatedAt`,
      [
        record.chapterId,
        record.timeSec,
        record.durationSec ?? null,
        record.percent ?? null,
        toBoolInt(record.isComplete),
        nowMs(),
      ]
    );
  }

  public async loadChapterProgress(chapterId: string): Promise<ChapterProgressRecord | null> {
    await this.init();
    const db = this.mustDb();
    const res = await db.query(
      `SELECT chapterId, timeSec, durationSec, percent, isComplete, updatedAt
       FROM progress WHERE chapterId = ?`,
      [chapterId]
    );

    const row = res.values?.[0] as any;
    if (!row) return null;

    return {
      chapterId: String(row.chapterId),
      timeSec: Number(row.timeSec),
      durationSec: row.durationSec != null ? Number(row.durationSec) : undefined,
      percent: row.percent != null ? Number(row.percent) : undefined,
      isComplete: fromBoolInt(row.isComplete),
      updatedAt: Number(row.updatedAt),
    };
  }
}
