import { Rule } from "../types";
import { applyRules } from "../services/speechService";
import { reflowLineBreaks } from "../services/textFormat";
import { stripChapterTemplateHeader } from "./stripChapterTemplateHeader";

export type BlockType = "paragraph" | "heading" | "table" | "code" | "spacer" | "list";

export type TextRange = {
  startIndex: number;
  endIndex: number;
};

export type CellRange = TextRange & {
  row: number;
  col: number;
  isHeader?: boolean;
};

export type ListItemRange = TextRange & {
  index: number;
};

export interface RenderBlock {
  id: string;
  type: BlockType;
  content?: string;
  level?: number;
  items?: string[];
  ordered?: boolean;
  itemRanges?: ListItemRange[];
  headers?: string[];
  rows?: string[][];
  cellRanges?: CellRange[];
  startIndex: number;
  endIndex: number;
}

export interface ParsedBlocks {
  blocks: RenderBlock[];
  speakText: string;
}

const normalizeNewlines = (input: string) => input.replace(/\r\n?/g, "\n");

const stripZeroWidth = (input: string) =>
  input
    .replace(/\uFEFF/g, "")
    .replace(/[\u200B-\u200D\u2060]/g, "");

const normalizeHtmlLineBreaks = (input: string) => input.replace(/<br\s*\/?>/gi, "\n");

const stripHtmlTags = (input: string) => input.replace(/<[^>]+>/g, "");

const convertLinks = (input: string) => input.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");

const convertImages = (input: string) => input.replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1");

const stripInlineCodeMarkers = (input: string) => input.replace(/`([^`]+)`/g, "$1");

const stripEmphasisMarkers = (input: string) => input.replace(/(\*\*|__|\*|_)/g, "");

const collapseInlineWhitespace = (input: string) =>
  input.replace(/\s+/g, " ").trim();

const cleanInlineMarkdown = (input: string) =>
  collapseInlineWhitespace(
    stripHtmlTags(
      stripEmphasisMarkers(stripInlineCodeMarkers(convertLinks(convertImages(input))))
    )
  );

const parseTableRow = (line: string) => {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return null;
  const withoutOuter =
    trimmed.startsWith("|") && trimmed.endsWith("|") ? trimmed.slice(1, -1) : trimmed;
  return withoutOuter.split("|").map((c) => c.trim());
};

const isSeparatorRow = (line: string) => {
  const cells = parseTableRow(line);
  if (!cells) return false;
  return cells.every((c) => /^:?-{3,}:?$/.test(c));
};

const makeBlockId = (() => {
  let counter = 0;
  return () => `blk_${counter++}`;
})();

const addSpacer = (blocks: RenderBlock[]) => {
  if (blocks.length === 0) return;
  const last = blocks[blocks.length - 1];
  if (last.type === "spacer") return;
  blocks.push({
    id: makeBlockId(),
    type: "spacer",
    startIndex: -1,
    endIndex: -1,
  });
};

const parsePlainTextBlocks = (rawText: string): RenderBlock[] => {
  const text = normalizeNewlines(stripZeroWidth(rawText || ""));
  const paragraphs = text.split(/\n\s*\n/);
  const blocks: RenderBlock[] = [];

  for (const para of paragraphs) {
    const content = para
      .split("\n")
      .map((line) => line.trim())
      .join("\n")
      .trim();
    if (!content) continue;
    blocks.push({
      id: makeBlockId(),
      type: "paragraph",
      content,
      startIndex: -1,
      endIndex: -1,
    });
    addSpacer(blocks);
  }

  return blocks;
};

const parseMarkdownBlocks = (rawText: string): RenderBlock[] => {
  const text = normalizeNewlines(stripZeroWidth(normalizeHtmlLineBreaks(rawText || "")));
  const lines = text.split("\n");
  const blocks: RenderBlock[] = [];
  let i = 0;

  const isTableStart = (index: number) => {
    const header = parseTableRow(lines[index] ?? "");
    const separator = lines[index + 1];
    return !!header && !!separator && isSeparatorRow(separator);
  };

  while (i < lines.length) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();

    if (!trimmed) {
      i += 1;
      continue;
    }

    if (trimmed.startsWith("```")) {
      let codeContent = "";
      i += 1;
      while (i < lines.length && !(lines[i] || "").trim().startsWith("```")) {
        codeContent += lines[i] + "\n";
        i += 1;
      }
      i += 1;
      blocks.push({
        id: makeBlockId(),
        type: "code",
        content: codeContent.trimEnd(),
        startIndex: -1,
        endIndex: -1,
      });
      addSpacer(blocks);
      continue;
    }

    if (isTableStart(i)) {
      const headerCells = parseTableRow(lines[i] || "") ?? [];
      i += 2;
      const rows: string[][] = [];

      while (i < lines.length) {
        const rowCells = parseTableRow(lines[i] || "");
        if (!rowCells) break;
        rows.push(rowCells);
        i += 1;
      }

      blocks.push({
        id: makeBlockId(),
        type: "table",
        headers: headerCells.map((c) => cleanInlineMarkdown(c)),
        rows: rows.map((row) => row.map((c) => cleanInlineMarkdown(c))),
        startIndex: -1,
        endIndex: -1,
      });
      addSpacer(blocks);
      continue;
    }

    const headingMatch = trimmed.match(/^(#{1,6})\s+(.*)/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const content = cleanInlineMarkdown(headingMatch[2] ?? "");
      blocks.push({
        id: makeBlockId(),
        type: "heading",
        content,
        level,
        startIndex: -1,
        endIndex: -1,
      });
      addSpacer(blocks);
      i += 1;
      continue;
    }

    const listMatch = trimmed.match(/^(\*|-|\d+\.)\s+(.*)/);
    if (listMatch) {
      const items: string[] = [];
      const ordered = /^\d+\./.test(listMatch[1]);
      while (i < lines.length) {
        const itemMatch = (lines[i] || "").trim().match(/^(\*|-|\d+\.)\s+(.*)/);
        if (!itemMatch) break;
        items.push(cleanInlineMarkdown(itemMatch[2] ?? ""));
        i += 1;
      }
      blocks.push({
        id: makeBlockId(),
        type: "list",
        items,
        ordered,
        startIndex: -1,
        endIndex: -1,
      });
      addSpacer(blocks);
      continue;
    }

    let para = "";
    while (i < lines.length) {
      const nextLine = lines[i] ?? "";
      const nextTrim = nextLine.trim();
      if (!nextTrim) break;
      if (nextTrim.startsWith("```")) break;
      if (isTableStart(i)) break;
      if (/^#{1,6}\s+/.test(nextTrim)) break;
      if (/^(\*|-|\d+\.)\s+/.test(nextTrim)) break;
      para += nextLine + " ";
      i += 1;
    }
    const content = cleanInlineMarkdown(para);
    if (content) {
      blocks.push({
        id: makeBlockId(),
        type: "paragraph",
        content,
        startIndex: -1,
        endIndex: -1,
      });
      addSpacer(blocks);
    } else {
      i += 1;
    }
  }

  return blocks;
};

const applySpeechRules = (input: string, rules: Rule[], reflow: boolean) => {
  let text = applyRules(input, rules);
  if (reflow) text = reflowLineBreaks(text);
  return text;
};

const applyRulesAndBuildOffsets = (
  blocks: RenderBlock[],
  rules: Rule[],
  reflowLineBreaksEnabled: boolean
): ParsedBlocks => {
  let speakText = "";
  const processed: RenderBlock[] = [];

  const hasNextSpeakable = (startIndex: number) =>
    blocks.slice(startIndex + 1).some((b) => b.type !== "spacer" && b.type !== "code");

  for (let idx = 0; idx < blocks.length; idx += 1) {
    const block = blocks[idx];
    if (block.type === "spacer" || block.type === "code") {
      processed.push({ ...block, startIndex: -1, endIndex: -1 });
      continue;
    }

    if (block.type === "paragraph" || block.type === "heading") {
      const content = applySpeechRules(block.content || "", rules, reflowLineBreaksEnabled);
      const startIndex = speakText.length;
      speakText += content;
      const endIndex = speakText.length;
      processed.push({
        ...block,
        content,
        startIndex,
        endIndex,
      });
      if (hasNextSpeakable(idx)) speakText += "\n\n";
      continue;
    }

    if (block.type === "list") {
      const items = (block.items ?? []).map((item) =>
        applySpeechRules(item, rules, reflowLineBreaksEnabled)
      );
      const itemRanges: ListItemRange[] = [];
      const startIndex = speakText.length;
      items.forEach((item, index) => {
        const itemStart = speakText.length;
        speakText += item;
        const itemEnd = speakText.length;
        itemRanges.push({ index, startIndex: itemStart, endIndex: itemEnd });
        if (index < items.length - 1) speakText += "\n";
      });
      const endIndex = speakText.length;
      processed.push({
        ...block,
        items,
        itemRanges,
        startIndex,
        endIndex,
      });
      if (hasNextSpeakable(idx)) speakText += "\n\n";
      continue;
    }

    if (block.type === "table") {
      const headers = (block.headers ?? []).map((cell) =>
        applySpeechRules(cell, rules, reflowLineBreaksEnabled)
      );
      const rows = (block.rows ?? []).map((row) =>
        row.map((cell) => applySpeechRules(cell, rules, reflowLineBreaksEnabled))
      );
      const cellRanges: CellRange[] = [];

      const startIndex = speakText.length;
      headers.forEach((cell, col) => {
        const cellStart = speakText.length;
        speakText += cell;
        const cellEnd = speakText.length;
        cellRanges.push({ row: 0, col, startIndex: cellStart, endIndex: cellEnd, isHeader: true });
        if (col < headers.length - 1) speakText += " ";
      });
      if (headers.length > 0) speakText += "\n";

      rows.forEach((row, rowIdx) => {
        row.forEach((cell, col) => {
          const cellStart = speakText.length;
          speakText += cell;
          const cellEnd = speakText.length;
          cellRanges.push({ row: rowIdx + 1, col, startIndex: cellStart, endIndex: cellEnd });
          if (col < row.length - 1) speakText += " ";
        });
        if (rowIdx < rows.length - 1) speakText += "\n";
      });

      const endIndex = speakText.length;
      processed.push({
        ...block,
        headers,
        rows,
        cellRanges,
        startIndex,
        endIndex,
      });
      if (hasNextSpeakable(idx)) speakText += "\n\n";
    }
  }

  return { blocks: processed, speakText };
};

export function buildReaderModel(
  rawText: string,
  isMarkdown: boolean,
  rules: Rule[],
  reflowLineBreaksEnabled: boolean
): ParsedBlocks {
  const normalized = stripChapterTemplateHeader(rawText || "");
  const blocks = isMarkdown ? parseMarkdownBlocks(normalized) : parsePlainTextBlocks(normalized);
  return applyRulesAndBuildOffsets(blocks, rules, reflowLineBreaksEnabled);
}

export function buildSpeakTextFromContent(
  rawText: string,
  isMarkdown: boolean,
  rules: Rule[],
  reflowLineBreaksEnabled: boolean
): string {
  return buildReaderModel(rawText, isMarkdown, rules, reflowLineBreaksEnabled).speakText;
}
