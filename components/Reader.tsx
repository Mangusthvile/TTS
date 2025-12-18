
import React, { useEffect, useRef, useMemo } from 'react';
import { Chapter, Rule, Theme, HighlightMode, ReaderSettings } from '../types';
import { applyRules } from '../services/speechService';
import { Bug, FolderOpen } from 'lucide-react';

interface ReaderProps {
  chapter: Chapter | null;
  rules: Rule[];
  currentOffset: number;
  theme: Theme;
  debugMode: boolean;
  onToggleDebug: () => void;
  onJumpToOffset: (offset: number) => void;
  onBackToChapters?: () => void;
  highlightMode: HighlightMode;
  readerSettings: ReaderSettings;
}

const Reader: React.FC<ReaderProps> = ({ 
  chapter, rules, currentOffset, theme, debugMode, onToggleDebug, onJumpToOffset, 
  onBackToChapters, highlightMode, readerSettings
}) => {
  const activeWordRef = useRef<HTMLSpanElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const speakText = useMemo(() => {
    if (!chapter) return "";
    return applyRules(chapter.content, rules);
  }, [chapter, rules]);

  const wordSpans = useMemo(() => {
    const spans: {start: number, end: number}[] = [];
    if (!speakText) return spans;
    const regex = /\w+/g;
    let match;
    while ((match = regex.exec(speakText)) !== null) {
      spans.push({ start: match.index, end: regex.lastIndex });
    }
    return spans;
  }, [speakText]);

  const sentenceSpans = useMemo(() => {
    const spans: {start: number, end: number}[] = [];
    if (!speakText) return spans;
    const regex = /[^.!?]+[.!?]*/g;
    let match;
    while ((match = regex.exec(speakText)) !== null) {
      spans.push({ start: match.index, end: regex.lastIndex });
    }
    return spans;
  }, [speakText]);

  useEffect(() => {
    if (activeWordRef.current && containerRef.current) {
      activeWordRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
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

    const target = wordSpans.find(s => globalOffset >= s.start && globalOffset < s.end) || 
                   wordSpans.find(s => s.start >= globalOffset);
    
    if (target) {
      onJumpToOffset(target.start);
    }
    selection.removeAllRanges();
  };

  const highlightClass = theme === Theme.DARK ? 'bg-indigo-500 text-white shadow-[0_0_10px_rgba(99,102,241,0.5)] rounded px-0.5' : 
                        theme === Theme.SEPIA ? 'bg-[#9c6644] text-white rounded px-0.5' : 
                        'bg-indigo-600 text-white rounded px-0.5';

  const sentenceHighlightBg = theme === Theme.DARK ? 'bg-white/10 rounded-lg' : 
                        theme === Theme.SEPIA ? 'bg-black/10 rounded-lg' : 
                        'bg-indigo-600/10 rounded-lg';

  const textContrastClass = theme === Theme.DARK ? 'text-slate-100' : theme === Theme.SEPIA ? 'text-[#3c2f25]' : 'text-black';

  const renderContent = () => {
    const activeWord = wordSpans.find(s => currentOffset >= s.start && currentOffset < s.end) || wordSpans.find(s => s.start >= currentOffset);
    const activeSentence = sentenceSpans.find(s => currentOffset >= s.start && currentOffset < s.end) || sentenceSpans.find(s => s.start >= currentOffset);

    if (highlightMode === HighlightMode.SENTENCE && activeSentence) {
      return (
        <span className="para-content">
          <span data-base="0">{speakText.substring(0, activeSentence.start)}</span>
          <span data-base={activeSentence.start} className={`${sentenceHighlightBg} px-1.5 py-0.5`}>
            {speakText.substring(activeSentence.start, activeSentence.end)}
            <span ref={activeWordRef} className="invisible w-0" />
          </span>
          <span data-base={activeSentence.end}>{speakText.substring(activeSentence.end)}</span>
        </span>
      );
    }
    
    if (highlightMode === HighlightMode.KARAOKE && activeSentence && activeWord) {
      return (
        <span className="para-content">
          <span data-base="0">{speakText.substring(0, activeSentence.start)}</span>
          <span className={`${sentenceHighlightBg} px-1.5 py-0.5`} data-base={activeSentence.start}>
            {speakText.substring(activeSentence.start, activeWord.start)}
            <span ref={activeWordRef} className={`font-black ${highlightClass}`} data-base={activeWord.start}>
              {speakText.substring(activeWord.start, activeWord.end)}
            </span>
            {speakText.substring(activeWord.end, activeSentence.end)}
          </span>
          <span data-base={activeSentence.end}>{speakText.substring(activeSentence.end)}</span>
        </span>
      );
    }

    if (activeWord) {
      return (
        <span className="para-content">
          <span data-base="0">{speakText.substring(0, activeWord.start)}</span>
          <span ref={activeWordRef} data-base={activeWord.start} className={`font-black transition-all ${highlightClass}`}>
            {speakText.substring(activeWord.start, activeWord.end)}
          </span>
          <span data-base={activeWord.end}>{speakText.substring(activeWord.end)}</span>
        </span>
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
    <div className={`relative flex-1 flex flex-col min-h-0 overflow-hidden ${textContrastClass}`}>
      <div className={`absolute top-0 left-0 right-0 h-16 lg:h-24 z-10 pointer-events-none bg-gradient-to-b ${fadeColor} to-transparent`} />
      <div ref={containerRef} className="flex-1 overflow-y-auto px-4 lg:px-12 py-12 lg:py-24 scroll-smooth">
        <div 
          onDoubleClick={handleDoubleClick}
          style={containerStyles}
          className="max-w-[70ch] mx-auto pb-64 whitespace-pre-wrap select-text cursor-text font-medium"
        >
          <div className={`mb-10 border-b pb-6 flex justify-between items-end select-none ${theme === Theme.DARK ? 'border-white/10' : 'border-black/10'}`}>
             <div className="flex-1 min-w-0 pr-4">
                <div className="text-[11px] font-black uppercase tracking-widest text-indigo-600 mb-1">Chapter {chapter?.index || 0}</div>
                <h1 className="text-2xl lg:text-4xl font-black tracking-tight leading-tight truncate">{chapter?.title || "Untitled"}</h1>
             </div>
             <div className="flex items-center gap-1">
                {onBackToChapters && <button onClick={onBackToChapters} className={`p-2.5 rounded-xl transition-all ${theme === Theme.DARK ? 'bg-white/10 hover:bg-indigo-600 hover:text-white' : 'bg-black/5 hover:bg-indigo-600 hover:text-white'}`}><FolderOpen className="w-4 h-4" /></button>}
                <button onClick={onToggleDebug} className={`p-2.5 rounded-xl transition-all ${theme === Theme.DARK ? 'bg-white/10 hover:bg-white/20' : 'bg-black/5 hover:bg-black/10'}`}><Bug className="w-4 h-4" /></button>
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
