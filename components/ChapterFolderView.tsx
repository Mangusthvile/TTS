import React, { useMemo, useState, useEffect } from 'react';
import { Book, Theme, StorageBackend, Chapter, AudioChunkMetadata } from '../types';
import { LayoutGrid, List, AlignJustify, Plus, Folder, CheckCircle2, Edit2, Check, RefreshCw, Trash2, Headphones, Loader2, Cloud, AlertTriangle, X, RotateCcw } from 'lucide-react';
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
  onRefreshDriveFolder?: () => void;
  onUpdateChapter?: (chapter: Chapter) => void;
  onUpdateBookSettings?: (settings: any) => void;
  driveToken?: string;
}

const ChapterFolderView: React.FC<ChapterFolderViewProps> = ({
  book, theme, onAddChapter, onOpenChapter, onToggleFavorite, onUpdateChapterTitle, onDeleteChapter, onRefreshDriveFolder, onUpdateChapter, onUpdateBookSettings, driveToken
}) => {
  // Persistence per-book
  const VIEW_MODE_KEY = `talevox:viewMode:${book.id}`;
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    const saved = localStorage.getItem(VIEW_MODE_KEY);
    return (saved === 'details' || saved === 'list' || saved === 'grid') ? (saved as ViewMode) : 'details';
  });

  useEffect(() => {
    localStorage.setItem(VIEW_MODE_KEY, viewMode);
  }, [viewMode, VIEW_MODE_KEY]);

  const [editingChapterId, setEditingChapterId] = useState<string | null>(null);
  const [synthesizingId, setSynthesizingId] = useState<string | null>(null);
  const [isBatchSynthesizing, setIsBatchSynthesizing] = useState(false);
  const [batchProgress, setBatchProgress] = useState({ current: 0, total: 0 });
  const [tempTitle, setTempTitle] = useState('');
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

  const currentSignature = useMemo(() => {
    const voice = book.settings.defaultVoiceId || 'default';
    const rulesHash = book.rules.length + "_" + book.rules.filter(r => r.enabled).length;
    return `${voice}_${rulesHash}_v4`; 
  }, [book.settings.defaultVoiceId, book.rules]);

  const getChapterStaleStatus = (c: Chapter) => {
    if (!c.audioDriveId) return 'none';
    const baseStale = c.audioSignature !== currentSignature;
    const introStr = `Chapter ${c.index}. ${c.title}. `;
    const introStale = c.audioPrefixLen !== introStr.length;
    return (baseStale || introStale) ? 'stale' : 'ready';
  };

  const getHighPrecisionDuration = async (blob: Blob): Promise<number> => {
    try {
      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      const arrayBuffer = await blob.arrayBuffer();
      const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
      const duration = audioBuffer.duration;
      await audioCtx.close();
      return duration;
    } catch (e) {
      return 0;
    }
  };

  const migrateChapterAudioToDrive = async (chapter: Chapter, voiceToUse?: string) => {
    const voice = voiceToUse || book.settings.defaultVoiceId || 'en-US-Standard-C';
    const speed = 1.0; 
    
    // Apply rules to content for synthesis
    const rawIntro = `Chapter ${chapter.index}. ${chapter.title}. `;
    const introText = applyRules(rawIntro, book.rules);
    const contentText = applyRules(chapter.content, book.rules);
    const prefixLen = introText.length;

    const allBlobs: Blob[] = [];
    
    const introCacheKey = generateAudioKey(introText, voice, speed);
    let introBlobOrNull = await getAudioFromCache(introCacheKey);
    if (!introBlobOrNull) {
      const res = await synthesizeChunk(introText, voice, speed);
      introBlobOrNull = await fetch(res.audioUrl).then(r => r.blob());
      if (introBlobOrNull) await saveAudioToCache(introCacheKey, introBlobOrNull);
    }
    if (!introBlobOrNull) throw new Error("INTRO_GEN_FAIL");
    
    const introBlob: Blob = introBlobOrNull;
    const introDurSec = await getHighPrecisionDuration(introBlob);
    allBlobs.push(introBlob);

    // Using single chunk for simplicity, but maintaining chunkMap for high-precision highlight support
    const textChunks = [contentText];
    const chunkMap: AudioChunkMetadata[] = [];
    
    let currentPosInContent = 0;
    for (const chunkText of textChunks) {
      const cacheKey = generateAudioKey(chunkText, voice, speed);
      let blobOrNull = await getAudioFromCache(cacheKey);
      
      if (!blobOrNull) {
        const res = await synthesizeChunk(chunkText, voice, speed);
        blobOrNull = await fetch(res.audioUrl).then(r => r.blob());
        if (blobOrNull) await saveAudioToCache(cacheKey, blobOrNull);
      }

      if (blobOrNull) {
        const audioBlob: Blob = blobOrNull;
        const dur = await getHighPrecisionDuration(audioBlob);
        allBlobs.push(audioBlob);
        chunkMap.push({ startChar: currentPosInContent, endChar: currentPosInContent + chunkText.length, durSec: dur });
        currentPosInContent += chunkText.length;
      }
    }

    if (book.backend === StorageBackend.DRIVE && driveToken && allBlobs.length > 0) {
      const combinedBlob = new Blob(allBlobs, { type: 'audio/mpeg' });
      const filename = buildMp3Name(chapter.index, chapter.title);
      console.log(`[AudioGen] Uploading ${filename} to Drive folder ${book.driveFolderId}`);
      const audioDriveId = await uploadToDrive(driveToken, book.driveFolderId!, filename, combinedBlob, chapter.audioDriveId, 'audio/mpeg');
      return { audioDriveId, prefixLen, introDurSec, chunkMap };
    }
    return undefined;
  };

  const handleRunGeneration = async (voiceId: string, chapterId?: string) => {
    if (!driveToken || !book.driveFolderId) {
       alert("Drive folder not linked. Please link a folder first in book settings.");
       return;
    }

    if (onUpdateBookSettings && (rememberAsDefault || !book.settings.defaultVoiceId)) {
      onUpdateBookSettings({ ...book.settings, defaultVoiceId: voiceId });
    }
    setShowVoiceModal(null);

    if (chapterId) {
      const chapter = chapters.find(c => c.id === chapterId);
      if (!chapter) return;
      setSynthesizingId(chapterId);
      try {
        const res = await migrateChapterAudioToDrive(chapter, voiceId);
        if (onUpdateChapter && res) {
          onUpdateChapter({ 
            ...chapter, audioDriveId: res.audioDriveId, audioPrefixLen: res.prefixLen, 
            audioIntroDurSec: res.introDurSec, audioChunkMap: res.chunkMap, audioSignature: currentSignature 
          });
        }
      } catch (err) { alert("Generation failed: " + err); } finally { setSynthesizingId(null); }
    } else {
      setIsBatchSynthesizing(true);
      try {
        // 1) List files in folder to find existing audio
        console.log(`[SyncBulk] Listing files in folder: ${book.driveFolderId}`);
        const driveFiles = await listFilesInFolder(driveToken, book.driveFolderId);
        
        // 2) Build MP3 Map (name -> id)
        const mp3Map = new Map<string, string>();
        for (const f of driveFiles) {
          if (f.name?.toLowerCase().endsWith(".mp3") || f.mimeType?.startsWith("audio/")) {
            mp3Map.set(f.name, f.id);
          }
        }

        // 3) Process chapters missing audio OR having existing audio on Drive but not in state
        const processingQueue: Chapter[] = [];
        for (const ch of chapters) {
          const expectedName = buildMp3Name(ch.index, ch.title);
          const driveId = mp3Map.get(expectedName);
          
          if (driveId && !ch.audioDriveId) {
            // Already on Drive but not in local state - just update state (fast sync)
            console.log(`[SyncBulk] Found existing file for Chapter ${ch.index}: ${expectedName}`);
            if (onUpdateChapter) {
              onUpdateChapter({ ...ch, audioDriveId: driveId, audioSignature: currentSignature });
            }
          } else if (!driveId) {
            // Truly missing
            processingQueue.push(ch);
          }
        }

        setBatchProgress({ current: 0, total: processingQueue.length });
        
        // 4) Sequential generation
        for (let i = 0; i < processingQueue.length; i++) {
          const chapter = processingQueue[i];
          setBatchProgress({ current: i + 1, total: processingQueue.length });
          setSynthesizingId(chapter.id);
          try {
            const res = await migrateChapterAudioToDrive(chapter, voiceId);
            if (onUpdateChapter && res) {
              onUpdateChapter({ 
                ...chapter, audioDriveId: res.audioDriveId, audioPrefixLen: res.prefixLen, 
                audioIntroDurSec: res.introDurSec, audioChunkMap: res.chunkMap, audioSignature: currentSignature 
              });
            }
          } catch (e) { 
            console.error(`[SyncBulk] Failed chapter ${chapter.index}:`, e); 
          } finally {
            setSynthesizingId(null);
          }
        }
      } catch (err) {
        console.error("[SyncBulk] Critical failure:", err);
        alert("Batch synchronization failed. Check console for details.");
      } finally {
        setIsBatchSynthesizing(false);
      }
    }
  };

  const handleRestart = (chapterId: string) => {
    const storeRaw = localStorage.getItem(PROGRESS_STORE_V4);
    const store = storeRaw ? JSON.parse(storeRaw) : {};
    if (!store[book.id]) return;
    
    if (store[book.id][chapterId]) {
      store[book.id][chapterId] = {
        ...store[book.id][chapterId],
        timeSec: 0,
        percent: 0,
        completed: false,
        updatedAt: Date.now()
      };
      localStorage.setItem(PROGRESS_STORE_V4, JSON.stringify(store));
      window.dispatchEvent(new CustomEvent('talevox_progress_updated', { 
        detail: { bookId: book.id, chapterId: chapterId } 
      }));
    }
  };

  const handleSaveEdit = () => { 
    if (editingChapterId && tempTitle.trim()) onUpdateChapterTitle(editingChapterId, tempTitle.trim()); 
    setEditingChapterId(null); 
  };

  const renderStatusIcon = (c: Chapter) => {
    const status = getChapterStaleStatus(c);
    if (status === 'ready') return <span title="Audio ready on Drive"><Cloud className="w-3.5 h-3.5 text-emerald-500" /></span>;
    if (status === 'stale') return <span title="Audio out of sync (re-generate)"><AlertTriangle className="w-3.5 h-3.5 text-amber-500" /></span>;
    if (synthesizingId === c.id) return <Loader2 className="w-3.5 h-3.5 animate-spin text-indigo-500" />;
    return <span title="No audio generated"><AlertTriangle className="w-3.5 h-3.5 text-slate-400 opacity-50" /></span>;
  };

  const renderRow = (c: Chapter) => {
    const isEditing = editingChapterId === c.id;
    const saved = progressData[c.id];
    const isActuallyCompleted = saved?.completed || false;
    const displayPercent = saved?.percent !== undefined ? Math.floor(saved.percent * 100) : 0;

    return (
      <div key={c.id} onClick={() => !isEditing && onOpenChapter(c.id)} className={`grid grid-cols-[40px_1fr_60px] sm:grid-cols-[60px_1fr_100px_100px_180px] items-center px-4 sm:px-6 py-4 cursor-pointer border-b last:border-0 transition-colors ${isDark ? 'hover:bg-white/5 border-slate-800' : 'hover:bg-black/5 border-black/5'} ${isActuallyCompleted ? 'opacity-60' : ''}`}>
        <div className={`font-mono text-[10px] sm:text-xs font-black flex items-center gap-2 ${textSecondary}`}>{isActuallyCompleted ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" /> : String(c.index).padStart(3, '0')}</div>
        <div className="flex items-center gap-4 min-w-0 mr-2">
          {isEditing ? (
            <div className="flex-1 flex items-center gap-2" onClick={e => e.stopPropagation()}>
              <input autoFocus type="text" value={tempTitle} onChange={e => setTempTitle(e.target.value)} onKeyDown={e => e.key === 'Enter' ? handleSaveEdit() : e.key === 'Escape' && setEditingChapterId(null)} className={`flex-1 px-3 py-1.5 rounded-lg border-2 font-black text-sm outline-none ${isDark ? 'bg-slate-900 border-indigo-600 text-white' : 'bg-white border-indigo-600 text-black'}`} />
              <button onClick={handleSaveEdit} className="p-1.5 bg-emerald-600 text-white rounded-lg"><Check className="w-4 h-4" /></button>
            </div>
          ) : (
            <div className="flex items-center gap-3 min-w-0">
              <div className={`truncate font-black text-xs sm:text-sm ${isActuallyCompleted ? 'line-through decoration-indigo-500/40' : ''}`}>{c.title}</div>
              {renderStatusIcon(c)}
            </div>
          )}
        </div>
        <div className={`text-[10px] sm:text-xs font-black text-right hidden sm:block ${textSecondary}`}>{c.wordCount?.toLocaleString()} words</div>
        <div className="text-right px-4">
          <div className="flex flex-col items-end gap-1">
            <span className={`text-[9px] sm:text-[10px] font-black px-2 py-0.5 rounded-full ${isActuallyCompleted ? 'bg-emerald-500/20 text-emerald-600' : 'bg-indigo-500/15 text-indigo-500'}`}>
              {isActuallyCompleted ? 'Done' : `${displayPercent}%`}
            </span>
            {isActuallyCompleted && (
              <button 
                type="button"
                onClick={(e) => { e.stopPropagation(); handleRestart(c.id); }} 
                className={`flex items-center gap-1 text-[8px] font-black uppercase transition-all hover:opacity-100 ${isDark ? 'text-indigo-400 opacity-60' : 'text-indigo-600 opacity-70'}`}
              >
                <RotateCcw className="w-2.5 h-2.5" /> Restart
              </button>
            )}
          </div>
        </div>
        <div className="flex justify-end items-center gap-2 hidden sm:flex">
          <button onClick={(e) => { e.stopPropagation(); setRememberAsDefault(false); setShowVoiceModal({ chapterId: c.id }); }} disabled={!!synthesizingId || isBatchSynthesizing} className={`p-2 rounded-xl border transition-all ${controlBg} opacity-40 hover:opacity-100 relative z-20 cursor-pointer`} title="Regenerate Sync Audio"><RefreshCw className="w-4 h-4" /></button>
          {!isEditing && <button onClick={(e) => { e.stopPropagation(); setEditingChapterId(c.id); setTempTitle(c.title); }} className={`p-2 rounded-xl border transition-all ${controlBg} opacity-40 hover:opacity-100 relative z-20 cursor-pointer`}><Edit2 className="w-4 h-4" /></button>}
          <button onClick={(e) => { e.stopPropagation(); if (confirm('Delete chapter?')) onDeleteChapter(c.id); }} className={`p-2 rounded-xl border transition-all ${controlBg} opacity-40 hover:opacity-100 hover:text-red-600 relative z-20 cursor-pointer`}><Trash2 className="w-4 h-4" /></button>
        </div>
      </div>
    );
  };

  const renderListItem = (c: Chapter) => {
    const saved = progressData[c.id];
    const isActuallyCompleted = saved?.completed || false;
    const displayPercent = saved?.percent !== undefined ? Math.floor(saved.percent * 100) : 0;
    return (
      <div key={c.id} onClick={() => onOpenChapter(c.id)} className={`flex items-center px-4 py-2 cursor-pointer border-b last:border-0 transition-colors ${isDark ? 'hover:bg-white/5 border-slate-800' : 'hover:bg-black/5 border-black/5'} ${isActuallyCompleted ? 'opacity-50' : ''}`}>
        <div className={`w-8 font-mono text-[10px] font-black ${textSecondary}`}>{isActuallyCompleted ? <CheckCircle2 className="w-3 h-3 text-emerald-500" /> : c.index}</div>
        <div className="flex-1 truncate font-bold text-xs mr-4">{c.title}</div>
        <div className="flex items-center gap-3">
          {renderStatusIcon(c)}
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-black text-indigo-500 w-8 text-right">{displayPercent}%</span>
            {isActuallyCompleted && (
              <button 
                type="button"
                onClick={(e) => { e.stopPropagation(); handleRestart(c.id); }} 
                className={`p-1 rounded bg-indigo-600/10 text-indigo-600 hover:bg-indigo-600/20 transition-all`}
                title="Restart Chapter"
              >
                <RotateCcw className="w-3 h-3" />
              </button>
            )}
          </div>
          <button onClick={(e) => { e.stopPropagation(); if (confirm('Delete chapter?')) onDeleteChapter(c.id); }} className="p-1 opacity-0 group-hover:opacity-100 hover:text-red-500 relative z-20 cursor-pointer"><Trash2 className="w-3 h-3" /></button>
        </div>
      </div>
    );
  };

  const renderGridItem = (c: Chapter) => {
    const saved = progressData[c.id];
    const isActuallyCompleted = saved?.completed || false;
    const displayPercent = saved?.percent !== undefined ? Math.floor(saved.percent * 100) : 0;
    return (
      <div key={c.id} onClick={() => onOpenChapter(c.id)} className={`p-4 rounded-2xl border transition-all cursor-pointer flex flex-col justify-between h-36 relative group ${cardBg} ${isActuallyCompleted ? 'opacity-60' : ''} hover:shadow-lg`}>
        <div className="flex justify-between items-start">
          <div className={`text-[10px] font-black uppercase tracking-tighter ${textSecondary}`}>CH {c.index}</div>
          {renderStatusIcon(c)}
        </div>
        <div className="mt-2 flex-1">
          <div className="font-black text-sm line-clamp-2 leading-tight">{c.title}</div>
        </div>
        <div className="mt-2 space-y-2">
          <div className="flex items-center justify-between">
            <div className="h-1.5 flex-1 bg-black/5 rounded-full overflow-hidden mr-3">
              <div className="h-full bg-indigo-600 transition-all" style={{ width: `${displayPercent}%` }} />
            </div>
            <div className="text-[10px] font-black text-indigo-600">{displayPercent}%</div>
          </div>
          {isActuallyCompleted && (
            <button 
              type="button"
              onClick={(e) => { e.stopPropagation(); handleRestart(c.id); }} 
              className={`w-full py-1.5 rounded-lg border-2 border-dashed flex items-center justify-center gap-2 text-[9px] font-black uppercase tracking-widest transition-all ${isDark ? 'border-slate-700 text-indigo-400 hover:border-indigo-600' : 'border-indigo-100 text-indigo-600 hover:border-indigo-600 hover:bg-indigo-50'}`}
            >
              <RotateCcw className="w-3 h-3" /> Restart Chapter
            </button>
          )}
        </div>
        <button onClick={(e) => { e.stopPropagation(); if (confirm('Delete chapter?')) onDeleteChapter(c.id); }} className="absolute -top-2 -right-2 p-1.5 bg-red-500 text-white rounded-full shadow-lg opacity-0 group-hover:opacity-100 transition-all scale-75 hover:scale-100 relative z-30 cursor-pointer"><Trash2 className="w-3.5 h-3.5" /></button>
      </div>
    );
  };

  return (
    <div className={`h-full min-h-0 flex flex-col relative z-0 ${isDark ? 'bg-slate-900 text-slate-100' : isSepia ? 'bg-[#f4ecd8] text-[#3c2f25]' : 'bg-white text-black'}`}>
      {showVoiceModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className={`w-full max-w-md rounded-3xl shadow-2xl p-8 space-y-6 ${isDark ? 'bg-slate-900 border border-slate-800' : 'bg-white border border-black/5'}`}>
            <div className="flex justify-between items-center">
              <h3 className="text-xl font-black tracking-tight">Select Cloud Voice</h3>
              <button onClick={() => setShowVoiceModal(null)} className="p-2 opacity-60 hover:opacity-100"><X className="w-5 h-5" /></button>
            </div>
            <div className="space-y-4">
              <p className="text-sm font-bold opacity-60">High-precision sync will be generated for every chunk of this chapter.</p>
              <div className="flex items-center gap-3 p-3 bg-black/5 rounded-xl">
                <input type="checkbox" id="rememberDefault" checked={rememberAsDefault} onChange={e => setRememberAsDefault(e.target.checked)} className="w-4 h-4 accent-indigo-600" />
                <label htmlFor="rememberDefault" className="text-xs font-black uppercase tracking-tight opacity-70 cursor-pointer">Set as book default</label>
              </div>
              <div className="space-y-2 max-h-[40vh] overflow-y-auto pr-1">
                {CLOUD_VOICES.map(v => (
                  <button key={v.id} onClick={() => handleRunGeneration(v.id, showVoiceModal.chapterId)} className={`w-full p-4 rounded-xl border-2 text-left font-black text-sm transition-all flex justify-between items-center ${isDark ? 'border-slate-800 hover:border-indigo-600 bg-slate-950/40' : 'border-slate-100 hover:border-indigo-600 bg-slate-50'}`}>{v.name}<Headphones className="w-4 h-4 opacity-40" /></button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
      <div className="px-4 sm:px-8 pt-6 sm:pt-8 flex-shrink-0 relative z-10">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
          <div className="flex items-center gap-4 min-w-0">
            <div className={`p-3.5 sm:p-4 rounded-[1.2rem] border shadow-sm ${cardBg}`}><Folder className="w-5 h-5 sm:w-6 sm:h-6 text-indigo-600" /></div>
            <div className="min-w-0">
              <div className={`text-[9px] sm:text-[11px] font-black uppercase tracking-widest ${isDark ? 'text-indigo-400' : 'text-indigo-600'}`}>Library Collection</div>
              <div className="text-xl sm:text-2xl font-black tracking-tight truncate mt-1">{book.title}</div>
            </div>
          </div>
          <div className="flex items-center flex-wrap gap-2 sm:gap-3 relative z-20">
             <button type="button" onClick={() => { setRememberAsDefault(true); setShowVoiceModal({ isBulk: true }); }} disabled={isBatchSynthesizing} className={`px-5 py-2.5 rounded-xl text-[10px] sm:text-[11px] font-black flex items-center gap-2 border transition-all ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-black/10 shadow-sm'} hover:scale-105 active:scale-95 cursor-pointer`}>{isBatchSynthesizing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Headphones className="w-3.5 h-3.5" />}{isBatchSynthesizing ? `Syncing ${batchProgress.current}/${batchProgress.total}...` : 'Sync Missing Audio'}</button>
             <button type="button" onClick={onAddChapter} className="px-5 py-2.5 rounded-xl text-[10px] sm:text-[11px] font-black flex items-center gap-2 bg-indigo-600 text-white shadow-lg hover:scale-105 transition-all active:scale-95 cursor-pointer"><Plus className="w-3.5 h-3.5" />Import Chapter</button>
             <div className={`flex items-center gap-1 p-1 rounded-xl border shadow-sm ${controlBg} relative z-30`}>
              <button 
                type="button" 
                onClick={(e) => { e.stopPropagation(); setViewMode('details'); }} 
                aria-pressed={viewMode === 'details'}
                aria-label="Table View" 
                className={`p-2.5 rounded-lg transition-all cursor-pointer ${viewMode === 'details' ? 'bg-indigo-600 text-white shadow-md' : 'opacity-60 hover:bg-black/5'}`}
              >
                <AlignJustify className="w-4 h-4" />
              </button>
              <button 
                type="button" 
                onClick={(e) => { e.stopPropagation(); setViewMode('list'); }} 
                aria-pressed={viewMode === 'list'}
                aria-label="Compact View" 
                className={`p-2.5 rounded-lg transition-all cursor-pointer ${viewMode === 'list' ? 'bg-indigo-600 text-white shadow-md' : 'opacity-60 hover:bg-black/5'}`}
              >
                <List className="w-4 h-4" />
              </button>
              <button 
                type="button" 
                onClick={(e) => { e.stopPropagation(); setViewMode('grid'); }} 
                aria-pressed={viewMode === 'grid'}
                aria-label="Grid View" 
                className={`p-2.5 rounded-lg transition-all cursor-pointer ${viewMode === 'grid' ? 'bg-indigo-600 text-white shadow-md' : 'opacity-60 hover:bg-black/5'}`}
              >
                <LayoutGrid className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto px-4 sm:px-8 pb-12 pt-6 sm:pt-8">
        <div className={viewMode === 'grid' ? "" : `rounded-[1.5rem] border shadow-sm overflow-hidden ${cardBg}`}>
          {chapters.length === 0 ? <div className="p-12 text-center text-lg font-black opacity-30">Empty Collection</div> : (
            <div className={viewMode === 'grid' ? "grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4" : ""}>
              {viewMode === 'details' && (
                <div className={`grid grid-cols-[40px_1fr_60px] sm:grid-cols-[60px_1fr_100px_100px_180px] px-4 sm:px-6 py-4 text-[9px] sm:text-[11px] font-black uppercase tracking-widest border-b ${isDark ? 'border-slate-800 bg-slate-950/40 text-indigo-400' : 'border-black/5 bg-black/5 text-indigo-600'}`}>
                  <div>Idx</div><div>Title</div><div className="text-right hidden sm:block">Words</div><div className="text-right px-4">Prog.</div><div className="text-right hidden sm:block">Actions</div>
                </div>
              )}
              {viewMode === 'list' && (
                <div className={`flex px-4 py-2 text-[9px] font-black uppercase tracking-widest border-b ${isDark ? 'border-slate-800 bg-slate-950/40 text-indigo-400' : 'border-black/5 bg-black/5 text-indigo-600'}`}>
                  <div className="w-8">#</div><div className="flex-1">Chapter Name</div><div className="w-32 text-right">Progress</div>
                </div>
              )}
              <div className={viewMode === 'grid' ? "contents" : `divide-y ${isDark ? 'divide-slate-800' : 'divide-black/5'}`}>
                {chapters.map(c => {
                  if (viewMode === 'grid') return renderGridItem(c);
                  if (viewMode === 'list') return renderListItem(c);
                  return renderRow(c);
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default ChapterFolderView;