import React, { useMemo, useState } from 'react';
import { Book, Theme, StorageBackend } from '../types';
import { LayoutGrid, List, AlignJustify, Plus, Star, Folder, Link2, CheckCircle2, Download, Edit2, Check, X, RefreshCw } from 'lucide-react';

type ViewMode = 'details' | 'list' | 'grid';

interface ChapterFolderViewProps {
  book: Book;
  theme: Theme;
  onAddChapter: () => void;
  onOpenChapter: (chapterId: string) => void;
  onToggleFavorite: (chapterId: string) => void;
  onUpdateChapterTitle: (chapterId: string, newTitle: string) => void;
  onRefreshDriveFolder?: () => void;
  onLinkFolder?: (handle: any) => void;
}

const ChapterFolderView: React.FC<ChapterFolderViewProps> = ({
  book,
  theme,
  onAddChapter,
  onOpenChapter,
  onToggleFavorite,
  onUpdateChapterTitle,
  onRefreshDriveFolder,
  onLinkFolder
}) => {
  const [viewMode, setViewMode] = useState<ViewMode>('details');
  const [editingChapterId, setEditingChapterId] = useState<string | null>(null);
  const [tempTitle, setTempTitle] = useState('');

  const isDark = theme === Theme.DARK;
  const isSepia = theme === Theme.SEPIA;

  const pageBg = isDark ? 'bg-slate-900 text-slate-100' : isSepia ? 'bg-[#f4ecd8] text-[#3c2f25]' : 'bg-white text-black';
  const cardBg = isDark ? 'bg-slate-800 border-slate-700' : isSepia ? 'bg-[#efe6d5] border-[#d8ccb6]' : 'bg-white border-black/10';
  const controlBg = isDark ? 'bg-slate-950/40 border-slate-800' : isSepia ? 'bg-[#efe6d5] border-[#d8ccb6]' : 'bg-white border-black/5';
  const textPrimary = isDark ? 'text-slate-100' : isSepia ? 'text-[#3c2f25]' : 'text-black';
  const textSecondary = isDark ? 'text-slate-400' : isSepia ? 'text-[#3c2f25]/70' : 'text-slate-600';

  const chapters = useMemo(() => {
    return [...(book.chapters || [])].sort((a, b) => a.index - b.index);
  }, [book.chapters]);

  const canPickFolder = typeof (window as any).showDirectoryPicker === 'function';

  const handleStartEdit = (e: React.MouseEvent, chapterId: string, currentTitle: string) => {
    e.stopPropagation();
    setEditingChapterId(chapterId);
    setTempTitle(currentTitle);
  };

  const handleSaveEdit = (e?: React.FormEvent | React.MouseEvent) => {
    e?.stopPropagation();
    if (editingChapterId && tempTitle.trim()) {
      onUpdateChapterTitle(editingChapterId, tempTitle.trim());
    }
    setEditingChapterId(null);
  };

  const handleCancelEdit = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    setEditingChapterId(null);
  };

  const handleLinkFolder = async () => {
    if (!onLinkFolder || !canPickFolder) return;
    try {
      const handle = await (window as any).showDirectoryPicker({ mode: 'readwrite' });
      onLinkFolder(handle);
    } catch (e) {
      console.warn("Folder picker cancelled");
    }
  };

  const downloadAllChapters = () => {
    chapters.forEach((chapter, i) => {
      setTimeout(() => {
        const blob = new Blob([chapter.content], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const safeTitle = chapter.title.replace(/[^a-z0-9]/gi, '_').toLowerCase();
        a.download = `${chapter.index.toString().padStart(3, '0')}_${safeTitle}.txt`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, i * 300);
    });
  };

  const renderRow = (c: any) => {
    const idx = String(c.index).padStart(3, '0');
    const words = c.wordCount ? Number(c.wordCount).toLocaleString() : '0';
    const percent = c.progressTotalLength ? Math.min(100, Math.round((c.progress / c.progressTotalLength) * 100)) : 0;
    const isEditing = editingChapterId === c.id;
    
    return (
      <div
        key={c.id}
        onClick={() => !isEditing && onOpenChapter(c.id)}
        className={`grid grid-cols-[40px_1fr_60px] sm:grid-cols-[86px_1fr_120px_100px_100px] items-center px-4 sm:px-6 py-4 cursor-pointer select-none border-b last:border-0 transition-colors ${isDark ? 'hover:bg-white/5 border-slate-800' : 'hover:bg-black/5 border-black/5'} ${c.isCompleted ? 'opacity-60' : ''}`}
      >
        <div className={`font-mono text-[10px] sm:text-xs font-black flex items-center gap-2 ${textSecondary}`}>
          {c.isCompleted && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 hidden sm:block" />}
          {idx}
        </div>
        
        <div className="flex items-center gap-4 min-w-0 mr-2 sm:mr-4">
          {isEditing ? (
            <div className="flex-1 flex items-center gap-2" onClick={e => e.stopPropagation()}>
              <input
                autoFocus
                type="text"
                value={tempTitle}
                onChange={e => setTempTitle(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') handleSaveEdit();
                  if (e.key === 'Escape') handleCancelEdit();
                }}
                className={`flex-1 px-3 py-1.5 rounded-lg border-2 font-black text-sm outline-none ${isDark ? 'bg-slate-900 border-indigo-600 text-white' : 'bg-white border-indigo-600 text-black'}`}
              />
              <button onClick={handleSaveEdit} className="p-1.5 bg-emerald-600 text-white rounded-lg hover:scale-110 transition-transform"><Check className="w-4 h-4" /></button>
            </div>
          ) : (
            <div className={`truncate font-black text-xs sm:text-sm ${c.isCompleted ? 'line-through decoration-indigo-500/40' : ''}`}>{c.title}</div>
          )}
        </div>

        <div className={`text-[10px] sm:text-xs font-black text-right hidden sm:block ${textSecondary}`}>{words} words</div>
        <div className="text-right">
          <span className={`text-[9px] sm:text-[10px] font-black px-2 py-0.5 sm:px-2.5 sm:py-1 rounded-full ${percent >= 100 ? 'bg-emerald-500/20 text-emerald-600' : 'bg-indigo-500/15 text-indigo-500'}`}>
            {percent}%
          </span>
        </div>
        <div className="flex justify-end items-center gap-2 hidden sm:flex">
          {!isEditing && (
            <button
              onClick={(e) => handleStartEdit(e, c.id, c.title)}
              className={`p-2 rounded-xl border transition-all ${controlBg} opacity-60 hover:opacity-100 hover:text-indigo-500`}
              title="Rename Chapter"
            >
              <Edit2 className="w-4 h-4" />
            </button>
          )}
          <button
            onClick={(e) => {
              e.stopPropagation();
              onToggleFavorite(c.id);
            }}
            className={`p-2 rounded-xl border transition-all ${controlBg} ${c.isFavorite ? 'opacity-100 text-amber-500 border-amber-500/30' : 'opacity-60 hover:opacity-100'}`}
          >
            <Star className={`w-4 h-4 ${c.isFavorite ? 'fill-current' : ''}`} />
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className={`h-full min-h-0 flex flex-col ${pageBg}`}>
      <div className="px-4 sm:px-8 pt-6 sm:pt-8">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
          <div className="flex items-center gap-4 min-w-0">
            <div className={`p-3.5 sm:p-4 rounded-[1.2rem] sm:rounded-[1.5rem] border shadow-sm ${cardBg}`}>
              <Folder className="w-5 h-5 sm:w-6 sm:h-6 text-indigo-600" />
            </div>
            <div className="min-w-0">
              <div className={`text-[9px] sm:text-[11px] font-black uppercase tracking-widest ${isDark ? 'text-indigo-400' : 'text-indigo-600'}`}>Library Collection</div>
              <div className="text-xl sm:text-2xl font-black tracking-tight truncate leading-none mt-1">{book.title}</div>
            </div>
          </div>

          <div className="flex items-center flex-wrap gap-2 sm:gap-3">
            <button
              onClick={downloadAllChapters}
              title="Download all chapters as .txt files"
              className={`px-3 py-2 rounded-xl border text-[10px] font-black flex items-center gap-1.5 shadow-sm ${controlBg} ${textPrimary}`}
            >
              <Download className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Export .TXT</span>
              <span className="sm:hidden">Export</span>
            </button>

            {book.backend === StorageBackend.DRIVE && onRefreshDriveFolder && (
               <button
                 onClick={onRefreshDriveFolder}
                 title="Force Re-scan Google Drive Folder"
                 className={`px-3 py-2 rounded-xl border text-[10px] font-black flex items-center gap-1.5 shadow-sm ${controlBg} ${textPrimary}`}
               >
                 <RefreshCw className="w-3.5 h-3.5" />
                 <span className="hidden sm:inline">Refresh Folder</span>
                 <span className="sm:hidden">Refresh</span>
               </button>
            )}

            <div className={`flex items-center gap-1 p-1 rounded-xl border shadow-sm ${controlBg}`}>
              <button onClick={() => setViewMode('details')} className={`p-1.5 sm:p-2 rounded-lg transition-all ${viewMode === 'details' ? (isDark ? 'bg-white/10' : 'bg-black/10') : 'opacity-60'}`}><AlignJustify className="w-3.5 h-3.5 sm:w-4 sm:h-4" /></button>
              <button onClick={() => setViewMode('list')} className={`p-1.5 sm:p-2 rounded-lg transition-all ${viewMode === 'list' ? (isDark ? 'bg-white/10' : 'bg-black/10') : 'opacity-60'}`}><List className="w-3.5 h-3.5 sm:w-4 sm:h-4" /></button>
              <button onClick={() => setViewMode('grid')} className={`p-1.5 sm:p-2 rounded-lg transition-all ${viewMode === 'grid' ? (isDark ? 'bg-white/10' : 'bg-black/10') : 'opacity-60'}`}><LayoutGrid className="w-3.5 h-3.5 sm:w-4 sm:h-4" /></button>
            </div>

            <button
              onClick={onAddChapter}
              className="px-5 py-2.5 rounded-xl text-[10px] sm:text-[11px] font-black flex items-center gap-2 bg-indigo-600 text-white shadow-lg shadow-indigo-600/20 hover:scale-105 active:scale-95 transition-all"
            >
              <Plus className="w-3.5 h-3.5" />
              Import Chapter
            </button>
          </div>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-4 sm:px-8 pb-12 pt-6 sm:pt-8">
        <div className={`rounded-[1.5rem] sm:rounded-[2.5rem] border shadow-sm overflow-hidden ${cardBg}`}>
          {chapters.length === 0 ? (
            <div className="p-12 sm:p-16 text-center">
              <div className={`text-lg font-black ${textPrimary}`}>Empty Collection</div>
              <div className={`text-xs sm:text-sm font-bold mt-2 ${textSecondary}`}>Add chapters or Refresh to get started.</div>
              <div className="flex flex-col sm:flex-row justify-center gap-3 mt-8">
                <button onClick={onAddChapter} className="inline-flex items-center justify-center gap-3 px-8 py-4 rounded-2xl bg-indigo-600 text-white text-xs font-black shadow-xl"><Plus className="w-5 h-5" /> Import Chapter</button>
                {book.backend === StorageBackend.DRIVE && onRefreshDriveFolder && (
                  <button onClick={onRefreshDriveFolder} className="inline-flex items-center justify-center gap-3 px-8 py-4 rounded-2xl border text-indigo-600 text-xs font-black shadow-sm"><RefreshCw className="w-5 h-5" /> Refresh Files</button>
                )}
              </div>
            </div>
          ) : viewMode === 'details' ? (
            <div>
              <div className={`grid grid-cols-[40px_1fr_60px] sm:grid-cols-[86px_1fr_120px_100px_100px] px-4 sm:px-6 py-4 text-[9px] sm:text-[11px] font-black uppercase tracking-widest border-b ${isDark ? 'border-slate-800 bg-slate-950/40 text-indigo-400' : 'border-black/5 bg-black/5 text-indigo-600'}`}>
                <div>Index</div>
                <div>Name</div>
                <div className="text-right hidden sm:block">Words</div>
                <div className="text-right">Prog.</div>
                <div className="text-right hidden sm:block">Action</div>
              </div>
              <div className={`divide-y ${isDark ? 'divide-slate-800' : 'divide-white/5'}`}>{chapters.map(renderRow)}</div>
            </div>
          ) : viewMode === 'list' ? (
            <div className={`divide-y ${isDark ? 'divide-slate-800' : 'divide-black/5'}`}>
              {chapters.map((c) => {
                const isEditing = editingChapterId === c.id;
                const percent = c.progressTotalLength ? Math.min(100, Math.round((c.progress / c.progressTotalLength) * 100)) : 0;
                return (
                  <div key={c.id} onClick={() => !isEditing && onOpenChapter(c.id)} className={`w-full text-left px-4 sm:px-6 py-4 flex items-center gap-3 sm:gap-4 transition-colors cursor-pointer group ${isDark ? 'hover:bg-white/5' : 'hover:bg-black/5'} ${c.isCompleted ? 'opacity-60' : ''}`}>
                    <span className={`font-mono text-[10px] sm:text-xs font-black w-[30px] sm:w-[80px] flex items-center gap-2 ${textSecondary}`}>{c.isCompleted && <CheckCircle2 className="w-3 h-3 text-emerald-500 hidden sm:block" />}{String(c.index).padStart(3, '0')}</span>
                    {isEditing ? (
                      <div className="flex-1 flex items-center gap-2" onClick={e => e.stopPropagation()}>
                        <input autoFocus type="text" value={tempTitle} onChange={e => setTempTitle(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') handleSaveEdit(); if (e.key === 'Escape') handleCancelEdit(); }} className={`flex-1 px-3 py-1 rounded-lg border-2 font-black text-sm outline-none ${isDark ? 'bg-slate-900 border-indigo-600 text-white' : 'bg-white border-indigo-600 text-black'}`} />
                      </div>
                    ) : (
                      <span className={`font-black text-xs sm:text-sm flex-1 truncate ${c.isCompleted ? 'line-through decoration-indigo-500/40' : ''}`}>{c.title}</span>
                    )}
                    <button onClick={(e) => handleStartEdit(e, c.id, c.title)} className="p-1.5 opacity-60 sm:opacity-0 group-hover:opacity-100 transition-opacity"><Edit2 className="w-3.5 h-3.5" /></button>
                    {percent > 0 && <span className={`text-[9px] sm:text-[11px] font-black px-2 py-0.5 rounded-full ${isDark ? 'bg-indigo-600/30' : 'bg-indigo-600/10'} text-indigo-500`}>{percent}%</span>}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="p-4 sm:p-6 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {chapters.map((c) => {
                const percent = c.progressTotalLength ? Math.min(100, Math.round((c.progress / c.progressTotalLength) * 100)) : 0;
                return (
                  <button key={c.id} onClick={() => onOpenChapter(c.id)} className={`text-left p-5 sm:p-6 rounded-2xl sm:rounded-3xl border transition-all ${controlBg} ${isDark ? 'hover:bg-slate-800 hover:border-indigo-600/30' : 'hover:bg-black/5 hover:border-indigo-600/30'} ${c.isCompleted ? 'opacity-60' : ''}`}>
                    <div className="flex justify-between items-start mb-3 sm:mb-4">
                      <div className={`text-[11px] sm:text-[12px] font-mono font-black flex items-center gap-1.5 ${textSecondary}`}>{c.isCompleted && <CheckCircle2 className="w-3 h-3 text-emerald-500" />}#{String(c.index).padStart(3, '0')}</div>
                      {percent > 0 && <div className={`text-[9px] font-black px-2 py-0.5 rounded-full ${isDark ? 'bg-indigo-600/30' : 'bg-indigo-600/15'} text-indigo-500`}>{percent}%</div>}
                    </div>
                    <div className={`text-sm sm:text-base font-black leading-tight line-clamp-2 ${textPrimary} ${c.isCompleted ? 'line-through' : ''}`}>{c.title}</div>
                    <div className={`mt-4 text-[9px] sm:text-[11px] font-black uppercase tracking-wider ${textSecondary}`}>{c.wordCount ? Number(c.wordCount).toLocaleString() : '0'} Words</div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default ChapterFolderView;