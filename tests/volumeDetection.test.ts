import { describe, expect, it } from "vitest";
import { detectVolumeMeta, sortForSmartUpload } from "../utils/volumeDetection";

describe("volumeDetection", () => {
  it("parses 'Book N: Chapter M: Title' header", () => {
    const meta = detectVolumeMeta(
      "Book_9__Chapter_999__Ignored.md",
      "Book 1: Chapter 1: Waiting for the End to Come"
    );
    expect(meta.volumeName).toBe("Book 1");
    expect(meta.volumeNumber).toBe(1);
    expect(meta.volumeLocalChapter).toBe(1);
    expect(meta.title).toBe("Waiting for the End to Come");
  });

  it("parses volume/local chapter from filename", () => {
    const meta = detectVolumeMeta("Book_2__Chapter_1__Waiting_for_the_End_to_Come.md", "");
    expect(meta.volumeName).toBe("Book 2");
    expect(meta.volumeNumber).toBe(2);
    expect(meta.volumeLocalChapter).toBe(1);
    expect(meta.title).toBe("Waiting for the End to Come");
  });

  it("header values take precedence over filename", () => {
    const meta = detectVolumeMeta(
      "Book_2__Chapter_1__Wrong_Title.md",
      "Book 3: Chapter 4: Real Title"
    );
    expect(meta.volumeName).toBe("Book 3");
    expect(meta.volumeNumber).toBe(3);
    expect(meta.volumeLocalChapter).toBe(4);
    expect(meta.title).toBe("Real Title");
  });

  it("sorts smart upload files by volume then local chapter", () => {
    const files = [
      { fileName: "Book_2__Chapter_1__B.md", meta: detectVolumeMeta("Book_2__Chapter_1__B.md", "") },
      { fileName: "Book_1__Chapter_10__C.md", meta: detectVolumeMeta("Book_1__Chapter_10__C.md", "") },
      { fileName: "Book_1__Chapter_2__A.md", meta: detectVolumeMeta("Book_1__Chapter_2__A.md", "") },
      { fileName: "Chapter_3__Ungrouped.md", meta: detectVolumeMeta("Chapter_3__Ungrouped.md", "") },
    ];
    const sorted = sortForSmartUpload(files);
    expect(sorted.map((f) => f.fileName)).toEqual([
      "Book_1__Chapter_2__A.md",
      "Book_1__Chapter_10__C.md",
      "Book_2__Chapter_1__B.md",
      "Chapter_3__Ungrouped.md",
    ]);
  });
});

