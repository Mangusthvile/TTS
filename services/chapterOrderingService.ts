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
  const byId = new Map<string, { chapter: Chapter; hasExplicit: boolean }>();
  const fallbackOrderById = new Map<string, number>();

  chapters.forEach((chapter, idx) => {
    const id = String(chapter.id);
    const fallbackOrder = idx + DEFAULT_SORT_ORDER;
    if (!fallbackOrderById.has(id)) {
      fallbackOrderById.set(id, fallbackOrder);
    }
    const explicitSortOrder = asPositiveInt(chapter.sortOrder);
    const explicitIndex = asPositiveInt(chapter.index);
    const hasExplicit = explicitSortOrder !== null || explicitIndex !== null;
    const normalizedSortOrder =
      explicitSortOrder ??
      explicitIndex ??
      fallbackOrderById.get(id)!;
    const nextChapter: Chapter = {
      ...chapter,
      sortOrder: normalizedSortOrder,
    };

    const existing = byId.get(id);
    if (!existing) {
      byId.set(id, { chapter: nextChapter, hasExplicit });
      return;
    }

    const existingUpdated = Number(existing.chapter.updatedAt ?? 0);
    const incomingUpdated = Number(nextChapter.updatedAt ?? 0);
    byId.set(id, incomingUpdated >= existingUpdated ? { chapter: nextChapter, hasExplicit } : existing);
  });

  return Array.from(byId.values())
    .sort((a, b) => {
      if (a.hasExplicit !== b.hasExplicit) return a.hasExplicit ? -1 : 1;
      return compareChapters(a.chapter, b.chapter);
    })
    .map((entry) => entry.chapter);
}

export function deriveDisplayIndices(chapters: Chapter[]): Chapter[] {
  const ordered = normalizeChapterOrder(chapters);
  return ordered.map((chapter, idx) => {
    const fallbackIndex = idx + DEFAULT_SORT_ORDER;
    const existingIndex = asPositiveInt(chapter.index);
    const normalizedSortOrder = getChapterSortOrder(chapter);
    const displayIndex =
      existingIndex ??
      asPositiveInt(chapter.sortOrder) ??
      asPositiveInt(normalizedSortOrder) ??
      fallbackIndex;
    return {
      ...chapter,
      sortOrder: normalizedSortOrder,
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
