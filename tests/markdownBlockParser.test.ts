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

  it("detects table when blank line exists between header and separator row", () => {
    const input = [
      "| Property | Value |",
      "",
      "| :--- | :--- |",
      "| Name | Elijah Hart |",
      "| Level | 268 |",
    ].join("\n");

    const parsed = buildReaderModel(input, true, [], false);
    const tableBlocks = parsed.blocks.filter((block) => block.type === "table");
    expect(tableBlocks).toHaveLength(1);

    const table = tableBlocks[0];
    expect(table.headers).toEqual(["Property", "Value"]);
    expect(table.rows).toHaveLength(2);
    expect(table.rows?.[0]).toEqual(["Name", "Elijah Hart"]);
    expect(table.rows?.[1]).toEqual(["Level", "268"]);
  });

  it("accepts separator cells with spaces (e.g. :--- )", () => {
    const input = [
      "| A | B |",
      "| :--- | :---: |",
      "| 1 | 2 |",
    ].join("\n");

    const parsed = buildReaderModel(input, true, [], false);
    const tableBlocks = parsed.blocks.filter((block) => block.type === "table");
    expect(tableBlocks).toHaveLength(1);
    expect(tableBlocks[0].headers).toEqual(["A", "B"]);
    expect(tableBlocks[0].rows).toHaveLength(1);
    expect(tableBlocks[0].rows?.[0]).toEqual(["1", "2"]);
  });

  it("collapses blank lines between every table row (pre-processing)", () => {
    const input = [
      "| Property | Value |",
      "",
      "| :--- | :--- |",
      "",
      "| Name | Elijah Hart |",
      "",
      "| Level | 268 |",
      "",
      "| Archetype | Druid |",
    ].join("\n");

    const parsed = buildReaderModel(input, true, [], false);
    const tableBlocks = parsed.blocks.filter((block) => block.type === "table");
    expect(tableBlocks).toHaveLength(1);

    const table = tableBlocks[0];
    expect(table.headers).toEqual(["Property", "Value"]);
    expect(table.rows).toHaveLength(3);
    expect(table.rows?.[0]).toEqual(["Name", "Elijah Hart"]);
    expect(table.rows?.[1]).toEqual(["Level", "268"]);
    expect(table.rows?.[2]).toEqual(["Archetype", "Druid"]);
  });
});
