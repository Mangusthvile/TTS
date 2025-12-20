import React, { useMemo, useState, useEffect } from 'react';
import { Book, Theme, StorageBackend, Chapter } from '../types';
import { LayoutGrid, List, AlignJustify, Plus, Star, Folder, CheckCircle2, Download, Edit2, Check, RefreshCw, Trash2, Headphones, Loader2, Zap, Cloud, ExternalLink, AlertTriangle, X } from 'lucide-react';
import { synthesizeChunk, sanitizeVoiceForCloud } from '../services/cloudTtsService';
import { saveAudioToCache, generateAudioKey, getAudioFromCache } from '../services/audioCache';
import { uploadToDrive } from '../services/driveService';

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
  book,
  theme,
  onAddChapter,
  onOpenChapter,
  onToggleFavorite,
  onUpdateChapterTitle,
  onDeleteChapter,
  onRefreshDriveFolder,
  onUpdateChapter,
  onUpdateBookSettings,
  driveToken
}) => {
  const [viewMode, setViewMode] = useState<ViewMode>('details');
  const [editingChapterId, setEditingChapterId] = useState<string | null>(null);
  const [synthesizingId, setSynthesizingId] = useState<string | null>(null);
  const [isBatchSynthesizing, setIsBatchSynthesizing] = useState(false);
  const [batchProgress, setBatchProgress] = useState({ current: 0, total: 0 });
  const [tempTitle, setTempTitle] = useState('');
  const [showVoiceModal, setShowVoiceModal] = useState<{ chapterId?: string } | null>(null);

  const isDark = theme === Theme.DARK;
  const isSepia = theme === Theme.SEPIA;

  const cardBg = isDark ? 'bg-slate-800 border-slate-700' : isSepia ? 'bg-[#efe6d5] border-[#d8ccb6]' : 'bg-white border-black/10';
  const controlBg = isDark ? 'bg-slate-950/40 border-slate-800' : isSepia ? 'bg-[#efe6d5] border-[#d8ccb6]' : 'bg-white border-black/5';
  const textPrimary = isDark ? 'text-slate-100' : isSepia ? 'text-[#3c2f25]' : 'text-black';
  const textSecondary = isDark ? 'text-slate-400' : isSepia ? 'text-[#3c2f25]/70' : 'text-slate-600';

  const chapters = useMemo(() => {
    return [...(book.chapters || [])].sort((a, b) => a.index - b.index);
  }, [book.chapters]);

  const currentSignature = useMemo(() => {
    const voice = book.settings.defaultVoiceId || 'default';
    const rulesHash = book.rules.length + "_" + book.rules.filter(r => r.enabled).length;
    return `${voice}_${rulesHash}`;
  }, [book.settings.defaultVoiceId, book.rules]);

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

  const migrateChapterAudioToDrive = async (chapter: Chapter, voiceToUse?: string) => {
    const voice = voiceToUse || book.settings.defaultVoiceId || 'en-US-Standard-C';
    const speed = 1.0; 
    
    const MAX = 4800;
    const textChunks = [];
    const content = chapter.content;
    for (let i = 0; i < content.length; i += MAX) {
      textChunks.push(content.substring(i, i + MAX));
    }

    const audioBlobs: Blob[] = [];

    for (const chunkText of textChunks) {
      const cacheKey = generateAudioKey(chunkText, voice, speed);
      const existing = await getAudioFromCache(cacheKey);
      if (existing) {
        audioBlobs.push(existing);
      } else {
        const res = await synthesizeChunk(chunkText, voice, speed);
        const blob = await fetch(res.audioUrl).then(r => r.blob());
        await saveAudioToCache(cacheKey, blob);
        audioBlobs.push(blob);
      }
    }

    if (book.backend === StorageBackend.DRIVE && driveToken && audioBlobs.length > 0) {
      const combinedBlob = new Blob(audioBlobs, { type: 'audio/mpeg' });
      const audioFilename = `${chapter.index.toString().padStart(3, '0')}.mp3`;
      
      try {
        const audioDriveId = await uploadToDrive(
          driveToken, 
          book.driveFolderId!, 
          audioFilename, 
          combinedBlob, 
          chapter.audioDriveId,
          'audio/mpeg'
        );
        return audioDriveId;
      } catch (err) {
        console.warn("Drive sync failed:", err);
      }
    }
    return undefined;
  };

  const handleRunGeneration = async (voiceId: string, chapterId?: string) => {
    if (onUpdateBookSettings && !book.settings.defaultVoiceId) {
      onUpdateBookSettings({ ...book.settings, defaultVoiceId: voiceId });
    }

    setShowVoiceModal(null);

    if (chapterId) {
      const chapter = chapters.find(c => c.id === chapterId);
      if (!chapter) return;
      setSynthesizingId(chapterId);
      try {
        const audioDriveId = await migrateChapterAudioToDrive(chapter, voiceId);
        if (onUpdateChapter) {
          onUpdateChapter({ ...chapter, audioDriveId, audioSignature: currentSignature });
        }
      } catch (err) {
        alert("Audio generation failed: " + err);
      } finally {
        setSynthesizingId(null);
      }
    } else {
      // Bulk process
      const missing = chapters.filter(c => !c.audioDriveId);
      if (missing.length === 0) return;

      setIsBatchSynthesizing(true);
      setBatchProgress({ current: 0, total: missing.length });

      for (let i = 0; i < missing.length; i++) {
        setBatchProgress({ current: i + 1, total: missing.length });
        const chapter = missing[i];
        try {
          const audioDriveId = await migrateChapterAudioToDrive(chapter, voiceId);
          if (onUpdateChapter) {
            onUpdateChapter({ ...chapter, audioDriveId, audioSignature: currentSignature });
          }
        } catch (e) {
          console.error("Batch fail for ch", chapter.index, e);
        }
      }
      setIsBatchSynthesizing(false);
    }
  };

  const handleSynthesizeClick = (e: React.MouseEvent, chapter: Chapter) => {
    e.stopPropagation();
    if (book.settings.defaultVoiceId) {
      handleRunGeneration(book.settings.defaultVoiceId, chapter.id);
    } else {
      setShowVoiceModal({ chapterId: chapter.id });
    }
  };

  const handleBulkClick = () => {
    if (book.settings.defaultVoiceId) {
      handleRunGeneration(book.settings.defaultVoiceId);
    } else {
      setShowVoiceModal({});
    }
  };

  const renderRow = (c: Chapter) => {
    const isEditing = editingChapterId === c.id;
    const isSynthesizing = synthesizingId === c.id;
    const isStale = c.audioDriveId && c.audioSignature !== currentSignature;
    
    return (
      <div
        key={c.id}
        onClick={() => !isEditing && onOpenChapter(c.id)}
        className={`grid grid-cols-[40px_1fr_60px] sm:grid-cols-[60px_1fr_100px_100px_180px] items-center px-4 sm:px-6 py-4 cursor-pointer select-none border-b last:border-0 transition-colors ${isDark ? 'hover:bg-white/5 border-slate-800' : 'hover:bg-black/5 border-black/5'} ${c.isCompleted ? 'opacity-60' : ''}`}
      >
        <div className={`font-mono text-[10px] sm:text-xs font-black flex items-center gap-2 ${textSecondary}`}>
          {c.isCompleted ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" /> : String(c.index).padStart(3, '0')}
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
                  if (e.key === 'Escape') setEditingChapterId(null);
                }}
                className={`flex-1 px-3 py-1.5 rounded-lg border-2 font-black text-sm outline-none ${isDark ? 'bg-slate-900 border-indigo-600 text-white' : 'bg-white border-indigo-600 text-black'}`}
              />
              <button onClick={handleSaveEdit} className="p-1.5 bg-emerald-600 text-white rounded-lg hover:scale-110 transition-transform"><Check className="w-4 h-4" /></button>
            </div>
          ) : (
            <div className="flex items-center gap-3 min-w-0">
              <div className={`truncate font-black text-xs sm:text-sm ${c.isCompleted ? 'line-through decoration-indigo-500/40' : ''}`}>{c.title}</div>
              {c.audioDriveId ? (
                isStale ? (
                  <span title="Audio is stale (Rules or Voice changed)"><AlertTriangle className="w-3.5 h-3.5 text-amber-500" /></span>
                ) : (
                  <span title="Audio ready on Drive"><Cloud className="w-3.5 h-3.5 text-emerald-500" /></span>
                )
              ) : (isSynthesizing ? <Loader2 className="w-3.5 h-3.5 animate-spin text-indigo-500" /> : <span title="No audio generated"><AlertTriangle className="w-3.5 h-3.5 text-slate-400 opacity-50" /></span>)}
            </div>
          )}
        </div>

        <div className={`text-[10px] sm:text-xs font-black text-right hidden sm:block ${textSecondary}`}>{c.wordCount?.toLocaleString()} words</div>
        
        <div className="text-right px-4">
          <span className={`text-[9px] sm:text-[10px] font-black px-2 py-0.5 sm:px-2.5 sm:py-1 rounded-full whitespace-nowrap ${c.isCompleted ? 'bg-emerald-500/20 text-emerald-600' : 'bg-indigo-500/15 text-indigo-500'}`}>
            {Math.round((c.progress / (c.progressTotalLength || 1)) * 100)}%
          </span>
        </div>

        <div className="flex justify-end items-center gap-2 hidden sm:flex">
          <button
            onClick={(e) => handleSynthesizeClick(e, c)}
            disabled={isSynthesizing || isBatchSynthesizing}
            className={`p-2 rounded-xl border transition-all ${controlBg} ${isSynthesizing ? 'opacity-100 text-indigo-600 ring-1 ring-indigo-600' : 'opacity-40 hover:opacity-100 hover:text-indigo-500'}`}
            title={c.audioDriveId ? (isStale ? "Audio Stale: Regenerate" : "Refresh Drive Audio") : "Generate Audio"}
          >
            {isSynthesizing ? <Loader2 className="w-4 h-4 animate-spin" /> : (isStale ? <RefreshCw className="w-4 h-4 text-amber-500" /> : <RefreshCw className="w-4 h-4" />)}
          </button>
          {!isEditing && (
            <button
              onClick={(e) => handleStartEdit(e, c.id, c.title)}
              className={`p-2 rounded-xl border transition-all ${controlBg} opacity-40 hover:opacity-100 hover:text-indigo-500`}
              title="Rename Chapter"
            >
              <Edit2 className="w-4 h-4" />
            </button>
          )}
          <button
            onClick={(e) => { e.stopPropagation(); onDeleteChapter(c.id); }}
            className={`p-2 rounded-xl border transition-all ${controlBg} opacity-40 hover:opacity-100 hover:text-red-600`}
            title="Delete Chapter"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className={`h-full min-h-0 flex flex-col ${isDark ? 'bg-slate-900 text-slate-100' : isSepia ? 'bg-[#f4ecd8] text-[#3c2f25]' : 'bg-white text-black'}`}>
      {/* Voice Selection Modal */}
      {showVoiceModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className={`w-full max-w-md rounded-3xl shadow-2xl p-8 space-y-6 ${isDark ? 'bg-slate-900 border border-slate-800' : 'bg-white border border-black/5'}`}>
            <div className="flex justify-between items-center">
              <h3 className="text-xl font-black tracking-tight">Select Cloud Voice</h3>
              <button onClick={() => setShowVoiceModal(null)} className="p-2 opacity-60 hover:opacity-100"><X className="w-5 h-5" /></button>
            </div>
            <p className="text-sm font-bold opacity-60">This voice will be used for generation and remembered as the default for this book.</p>
            <div className="space-y-2">
              {CLOUD_VOICES.map(v => (
                <button
                  key={v.id}
                  onClick={() => handleRunGeneration(v.id, showVoiceModal.chapterId)}
                  className={`w-full p-4 rounded-xl border-2 text-left font-black text-sm transition-all flex justify-between items-center ${isDark ? 'border-slate-800 hover:border-indigo-600 bg-slate-950/40' : 'border-slate-100 hover:border-indigo-600 bg-slate-50'}`}
                >
                  {v.name}
                  < Headphones className="w-4 h-4 opacity-40" />
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

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
              onClick={handleBulkClick}
              disabled={isBatchSynthesizing}
              className={`px-5 py-2.5 rounded-xl text-[10px] sm:text-[11px] font-black flex items-center gap-2 border transition-all ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-black/10 shadow-sm'}`}
            >
              {isBatchSynthesizing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Headphones className="w-3.5 h-3.5" />}
              {isBatchSynthesizing ? `Syncing ${batchProgress.current}/${batchProgress.total}...` : 'Convert Missing Audio'}
            </button>
             <button
              onClick={onAddChapter}
              className="px-5 py-2.5 rounded-xl text-[10px] sm:text-[11px] font-black flex items-center gap-2 bg-indigo-600 text-white shadow-lg shadow-indigo-600/20 hover:scale-105 transition-all"
            >
              <Plus className="w-3.5 h-3.5" />
              Import Chapter
            </button>
            <div className={`flex items-center gap-1 p-1 rounded-xl border shadow-sm ${controlBg}`}>
              <button onClick={() => setViewMode('details')} className={`p-1.5 sm:p-2 rounded-lg transition-all ${viewMode === 'details' ? (isDark ? 'bg-white/10' : 'bg-black/10') : 'opacity-60'}`}><AlignJustify className="w-3.5 h-3.5 sm:w-4 sm:h-4" /></button>
              <button onClick={() => setViewMode('list')} className={`p-1.5 sm:p-2 rounded-lg transition-all ${viewMode === 'list' ? (isDark ? 'bg-white/10' : 'bg-black/10') : 'opacity-60'}`}><List className="w-3.5 h-3.5 sm:w-4 sm:h-4" /></button>
              <button onClick={() => setViewMode('grid')} className={`p-1.5 sm:p-2 rounded-lg transition-all ${viewMode === 'grid' ? (isDark ? 'bg-white/10' : 'bg-black/10') : 'opacity-60'}`}><LayoutGrid className="w-3.5 h-3.5 sm:w-4 sm:h-4" /></button>
            </div>
          </div>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-4 sm:px-8 pb-12 pt-6 sm:pt-8">
        <div className={`rounded-[1.5rem] sm:rounded-[2.5rem] border shadow-sm overflow-hidden ${cardBg}`}>
          {chapters.length === 0 ? (
            <div className="p-12 sm:p-16 text-center">
              <div className={`text-lg font-black ${textPrimary}`}>Empty Collection</div>
            </div>
          ) : (
            <div>
              <div className={`grid grid-cols-[40px_1fr_60px] sm:grid-cols-[60px_1fr_100px_100px_180px] px-4 sm:px-6 py-4 text-[9px] sm:text-[11px] font-black uppercase tracking-widest border-b ${isDark ? 'border-slate-800 bg-slate-950/40 text-indigo-400' : 'border-black/5 bg-black/5 text-indigo-600'}`}>
                <div>Status</div>
                <div>Chapter Name</div>
                <div className="text-right hidden sm:block">Length</div>
                <div className="text-right px-4">Prog.</div>
                <div className="text-right hidden sm:block">Actions</div>
              </div>
              <div className={`divide-y ${isDark ? 'divide-slate-800' : 'divide-white/5'}`}>{chapters.map(renderRow)}</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default ChapterFolderView;