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
  return asPositiveInt(chapter.sortOrder) ?? asPositiveInt(chapter.index) ?? DEFAULT_SORT_ORDER;
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
    const normalizedSortOrder = explicitSortOrder ?? explicitIndex ?? fallbackOrderById.get(id)!;
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
    byId.set(
      id,
      incomingUpdated >= existingUpdated ? { chapter: nextChapter, hasExplicit } : existing
    );
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
  let lastDisplayIndex = 0;
  return ordered.map((chapter, idx) => {
    const fallbackIndex = idx + DEFAULT_SORT_ORDER;
    const existingIndex = asPositiveInt(chapter.index);
    const normalizedSortOrder = getChapterSortOrder(chapter);
    const baseIndex =
      existingIndex ??
      asPositiveInt(chapter.sortOrder) ??
      asPositiveInt(normalizedSortOrder) ??
      fallbackIndex;
    // If duplicate (same number as previous): first keeps, next moves up by one
    const displayIndex = baseIndex === lastDisplayIndex ? lastDisplayIndex + 1 : baseIndex;
    lastDisplayIndex = displayIndex;
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

/**
 * Renumber chapters sequentially from the minimum existing sortOrder.
 * Use after delete so indices stay consistent: e.g. 1–858 → delete one → 1–857;
 * or 3514–4314 → delete one → 3514–4313.
 * Duplicates are resolved: first keeps its place, subsequent get +1.
 */
export function renumberChaptersSequentially(chapters: Chapter[]): Chapter[] {
  if (!chapters.length) return [];
  const sorted = [...chapters].sort((a, b) => {
    const bySort = getChapterSortOrder(a) - getChapterSortOrder(b);
    if (bySort !== 0) return bySort;
    const byIdx = (asPositiveInt(a.index) ?? 0) - (asPositiveInt(b.index) ?? 0);
    if (byIdx !== 0) return byIdx;
    return String(a.id).localeCompare(String(b.id), undefined, { numeric: true });
  });
  const startIndex = Math.max(1, getChapterSortOrder(sorted[0]) || DEFAULT_SORT_ORDER);
  return sorted.map((chapter, idx) => {
    const sortOrder = startIndex + idx;
    return {
      ...chapter,
      sortOrder,
      index: sortOrder,
      updatedAt: chapter.updatedAt ?? Date.now(),
    };
  });
}

/**
 * Fix duplicates and missing chapter numbers. Preserves starting index
 * (e.g. 3514–4314 stays in range; 1–858 stays 1-based).
 */
export async function fixChapterOrdering(
  _bookId: string,
  chapters: Chapter[]
): Promise<FixChapterOrderingResult> {
  const normalized = normalizeChapterOrder(chapters);
  const maxBefore = normalized.reduce((max, chapter) => {
    const value = getChapterSortOrder(chapter);
    return value > max ? value : max;
  }, 0);
  const reindexed = renumberChaptersSequentially(normalized);
  const reindexedById = new Map<string, Chapter>(reindexed.map((c) => [String(c.id), c]));
  const now = Date.now();
  let updated = 0;
  for (const prev of normalized) {
    const next = reindexedById.get(String(prev.id));
    if (!next) continue;
    if (
      getChapterSortOrder(prev) !== (next.sortOrder ?? 0) ||
      (asPositiveInt(prev.index) ?? 0) !== (next.index ?? 0)
    ) {
      updated += 1;
    }
  }

  const maxAfter = reindexed.reduce((max, c) => Math.max(max, getChapterSortOrder(c)), 0);

  return {
    updated,
    maxBefore,
    maxAfter,
    chapters: reindexed.map((c) => ({ ...c, updatedAt: c.updatedAt ?? now })),
  };
}
