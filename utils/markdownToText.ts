const normalizeNewlines = (input: string) => input.replace(/\r\n?/g, "\n");

const stripZeroWidth = (input: string) =>
  input
    .replace(/\uFEFF/g, "") // BOM
    .replace(/[\u200B-\u200D\u2060]/g, ""); // ZWSP/ZWNJ/ZWJ/WORD JOINER

const stripFencedCodeBlocks = (input: string) => input.replace(/```[\s\S]*?```/g, "");

const normalizeHtmlLineBreaks = (input: string) => input.replace(/<br\s*\/?>/gi, "\n");

const stripHtmlTags = (input: string) => input.replace(/<[^>]+>/g, "");

const stripInlineCodeMarkers = (input: string) => input.replace(/`([^`]+)`/g, "$1");

const stripEmphasisMarkers = (input: string) => input.replace(/(\*\*|__|\*|_)/g, "");

const stripMarkdownHeadings = (input: string) => input.replace(/^\s{0,3}#{1,6}\s+/gm, "");

const stripBlockquoteMarkers = (input: string) => input.replace(/^\s{0,3}>\s?/gm, "");

const stripListMarkers = (input: string) =>
  input
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "");

const convertLinks = (input: string) => input.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");

const convertImages = (input: string) => input.replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1");

const collapseWhitespace = (input: string) =>
  input
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

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

const convertGfmTables = (input: string) => {
  const lines = normalizeNewlines(input).split("\n");
  const out: string[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const next = lines[i + 1];
    const headerCells = parseTableRow(line);

    if (!headerCells || !next || !isSeparatorRow(next)) {
      out.push(line);
      continue;
    }

    const headers = headerCells.map((h) => stripEmphasisMarkers(stripInlineCodeMarkers(h)));
    const tableLines: string[] = [];
    i += 2; // skip header + separator

    while (i < lines.length) {
      const rowCells = parseTableRow(lines[i]);
      if (!rowCells) break;
      const cells = rowCells.map((c) => stripEmphasisMarkers(stripInlineCodeMarkers(convertLinks(c))));

      if (cells.length === 1) {
        const value = cells[0];
        if (value) tableLines.push(value);
        i += 1;
        continue;
      }

      if (cells.length >= 2) {
        // Common stat-sheet format: Label | Value
        if (cells.length === 2 && headers.length === 2) {
          const label = cells[0];
          const value = cells[1];
          if (label && value) tableLines.push(`${label}: ${value}`);
        } else {
          const parts: string[] = [];
          for (let c = 0; c < Math.min(headers.length, cells.length); c += 1) {
            const h = headers[c];
            const v = cells[c];
            if (!v) continue;
            if (h) parts.push(`${h}: ${v}`);
            else parts.push(v);
          }
          if (parts.length > 0) tableLines.push(parts.join(", "));
        }
      }

      i += 1;
    }

    i -= 1; // let outer loop advance
    if (tableLines.length > 0) {
      out.push("");
      out.push(...tableLines);
      out.push("");
    }
  }

  return out.join("\n");
};

export function markdownToPlainText(markdown: string): string {
  let text = markdown ?? "";
  text = normalizeNewlines(text);
  text = stripZeroWidth(text);
  text = stripFencedCodeBlocks(text);
  text = convertGfmTables(text);
  text = normalizeHtmlLineBreaks(text);
  text = convertImages(text);
  text = convertLinks(text);
  text = stripMarkdownHeadings(text);
  text = stripBlockquoteMarkers(text);
  text = stripListMarkers(text);
  text = stripInlineCodeMarkers(text);
  text = stripEmphasisMarkers(text);
  text = stripHtmlTags(text);
  return collapseWhitespace(text);
}
