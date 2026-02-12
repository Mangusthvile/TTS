import { describe, expect, it } from "vitest";
import { buildChunks, chunkIndexFromChar } from "../utils/chunking";

describe("chunking", () => {
  it("buildChunks covers full text contiguously", () => {
    const text = "Hello world. Hello world.\n\nNext para! Another?";
    const chunks = buildChunks(text);

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].start).toBe(0);
    expect(chunks[chunks.length - 1].end).toBe(text.length);

    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      expect(c.text).toBe(text.slice(c.start, c.end));
      if (i > 0) {
        expect(chunks[i - 1].end).toBe(c.start);
      }
    }
  });

  it("splits on sentence boundaries and paragraph breaks", () => {
    const text = "A. B.\n\nC! D?";
    const chunks = buildChunks(text);
    expect(chunks.map((c) => c.text)).toEqual(["A. ", "B.\n\n", "C! ", "D?"]);
  });

  it("handles repeated sentences without collisions", () => {
    const text = "Repeat. Repeat. Repeat.";
    const chunks = buildChunks(text);
    expect(chunks.map((c) => c.text)).toEqual(["Repeat. ", "Repeat. ", "Repeat."]);
    expect(chunks.map((c) => c.start)).toEqual([0, 8, 16]);
  });

  it("chunkIndexFromChar maps char indices correctly", () => {
    const text = "One. Two. Three.";
    const chunks = buildChunks(text);

    expect(chunkIndexFromChar(chunks, -5)).toBe(0);
    expect(chunkIndexFromChar(chunks, 0)).toBe(0);

    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      expect(chunkIndexFromChar(chunks, c.start)).toBe(i);
      if (c.start + 1 < c.end) {
        expect(chunkIndexFromChar(chunks, c.start + 1)).toBe(i);
      }
      expect(chunkIndexFromChar(chunks, c.end - 1)).toBe(i);

      if (i < chunks.length - 1) {
        // End is exclusive; next chunk should own this index.
        expect(chunkIndexFromChar(chunks, c.end)).toBe(i + 1);
      }
    }

    expect(chunkIndexFromChar(chunks, text.length)).toBe(chunks.length - 1);
    expect(chunkIndexFromChar(chunks, text.length + 999)).toBe(chunks.length - 1);
  });
});
