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
