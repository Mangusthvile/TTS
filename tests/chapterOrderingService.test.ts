import { describe, expect, it } from "vitest";
import type { Chapter } from "../types";
import {
  computeNextSortOrder,
  deriveDisplayIndices,
  fixChapterOrdering,
  getChapterSortOrder,
  normalizeChapterOrder,
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

  it("derives contiguous display indices", () => {
    const display = deriveDisplayIndices([
      chapter({ id: "z", sortOrder: 10, index: 10 }),
      chapter({ id: "a", sortOrder: 1, index: 999 }),
      chapter({ id: "m", sortOrder: 4, index: 4 }),
    ]);

    expect(display.map((item) => item.id)).toEqual(["a", "m", "z"]);
    expect(display.map((item) => item.index)).toEqual([1, 2, 3]);
    expect(display.map((item) => item.sortOrder)).toEqual([1, 4, 10]);
  });

  it("computes next sort order from current max", () => {
    const next = computeNextSortOrder([
      chapter({ id: "a", sortOrder: 4 }),
      chapter({ id: "b", index: 9 }),
      chapter({ id: "c", sortOrder: 2 }),
    ]);
    expect(next).toBe(10);
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
