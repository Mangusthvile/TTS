
import React, { useMemo, useState, useEffect } from 'react';
import { Book, Theme, StorageBackend, Chapter, AudioChunkMetadata, AudioStatus } from '../types';
import { LayoutGrid, List, AlignJustify, Plus, Folder, CheckCircle2, Edit2, Check, RefreshCw, Trash2, Headphones, Loader2, Cloud, AlertTriangle, X, RotateCcw, ChevronLeft, Image as ImageIcon, Wand2, FileText, AlertCircle } from 'lucide-react';
import { PROGRESS_STORE_V4 } from '../services/speechService';

type ViewMode = 'details' | 'list' | 'grid';

interface ChapterFolderViewProps {
  book: Book;
  theme: Theme;
  onAddChapter: () => void;
  onOpenChapter: (chapterId: string) => void;
  onToggleFavorite: (chapterId: string) => void;
  onUpdateChapterTitle: (chapterId: string, newTitle: string) => void;
  onDeleteChapter: (chapterId: string) => void;
  onUpdateChapter: (chapter: Chapter) => void;
  onBackToLibrary: () => void;
  onBulkAudioEnsure?: () => void;
}

const ChapterFolderView: React.FC<ChapterFolderViewProps> = ({
  book, theme, onAddChapter, onOpenChapter, onToggleFavorite, onUpdateChapterTitle, onDeleteChapter, onUpdateChapter, onBackToLibrary, onBulkAudioEnsure
}) => {
  const VIEW_MODE_KEY = `talevox:viewMode:${book.id}`;
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    const saved = localStorage.getItem(VIEW_MODE_KEY);
    return (saved === 'details' || saved === 'list' || saved === 'grid') ? (saved as ViewMode) : 'details';
  });

  useEffect(() => { localStorage.setItem(VIEW_MODE_KEY, viewMode); }, [viewMode, VIEW_MODE_KEY]);

  const isDark = theme === Theme.DARK;
  const isSepia = theme === Theme.SEPIA;
  const cardBg = isDark ? 'bg-slate-800 border-slate-700' : isSepia ? 'bg-[#f4ecd8] border-[#d8ccb6]' : 'bg-white border-black/10';
  const textPrimary = isDark ? 'text-slate-100' : isSepia ? 'text-[#3c2f25]' : 'text-black';
  const textSecondary = isDark ? 'text-slate-400' : isSepia ? 'text-[#3c2f25]/70' : 'text-slate-600';

  const chapters = useMemo(() => [...(book.chapters || [])].sort((a, b) => a.index - b.index), [book.chapters]);
  const progressData = useMemo(() => {
    const store = JSON.parse(localStorage.getItem(PROGRESS_STORE_V4) || '{}');
    return store[book.id] || {};
  }, [book.id, chapters]);

  const handleRestart = (chapterId: string) => {
    const storeRaw = localStorage.getItem(PROGRESS_STORE_V4);
    const store = storeRaw ? JSON.parse(storeRaw) : {};
    if (!store[book.id]) return;
    if (store[book.id][chapterId]) {
      store[book.id][chapterId] = { ...store[book.id][chapterId], timeSec: 0, percent: 0, completed: false, updatedAt: Date.now() };
      localStorage.setItem(PROGRESS_STORE_V4, JSON.stringify(store));
      window.dispatchEvent(new CustomEvent('talevox_progress_updated', { detail: { bookId: book.id, chapterId: chapterId } }));
    }
  };

  const renderAudioStatusIcon = (c: Chapter) => {
    if (c.audioStatus === AudioStatus.READY) {
      return <Cloud className="w-4 h-4 text-indigo-500" title="Audio ready" />;
    }
    if (c.audioStatus === AudioStatus.GENERATING) {
      return <Loader2 className="w-4 h-4 text-indigo-400 animate-spin" title="Generating..." />;
    }
    return <AlertCircle className="w-4 h-4 text-amber-500" title="Audio missing — generate/sync needed" />;
  };

  const renderDetailsView = () => (
    <div className={`rounded-3xl border shadow-sm overflow-hidden ${cardBg}`}>
      <div className={`grid grid-cols-[40px_1fr_100px_100px] px-6 py-3 text-[10px] font-black uppercase tracking-widest border-b ${isDark ? 'border-slate-800 bg-slate-950/40 text-indigo-400' : 'border-black/5 bg-black/5 text-indigo-600'}`}>
        <div>Idx</div><div>Title</div><div className="text-right px-4">Progress</div><div className="text-right">Actions</div>
      </div>
      <div className="divide-y divide-black/5">
        {chapters.map(c => {
          const saved = progressData[c.id];
          const isCompleted = saved?.completed || false;
          const percent = saved?.percent !== undefined ? Math.floor(saved.percent * 100) : 0;
          return (
            <div key={c.id} onClick={() => onOpenChapter(c.id)} className={`grid grid-cols-[40px_1fr_100px_100px] items-center px-6 py-4 cursor-pointer border-b last:border-0 transition-colors ${isDark ? 'hover:bg-white/5 border-slate-800' : 'hover:bg-black/5 border-black/5'} ${isCompleted ? 'opacity-50' : ''}`}>
              <div className={`font-mono text-xs font-black ${textSecondary}`}>{String(c.index).padStart(3, '0')}</div>
              <div className="flex items-center gap-3 min-w-0 mr-4">
                <div className="font-black text-sm truncate">{c.title}</div>
                {renderAudioStatusIcon(c)}
              </div>
              <div className="text-right px-4">
                <span className={`text-[10px] font-black px-2 py-0.5 rounded-full ${isCompleted ? 'bg-emerald-500/20 text-emerald-600' : 'bg-indigo-500/15 text-indigo-500'}`}>{isCompleted ? 'Done' : `${percent}%`}</span>
              </div>
              <div className="flex justify-end items-center gap-2">
                {isCompleted && <button onClick={(e) => { e.stopPropagation(); handleRestart(c.id); }} className="p-2 bg-indigo-600/10 text-indigo-600 rounded-xl hover:bg-indigo-600/20"><RotateCcw className="w-4 h-4" /></button>}
                <button onClick={(e) => { e.stopPropagation(); if (confirm('Delete?')) onDeleteChapter(c.id); }} className="p-2 opacity-40 hover:opacity-100 hover:text-red-500"><Trash2 className="w-4 h-4" /></button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );

  const renderListView = () => (
    <div className="space-y-2">
      {chapters.map(c => (
        <div key={c.id} onClick={() => onOpenChapter(c.id)} className={`flex items-center gap-4 p-4 rounded-2xl border cursor-pointer transition-all hover:translate-x-1 ${cardBg}`}>
          <div className={`w-8 h-8 rounded-lg flex items-center justify-center font-mono text-[10px] font-black ${isDark ? 'bg-slate-950 text-indigo-400' : 'bg-indigo-50 text-indigo-600'}`}>{c.index}</div>
          <div className="flex-1 min-w-0 font-black text-sm truncate">{c.title}</div>
          <div className="flex items-center gap-3">
            {renderAudioStatusIcon(c)}
            <button onClick={(e) => { e.stopPropagation(); if (confirm('Delete?')) onDeleteChapter(c.id); }} className="p-2 opacity-40 hover:opacity-100 hover:text-red-500"><Trash2 className="w-4 h-4" /></button>
          </div>
        </div>
      ))}
    </div>
  );

  const renderGridView = () => (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
      {chapters.map(c => (
        <div key={c.id} onClick={() => onOpenChapter(c.id)} className={`aspect-square p-4 rounded-3xl border flex flex-col items-center justify-center text-center gap-2 cursor-pointer transition-all hover:scale-105 group relative ${cardBg}`}>
          <div className="absolute top-3 right-3">{renderAudioStatusIcon(c)}</div>
          <div className={`w-12 h-12 rounded-2xl flex items-center justify-center font-mono text-lg font-black mb-1 ${isDark ? 'bg-slate-950 text-indigo-400' : 'bg-indigo-50 text-indigo-600'}`}>{c.index}</div>
          <div className="font-black text-xs line-clamp-2 leading-tight px-1">{c.title}</div>
          <button onClick={(e) => { e.stopPropagation(); if (confirm('Delete?')) onDeleteChapter(c.id); }} className="absolute bottom-2 right-2 p-2 opacity-0 group-hover:opacity-100 text-red-500 transition-opacity"><Trash2 className="w-3.5 h-3.5" /></button>
        </div>
      ))}
    </div>
  );

  return (
    <div className={`h-full min-h-0 flex flex-col ${isDark ? 'bg-slate-900 text-slate-100' : isSepia ? 'bg-[#f4ecd8] text-[#3c2f25]' : 'bg-white text-black'}`}>
      <div className="p-6 sm:p-8 flex-shrink-0 border-b border-black/5 bg-black/5">
        <div className="flex items-center justify-between mb-6">
          <button onClick={onBackToLibrary} className="flex items-center gap-1 text-[10px] font-black uppercase tracking-widest text-indigo-500 hover:translate-x-[-2px] transition-transform">
            <ChevronLeft className="w-3 h-3" /> Library
          </button>
          <div className="flex items-center gap-1 p-1 rounded-xl bg-black/5">
            <button onClick={() => setViewMode('grid')} className={`p-2 rounded-lg transition-all ${viewMode === 'grid' ? 'bg-white shadow-sm text-indigo-600' : 'opacity-40'}`}><LayoutGrid className="w-4 h-4" /></button>
            <button onClick={() => setViewMode('list')} className={`p-2 rounded-lg transition-all ${viewMode === 'list' ? 'bg-white shadow-sm text-indigo-600' : 'opacity-40'}`}><AlignJustify className="w-4 h-4" /></button>
            <button onClick={() => setViewMode('details')} className={`p-2 rounded-lg transition-all ${viewMode === 'details' ? 'bg-white shadow-sm text-indigo-600' : 'opacity-40'}`}><List className="w-4 h-4" /></button>
          </div>
        </div>
        
        <div className="flex flex-col md:flex-row gap-8 items-start md:items-center">
          <div className="w-32 aspect-[2/3] rounded-2xl overflow-hidden shadow-2xl flex-shrink-0 bg-indigo-600/10 flex items-center justify-center">
            {book.coverImage ? <img src={book.coverImage} className="w-full h-full object-cover" alt={book.title} /> : <ImageIcon className="w-10 h-10 opacity-20" />}
          </div>
          <div className="flex-1 min-w-0">
            <h1 className="text-3xl font-black tracking-tight mb-2 truncate">{book.title}</h1>
            <p className="text-xs font-bold opacity-60 uppercase tracking-widest mb-6">{book.chapters.length} Chapters • {book.backend} backend</p>
            <div className="flex flex-wrap gap-3">
              <button onClick={onAddChapter} className="px-6 py-3 bg-indigo-600 text-white rounded-2xl font-black uppercase text-[10px] tracking-widest shadow-xl hover:scale-105 active:scale-95 transition-all flex items-center gap-2"><Plus className="w-4 h-4" /> Add Chapter</button>
              <button onClick={onBulkAudioEnsure} className="px-6 py-3 bg-white text-indigo-600 border border-indigo-600/20 rounded-2xl font-black uppercase text-[10px] tracking-widest shadow-lg hover:bg-indigo-50 active:scale-95 transition-all flex items-center gap-2" title="Make sure all chapters have audio files"><Wand2 className="w-4 h-4" /> Ensure Audio</button>
            </div>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-8">
        {chapters.length === 0 ? (
          <div className="p-12 text-center text-xs font-black opacity-30 uppercase">No chapters found</div>
        ) : (
          <>
            {viewMode === 'details' && renderDetailsView()}
            {viewMode === 'list' && renderListView()}
            {viewMode === 'grid' && renderGridView()}
          </>
        )}
      </div>
    </div>
  );
};

export default ChapterFolderView;
