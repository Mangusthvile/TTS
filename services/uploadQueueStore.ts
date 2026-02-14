import { initStorage, getStorage } from "./storageSingleton";
import type { DriveUploadQueuedItem } from "./storageDriver";

export type UploadSource = "audio" | "backup" | "fix";

const ensureDefaults = (item: DriveUploadQueuedItem): DriveUploadQueuedItem => {
  const now = Date.now();
  return {
    ...item,
    priority: Number.isFinite(item.priority) ? item.priority : 0,
    queuedAt: Number.isFinite(item.queuedAt) ? item.queuedAt : now,
    source: item.source ?? "audio",
    lastAttemptAt: Number.isFinite(item.lastAttemptAt) ? item.lastAttemptAt : 0,
    manual: item.manual ?? false,
  };
};

export async function listQueuedUploads(limit?: number): Promise<DriveUploadQueuedItem[]> {
  await initStorage();
  const storage = getStorage();
  const res = await storage.listQueuedUploads(limit);
  const list = res.ok ? res.value ?? [] : [];
  return list.map(ensureDefaults);
}

export async function countQueuedUploads(): Promise<number> {
  await initStorage();
  const storage = getStorage();
  const res = await storage.countQueuedUploads();
  return res.ok ? res.value ?? 0 : 0;
}

export async function enqueueUpload(item: DriveUploadQueuedItem): Promise<boolean> {
  await initStorage();
  const storage = getStorage();
  const res = await storage.enqueueUpload(ensureDefaults(item));
  return res.ok;
}

export async function enqueueChapterUpload(
  bookId: string,
  chapterId: string,
  localPath: string,
  opts?: { priority?: number; source?: UploadSource; manual?: boolean }
): Promise<boolean> {
  const existing = await listQueuedUploads();
  if (existing.some((item) => item.bookId === bookId && item.chapterId === chapterId)) return true;
  const now = Date.now();
  const id = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${chapterId}-${now}`;
  const item: DriveUploadQueuedItem = {
    id,
    bookId,
    chapterId,
    localPath,
    status: "queued",
    attempts: 0,
    nextAttemptAt: now,
    createdAt: now,
    updatedAt: now,
    priority: opts?.priority ?? 0,
    queuedAt: now,
    source: opts?.source ?? "audio",
    lastAttemptAt: 0,
    manual: opts?.manual ?? false,
  };
  return enqueueUpload(item);
}

export async function updateUploadItem(id: string, patch: Partial<DriveUploadQueuedItem>): Promise<boolean> {
  await initStorage();
  const storage = getStorage();
  if (!storage.updateUploadItem) return false;
  const res = await storage.updateUploadItem(id, patch);
  return res.ok;
}

export async function removeQueuedUpload(id: string): Promise<boolean> {
  await initStorage();
  const storage = getStorage();
  const res = await storage.markUploadDone(id);
  return res.ok;
}

export async function markUploadUploading(id: string, nextAttemptAt: number): Promise<boolean> {
  await initStorage();
  const storage = getStorage();
  const res = await storage.markUploadUploading(id, nextAttemptAt);
  return res.ok;
}

export async function markUploadFailed(id: string, error: string, nextAttemptAt: number): Promise<boolean> {
  await initStorage();
  const storage = getStorage();
  const res = await storage.markUploadFailed(id, error, nextAttemptAt);
  return res.ok;
}

export async function getNextReadyUpload(now: number): Promise<DriveUploadQueuedItem | null> {
  await initStorage();
  const storage = getStorage();
  const res = await storage.getNextReadyUpload(now);
  return res.ok ? (res.value ?? null) : null;
}

export async function clearQueuedUploads(): Promise<boolean> {
  const items = await listQueuedUploads();
  let ok = true;
  for (const item of items) {
    const res = await removeQueuedUpload(item.id);
    ok = ok && res;
  }
  return ok;
}
