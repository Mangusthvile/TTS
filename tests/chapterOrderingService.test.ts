import { describe, expect, it } from "vitest";
import type { Chapter } from "../types";
import {
  computeNextSortOrder,
  deriveDisplayIndices,
  fixChapterOrdering,
  getChapterSortOrder,
  normalizeChapterOrder,
  renumberChaptersSequentially,
} from "../services/chapterOrderingService";

let chapterSeed = 0;

function chapter(overrides: Partial<Chapter>): Chapter {
  return {
    id: overrides.id ?? `chapter-${++chapterSeed}`,
    index: overrides.index ?? 0,
    sortOrder: overrides.sortOrder,
    title: overrides.title ?? "Chapter",
    filename: overrides.filename ?? "chapter.txt",
    wordCount: 100,
    progress: 0,
    progressChars: 0,
    ...overrides,
  };
}

describe("chapterOrderingService", () => {
  it("uses sortOrder when present and falls back to legacy index", () => {
    const withSort = chapter({ id: "a", index: 99, sortOrder: 4 });
    const withoutSort = chapter({ id: "b", index: 7 });

    expect(getChapterSortOrder(withSort)).toBe(4);
    expect(getChapterSortOrder(withoutSort)).toBe(7);
  });

  it("normalizes deterministic chapter ordering with tie-breakers", () => {
    const ordered = normalizeChapterOrder([
      chapter({ id: "c", index: 2, title: "Zulu" }),
      chapter({ id: "a", index: 2, title: "Alpha" }),
      chapter({ id: "b", sortOrder: 1, index: 900 }),
    ]);

    expect(ordered.map((item) => item.id)).toEqual(["b", "a", "c"]);
  });

  it("preserves existing indices when deriving display order", () => {
    const display = deriveDisplayIndices([
      chapter({ id: "z", sortOrder: 10, index: 10 }),
      chapter({ id: "a", sortOrder: 1, index: 999 }),
      chapter({ id: "m", sortOrder: 4, index: 4 }),
    ]);

    expect(display.map((item) => item.id)).toEqual(["a", "m", "z"]);
    expect(display.map((item) => item.index)).toEqual([999, 4, 10]);
    expect(display.map((item) => item.sortOrder)).toEqual([1, 4, 10]);
  });

  it("fills missing indices from sortOrder or fallback", () => {
    const display = deriveDisplayIndices([
      chapter({ id: "a", sortOrder: 2, index: 0 }),
      chapter({ id: "b", sortOrder: 5, index: 0 }),
      chapter({ id: "c", sortOrder: 0, index: 0 }),
    ]);

    expect(display.map((item) => item.id)).toEqual(["a", "b", "c"]);
    expect(display.map((item) => item.index)).toEqual([2, 5, 3]);
    expect(display.map((item) => item.sortOrder)).toEqual([2, 5, 3]);
  });

  it("computes next sort order from current max", () => {
    const next = computeNextSortOrder([
      chapter({ id: "a", sortOrder: 4 }),
      chapter({ id: "b", index: 9 }),
      chapter({ id: "c", sortOrder: 2 }),
    ]);
    expect(next).toBe(10);
  });

  it("renumberChaptersSequentially preserves start index and renumbers after delete", () => {
    const before = [
      chapter({ id: "a", sortOrder: 1, index: 1 }),
      chapter({ id: "b", sortOrder: 2, index: 2 }),
      chapter({ id: "c", sortOrder: 3, index: 3 }),
      chapter({ id: "d", sortOrder: 4, index: 4 }),
    ];
    const afterDelete = before.filter((c) => c.id !== "c");
    const renumbered = renumberChaptersSequentially(afterDelete);
    expect(renumbered.map((c) => c.sortOrder)).toEqual([1, 2, 3]);
    expect(renumbered.map((c) => c.id)).toEqual(["a", "b", "d"]);
  });

  it("renumberChaptersSequentially preserves high start index (e.g. 3514)", () => {
    const before = [
      chapter({ id: "a", sortOrder: 3514, index: 3514 }),
      chapter({ id: "b", sortOrder: 3515, index: 3515 }),
      chapter({ id: "c", sortOrder: 3516, index: 3516 }),
    ];
    const afterDelete = before.filter((c) => c.id !== "b");
    const renumbered = renumberChaptersSequentially(afterDelete);
    expect(renumbered.map((c) => c.sortOrder)).toEqual([3514, 3515]);
    expect(renumbered.map((c) => c.id)).toEqual(["a", "c"]);
  });

  it("derives display indices with duplicate fix (first keeps, next +1)", () => {
    const display = deriveDisplayIndices([
      chapter({ id: "a", sortOrder: 5, index: 5 }),
      chapter({ id: "b", sortOrder: 5, index: 5 }),
      chapter({ id: "c", sortOrder: 6, index: 6 }),
    ]);
    expect(display.map((c) => c.index)).toEqual([5, 6, 7]);
  });

  it("reindexes chapters sequentially and reports summary", async () => {
    const result = await fixChapterOrdering("book-1", [
      chapter({ id: "c", sortOrder: 300, index: 300 }),
      chapter({ id: "a", sortOrder: 1, index: 99 }),
      chapter({ id: "b", index: 2 }),
    ]);

    expect(result.updated).toBeGreaterThan(0);
    expect(result.maxBefore).toBe(300);
    expect(result.maxAfter).toBe(3);
    expect(result.chapters.map((item) => item.id)).toEqual(["a", "b", "c"]);
    expect(result.chapters.map((item) => item.sortOrder)).toEqual([1, 2, 3]);
    expect(result.chapters.map((item) => item.index)).toEqual([1, 2, 3]);
  });
});
