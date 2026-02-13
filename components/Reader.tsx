import React, { useEffect, useRef, useMemo, useState } from 'react';
import { Chapter, Rule, Theme, ReaderSettings, ParagraphMap } from '../types';
import { Bug, Plus, ChevronLeft, ArrowDownCircle, MoreVertical, Paperclip } from 'lucide-react';
import ReaderList from "./ReaderList";
import { RenderBlock, buildReaderModel } from "../utils/markdownBlockParser";

interface ReaderProps {
  chapter: Chapter | null;
  chapterText?: string;
  speechText?: string;
  rules: Rule[];
  activeCueIndex?: number | null;
  activeCueRange?: { start: number; end: number } | null;
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
    mode: string;
    isPlaying: boolean;
  };
  theme: Theme;
  debugMode: boolean;
  onToggleDebug: () => void;
  onJumpToOffset: (offset: number) => void;
  onBackToCollection?: () => void;
  onAddChapter?: () => void;
  onOpenAttachments?: () => void;
  initialScrollTop?: number | null;
  onScrollPositionChange?: (scrollTop: number) => void;
  readerSettings: ReaderSettings;
  isMobile: boolean;
  isScrubbing?: boolean;
  seekNudge?: number;
  readerBlocks?: RenderBlock[];
}

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
  chapterText,
  speechText,
  rules,
  activeCueIndex,
  activeCueRange,
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
  onOpenAttachments,
  initialScrollTop,
  onScrollPositionChange,
  readerSettings,
  isMobile,
  isScrubbing = false,
  seekNudge = 0,
  readerBlocks
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const lastRestoreKeyRef = useRef<string | null>(null);
  const [cueTargetFound, setCueTargetFound] = useState<boolean | null>(null);
  const [isUserScrolling, setIsUserScrolling] = useState(false);
  const [resumeNudge, setResumeNudge] = useState(0);
  const [showToolsMenu, setShowToolsMenu] = useState(false);
  const { blocks, speakText } = useMemo(() => {
    if (readerBlocks && typeof speechText === "string") {
      return { blocks: readerBlocks, speakText: speechText };
    }
    if (!chapter) return { blocks: [], speakText: "" };
    const baseText =
      typeof chapterText === "string" && chapterText.length > 0 ? chapterText : (chapter.content ?? "");
    const chapterFilename = chapter.filename ?? "";
    const isMarkdown =
      chapter.contentFormat === "markdown" ||
      chapterFilename.toLowerCase().endsWith(".md");
    return buildReaderModel(baseText, isMarkdown, rules, !!readerSettings.reflowLineBreaks);
  }, [readerBlocks, speechText, chapter, chapterText, rules, readerSettings.reflowLineBreaks]);

  const effectiveHighlightEnabled = highlightEnabled;
  const autoFollowEnabled = effectiveHighlightEnabled && readerSettings.followHighlight && highlightReady;
  const showResumeButton = isMobile && autoFollowEnabled && isUserScrolling;

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
    color: themeTokens.text,
    ['--highlight-strong' as any]: themeTokens.highlightStrong,
    ['--highlight-weak' as any]: themeTokens.highlightWeak,
    ['--highlight-strong-text' as any]: themeTokens.highlightStrongText,
  };

  const spacerClassName =
    readerSettings.paragraphSpacing === 0 ? 'h-0' :
    readerSettings.paragraphSpacing === 1 ? 'h-2' :
    readerSettings.paragraphSpacing === 2 ? 'h-6' :
    'h-10';

  const fadeColor = theme === Theme.DARK ? 'from-[#0a0f1e]' : theme === Theme.SEPIA ? 'from-[#f4ead8]' : 'from-[#f6f7fb]';
  useEffect(() => {
    if (!debugMode && !readerSettings.highlightDebugOverlay) return;
    if (!highlightEnabled || !highlightReady) {
      setCueTargetFound(null);
      return;
    }
    let frame = 0;
    frame = window.requestAnimationFrame(() => {
      const container = containerRef.current;
      if (!container) return;
      const found = !!container.querySelector('[data-highlight-anchor="true"]');
      setCueTargetFound(found);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [
    debugMode,
    readerSettings.highlightDebugOverlay,
    highlightEnabled,
    highlightReady,
    activeCueIndex,
    activeCueRange,
    activeParagraphIndex,
  ]);

  const handleResumeAutoScroll = () => {
    setIsUserScrolling(false);
    setResumeNudge((n) => n + 1);
  };

  useEffect(() => {
    if (!containerRef.current) return;
    if (initialScrollTop == null) return;
    const chapterId = chapter?.id ?? "none";
    const key = `${chapterId}:${initialScrollTop}:${speakText.length}`;
    if (lastRestoreKeyRef.current === key) return;
    lastRestoreKeyRef.current = key;
    const target = containerRef.current;
    requestAnimationFrame(() => {
      target.scrollTop = initialScrollTop;
    });
  }, [chapter?.id, initialScrollTop, speakText.length]);

  const handleScroll = () => {
    if (containerRef.current && onScrollPositionChange) {
      onScrollPositionChange(containerRef.current.scrollTop);
    }
  };

  const handleBack = () => {
    console.log('[TaleVox][Reader] back_to_collection');
    if (onBackToCollection) onBackToCollection();
  };

  const triggerJump = () => {
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

  const showHighlightPending = highlightEnabled && !!chapter && !highlightReady;
  const showHighlightOverlay = !!readerSettings.highlightDebugOverlay && !!highlightDebugData;

  return (
    <div className="relative flex-1 flex flex-col min-h-0 overflow-hidden touch-manipulation text-theme ui-font">
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
          <div>follow: {readerSettings.followHighlight ? 'on' : 'off'}</div>
          <div>autoLock: {isUserScrolling ? 'yes' : 'no'}</div>
          <div>cueTarget: {cueTargetFound == null ? 'n/a' : cueTargetFound ? 'yes' : 'no'}</div>
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
        className={`flex-1 overflow-y-auto overscroll-contain touch-pan-y px-4 lg:px-12 py-12 lg:py-24 scrollbar-hide ${readerSettings.followHighlight ? '' : 'scroll-smooth'}`}
        onDoubleClick={triggerJump}
      >
        <div
          style={containerStyles}
          className="max-w-[70ch] mx-auto pb-64 select-text cursor-text font-medium leading-relaxed"
        >
          <div className={`mb-10 border-b pb-6 flex justify-between items-end select-none ${theme === Theme.DARK ? 'border-white/10' : theme === Theme.SEPIA ? 'border-black/10' : 'border-black/10'}`}>
            <div className="flex-1 min-w-0 pr-4">
              <button
                onClick={handleBack}
                className="flex items-center gap-1 text-[10px] font-black uppercase tracking-widest text-[color:var(--tvx-accent)] mb-4 hover:translate-x-[-2px] transition-transform"
              >
                <ChevronLeft className="w-3 h-3" /> Back
              </button>
              <div className="text-[11px] font-black uppercase tracking-widest text-[color:var(--tvx-accent)] mb-1">Chapter {chapter?.index || 0}</div>
              <h1 className="text-3xl lg:text-5xl font-black tracking-tight leading-tight truncate heading-font">{chapter?.title || "Untitled"}</h1>
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
                  {onOpenAttachments && (
                    <button
                      onClick={() => { setShowToolsMenu(false); onOpenAttachments(); }}
                      className={`w-full flex items-center gap-2 px-3 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-colors ${theme === Theme.DARK ? 'hover:bg-white/10 text-slate-100' : 'hover:bg-black/5 text-slate-900'}`}
                    >
                      <Paperclip className="w-4 h-4" /> Attachments
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
          <ReaderList
            blocks={blocks}
            activeCueRange={effectiveHighlightEnabled && highlightReady ? activeCueRange ?? null : null}
            autoFollow={autoFollowEnabled}
            isScrubbing={isScrubbing}
            followNudge={seekNudge + resumeNudge}
            containerRef={containerRef}
            onUserScrollingChange={setIsUserScrolling}
            theme={theme}
            spacerClassName={spacerClassName}
          />
        </div>
      </div>
      <div className={`absolute bottom-0 left-0 right-0 h-24 lg:h-32 z-10 pointer-events-none bg-gradient-to-t ${fadeColor} to-transparent`} />
    </div>
  );
};

export default Reader;
