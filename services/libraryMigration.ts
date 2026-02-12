// services/libraryMigration.ts
/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * One-time migration from legacy localStorage state (talevox_pro_v2)
 * into the Phase One LibraryStore tables.
 */

import { Capacitor } from "@capacitor/core";
import { HighlightMode } from "../types";
import type { Book, Chapter } from "../types";
import { listBooks, upsertBook, bulkUpsertChapters } from "./libraryStore";

const LEGACY_KEY = "talevox_pro_v2";
const MIGRATED_KEY = "talevox_library_migrated_v3";

function safeParse(raw: string | null): any | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function isNative(): boolean {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

export async function migrateLegacyLocalStorageIfNeeded(): Promise<{ migrated: boolean; reason: string }> {
  const already = localStorage.getItem(MIGRATED_KEY) === "1";
  if (already) return { migrated: false, reason: "already_marked" };

  const existing = await listBooks();
  if (existing.length > 0) {
    localStorage.setItem(MIGRATED_KEY, "1");
    return { migrated: false, reason: "store_nonempty" };
  }

  const parsed = safeParse(localStorage.getItem(LEGACY_KEY));
  if (!parsed || !Array.isArray(parsed.books) || parsed.books.length === 0) {
    localStorage.setItem(MIGRATED_KEY, "1");
    return { migrated: false, reason: "no_legacy_data" };
  }

  const legacyBooks = parsed.books as any[];

  for (const b of legacyBooks) {
    const book: Book = {
      id: String(b.id),
      title: String(b.title ?? "Untitled"),
      author: b.author ?? undefined,
      coverImage: b.coverImage ?? undefined,
      chapters: [],
      currentChapterId: b.currentChapterId ?? undefined,
      rules: Array.isArray(b.rules) ? b.rules : [],
      directoryHandle: undefined,
      driveFolderId: b.driveFolderId ?? undefined,
      driveFolderName: b.driveFolderName ?? undefined,
      backend: b.backend ?? "local",
      settings:
        b.settings ?? { useBookSettings: false, highlightMode: HighlightMode.SENTENCE, autoGenerateAudioOnAdd: true },
      updatedAt: Number(b.updatedAt ?? Date.now()),
    } as any;

    await upsertBook(book);

    const chapters = Array.isArray(b.chapters) ? (b.chapters as any[]) : [];
    const items: Array<{ chapter: Chapter; content?: string | null }> = chapters.map((c) => {
      const chapter: Chapter = {
        id: String(c.id),
        index: Number(c.index ?? 0),
        title: String(c.title ?? `Chapter ${c.index ?? 0}`),
        sourceUrl: c.sourceUrl ?? undefined,
        filename: String(c.filename ?? `chapter-${c.index ?? 0}.txt`),
        content: undefined,
        wordCount: Number(c.wordCount ?? 0),
        progress: Number(c.progress ?? 0),
        progressChars: Number(c.progressChars ?? 0),
        progressTotalLength: c.progressTotalLength ?? undefined,
        progressSec: c.progressSec ?? undefined,
        durationSec: c.durationSec ?? undefined,
        textLength: c.textLength ?? undefined,
        isFavorite: c.isFavorite ?? undefined,
        isCompleted: c.isCompleted ?? undefined,
        cloudTextFileId: c.cloudTextFileId ?? undefined,
        cloudAudioFileId: c.cloudAudioFileId ?? undefined,
        audioDriveId: c.audioDriveId ?? undefined,
        audioStatus: c.audioStatus ?? undefined,
        audioSignature: c.audioSignature ?? undefined,
        audioIntroDurSec: c.audioIntroDurSec ?? undefined,
        audioChunkMap: c.audioChunkMap ?? undefined,
        hasCachedAudio: c.hasCachedAudio ?? undefined,
        hasTextOnDrive: c.hasTextOnDrive ?? undefined,
        updatedAt: Number(c.updatedAt ?? Date.now()),
      } as any;

      const content = typeof c.content === "string" && c.content.length ? c.content : null;
      return { chapter, content };
    });

    if (items.length) {
      await bulkUpsertChapters(book.id, items);
    }
  }

  localStorage.setItem(MIGRATED_KEY, "1");

  if (isNative()) {
    try {
      localStorage.removeItem(LEGACY_KEY);
    } catch {}
  }

  return { migrated: true, reason: "migrated" };
}
