import React, { useEffect, useRef, useMemo, useState } from 'react';
import { Chapter, Rule, Theme, HighlightMode, ReaderSettings } from '../types';
import { applyRules } from '../services/speechService';
import { reflowLineBreaks } from '../services/textFormat';
import { Bug, Plus, ChevronLeft, ArrowDownCircle, MoreVertical } from 'lucide-react';

interface ReaderProps {
  chapter: Chapter | null;
  rules: Rule[];
  currentOffsetChars: number; 
  activeHighlightRange?: { start: number; end: number } | null;
  activeCueIndex?: number | null;
  cueMeta?: { method?: string; count?: number };
  onRegenerateCueMap?: () => void;
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

const WordWrapper = React.memo(({ word, currentOffset, highlightMode, sentences }: { word: any, currentOffset: number, highlightMode: HighlightMode, sentences: any[] }) => {
  const isActive = currentOffset >= word.start && currentOffset < word.end;
  let isSentenceActive = false;

  if (highlightMode === HighlightMode.SENTENCE || highlightMode === HighlightMode.KARAOKE) {
    const activeSent = sentences.find(s => currentOffset >= s.start && currentOffset < s.end);
    if (activeSent && word.start >= activeSent.start && word.end <= activeSent.end) {
      isSentenceActive = true;
    }
  }

  const highlightClass = isActive ? "bg-[var(--highlight-color)] text-white shadow-md" : "";
  const sentenceClass = (isSentenceActive && (highlightMode === HighlightMode.SENTENCE || (highlightMode === HighlightMode.KARAOKE && !isActive))) 
    ? "bg-indigo-600/10 dark:bg-white/10" 
    : "";

  return (
    <span 
      data-base={word.start} 
      data-active={isActive ? "true" : "false"}
      className={`inline-block rounded px-0.5 transition-all duration-150 ease-out ${highlightClass} ${sentenceClass}`}
      style={{ fontWeight: 'inherit' }}
    >
      {word.text}
    </span>
  );
});

const Reader: React.FC<ReaderProps> = ({ 
  chapter, rules, currentOffsetChars, activeHighlightRange, activeCueIndex, cueMeta, onRegenerateCueMap, theme, debugMode, onToggleDebug, onJumpToOffset, 
  onBackToCollection, onAddChapter, highlightMode, readerSettings, isMobile
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const userScrollingRef = useRef<boolean>(false);
  const scrollTimeoutRef = useRef<number | null>(null);
  const [showResumeButton, setShowResumeButton] = useState(false);
  const [showToolsMenu, setShowToolsMenu] = useState(false);

  const speakText = useMemo(() => {
    if (!chapter) return "";
    const ruled = applyRules((chapter.content ?? ""), rules);
    return readerSettings.reflowLineBreaks ? reflowLineBreaks(ruled) : ruled;
  }, [chapter, rules, readerSettings.reflowLineBreaks]);

  const slices = useMemo(() => {
    if (!chapter || !speakText || !activeHighlightRange) return null;
    const { start, end } = activeHighlightRange;
    return {
      before: speakText.slice(0, Math.max(0, start)),
      mid: speakText.slice(Math.max(0, start), Math.max(start, end)),
      after: speakText.slice(Math.max(start, end)),
      key: `${chapter.id}-${start}-${end}`
    };
  }, [chapter, speakText, activeHighlightRange?.start, activeHighlightRange?.end]);

  const segments = useMemo(() => {
    if (!speakText) return { words: [], sentences: [], nodes: [] };
    const words: {start: number, end: number, text: string}[] = [];
    const sentences: {start: number, end: number}[] = [];
    if (!('Segmenter' in Intl)) {
      const wordRegex = /\w+/g;
      let m;
      while ((m = wordRegex.exec(speakText)) !== null) {
        words.push({ start: m.index, end: wordRegex.lastIndex, text: m[0] });
      }
      const sentRegex = /[^.!?]+[.!?]*/g;
      while ((m = sentRegex.exec(speakText)) !== null) {
        sentences.push({ start: m.index, end: sentRegex.lastIndex });
      }
    } else {
      const wordSegmenter = new (Intl as any).Segmenter('en', { granularity: 'word' });
      for (const seg of wordSegmenter.segment(speakText)) {
        if (seg.isWordLike) words.push({ start: seg.index, end: seg.index + seg.segment.length, text: seg.segment });
      }
      const sentSegmenter = new (Intl as any).Segmenter('en', { granularity: 'sentence' });
      for (const seg of sentSegmenter.segment(speakText)) {
        sentences.push({ start: seg.index, end: seg.index + seg.segment.length });
      }
    }
    const nodes: React.ReactNode[] = [];
    let lastIndex = 0;
    words.forEach((w) => {
      if (w.start > lastIndex) {
        nodes.push(<span key={`gap-${lastIndex}`} data-base={lastIndex}>{speakText.substring(lastIndex, w.start)}</span>);
      }
      nodes.push(
        <WordWrapper 
          key={`word-${w.start}`}
          word={w}
          currentOffset={currentOffsetChars}
          highlightMode={highlightMode}
          sentences={sentences}
        />
      );
      lastIndex = w.end;
    });
    if (lastIndex < speakText.length) {
      nodes.push(<span key={`gap-end`} data-base={lastIndex}>{speakText.substring(lastIndex)}</span>);
    }
    return { words, sentences, nodes };
  }, [speakText, currentOffsetChars, highlightMode]);

  const highlightRef = useRef<HTMLSpanElement | null>(null);

  // Screen follows highlight
  useEffect(() => {
    if (!readerSettings.followHighlight || userScrollingRef.current) return;
    scrollToActive();
  }, [currentOffsetChars, activeHighlightRange?.start, activeHighlightRange?.end, readerSettings.followHighlight]);

  const scrollToActive = () => {
    const target = highlightRef.current || containerRef.current?.querySelector('[data-active="true"]');
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  };

  const handleResumeAutoScroll = () => {
    userScrollingRef.current = false;
    setShowResumeButton(false);
    scrollToActive();
  };

  const handleScroll = () => {
    userScrollingRef.current = true;
    if (isMobile) setShowResumeButton(true);
    
    if (scrollTimeoutRef.current) window.clearTimeout(scrollTimeoutRef.current);
    
    // Only auto-reset on desktop. On mobile, we wait for explicit resume or new chapter.
    if (!isMobile) {
      const cooldown = 1500;
      scrollTimeoutRef.current = window.setTimeout(() => {
        userScrollingRef.current = false;
      }, cooldown);
    }
  };

  const triggerJump = () => {
    if (isMobile) return; // Disable double-tap seek on mobile to prevent conflicts
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    const container = range.startContainer;
    const span = container.parentElement?.closest('[data-base]');
    if (!span) return;
    const baseOffset = parseInt((span as HTMLElement).dataset.base || '0', 10);
    const globalOffset = baseOffset + range.startOffset;
    const target = segments.words.find(s => globalOffset >= s.start && globalOffset < s.end) || 
                   segments.words.find(s => s.start >= globalOffset);
    if (target) onJumpToOffset(target.start);
    selection.removeAllRanges();
  };

  const containerStyles = {
    fontFamily: readerSettings.fontFamily,
    fontSize: `clamp(18px, 4.5vw, ${readerSettings.fontSizePx}px)`,
    lineHeight: readerSettings.lineHeight,
  };

  const paragraphClass =
    readerSettings.paragraphSpacing === 0 ? 'space-y-0' :
    readerSettings.paragraphSpacing === 1 ? 'space-y-2' :
    readerSettings.paragraphSpacing === 2 ? 'space-y-6' :
    'space-y-10';

  const fadeColor = theme === Theme.DARK ? 'from-slate-900' : theme === Theme.SEPIA ? 'from-[#efe6d5]' : 'from-white';
  const handleBack = () => {
    console.log('[TaleVox][Reader] back_to_collection');
    if (onBackToCollection) onBackToCollection();
  };

  return (
    <div className="relative flex-1 flex flex-col min-h-0 overflow-hidden touch-manipulation text-theme">
      <div className={`absolute top-0 left-0 right-0 h-16 lg:h-24 z-10 pointer-events-none bg-gradient-to-b ${fadeColor} to-transparent`} />
      
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
        onTouchStart={() => { userScrollingRef.current = true; if(isMobile) setShowResumeButton(true); }}
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
            {activeHighlightRange && slices ? (
              <div data-base="0" className="leading-relaxed">
                {slices.before}
                <span
                  ref={highlightRef}
                  className="bg-[var(--highlight-color)] text-white shadow-md rounded px-0.5 transition-colors duration-100"
                >
                  {slices.mid || " "}
                </span>
                {slices.after}
              </div>
            ) : (
              segments.nodes
            )}
          </div>
        </div>
      </div>
      <div className={`absolute bottom-0 left-0 right-0 h-24 lg:h-32 z-10 pointer-events-none bg-gradient-to-t ${fadeColor} to-transparent`} />
    </div>
  );
};

export default Reader;
