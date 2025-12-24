
import React, { useMemo, useState, useEffect, useCallback } from 'react';
import { Book, Theme, StorageBackend, Chapter, AudioStatus, CLOUD_VOICES } from '../types';
import { LayoutGrid, List, AlignJustify, Plus, Edit2, RefreshCw, Trash2, Headphones, Loader2, Cloud, AlertTriangle, X, RotateCcw, ChevronLeft, Image as ImageIcon, Search, FileX, AlertCircle } from 'lucide-react';
import { PROGRESS_STORE_V4, applyRules } from '../services/speechService';
import { synthesizeChunk } from '../services/cloudTtsService';
import { saveAudioToCache, generateAudioKey, getAudioFromCache } from '../services/audioCache';
import { uploadToDrive, listFilesInFolder, buildMp3Name, buildTextName } from '../services/driveService';

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
  onUpdateBookSettings?: (settings: any) => void;
  onBackToLibrary: () => void;
}

const ChapterFolderView: React.FC<ChapterFolderViewProps> = ({
  book, theme, onAddChapter, onOpenChapter, onUpdateChapterTitle, onDeleteChapter, onUpdateChapter, onUpdateBookSettings, onBackToLibrary
}) => {
  const VIEW_MODE_KEY = `talevox:viewMode:${book.id}`;
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    const saved = localStorage.getItem(VIEW_MODE_KEY);
    return (saved === 'details' || saved === 'list' || saved === 'grid') ? (saved as ViewMode) : 'details';
  });

  useEffect(() => { localStorage.setItem(VIEW_MODE_KEY, viewMode); }, [viewMode, VIEW_MODE_KEY]);

  const [editingChapterId, setEditingChapterId] = useState<string | null>(null);
  const [tempTitle, setTempTitle] = useState('');
  const [synthesizingId, setSynthesizingId] = useState<string | null>(null);
  const [isCheckingDrive, setIsCheckingDrive] = useState(false);
  const [showVoiceModal, setShowVoiceModal] = useState<{ chapterId?: string } | null>(null);
  const [rememberAsDefault, setRememberAsDefault] = useState(true);

  const isDark = theme === Theme.DARK;
  const isSepia = theme === Theme.SEPIA;
  const cardBg = isDark ? 'bg-slate-800 border-slate-700' : isSepia ? 'bg-[#f4ecd8] border-[#d8ccb6]' : 'bg-white border-black/10';
  const textSecondary = isDark ? 'text-slate-400' : isSepia ? 'text-[#3c2f25]/70' : 'text-slate-600';

  const chapters = useMemo(() => [...(book.chapters || [])].sort((a, b) => a.index - b.index), [book.chapters]);
  const progressData = useMemo(() => {
    const store = JSON.parse(localStorage.getItem(PROGRESS_STORE_V4) || '{}');
    return store[book.id] || {};
  }, [book.id]);

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

  const handleCheckDriveIntegrity = useCallback(async () => {
    if (!book.driveFolderId) return;
    setIsCheckingDrive(true);
    try {
      const driveFiles = await listFilesInFolder(book.driveFolderId);
      const fileMap = new Map(driveFiles.map(f => [f.name, f.id]));
      
      let missingText = 0;
      let missingAudio = 0;

      for (const chapter of chapters) {
        const expectedTextName = buildTextName(chapter.index, chapter.title);
        const expectedAudioName = buildMp3Name(chapter.index, chapter.title);
        
        const textId = fileMap.get(expectedTextName);
        const audioId = fileMap.get(expectedAudioName);

        if (!textId) missingText++;
        if (!audioId) missingAudio++;

        onUpdateChapter({
          ...chapter,
          cloudTextFileId: textId || chapter.cloudTextFileId,
          cloudAudioFileId: audioId || chapter.cloudAudioFileId,
          hasTextOnDrive: !!textId,
          audioStatus: audioId ? AudioStatus.READY : AudioStatus.PENDING
        });
      }

      alert(`Checked ${chapters.length} chapters:\n${missingText} missing text\n${missingAudio} missing audio`);
    } catch (e: any) {
      alert("Integrity check failed: " + e.message);
    } finally {
      setIsCheckingDrive(false);
    }
  }, [book.driveFolderId, chapters, onUpdateChapter]);

  const generateAudio = async (chapter: Chapter, voiceToUse?: string) => {
    const voice = voiceToUse || book.settings.defaultVoiceId || 'en-US-Standard-C';
    const introText = applyRules(`Chapter ${chapter.index}. ${chapter.title}. `, book.rules);
    const contentText = applyRules(chapter.content, book.rules);
    const fullText = introText + contentText;
    
    setSynthesizingId(chapter.id);
    try {
      const cacheKey = generateAudioKey(fullText, voice, 1.0);
      let audioBlob = await getAudioFromCache(cacheKey);
      
      if (!audioBlob) {
        const res = await synthesizeChunk(fullText, voice, 1.0);
        const fetchRes = await fetch(res.audioUrl);
        if (!fetchRes.ok) throw new Error("Synthesis output fetch failed");
        audioBlob = await fetchRes.blob();
        if (audioBlob) {
          await saveAudioToCache(cacheKey, audioBlob);
        }
      }

      if (!audioBlob) throw new Error("No audio blob available");

      let cloudId = chapter.cloudAudioFileId || chapter.audioDriveId;
      if (book.backend === StorageBackend.DRIVE && book.driveFolderId) {
        const filename = buildMp3Name(chapter.index, chapter.title);
        cloudId = await uploadToDrive(book.driveFolderId, filename, audioBlob, cloudId, 'audio/mpeg');
      }

      onUpdateChapter({
        ...chapter,
        cloudAudioFileId: cloudId,
        audioStatus: AudioStatus.READY,
        hasCachedAudio: true
      });
    } catch (e) {
      onUpdateChapter({ ...chapter, audioStatus: AudioStatus.FAILED });
    } finally {
      setSynthesizingId(null);
    }
  };

  const handleVoiceSelect = (voiceId: string) => {
    const chId = showVoiceModal?.chapterId;
    if (onUpdateBookSettings && rememberAsDefault) {
      onUpdateBookSettings({ ...book.settings, defaultVoiceId: voiceId });
    }
    setShowVoiceModal(null);
    if (chId) {
      const chapter = chapters.find(c => c.id === chId);
      if (chapter) generateAudio(chapter, voiceId);
    }
  };

  const renderAudioStatusIcon = (c: Chapter) => {
    if (c.cloudAudioFileId || c.audioDriveId || c.audioStatus === AudioStatus.READY) {
      return (
        <span title="Audio ready on Google Drive" className="inline-flex items-center">
          <Cloud className="w-4 h-4 text-emerald-500" />
        </span>
      );
    }
    if (synthesizingId === c.id || c.audioStatus === AudioStatus.GENERATING) {
      return (
        <span title="Generating and Uploading..." className="inline-flex items-center">
          <Loader2 className="w-4 h-4 text-indigo-400 animate-spin" />
        </span>
      );
    }
    return (
      <span title="Audio missing" className="inline-flex items-center">
        <AlertTriangle className="w-4 h-4 text-amber-500" />
      </span>
    );
  };

  const renderTextStatusIcon = (c: Chapter) => {
    if (book.backend !== StorageBackend.DRIVE) return null;
    if (c.hasTextOnDrive === false) {
      return (
        <span title="Source text missing from Drive" className="inline-flex items-center ml-2">
           <FileX className="w-4 h-4 text-red-500" />
        </span>
      );
    }
    return null;
  };

  const renderDetailsView = () => (
    <div className={`rounded-3xl border shadow-sm overflow-hidden ${cardBg}`}>
      <div className={`grid grid-cols-[40px_1fr_100px_150px] px-6 py-3 text-[10px] font-black uppercase tracking-widest border-b ${isDark ? 'border-slate-800 bg-slate-950/40 text-indigo-400' : 'border-black/5 bg-black/5 text-indigo-600'}`}>
        <div>Idx</div><div>Title</div><div className="text-right px-4">Progress</div><div className="text-right">Actions</div>
      </div>
      <div className="divide-y divide-black/5">
        {chapters.map(c => {
          const saved = progressData[c.id];
          const isCompleted = saved?.completed || false;
          const percent = saved?.percent !== undefined ? Math.floor(saved.percent * 100) : 0;
          const isEditing = editingChapterId === c.id;

          return (
            <div key={c.id} onClick={() => !isEditing && onOpenChapter(c.id)} className={`grid grid-cols-[40px_1fr_100px_150px] items-center px-6 py-4 cursor-pointer border-b last:border-0 transition-colors ${isDark ? 'hover:bg-white/5 border-slate-800' : 'hover:bg-black/5 border-black/5'} ${isCompleted ? 'opacity-50' : ''}`}>
              <div className={`font-mono text-xs font-black ${textSecondary}`}>{String(c.index).padStart(3, '0')}</div>
              <div className="flex flex-col gap-1 min-w-0 mr-4">
                <div className="flex items-center gap-3">
                  {isEditing ? (
                    <div className="flex-1 flex items-center gap-2" onClick={e => e.stopPropagation()}>
                      <input autoFocus type="text" value={tempTitle} onChange={e => setTempTitle(e.target.value)} onBlur={() => { onUpdateChapterTitle(c.id, tempTitle); setEditingChapterId(null); }} className="px-2 py-1 rounded border text-sm font-bold w-full bg-inherit" />
                    </div>
                  ) : (
                    <div className="font-black text-sm truncate flex items-center">
                      {c.title}
                      {renderTextStatusIcon(c)}
                    </div>
                  )}
                  {renderAudioStatusIcon(c)}
                </div>
                <div className={`h-1 w-full rounded-full overflow-hidden ${isDark ? 'bg-slate-700' : 'bg-black/5'}`}>
                   <div className={`h-full transition-all duration-500 ${isCompleted ? 'bg-emerald-500' : 'bg-indigo-500'}`} style={{ width: `${percent}%` }} />
                </div>
              </div>
              <div className="text-right px-4">
                <span className={`text-[10px] font-black px-2 py-0.5 rounded-full ${isCompleted ? 'bg-emerald-500/20 text-emerald-600' : 'bg-indigo-500/15 text-indigo-500'}`}>{isCompleted ? 'Done' : `${percent}%`}</span>
              </div>
              <div className="flex justify-end items-center gap-2">
                {isCompleted && <button onClick={(e) => { e.stopPropagation(); handleRestart(c.id); }} className="p-2 bg-indigo-600/10 text-indigo-600 rounded-xl hover:bg-indigo-600/20"><RotateCcw className="w-4 h-4" /></button>}
                <button onClick={(e) => { e.stopPropagation(); setRememberAsDefault(false); setShowVoiceModal({ chapterId: c.id }); }} className="p-2 opacity-40 hover:opacity-100"><RefreshCw className="w-4 h-4" /></button>
                <button onClick={(e) => { e.stopPropagation(); setEditingChapterId(c.id); setTempTitle(c.title); }} className="p-2 opacity-40 hover:opacity-100"><Edit2 className="w-4 h-4" /></button>
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
      {chapters.map(c => {
        const saved = progressData[c.id];
        const percent = saved?.percent !== undefined ? Math.floor(saved.percent * 100) : 0;
        return (
          <div key={c.id} onClick={() => onOpenChapter(c.id)} className={`flex flex-col gap-2 p-4 rounded-2xl border cursor-pointer transition-all hover:translate-x-1 ${cardBg}`}>
            <div className="flex items-center gap-4">
              <div className={`w-8 h-8 rounded-lg flex items-center justify-center font-mono text-[10px] font-black ${isDark ? 'bg-slate-950 text-indigo-400' : 'bg-indigo-50 text-indigo-600'}`}>{c.index}</div>
              <div className="flex-1 min-w-0 font-black text-sm truncate flex items-center">
                {c.title}
                {renderTextStatusIcon(c)}
              </div>
              <div className="flex items-center gap-3">
                <span className="text-[9px] font-black opacity-40 uppercase">{percent}%</span>
                {renderAudioStatusIcon(c)}
              </div>
            </div>
            <div className={`h-0.5 w-full rounded-full overflow-hidden ${isDark ? 'bg-slate-700' : 'bg-black/5'}`}>
               <div className="h-full bg-indigo-500" style={{ width: `${percent}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );

  const renderGridView = () => (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
      {chapters.map(c => {
        const saved = progressData[c.id];
        const percent = saved?.percent !== undefined ? Math.floor(saved.percent * 100) : 0;
        return (
          <div key={c.id} onClick={() => onOpenChapter(c.id)} className={`aspect-square p-4 rounded-3xl border flex flex-col items-center justify-center text-center gap-2 cursor-pointer transition-all hover:scale-105 group relative ${cardBg}`}>
            <div className="absolute top-3 right-3 flex gap-1">
              {renderTextStatusIcon(c)}
              {renderAudioStatusIcon(c)}
            </div>
            <div className={`w-12 h-12 rounded-2xl flex items-center justify-center font-mono text-lg font-black mb-1 ${isDark ? 'bg-slate-950 text-indigo-400' : 'bg-indigo-50 text-indigo-600'}`}>{c.index}</div>
            <div className="font-black text-xs line-clamp-2 leading-tight px-1">{c.title}</div>
            <div className="mt-2 w-full px-4">
               <div className={`h-1 w-full rounded-full overflow-hidden ${isDark ? 'bg-slate-700' : 'bg-black/5'}`}>
                  <div className="h-full bg-indigo-500" style={{ width: `${percent}%` }} />
               </div>
               <div className="text-[8px] font-black uppercase opacity-40 mt-1">{percent}%</div>
            </div>
            <button onClick={(e) => { e.stopPropagation(); if (confirm('Delete?')) onDeleteChapter(c.id); }} className="absolute bottom-2 right-2 p-2 opacity-0 group-hover:opacity-100 text-red-500 transition-opacity"><Trash2 className="w-3.5 h-3.5" /></button>
          </div>
        );
      })}
    </div>
  );

  return (
    <div className={`h-full min-h-0 flex flex-col ${isDark ? 'bg-slate-900 text-slate-100' : isSepia ? 'bg-[#f4ecd8] text-[#3c2f25]' : 'bg-white text-black'}`}>
      {showVoiceModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className={`w-full max-w-md rounded-3xl shadow-2xl p-8 space-y-6 ${isDark ? 'bg-slate-900 border border-slate-800' : 'bg-white border border-black/5'}`}>
            <div className="flex justify-between items-center">
              <h3 className="text-xl font-black tracking-tight">Select Cloud Voice</h3>
              <button onClick={() => setShowVoiceModal(null)} className="p-2 opacity-60 hover:opacity-100"><X className="w-5 h-5" /></button>
            </div>
            <div className="space-y-4">
              <div className="flex items-center gap-3 p-3 bg-black/5 rounded-xl">
                <input type="checkbox" id="rememberDefault" checked={rememberAsDefault} onChange={e => setRememberAsDefault(e.target.checked)} className="w-4 h-4 accent-indigo-600" />
                <label htmlFor="rememberDefault" className="text-xs font-black uppercase tracking-tight opacity-70 cursor-pointer">Set as book default</label>
              </div>
              <div className="space-y-2 max-h-[40vh] overflow-y-auto pr-1">
                {CLOUD_VOICES.map(v => (
                  <button key={v.id} onClick={() => handleVoiceSelect(v.id)} className={`w-full p-4 rounded-xl border-2 text-left font-black text-sm transition-all flex justify-between items-center ${isDark ? 'border-slate-800 hover:border-indigo-600 bg-slate-950/40' : 'border-slate-100 hover:border-indigo-600 bg-slate-50'}`}>{v.name}<Headphones className="w-4 h-4 opacity-40" /></button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

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
              <button onClick={handleCheckDriveIntegrity} disabled={isCheckingDrive} className="px-6 py-3 bg-white text-indigo-600 border border-indigo-600/20 rounded-2xl font-black uppercase text-[10px] tracking-widest shadow-lg hover:bg-indigo-50 active:scale-95 transition-all flex items-center gap-2" title="Check cloud text/audio integrity">
                {isCheckingDrive ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />} 
                {isCheckingDrive ? 'Checking Drive...' : 'Check Drive'}
              </button>
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
