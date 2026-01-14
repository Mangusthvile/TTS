import React from 'react';
import { Book, Theme } from '../types';
import { ChevronRight, X, CheckCircle2 } from 'lucide-react';

interface ChapterSidebarProps {
  book: Book;
  theme: Theme;
  onSelectChapter: (id: string) => void;
  onClose: () => void;
  isDrawer: boolean;
  playbackSnapshot?: { chapterId: string, percent: number } | null;
}

const ChapterSidebar: React.FC<ChapterSidebarProps> = ({ book, theme, onSelectChapter, onClose, isDrawer, playbackSnapshot }) => {
  const isDark = theme === Theme.DARK;
  const isSepia = theme === Theme.SEPIA;
  const textClass = isDark ? 'text-slate-100' : isSepia ? 'text-[#3c2f25]' : 'text-black';
  const itemHover = isDark ? 'hover:bg-white/5' : 'hover:bg-black/5';

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="p-6 border-b border-black/5 flex items-center justify-between">
        <div>
          <h3 className={`text-sm font-black uppercase tracking-widest ${textClass}`}>Chapters</h3>
          <p className="text-[10px] font-bold opacity-50 truncate max-w-[180px]">{book.title}</p>
        </div>
        {isDrawer && (
          <button onClick={onClose} className="p-2 -mr-2 opacity-60 hover:opacity-100"><X className="w-5 h-5" /></button>
        )}
      </div>
      <div className="flex-1 overflow-y-auto py-2 scrollbar-hide">
        {book.chapters.map((chapter) => {
          const isCurrent = book.currentChapterId === chapter.id;
          let pct = chapter.progress !== undefined ? Math.floor(chapter.progress * 100) : 0;
          if (playbackSnapshot && playbackSnapshot.chapterId === chapter.id) {
            pct = Math.floor(playbackSnapshot.percent * 100);
          }
          
          return (
            <button
              key={chapter.id}
              onClick={() => onSelectChapter(chapter.id)}
              className={`w-full flex items-center gap-3 px-6 py-3 text-left transition-all ${itemHover} ${isCurrent ? 'bg-indigo-600/10' : ''}`}
            >
              <div className={`w-6 h-6 rounded-lg flex items-center justify-center flex-shrink-0 ${isCurrent ? 'bg-indigo-600 text-white' : 'bg-black/5 text-inherit'}`}>
                 {chapter.isCompleted ? <CheckCircle2 className="w-3 h-3" /> : <span className="text-[9px] font-black">{pct > 0 ? `${pct}%` : chapter.index}</span>}
              </div>
              <span className={`text-xs font-bold truncate ${isCurrent ? 'text-indigo-600' : textClass} ${chapter.isCompleted ? 'opacity-50' : ''}`}>
                {chapter.title}
              </span>
              {isCurrent && <ChevronRight className="w-3 h-3 ml-auto text-indigo-600" />}
            </button>
          );
        })}
      </div>
    </div>
  );
};

export default ChapterSidebar;
