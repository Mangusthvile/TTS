// services/nativeLibraryBridge.ts
/* eslint-disable @typescript-eslint/no-explicit-any */

import { Capacitor } from "@capacitor/core";
import type { SQLiteDBConnection } from "@capacitor-community/sqlite";
import { getSqliteDb } from "./sqliteConnectionManager";
import { appConfig } from "../src/config/appConfig";

const DB_NAME = appConfig.db.name;
const DB_VERSION = appConfig.db.version;

let bridgeReady: Promise<SQLiteDBConnection> | null = null;

function isNative(): boolean {
  try {
    return typeof window !== "undefined" && !!(window as any).Capacitor && Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

async function getDb(): Promise<SQLiteDBConnection> {
  if (!isNative()) {
    throw new Error("nativeLibraryBridge: not running on native platform");
  }
  if (bridgeReady) return bridgeReady;
  bridgeReady = (async () => {
    const conn = await getSqliteDb(DB_NAME, DB_VERSION);
    await ensureSchema(conn);
    return conn;
  })().catch((err) => {
    bridgeReady = null;
    throw err;
  });
  return bridgeReady;
}

async function ensureSchema(conn: SQLiteDBConnection): Promise<void> {
  await conn.execute(`
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
      sortOrder INTEGER,
      title TEXT NOT NULL,
      filename TEXT NOT NULL,
      sourceUrl TEXT,
      volumeName TEXT,
      volumeLocalChapter INTEGER,
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
  `);
  try {
    await conn.execute(`ALTER TABLE chapter_text ADD COLUMN localPath TEXT`);
  } catch {
    // Column already exists
  }
  try {
    await conn.execute(`ALTER TABLE chapters ADD COLUMN volumeName TEXT`);
  } catch {
    // Column already exists
  }
  try {
    await conn.execute(`ALTER TABLE chapters ADD COLUMN volumeLocalChapter INTEGER`);
  } catch {
    // Column already exists
  }
  try {
    await conn.execute(`ALTER TABLE chapters ADD COLUMN sortOrder INTEGER`);
  } catch {
    // Column already exists
  }
  try {
    await conn.execute(`UPDATE chapters SET sortOrder = idx WHERE sortOrder IS NULL`);
  } catch {
    // best-effort backfill
  }
  try {
    await conn.execute(`CREATE INDEX IF NOT EXISTS idx_chapters_book_sort ON chapters(bookId, sortOrder, idx)`);
  } catch {
    // best-effort index creation
  }
}

export async function ensureNativeBook(book: {
  id: string;
  title: string;
  author?: string;
  coverImage?: string;
  backend?: string;
  driveFolderId?: string;
  driveFolderName?: string;
  currentChapterId?: string;
  settings?: any;
  rules?: any;
}): Promise<void> {
  const conn = await getDb();
  const now = Date.now();
  const backend = book.backend ?? (book.driveFolderId ? "drive" : "local");
  const settingsJson = book.settings != null ? JSON.stringify(book.settings) : null;
  const rulesJson = book.rules != null ? JSON.stringify(book.rules) : null;
  await conn.run(
    `INSERT INTO books (
      id, title, author, coverImage, backend, driveFolderId, driveFolderName,
      currentChapterId, settingsJson, rulesJson, updatedAt
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       title=excluded.title,
       author=excluded.author,
       coverImage=excluded.coverImage,
       backend=excluded.backend,
       driveFolderId=excluded.driveFolderId,
       driveFolderName=excluded.driveFolderName,
       currentChapterId=excluded.currentChapterId,
       settingsJson=excluded.settingsJson,
       rulesJson=excluded.rulesJson,
       updatedAt=excluded.updatedAt`,
    [
      book.id,
      book.title,
      book.author ?? null,
      book.coverImage ?? null,
      backend,
      book.driveFolderId ?? null,
      book.driveFolderName ?? null,
      book.currentChapterId ?? null,
      settingsJson,
      rulesJson,
      now,
    ]
  );
}

export async function ensureNativeChapter(
  bookId: string,
  chapter: {
    id: string;
    title: string;
    idx?: number;
    sortOrder?: number;
    filename?: string;
    sourceUrl?: string;
    volumeName?: string;
    volumeLocalChapter?: number;
    cloudTextFileId?: string;
    cloudAudioFileId?: string;
    audioDriveId?: string;
    audioStatus?: string;
    audioSignature?: string;
    durationSec?: number;
    textLength?: number;
    wordCount?: number;
    isFavorite?: boolean;
    updatedAt?: number;
  }
): Promise<void> {
  const conn = await getDb();
  const now = Date.now();
  const filename = chapter.filename ?? `${chapter.id}.txt`;
  const idx = chapter.idx ?? 0;
  const sortOrder = chapter.sortOrder ?? idx;
  await conn.run(
    `INSERT INTO chapters (
      id, bookId, idx, sortOrder, title, filename, sourceUrl,
      volumeName, volumeLocalChapter,
      cloudTextFileId, cloudAudioFileId, audioDriveId,
      audioStatus, audioSignature, durationSec, textLength, wordCount,
      isFavorite, updatedAt
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       bookId=excluded.bookId,
       idx=excluded.idx,
       sortOrder=excluded.sortOrder,
       title=excluded.title,
       filename=excluded.filename,
       sourceUrl=excluded.sourceUrl,
       volumeName=excluded.volumeName,
       volumeLocalChapter=excluded.volumeLocalChapter,
       cloudTextFileId=excluded.cloudTextFileId,
       cloudAudioFileId=excluded.cloudAudioFileId,
       audioDriveId=excluded.audioDriveId,
       audioStatus=excluded.audioStatus,
       audioSignature=excluded.audioSignature,
       durationSec=excluded.durationSec,
       textLength=excluded.textLength,
       wordCount=excluded.wordCount,
       isFavorite=excluded.isFavorite,
       updatedAt=excluded.updatedAt`,
    [
      chapter.id,
      bookId,
      idx,
      sortOrder,
      chapter.title,
      filename,
      chapter.sourceUrl ?? null,
      (chapter as any).volumeName ?? null,
      (chapter as any).volumeLocalChapter ?? null,
      chapter.cloudTextFileId ?? null,
      chapter.cloudAudioFileId ?? null,
      chapter.audioDriveId ?? null,
      chapter.audioStatus ?? null,
      chapter.audioSignature ?? null,
      chapter.durationSec ?? null,
      chapter.textLength ?? null,
      chapter.wordCount ?? null,
      chapter.isFavorite ? 1 : 0,
      chapter.updatedAt ?? now,
    ]
  );
}

export async function ensureNativeChapterText(
  bookId: string,
  chapterId: string,
  content: string,
  localPath?: string | null
): Promise<void> {
  const conn = await getDb();
  const now = Date.now();
  await conn.run(
    `INSERT INTO chapter_text (chapterId, bookId, content, localPath, updatedAt)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(chapterId) DO UPDATE SET
       bookId=excluded.bookId,
       content=excluded.content,
       localPath=excluded.localPath,
       updatedAt=excluded.updatedAt`,
    [chapterId, bookId, content, localPath ?? null, now]
  );
}

export async function ensureNativeLibraryForGenerateAudio(
  book: {
    id: string;
    title: string;
    author?: string;
    coverImage?: string;
    backend?: string;
    driveFolderId?: string;
    driveFolderName?: string;
    currentChapterId?: string;
    settings?: any;
    rules?: any;
  },
  chapters: Array<{
    id: string;
    title: string;
    index?: number;
    sortOrder?: number;
    filename?: string;
    sourceUrl?: string;
    cloudTextFileId?: string;
    cloudAudioFileId?: string;
    audioDriveId?: string;
    audioStatus?: string;
    audioSignature?: string;
    durationSec?: number;
    textLength?: number;
    wordCount?: number;
    isFavorite?: boolean;
    updatedAt?: number;
    content?: string | null;
    localPath?: string | null;
  }>
): Promise<{ books: number; chapters: number; texts: number }> {
  if (!isNative()) return { books: 0, chapters: 0, texts: 0 };

  let bookCount = 0;
  let chapterCount = 0;
  let textCount = 0;

  await ensureNativeBook(book);
  bookCount += 1;

  for (const ch of chapters) {
    await ensureNativeChapter(book.id, {
      id: ch.id,
      title: ch.title,
      idx: ch.index,
      sortOrder: ch.sortOrder,
      filename: ch.filename,
      sourceUrl: ch.sourceUrl,
      cloudTextFileId: ch.cloudTextFileId,
      cloudAudioFileId: ch.cloudAudioFileId,
      audioDriveId: ch.audioDriveId,
      audioStatus: ch.audioStatus,
      audioSignature: ch.audioSignature,
      durationSec: ch.durationSec,
      textLength: ch.textLength,
      wordCount: ch.wordCount,
      isFavorite: ch.isFavorite,
      updatedAt: ch.updatedAt,
    });
    chapterCount += 1;

    if (typeof ch.content !== "string" || ch.content.length === 0) {
      throw new Error(
        `Missing cached text for chapter "${ch.title || ch.id}". Open the chapter or re-import text first.`
      );
    }
    await ensureNativeChapterText(book.id, ch.id, ch.content, ch.localPath);
    textCount += 1;
  }

  return { books: bookCount, chapters: chapterCount, texts: textCount };
}

export async function getNativeChapterTextCount(chapterIds: string[]): Promise<number> {
  const conn = await getDb();
  if (!chapterIds.length) return 0;
  const placeholders = chapterIds.map(() => "?").join(",");
  const res = await conn.query(
    `SELECT COUNT(*) AS cnt FROM chapter_text WHERE chapterId IN (${placeholders})`,
    chapterIds
  );
  const row = (res.values?.[0] ?? null) as any;
  return Number(row?.cnt ?? 0);
}

export async function getNativeChapterTextInfo(
  chapterIds: string[]
): Promise<Record<string, { localPath?: string | null }>> {
  const conn = await getDb();
  const info: Record<string, { localPath?: string | null }> = {};
  if (!chapterIds.length) return info;
  const placeholders = chapterIds.map(() => "?").join(",");
  const res = await conn.query(
    `SELECT chapterId, localPath FROM chapter_text WHERE chapterId IN (${placeholders})`,
    chapterIds
  );
  const rows = (res.values ?? []) as any[];
  for (const row of rows) {
    const id = String(row.chapterId);
    info[id] = { localPath: row.localPath ?? null };
  }
  return info;
}

export async function hasNativeBook(bookId: string, driveFolderId?: string): Promise<boolean> {
  const conn = await getDb();
  const params = [bookId];
  let where = "id = ?";
  if (driveFolderId) {
    where += " OR driveFolderId = ?";
    params.push(driveFolderId);
  }
  const res = await conn.query(
    `SELECT id FROM books WHERE ${where} LIMIT 1`,
    params
  );
  return Array.isArray(res.values) && res.values.length > 0;
}
