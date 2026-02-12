export type Chunk = { id: string; text: string; start: number; end: number };

const SENTENCE_END = new Set([".", "!", "?", "…"]);

function isWhitespace(ch: string): boolean {
  return ch === " " || ch === "\n" || ch === "\t" || ch === "\v" || ch === "\f";
}

function isSentenceStart(ch: string): boolean {
  // Keep this conservative and WebView-friendly (no Unicode property escapes).
  // Includes common quote/bracket starters used in novels.
  return /[A-Z0-9“”"'\u2018\u2019(\[]/.test(ch);
}

export function buildChunks(fullText: string): Chunk[] {
  const text = fullText.replace(/\r\n?/g, "\n");
  const len = text.length;
  if (len === 0) return [];

  const chunks: Chunk[] = [];

  let start = 0;
  let i = 0;

  const push = (end: number) => {
    if (end <= start) return;
    chunks.push({
      id: `c_${start}`,
      text: text.slice(start, end),
      start,
      end,
    });
    start = end;
  };

  while (i < len) {
    // Paragraph break: two or more newlines.
    if (text[i] === "\n") {
      let j = i;
      while (j < len && text[j] === "\n") j++;
      if (j - i >= 2) {
        push(j);
        i = start;
        continue;
      }
    }

    const ch = text[i];
    if (!SENTENCE_END.has(ch)) {
      i += 1;
      continue;
    }

    // Consume repeated sentence-ending punctuation (e.g., "...", "!!").
    let j = i + 1;
    while (j < len && SENTENCE_END.has(text[j])) j++;

    if (j >= len || !isWhitespace(text[j])) {
      i += 1;
      continue;
    }

    // Include trailing whitespace in the chunk; next chunk starts at first non-whitespace.
    let k = j;
    while (k < len && isWhitespace(text[k])) k++;

    if (k >= len) {
      push(len);
      break;
    }

    if (isSentenceStart(text[k])) {
      push(k);
      i = start;
      continue;
    }

    i += 1;
  }

  if (start < len) push(len);
  return chunks;
}

export function chunkIndexFromChar(chunks: Chunk[], charIndex: number): number {
  if (!chunks.length) return 0;

  const idx = Number.isFinite(charIndex) ? Math.floor(charIndex) : 0;
  if (idx <= 0) return 0;

  const last = chunks[chunks.length - 1];
  if (idx >= last.end) return chunks.length - 1;

  let lo = 0;
  let hi = chunks.length - 1;

  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const c = chunks[mid];
    if (idx < c.start) {
      hi = mid - 1;
    } else if (idx >= c.end) {
      lo = mid + 1;
    } else {
      return mid;
    }
  }

  return Math.max(0, Math.min(lo, chunks.length - 1));
}

