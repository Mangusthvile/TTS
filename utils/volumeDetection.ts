export type DetectedVolumeMeta = {
  volumeName: string | null;
  volumeNumber: number | null;
  volumeLocalChapter: number | null;
  title: string | null;
};

const normalizeSpaces = (input: string) => input.replace(/\s+/g, " ").trim();

function parsePositiveInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
  if (typeof value !== "string") return null;
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function extractFromHeader(firstLine: string): DetectedVolumeMeta | null {
  const line = normalizeSpaces(firstLine || "");
  if (!line) return null;

  // Examples:
  // "Book 1: Chapter 1: Waiting for the End to Come"
  // "Volume 2 - Chapter 10 - A New Beginning"
  const m = line.match(
    /^(book|volume)\s*(\d+)\s*(?:[:\-–—]\s*)+chapter\s*(\d+)\s*(?:[:\-–—]\s*)+(.*)$/i
  );
  if (!m) return null;

  const kind = m[1]?.toLowerCase() === "volume" ? "Volume" : "Book";
  const volumeNumber = parsePositiveInt(m[2]);
  const volumeLocalChapter = parsePositiveInt(m[3]);
  const title = normalizeSpaces(m[4] || "");

  return {
    volumeName: volumeNumber ? `${kind} ${volumeNumber}` : null,
    volumeNumber,
    volumeLocalChapter,
    title: title || null,
  };
}

function extractFromFileName(fileName: string): DetectedVolumeMeta {
  const base = String(fileName || "");
  const withoutExt = base.replace(/\.(txt|md)$/i, "");

  const volMatch = withoutExt.match(/(?:^|[_\s-])(book|volume)[_\s-]*(\d+)/i);
  const volumeNumber = parsePositiveInt(volMatch?.[2]);
  const volumeName =
    volumeNumber && volMatch
      ? `${volMatch[1]?.toLowerCase() === "volume" ? "Volume" : "Book"} ${volumeNumber}`
      : null;

  const chMatch = withoutExt.match(/chapter[_\s-]*(\d+)/i);
  const volumeLocalChapter = parsePositiveInt(chMatch?.[1]);

  let title: string | null = null;
  const afterChapterMatch = withoutExt.match(/chapter[_\s-]*\d+[_\s-]*(.*)$/i);
  if (afterChapterMatch && afterChapterMatch[1]) {
    const raw = afterChapterMatch[1]
      .replace(/^[_\s-]+/, "")
      .replace(/[_]+/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim();
    if (raw) title = raw;
  }

  return { volumeName, volumeNumber, volumeLocalChapter, title };
}

export function detectVolumeMeta(fileName: string, firstLine: string): DetectedVolumeMeta {
  const header = extractFromHeader(firstLine);
  const fromName = extractFromFileName(fileName);

  return {
    volumeName: header?.volumeName ?? fromName.volumeName,
    volumeNumber: header?.volumeNumber ?? fromName.volumeNumber,
    volumeLocalChapter: header?.volumeLocalChapter ?? fromName.volumeLocalChapter,
    title: header?.title ?? fromName.title,
  };
}

export function sortForSmartUpload<T extends { fileName: string; meta: DetectedVolumeMeta }>(files: T[]): T[] {
  const copy = [...files];
  const NONE = 1_000_000_000;
  copy.sort((a, b) => {
    const aVol = a.meta.volumeNumber ?? NONE;
    const bVol = b.meta.volumeNumber ?? NONE;
    if (aVol !== bVol) return aVol - bVol;

    const aCh = a.meta.volumeLocalChapter ?? NONE;
    const bCh = b.meta.volumeLocalChapter ?? NONE;
    if (aCh !== bCh) return aCh - bCh;

    return String(a.fileName || "").localeCompare(String(b.fileName || ""), undefined, { numeric: true });
  });
  return copy;
}

