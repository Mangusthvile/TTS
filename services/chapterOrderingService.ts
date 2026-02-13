import type { Chapter } from "../types";

export type FixChapterOrderingResult = {
  updated: number;
  maxBefore: number;
  maxAfter: number;
  chapters: Chapter[];
};

const DEFAULT_SORT_ORDER = 1;

function asPositiveInt(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

function normalizeTitle(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().toLowerCase();
}

function compareChapters(a: Chapter, b: Chapter): number {
  const bySort = getChapterSortOrder(a) - getChapterSortOrder(b);
  if (bySort !== 0) return bySort;
  const byLegacyIndex = (asPositiveInt(a.index) ?? 0) - (asPositiveInt(b.index) ?? 0);
  if (byLegacyIndex !== 0) return byLegacyIndex;
  const byTitle = normalizeTitle(a.title).localeCompare(normalizeTitle(b.title), undefined, {
    numeric: true,
  });
  if (byTitle !== 0) return byTitle;
  return String(a.id).localeCompare(String(b.id), undefined, { numeric: true });
}

export function getChapterSortOrder(chapter: Chapter): number {
  return (
    asPositiveInt(chapter.sortOrder) ??
    asPositiveInt(chapter.index) ??
    DEFAULT_SORT_ORDER
  );
}

export function normalizeChapterOrder(chapters: Chapter[]): Chapter[] {
  const byId = new Map<string, Chapter>();
  const fallbackOrderById = new Map<string, number>();

  chapters.forEach((chapter, idx) => {
    const id = String(chapter.id);
    const fallbackOrder = idx + DEFAULT_SORT_ORDER;
    if (!fallbackOrderById.has(id)) {
      fallbackOrderById.set(id, fallbackOrder);
    }
    const normalizedSortOrder =
      asPositiveInt(chapter.sortOrder) ??
      asPositiveInt(chapter.index) ??
      fallbackOrderById.get(id)!;
    const nextChapter: Chapter = {
      ...chapter,
      sortOrder: normalizedSortOrder,
    };

    const existing = byId.get(id);
    if (!existing) {
      byId.set(id, nextChapter);
      return;
    }

    const existingUpdated = Number(existing.updatedAt ?? 0);
    const incomingUpdated = Number(nextChapter.updatedAt ?? 0);
    byId.set(id, incomingUpdated >= existingUpdated ? nextChapter : existing);
  });

  return Array.from(byId.values()).sort(compareChapters);
}

export function deriveDisplayIndices(chapters: Chapter[]): Chapter[] {
  const ordered = normalizeChapterOrder(chapters);
  return ordered.map((chapter, idx) => {
    const displayIndex = idx + DEFAULT_SORT_ORDER;
    return {
      ...chapter,
      sortOrder: getChapterSortOrder(chapter),
      index: displayIndex,
    };
  });
}

export function computeNextSortOrder(chapters: Chapter[]): number {
  if (!chapters.length) return DEFAULT_SORT_ORDER;
  const maxSortOrder = chapters.reduce((max, chapter) => {
    const next = getChapterSortOrder(chapter);
    return next > max ? next : max;
  }, 0);
  return Math.max(DEFAULT_SORT_ORDER, maxSortOrder + 1);
}

export async function fixChapterOrdering(
  _bookId: string,
  chapters: Chapter[]
): Promise<FixChapterOrderingResult> {
  const normalized = normalizeChapterOrder(chapters);
  const maxBefore = normalized.reduce((max, chapter) => {
    const value = getChapterSortOrder(chapter);
    return value > max ? value : max;
  }, 0);
  const now = Date.now();
  let updated = 0;
  const reindexed = normalized.map((chapter, idx) => {
    const sortOrder = idx + DEFAULT_SORT_ORDER;
    const displayIndex = sortOrder;
    const nextChapter: Chapter = {
      ...chapter,
      sortOrder,
      index: displayIndex,
      updatedAt: chapter.updatedAt ?? now,
    };
    if (
      getChapterSortOrder(chapter) !== sortOrder ||
      (asPositiveInt(chapter.index) ?? 0) !== displayIndex
    ) {
      updated += 1;
      nextChapter.updatedAt = now;
    }
    return nextChapter;
  });

  return {
    updated,
    maxBefore,
    maxAfter: reindexed.length,
    chapters: reindexed,
  };
}

