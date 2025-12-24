
import React, { useMemo, useState, useEffect } from 'react';
import { Book, Theme, StorageBackend, Chapter, AudioChunkMetadata, AudioStatus } from '../types';
import { LayoutGrid, List, AlignJustify, Plus, Folder, CheckCircle2, Edit2, Check, RefreshCw, Trash2, Headphones, Loader2, Cloud, AlertTriangle, X, RotateCcw, ChevronLeft, Image as ImageIcon } from 'lucide-react';
import { synthesizeChunk } from '../services/cloudTtsService';
import { saveAudioToCache, generateAudioKey, getAudioFromCache } from '../services/audioCache';
import { uploadToDrive, listFilesInFolder, buildMp3Name } from '../services/driveService';
import { PROGRESS_STORE_V4, applyRules } from '../services/speechService';

type ViewMode = 'details' | 'list' | 'grid';

const CLOUD_VOICES = [
  { id: 'en-US-Standard-C', name: 'Standard Female (US)' },
  { id: 'en-US-Standard-D', name: 'Standard Male (US)' },
  { id: 'en-US-Wavenet-D', name: 'Premium Male (US)' },
  { id: 'en-US-Wavenet-C', name: 'Premium Female (US)' },
  { id: 'en-GB-Wavenet-B', name: 'Premium Male (UK)' },
  { id: 'en-GB-Wavenet-A', name: 'Premium Female (UK)' },
];

interface ChapterFolderViewProps {
  book: Book;
  theme: Theme;
  onAddChapter: () => void;
  onOpenChapter: (chapterId: string) => void;
  onToggleFavorite: (chapterId: string) => void;
  onUpdateChapterTitle: (chapterId: string, newTitle: string) => void;
  onDeleteChapter: (chapterId: string) => void;
  onUpdateChapter: (chapter: Chapter) => void;
  onUpdateBookSettings?: (settings: any) => void;
  onBackToLibrary: () => void;
}

const ChapterFolderView: React.FC<ChapterFolderViewProps> = ({
  book, theme, onAddChapter, onOpenChapter, onToggleFavorite, onUpdateChapterTitle, onDeleteChapter, onUpdateChapter, onUpdateBookSettings, onBackToLibrary
}) => {
  const VIEW_MODE_KEY = `talevox:viewMode:${book.id}`;
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    const saved = localStorage.getItem(VIEW_MODE_KEY);
    return (saved === 'details' || saved === 'list' || saved === 'grid') ? (saved as ViewMode) : 'details';
  });

  useEffect(() => { localStorage.setItem(VIEW_MODE_KEY, viewMode); }, [viewMode, VIEW_MODE_KEY]);

  const [editingChapterId, setEditingChapterId] = useState<string | null>(null);
  const [tempTitle, setTempTitle] = useState('');
  const [showVoiceModal, setShowVoiceModal] = useState<{ chapterId?: string; isBulk?: boolean } | null>(null);

  const isDark = theme === Theme.DARK;
  const isSepia = theme === Theme.SEPIA;
  const cardBg = isDark ? 'bg-slate-800 border-slate-700' : isSepia ? 'bg-[#f4ecd8] border-[#d8ccb6]' : 'bg-white border-black/10';
  const controlBg = isDark ? 'bg-slate-950/40 border-slate-800' : isSepia ? 'bg-[#efe6d5] border-[#d8ccb6]' : 'bg-white border-black/5';
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

  const renderAudioStatus = (c: Chapter) => {
    switch (c.audioStatus) {
      case AudioStatus.PENDING: return <div className="flex items-center gap-1.5"><Loader2 className="w-3 h-3 animate-spin opacity-40" /><span className="text-[9px] font-black uppercase tracking-widest opacity-40">Queue</span></div>;
      case AudioStatus.GENERATING: return <div className="flex items-center gap-1.5"><Loader2 className="w-3 h-3 animate-spin text-indigo-500" /><span className="text-[9px] font-black uppercase tracking-widest text-indigo-500">Processing</span></div>;
      case AudioStatus.READY: return <div className="flex items-center gap-1.5"><CheckCircle2 className="w-3 h-3 text-emerald-500" /><span className="text-[9px] font-black uppercase tracking-widest text-emerald-500">Ready</span></div>;
      case AudioStatus.FAILED: return <div className="flex items-center gap-1.5"><AlertTriangle className="w-3 h-3 text-red-500" /><span className="text-[9px] font-black uppercase tracking-widest text-red-500">Error</span></div>;
      default: return null;
    }
  };

  const renderRow = (c: Chapter) => {
    const isEditing = editingChapterId === c.id;
    const saved = progressData[c.id];
    const isCompleted = saved?.completed || false;
    const percent = saved?.percent !== undefined ? Math.floor(saved.percent * 100) : 0;

    return (
      <div key={c.id} onClick={() => !isEditing && onOpenChapter(c.id)} className={`grid grid-cols-[40px_1fr_100px_100px] items-center px-6 py-4 cursor-pointer border-b last:border-0 transition-colors ${isDark ? 'hover:bg-white/5 border-slate-800' : 'hover:bg-black/5 border-black/5'} ${isCompleted ? 'opacity-50' : ''}`}>
        <div className={`font-mono text-xs font-black ${textSecondary}`}>{String(c.index).padStart(3, '0')}</div>
        <div className="flex flex-col min-w-0 mr-4">
          <div className="font-black text-sm truncate">{c.title}</div>
          <div className="mt-1">{renderAudioStatus(c)}</div>
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
  };

  return (
    <div className={`h-full min-h-0 flex flex-col ${isDark ? 'bg-slate-900 text-slate-100' : isSepia ? 'bg-[#f4ecd8] text-[#3c2f25]' : 'bg-white text-black'}`}>
      <div className="p-6 sm:p-8 flex-shrink-0 border-b border-black/5 bg-black/5">
        <button onClick={onBackToLibrary} className="flex items-center gap-1 text-[10px] font-black uppercase tracking-widest text-indigo-500 mb-6 hover:translate-x-[-2px] transition-transform">
          <ChevronLeft className="w-3 h-3" /> Library
        </button>
        
        <div className="flex flex-col md:flex-row gap-8 items-start md:items-center">
          <div className="w-32 aspect-[2/3] rounded-2xl overflow-hidden shadow-2xl flex-shrink-0 bg-indigo-600/10 flex items-center justify-center">
            {book.coverImage ? <img src={book.coverImage} className="w-full h-full object-cover" alt={book.title} /> : <ImageIcon className="w-10 h-10 opacity-20" />}
          </div>
          <div className="flex-1 min-w-0">
            <h1 className="text-3xl font-black tracking-tight mb-2 truncate">{book.title}</h1>
            <p className="text-xs font-bold opacity-60 uppercase tracking-widest mb-6">{book.chapters.length} Chapters • {book.backend} backend</p>
            <div className="flex gap-3">
              <button onClick={onAddChapter} className="px-6 py-3 bg-indigo-600 text-white rounded-2xl font-black uppercase text-[10px] tracking-widest shadow-xl hover:scale-105 active:scale-95 transition-all flex items-center gap-2"><Plus className="w-4 h-4" /> Add Chapter</button>
            </div>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-8">
        <div className={`rounded-3xl border shadow-sm overflow-hidden ${cardBg}`}>
          <div className={`grid grid-cols-[40px_1fr_100px_100px] px-6 py-3 text-[10px] font-black uppercase tracking-widest border-b ${isDark ? 'border-slate-800 bg-slate-950/40 text-indigo-400' : 'border-black/5 bg-black/5 text-indigo-600'}`}>
            <div>Idx</div><div>Title</div><div className="text-right px-4">Progress</div><div className="text-right">Actions</div>
          </div>
          <div className="divide-y divide-black/5">
            {chapters.map(renderRow)}
            {chapters.length === 0 && <div className="p-12 text-center text-xs font-black opacity-30 uppercase">No chapters found</div>}
          </div>
        </div>
      </div>
    </div>
  );
};

export default ChapterFolderView;
