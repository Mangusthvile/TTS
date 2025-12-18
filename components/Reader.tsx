
import React, { useEffect, useRef, useMemo } from 'react';
import { Chapter, Rule, Theme, HighlightMode, ReaderSettings } from '../types';
import { applyRules } from '../services/speechService';
import { Bug, FolderOpen, Plus } from 'lucide-react';

interface ReaderProps {
  chapter: Chapter | null;
  chapterText?: string;
  rules: Rule[];
  currentOffset: number;
  theme: Theme;
  debugMode: boolean;
  onToggleDebug: () => void;
  onJumpToOffset: (offset: number) => void;
  onBackToChapters?: () => void;
  onAddChapter?: () => void;
  highlightMode: HighlightMode;
  readerSettings: ReaderSettings;
}

const Reader: React.FC<ReaderProps> = ({ 
  chapter, chapterText, rules, currentOffset, theme, debugMode, onToggleDebug, onJumpToOffset, 
  onBackToChapters, onAddChapter, highlightMode, readerSettings
}) => {
  const activeWordRef = useRef<HTMLSpanElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const lastScrollTime = useRef<number>(0);

  const rawText = chapterText ?? chapter?.content ?? "";

  const speakText = useMemo(() => {
    if (!rawText) return "";
    return applyRules(rawText, rules);
  }, [rawText, rules]);

  const segments = useMemo(() => {
    if (!speakText) return { words: [], sentences: [] };
    
    const words: {start: number, end: number}[] = [];
    const sentences: {start: number, end: number}[] = [];

    if (!('Segmenter' in Intl)) {
      const wordRegex = /\w+/g;
      let m;
      while ((m = wordRegex.exec(speakText)) !== null) {
        words.push({ start: m.index, end: wordRegex.lastIndex });
      }
      const sentRegex = /[^.!?]+[.!?]*/g;
      while ((m = sentRegex.exec(speakText)) !== null) {
        sentences.push({ start: m.index, end: sentRegex.lastIndex });
      }
      return { words, sentences };
    }

    const wordSegmenter = new (Intl as any).Segmenter('en', { granularity: 'word' });
    for (const seg of wordSegmenter.segment(speakText)) {
      if (seg.isWordLike) words.push({ start: seg.index, end: seg.index + seg.segment.length });
    }

    const sentSegmenter = new (Intl as any).Segmenter('en', { granularity: 'sentence' });
    for (const seg of sentSegmenter.segment(speakText)) {
      sentences.push({ start: seg.index, end: seg.index + seg.segment.length });
    }

    return { words, sentences };
  }, [speakText]);

  useEffect(() => {
    const now = Date.now();
    if (activeWordRef.current && containerRef.current && now - lastScrollTime.current > 250) {
      const el = activeWordRef.current;
      const container = containerRef.current;
      const rect = el.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      const threshold = containerRect.height * 0.3;
      const isOutsideThreshold = rect.top < containerRect.top + threshold || rect.bottom > containerRect.bottom - threshold;

      if (isOutsideThreshold) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        lastScrollTime.current = now;
      }
    }
  }, [currentOffset]);

  const handleDoubleClick = (e: React.MouseEvent) => {
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

  const highlightStyles = useMemo(() => {
    const isDark = theme === Theme.DARK;
    const isSepia = theme === Theme.SEPIA;
    return {
      word: isDark ? 'bg-indigo-500 text-white' : isSepia ? 'bg-[#9c6644] text-white' : 'bg-indigo-600 text-white',
      sentence: isDark ? 'bg-white/10' : isSepia ? 'bg-black/10' : 'bg-indigo-600/10'
    };
  }, [theme]);

  const renderContent = () => {
    const activeWord = segments.words.find(s => currentOffset >= s.start && currentOffset < s.end) || 
                      segments.words.find(s => s.start >= currentOffset);
    const activeSentence = segments.sentences.find(s => currentOffset >= s.start && currentOffset < s.end) || 
                          segments.sentences.find(s => s.start >= currentOffset);

    const transitionClass = "transition-all duration-150 ease-out rounded px-0.5";

    if (highlightMode === HighlightMode.SENTENCE && activeSentence) {
      return (
        <React.Fragment>
          <span data-base="0">{speakText.substring(0, activeSentence.start)}</span>
          <span data-base={activeSentence.start} className={`${highlightStyles.sentence} ${transitionClass} py-0.5`}>
            {speakText.substring(activeSentence.start, activeSentence.end)}
            <span ref={activeWordRef} className="invisible w-0" />
          </span>
          <span data-base={activeSentence.end}>{speakText.substring(activeSentence.end)}</span>
        </React.Fragment>
      );
    }
    
    if (highlightMode === HighlightMode.KARAOKE && activeSentence && activeWord) {
      return (
        <React.Fragment>
          <span data-base="0">{speakText.substring(0, activeSentence.start)}</span>
          <span className={`${highlightStyles.sentence} ${transitionClass} py-0.5`} data-base={activeSentence.start}>
            {speakText.substring(activeSentence.start, activeWord.start)}
            <span ref={activeWordRef} className={`font-black ${highlightStyles.word} ${transitionClass} shadow-md`} data-base={activeWord.start}>
              {speakText.substring(activeWord.start, activeWord.end)}
            </span>
            {speakText.substring(activeWord.end, activeSentence.end)}
          </span>
          <span data-base={activeSentence.end}>{speakText.substring(activeSentence.end)}</span>
        </React.Fragment>
      );
    }

    if (activeWord) {
      return (
        <React.Fragment>
          <span data-base="0">{speakText.substring(0, activeWord.start)}</span>
          <span ref={activeWordRef} data-base={activeWord.start} className={`font-black ${highlightStyles.word} ${transitionClass} shadow-md`}>
            {speakText.substring(activeWord.start, activeWord.end)}
          </span>
          <span data-base={activeWord.end}>{speakText.substring(activeWord.end)}</span>
        </React.Fragment>
      );
    }

    return <span data-base="0">{speakText}</span>;
  };

  const containerStyles = {
    fontFamily: readerSettings.fontFamily,
    fontSize: `clamp(18px, 4.5vw, ${readerSettings.fontSizePx}px)`,
    lineHeight: readerSettings.lineHeight,
  };

  const fadeColor = theme === Theme.DARK ? 'from-slate-900' : theme === Theme.SEPIA ? 'from-[#efe6d5]' : 'from-white';

  return (
    <div className={`relative flex-1 flex flex-col min-h-0 overflow-hidden ${theme === Theme.DARK ? 'text-slate-100' : theme === Theme.SEPIA ? 'text-[#3c2f25]' : 'text-black'}`}>
      <div className={`absolute top-0 left-0 right-0 h-16 lg:h-24 z-10 pointer-events-none bg-gradient-to-b ${fadeColor} to-transparent`} />
      <div ref={containerRef} className="flex-1 overflow-y-auto px-4 lg:px-12 py-12 lg:py-24 scroll-smooth scrollbar-hide">
        <div 
          onDoubleClick={handleDoubleClick}
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
                  <button 
                    onClick={onAddChapter} 
                    title="Quick Add Chapter"
                    className={`p-2.5 rounded-xl transition-all ${theme === Theme.DARK ? 'bg-white/10 hover:bg-indigo-600 hover:text-white' : 'bg-black/5 hover:bg-indigo-600 hover:text-white'}`}
                  >
                    <Plus className="w-4 h-4" />
                  </button>
                )}
                {onBackToChapters && (
                  <button 
                    onClick={onBackToChapters} 
                    title="Back to Collection"
                    className={`p-2.5 rounded-xl transition-all ${theme === Theme.DARK ? 'bg-white/10 hover:bg-indigo-600 hover:text-white' : 'bg-black/5 hover:bg-indigo-600 hover:text-white'}`}
                  >
                    <FolderOpen className="w-4 h-4" />
                  </button>
                )}
                <button 
                  onClick={onToggleDebug} 
                  title="Debug Mode"
                  className={`p-2.5 rounded-xl transition-all ${theme === Theme.DARK ? 'bg-white/10 hover:bg-white/20' : 'bg-black/5 hover:bg-black/10'}`}
                >
                  <Bug className="w-4 h-4" />
                </button>
             </div>
          </div>
          <div className={readerSettings.paragraphSpacing === 2 ? 'space-y-10' : 'space-y-2'}>
            {renderContent()}
          </div>
        </div>
      </div>
      <div className={`absolute bottom-0 left-0 right-0 h-24 lg:h-32 z-10 pointer-events-none bg-gradient-to-t ${fadeColor} to-transparent`} />
    </div>
  );
};

export default Reader;
