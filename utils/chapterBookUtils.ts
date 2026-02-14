import { AudioChunkMetadata, Book, Chapter } from '../types';
import { clamp, computePercent } from './progress';
import { deriveDisplayIndices, normalizeChapterOrder } from '../services/chapterOrderingService';

export const normalizeChapterProgress = (c: Chapter): Chapter => {
  let percent = typeof c.progress === 'number' ? c.progress : 0;
  if (c.progress === undefined) {
    if (typeof c.progressSec === 'number' && c.durationSec) {
      percent = computePercent(c.progressSec, c.durationSec) ?? 0;
    } else if (typeof c.progressChars === 'number' && c.textLength) {
      percent = computePercent(c.progressChars, c.textLength) ?? 0;
    }
  }

  percent = clamp(percent, 0, 1);
  const isCompleted = !!c.isCompleted;
  if (isCompleted) percent = 1;
  return { ...c, progress: percent, isCompleted };
};

export const orderChaptersForDisplay = (chapters: Chapter[]): Chapter[] => {
  return deriveDisplayIndices(normalizeChapterOrder(chapters || [])).map((chapter) =>
    normalizeChapterProgress(chapter)
  );
};

export const normalizeBookChapters = (book: Book): Book => {
  const ordered = orderChaptersForDisplay(book.chapters || []);
  return {
    ...book,
    chapters: ordered,
    chapterCount:
      typeof book.chapterCount === 'number'
        ? Math.max(book.chapterCount, ordered.length)
        : ordered.length,
  };
};

export const getEffectivePrefixLen = (chapter: Chapter, fallbackIntroLen: number): number => {
  if (Number.isFinite(chapter.audioPrefixLen)) {
    return Math.max(0, Number(chapter.audioPrefixLen));
  }
  if (chapter.audioSignature) {
    return Math.max(0, fallbackIntroLen);
  }
  return 0;
};

export const deriveIntroMsFromChunkMap = (chunkMap: AudioChunkMetadata[], prefixLen: number): number => {
  if (!chunkMap.length || prefixLen <= 0) return 0;
  let introMs = 0;
  for (const chunk of chunkMap) {
    const segLen = Math.max(1, chunk.endChar - chunk.startChar);
    if (chunk.endChar <= prefixLen) {
      introMs += chunk.durSec * 1000;
    } else if (chunk.startChar < prefixLen) {
      const ratio = (prefixLen - chunk.startChar) / segLen;
      introMs += chunk.durSec * 1000 * Math.max(0, Math.min(1, ratio));
    }
  }
  return Math.floor(introMs);
};

export const normalizeChunkMapForChapter = (
  chunkMap: AudioChunkMetadata[] | undefined,
  textLen: number,
  prefixLen: number
): { chunkMap: AudioChunkMetadata[]; introMsFromChunk: number } => {
  if (!chunkMap || chunkMap.length === 0 || textLen <= 0) {
    return { chunkMap: [], introMsFromChunk: 0 };
  }
  const safePrefix = Math.max(0, prefixLen);
  const maxEnd = chunkMap.reduce((acc, c) => Math.max(acc, c.endChar), 0);
  const looksPrefixed = safePrefix > 0 && maxEnd > textLen + 2;
  let introMsFromChunk = 0;
  let mapped = chunkMap;
  if (looksPrefixed) {
    introMsFromChunk = deriveIntroMsFromChunkMap(chunkMap, safePrefix);
    mapped = chunkMap.map((c) => ({
      ...c,
      startChar: c.startChar - safePrefix,
      endChar: c.endChar - safePrefix,
    }));
  }
  const clamped = mapped
    .filter((c) => c.endChar > 0)
    .map((c) => ({
      ...c,
      startChar: Math.max(0, c.startChar),
      endChar: Math.min(textLen, c.endChar),
    }))
    .filter((c) => c.endChar > c.startChar);
  return { chunkMap: clamped, introMsFromChunk };
};

export const computeIntroMs = (opts: {
  audioIntroDurSec?: number;
  audioPrefixLen?: number;
  textLen: number;
  durationMs?: number;
  introMsFromChunk?: number;
}): number => {
  if (opts.audioIntroDurSec && opts.audioIntroDurSec > 0) {
    return Math.floor(opts.audioIntroDurSec * 1000);
  }
  if (opts.introMsFromChunk && opts.introMsFromChunk > 0) {
    return Math.floor(opts.introMsFromChunk);
  }
  const prefixLen = Math.max(0, opts.audioPrefixLen ?? 0);
  const durationMs = Math.max(0, opts.durationMs ?? 0);
  if (prefixLen > 0 && durationMs > 0) {
    const totalLen = prefixLen + Math.max(1, opts.textLen);
    return Math.min(durationMs, Math.floor((prefixLen / totalLen) * durationMs));
  }
  return 0;
};
