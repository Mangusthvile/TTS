// services/progressStore.ts
import { getStorage, initStorage } from "./storageSingleton";
import type { ChapterProgress } from "./storageDriver";
import { clamp, computePercent } from "../utils/progress";

type CommitInput = {
  chapterId: string;
  timeSec: number;
  durationSec?: number;
  // Optional overrides if you already compute these elsewhere:
  percent?: number;
  isComplete?: boolean;
};

const lastCommittedAtByChapter = new Map<string, number>();
const lastCommittedTimeByChapter = new Map<string, number>();

export async function commitProgressLocal(input: CommitInput): Promise<void> {
  // Ensure storage is ready (safe to call repeatedly)
  await initStorage();

  const now = Date.now();

  // Throttle: don’t write more than once per 1500ms per chapter
  const lastAt = lastCommittedAtByChapter.get(input.chapterId) ?? 0;
  if (now - lastAt < 1500) return;

  // Also avoid writing identical time repeatedly (tiny seeks / jitter)
  const lastTime = lastCommittedTimeByChapter.get(input.chapterId);
  if (typeof lastTime === "number" && Math.abs(lastTime - input.timeSec) < 0.25) {
    // Less than 250ms change — ignore
    return;
  }

  const durationSec =
    typeof input.durationSec === "number" && Number.isFinite(input.durationSec) ? input.durationSec : undefined;
  let timeSec = Math.max(0, input.timeSec);
  if (durationSec && timeSec > durationSec + 0.5) {
    timeSec = durationSec;
  }

  const percent =
    typeof input.percent === "number" ? clamp(input.percent, 0, 1) : computePercent(timeSec, durationSec);

  const isComplete = typeof input.isComplete === "boolean" ? input.isComplete : undefined;

  const progress: ChapterProgress = {
    chapterId: input.chapterId,
    timeSec,
    durationSec,
    percent,
    isComplete,
    updatedAt: now,
  };

  const storage = getStorage();
  const res = await storage.saveChapterProgress(progress);

  if (!res.ok) {
    console.warn("[TaleVox][Progress] saveChapterProgress failed:", res.error);
    return;
  }

  lastCommittedAtByChapter.set(input.chapterId, now);
  lastCommittedTimeByChapter.set(input.chapterId, input.timeSec);

  console.log("[TaleVox][Progress] committed", {
    chapterId: input.chapterId,
    timeSec: input.timeSec,
    durationSec: input.durationSec,
    percent,
    isComplete,
  });
}

export async function loadProgressLocal(chapterId: string): Promise<ChapterProgress | null> {
  await initStorage();
  const storage = getStorage();
  const res = await storage.loadChapterProgress(chapterId);
  if (!res.ok) return null;
  return res.value ?? null;
}

/**
 * Restore audio currentTime safely.
 * Use this when you load a chapter audio source.
 *
 * It handles the case where duration isn't known yet by applying again on loadedmetadata.
 */
export async function restoreAudioTimeFromLocalProgress(
  audio: HTMLAudioElement,
  chapterId: string
): Promise<void> {
  const p = await loadProgressLocal(chapterId);
  if (!p || !p.timeSec || p.timeSec <= 0) return;

  const apply = () => {
    try {
      // Don’t seek past duration (can throw or clamp weirdly)
      const dur = Number.isFinite(audio.duration) ? audio.duration : undefined;
      const target = dur && dur > 0 ? clamp(p.timeSec, 0, Math.max(0, dur - 0.15)) : p.timeSec;

      // Only set if it’s meaningfully different
      if (Math.abs(audio.currentTime - target) > 0.35) {
        audio.currentTime = target;
        console.log("[TaleVox][Progress] restored audio time", { chapterId, target });
      }
    } catch (e) {
      console.warn("[TaleVox][Progress] restore seek failed:", e);
    }
  };

  // If metadata already loaded, apply now.
  if (audio.readyState >= 1) {
    apply();
    return;
  }

  // Otherwise apply once metadata loads.
  const onMeta = () => {
    audio.removeEventListener("loadedmetadata", onMeta);
    apply();
  };
  audio.addEventListener("loadedmetadata", onMeta);
}
