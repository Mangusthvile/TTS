import { describe, expect, it, beforeEach } from "vitest";
import {
  analyzeProgressMismatch,
  commitProgressLocal,
  compareChapterProgressNonRegressive,
  readProgressStore,
  writeProgressStore,
  loadProgressLocal,
  normalizeProgressStore,
  mergeStores,
  resolveStartupConflictChoice,
  getLocalProgressLastUpdated,
  hydrateProgressFromIndexedDB,
  SESSION_DELTA_KEY,
  __clearProgressStoreCacheForTests,
  isProgressStoreHydrated,
  setProgressStoreHydrated,
  shouldSkipProgressWrite,
  IMPLAUSIBLE_RESET_THRESHOLD_SEC,
} from "../services/progressStore";

describe("progressStore", () => {
  beforeEach(() => {
    localStorage.clear();
    __clearProgressStoreCacheForTests();
  });

  it("commitProgressLocal writes and readProgressStore returns data", async () => {
    await commitProgressLocal({
      bookId: "book-1",
      chapterId: "ch-1",
      timeSec: 60,
      durationSec: 120,
      isComplete: false,
      updatedAt: 1000,
    });
    const store = readProgressStore();
    expect(store.books["book-1"]).toBeDefined();
    expect(store.books["book-1"]["ch-1"]).toBeDefined();
    expect(store.books["book-1"]["ch-1"].timeSec).toBe(60);
    expect(store.books["book-1"]["ch-1"].durationSec).toBe(120);
    expect(store.books["book-1"]["ch-1"].percent).toBeCloseTo(0.5, 4);
    expect(store.books["book-1"]["ch-1"].completed).toBe(false);
  });

  it("commitProgressLocal with isComplete marks chapter complete", async () => {
    await commitProgressLocal({
      bookId: "book-1",
      chapterId: "ch-1",
      timeSec: 100,
      durationSec: 100,
      isComplete: true,
      updatedAt: 2000,
    });
    const store = readProgressStore();
    expect(store.books["book-1"]["ch-1"].completed).toBe(true);
    expect(store.books["book-1"]["ch-1"].percent).toBe(1);
  });

  it("loadProgressLocal returns entry by chapterId and bookId", async () => {
    await commitProgressLocal({
      bookId: "book-1",
      chapterId: "ch-1",
      timeSec: 30,
      durationSec: 60,
      updatedAt: 3000,
    });
    const entry = await loadProgressLocal("ch-1", "book-1");
    expect(entry).toBeDefined();
    expect(entry!.timeSec).toBe(30);
    expect(entry!.durationSec).toBe(60);
    expect(entry!.percent).toBeCloseTo(0.5, 4);
  });

  it("loadProgressLocal finds chapter without bookId", async () => {
    await commitProgressLocal({
      bookId: "book-1",
      chapterId: "ch-1",
      timeSec: 45,
      durationSec: 90,
      updatedAt: 4000,
    });
    const entry = await loadProgressLocal("ch-1");
    expect(entry).toBeDefined();
    expect(entry!.timeSec).toBe(45);
  });

  it("writeProgressStore and readProgressStore roundtrip", () => {
    const payload = {
      schemaVersion: 1,
      books: {
        "book-a": {
          "ch-x": { timeSec: 10, durationSec: 20, percent: 0.5, completed: false, updatedAt: 5000 },
        },
        "book-b": {
          "ch-y": { timeSec: 50, durationSec: 100, percent: 1, completed: true, updatedAt: 6000 },
        },
      },
    };
    writeProgressStore(payload);
    const read = readProgressStore();
    expect(read.books["book-a"]["ch-x"].timeSec).toBe(10);
    expect(read.books["book-b"]["ch-y"].completed).toBe(true);
  });

  it("normalizeProgressStore handles legacy format", () => {
    const raw = { books: { b1: { c1: { timeSec: 5, completed: false } } } };
    const norm = normalizeProgressStore(raw);
    expect(norm).not.toBeNull();
    expect(norm!.schemaVersion).toBe(1);
    expect(norm!.books["b1"]).toBeDefined();
    expect(norm!.books["b1"]["c1"].timeSec).toBe(5);
  });

  it("normalizeProgressStore returns null for invalid input", () => {
    expect(normalizeProgressStore(null)).toBeNull();
    expect(normalizeProgressStore(undefined)).toBeNull();
    expect(normalizeProgressStore("not an object")).toBeNull();
  });

  it("mergeStores handles large book (3573 entries then append 3574-3709)", () => {
    const bookId = "large-book";
    const chapters: Record<
      string,
      {
        timeSec: number;
        durationSec: number;
        percent: number;
        completed: boolean;
        updatedAt: number;
      }
    > = {};
    for (let i = 1; i <= 3573; i++) {
      chapters[`ch-${i}`] = {
        timeSec: 60,
        durationSec: 120,
        percent: 1,
        completed: true,
        updatedAt: 1000 + i,
      };
    }
    const local: import("../services/progressStore").ProgressStorePayload = {
      schemaVersion: 1,
      books: { [bookId]: chapters },
    };
    writeProgressStore(local);
    const appended: Record<
      string,
      {
        timeSec: number;
        durationSec: number;
        percent: number;
        completed: boolean;
        updatedAt: number;
      }
    > = {};
    for (let i = 3574; i <= 3709; i++) {
      appended[`ch-${i}`] = {
        timeSec: 30,
        durationSec: 60,
        percent: 0.5,
        completed: false,
        updatedAt: 2000 + i,
      };
    }
    const incoming: import("../services/progressStore").ProgressStorePayload = {
      schemaVersion: 1,
      books: { [bookId]: { ...chapters, ...appended } },
    };
    const merged = mergeStores(local, incoming);
    expect(merged.books[bookId]).toBeDefined();
    expect(Object.keys(merged.books[bookId]).length).toBe(3709);
    for (let i = 1; i <= 3573; i++) {
      expect(merged.books[bookId][`ch-${i}`]).toBeDefined();
      expect(merged.books[bookId][`ch-${i}`].completed).toBe(true);
    }
    for (let i = 3574; i <= 3709; i++) {
      expect(merged.books[bookId][`ch-${i}`]).toBeDefined();
      expect(merged.books[bookId][`ch-${i}`].updatedAt).toBe(2000 + i);
    }
    writeProgressStore(merged);
    const read = readProgressStore();
    expect(Object.keys(read.books[bookId]).length).toBe(3709);
  });

  it("mergeStores keeps advanced durable progress when incoming is newer but much lower", () => {
    const durable = {
      schemaVersion: 1,
      books: {
        b1: {
          c1: { timeSec: 180, durationSec: 240, percent: 0.75, completed: false, updatedAt: 1000 },
        },
      },
    };
    const incoming = {
      schemaVersion: 1,
      books: {
        b1: {
          c1: { timeSec: 5, durationSec: 240, percent: 0.02, completed: false, updatedAt: 2000 },
        },
      },
    };
    const merged = mergeStores(durable, incoming);
    expect(merged.books.b1.c1.timeSec).toBe(180);
    expect(merged.books.b1.c1.percent).toBeCloseTo(0.75, 4);
    expect(merged.books.b1.c1.updatedAt).toBe(1000);
  });

  it("mergeStores allows explicit reset entries to replace advanced progress", () => {
    const durable = {
      schemaVersion: 1,
      books: {
        b1: {
          c1: { timeSec: 180, durationSec: 240, percent: 0.75, completed: true, updatedAt: 1000 },
        },
      },
    };
    const incoming = {
      schemaVersion: 1,
      books: {
        b1: {
          c1: {
            timeSec: 0,
            durationSec: 240,
            percent: 0,
            completed: false,
            updatedAt: 2000,
            resetReason: "explicit",
          },
        },
      },
    };
    const merged = mergeStores(durable, incoming);
    expect(merged.books.b1.c1.timeSec).toBe(0);
    expect(merged.books.b1.c1.completed).toBe(false);
    expect(merged.books.b1.c1.updatedAt).toBe(2000);
  });

  it("analyzeProgressMismatch only flags major deltas by threshold", () => {
    const localMinor = {
      schemaVersion: 1,
      books: {
        b1: { c1: { timeSec: 20, completed: false, updatedAt: 1000 } },
      },
    };
    const durableMinor = {
      schemaVersion: 1,
      books: {
        b1: { c1: { timeSec: 35, completed: false, updatedAt: 1200 } },
      },
    };
    const minor = analyzeProgressMismatch(localMinor, durableMinor);
    expect(minor.isMajorMismatch).toBe(false);

    const localMajor = {
      schemaVersion: 1,
      books: {
        b1: { c1: { timeSec: 5, completed: false, updatedAt: 3000 } },
      },
    };
    const durableMajor = {
      schemaVersion: 1,
      books: {
        b1: { c1: { timeSec: 80, completed: false, updatedAt: 2000 } },
      },
    };
    const major = analyzeProgressMismatch(localMajor, durableMajor);
    expect(major.isMajorMismatch).toBe(true);
    expect(major.reasons).toContain("time_delta");
  });

  it("startup conflict dismiss defaults to durable", () => {
    expect(resolveStartupConflictChoice(undefined)).toBe("durable");
    expect(resolveStartupConflictChoice(null)).toBe("durable");
    expect(resolveStartupConflictChoice("local")).toBe("local");
  });

  it("compareChapterProgressNonRegressive favors completed and higher progress", () => {
    expect(
      compareChapterProgressNonRegressive(
        { completed: true, timeSec: 10, percent: 0.2 },
        { completed: false, timeSec: 90, percent: 0.8 }
      )
    ).toBeGreaterThan(0);
    expect(
      compareChapterProgressNonRegressive(
        { completed: false, timeSec: 90, percent: 0.8 },
        { completed: false, timeSec: 10, percent: 0.2 }
      )
    ).toBeGreaterThan(0);
  });

  it("getLocalProgressLastUpdated returns max updatedAt", () => {
    writeProgressStore({
      schemaVersion: 1,
      books: {
        b1: {
          c1: { timeSec: 0, updatedAt: 100 },
          c2: { timeSec: 0, updatedAt: 300 },
        },
        b2: { c1: { timeSec: 0, updatedAt: 200 } },
      },
    });
    expect(getLocalProgressLastUpdated()).toBe(300);
  });

  it("hydrateProgressFromIndexedDB merges session delta and removes key", async () => {
    __clearProgressStoreCacheForTests();
    const delta = {
      bookId: "delta-book",
      chapterId: "delta-ch",
      entry: { timeSec: 90, durationSec: 120, percent: 0.75, completed: false, updatedAt: 9999 },
      savedAt: 9999,
    };
    localStorage.setItem(SESSION_DELTA_KEY, JSON.stringify(delta));
    await hydrateProgressFromIndexedDB();
    const store = readProgressStore();
    expect(store.books["delta-book"]).toBeDefined();
    expect(store.books["delta-book"]["delta-ch"]).toEqual(delta.entry);
    expect(localStorage.getItem(SESSION_DELTA_KEY)).toBeNull();
  });

  describe("hydration flag (Phase 2)", () => {
    it("is false after clear and true after setProgressStoreHydrated", () => {
      __clearProgressStoreCacheForTests();
      expect(isProgressStoreHydrated()).toBe(false);
      setProgressStoreHydrated();
      expect(isProgressStoreHydrated()).toBe(true);
      __clearProgressStoreCacheForTests();
      expect(isProgressStoreHydrated()).toBe(false);
    });
  });

  describe("monotonicity / shouldSkipProgressWrite (Phase 3)", () => {
    it("skips when existing is complete and incoming is not (completion lock)", () => {
      expect(shouldSkipProgressWrite(60, true, 30, false, false)).toBe(true);
      expect(shouldSkipProgressWrite(60, true, 0, false, false)).toBe(true);
      expect(shouldSkipProgressWrite(60, true, 60, true, false)).toBe(false);
      expect(shouldSkipProgressWrite(60, false, 30, false, false)).toBe(false);
    });

    it("skips implausible reset (incoming 0 when stored > threshold)", () => {
      const t = IMPLAUSIBLE_RESET_THRESHOLD_SEC;
      expect(shouldSkipProgressWrite(15, false, 0, false, false)).toBe(true);
      expect(shouldSkipProgressWrite(t + 1, false, 0, false, false)).toBe(true);
      expect(shouldSkipProgressWrite(5, false, 0, false, false)).toBe(false);
      expect(shouldSkipProgressWrite(t, false, 0, false, false)).toBe(false);
    });

    it("allows write when forceReset is true", () => {
      expect(shouldSkipProgressWrite(60, true, 0, false, true)).toBe(false);
      expect(shouldSkipProgressWrite(15, false, 0, false, true)).toBe(false);
    });
  });
});
