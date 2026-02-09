import React, { useEffect, useRef, useMemo, useState } from 'react';
import { Chapter, Rule, Theme, HighlightMode, ReaderSettings, ParagraphMap } from '../types';
import { applyRules } from '../services/speechService';
import { reflowLineBreaks } from '../services/textFormat';
import { Bug, Plus, ChevronLeft, ArrowDownCircle, MoreVertical } from 'lucide-react';

interface ReaderProps {
  chapter: Chapter | null;
  rules: Rule[];
  activeHighlightRange?: { start: number; end: number } | null;
  activeCueIndex?: number | null;
  activeParagraphIndex?: number | null;
  paragraphMap?: ParagraphMap | null;
  cueMeta?: { method?: string; count?: number };
  onRegenerateCueMap?: () => void;
  highlightReady?: boolean;
  highlightEnabled?: boolean;
  highlightDebugData?: {
    positionMs: number;
    durationMs: number;
    cueIndex: number | null;
    cueCount: number;
    paragraphIndex: number | null;
    paragraphCount: number;
    mode: HighlightMode;
    isPlaying: boolean;
  };
  theme: Theme;
  debugMode: boolean;
  onToggleDebug: () => void;
  onJumpToOffset: (offset: number) => void;
  onBackToCollection?: () => void;
  onAddChapter?: () => void;
  highlightMode: HighlightMode;
  readerSettings: ReaderSettings;
  isMobile: boolean;
}

type ParagraphSlice = {
  pIndex: number;
  startChar: number;
  endChar: number;
  text: string;
};

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const cleaned = hex.replace('#', '').trim();
  if (cleaned.length === 3) {
    const r = parseInt(cleaned[0] + cleaned[0], 16);
    const g = parseInt(cleaned[1] + cleaned[1], 16);
    const b = parseInt(cleaned[2] + cleaned[2], 16);
    return { r, g, b };
  }
  if (cleaned.length === 6) {
    const r = parseInt(cleaned.slice(0, 2), 16);
    const g = parseInt(cleaned.slice(2, 4), 16);
    const b = parseInt(cleaned.slice(4, 6), 16);
    return { r, g, b };
  }
  return null;
}

function rgbaFromHex(hex: string, alpha: number): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return `rgba(79,70,229,${alpha})`;
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
}

function readableTextColor(hex: string): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return '#ffffff';
  const luminance = (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255;
  return luminance > 0.6 ? '#111827' : '#ffffff';
}

const Reader: React.FC<ReaderProps> = ({
  chapter,
  rules,
  activeHighlightRange,
  activeCueIndex,
  activeParagraphIndex,
  paragraphMap,
  cueMeta,
  onRegenerateCueMap,
  highlightReady = false,
  highlightEnabled = true,
  highlightDebugData,
  theme,
  debugMode,
  onToggleDebug,
  onJumpToOffset,
  onBackToCollection,
  onAddChapter,
  highlightMode,
  readerSettings,
  isMobile
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const userScrollingRef = useRef<boolean>(false);
  const scrollTimeoutRef = useRef<number | null>(null);
  const highlightRef = useRef<HTMLSpanElement | null>(null);
  const [showResumeButton, setShowResumeButton] = useState(false);
  const [showToolsMenu, setShowToolsMenu] = useState(false);
  const warnedRangeRef = useRef<string | null>(null);
  const warnedParagraphRef = useRef<string | null>(null);

  const speakText = useMemo(() => {
    if (!chapter) return "";
    const ruled = applyRules((chapter.content ?? ""), rules);
    return readerSettings.reflowLineBreaks ? reflowLineBreaks(ruled) : ruled;
  }, [chapter, rules, readerSettings.reflowLineBreaks]);

  const canUseParagraphs = !!paragraphMap && paragraphMap.paragraphs?.length > 0;
  const effectiveMode = useMemo(() => {
    if (!highlightEnabled) return HighlightMode.WORD;
    if (!canUseParagraphs && (highlightMode === HighlightMode.SENTENCE || highlightMode === HighlightMode.KARAOKE)) {
      return HighlightMode.WORD;
    }
    return highlightMode;
  }, [highlightMode, canUseParagraphs, highlightEnabled]);

  const paragraphs: ParagraphSlice[] = useMemo(() => {
    if (!speakText) return [];
    if (canUseParagraphs) {
      return paragraphMap!.paragraphs.map((p) => {
        const start = Math.max(0, Math.min(p.startChar, speakText.length));
        const end = Math.max(start, Math.min(p.endChar, speakText.length));
        if ((start !== p.startChar || end !== p.endChar) && chapter?.id) {
          const key = `${chapter.id}-${speakText.length}`;
          if (warnedParagraphRef.current !== key) {
            warnedParagraphRef.current = key;
            console.warn("[Highlight] paragraph range clamped", {
              chapterId: chapter.id,
              startChar: p.startChar,
              endChar: p.endChar,
              textLen: speakText.length,
            });
          }
        }
        return {
          pIndex: p.pIndex,
          startChar: start,
          endChar: end,
          text: speakText.slice(start, end),
        };
      });
    }
    return [{
      pIndex: 0,
      startChar: 0,
      endChar: speakText.length,
      text: speakText,
    }];
  }, [speakText, canUseParagraphs, paragraphMap]);

  const safeHighlightRange = useMemo(() => {
    if (!highlightEnabled || !activeHighlightRange || !speakText) return null;
    const textLen = speakText.length;
    const start = Math.max(0, Math.min(activeHighlightRange.start, textLen));
    const end = Math.max(start, Math.min(activeHighlightRange.end, textLen));
    if ((activeHighlightRange.start < 0 || activeHighlightRange.end > textLen) && chapter?.id) {
      const key = `${chapter.id}-${textLen}`;
      if (warnedRangeRef.current !== key) {
        warnedRangeRef.current = key;
        console.warn("[Highlight] range clamped", {
          chapterId: chapter.id,
          range: activeHighlightRange,
          textLen,
        });
      }
    }
    return { start, end };
  }, [activeHighlightRange, speakText, chapter?.id, highlightEnabled]);

  const themeTokens = useMemo(() => {
    const strong = readerSettings.highlightColor || '#4f46e5';
    const strongText = readableTextColor(strong);
    const weak = rgbaFromHex(strong, theme === Theme.DARK ? 0.25 : 0.18);
    return {
      highlightStrong: strong,
      highlightStrongText: strongText,
      highlightWeak: weak,
      text: theme === Theme.DARK ? '#e2e8f0' : theme === Theme.SEPIA ? '#3c2f25' : '#111827',
      muted: theme === Theme.DARK ? '#94a3b8' : '#6b7280',
    };
  }, [readerSettings.highlightColor, theme]);

  const containerStyles: React.CSSProperties = {
    fontFamily: readerSettings.fontFamily,
    fontSize: `clamp(18px, 4.5vw, ${readerSettings.fontSizePx}px)`,
    lineHeight: readerSettings.lineHeight,
    ['--highlight-strong' as any]: themeTokens.highlightStrong,
    ['--highlight-weak' as any]: themeTokens.highlightWeak,
    ['--highlight-strong-text' as any]: themeTokens.highlightStrongText,
  };

  const paragraphClass =
    readerSettings.paragraphSpacing === 0 ? 'space-y-0' :
    readerSettings.paragraphSpacing === 1 ? 'space-y-2' :
    readerSettings.paragraphSpacing === 2 ? 'space-y-6' :
    'space-y-10';

  const fadeColor = theme === Theme.DARK ? 'from-slate-900' : theme === Theme.SEPIA ? 'from-[#efe6d5]' : 'from-white';

  const scrollToActive = () => {
    const container = containerRef.current;
    if (!container) return;
    const target =
      highlightRef.current ||
      (container.querySelector('[data-active-paragraph="true"]') as HTMLElement | null);
    if (!target) return;
    const cRect = container.getBoundingClientRect();
    const tRect = target.getBoundingClientRect();
    const padding = 60;
    if (tRect.top < cRect.top + padding || tRect.bottom > cRect.bottom - padding) {
      target.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  };

  // Follow highlight if enabled and not user scrolling
  useEffect(() => {
    if (!highlightEnabled || !readerSettings.followHighlight || userScrollingRef.current) return;
    scrollToActive();
  }, [activeCueIndex, activeParagraphIndex, readerSettings.followHighlight, effectiveMode, highlightEnabled]);

  const handleResumeAutoScroll = () => {
    userScrollingRef.current = false;
    setShowResumeButton(false);
    scrollToActive();
  };

  const handleScroll = () => {
    userScrollingRef.current = true;
    if (isMobile) setShowResumeButton(true);
    if (scrollTimeoutRef.current) window.clearTimeout(scrollTimeoutRef.current);
    if (!isMobile) {
      const cooldown = 1500;
      scrollTimeoutRef.current = window.setTimeout(() => {
        userScrollingRef.current = false;
      }, cooldown);
    }
  };

  const handleBack = () => {
    console.log('[TaleVox][Reader] back_to_collection');
    if (onBackToCollection) onBackToCollection();
  };

  const triggerJump = () => {
    if (isMobile) return;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    const container = range.startContainer;
    const anchor =
      (container as Element)?.closest?.('[data-base]') ??
      (container as any)?.parentElement?.closest?.('[data-base]');
    if (!anchor) return;
    const baseOffset = parseInt((anchor as HTMLElement).dataset.base || '0', 10);
    const globalOffset = baseOffset + range.startOffset;
    onJumpToOffset(globalOffset);
    selection.removeAllRanges();
  };

  const renderParagraph = (p: ParagraphSlice) => {
    const isActiveParagraph = activeParagraphIndex === p.pIndex || !canUseParagraphs;
    const highlightRange = safeHighlightRange;
    const hasCue = !!highlightRange;

    const paragraphClassName = `leading-relaxed rounded-md px-1 -mx-1 ${isActiveParagraph && (effectiveMode === HighlightMode.SENTENCE || effectiveMode === HighlightMode.KARAOKE) ? 'bg-[var(--highlight-weak)]' : ''}`;

    if (effectiveMode === HighlightMode.SENTENCE) {
      return (
        <p key={p.pIndex} data-base={p.startChar} data-active-paragraph={isActiveParagraph ? 'true' : 'false'} className={paragraphClassName}>
          <span data-base={p.startChar}>{p.text}</span>
        </p>
      );
    }

    if (effectiveMode === HighlightMode.KARAOKE && isActiveParagraph && hasCue) {
      const localStart = Math.max(0, Math.min(highlightRange.start - p.startChar, p.text.length));
      const localEnd = Math.max(localStart, Math.min(highlightRange.end - p.startChar, p.text.length));
      const before = p.text.slice(0, localStart);
      const mid = p.text.slice(localStart, localEnd);
      const after = p.text.slice(localEnd);
      return (
        <p key={p.pIndex} data-base={p.startChar} data-active-paragraph="true" className={`${paragraphClassName}`}>
          {before && <span data-base={p.startChar}>{before}</span>}
          <span
            ref={highlightRef}
            data-base={p.startChar + localStart}
            className="rounded px-0.5 shadow-sm"
            style={{ backgroundColor: 'var(--highlight-strong)', color: 'var(--highlight-strong-text)' }}
          >
            {mid || " "}
          </span>
          {after && <span data-base={p.startChar + localEnd}>{after}</span>}
        </p>
      );
    }

    if (effectiveMode === HighlightMode.WORD && hasCue && isActiveParagraph) {
      const localStart = Math.max(0, Math.min(highlightRange.start - p.startChar, p.text.length));
      const localEnd = Math.max(localStart, Math.min(highlightRange.end - p.startChar, p.text.length));
      const before = p.text.slice(0, localStart);
      const mid = p.text.slice(localStart, localEnd);
      const after = p.text.slice(localEnd);
      return (
        <p key={p.pIndex} data-base={p.startChar} data-active-paragraph={isActiveParagraph ? 'true' : 'false'} className="leading-relaxed">
          {before && <span data-base={p.startChar}>{before}</span>}
          <span
            ref={highlightRef}
            data-base={p.startChar + localStart}
            className="rounded px-0.5 shadow-sm"
            style={{ backgroundColor: 'var(--highlight-strong)', color: 'var(--highlight-strong-text)' }}
          >
            {mid || " "}
          </span>
          {after && <span data-base={p.startChar + localEnd}>{after}</span>}
        </p>
      );
    }

    return (
      <p key={p.pIndex} data-base={p.startChar} data-active-paragraph={isActiveParagraph ? 'true' : 'false'} className="leading-relaxed">
        <span data-base={p.startChar}>{p.text}</span>
      </p>
    );
  };

  const showHighlightPending = highlightEnabled && !!chapter && !highlightReady;
  const showHighlightOverlay = !!readerSettings.highlightDebugOverlay && !!highlightDebugData;

  return (
    <div className="relative flex-1 flex flex-col min-h-0 overflow-hidden touch-manipulation text-theme">
      <div className={`absolute top-0 left-0 right-0 h-16 lg:h-24 z-10 pointer-events-none bg-gradient-to-b ${fadeColor} to-transparent`} />
      {showHighlightOverlay && highlightDebugData && (
        <div
          className={`absolute bottom-5 right-5 z-20 rounded-xl border px-3 py-2 text-[10px] font-mono shadow-xl ${
            theme === Theme.DARK
              ? 'bg-slate-900/90 border-slate-700 text-slate-100'
              : theme === Theme.SEPIA
                ? 'bg-[#f7efdf]/95 border-[#d8ccb6] text-[#3b2f21]'
                : 'bg-white/90 border-black/10 text-slate-900'
          }`}
        >
          <div>pos: {Math.floor(highlightDebugData.positionMs)}ms / {Math.floor(highlightDebugData.durationMs)}ms</div>
          <div>cue: {highlightDebugData.cueIndex ?? '--'} / {highlightDebugData.cueCount}</div>
          <div>para: {highlightDebugData.paragraphIndex ?? '--'} / {highlightDebugData.paragraphCount}</div>
          <div>mode: {highlightDebugData.mode}</div>
          <div>playing: {highlightDebugData.isPlaying ? 'yes' : 'no'}</div>
        </div>
      )}

      {showResumeButton && isMobile && (
        <div className="absolute bottom-6 right-6 z-50 animate-in zoom-in duration-200">
          <button
            onClick={handleResumeAutoScroll}
            className="flex items-center gap-2 px-4 py-3 bg-indigo-600 text-white rounded-full shadow-2xl font-black uppercase text-[10px] tracking-widest hover:scale-105 active:scale-95 transition-transform"
          >
            <ArrowDownCircle className="w-4 h-4" /> Resume
          </button>
        </div>
      )}

      <div
        ref={containerRef}
        onScroll={handleScroll}
        onTouchStart={() => { userScrollingRef.current = true; if (isMobile) setShowResumeButton(true); }}
        className="flex-1 overflow-y-auto px-4 lg:px-12 py-12 lg:py-24 scroll-smooth scrollbar-hide"
        onDoubleClick={triggerJump}
      >
        <div
          style={containerStyles}
          className="max-w-[70ch] mx-auto pb-64 whitespace-pre-wrap select-text cursor-text font-medium leading-relaxed"
        >
          <div className={`mb-10 border-b pb-6 flex justify-between items-end select-none ${theme === Theme.DARK ? 'border-white/10' : 'border-black/10'}`}>
            <div className="flex-1 min-w-0 pr-4">
              <button
                onClick={handleBack}
                className="flex items-center gap-1 text-[10px] font-black uppercase tracking-widest text-indigo-500 mb-4 hover:translate-x-[-2px] transition-transform"
              >
                <ChevronLeft className="w-3 h-3" /> Back
              </button>
              <div className="text-[11px] font-black uppercase tracking-widest text-indigo-600 mb-1">Chapter {chapter?.index || 0}</div>
              <h1 className="text-2xl lg:text-4xl font-black tracking-tight leading-tight truncate">{chapter?.title || "Untitled"}</h1>
              {showHighlightPending && (
                <div className="mt-2 text-[10px] font-black uppercase tracking-widest" style={{ color: themeTokens.muted }}>
                  Highlight generating…
                </div>
              )}
              {debugMode && (
                <div className="mt-2 text-[10px] font-mono text-indigo-400 flex items-center gap-3">
                  <span>Cues: {cueMeta?.count ?? 'n/a'}</span>
                  <span>Method: {cueMeta?.method ?? 'n/a'}</span>
                  <span>Active idx: {activeCueIndex ?? '--'}</span>
                  {onRegenerateCueMap && chapter && (
                    <button
                      onClick={onRegenerateCueMap}
                      className="px-2 py-1 rounded bg-indigo-700 text-white text-[10px] font-black uppercase tracking-widest"
                    >
                      Regenerate cue map
                    </button>
                  )}
                </div>
              )}
            </div>
            <div className="flex items-center gap-1 relative">
              <button
                onClick={() => setShowToolsMenu((v) => !v)}
                title="Reader tools"
                className={`p-3 rounded-xl transition-all ${theme === Theme.DARK ? 'bg-white/10 hover:bg-white/20' : 'bg-black/5 hover:bg-black/10'}`}
              >
                <MoreVertical className="w-5 h-5" />
              </button>
              {showToolsMenu && (
                <div className={`absolute right-0 top-12 z-20 min-w-[180px] rounded-2xl shadow-2xl p-2 ${theme === Theme.DARK ? 'bg-slate-900 border border-white/10' : theme === Theme.SEPIA ? 'bg-[#efe6d5] border border-black/10' : 'bg-white border border-black/10'}`}>
                  {onAddChapter && (
                    <button
                      onClick={() => { setShowToolsMenu(false); onAddChapter(); }}
                      className={`w-full flex items-center gap-2 px-3 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-colors ${theme === Theme.DARK ? 'hover:bg-white/10 text-slate-100' : 'hover:bg-black/5 text-slate-900'}`}
                    >
                      <Plus className="w-4 h-4" /> Add Chapter
                    </button>
                  )}
                  <button
                    onClick={() => { setShowToolsMenu(false); onToggleDebug(); }}
                    className={`w-full flex items-center gap-2 px-3 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-colors ${theme === Theme.DARK ? 'hover:bg-white/10 text-slate-100' : 'hover:bg-black/5 text-slate-900'}`}
                  >
                    <Bug className="w-4 h-4" /> {debugMode ? 'Disable Debug' : 'Enable Debug'}
                  </button>
                </div>
              )}
            </div>
          </div>
          <div className={paragraphClass}>
            {paragraphs.map(renderParagraph)}
          </div>
        </div>
      </div>
      <div className={`absolute bottom-0 left-0 right-0 h-24 lg:h-32 z-10 pointer-events-none bg-gradient-to-t ${fadeColor} to-transparent`} />
    </div>
  );
};

export default Reader;
