/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * IndexedDB backed library storage for web and desktop builds.
 *
 * Stores:
 * books (key: id)
 * chapters (key: id, index: byBookIndex, bookId_index, byBookId)
 * chapter_text (key: chapterId, index: byBookId)
 *
 * Notes:
 * 1) This file exports both plain names and idb prefixed aliases.
 *    This prevents import naming drift from breaking builds.
 * 2) Chapter objects returned from paging include required defaults:
 *    wordCount, progress, progressChars.
 */

import { HighlightMode } from "../types";
import type { Book, Chapter, StorageBackend, AudioStatus, BookSettings, Rule } from "../types";

const DB_NAME = "TalevoxLibrary";
const DB_VERSION = 2;

const STORE_BOOKS = "books";
const STORE_CHAPTERS = "chapters";
const STORE_CHAPTER_TEXT = "chapter_text";

export type ChapterPage = {
  chapters: Chapter[];
  nextAfterIndex: number | null;
  totalCount?: number;
};

type BookRow = {
  id: string;
  title: string;
  author?: string;
  coverImage?: string;
  backend: StorageBackend;
  driveFolderId?: string;
  driveFolderName?: string;
  currentChapterId?: string;
  settings?: BookSettings;
  rules?: Rule[];
  chapterCount?: number;
  updatedAt: number;
};

type ChapterRow = {
  id: string;
  bookId: string;
  idx: number;
  title: string;
  filename: string;
  sourceUrl?: string;

  cloudTextFileId?: string;
  cloudAudioFileId?: string;

  audioDriveId?: string;
  audioStatus?: AudioStatus;
  audioSignature?: string;

  durationSec?: number;
  textLength?: number;
  wordCount?: number;
  isFavorite?: boolean;

  updatedAt: number;
};

type ChapterTextRow = {
  chapterId: string;
  bookId: string;
  content: string;
  updatedAt: number;
};

let dbPromise: Promise<IDBDatabase> | null = null;

function ensureIndexedDbAvailable(): void {
  if (typeof indexedDB === "undefined") {
    throw new Error("IndexedDB is not available in this environment.");
  }
}

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  ensureIndexedDbAvailable();

  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = () => {
      const db = req.result;

      if (!db.objectStoreNames.contains(STORE_BOOKS)) {
        db.createObjectStore(STORE_BOOKS, { keyPath: "id" });
      }

      if (!db.objectStoreNames.contains(STORE_CHAPTERS)) {
        const s = db.createObjectStore(STORE_CHAPTERS, { keyPath: "id" });
        s.createIndex("byBookId", "bookId", { unique: false });
        s.createIndex("byBookIndex", ["bookId", "idx"], { unique: false });
        s.createIndex("bookId_index", ["bookId", "idx"], { unique: false });
      } else {
        const s = req.transaction!.objectStore(STORE_CHAPTERS);
        if (!s.indexNames.contains("byBookId")) s.createIndex("byBookId", "bookId", { unique: false });
        if (!s.indexNames.contains("byBookIndex")) s.createIndex("byBookIndex", ["bookId", "idx"], { unique: false });
        if (!s.indexNames.contains("bookId_index")) s.createIndex("bookId_index", ["bookId", "idx"], { unique: false });
      }

      if (!db.objectStoreNames.contains(STORE_CHAPTER_TEXT)) {
        const s = db.createObjectStore(STORE_CHAPTER_TEXT, { keyPath: "chapterId" });
        s.createIndex("byBookId", "bookId", { unique: false });
      } else {
        const s = req.transaction!.objectStore(STORE_CHAPTER_TEXT);
        if (!s.indexNames.contains("byBookId")) s.createIndex("byBookId", "bookId", { unique: false });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  return dbPromise;
}

function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function toBook(row: BookRow): Book {
  return {
    id: row.id,
    title: row.title,
    author: row.author,
    coverImage: row.coverImage,
    backend: row.backend,
    driveFolderId: row.driveFolderId,
    driveFolderName: row.driveFolderName,
    currentChapterId: row.currentChapterId,
    settings: row.settings ?? { useBookSettings: false, highlightMode: HighlightMode.WORD },
    rules: row.rules ?? [],
    chapters: [],
    chapterCount: row.chapterCount ?? 0,
    updatedAt: row.updatedAt ?? Date.now(),
  };
}

function toChapter(row: ChapterRow): Chapter {
  return {
    id: row.id,
    index: row.idx,
    title: row.title,
    filename: row.filename,
    sourceUrl: row.sourceUrl,
    content: undefined,

    wordCount: row.wordCount ?? 0,
    progress: 0,
    progressChars: 0,

    progressSec: undefined,
    durationSec: row.durationSec,
    textLength: row.textLength,
    isFavorite: row.isFavorite,

    cloudTextFileId: row.cloudTextFileId,
    cloudAudioFileId: row.cloudAudioFileId,
    audioDriveId: row.audioDriveId,
    audioStatus: row.audioStatus,
    audioSignature: row.audioSignature,

    updatedAt: row.updatedAt,
  } as any;
}

export async function listBooks(): Promise<Book[]> {
  const db = await openDb();
  const tx = db.transaction([STORE_BOOKS], "readonly");
  const store = tx.objectStore(STORE_BOOKS);

  const rows = (await reqToPromise(store.getAll())) as BookRow[];
  await txDone(tx);

  rows.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  return rows.map(toBook);
}

export async function upsertBook(book: Book): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([STORE_BOOKS], "readwrite");
  const store = tx.objectStore(STORE_BOOKS);

  const existing = (await reqToPromise(store.get(book.id))) as BookRow | undefined;

  const row: BookRow = {
    id: book.id,
    title: book.title,
    author: book.author,
    coverImage: book.coverImage,
    backend: book.backend,
    driveFolderId: book.driveFolderId,
    driveFolderName: book.driveFolderName,
    currentChapterId: book.currentChapterId,
    settings: book.settings ?? { useBookSettings: false, highlightMode: HighlightMode.WORD },
    rules: book.rules ?? [],
    chapterCount: book.chapterCount ?? existing?.chapterCount ?? book.chapters?.length ?? 0,
    updatedAt: book.updatedAt ?? Date.now(),
  };

  store.put(row);
  await txDone(tx);
}

export async function deleteBook(bookId: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([STORE_BOOKS, STORE_CHAPTERS, STORE_CHAPTER_TEXT], "readwrite");

  const sBooks = tx.objectStore(STORE_BOOKS);
  const sCh = tx.objectStore(STORE_CHAPTERS);
  const sTxt = tx.objectStore(STORE_CHAPTER_TEXT);

  sBooks.delete(bookId);

  const chIdx = sCh.index("byBookId");
  const chKeys = (await reqToPromise(chIdx.getAllKeys(IDBKeyRange.only(bookId)))) as any[];
  for (const k of chKeys) sCh.delete(k);

  const txtIdx = sTxt.index("byBookId");
  const txtKeys = (await reqToPromise(txtIdx.getAllKeys(IDBKeyRange.only(bookId)))) as any[];
  for (const k of txtKeys) sTxt.delete(k);

  await txDone(tx);
}

export async function upsertChapterMeta(bookId: string, chapter: Chapter): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([STORE_BOOKS, STORE_CHAPTERS], "readwrite");

  const sBooks = tx.objectStore(STORE_BOOKS);
  const sCh = tx.objectStore(STORE_CHAPTERS);

  const existingChapter = (await reqToPromise(sCh.get(chapter.id) as any)) as ChapterRow | undefined;
  const isNewChapter = !existingChapter;

  const row: ChapterRow = {
    id: chapter.id,
    bookId,
    idx: chapter.index,
    title: chapter.title,
    filename: chapter.filename,
    sourceUrl: chapter.sourceUrl,

    cloudTextFileId: (chapter as any).cloudTextFileId,
    cloudAudioFileId: (chapter as any).cloudAudioFileId,

    audioDriveId: (chapter as any).audioDriveId,
    audioStatus: (chapter as any).audioStatus,
    audioSignature: (chapter as any).audioSignature,

    durationSec: (chapter as any).durationSec,
    textLength: (chapter as any).textLength,
    wordCount: (chapter as any).wordCount ?? chapter.wordCount ?? 0,
    isFavorite: (chapter as any).isFavorite,

    updatedAt: (chapter as any).updatedAt ?? Date.now(),
  };

  sCh.put(row);

  try {
    const bookRow = (await reqToPromise(sBooks.get(bookId))) as BookRow | undefined;
    if (bookRow) {
      const prev = Number(bookRow.chapterCount ?? 0);
      bookRow.chapterCount = isNewChapter ? prev + 1 : prev;
      bookRow.updatedAt = Date.now();
      sBooks.put(bookRow);
    }
  } catch {
    // ignore
  }

  await txDone(tx);
}

export async function deleteChapter(bookId: string, chapterId: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([STORE_CHAPTERS, STORE_CHAPTER_TEXT], "readwrite");

  tx.objectStore(STORE_CHAPTERS).delete(chapterId);
  tx.objectStore(STORE_CHAPTER_TEXT).delete(chapterId);

  await txDone(tx);
}

export async function saveChapterText(bookId: string, chapterId: string, content: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([STORE_CHAPTER_TEXT], "readwrite");
  const store = tx.objectStore(STORE_CHAPTER_TEXT);

  const row: ChapterTextRow = {
    chapterId,
    bookId,
    content,
    updatedAt: Date.now(),
  };

  store.put(row);
  await txDone(tx);
}

// services/libraryIdb.ts
export async function loadChapterText(bookId: string, chapterId: string): Promise<string | null> {
  const db = await openDb();
  const tx = db.transaction([STORE_CHAPTER_TEXT], "readwrite");
  const store = tx.objectStore(STORE_CHAPTER_TEXT);

  const row = (await reqToPromise(store.get(chapterId))) as ChapterTextRow | undefined;

  if (!row) {
    await txDone(tx);
    return null;
  }

  // If the bookId mismatches, repair it. ChapterId is globally unique.
  if (row.bookId !== bookId) {
    try {
      store.put({ ...row, bookId, updatedAt: Date.now() });
    } catch {
      // ignore
    }
  }

  await txDone(tx);
  return row.content ?? "";
}

export async function listChaptersPage(
  bookId: string,
  afterIndex: number | null,
  limit: number
): Promise<ChapterPage> {
  const db = await openDb();
  const tx = db.transaction([STORE_CHAPTERS], "readonly");
  const store = tx.objectStore(STORE_CHAPTERS);

  const idx =
    store.indexNames.contains("byBookIndex")
      ? store.index("byBookIndex")
      : store.index("bookId_index");

  const start = (afterIndex ?? -1) + 1;
  const range = IDBKeyRange.bound([bookId, start], [bookId, Number.MAX_SAFE_INTEGER]);

  const chapters: Chapter[] = [];
  let totalCount: number | undefined;

  await new Promise<void>((resolve, reject) => {
    const req = idx.openCursor(range, "next");
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return resolve();

      if (chapters.length >= limit) return resolve();

      const row = cursor.value as ChapterRow;
      chapters.push(toChapter(row));

      cursor.continue();
    };
  });

  try {
    const countIdx = store.index("byBookId");
    totalCount = Number(await reqToPromise(countIdx.count(IDBKeyRange.only(bookId))));
  } catch {
    totalCount = undefined;
  }

  await txDone(tx);

  const nextAfterIndex = chapters.length ? chapters[chapters.length - 1].index : null;
  return {
    chapters,
    nextAfterIndex: chapters.length < limit ? null : nextAfterIndex,
    totalCount,
  };
}

export async function bulkUpsertChapters(
  bookId: string,
  items: Array<{ chapter: Chapter; content?: string | null }>
): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([STORE_BOOKS, STORE_CHAPTERS, STORE_CHAPTER_TEXT], "readwrite");

  const sBooks = tx.objectStore(STORE_BOOKS);
  const sCh = tx.objectStore(STORE_CHAPTERS);
  const sTxt = tx.objectStore(STORE_CHAPTER_TEXT);

  let newCount = 0;

  for (const it of items) {
    const c = it.chapter;

    const existing = (await reqToPromise(sCh.get(c.id))) as ChapterRow | undefined;
    if (!existing) newCount += 1;

    const row: ChapterRow = {
      id: c.id,
      bookId,
      idx: c.index,
      title: c.title,
      filename: c.filename,
      sourceUrl: c.sourceUrl,

      cloudTextFileId: (c as any).cloudTextFileId,
      cloudAudioFileId: (c as any).cloudAudioFileId,

      audioDriveId: (c as any).audioDriveId,
      audioStatus: (c as any).audioStatus,
      audioSignature: (c as any).audioSignature,

      durationSec: (c as any).durationSec,
      textLength: (c as any).textLength,
      wordCount: (c as any).wordCount ?? c.wordCount ?? 0,
      isFavorite: (c as any).isFavorite,

      updatedAt: (c as any).updatedAt ?? Date.now(),
    };

    sCh.put(row);

    if (typeof it.content === "string" && it.content.length) {
      const txtRow: ChapterTextRow = {
        chapterId: c.id,
        bookId,
        content: it.content,
        updatedAt: Date.now(),
      };
      sTxt.put(txtRow);
    }
  }

  try {
    const bookRow = (await reqToPromise(sBooks.get(bookId))) as BookRow | undefined;
    if (bookRow) {
      const prev = Number(bookRow.chapterCount ?? 0);
      bookRow.chapterCount = prev + newCount;
      bookRow.updatedAt = Date.now();
      sBooks.put(bookRow);
    }
  } catch {
    // ignore
  }

  await txDone(tx);
}

/**
 * Export aliases to prevent naming drift.
 * These match the earlier Phase One naming.
 */
export const idbListBooks = listBooks;
export const idbUpsertBook = upsertBook;
export const idbDeleteBook = deleteBook;
export const idbUpsertChapterMeta = upsertChapterMeta;
export const idbDeleteChapter = deleteChapter;
export const idbSaveChapterText = saveChapterText;
export const idbLoadChapterText = loadChapterText;
export const idbListChaptersPage = listChaptersPage;
export const idbBulkUpsertChapters = bulkUpsertChapters;
