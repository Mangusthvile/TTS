import { describe, it, expect, vi, beforeEach } from "vitest";

const runMock = vi.fn(async () => ({}));
const executeMock = vi.fn(async () => ({}));
const queryMock = vi.fn(async () => ({ values: [] }));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => true,
  },
}));

vi.mock("../services/sqliteConnectionManager", () => ({
  getSqliteDb: vi.fn(async () => ({
    run: runMock,
    execute: executeMock,
    query: queryMock,
  })),
}));

describe("nativeLibraryBridge", () => {
  beforeEach(() => {
    runMock.mockClear();
    executeMock.mockClear();
    queryMock.mockClear();
    (globalThis as any).window = (globalThis as any).window || {};
    (globalThis as any).window.Capacitor = {};
  });

  it("upserts book, chapters, and text content", async () => {
    const { ensureNativeLibraryForGenerateAudio } = await import("../services/nativeLibraryBridge");
    const book = { id: "b1", title: "Book 1", backend: "drive" };
    const chapters = [
      { id: "c1", title: "Chapter 1", index: 1, filename: "c1.txt", content: "hello" },
      { id: "c2", title: "Chapter 2", index: 2, filename: "c2.txt", content: "world" },
    ];

    const res = await ensureNativeLibraryForGenerateAudio(book as any, chapters as any);
    expect(res.books).toBe(1);
    expect(res.chapters).toBe(2);
    expect(res.texts).toBe(2);
    expect(runMock).toHaveBeenCalled();
    expect(executeMock).toHaveBeenCalled();
  });
});
