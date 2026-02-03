import { getStorage, initStorage } from "./storageSingleton";
import { appConfig } from "../src/config/appConfig";

type AudioPathRecord = { localPath: string; sizeBytes: number; updatedAt: number };
const AUDIO_PATH_CACHE_TTL_MS = appConfig.cache.chapterAudioPathTtlMs;
const audioPathCache = new Map<string, { value: AudioPathRecord | null; ts: number }>();
const audioPathInFlight = new Map<string, Promise<AudioPathRecord | null>>();

function getCachedAudioPath(chapterId: string): AudioPathRecord | null | undefined {
  const entry = audioPathCache.get(chapterId);
  if (!entry) return undefined;
  if (Date.now() - entry.ts > AUDIO_PATH_CACHE_TTL_MS) {
    audioPathCache.delete(chapterId);
    return undefined;
  }
  return entry.value;
}

function setCachedAudioPath(chapterId: string, value: AudioPathRecord | null): void {
  audioPathCache.set(chapterId, { value, ts: Date.now() });
}

export async function setChapterAudioPath(
  chapterId: string,
  localPath: string,
  sizeBytes: number
): Promise<void> {
  await initStorage();
  const storage = getStorage();
  const res = await storage.setChapterAudioPath(chapterId, localPath, sizeBytes);
  if (!res.ok) {
    console.warn("[TaleVox][ChapterAudio] setChapterAudioPath failed:", res.error);
    return;
  }
  setCachedAudioPath(chapterId, { localPath, sizeBytes, updatedAt: Date.now() });
}

export async function getChapterAudioPath(
  chapterId: string
): Promise<{ localPath: string; sizeBytes: number; updatedAt: number } | null> {
  const cached = getCachedAudioPath(chapterId);
  if (cached !== undefined) return cached;

  const inflight = audioPathInFlight.get(chapterId);
  if (inflight) return inflight;

  const task = (async () => {
    await initStorage();
    const storage = getStorage();
    const res = await storage.getChapterAudioPath(chapterId);
    if (!res.ok) {
      console.warn("[TaleVox][ChapterAudio] getChapterAudioPath failed:", res.error);
      setCachedAudioPath(chapterId, null);
      return null;
    }
    const value = res.value ?? null;
    setCachedAudioPath(chapterId, value);
    return value;
  })().finally(() => {
    audioPathInFlight.delete(chapterId);
  });

  audioPathInFlight.set(chapterId, task);
  return task;
}

export async function deleteChapterAudioPath(chapterId: string): Promise<void> {
  await initStorage();
  const storage = getStorage();
  const res = await storage.deleteChapterAudioPath(chapterId);
  if (!res.ok) {
    console.warn("[TaleVox][ChapterAudio] deleteChapterAudioPath failed:", res.error);
  }
  audioPathCache.delete(chapterId);
}
