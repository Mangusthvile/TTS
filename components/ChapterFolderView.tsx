
import React, { useMemo, useState, useEffect } from 'react';
import { Book, Theme, StorageBackend, Chapter, AudioChunkMetadata, AudioStatus, CLOUD_VOICES } from '../types';
import { LayoutGrid, List, AlignJustify, Plus, Folder, CheckCircle2, Edit2, Check, RefreshCw, Trash2, Headphones, Loader2, Cloud, AlertTriangle, X, RotateCcw, ChevronLeft, Image as ImageIcon, Wand2, FileText, AlertCircle } from 'lucide-react';
import { PROGRESS_STORE_V4, applyRules } from '../services/speechService';
import { synthesizeChunk } from '../services/cloudTtsService';
import { saveAudioToCache, generateAudioKey, getAudioFromCache } from '../services/audioCache';
import { uploadToDrive, listFilesInFolder, buildMp3Name, checkFileExists } from '../services/driveService';

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
  onBulkAudioEnsure?: () => void;
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
  const [synthesizingId, setSynthesizingId] = useState<string | null>(null);
  const [isBatchSynthesizing, setIsBatchSynthesizing] = useState(false);
  const [batchProgress, setBatchProgress] = useState({ current: 0, total: 0 });
  const [showVoiceModal, setShowVoiceModal] = useState<{ chapterId?: string; isBulk?: boolean } | null>(null);
  const [rememberAsDefault, setRememberAsDefault] = useState(true);

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

      if (!audioBlob) {
        throw new Error("No audio blob available for storage.");
      }

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
      console.error(e);
      onUpdateChapter({ ...chapter, audioStatus: AudioStatus.FAILED });
    } finally {
      setSynthesizingId(null);
    }
  };

  const handleRunBulkSync = async (voiceId: string) => {
    if (!book.driveFolderId) return;
    setIsBatchSynthesizing(true);
    setShowVoiceModal(null);
    if (onUpdateBookSettings && rememberAsDefault) {
      onUpdateBookSettings({ ...book.settings, defaultVoiceId: voiceId });
    }

    try {
      const driveFiles = await listFilesInFolder(book.driveFolderId);
      const mp3Map = new Map(driveFiles.filter(f => f.name.endsWith('.mp3')).map(f => [f.name, f.id]));

      const processingQueue = chapters.filter(c => {
        const expectedName = buildMp3Name(c.index, c.title);
        const driveId = mp3Map.get(expectedName);
        if (driveId && !c.cloudAudioFileId) {
          onUpdateChapter({ ...c, cloudAudioFileId: driveId, audioStatus: AudioStatus.READY });
          return false;
        }
        return !driveId;
      });

      setBatchProgress({ current: 0, total: processingQueue.length });
      for (let i = 0; i < processingQueue.length; i++) {
        setBatchProgress({ current: i + 1, total: processingQueue.length });
        await generateAudio(processingQueue[i], voiceId);
      }
    } finally {
      setIsBatchSynthesizing(false);
    }
  };

  const handleVoiceSelect = (voiceId: string) => {
    const isBulk = showVoiceModal?.isBulk;
    const chId = showVoiceModal?.chapterId;
    
    // 1. Persist book default if requested
    if (onUpdateBookSettings && rememberAsDefault) {
      onUpdateBookSettings({ ...book.settings, defaultVoiceId: voiceId });
    }

    // 2. CLOSE MODAL IMMEDIATELY
    setShowVoiceModal(null);

    // 3. START WORK IN BACKGROUND
    if (isBulk) {
      handleRunBulkSync(voiceId);
    } else if (chId) {
      const chapter = chapters.find(c => c.id === chId);
      if (chapter) generateAudio(chapter, voiceId);
    }
  };

  const renderAudioStatusIcon = (c: Chapter) => {
    if (c.cloudAudioFileId || c.audioDriveId || c.audioStatus === AudioStatus.READY) {
      return (
        <span title="Audio ready on Google Drive" className="inline-flex items-center">
          <Cloud className="w-4 h-4 text-emerald-500" aria-label="Audio ready" role="img" />
        </span>
      );
    }
    if (synthesizingId === c.id || c.audioStatus === AudioStatus.GENERATING) {
      return (
        <span title="Generating and Uploading..." className="inline-flex items-center">
          <Loader2 className="w-4 h-4 text-indigo-400 animate-spin" aria-label="Generating..." role="img" />
        </span>
      );
    }
    return (
      <span title="Audio missing — generate/sync needed" className="inline-flex items-center">
        <AlertTriangle className="w-4 h-4 text-amber-500" aria-label="Audio missing" role="img" />
      </span>
    );
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
                    <div className="font-black text-sm truncate">{c.title}</div>
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
              <div className="flex-1 min-w-0 font-black text-sm truncate">{c.title}</div>
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
            <div className="absolute top-3 right-3">{renderAudioStatusIcon(c)}</div>
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
              <button onClick={() => { if (book.settings.defaultVoiceId) handleRunBulkSync(book.settings.defaultVoiceId); else setShowVoiceModal({ isBulk: true }); }} disabled={isBatchSynthesizing} className="px-6 py-3 bg-white text-indigo-600 border border-indigo-600/20 rounded-2xl font-black uppercase text-[10px] tracking-widest shadow-lg hover:bg-indigo-50 active:scale-95 transition-all flex items-center gap-2" title="Make sure all chapters have audio files on Drive">
                {isBatchSynthesizing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />} 
                {isBatchSynthesizing ? `Syncing ${batchProgress.current}/${batchProgress.total}` : 'Ensure Audio'}
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
