import { AudioChunkMetadata, Cue, CueMap } from "../types";

export function cueMapFromChunkMap(
  chapterId: string,
  chunkMap: AudioChunkMetadata[],
  introOffsetMs: number = 0,
  version = 1
): CueMap {
  let cumulative = introOffsetMs;
  const cues: Cue[] = [];
  for (const chunk of chunkMap) {
    cues.push({ tMs: cumulative, startChar: chunk.startChar, endChar: chunk.endChar });
    cumulative += Math.floor(chunk.durSec * 1000);
  }
  return {
    chapterId,
    cues,
    version,
    generatedAt: Date.now(),
    method: "chunkmap",
    introOffsetMs,
  };
}

type Segment = { startChar: number; endChar: number };

export function segmentText(text: string): Segment[] {
  if (!text) return [];

  // Prefer Intl.Segmenter for sentence granularity
  try {
    const seg = (Intl as any)?.Segmenter ? new (Intl as any).Segmenter("en", { granularity: "sentence" }) : null;
    if (seg) {
      const segments: Segment[] = [];
      let offset = 0;
      for (const part of seg.segment(text)) {
        const start = (part as any).index ?? offset;
        const end = start + String(part.segment ?? "").length;
        segments.push({ startChar: start, endChar: end });
        offset = end;
      }
      if (segments.length) return segments;
    }
  } catch {
    // ignore and fallback
  }

  // Fallback regex-based sentence split while keeping offsets
  const re = /[^.!?]+[.!?\u2026]?\s*/g;
  const segments: Segment[] = [];
  let match: RegExpExecArray | null;
  let idx = 0;
  while ((match = re.exec(text)) !== null) {
    const segText = match[0];
    const start = match.index;
    const end = start + segText.length;
    segments.push({ startChar: start, endChar: end });
    idx++;
  }
  if (segments.length === 0) {
    segments.push({ startChar: 0, endChar: text.length });
  }
  return segments;
}

export function cueMapFallback(
  text: string,
  durationMs: number,
  chapterId: string,
  introOffsetMs: number = 0,
  version = 1
): CueMap {
  const segments = segmentText(text);
  if (segments.length === 0) {
    return {
      chapterId,
      cues: [],
      version,
      generatedAt: Date.now(),
      method: "fallback",
      introOffsetMs,
    };
  }

  const totalChars = segments.reduce((acc, s) => acc + Math.max(1, s.endChar - s.startChar), 0);
  const minSlice = 120; // ms
  const available = Math.max(0, durationMs - introOffsetMs);

  let cumulative = introOffsetMs;
  const cues: Cue[] = [];
  for (const seg of segments) {
    cues.push({ tMs: cumulative, startChar: seg.startChar, endChar: seg.endChar });
    const segChars = Math.max(1, seg.endChar - seg.startChar);
    const share = available * (segChars / totalChars);
    const slice = Math.max(minSlice, Math.floor(share));
    cumulative += slice;
  }

  return {
    chapterId,
    cues,
    version,
    generatedAt: Date.now(),
    method: "fallback",
    introOffsetMs,
  };
}

export function findCueIndex(cues: Cue[], positionMs: number): number {
  if (!cues.length) return 0;
  let lo = 0;
  let hi = cues.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].tMs <= positionMs) {
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return Math.max(0, Math.min(cues.length - 1, hi));
}
