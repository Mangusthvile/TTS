import type { DriveUploadQueuedItem } from "./storageDriver";
import { enqueueUpload, enqueueChapterUpload, listQueuedUploads, countQueuedUploads, clearQueuedUploads, updateUploadItem } from "./uploadQueueStore";
import { notifyUpload } from "./uploadNotifier";
import { getUploadPreferences } from "./uploadPreferences";
import { ensureUploadQueueJob, setUploadQueuePaused } from "./jobRunnerService";
import type { UiMode } from "../types";

export type UploadEnqueueInput = {
  bookId: string;
  chapterId: string;
  localPath: string;
  priority?: number;
  source?: DriveUploadQueuedItem["source"];
  manual?: boolean;
};

export async function enqueueUploads(items: UploadEnqueueInput[], uiMode: UiMode): Promise<number> {
  if (!items.length) return 0;
  let count = 0;
  for (const item of items) {
    const ok = await enqueueChapterUpload(item.bookId, item.chapterId, item.localPath, {
      priority: item.priority,
      source: item.source ?? "audio",
      manual: item.manual ?? true,
    });
    if (ok) count += 1;
  }
  if (count) notifyUpload("queued", `Queued ${count} upload${count === 1 ? "" : "s"}`);
  const prefs = getUploadPreferences();
  if (prefs.autoStart) {
    await startUploads(uiMode);
  }
  return count;
}

export async function enqueueUploadItem(item: DriveUploadQueuedItem, uiMode: UiMode): Promise<boolean> {
  const ok = await enqueueUpload(item);
  if (ok) notifyUpload("queued");
  const prefs = getUploadPreferences();
  if (ok && prefs.autoStart) {
    await startUploads(uiMode);
  }
  return ok;
}

export async function startUploads(uiMode: UiMode): Promise<void> {
  await setUploadQueuePaused(false, uiMode);
  const prefs = getUploadPreferences();
  await ensureUploadQueueJob(uiMode, {
    constraints: {
      wifiOnly: prefs.wifiOnly,
      requiresCharging: prefs.requiresCharging,
    },
  });
  notifyUpload("started");
}

export async function pauseUploads(uiMode: UiMode): Promise<void> {
  await setUploadQueuePaused(true, uiMode);
  notifyUpload("paused");
}

export async function resumeUploads(uiMode: UiMode): Promise<void> {
  await setUploadQueuePaused(false, uiMode);
  await startUploads(uiMode);
  notifyUpload("resumed");
}

export async function clearUploadQueue(): Promise<void> {
  await clearQueuedUploads();
  notifyUpload("cleared");
}

export async function listUploadQueue(): Promise<DriveUploadQueuedItem[]> {
  return listQueuedUploads();
}

export async function countUploadQueue(): Promise<number> {
  return countQueuedUploads();
}

export async function startUploadNow(chapterId: string): Promise<void> {
  const items = await listQueuedUploads();
  const target = items.find((item) => item.chapterId === chapterId);
  if (!target) return;
  await updateUploadItem(target.id, {
    priority: Math.max(1000, (target.priority ?? 0) + 1000),
    queuedAt: Date.now(),
    nextAttemptAt: Date.now(),
    status: "queued",
  });
}

export async function reorderUploadQueue(order: string[]): Promise<void> {
  const items = await listQueuedUploads();
  const map = new Map(items.map((item) => [item.id, item]));
  let priority = order.length;
  for (const id of order) {
    const item = map.get(id);
    if (!item) continue;
    await updateUploadItem(id, { priority, queuedAt: Date.now() + (order.length - priority) });
    priority -= 1;
  }
}
