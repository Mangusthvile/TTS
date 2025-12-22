import React, { useEffect, useRef, useMemo } from 'react';
import { Chapter, Rule, Theme, HighlightMode, ReaderSettings } from '../types';
import { applyRules } from '../services/speechService';
import { Bug, FolderOpen, Plus } from 'lucide-react';

interface ReaderProps {
  chapter: Chapter | null;
  rules: Rule[];
  currentOffsetChars: number; 
  theme: Theme;
  debugMode: boolean;
  onToggleDebug: () => void;
  onJumpToOffset: (offset: number) => void;
  onBackToChapters?: () => void;
  onAddChapter?: () => void;
  highlightMode: HighlightMode;
  readerSettings: ReaderSettings;
}

// Memoized Word Component for stable rendering
const Word = React.memo(({ text, start, end, isActive, highlightColor, isSentenceActive }: { text: string, start: number, end: number, isActive: boolean, highlightColor: string, isSentenceActive: boolean }) => {
  const activeClass = isActive ? "bg-[var(--highlight-color)] text-white shadow-md" : "";
  const sentenceClass = isSentenceActive && !isActive ? "bg-indigo-600/10 dark:bg-white/10" : "";
  
  return (
    <span 
      data-base={start} 
      data-end={end}
      className={`inline-block rounded px-0.5 transition-all duration-150 ease-out ${activeClass} ${sentenceClass}`}
    >
      {text}
    </span>
  );
});

const Reader: React.FC<ReaderProps> = ({ 
  chapter, rules, currentOffsetChars, theme, debugMode, onToggleDebug, onJumpToOffset, 
  onBackToChapters, onAddChapter, highlightMode, readerSettings
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const lastScrollTime = useRef<number>(0);

  const speakText = useMemo(() => {
    if (!chapter) return "";
    return applyRules(chapter.content, rules);
  }, [chapter, rules]);

  // Pre-calculate segments and chunks of text for stable DOM
  const segments = useMemo(() => {
    if (!speakText) return { words: [], sentences: [], nodes: [] };
    
    const words: {start: number, end: number, text: string}[] = [];
    const sentences: {start: number, end: number}[] = [];

    // Fallback if Segmenter is missing
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

    // Build static nodes for interleaved rendering (spans for words, text for spaces)
    const nodes: React.ReactNode[] = [];
    let lastIndex = 0;
    
    words.forEach((w, i) => {
      // Add gap text
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

    // Add trailing text
    if (lastIndex < speakText.length) {
      nodes.push(<span key={`gap-end`} data-base={lastIndex}>{speakText.substring(lastIndex)}</span>);
    }

    return { words, sentences, nodes };
  }, [speakText, currentOffsetChars, highlightMode]);

  // Auto-scroll logic
  useEffect(() => {
    const now = Date.now();
    if (containerRef.current && now - lastScrollTime.current > 150) {
      const activeEl = containerRef.current.querySelector('[data-active="true"]');
      if (activeEl) {
        const rect = activeEl.getBoundingClientRect();
        const containerRect = containerRef.current.getBoundingClientRect();
        const threshold = containerRect.height * 0.35;
        const isOutsideThreshold = rect.top < containerRect.top + threshold || rect.bottom > containerRect.bottom - threshold;

        if (isOutsideThreshold) {
          activeEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
          lastScrollTime.current = now;
        }
      }
    }
  }, [currentOffsetChars]);

  const triggerJump = () => {
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

  const fadeColor = theme === Theme.DARK ? 'from-slate-900' : theme === Theme.SEPIA ? 'from-[#efe6d5]' : 'from-white';

  return (
    <div className={`relative flex-1 flex flex-col min-h-0 overflow-hidden touch-manipulation ${theme === Theme.DARK ? 'text-slate-100' : theme === Theme.SEPIA ? 'text-[#3c2f25]' : 'text-black'}`}>
      <div className={`absolute top-0 left-0 right-0 h-16 lg:h-24 z-10 pointer-events-none bg-gradient-to-b ${fadeColor} to-transparent`} />
      <div 
        ref={containerRef} 
        className="flex-1 overflow-y-auto px-4 lg:px-12 py-12 lg:py-24 scroll-smooth scrollbar-hide"
        onDoubleClick={triggerJump}
      >
        <div 
          style={containerStyles}
          className="max-w-[70ch] mx-auto pb-64 whitespace-pre-wrap select-text cursor-text font-medium leading-relaxed"
        >
          <div className={`mb-10 border-b pb-6 flex justify-between items-end select-none ${theme === Theme.DARK ? 'border-white/10' : 'border-black/10'}`}>
             <div className="flex-1 min-w-0 pr-4">
                <div className="text-[11px] font-black uppercase tracking-widest text-indigo-600 mb-1">Chapter {chapter?.index || 0}</div>
                <h1 className="text-2xl lg:text-4xl font-black tracking-tight leading-tight truncate">{chapter?.title || "Untitled"}</h1>
             </div>
             <div className="flex items-center gap-1">
                {onAddChapter && (
                  <button onClick={onAddChapter} title="Quick Add Chapter" className={`p-3 rounded-xl transition-all ${theme === Theme.DARK ? 'bg-white/10 hover:bg-indigo-600 hover:text-white' : 'bg-black/5 hover:bg-indigo-600 hover:text-white'}`}><Plus className="w-5 h-5" /></button>
                )}
                {onBackToChapters && (
                  <button onClick={onBackToChapters} title="Back to Collection" className={`p-3 rounded-xl transition-all ${theme === Theme.DARK ? 'bg-white/10 hover:bg-indigo-600 hover:text-white' : 'bg-black/5 hover:bg-indigo-600 hover:text-white'}`}><FolderOpen className="w-5 h-5" /></button>
                )}
                <button onClick={onToggleDebug} title="Debug Mode" className={`p-3 rounded-xl transition-all ${theme === Theme.DARK ? 'bg-white/10 hover:bg-white/20' : 'bg-black/5 hover:bg-black/10'}`}><Bug className="w-5 h-5" /></button>
             </div>
          </div>
          <div className={readerSettings.paragraphSpacing === 2 ? 'space-y-10' : 'space-y-2'}>
            {segments.nodes}
          </div>
        </div>
      </div>
      <div className={`absolute bottom-0 left-0 right-0 h-24 lg:h-32 z-10 pointer-events-none bg-gradient-to-t ${fadeColor} to-transparent`} />
    </div>
  );
};

// Helper component to decide highlight state for a word without re-calculating entire tree
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
      style={{ fontWeight: 'inherit' }} // Fix Issue 2: Ensure no weight changes
    >
      {word.text}
    </span>
  );
});

export default Reader;