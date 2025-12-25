
import React, { useMemo, useState, useEffect, useCallback, useRef } from 'react';
import { Book, Theme, StorageBackend, Chapter, AudioStatus, CLOUD_VOICES, ScanResult, StrayFile } from '../types';
import { LayoutGrid, List, AlignJustify, Plus, Edit2, RefreshCw, Trash2, Headphones, Loader2, Cloud, AlertTriangle, X, RotateCcw, ChevronLeft, Image as ImageIcon, Search, FileX, AlertCircle, Wrench, Check, History, Trash, ChevronDown, ChevronUp, Settings as GearIcon } from 'lucide-react';
import { PROGRESS_STORE_V4, applyRules } from '../services/speechService';
import { synthesizeChunk } from '../services/cloudTtsService';
import { saveAudioToCache, generateAudioKey, getAudioFromCache } from '../services/audioCache';
import { uploadToDrive, listFilesInFolder, buildMp3Name, buildTextName, createDriveFolder, findFileSync, moveFile, inferChapterIndex, isPlausibleChapterFile } from '../services/driveService';
import { isTokenValid } from '../services/driveAuth';

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
  onResetChapterProgress: (bookId: string, chapterId: string) => void;
}

const ChapterFolderView: React.FC<ChapterFolderViewProps> = ({
  book, theme, onAddChapter, onOpenChapter, onUpdateChapterTitle, onDeleteChapter, onUpdateChapter, onUpdateBookSettings, onBackToLibrary, onResetChapterProgress
}) => {
  const VIEW_MODE_KEY = `talevox:viewMode:${book.id}`;
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    const saved = localStorage.getItem(VIEW_MODE_KEY);
    return (saved === 'details' || saved === 'list' || saved === 'grid') ? (saved as ViewMode) : 'details';
  });

  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => { localStorage.setItem(VIEW_MODE_KEY, viewMode); }, [viewMode, VIEW_MODE_KEY]);

  const [editingChapterId, setEditingChapterId] = useState<string | null>(null);
  const [tempTitle, setTempTitle] = useState('');
  const [synthesizingId, setSynthesizingId] = useState<string | null>(null);
  const [isCheckingDrive, setIsCheckingDrive] = useState(false);
  const [lastScan, setLastScan] = useState<ScanResult | null>(null);
  const [showFixModal, setShowFixModal] = useState(false);
  const [isFixing, setIsFixing] = useState(false);
  const [fixProgress, setFixProgress] = useState({ current: 0, total: 0 });

  const [showVoiceModal, setShowVoiceModal] = useState<{ chapterId?: string } | null>(null);
  const [rememberAsDefault, setRememberAsDefault] = useState(true);

  const [isHeaderExpanded, setIsHeaderExpanded] = useState(false);
  const [mobileMenuId, setMobileMenuId] = useState<string | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const [fixOptions, setFixOptions] = useState({
    genAudio: true,
    restoreText: true,
    cleanupStrays: true
  });

  const isDark = theme === Theme.DARK;
  const isSepia = theme === Theme.SEPIA;
  const cardBg = isDark ? 'bg-slate-800 border-slate-700' : isSepia ? 'bg-[#f4ecd8] border-[#d8ccb6]' : 'bg-white border-black/10';
  const textSecondary = isDark ? 'text-slate-400' : isSepia ? 'text-[#3c2f25]/70' : 'text-slate-600';
  const stickyHeaderBg = isDark ? 'bg-slate-900/90' : isSepia ? 'bg-[#f4ecd8]/90' : 'bg-white/90';

  const chapters = useMemo(() => [...(book.chapters || [])].sort((a, b) => a.index - b.index), [book.chapters]);
  
  const progressData = useMemo(() => {
    void refreshKey;
    const store = JSON.parse(localStorage.getItem(PROGRESS_STORE_V4) || '{}');
    return store[book.id] || {};
  }, [book.id, refreshKey]);

  useEffect(() => {
    const handleProgressUpdate = () => setRefreshKey(k => k + 1);
    window.addEventListener('talevox_progress_updated', handleProgressUpdate);
    return () => window.removeEventListener('talevox_progress_updated', handleProgressUpdate);
  }, []);

  const handleCheckDriveIntegrity = useCallback(async () => {
    if (!book.driveFolderId) return;
    if (!isTokenValid()) {
      alert("Google Drive session expired. Please sign in again in Settings.");
      return;
    }
    setIsCheckingDrive(true);
    try {
      const driveFiles = await listFilesInFolder(book.driveFolderId);
      const matchedFileIds = new Set<string>();
      
      const scan: ScanResult = { missingTextIds: [], missingAudioIds: [], strayFiles: [], duplicates: [], totalChecked: chapters.length };

      // Helper to find fuzzy matches if exact match fails
      const findFileForChapter = (index: number, type: 'text' | 'audio') => {
         const exts = type === 'text' ? ['txt', 'md'] : ['mp3', 'wav', 'm4a'];
         return driveFiles.find(f => {
            if (matchedFileIds.has(f.id)) return false;
            const fExt = f.name.split('.').pop()?.toLowerCase();
            if (!exts.includes(fExt || '')) return false;
            const inferred = inferChapterIndex(f.name);
            return inferred === index;
         });
      };

      for (const chapter of chapters) {
        const expectedTextName = buildTextName(chapter.index, chapter.title);
        const expectedAudioName = buildMp3Name(chapter.index, chapter.title);
        
        // 1. Try exact name match
        let textFile = driveFiles.find(f => f.name === expectedTextName);
        let audioFile = driveFiles.find(f => f.name === expectedAudioName);

        // 2. Fallback to fuzzy match (index + extension)
        if (!textFile) textFile = findFileForChapter(chapter.index, 'text');
        if (!audioFile) audioFile = findFileForChapter(chapter.index, 'audio');

        if (textFile) matchedFileIds.add(textFile.id);
        if (audioFile) matchedFileIds.add(audioFile.id);

        if (!textFile) scan.missingTextIds.push(chapter.id);
        if (!audioFile) scan.missingAudioIds.push(chapter.id);

        // Update chapter record with found IDs (even if name doesn't match standard)
        onUpdateChapter({ 
            ...chapter, 
            cloudTextFileId: textFile?.id || chapter.cloudTextFileId, 
            cloudAudioFileId: audioFile?.id || chapter.cloudAudioFileId, 
            hasTextOnDrive: !!textFile, 
            audioStatus: audioFile ? AudioStatus.READY : (chapter.audioStatus === AudioStatus.READY ? AudioStatus.PENDING : chapter.audioStatus) 
        });
      }

      for (const f of driveFiles) {
        if (matchedFileIds.has(f.id) || f.mimeType === 'application/vnd.google-apps.folder') continue;
        
        const lower = f.name.toLowerCase();
        if (lower.includes('cover') || lower.includes('manifest') || lower.endsWith('.json') || lower.endsWith('.jpg') || lower.endsWith('.png')) continue;

        // Skip files that look like chapters but weren't matched to current library (prevent deletion of potentially valid files)
        if (isPlausibleChapterFile(f.name)) {
            console.log(`[Scanner] Ignoring plausible chapter file not in library: ${f.name}`);
            continue;
        }

        scan.strayFiles.push(f);
        console.log(`[Scanner] Marked as stray: ${f.name} (No match, not plausible asset)`);
      }
      setLastScan(scan);
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
        if (audioBlob) await saveAudioToCache(cacheKey, audioBlob);
      }
      if (!audioBlob) throw new Error("No audio blob available");
      let cloudId = chapter.cloudAudioFileId || chapter.audioDriveId;
      if (book.backend === StorageBackend.DRIVE && book.driveFolderId) {
        const filename = buildMp3Name(chapter.index, chapter.title);
        cloudId = await uploadToDrive(book.driveFolderId, filename, audioBlob, cloudId, 'audio/mpeg');
      }
      onUpdateChapter({ ...chapter, cloudAudioFileId: cloudId, audioStatus: AudioStatus.READY, hasCachedAudio: true });
    } catch (e) {
      onUpdateChapter({ ...chapter, audioStatus: AudioStatus.FAILED });
    } finally {
      setSynthesizingId(null);
    }
  };

  const handleRunFix = async () => {
    if (!lastScan || !book.driveFolderId) return;
    setIsFixing(true);
    const totalActions = (fixOptions.restoreText ? lastScan.missingTextIds.length : 0) + (fixOptions.genAudio ? lastScan.missingAudioIds.length : 0) + (fixOptions.cleanupStrays ? lastScan.strayFiles.length : 0);
    setFixProgress({ current: 0, total: totalActions });
    try {
      if (fixOptions.restoreText) {
        for (const cid of lastScan.missingTextIds) {
          const ch = chapters.find(c => c.id === cid);
          if (ch && ch.content) {
            const filename = buildTextName(ch.index, ch.title);
            const id = await uploadToDrive(book.driveFolderId, filename, ch.content);
            onUpdateChapter({ ...ch, cloudTextFileId: id, hasTextOnDrive: true });
          }
          setFixProgress(p => ({ ...p, current: p.current + 1 }));
        }
      }
      if (fixOptions.genAudio) {
        for (const cid of lastScan.missingAudioIds) {
          const ch = chapters.find(c => c.id === cid);
          if (ch) await generateAudio(ch);
          setFixProgress(p => ({ ...p, current: p.current + 1 }));
        }
      }
      if (fixOptions.cleanupStrays && lastScan.strayFiles.length > 0) {
        let trashFolderId = await findFileSync('_trash', book.driveFolderId);
        if (!trashFolderId) trashFolderId = await createDriveFolder('_trash', book.driveFolderId);
        for (const file of lastScan.strayFiles) {
          await moveFile(file.id, book.driveFolderId!, trashFolderId);
          setFixProgress(p => ({ ...p, current: p.current + 1 }));
        }
      }
      setShowFixModal(false);
      handleCheckDriveIntegrity();
    } catch (e: any) {
      alert("Fix encountered error: " + e.message);
    } finally {
      setIsFixing(false);
    }
  };

  const handleVoiceSelect = (voiceId: string) => {
    const chId = showVoiceModal?.chapterId;
    if (onUpdateBookSettings && rememberAsDefault) onUpdateBookSettings({ ...book.settings, defaultVoiceId: voiceId });
    setShowVoiceModal(null);
    if (chId) {
      const chapter = chapters.find(c => c.id === chId);
      if (chapter) generateAudio(chapter, voiceId);
    }
  };

  const renderAudioStatusIcon = (c: Chapter) => {
    if (c.cloudAudioFileId || c.audioDriveId || c.audioStatus === AudioStatus.READY) return <span title="Audio ready on Google Drive" className="inline-flex items-center"><Cloud className="w-4 h-4 text-emerald-500" /></span>;
    if (synthesizingId === c.id || c.audioStatus === AudioStatus.GENERATING) return <span title="Generating and Uploading..." className="inline-flex items-center"><Loader2 className="w-4 h-4 text-indigo-400 animate-spin" /></span>;
    return <span title="Audio missing" className="inline-flex items-center"><AlertTriangle className="w-4 h-4 text-amber-500" /></span>;
  };

  const renderTextStatusIcon = (c: Chapter) => {
    if (book.backend !== StorageBackend.DRIVE) return null;
    if (c.hasTextOnDrive === false) return <span title="Source text missing from Drive" className="inline-flex items-center ml-2"><FileX className="w-4 h-4 text-red-500" /></span>;
    return null;
  };

  const MobileChapterMenu = ({ chapterId }: { chapterId: string }) => {
    const ch = chapters.find(c => c.id === chapterId);
    if (!ch) return null;
    return (
      <div className="fixed inset-0 z-[110] flex items-end sm:items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={() => setMobileMenuId(null)}>
        <div className={`w-full max-w-sm rounded-[2rem] shadow-2xl p-6 overflow-hidden animate-in slide-in-from-bottom-4 duration-200 ${isDark ? 'bg-slate-900 border border-white/10' : 'bg-white'}`} onClick={e => e.stopPropagation()}>
           <div className="flex justify-between items-center mb-6">
              <h3 className="text-sm font-black uppercase tracking-widest opacity-60">Chapter Options</h3>
              <button onClick={() => setMobileMenuId(null)} className="p-2 opacity-40"><X className="w-5 h-5" /></button>
           </div>
           <div className="space-y-2">
              <button onClick={() => { setMobileMenuId(null); handleCheckDriveIntegrity(); }} className={`w-full flex items-center gap-4 p-4 rounded-2xl font-black text-sm transition-all ${isDark ? 'hover:bg-white/5' : 'hover:bg-black/5'}`}>
                 <div className="p-2 bg-indigo-600/10 text-indigo-600 rounded-lg"><RefreshCw className="w-4 h-4" /></div>
                 Check Audio + Text
              </button>
              <button onClick={() => { setMobileMenuId(null); setEditingChapterId(ch.id); setTempTitle(ch.title); }} className={`w-full flex items-center gap-4 p-4 rounded-2xl font-black text-sm transition-all ${isDark ? 'hover:bg-white/5' : 'hover:bg-black/5'}`}>
                 <div className="p-2 bg-indigo-600/10 text-indigo-600 rounded-lg"><Edit2 className="w-4 h-4" /></div>
                 Edit Title
              </button>
              <button onClick={() => { if (confirm('Delete?')) { onDeleteChapter(ch.id); setMobileMenuId(null); } }} className={`w-full flex items-center gap-4 p-4 rounded-2xl font-black text-sm text-red-500 transition-all ${isDark ? 'hover:bg-red-500/10' : 'hover:bg-red-500/5'}`}>
                 <div className="p-2 bg-red-500/10 text-red-500 rounded-lg"><Trash2 className="w-4 h-4" /></div>
                 Delete Chapter
              </button>
           </div>
        </div>
      </div>
    );
  };

  const renderDetailsView = () => (
    <div className={`rounded-3xl border shadow-sm overflow-hidden ${cardBg}`}>
      <div className={`grid grid-cols-[40px_1fr_80px_100px] md:grid-cols-[40px_1fr_100px_150px] px-6 py-3 text-[10px] font-black uppercase tracking-widest border-b ${isDark ? 'border-slate-800 bg-slate-950/40 text-indigo-400' : 'border-black/5 bg-black/5 text-indigo-600'}`}>
        <div>Idx</div><div>Title</div><div className="text-right px-4">Progress</div><div className="text-right">Actions</div>
      </div>
      <div className="divide-y divide-black/5">
        {chapters.map(c => {
          const saved = progressData[c.id];
          const isCompleted = saved?.completed || false;
          const percent = saved?.percent !== undefined ? Math.floor(saved.percent * 100) : 0;
          const isEditing = editingChapterId === c.id;

          return (
            <div key={c.id} onClick={() => !isEditing && onOpenChapter(c.id)} className={`grid grid-cols-[40px_1fr_80px_60px] md:grid-cols-[40px_1fr_100px_150px] items-center px-6 py-4 cursor-pointer border-b last:border-0 transition-colors ${isDark ? 'hover:bg-white/5 border-slate-800' : 'hover:bg-black/5 border-black/5'} ${isCompleted ? 'opacity-50' : ''}`}>
              <div className={`font-mono text-xs font-black ${textSecondary}`}>{String(c.index).padStart(3, '0')}</div>
              <div className="flex flex-col gap-1 min-w-0 mr-4">
                <div className="flex items-center gap-3">
                  {isEditing ? (
                    <div className="flex-1 flex items-center gap-2" onClick={e => e.stopPropagation()}>
                      <input autoFocus type="text" value={tempTitle} onChange={e => setTempTitle(e.target.value)} onBlur={() => { onUpdateChapterTitle(c.id, tempTitle); setEditingChapterId(null); }} className="px-2 py-1 rounded border text-sm font-bold w-full bg-inherit" />
                    </div>
                  ) : (
                    <div className="font-black text-sm truncate flex items-center">{c.title}{renderTextStatusIcon(c)}</div>
                  )}
                  <span className="md:inline hidden">{renderAudioStatusIcon(c)}</span>
                </div>
                <div className={`h-1 w-full rounded-full overflow-hidden ${isDark ? 'bg-slate-700' : 'bg-black/5'}`}>
                   <div className={`h-full transition-all duration-500 ${isCompleted ? 'bg-emerald-500' : 'bg-indigo-500'}`} style={{ width: `${percent}%` }} />
                </div>
              </div>
              <div className="text-right px-4">
                <span className={`text-[10px] font-black px-2 py-0.5 rounded-full ${isCompleted ? 'bg-emerald-500/20 text-emerald-600' : 'bg-indigo-500/15 text-indigo-500'}`}>{isCompleted ? 'Done' : `${percent}%`}</span>
              </div>
              {/* Actions Toggle */}
              <div className="flex justify-end items-center gap-2">
                {/* Desktop Buttons */}
                <div className="hidden md:flex items-center gap-2">
                  {isCompleted && (
                    <button onClick={(e) => { e.stopPropagation(); onResetChapterProgress(book.id, c.id); }} className="p-2 bg-indigo-600/10 text-indigo-600 rounded-xl hover:bg-indigo-600/20" title="Reset Progress">
                      <RotateCcw className="w-4 h-4" />
                    </button>
                  )}
                  <button onClick={(e) => { e.stopPropagation(); setRememberAsDefault(false); setShowVoiceModal({ chapterId: c.id }); }} className="p-2 opacity-40 hover:opacity-100"><RefreshCw className="w-4 h-4" /></button>
                  <button onClick={(e) => { e.stopPropagation(); setEditingChapterId(c.id); setTempTitle(c.title); }} className="p-2 opacity-40 hover:opacity-100"><Edit2 className="w-4 h-4" /></button>
                  <button onClick={(e) => { e.stopPropagation(); if (confirm('Delete?')) onDeleteChapter(c.id); }} className="p-2 opacity-40 hover:opacity-100 hover:text-red-500"><Trash2 className="w-4 h-4" /></button>
                </div>
                {/* Mobile Gear */}
                <div className="md:hidden flex items-center gap-2">
                   {isCompleted && (
                    <button onClick={(e) => { e.stopPropagation(); onResetChapterProgress(book.id, c.id); }} className="p-1.5 text-indigo-600" title="Reset Progress">
                      <RotateCcw className="w-4 h-4" />
                    </button>
                  )}
                  <button onClick={(e) => { e.stopPropagation(); setMobileMenuId(c.id); }} className="p-1.5 opacity-40">
                    <GearIcon className="w-4 h-4" />
                  </button>
                </div>
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
        const isCompleted = saved?.completed || false;
        return (
          <div key={c.id} onClick={() => onOpenChapter(c.id)} className={`flex flex-col gap-2 p-4 rounded-2xl border cursor-pointer transition-all hover:translate-x-1 ${cardBg}`}>
            <div className="flex items-center gap-4">
              <div className={`w-8 h-8 rounded-lg flex items-center justify-center font-mono text-[10px] font-black ${isDark ? 'bg-slate-950 text-indigo-400' : 'bg-indigo-50 text-indigo-600'}`}>{c.index}</div>
              <div className="flex-1 min-w-0 font-black text-sm truncate flex items-center">{c.title}{renderTextStatusIcon(c)}</div>
              <div className="flex items-center gap-3">
                <span className="text-[9px] font-black opacity-40 uppercase">{percent}%</span>
                {renderAudioStatusIcon(c)}
                <div className="flex md:hidden gap-1 items-center">
                  {isCompleted && (
                    <button onClick={(e) => { e.stopPropagation(); onResetChapterProgress(book.id, c.id); }} className="p-1.5 text-indigo-600">
                      <RotateCcw className="w-3.5 h-3.5" />
                    </button>
                  )}
                  <button onClick={(e) => { e.stopPropagation(); setMobileMenuId(c.id); }} className="p-1.5 opacity-40">
                    <GearIcon className="w-3.5 h-3.5" />
                  </button>
                </div>
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
        const isCompleted = saved?.completed || false;
        return (
          <div key={c.id} onClick={() => onOpenChapter(c.id)} className={`aspect-square p-4 rounded-3xl border flex flex-col items-center justify-center text-center gap-2 cursor-pointer transition-all hover:scale-105 group relative ${cardBg}`}>
            <div className="absolute top-3 right-3 flex gap-1">{renderTextStatusIcon(c)}{renderAudioStatusIcon(c)}</div>
            <div className={`w-12 h-12 rounded-2xl flex items-center justify-center font-mono text-lg font-black mb-1 ${isDark ? 'bg-slate-950 text-indigo-400' : 'bg-indigo-50 text-indigo-600'}`}>{c.index}</div>
            <div className="font-black text-xs line-clamp-2 leading-tight px-1">{c.title}</div>
            <div className="mt-2 w-full px-4">
               <div className={`h-1 w-full rounded-full overflow-hidden ${isDark ? 'bg-slate-700' : 'bg-black/5'}`}><div className="h-full bg-indigo-500" style={{ width: `${percent}%` }} /></div>
               <div className="text-[8px] font-black uppercase mt-1">{percent}%</div>
            </div>
            {/* Desktop Quick Actions Overlay */}
            <button onClick={(e) => { e.stopPropagation(); if (confirm('Delete?')) onDeleteChapter(c.id); }} className="hidden md:block absolute bottom-2 right-2 p-2 opacity-0 group-hover:opacity-100 text-red-500 transition-opacity"><Trash2 className="w-3.5 h-3.5" /></button>
            {/* Mobile Actions Overlay */}
            <div className="md:hidden absolute bottom-2 left-0 right-0 flex justify-center gap-2 px-2">
               {isCompleted && (
                 <button onClick={(e) => { e.stopPropagation(); onResetChapterProgress(book.id, c.id); }} className="p-2 bg-indigo-600/10 text-indigo-600 rounded-xl">
                   <RotateCcw className="w-3.5 h-3.5" />
                 </button>
               )}
               <button onClick={(e) => { e.stopPropagation(); setMobileMenuId(c.id); }} className="p-2 bg-black/5 rounded-xl opacity-60">
                 <GearIcon className="w-3.5 h-3.5" />
               </button>
            </div>
          </div>
        );
      })}
    </div>
  );

  const hasIssues = lastScan && (lastScan.missingTextIds.length > 0 || lastScan.missingAudioIds.length > 0 || lastScan.strayFiles.length > 0);

  return (
    <div className={`h-full min-h-0 flex flex-col ${isDark ? 'bg-slate-900 text-slate-100' : isSepia ? 'bg-[#f4ecd8] text-[#3c2f25]' : 'bg-white text-black'}`}>
      {showVoiceModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className={`w-full max-w-md rounded-3xl shadow-2xl p-8 space-y-6 ${isDark ? 'bg-slate-900 border border-slate-800' : 'bg-white border border-black/5'}`}>
            <div className="flex justify-between items-center"><h3 className="text-xl font-black tracking-tight">Select Cloud Voice</h3><button onClick={() => setShowVoiceModal(null)} className="p-2 opacity-60 hover:opacity-100"><X className="w-5 h-5" /></button></div>
            <div className="space-y-4">
              <div className="flex items-center gap-3 p-3 bg-black/5 rounded-xl"><input type="checkbox" id="rememberDefault" checked={rememberAsDefault} onChange={e => setRememberAsDefault(e.target.checked)} className="w-4 h-4 accent-indigo-600" /><label htmlFor="rememberDefault" className="text-xs font-black uppercase tracking-tight opacity-70 cursor-pointer">Set as book default</label></div>
              <div className="space-y-2 max-h-[40vh] overflow-y-auto pr-1">
                {CLOUD_VOICES.map(v => (<button key={v.id} onClick={() => handleVoiceSelect(v.id)} className={`w-full p-4 rounded-xl border-2 text-left font-black text-sm transition-all flex justify-between items-center ${isDark ? 'border-slate-800 hover:border-indigo-600 bg-slate-950/40' : 'border-slate-100 hover:border-indigo-600 bg-slate-50'}`}>{v.name}<Headphones className="w-4 h-4 opacity-40" /></button>))}
              </div>
            </div>
          </div>
        </div>
      )}

      {mobileMenuId && <MobileChapterMenu chapterId={mobileMenuId} />}

      {showFixModal && lastScan && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm overflow-y-auto">
          <div className={`w-full max-w-2xl rounded-[2.5rem] shadow-2xl p-8 lg:p-12 space-y-8 animate-in zoom-in-95 ${isDark ? 'bg-slate-900 border border-white/10' : 'bg-white'}`}>
             <div className="flex justify-between items-start"><div><h3 className="text-2xl font-black tracking-tight flex items-center gap-3"><Wrench className="w-7 h-7 text-indigo-600" /> Fix & Cleanup Cloud Folder</h3><p className="text-xs font-bold opacity-50 uppercase tracking-widest mt-2">Book: {book.title}</p></div>{!isFixing && <button onClick={() => setShowFixModal(false)} className="p-3 bg-black/5 rounded-full hover:bg-black/10"><X className="w-6 h-6" /></button>}</div>
             <div className="grid grid-cols-1 sm:grid-cols-3 gap-4"><div className="p-4 rounded-2xl bg-indigo-600/5 border border-indigo-600/10 flex flex-col gap-1"><span className="text-[10px] font-black uppercase text-indigo-600">Missing Text</span><span className="text-2xl font-black">{lastScan.missingTextIds.length}</span></div><div className="p-4 rounded-2xl bg-amber-600/5 border border-amber-600/10 flex flex-col gap-1"><span className="text-[10px] font-black uppercase text-amber-600">Missing Audio</span><span className="text-2xl font-black">{lastScan.missingAudioIds.length}</span></div><div className="p-4 rounded-2xl bg-red-600/5 border border-red-600/10 flex flex-col gap-1"><span className="text-[10px] font-black uppercase text-red-600">Stray Files</span><span className="text-2xl font-black">{lastScan.strayFiles.length}</span></div></div>
             <div className="space-y-4"><label className="text-[10px] font-black uppercase tracking-widest opacity-60">Actions to Perform</label><div className="space-y-3"><label className="flex items-center gap-4 p-4 rounded-2xl border-2 border-black/5 cursor-pointer hover:bg-black/5 transition-colors"><input type="checkbox" className="w-5 h-5 accent-indigo-600" checked={fixOptions.restoreText} onChange={e => setFixOptions(o => ({...o, restoreText: e.target.checked}))} /><div><div className="text-sm font-black">Restore Missing Text</div><p className="text-[10px] opacity-60 uppercase font-bold">Re-upload local content to Drive</p></div></label><label className="flex items-center gap-4 p-4 rounded-2xl border-2 border-black/5 cursor-pointer hover:bg-black/5 transition-colors"><input type="checkbox" className="w-5 h-5 accent-indigo-600" checked={fixOptions.genAudio} onChange={e => setFixOptions(o => ({...o, genAudio: e.target.checked}))} /><div><div className="text-sm font-black">Generate Missing Audio</div><p className="text-[10px] opacity-60 uppercase font-bold">Synthesize and upload MP3s</p></div></label><label className="flex items-center gap-4 p-4 rounded-2xl border-2 border-black/5 cursor-pointer hover:bg-black/5 transition-colors"><input type="checkbox" className="w-5 h-5 accent-indigo-600" checked={fixOptions.cleanupStrays} onChange={e => setFixOptions(o => ({...o, cleanupStrays: e.target.checked}))} /><div><div className="text-sm font-black">Cleanup Book Folder</div><p className="text-[10px] opacity-60 uppercase font-bold">Move unrecognized files to _trash</p></div></label></div></div>
             <div className="max-h-[25vh] overflow-y-auto border rounded-2xl p-4 bg-black/5 space-y-2"><span className="text-[10px] font-black uppercase opacity-40 sticky top-0 bg-inherit py-1">Detailed Breakdown</span>{fixOptions.restoreText && lastScan.missingTextIds.map(cid => (<div key={`txt-${cid}`} className="text-xs font-bold flex items-center gap-2 text-indigo-600"><Plus className="w-3 h-3" /> Re-upload: {chapters.find(c=>c.id===cid)?.title}</div>))}{fixOptions.genAudio && lastScan.missingAudioIds.map(cid => (<div key={`aud-${cid}`} className="text-xs font-bold flex items-center gap-2 text-amber-600"><Headphones className="w-3 h-3" /> Synthesize: {chapters.find(c=>c.id===cid)?.title}</div>))}{fixOptions.cleanupStrays && lastScan.strayFiles.map(f => (<div key={`stray-${f.id}`} className="text-xs font-bold flex items-center gap-2 text-red-600"><History className="w-3 h-3" /> Move to _trash: {f.name}</div>))}</div>
             {isFixing ? (<div className="space-y-4 pt-4"><div className="flex justify-between items-center"><span className="text-sm font-black">Restoring Integrity...</span><span className="text-xs font-mono font-black">{fixProgress.current} / {fixProgress.total}</span></div><div className="h-3 w-full bg-black/5 rounded-full overflow-hidden"><div className="h-full bg-indigo-600 transition-all duration-300" style={{ width: `${(fixProgress.current / fixProgress.total) * 100}%` }} /></div></div>) : (<div className="grid grid-cols-2 gap-4"><button onClick={() => setShowFixModal(false)} className="py-4 rounded-2xl font-black uppercase text-[10px] tracking-widest border-2 hover:bg-black/5">Cancel</button><button onClick={handleRunFix} className="py-4 bg-indigo-600 text-white rounded-2xl font-black uppercase text-[10px] tracking-widest shadow-xl hover:scale-[1.02] active:scale-95 transition-all">Start Fixing</button></div>)}
          </div>
        </div>
      )}

      <div className={`sticky top-0 z-50 border-b border-black/5 backdrop-blur-md transition-all duration-300 ${stickyHeaderBg}`}>
        <div className={`p-4 sm:p-6 lg:p-8 flex flex-col gap-4 ${!isHeaderExpanded ? 'md:block' : ''}`}>
          <div className="flex items-center justify-between">
            <button onClick={onBackToLibrary} className="flex items-center gap-1 text-[10px] font-black uppercase tracking-widest text-indigo-500 hover:translate-x-[-2px] transition-transform"><ChevronLeft className="w-3 h-3" /> Library</button>
            <div className="flex items-center gap-1 p-1 rounded-xl bg-black/5">
              <button onClick={() => setViewMode('grid')} className={`p-1.5 rounded-lg transition-all ${viewMode === 'grid' ? 'bg-white shadow-sm text-indigo-600' : 'opacity-40'}`}><LayoutGrid className="w-3.5 h-3.5" /></button>
              <button onClick={() => setViewMode('list')} className={`p-1.5 rounded-lg transition-all ${viewMode === 'list' ? 'bg-white shadow-sm text-indigo-600' : 'opacity-40'}`}><AlignJustify className="w-3.5 h-3.5" /></button>
              <button onClick={() => setViewMode('details')} className={`p-1.5 rounded-lg transition-all ${viewMode === 'details' ? 'bg-white shadow-sm text-indigo-600' : 'opacity-40'}`}><List className="w-3.5 h-3.5" /></button>
            </div>
          </div>
          
          <div className={`flex items-center gap-3 sm:gap-8 cursor-pointer md:cursor-default`} onClick={() => window.innerWidth < 768 && setIsHeaderExpanded(!isHeaderExpanded)}>
            <div className={`rounded-xl sm:rounded-2xl overflow-hidden shadow-xl flex-shrink-0 bg-indigo-600/10 flex items-center justify-center transition-all duration-300 ${isHeaderExpanded ? 'w-24 sm:w-32 aspect-[2/3]' : 'w-12 sm:w-32 aspect-[1/1] sm:aspect-[2/3]'}`}>{book.coverImage ? <img src={book.coverImage} className="w-full h-full object-cover" alt={book.title} /> : <ImageIcon className="w-5 h-5 sm:w-10 sm:h-10 opacity-20" />}</div>
            <div className="flex-1 min-w-0"><div className="flex items-center gap-2"><h1 className={`font-black tracking-tight truncate transition-all duration-300 ${isHeaderExpanded ? 'text-xl sm:text-3xl' : 'text-sm sm:text-3xl'}`}>{book.title}</h1><div className="md:hidden">{isHeaderExpanded ? <ChevronUp className="w-4 h-4 opacity-40" /> : <ChevronDown className="w-4 h-4 opacity-40" />}</div></div><p className={`font-bold opacity-60 uppercase tracking-widest transition-all duration-300 ${isHeaderExpanded ? 'text-[10px] sm:text-xs mt-1' : 'text-[8px] sm:text-xs'}`}>{book.chapters.length} Chapters {isHeaderExpanded && `• ${book.backend} backend`}</p></div>
          </div>

          <div className={`flex flex-wrap gap-2 transition-all duration-300 ${isHeaderExpanded || window.innerWidth >= 768 ? 'opacity-100 max-h-40 pointer-events-auto' : 'opacity-0 max-h-0 pointer-events-none overflow-hidden sm:opacity-100 sm:max-h-40 sm:pointer-events-auto'}`}>
            <button onClick={onAddChapter} className="flex-1 sm:flex-none px-4 py-2 sm:px-6 sm:py-3 bg-indigo-600 text-white rounded-xl sm:rounded-2xl font-black uppercase text-[9px] sm:text-[10px] tracking-widest shadow-xl hover:scale-105 active:scale-95 transition-all flex items-center justify-center gap-2"><Plus className="w-3.5 h-3.5" /> Add Chapter</button>
            <button onClick={handleCheckDriveIntegrity} disabled={isCheckingDrive} className="flex-1 sm:flex-none px-4 py-2 sm:px-6 sm:py-3 bg-white text-indigo-600 border border-indigo-600/20 rounded-xl sm:rounded-2xl font-black uppercase text-[9px] sm:text-[10px] tracking-widest shadow-lg hover:bg-indigo-50 active:scale-95 transition-all flex items-center justify-center gap-2">{isCheckingDrive ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}{isCheckingDrive ? '...' : 'Check'}</button>
            <button onClick={() => setShowFixModal(true)} disabled={!hasIssues} className={`flex-1 sm:flex-none px-4 py-2 sm:px-6 sm:py-3 rounded-xl sm:rounded-2xl font-black uppercase text-[9px] sm:text-[10px] tracking-widest shadow-lg active:scale-95 transition-all flex items-center justify-center gap-2 ${hasIssues ? 'bg-amber-600 text-white shadow-amber-600/20 hover:scale-105' : 'bg-black/5 text-black/20 cursor-not-allowed'}`}><Wrench className="w-3.5 h-3.5" /> Fix</button>
          </div>
        </div>
      </div>

      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto px-4 sm:px-6 py-6 sm:py-8">{chapters.length === 0 ? (<div className="p-12 text-center text-xs font-black opacity-30 uppercase">No chapters found</div>) : (<>{viewMode === 'details' && renderDetailsView()}{viewMode === 'list' && renderListView()}{viewMode === 'grid' && renderGridView()}</>)}</div>
    </div>
  );
};

export default ChapterFolderView;
