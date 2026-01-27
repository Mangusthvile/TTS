// services/bookFolderInit.ts

import type { Book, Chapter } from "../types";
import type { FolderAdapter, FolderRef } from "./folderAdapter";
import { buildMp3Name, buildTextName } from "./driveService";
import { listChaptersPage } from "./libraryStore";
import type { BookManifest, InventoryManifest } from "./bookManifests";
import { safeParseJson } from "./bookManifests";

async function listAllChapterMeta(bookId: string): Promise<Chapter[]> {
  const out: Chapter[] = [];
  let after: number | null = null;

  for (;;) {
    const page = await listChaptersPage(bookId, after, 500);
    out.push(...page.chapters);

    if (page.nextAfterIndex == null) break;
    after = page.nextAfterIndex;
  }

  return out;
}

export async function initBookFolderManifests(args: {
  book: Book;
  rootFolderId: string;
  rootFolderName?: string;
  adapter: FolderAdapter;
}): Promise<{ bookManifest: BookManifest; inventory: InventoryManifest }> {
  const { book, rootFolderId, rootFolderName, adapter } = args;

  const root: FolderRef = {
    backend: adapter.backend,
    id: rootFolderId,
    name: rootFolderName ?? book.title
  };

  const metaFolder = await adapter.ensureFolder(root, "meta");

  const bookJsonFile = await adapter.findByName(metaFolder, "book.json");
  const invJsonFile = await adapter.findByName(metaFolder, "inventory.json");

  const defaultBookManifest: BookManifest = {
    schemaVersion: "3.0",
    bookId: book.id,
    title: book.title,
    createdAt: Date.now(),
    backend: book.backend === "drive" ? "drive" : "eternal",
    rootFolderId: rootFolderId,
    folders: {
      meta: "meta",
      text: "text",
      audio: "audio",
      trash: "trash"
    }
  };

  let bookManifest: BookManifest;
  if (bookJsonFile) {
    const raw = await adapter.readText(bookJsonFile);
    bookManifest = safeParseJson<BookManifest>(raw, defaultBookManifest);
  } else {
    bookManifest = defaultBookManifest;
    await adapter.writeText(metaFolder, "book.json", JSON.stringify(bookManifest, null, 2), null);
  }

  let inventory: InventoryManifest;
  if (invJsonFile) {
    const raw = await adapter.readText(invJsonFile);
    inventory = safeParseJson<InventoryManifest>(raw, {
      schemaVersion: "3.0",
      bookId: book.id,
      expectedTotal: 0,
      chapters: []
    });
  } else {
    const chapters = await listAllChapterMeta(book.id);

    inventory = {
      schemaVersion: "3.0",
      bookId: book.id,
      expectedTotal: chapters.length,
      chapters: chapters.map((c) => ({
        chapterId: c.id,
        idx: Number(c.index),
        title: String(c.title),
        textName: buildTextName(book.id, c.id),
        audioName: buildMp3Name(book.id, c.id)
      }))
    };

    await adapter.writeText(metaFolder, "inventory.json", JSON.stringify(inventory, null, 2), null);
  }

  return { bookManifest, inventory };
}
