import type { Chapter } from "../types";
import { listFoldersInFolder, resolveFolderIdByName } from "./driveService";

const folderIdCache = new Map<string, string>();

const SYSTEM_FOLDER_NAMES = new Set([
  "meta",
  "attachments",
  "trash",
  "text",
  "audio",
]);

function normalizeVolumeName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length ? trimmed : null;
}

function toCacheKey(bookFolderId: string, volumeName: string): string {
  return `${bookFolderId}::${volumeName.toLowerCase()}`;
}

export function getChapterVolumeFolderName(chapter: Pick<Chapter, "volumeName">): string | null {
  return normalizeVolumeName(chapter.volumeName);
}

export async function ensureChapterDriveStorageFolder(
  bookFolderId: string,
  chapter: Pick<Chapter, "volumeName">
): Promise<string> {
  const volumeName = getChapterVolumeFolderName(chapter);
  if (!volumeName) return bookFolderId;

  const key = toCacheKey(bookFolderId, volumeName);
  const cached = folderIdCache.get(key);
  if (cached) return cached;

  const { id } = await resolveFolderIdByName(bookFolderId, volumeName);
  folderIdCache.set(key, id);
  return id;
}

export async function findChapterDriveStorageFolder(
  bookFolderId: string,
  chapter: Pick<Chapter, "volumeName">
): Promise<string | null> {
  const volumeName = getChapterVolumeFolderName(chapter);
  if (!volumeName) return bookFolderId;

  const key = toCacheKey(bookFolderId, volumeName);
  const cached = folderIdCache.get(key);
  if (cached) return cached;

  const folders = await listFoldersInFolder(bookFolderId);
  const match = folders.find((folder) => folder.name.trim().toLowerCase() === volumeName.toLowerCase());
  if (!match) return null;

  folderIdCache.set(key, match.id);
  return match.id;
}

export async function listVolumeFolders(bookFolderId: string): Promise<Array<{ id: string; name: string }>> {
  const folders = await listFoldersInFolder(bookFolderId);
  return folders
    .filter((folder) => {
      const key = folder.name.trim().toLowerCase();
      return key.length > 0 && !SYSTEM_FOLDER_NAMES.has(key);
    })
    .map((folder) => ({ id: folder.id, name: folder.name.trim() || folder.name }));
}

export function clearChapterDriveFolderCache(bookFolderId?: string) {
  if (!bookFolderId) {
    folderIdCache.clear();
    return;
  }
  const prefix = `${bookFolderId}::`;
  for (const key of folderIdCache.keys()) {
    if (key.startsWith(prefix)) folderIdCache.delete(key);
  }
}
