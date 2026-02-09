import { AudioChunkMetadata, Cue, CueMap } from "../types";

export function cueMapFromChunkMap(
  chapterId: string,
  chunkMap: AudioChunkMetadata[],
  introOffsetMs: number = 0,
  version = 1
): CueMap {
  let cumulative = introOffsetMs;
  let totalMs = introOffsetMs;
  const cues: Cue[] = [];
  for (const chunk of chunkMap) {
    cues.push({ tMs: cumulative, startChar: chunk.startChar, endChar: chunk.endChar });
    const segMs = Math.floor(chunk.durSec * 1000);
    cumulative += segMs;
    totalMs += segMs;
  }
  return {
    chapterId,
    cues,
    version,
    generatedAt: Date.now(),
    method: "timepoints",
    introOffsetMs,
    durationMs: totalMs,
  };
}

type Segment = { startChar: number; endChar: number };

export function segmentTextForCues(text: string): Segment[] {
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
  while ((match = re.exec(text)) !== null) {
    const segText = match[0];
    const start = match.index;
    const end = start + segText.length;
    segments.push({ startChar: start, endChar: end });
  }
  if (segments.length === 0) {
    segments.push({ startChar: 0, endChar: text.length });
  }
  return segments;
}

function splitSegmentByDelimiters(text: string, baseOffset: number): Segment[] {
  const splits: Segment[] = [];
  const re = /[,;:\u2014\u2013]/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const end = match.index + 1;
    if (end - lastIndex > 0) {
      splits.push({ startChar: baseOffset + lastIndex, endChar: baseOffset + end });
    }
    lastIndex = end;
  }
  if (lastIndex < text.length) {
    splits.push({ startChar: baseOffset + lastIndex, endChar: baseOffset + text.length });
  }
  return splits;
}

function splitSegmentByMaxLength(seg: Segment, maxLen: number): Segment[] {
  const length = seg.endChar - seg.startChar;
  if (length <= maxLen) return [seg];
  const out: Segment[] = [];
  let start = seg.startChar;
  while (start < seg.endChar) {
    const end = Math.min(seg.endChar, start + maxLen);
    out.push({ startChar: start, endChar: end });
    start = end;
  }
  return out;
}

export function generateFallbackCueMap(params: {
  chapterId: string;
  text: string;
  durationMs: number;
  targetCueCount?: number;
  introOffsetMs?: number;
  version?: number;
}): CueMap {
  const { chapterId, text, durationMs, targetCueCount, introOffsetMs = 0, version = 1 } = params;
  const baseSegments = segmentTextForCues(text);
  if (baseSegments.length === 0) {
    return {
      chapterId,
      cues: [],
      version,
      generatedAt: Date.now(),
      method: "fallback",
      introOffsetMs,
    };
  }

  const desiredCount =
    typeof targetCueCount === "number" && targetCueCount > 0
      ? targetCueCount
      : Math.max(30, Math.min(400, Math.floor(text.length / 180)));

  let segments = [...baseSegments];

  if (segments.length < desiredCount) {
    const expanded: Segment[] = [];
    for (const seg of segments) {
      const segText = text.slice(seg.startChar, seg.endChar);
      const split = splitSegmentByDelimiters(segText, seg.startChar);
      expanded.push(...split);
    }
    segments = expanded;
  }

  if (segments.length < desiredCount) {
    const maxLen = 200;
    const expanded: Segment[] = [];
    for (const seg of segments) {
      expanded.push(...splitSegmentByMaxLength(seg, maxLen));
    }
    segments = expanded;
  }

  if (segments.length === 0) {
    segments = [{ startChar: 0, endChar: text.length }];
  }

  const available = Math.max(0, durationMs - introOffsetMs);
  const minSlice = 300; // ms
  const totalChars = segments.reduce((acc, s) => acc + Math.max(1, s.endChar - s.startChar), 0);

  let rawSlices = segments.map((seg) => {
    const segChars = Math.max(1, seg.endChar - seg.startChar);
    const share = available * (segChars / totalChars);
    return Math.max(minSlice, Math.floor(share));
  });

  const totalSlices = rawSlices.reduce((a, b) => a + b, 0);
  if (totalSlices > available && segments.length > 0) {
    const minTotal = minSlice * segments.length;
    const adjustable = Math.max(1, totalSlices - minTotal);
    const scale = Math.max(0, (available - minTotal) / adjustable);
    rawSlices = rawSlices.map((slice) => Math.max(minSlice, Math.floor(minSlice + (slice - minSlice) * scale)));
  }

  let cumulative = introOffsetMs;
  const cues: Cue[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    cues.push({ tMs: Math.min(Math.max(0, cumulative), durationMs), startChar: seg.startChar, endChar: seg.endChar });
    cumulative += rawSlices[i] ?? minSlice;
  }

  return {
    chapterId,
    cues,
    version,
    generatedAt: Date.now(),
    method: "fallback",
    introOffsetMs,
    durationMs,
  };
}

export function cueMapFallback(
  text: string,
  durationMs: number,
  chapterId: string,
  introOffsetMs: number = 0,
  version = 1
): CueMap {
  return generateFallbackCueMap({
    chapterId,
    text,
    durationMs,
    introOffsetMs,
    version,
  });
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
