// services/libraryStore.ts
/* eslint-disable @typescript-eslint/no-explicit-any */

import { Capacitor } from "@capacitor/core";
import { HighlightMode } from "../types";
import type { Book, Chapter, StorageBackend, AudioStatus, BookSettings, Rule } from "../types";
import { initStorage, getStorage } from "./storageSingleton";
import {
  listBooks as idbListBooks,
  upsertBook as idbUpsertBook,
  deleteBook as idbDeleteBook,
  upsertChapterMeta as idbUpsertChapterMeta,
  deleteChapter as idbDeleteChapter,
  saveChapterText as idbSaveChapterText,
  loadChapterText as idbLoadChapterText,
  listChaptersPage as idbListChaptersPage,
  bulkUpsertChapters as idbBulkUpsertChapters
} from "./libraryIdb";
import type { SQLiteDBConnection } from "@capacitor-community/sqlite";

let initPromise: Promise<void> | null = null;

function isNative(): boolean {
  try {
    return typeof window !== "undefined" && !!(window as any).Capacitor && Capacitor.isNativePlatform();
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

function safeParseJson<T>(jsonStr: any, fallback: T): T {
  try {
    if (jsonStr == null) return fallback;
    const parsed = JSON.parse(String(jsonStr));
    return (parsed ?? fallback) as T;
  } catch {
    return fallback;
  }
}

function ensureBookDefaults(b: Partial<Book> & { id: string; title: string; backend: StorageBackend }): Book {
  return {
    id: b.id,
    title: b.title,
    author: b.author,
    coverImage: b.coverImage,
    backend: b.backend,
    driveFolderId: b.driveFolderId,
    driveFolderName: b.driveFolderName,
    currentChapterId: b.currentChapterId,
    settings: b.settings ?? { useBookSettings: false, highlightMode: HighlightMode.WORD },
    rules: b.rules ?? [],
    chapters: b.chapters ?? [],
    chapterCount: (b as any).chapterCount ?? 0,
    directoryHandle: b.directoryHandle,
    updatedAt: b.updatedAt ?? Date.now(),
  };
}

function mustSqliteDb(): SQLiteDBConnection {
  const driver = getStorage();
  if ((driver as any).name !== "sqlite" || typeof (driver as any).getDb !== "function") {
    throw new Error("SQLite driver not available on this platform.");
  }
  return (driver as any).getDb() as SQLiteDBConnection;
}

export async function listBooks(): Promise<Book[]> {
  await ensureInit();

  if (!isNative()) {
    return idbListBooks();
  }

  const db = mustSqliteDb();
  const res = await db.query(
    `SELECT b.id, b.title, b.author, b.coverImage, b.backend, b.driveFolderId, b.driveFolderName, b.currentChapterId,
            b.settingsJson, b.rulesJson, b.updatedAt,
            IFNULL(cnt.chapterCount, 0) AS chapterCount
     FROM books b
     LEFT JOIN (
       SELECT bookId, COUNT(*) AS chapterCount
       FROM chapters
       GROUP BY bookId
     ) cnt ON cnt.bookId = b.id
     ORDER BY b.updatedAt DESC`,
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
      chapterCount: Number(r.chapterCount ?? 0),
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
  const settingsJson = JSON.stringify(book.settings ?? { useBookSettings: false, highlightMode: HighlightMode.WORD });
  const rulesJson = JSON.stringify(book.rules ?? []);
  const updatedAt = book.updatedAt ?? Date.now();

  await db.run(
    `INSERT INTO books (id, title, author, coverImage, backend, driveFolderId, driveFolderName, currentChapterId, settingsJson, rulesJson, updatedAt)
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
      book.backend,
      book.driveFolderId ?? null,
      book.driveFolderName ?? null,
      book.currentChapterId ?? null,
      settingsJson,
      rulesJson,
      updatedAt,
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
  await db.run(`DELETE FROM chapter_text WHERE bookId = ?`, [bookId]);
  await db.run(`DELETE FROM chapters WHERE bookId = ?`, [bookId]);
  await db.run(`DELETE FROM books WHERE id = ?`, [bookId]);
}

export async function upsertChapterMeta(bookId: string, chapter: Chapter): Promise<void> {
  await ensureInit();

  if (!isNative()) {
    await idbUpsertChapterMeta(bookId, chapter);
    return;
  }

  const db = mustSqliteDb();
  const updatedAt = chapter.updatedAt ?? Date.now();

  await db.run(
    `INSERT INTO chapters (
       id, bookId, idx, title, filename, sourceUrl,
       cloudTextFileId, cloudAudioFileId, audioDriveId,
       audioStatus, audioSignature, durationSec, textLength, wordCount, isFavorite, updatedAt
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       bookId=excluded.bookId,
       idx=excluded.idx,
       title=excluded.title,
       filename=excluded.filename,
       sourceUrl=excluded.sourceUrl,
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
      chapter.index,
      chapter.title,
      chapter.filename,
      chapter.sourceUrl ?? null,
      chapter.cloudTextFileId ?? null,
      chapter.cloudAudioFileId ?? null,
      (chapter as any).audioDriveId ?? null,
      (chapter.audioStatus ?? ("none" as any)) as AudioStatus,
      (chapter as any).audioSignature ?? null,
      (chapter as any).durationSec ?? null,
      chapter.textLength ?? null,
      (chapter as any).wordCount ?? null,
      chapter.isFavorite ? 1 : 0,
      updatedAt,
    ]
  );
}

export async function deleteChapter(bookId: string, chapterId: string): Promise<void> {
  await ensureInit();

  if (!isNative()) {
    await idbDeleteChapter(bookId, chapterId);
    return;
  }

  const db = mustSqliteDb();
  await db.run(`DELETE FROM chapter_text WHERE chapterId = ?`, [chapterId]);
  await db.run(`DELETE FROM chapters WHERE id = ? AND bookId = ?`, [chapterId, bookId]);
}

export async function saveChapterText(bookId: string, chapterId: string, content: string): Promise<void> {
  await ensureInit();

  if (!isNative()) {
    await idbSaveChapterText(bookId, chapterId, content);
    return;
  }

  const db = mustSqliteDb();
  await db.run(
    `INSERT INTO chapter_text (chapterId, bookId, content, updatedAt)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(chapterId) DO UPDATE SET
       content=excluded.content,
       updatedAt=excluded.updatedAt`,
    [chapterId, bookId, content, Date.now()]
  );
}

export async function loadChapterText(bookId: string, chapterId: string): Promise<string | null> {
  await ensureInit();

  if (!isNative()) {
    return idbLoadChapterText(bookId, chapterId);
  }

  const db = mustSqliteDb();

  // First try the correct lookup
  const res = await db.query(
    `SELECT content FROM chapter_text WHERE chapterId = ? AND bookId = ?`,
    [chapterId, bookId]
  );
  const row = (res.values?.[0] ?? null) as any;
  if (row) return String(row.content ?? "");

  // Fallback lookup by chapterId only.
  // This repairs older rows that were saved under the wrong bookId.
  const res2 = await db.query(
    `SELECT bookId, content FROM chapter_text WHERE chapterId = ? LIMIT 1`,
    [chapterId]
  );
  const row2 = (res2.values?.[0] ?? null) as any;
  if (!row2) return null;

  const content = String(row2.content ?? "");

  try {
    await db.run(`UPDATE chapter_text SET bookId = ? WHERE chapterId = ?`, [bookId, chapterId]);
  } catch {
    // ignore repair failure
  }

  return content;
}

export async function listChaptersPage(
  bookId: string,
  afterIndex: number | null,
  limit: number
): Promise<{ chapters: Chapter[]; nextAfterIndex: number | null }> {
  await ensureInit();

  if (!isNative()) {
    return idbListChaptersPage(bookId, afterIndex, limit);
  }

  const db = mustSqliteDb();
  const params: any[] = [bookId];

  let where = `WHERE bookId = ?`;
  if (afterIndex != null) {
    where += ` AND idx > ?`;
    params.push(afterIndex);
  }

  params.push(limit);

  const res = await db.query(
    `SELECT id, idx as "index", title, filename, sourceUrl,
            cloudTextFileId, cloudAudioFileId, audioDriveId,
            audioStatus, audioSignature, durationSec, textLength, wordCount, isFavorite, updatedAt
     FROM chapters
     ${where}
     ORDER BY idx ASC
     LIMIT ?`,
    params
  );

  const rows = (res.values ?? []) as any[];

  const chapters: Chapter[] = rows.map((r) => ({
    id: String(r.id),
    index: Number(r.index ?? r.idx),
    title: String(r.title),
    filename: String(r.filename),
    sourceUrl: r.sourceUrl ?? undefined,
    content: undefined,

    wordCount: Number(r.wordCount ?? 0),
    progress: 0,
    progressChars: 0,
    progressSec: r.progressSec != null ? Number(r.progressSec) : undefined,
    durationSec: r.durationSec != null ? Number(r.durationSec) : undefined,
    textLength: r.textLength != null ? Number(r.textLength) : undefined,

    isFavorite: r.isFavorite === 1 || r.isFavorite === true,
    updatedAt: Number(r.updatedAt ?? Date.now()),

    cloudTextFileId: r.cloudTextFileId ?? undefined,
    cloudAudioFileId: r.cloudAudioFileId ?? undefined,
    audioDriveId: r.audioDriveId ?? undefined,
    audioStatus: r.audioStatus ?? undefined,
    audioSignature: r.audioSignature ?? undefined,
  }));

  const nextAfterIndex = chapters.length ? chapters[chapters.length - 1].index : null;

  return {
    chapters,
    nextAfterIndex: chapters.length < limit ? null : nextAfterIndex,
  };
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

  for (const it of items) {
    await upsertChapterMeta(bookId, it.chapter);
    if (typeof it.content === "string" && it.content.length) {
      await saveChapterText(bookId, it.chapter.id, it.content);
    }
  }
}