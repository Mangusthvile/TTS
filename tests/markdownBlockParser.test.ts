import { describe, expect, it } from "vitest";
import { buildReaderModel } from "../utils/markdownBlockParser";

describe("buildReaderModel markdown tables", () => {
  it("keeps one-column table rows intact when cells contain <br> tags", () => {
    const input = [
      "|  |",
      "| --- |",
      "| Archetype: Warrior<br> <br> A versatile melee archetype.<br> <br> Required Aspect:<br> <br> [Martial]<br> <br> Sample Class Choices:<br> <br> {Berserker}, {Guardian}<br> <br> Compatibility: 77% |",
      "",
      "After block",
      "",
    ].join("\n");

    const parsed = buildReaderModel(input, true, [], false);
    const tableBlocks = parsed.blocks.filter((block) => block.type === "table");
    expect(tableBlocks).toHaveLength(1);

    const table = tableBlocks[0];
    expect(table.rows?.length).toBe(1);
    expect(table.rows?.[0]?.[0]).toContain("Archetype: Warrior");
    expect(table.rows?.[0]?.[0]).toContain("Sample Class Choices");
    expect(table.rows?.[0]?.[0]).toContain("Compatibility: 77%");
    expect(table.rows?.[0]?.[0]).toContain("\nRequired Aspect:");

    const leakedParagraph = parsed.blocks.find(
      (block) =>
        block.type === "paragraph" &&
        typeof block.content === "string" &&
        block.content.includes("Required Aspect")
    );
    expect(leakedParagraph).toBeUndefined();
  });
});
