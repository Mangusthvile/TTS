import { initStorage, getStorage } from "./storageSingleton";
import type { DriveUploadQueuedItem } from "./storageDriver";
export type { DriveUploadQueuedItem } from "./storageDriver";

export async function countQueuedUploads(): Promise<number> {
  await initStorage();
  const storage = getStorage();
  const res = await storage.countQueuedUploads();
  return res.ok ? res.value ?? 0 : 0;
}

export async function listQueuedUploads(limit?: number): Promise<DriveUploadQueuedItem[]> {
  await initStorage();
  const storage = getStorage();
  const res = await storage.listQueuedUploads(limit);
  return res.ok ? res.value ?? [] : [];
}

export async function enqueueUploadEntry(item: DriveUploadQueuedItem): Promise<boolean> {
  await initStorage();
  const storage = getStorage();
  const res = await storage.enqueueUpload(item);
  return res.ok;
}

export async function enqueueChapterUpload(bookId: string, chapterId: string, localPath: string): Promise<boolean> {
  const existing = await listQueuedUploads();
  if (existing.some((item) => item.bookId === bookId && item.chapterId === chapterId)) {
    return true;
  }
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
  };
  const ok = await enqueueUploadEntry(item);
  try {
    const uiMode = (localStorage.getItem("talevox_ui_mode") as any) || "auto";
    const { ensureUploadQueueJob } = await import("./jobRunnerService");
    await ensureUploadQueueJob(uiMode as any);
  } catch {
    // best effort
  }
  return ok;
}

export async function removeQueuedUpload(id: string): Promise<boolean> {
  await initStorage();
  const storage = getStorage();
  const res = await storage.markUploadDone(id);
  return res.ok;
}
