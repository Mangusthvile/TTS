// services/libraryIdb.ts
/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * IndexedDB-backed library storage for web/desktop builds.
 *
 * Tables:
 * - books (key: id)
 * - chapters (key: id, index: ["bookId","index"])
 * - chapter_text (key: chapterId, index: bookId)
 */

import { HighlightMode } from "../types";
import type { Book, Chapter, StorageBackend, AudioStatus, BookSettings, Rule } from "../types";

const DB_NAME = "TalevoxLibrary";
const DB_VERSION = 1;

const STORE_BOOKS = "books";
const STORE_CHAPTERS = "chapters";
const STORE_CHAPTER_TEXT = "chapter_text";

export type ChapterPage = { chapters: Chapter[]; nextAfterIndex: number | null };

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
  updatedAt: number;
};

type ChapterRow = {
  id: string;
  bookId: string;
  index: number;
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

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = () => {
      const db = req.result;

      if (!db.objectStoreNames.contains(STORE_BOOKS)) {
        db.createObjectStore(STORE_BOOKS, { keyPath: "id" });
      }

      if (!db.objectStoreNames.contains(STORE_CHAPTERS)) {
        const store = db.createObjectStore(STORE_CHAPTERS, { keyPath: "id" });
        store.createIndex("bookId_index", ["bookId", "index"], { unique: false });
        store.createIndex("bookId", "bookId", { unique: false });
      }

      if (!db.objectStoreNames.contains(STORE_CHAPTER_TEXT)) {
        const store = db.createObjectStore(STORE_CHAPTER_TEXT, { keyPath: "chapterId" });
        store.createIndex("bookId", "bookId", { unique: false });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  return dbPromise;
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function idbListBooks(): Promise<Book[]> {
  const db = await openDb();
  const tx = db.transaction([STORE_BOOKS], "readonly");
  const store = tx.objectStore(STORE_BOOKS);
  const rows = (await reqToPromise(store.getAll())) as BookRow[];
  await txDone(tx);

  return rows
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    .map((r) => ({
      id: r.id,
      title: r.title,
      author: r.author,
      coverImage: r.coverImage,
      chapters: [],
      currentChapterId: r.currentChapterId,
      rules: r.rules ?? [],
      directoryHandle: undefined,
      driveFolderId: r.driveFolderId,
      driveFolderName: r.driveFolderName,
      backend: r.backend,
      settings: r.settings ?? { useBookSettings: false, highlightMode: HighlightMode.WORD },
      updatedAt: r.updatedAt,
    }));
}

export async function idbUpsertBook(book: Book): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([STORE_BOOKS], "readwrite");
  const store = tx.objectStore(STORE_BOOKS);

  const row: BookRow = {
    id: book.id,
    title: book.title,
    author: book.author,
    coverImage: book.coverImage,
    backend: book.backend,
    driveFolderId: book.driveFolderId,
    driveFolderName: book.driveFolderName,
    currentChapterId: book.currentChapterId,
    settings: book.settings,
    rules: book.rules ?? [],
    updatedAt: book.updatedAt ?? Date.now(),
  };

  store.put(row);
  await txDone(tx);
}

export async function idbDeleteBook(bookId: string): Promise<void> {
  const db = await openDb();

  {
    const tx = db.transaction([STORE_BOOKS], "readwrite");
    tx.objectStore(STORE_BOOKS).delete(bookId);
    await txDone(tx);
  }

  const chapters = await idbListAllChaptersForBook(bookId);
  const chapterIds = chapters.map((c) => c.id);

  if (chapterIds.length) {
    const tx = db.transaction([STORE_CHAPTERS, STORE_CHAPTER_TEXT], "readwrite");
    const sCh = tx.objectStore(STORE_CHAPTERS);
    const sTxt = tx.objectStore(STORE_CHAPTER_TEXT);
    for (const id of chapterIds) sCh.delete(id);
    for (const id of chapterIds) sTxt.delete(id);
    await txDone(tx);
  }
}

async function idbListAllChaptersForBook(bookId: string): Promise<ChapterRow[]> {
  const db = await openDb();
  const tx = db.transaction([STORE_CHAPTERS], "readonly");
  const store = tx.objectStore(STORE_CHAPTERS);
  const idx = store.index("bookId");
  const rows = (await reqToPromise(idx.getAll(IDBKeyRange.only(bookId)))) as ChapterRow[];
  await txDone(tx);
  return rows;
}

export async function idbListChaptersPage(bookId: string, afterIndex: number, limit: number): Promise<ChapterPage> {
  const db = await openDb();
  const tx = db.transaction([STORE_CHAPTERS], "readonly");
  const store = tx.objectStore(STORE_CHAPTERS);
  const idx = store.index("bookId_index");

  const lower = IDBKeyRange.lowerBound([bookId, afterIndex + 1]);
  const chapters: Chapter[] = [];

  await new Promise<void>((resolve, reject) => {
    const req = idx.openCursor(lower, "next");
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return resolve();

      const row = cursor.value as ChapterRow;
      if (row.bookId !== bookId) return resolve();

      chapters.push({
        id: row.id,
        index: row.index,
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
      });

      if (chapters.length >= limit) return resolve();
      cursor.continue();
    };
  });

  await txDone(tx);

  const nextAfterIndex = chapters.length ? chapters[chapters.length - 1].index : null;
  return { chapters, nextAfterIndex };
}

export async function idbUpsertChapterMeta(bookId: string, chapter: Chapter): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([STORE_CHAPTERS], "readwrite");
  const store = tx.objectStore(STORE_CHAPTERS);

  const row: ChapterRow = {
    id: chapter.id,
    bookId,
    index: chapter.index,
    title: chapter.title,
    filename: chapter.filename,
    sourceUrl: chapter.sourceUrl,
    cloudTextFileId: chapter.cloudTextFileId,
    cloudAudioFileId: chapter.cloudAudioFileId,
    audioDriveId: chapter.audioDriveId,
    audioStatus: chapter.audioStatus,
    audioSignature: chapter.audioSignature,
    durationSec: chapter.durationSec,
    textLength: chapter.textLength,
    wordCount: chapter.wordCount,
    isFavorite: chapter.isFavorite,
    updatedAt: chapter.updatedAt ?? Date.now(),
  };

  store.put(row);
  await txDone(tx);
}

export async function idbDeleteChapter(chapterId: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([STORE_CHAPTERS, STORE_CHAPTER_TEXT], "readwrite");
  tx.objectStore(STORE_CHAPTERS).delete(chapterId);
  tx.objectStore(STORE_CHAPTER_TEXT).delete(chapterId);
  await txDone(tx);
}

export async function idbSaveChapterText(bookId: string, chapterId: string, content: string): Promise<void> {
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

export async function idbLoadChapterText(chapterId: string): Promise<string | null> {
  const db = await openDb();
  const tx = db.transaction([STORE_CHAPTER_TEXT], "readonly");
  const store = tx.objectStore(STORE_CHAPTER_TEXT);
  const row = (await reqToPromise(store.get(chapterId))) as ChapterTextRow | undefined;
  await txDone(tx);
  return row?.content ?? null;
}

export async function idbBulkUpsertChapters(
  bookId: string,
  items: Array<{ chapter: Chapter; content?: string | null }>
): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([STORE_CHAPTERS, STORE_CHAPTER_TEXT], "readwrite");
  const sCh = tx.objectStore(STORE_CHAPTERS);
  const sTxt = tx.objectStore(STORE_CHAPTER_TEXT);

  for (const it of items) {
    const c = it.chapter;
    const row: ChapterRow = {
      id: c.id,
      bookId,
      index: c.index,
      title: c.title,
      filename: c.filename,
      sourceUrl: c.sourceUrl,
      cloudTextFileId: c.cloudTextFileId,
      cloudAudioFileId: c.cloudAudioFileId,
      audioDriveId: c.audioDriveId,
      audioStatus: c.audioStatus,
      audioSignature: c.audioSignature,
      durationSec: c.durationSec,
      textLength: c.textLength,
      wordCount: c.wordCount,
      isFavorite: c.isFavorite,
      updatedAt: c.updatedAt ?? Date.now(),
    };
    sCh.put(row);

    if (typeof it.content === "string" && it.content.length) {
      const txtRow: ChapterTextRow = { chapterId: c.id, bookId, content: it.content, updatedAt: Date.now() };
      sTxt.put(txtRow);
    }
  }

  await txDone(tx);
}
