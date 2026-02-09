import type { CueMap, ParagraphMap, ParagraphRange } from "../types";
import {
  getChapterCueMap,
  saveChapterCueMap,
  deleteChapterCueMap,
  getChapterParagraphMap,
  saveChapterParagraphMap,
  deleteChapterParagraphMap,
} from "./libraryStore";

export async function getCueMap(chapterId: string): Promise<CueMap | null> {
  return getChapterCueMap(chapterId);
}

export async function saveCueMap(chapterId: string, cueMap: CueMap): Promise<void> {
  return saveChapterCueMap(chapterId, cueMap);
}

export async function deleteCueMap(chapterId: string): Promise<void> {
  return deleteChapterCueMap(chapterId);
}

export async function getParagraphMap(chapterId: string): Promise<ParagraphMap | null> {
  return getChapterParagraphMap(chapterId);
}

export async function saveParagraphMap(chapterId: string, paragraphMap: ParagraphMap): Promise<void> {
  return saveChapterParagraphMap(chapterId, paragraphMap);
}

export async function deleteParagraphMap(chapterId: string): Promise<void> {
  return deleteChapterParagraphMap(chapterId);
}

function isHtmlParagraphText(text: string): boolean {
  return /<p[\s>]/i.test(text);
}

function clampRange(start: number, end: number): { start: number; end: number } {
  const s = Math.max(0, start);
  const e = Math.max(s, end);
  return { start: s, end: e };
}

function trimRange(text: string, start: number, end: number): { start: number; end: number } {
  let s = start;
  let e = end;
  while (s < e && /\s/.test(text[s])) s += 1;
  while (e > s && /\s/.test(text[e - 1])) e -= 1;
  return { start: s, end: e };
}

function buildParagraphsFromHtml(text: string): ParagraphRange[] {
  const ranges: ParagraphRange[] = [];
  const openTag = /<p\b[^>]*>/gi;
  let match: RegExpExecArray | null;
  let pIndex = 0;
  while ((match = openTag.exec(text)) !== null) {
    const openEnd = match.index + match[0].length;
    const closeTag = /<\/p\s*>/gi;
    closeTag.lastIndex = openEnd;
    const closeMatch = closeTag.exec(text);
    if (!closeMatch) break;
    const closeStart = closeMatch.index;
    const { start, end } = trimRange(text, openEnd, closeStart);
    const clamped = clampRange(start, end);
    if (clamped.end > clamped.start) {
      ranges.push({ pIndex, startChar: clamped.start, endChar: clamped.end });
      pIndex += 1;
    }
    openTag.lastIndex = closeMatch.index + closeMatch[0].length;
  }
  return ranges;
}

function buildParagraphsFromBlankLines(text: string): ParagraphRange[] {
  const ranges: ParagraphRange[] = [];
  const re = /\r?\n\s*\r?\n+/g;
  let lastIndex = 0;
  let pIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const segmentStart = lastIndex;
    const segmentEnd = match.index;
    const { start, end } = trimRange(text, segmentStart, segmentEnd);
    const clamped = clampRange(start, end);
    if (clamped.end > clamped.start) {
      ranges.push({ pIndex, startChar: clamped.start, endChar: clamped.end });
      pIndex += 1;
    }
    lastIndex = match.index + match[0].length;
  }
  const { start, end } = trimRange(text, lastIndex, text.length);
  const clamped = clampRange(start, end);
  if (clamped.end > clamped.start) {
    ranges.push({ pIndex, startChar: clamped.start, endChar: clamped.end });
  }
  return ranges;
}

export function buildParagraphMap(text: string, chapterId: string): ParagraphMap {
  let paragraphs: ParagraphRange[] = [];
  if (text) {
    if (isHtmlParagraphText(text)) {
      paragraphs = buildParagraphsFromHtml(text);
    }
    if (!paragraphs.length) {
      paragraphs = buildParagraphsFromBlankLines(text);
    }
  }

  if (!paragraphs.length) {
    paragraphs = [{ pIndex: 0, startChar: 0, endChar: Math.max(0, text.length) }];
  }

  return {
    chapterId,
    version: 1,
    generatedAt: Date.now(),
    paragraphs,
  };
}

export function findParagraphIndex(paragraphs: ParagraphRange[], offset: number): number {
  if (!paragraphs.length) return 0;
  let lo = 0;
  let hi = paragraphs.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const p = paragraphs[mid];
    if (offset < p.startChar) {
      hi = mid - 1;
    } else if (offset >= p.endChar) {
      lo = mid + 1;
    } else {
      return mid;
    }
  }
  return Math.max(0, Math.min(paragraphs.length - 1, hi));
}
