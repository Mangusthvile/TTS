import { getStorage, initStorage } from "./storageSingleton";

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
  }
}

export async function getChapterAudioPath(
  chapterId: string
): Promise<{ localPath: string; sizeBytes: number; updatedAt: number } | null> {
  await initStorage();
  const storage = getStorage();
  const res = await storage.getChapterAudioPath(chapterId);
  if (!res.ok) {
    console.warn("[TaleVox][ChapterAudio] getChapterAudioPath failed:", res.error);
    return null;
  }
  return res.value ?? null;
}

export async function deleteChapterAudioPath(chapterId: string): Promise<void> {
  await initStorage();
  const storage = getStorage();
  const res = await storage.deleteChapterAudioPath(chapterId);
  if (!res.ok) {
    console.warn("[TaleVox][ChapterAudio] deleteChapterAudioPath failed:", res.error);
  }
}
