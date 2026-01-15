// services/libraryStore.ts
/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Phase One. LibraryStore
 *
 * Goals:
 * - Store books and chapters without loading everything into React memory.
 * - Support paging for chapter lists (10,000+ chapters per book).
 * - Store chapter text separately so metadata lists stay light.
 *
 * Storage backends:
 * - Native (Capacitor Android): SQLite tables in talevox.db
 * - Web/Desktop: IndexedDB (services/libraryIdb.ts)
 */

import { Capacitor } from "@capacitor/core";
import { initStorage, getStorage } from "./storageSingleton";
import type { SQLiteDBConnection } from "@capacitor-community/sqlite";

import { HighlightMode, AudioStatus } from "../types";
import type { Book, Chapter, StorageBackend } from "../types";
import {
  idbListBooks,
  idbUpsertBook,
  idbDeleteBook,
  idbListChaptersPage,
  idbUpsertChapterMeta,
  idbDeleteChapter,
  idbSaveChapterText,
  idbLoadChapterText,
  idbBulkUpsertChapters,
  type ChapterPage,
} from "./libraryIdb";

export type { ChapterPage };

const DEFAULT_PAGE_SIZE = 200;

let initPromise: Promise<void> | null = null;

function isNative(): boolean {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

async function ensureInit(): Promise<void> {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    await initStorage();
  })();

  return initPromise;
}

function mustSqliteDb(): SQLiteDBConnection {
  const driver = getStorage();
  if (driver.name !== "sqlite") {
    throw new Error(`LibraryStore expected sqlite driver, got ${driver.name}`);
  }
  const anyDriver = driver as any;
  if (typeof anyDriver.getDb !== "function") {
    throw new Error("SqliteStorageDriver is missing getDb(). Apply Phase One changes to services/sqliteStorageDriver.ts");
  }
  return anyDriver.getDb() as SQLiteDBConnection;
}

function safeParseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function ensureBookDefaults(b: Partial<Book>): Book {
  return {
    id: b.id!,
    title: b.title ?? "Untitled",
    author: b.author,
    coverImage: b.coverImage,
    chapters: b.chapters ?? [],
    currentChapterId: b.currentChapterId,
    rules: b.rules ?? [],
    directoryHandle: undefined,
    driveFolderId: b.driveFolderId,
    driveFolderName: b.driveFolderName,
    backend: (b.backend ?? ("local" as StorageBackend)) as StorageBackend,
    settings:
      b.settings ?? {
        useBookSettings: false,
        highlightMode: HighlightMode.WORD,
      },
    updatedAt: b.updatedAt ?? Date.now(),
  };
}

export async function listBooks(): Promise<Book[]> {
  await ensureInit();

  if (!isNative()) {
    return idbListBooks();
  }

  const db = mustSqliteDb();
  const res = await db.query(
    `SELECT id, title, author, coverImage, backend, driveFolderId, driveFolderName, currentChapterId,
            settingsJson, rulesJson, updatedAt
     FROM books
     ORDER BY updatedAt DESC`,
    []
  );

  const rows = (res.values ?? []) as any[];
  return rows.map((r) =>
    ensureBookDefaults({
      id: String(r.id),
      title: String(r.title),
      author: r.author ?? undefined,
      coverImage: r.coverImage ?? undefined,
      backend: r.backend as StorageBackend,
      driveFolderId: r.driveFolderId ?? undefined,
      driveFolderName: r.driveFolderName ?? undefined,
      currentChapterId: r.currentChapterId ?? undefined,
      settings: safeParseJson(r.settingsJson, { useBookSettings: false, highlightMode: HighlightMode.WORD }),
      rules: safeParseJson(r.rulesJson, []),
      chapters: [],
      updatedAt: Number(r.updatedAt ?? Date.now()),
    })
  );
}

export async function upsertBook(book: Book): Promise<void> {
  await ensureInit();

  if (!isNative()) {
    await idbUpsertBook(book);
    return;
  }

  const db = mustSqliteDb();
  const now = Date.now();

  const settingsJson = JSON.stringify(book.settings ?? { useBookSettings: false, highlightMode: HighlightMode.WORD });
  const rulesJson = JSON.stringify(book.rules ?? []);

  await db.run(
    `INSERT INTO books (id, title, author, coverImage, backend, driveFolderId, driveFolderName, currentChapterId, settingsJson, rulesJson, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title,
       author = excluded.author,
       coverImage = excluded.coverImage,
       backend = excluded.backend,
       driveFolderId = excluded.driveFolderId,
       driveFolderName = excluded.driveFolderName,
       currentChapterId = excluded.currentChapterId,
       settingsJson = excluded.settingsJson,
       rulesJson = excluded.rulesJson,
       updatedAt = excluded.updatedAt`,
    [
      book.id,
      book.title,
      book.author ?? null,
      book.coverImage ?? null,
      book.backend,
      book.driveFolderId ?? null,
      book.driveFolderName ?? null,
      book.currentChapterId ?? null,
      settingsJson,
      rulesJson,
      book.updatedAt ?? now,
    ]
  );
}

export async function deleteBook(bookId: string): Promise<void> {
  await ensureInit();

  if (!isNative()) {
    await idbDeleteBook(bookId);
    return;
  }

  const db = mustSqliteDb();

  await db.run(`DELETE FROM chapters WHERE bookId = ?`, [bookId]);
  await db.run(`DELETE FROM chapter_text WHERE bookId = ?`, [bookId]);
  await db.run(`DELETE FROM books WHERE id = ?`, [bookId]);
}

export async function listChaptersPage(
  bookId: string,
  afterIndex: number = -1,
  limit: number = DEFAULT_PAGE_SIZE
): Promise<ChapterPage> {
  await ensureInit();

  if (!isNative()) {
    return idbListChaptersPage(bookId, afterIndex, limit);
  }

  const db = mustSqliteDb();

  const res = await db.query(
    `SELECT c.id, c.idx, c.title, c.filename, c.sourceUrl,
            c.cloudTextFileId, c.cloudAudioFileId, c.audioDriveId, c.audioStatus, c.audioSignature,
            c.durationSec, c.textLength, c.wordCount, c.isFavorite, c.updatedAt,
            p.timeSec AS progressSec, p.durationSec AS progressDurationSec, p.percent AS progressPercent, p.isComplete AS progressIsComplete
     FROM chapters c
     LEFT JOIN progress p ON p.chapterId = c.id
     WHERE c.bookId = ? AND c.idx > ?
     ORDER BY c.idx ASC
     LIMIT ?`,
    [bookId, afterIndex, limit]
  );

  const rows = (res.values ?? []) as any[];
  const chapters: Chapter[] = rows.map((r) => {
    const progressPercent = r.progressPercent != null ? Number(r.progressPercent) : 0;
    const isComplete = r.progressIsComplete === 1;

    return {
      id: String(r.id),
      index: Number(r.idx),
      title: String(r.title),
      sourceUrl: r.sourceUrl ?? undefined,
      filename: String(r.filename),
      content: undefined,
      wordCount: Number(r.wordCount ?? 0),
      progress: isComplete ? 1 : progressPercent,
      progressChars: 0,
      progressTotalLength: undefined,
      progressSec: r.progressSec != null ? Number(r.progressSec) : undefined,
      durationSec: r.durationSec != null ? Number(r.durationSec) : undefined,
      textLength: r.textLength != null ? Number(r.textLength) : undefined,
      isFavorite: r.isFavorite === 1,
      isCompleted: isComplete,
      cloudTextFileId: r.cloudTextFileId ?? undefined,
      cloudAudioFileId: r.cloudAudioFileId ?? undefined,
      audioDriveId: r.audioDriveId ?? undefined,
      audioStatus: (r.audioStatus as any) ?? AudioStatus.NONE,
      audioSignature: r.audioSignature ?? undefined,
      updatedAt: Number(r.updatedAt ?? Date.now()),
    };
  });

  const nextAfterIndex = chapters.length ? chapters[chapters.length - 1].index : null;
  return { chapters, nextAfterIndex };
}

export async function upsertChapterMeta(bookId: string, chapter: Chapter): Promise<void> {
  await ensureInit();

  if (!isNative()) {
    await idbUpsertChapterMeta(bookId, chapter);
    return;
  }

  const db = mustSqliteDb();
  const now = Date.now();

  await db.run(
    `INSERT INTO chapters (id, bookId, idx, title, filename, sourceUrl,
                           cloudTextFileId, cloudAudioFileId, audioDriveId, audioStatus, audioSignature,
                           durationSec, textLength, wordCount, isFavorite, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       bookId = excluded.bookId,
       idx = excluded.idx,
       title = excluded.title,
       filename = excluded.filename,
       sourceUrl = excluded.sourceUrl,
       cloudTextFileId = excluded.cloudTextFileId,
       cloudAudioFileId = excluded.cloudAudioFileId,
       audioDriveId = excluded.audioDriveId,
       audioStatus = excluded.audioStatus,
       audioSignature = excluded.audioSignature,
       durationSec = excluded.durationSec,
       textLength = excluded.textLength,
       wordCount = excluded.wordCount,
       isFavorite = excluded.isFavorite,
       updatedAt = excluded.updatedAt`,
    [
      chapter.id,
      bookId,
      chapter.index,
      chapter.title,
      chapter.filename,
      chapter.sourceUrl ?? null,
      chapter.cloudTextFileId ?? null,
      chapter.cloudAudioFileId ?? null,
      chapter.audioDriveId ?? null,
      chapter.audioStatus ?? AudioStatus.NONE,
      chapter.audioSignature ?? null,
      chapter.durationSec ?? null,
      chapter.textLength ?? null,
      chapter.wordCount ?? null,
      chapter.isFavorite ? 1 : 0,
      chapter.updatedAt ?? now,
    ]
  );
}

export async function deleteChapter(chapterId: string): Promise<void> {
  await ensureInit();

  if (!isNative()) {
    await idbDeleteChapter(chapterId);
    return;
  }

  const db = mustSqliteDb();
  await db.run(`DELETE FROM chapters WHERE id = ?`, [chapterId]);
  await db.run(`DELETE FROM chapter_text WHERE chapterId = ?`, [chapterId]);
}

export async function saveChapterText(bookId: string, chapterId: string, content: string): Promise<void> {
  await ensureInit();

  if (!isNative()) {
    await idbSaveChapterText(bookId, chapterId, content);
    return;
  }

  const db = mustSqliteDb();
  const now = Date.now();

  await db.run(
    `INSERT INTO chapter_text (chapterId, bookId, content, updatedAt)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(chapterId) DO UPDATE SET
       bookId = excluded.bookId,
       content = excluded.content,
       updatedAt = excluded.updatedAt`,
    [chapterId, bookId, content, now]
  );
}

export async function loadChapterText(chapterId: string): Promise<string | null> {
  await ensureInit();

  if (!isNative()) {
    return idbLoadChapterText(chapterId);
  }

  const db = mustSqliteDb();
  const res = await db.query(`SELECT content FROM chapter_text WHERE chapterId = ?`, [chapterId]);
  const row = (res.values?.[0] ?? null) as any;
  if (!row || row.content == null) return null;
  return String(row.content);
}

export async function bulkUpsertChapters(
  bookId: string,
  items: Array<{ chapter: Chapter; content?: string | null }>
): Promise<void> {
  await ensureInit();

  if (!isNative()) {
    await idbBulkUpsertChapters(bookId, items);
    return;
  }

  const db = mustSqliteDb();

  await db.execute("BEGIN TRANSACTION;");
  try {
    for (const it of items) {
      await upsertChapterMeta(bookId, it.chapter);
      if (typeof it.content === "string" && it.content.length) {
        await saveChapterText(bookId, it.chapter.id, it.content);
      }
    }
    await db.execute("COMMIT;");
  } catch (e) {
    await db.execute("ROLLBACK;");
    throw e;
  }
}
