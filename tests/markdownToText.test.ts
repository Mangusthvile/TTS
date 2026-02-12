import { describe, expect, it } from "vitest";
import { markdownToPlainText } from "../utils/markdownToText";

describe("markdownToPlainText", () => {
  it("converts GFM tables to speakable text (no pipes/separators)", () => {
    const input = [
      "Some intro",
      "",
      "| Stat | Value |",
      "| --- | --- |",
      "| Strength | 6 |",
      "| Notes | Line1<br>Line2 |",
      "",
      "After",
      "",
    ].join("\n");

    const out = markdownToPlainText(input);
    expect(out).toContain("Strength: 6");
    expect(out).toContain("Notes: Line1\nLine2");
    expect(out).not.toContain("|");
    expect(out).not.toContain("---");
  });

  it("preserves 1-column table rows (blue-box messages)", () => {
    const input = [
      "|  |",
      "| --- |",
      "| Your planet (Earth) has been touched by the World Tree. Scanning… |",
      "",
      "After",
    ].join("\n");
    const out = markdownToPlainText(input);
    expect(out).toContain("Your planet (Earth) has been touched by the World Tree. Scanning…");
    expect(out).not.toContain("|");
  });

  it("strips fenced code blocks", () => {
    const input = ["Before", "```js", "const x = 1;", "```", "After"].join("\n");
    const out = markdownToPlainText(input);
    expect(out).toContain("Before");
    expect(out).toContain("After");
    expect(out).not.toContain("const x");
  });

  it("converts <br> tags to newlines", () => {
    const out = markdownToPlainText("Hello<br>world");
    expect(out).toBe("Hello\nworld");
  });
});
