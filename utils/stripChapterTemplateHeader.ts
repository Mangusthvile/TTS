const normalizeNewlines = (input: string) => input.replace(/\r\n?/g, "\n");

// Strips a common import template header:
// "Chapter {n}: {title}" then a blank line.
export function stripChapterTemplateHeader(input: string): string {
  const text = normalizeNewlines(input ?? "");
  const lines = text.split("\n");
  if (lines.length < 2) return input;

  const firstNonEmptyIdx = lines.findIndex((l) => l.trim().length > 0);
  if (firstNonEmptyIdx !== 0) {
    // Only strip when it's the very first line, to avoid deleting in-story text.
    return input;
  }

  const first = lines[0].trim();
  const second = lines[1];
  const looksLikeHeader = /^chapter\s+\d+(\s*[:.\-]\s*|\s+).+/i.test(first);
  const followedByBlank = second.trim().length === 0;
  if (!looksLikeHeader || !followedByBlank) return input;

  const rest = lines.slice(2).join("\n");
  return rest.replace(/^\n+/, "");
}

