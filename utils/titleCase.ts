const WORD_START_RE = /[A-Za-z\u00C0-\u00FF]/;

export function toTitleCase(input: string): string {
  if (typeof input !== "string") return "";
  const normalized = input.replace(/\s+/g, " ").trim();
  if (!normalized) return "";

  return normalized
    .split(" ")
    .map((word) => {
      const matchIndex = word.search(WORD_START_RE);
      if (matchIndex === -1) return word;
      const first = word.slice(matchIndex, matchIndex + 1).toUpperCase();
      const rest = word.slice(matchIndex + 1).toLowerCase();
      return `${word.slice(0, matchIndex)}${first}${rest}`;
    })
    .join(" ");
}

export function normalizeChapterTitle(
  rawTitle: string | null | undefined,
  fallback?: string
): string {
  const base = typeof rawTitle === "string" ? rawTitle : "";
  const titled = toTitleCase(base);
  if (titled.length > 0) return titled;
  return fallback ? toTitleCase(fallback) : "";
}
