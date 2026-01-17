export function reflowLineBreaks(text: string): string {
  if (!text) return "";

  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // Split on blank lines (paragraph breaks). Keep paragraphs, reflow single line breaks inside them.
  const paragraphs = normalized.split(/\n{2,}/g);

  const cleaned = paragraphs
    .map((p) =>
      p
        .replace(/\n+/g, " ")
        .replace(/[ \t]+/g, " ")
        .trim()
    )
    .filter((p) => p.length > 0);

  return cleaned.join("\n\n");
}