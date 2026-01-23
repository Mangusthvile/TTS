import React, { useMemo, useState, useEffect, useCallback, useRef } from 'react';
import { Book, Theme, StorageBackend, Chapter, AudioStatus, CLOUD_VOICES, ScanResult, StrayFile, Rule, HighlightMode } from '../types';
import { LayoutGrid, List, AlignJustify, Plus, Edit2, RefreshCw, Trash2, Headphones, Loader2, Cloud, AlertTriangle, X, RotateCcw, ChevronLeft, Image as ImageIcon, Search, FileX, AlertCircle, Wrench, Check, History, Trash, ChevronDown, ChevronUp, Settings as GearIcon, Sparkles } from 'lucide-react';
import { applyRules } from '../services/speechService';
import { synthesizeChunk } from '../services/cloudTtsService';
import { saveAudioToCache, generateAudioKey, getAudioFromCache, hasAudioInCache } from '../services/audioCache';
import { uploadToDrive, listFilesInFolder, buildMp3Name, buildTextName, createDriveFolder, findFileSync, moveFile, moveFileToTrash } from '../services/driveService';
import { isTokenValid } from '../services/driveAuth';
import { reflowLineBreaks } from '../services/textFormat';
import { loadChapterText as libraryLoadChapterText } from '../services/libraryStore';

type ViewMode = 'details' | 'list' | 'grid';

interface ChapterFolderViewProps {
  book: Book;
  theme: Theme;
  globalRules: Rule[];
  reflowLineBreaksEnabled: boolean;
  onAddChapter: () => void;
  onOpenChapter: (chapterId: string) => void;
  onToggleFavorite: (chapterId: string) => void;
  onUpdateChapterTitle: (chapterId: string, newTitle: string) => void;
  onDeleteChapter: (chapterId: string) => void;
  onUpdateChapter: (chapter: Chapter) => void;
  onUpdateBookSettings?: (settings: any) => void;
  onBackToLibrary: () => void;
  onResetChapterProgress: (bookId: string, chapterId: string) => void;
  playbackSnapshot?: { chapterId: string, percent: number } | null;

  // Phase One: paging support
  onLoadMoreChapters?: () => void;
  hasMoreChapters?: boolean;
  isLoadingMoreChapters?: boolean;
}

const ChapterFolderView: React.FC<ChapterFolderViewProps> = ({
  book,
  theme,
  globalRules,
  reflowLineBreaksEnabled,
  onAddChapter,
  onOpenChapter,
  onToggleFavorite,
  onUpdateChapterTitle,
  onDeleteChapter,
  onUpdateChapter,
  onUpdateBookSettings,
  onBackToLibrary,
  onResetChapterProgress,
  playbackSnapshot,
  onLoadMoreChapters,
  hasMoreChapters,
  isLoadingMoreChapters
}) => {
  const { driveFolderId } = book;
  const VIEW_MODE_KEY = `talevox:viewMode:${book.id}`;
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    const saved = localStorage.getItem(VIEW_MODE_KEY);
    return (saved === 'details' || saved === 'list' || saved === 'grid') ? (saved as ViewMode) : 'details';
  });

  useEffect(() => { localStorage.setItem(VIEW_MODE_KEY, viewMode); }, [viewMode, VIEW_MODE_KEY]);

  const [editingChapterId, setEditingChapterId] = useState<string | null>(null);
  const [tempTitle, setTempTitle] = useState('');
  const [synthesizingId, setSynthesizingId] = useState<string | null>(null);
  const [synthesisProgress, setSynthesisProgress] = useState<{ current: number, total: number, message: string } | null>(null);
  const [isCheckingDrive, setIsCheckingDrive] = useState(false);
  const [lastScan, setLastScan] = useState<ScanResult | null>(null);
  const [missingTextIds, setMissingTextIds] = useState<string[]>([]);
  const [missingAudioIds, setMissingAudioIds] = useState<string[]>([]);
  const [fixLog, setFixLog] = useState<string[]>([]);

  const [notice, setNotice] = useState<{ message: string; kind: 'info' | 'success' | 'error' } | null>(null);
  const noticeTimerRef = useRef<number | null>(null);

  const pushNotice = useCallback((message: string, kind: 'info' | 'success' | 'error' = 'info', durationMs: number = 3000) => {
    setNotice({ message, kind });

    if (noticeTimerRef.current) {
      window.clearTimeout(noticeTimerRef.current);
      noticeTimerRef.current = null;
    }

    if (durationMs > 0) {
      noticeTimerRef.current = window.setTimeout(() => {
        setNotice(null);
        noticeTimerRef.current = null;
      }, durationMs);
    }
  }, []);

  const [showFixModal, setShowFixModal] = useState(false);
  const [isFixing, setIsFixing] = useState(false);
  const [fixProgress, setFixProgress] = useState({ current: 0, total: 0 });
  const abortFixRef = useRef(false);

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
  const subtleText = textSecondary;
  const stickyHeaderBg = isDark ? 'bg-slate-900/90' : isSepia ? 'bg-[#f4ecd8]/90' : 'bg-white/90';

  const chapters = useMemo(() => [...(book.chapters || [])].sort((a, b) => a.index - b.index), [book.chapters]);

  const loadMoreSentinelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!hasMoreChapters) return;
    if (!onLoadMoreChapters) return;
    const el = loadMoreSentinelRef.current;
    if (!el) return;

    const obs = new IntersectionObserver((entries) => {
      const first = entries[0];
      if (first?.isIntersecting && !isLoadingMoreChapters) {
        onLoadMoreChapters();
      }
    }, { rootMargin: '200px' });

    obs.observe(el);
    return () => obs.disconnect();
  }, [hasMoreChapters, onLoadMoreChapters, isLoadingMoreChapters]);

  const handleCheckDriveIntegrity = useCallback(async (): Promise<ScanResult | null> => {
    if (!driveFolderId) {
      pushNotice("Drive folder not set for this book yet.", "error");
      return null;
    }
    if (!isTokenValid()) {
      alert("Google Drive session expired. Please sign in again in Settings.");
      return null;
    }
    setIsCheckingDrive(true);
    try {
      const driveFiles = await listFilesInFolder(driveFolderId);

      // Build fast lookup by name
      const byName = new Map(driveFiles.map(f => [f.name, f]));

      // Expected file names from current chapters
      const expectedNames = new Set<string>();
      const missingText: Chapter[] = [];
      const missingAudio: Chapter[] = [];

      for (const ch of chapters) {
        const txtName = buildTextName(book.id, ch.id);
        const mp3Name = buildMp3Name(book.id, ch.id);

        expectedNames.add(txtName);
        expectedNames.add(mp3Name);

        if (!byName.has(txtName)) missingText.push(ch);
        if (!byName.has(mp3Name)) missingAudio.push(ch);
      }

      // Anything in Drive folder not expected is stray
      // STRICT CHECK: Legacy files (e.g. "Chapter 1.txt") are NOT in expectedNames, so they are stray.
      const strayFiles = driveFiles.filter(f => {
        if (!f?.name) return false;
        if (expectedNames.has(f.name)) return false;

        // ignore common stuff
        if (f.name === ".keep" || f.name === "cover.jpg" || f.name === "manifest.json" || f.name.startsWith('_')) return false;

        return true;
      });

      const scan: ScanResult = {
        missingTextIds: missingText.map(c => c.id),
        missingAudioIds: missingAudio.map(c => c.id),
        strayFiles: strayFiles,
        duplicates: [],
        totalChecked: chapters.length
      };

      setLastScan(scan);
      setMissingTextIds(scan.missingTextIds);
      setMissingAudioIds(scan.missingAudioIds);
      return scan;
    } catch (e: any) {
      pushNotice("Integrity check failed: " + (e?.message || String(e)), 'error', 6000);
      return null;
    } finally {
      setIsCheckingDrive(false);
    }
  }, [driveFolderId, book.id, chapters, pushNotice]);

  const handleCheckLocalIntegrity = useCallback(async (): Promise<ScanResult | null> => {
    setIsCheckingDrive(true);
    try {
      const scan: ScanResult = {
        missingTextIds: [],
        missingAudioIds: [],
        strayFiles: [],
        duplicates: [],
        totalChecked: chapters.length
      };

      for (const chapter of chapters) {
        const text =
          (chapter.content && chapter.content.trim() ? chapter.content : null) ??
          (await libraryLoadChapterText(book.id, chapter.id)) ??
          "";

        if (!text.trim()) {
          scan.missingTextIds.push(chapter.id);
        }

        const signature = (chapter as any).audioSignature as string | undefined;
        const audioOk = signature ? await hasAudioInCache(signature) : false;

        if (!audioOk) {
          scan.missingAudioIds.push(chapter.id);
        }

        onUpdateChapter({
          ...chapter,
          audioStatus: audioOk ? AudioStatus.READY : AudioStatus.PENDING
        });
      }

      setLastScan(scan);
      setMissingTextIds(scan.missingTextIds);
      setMissingAudioIds(scan.missingAudioIds);

      return scan;
    } catch (e: any) {
      pushNotice("Integrity check failed: " + (e?.message || String(e)), "error", 6000);
      return null;
    } finally {
      setIsCheckingDrive(false);
    }
  }, [chapters, book.id, onUpdateChapter, pushNotice]);

  const handleCheckIntegrity = useCallback(async () => {
    const scan =
      book.backend === StorageBackend.DRIVE
        ? await handleCheckDriveIntegrity()
        : await handleCheckLocalIntegrity();

    if (!scan) return;

    const missingText = scan.missingTextIds.length;
    const missingAudio = scan.missingAudioIds.length;
    const strays = scan.strayFiles.length;

    if (missingText || missingAudio || strays) {
      pushNotice(
        `Found issues: ${missingText} missing text, ${missingAudio} missing audio, ${strays} stray.`,
        "info",
        6000
      );
    } else {
      pushNotice("All good — nothing to fix.", "success", 2500);
    }
  }, [book.backend, handleCheckDriveIntegrity, handleCheckLocalIntegrity, pushNotice]);

  const generateAudio = async (chapter: Chapter, voiceIdOverride?: string): Promise<boolean> => {
    if (synthesizingId) return false;

    setSynthesizingId(chapter.id);
    setSynthesisProgress({ current: 0, total: 1, message: "Preparing text..." });

    try {
      const selectedVoiceId =
        voiceIdOverride ||
        book.settings.defaultVoiceId ||
        book.settings.selectedVoiceName ||
        "en-US-Standard-C";

      const rawContent =
        chapter.content ||
        (await libraryLoadChapterText(book.id, chapter.id)) ||
        "";

      if (!rawContent.trim()) {
        throw new Error("No chapter text found. Create or import text first.");
      }

      const allRules = [...(globalRules || []), ...(book.rules || [])];

      let textToSpeak = applyRules(rawContent, allRules);
      if (reflowLineBreaksEnabled) textToSpeak = reflowLineBreaks(textToSpeak);

      const rawIntro = `Chapter ${chapter.index}. ${chapter.title}. `;
      const introText = applyRules(rawIntro, allRules);

      const fullText = introText + textToSpeak;
      const cacheKey = generateAudioKey(fullText, selectedVoiceId, 1.0);

      let audioBlob = await getAudioFromCache(cacheKey);

      if (!audioBlob) {
        setSynthesisProgress({ current: 0, total: 1, message: "Synthesizing audio..." });

        const res = await synthesizeChunk(fullText, selectedVoiceId, 1.0);
        
        // Replace the Blob construction with an ArrayBuffer-backed copy for TS compatibility.
        const mp3Bytes = res.mp3Bytes instanceof Uint8Array ? res.mp3Bytes : new Uint8Array(res.mp3Bytes as any);

        // Copy into a fresh Uint8Array so its buffer is a real ArrayBuffer (not ArrayBufferLike / SharedArrayBuffer)
        const mp3Copy = new Uint8Array(mp3Bytes);

        audioBlob = new Blob([mp3Copy], { type: "audio/mpeg" });

        await saveAudioToCache(cacheKey, audioBlob);
      }

      onUpdateChapter({
        ...chapter,
        audioStatus: AudioStatus.READY,
        audioSignature: cacheKey,
        audioPrefixLen: introText.length,
        hasCachedAudio: true,
        updatedAt: Date.now(),
      });

      if (book.backend === StorageBackend.DRIVE && driveFolderId) {
        setSynthesisProgress({ current: 0, total: 1, message: "Uploading to Drive..." });

        const filename = buildMp3Name(book.id, chapter.id);

        const cloudAudioFileId = await uploadToDrive(
          driveFolderId,
          filename,
          audioBlob,
          chapter.cloudAudioFileId,
          "audio/mpeg"
        );

        onUpdateChapter({
          ...chapter,
          cloudAudioFileId,
          audioStatus: AudioStatus.READY,
          audioSignature: cacheKey,
          audioPrefixLen: introText.length,
          hasCachedAudio: true,
          updatedAt: Date.now(),
        });
      }
      return true;
    } catch (err: any) {
      console.error("[TaleVox] generateAudio failed", err);

      onUpdateChapter({
        ...chapter,
        audioStatus: AudioStatus.FAILED,
        updatedAt: Date.now(),
      });

      alert(err?.message || "Audio generation failed");
      return false;
    } finally {
      setSynthesizingId(null);
      setSynthesisProgress(null);
    }
  };

  const handleRunFix = async () => {
    setIsFixing(true);
    abortFixRef.current = false;
    setFixLog([]);
    let errorCount = 0;

    const totalSteps = 
      (fixOptions.restoreText ? missingTextIds.length : 0) + 
      (fixOptions.genAudio ? missingAudioIds.length : 0) + 
      (fixOptions.cleanupStrays && lastScan?.strayFiles ? lastScan.strayFiles.length : 0);
    
    setFixProgress({ current: 0, total: totalSteps });

    try {
      if (book.backend !== StorageBackend.DRIVE) {
        const targets = new Set<string>([...missingAudioIds]);

        if (fixOptions.genAudio && targets.size) {
          for (const chapterId of targets) {
            if (abortFixRef.current) break;
            const ch = chapters.find(c => c.id === chapterId);
            if (!ch) continue;
            setFixLog(prev => [...prev, `Generate audio: ${ch.title}`]);
            await generateAudio(ch);
            setFixProgress(p => ({ ...p, current: p.current + 1 }));
          }
        }
        pushNotice("Fix complete.", "success", 3500);
        setLastScan(null);
        return;
      }

      if (!driveFolderId) {
        pushNotice("Drive folder not set.", "error");
        return;
      }

      const chaptersById = new Map(chapters.map((c) => [c.id, c]));

      // 1. Restore Missing Text
      if (fixOptions.restoreText && missingTextIds.length) {
        for (const chapterId of missingTextIds) {
          if (abortFixRef.current) break;
          const ch = chaptersById.get(chapterId);
          if (!ch) continue;

          const text = (ch.content && ch.content.trim() ? ch.content : null) ?? (await libraryLoadChapterText(book.id, ch.id)) ?? "";
          if (!text.trim()) {
              setFixLog(p => [...p, `Skipping text restore for ${ch.title} (no local content)`]);
              errorCount++;
              continue;
          }

          const filename = buildTextName(book.id, ch.id);
          setFixLog((prev) => [...prev, `Uploading missing text: ${filename}`]);

          try {
            const cloudTextFileId = await uploadToDrive(driveFolderId, filename, text, undefined, "text/plain");
            onUpdateChapter({ ...ch, cloudTextFileId, hasTextOnDrive: true, updatedAt: Date.now() });
          } catch (e) {
            errorCount++;
            setFixLog(p => [...p, `Failed to upload text: ${filename}`]);
          }
          setFixProgress(p => ({ ...p, current: p.current + 1 }));
        }
      }

      // 2. Generate Missing Audio
      if (fixOptions.genAudio && missingAudioIds.length) {
        for (const chapterId of missingAudioIds) {
          if (abortFixRef.current) break;
          const ch = chaptersById.get(chapterId);
          if (!ch) continue;
          setFixLog((prev) => [...prev, `Generating missing audio: ${ch.title}`]);
          const success = await generateAudio(ch);
          if (!success) errorCount++;
          setFixProgress(p => ({ ...p, current: p.current + 1 }));
        }
      }

      // 3. Cleanup stray files (only after replacements exist)
      if (fixOptions.cleanupStrays && lastScan?.strayFiles?.length) {
        if (abortFixRef.current) {
            setFixLog(p => [...p, "Cleanup aborted by user."]);
        } else if (errorCount > 0) {
            setFixLog(p => [...p, "SKIPPING CLEANUP: Errors occurred during restoration."]);
            pushNotice("Cleanup skipped for safety due to errors.", "error");
        } else {
            for (const stray of lastScan.strayFiles) {
              if (abortFixRef.current) break;
              setFixLog((prev) => [...prev, `Trashing stray file: ${stray.name}`]);
              try {
                  await moveFileToTrash(stray.id);
              } catch (e) {
                  setFixLog(p => [...p, `Failed to trash ${stray.name}`]);
              }
              setFixProgress(p => ({ ...p, current: p.current + 1 }));
            }
        }
      }

      if (abortFixRef.current) {
          pushNotice("Fix operation stopped.", "info");
      } else if (errorCount === 0) {
          pushNotice("Fix complete. Run CHECK again to verify.", "success");
          setLastScan(null);
          setMissingTextIds([]);
          setMissingAudioIds([]);
      }
    } catch (e: any) {
      pushNotice(`Fix failed: ${e?.message || e}`, "error", 6000);
    } finally {
      setIsFixing(false);
      abortFixRef.current = false;
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
    if (c.cloudAudioFileId || (c as any).audioDriveId || c.audioStatus === AudioStatus.READY) {
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
              <button
                disabled={synthesizingId === ch.id}
                onClick={() => {
                  setMobileMenuId(null);
                  setRememberAsDefault(true);
                  setShowVoiceModal({ chapterId: ch.id });
                }}
                className={`w-full flex items-center gap-4 p-4 rounded-2xl font-black text-sm transition-all ${
                  isDark ? 'hover:bg-white/5' : 'hover:bg-black/5'
                } ${synthesizingId === ch.id ? 'opacity-60' : ''}`}
              >
                <div className="p-2 bg-indigo-600/10 text-indigo-600 rounded-lg">
                  {synthesizingId === ch.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Headphones className="w-4 h-4" />}
                </div>
                {ch.cloudAudioFileId || ch.hasCachedAudio ? 'Regenerate Audio' : 'Generate Audio'}
              </button>

              <button onClick={() => { setMobileMenuId(null); onResetChapterProgress(book.id, ch.id); }} className={`w-full flex items-center gap-4 p-4 rounded-2xl font-black text-sm transition-all ${isDark ? 'hover:bg-white/5' : 'hover:bg-black/5'}`}>
                 <div className="p-2 bg-emerald-600/10 text-emerald-600 rounded-lg"><RefreshCw className="w-4 h-4" /></div>
                 Reset Progress
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
      <div className={`grid grid-cols-[40px_1fr_80px_100px] md:grid-cols-[40px_1fr_100px_180px] px-6 py-3 text-[10px] font-black uppercase tracking-widest border-b ${isDark ? 'border-slate-800 bg-slate-950/40 text-indigo-400' : 'border-black/5 bg-black/5 text-indigo-600'}`}>
        <div>Idx</div><div>Title</div><div className="text-right px-4">Progress</div><div className="text-right">Actions</div>
      </div>
      <div className="divide-y divide-black/5">
        {chapters.map(c => {
          const isCompleted = c.isCompleted || false;
          // Live progress logic: use snapshot if active chapter, else stored
          let percent = c.progress !== undefined ? Math.floor(c.progress * 100) : 0;
          if (playbackSnapshot && playbackSnapshot.chapterId === c.id) {
             percent = Math.floor(playbackSnapshot.percent * 100);
          }
          
          const isEditing = editingChapterId === c.id;

          return (
            <div key={c.id} onClick={() => !isEditing && onOpenChapter(c.id)} className={`grid grid-cols-[40px_1fr_80px_60px] md:grid-cols-[40px_1fr_100px_180px] items-center px-6 py-4 cursor-pointer border-b last:border-0 transition-colors ${isDark ? 'hover:bg-white/5 border-slate-800' : 'hover:bg-black/5 border-black/5'} ${isCompleted ? 'opacity-50' : ''}`}>
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
                  <span className="inline">{renderAudioStatusIcon(c)}</span>
                </div>
                <div className={`h-1 w-full rounded-full overflow-hidden ${isDark ? 'bg-slate-700' : 'bg-black/5'}`}>
                   <div className={`h-full transition-all duration-300 ${isCompleted ? 'bg-emerald-500' : 'bg-indigo-500'}`} style={{ width: `${percent}%` }} />
                </div>
              </div>
              <div className="text-right px-4">
                <span className={`text-[10px] font-black px-2 py-0.5 rounded-full ${isCompleted ? 'bg-emerald-500/20 text-emerald-600' : 'bg-indigo-500/15 text-indigo-500'}`}>{isCompleted ? 'Done' : `${percent}%`}</span>
              </div>
              <div className="flex justify-end items-center gap-2">
                <div className="hidden md:flex items-center gap-2">
                  <button onClick={(e) => { e.stopPropagation(); onResetChapterProgress(book.id, c.id); }} className="p-2 opacity-40 hover:opacity-100 hover:text-indigo-500" title="Reset Progress">
                      <RotateCcw className="w-4 h-4" />
                  </button>
                  <button onClick={(e) => { e.stopPropagation(); setRememberAsDefault(true); setShowVoiceModal({ chapterId: c.id }); }} className="p-2 opacity-40 hover:opacity-100" title="Regenerate Audio"><Headphones className="w-4 h-4" /></button>
                  <button onClick={(e) => { e.stopPropagation(); setEditingChapterId(c.id); setTempTitle(c.title); }} className="p-2 opacity-40 hover:opacity-100" title="Edit Title"><Edit2 className="w-4 h-4" /></button>
                  <button onClick={(e) => { e.stopPropagation(); if (confirm('Delete?')) onDeleteChapter(c.id); }} className="p-2 opacity-40 hover:opacity-100 hover:text-red-500" title="Delete"><Trash2 className="w-4 h-4" /></button>
                </div>
                <div className="md:hidden flex items-center gap-2">
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
        let percent = c.progress !== undefined ? Math.floor(c.progress * 100) : 0;
        if (playbackSnapshot && playbackSnapshot.chapterId === c.id) {
             percent = Math.floor(playbackSnapshot.percent * 100);
        }
        const isCompleted = c.isCompleted || false;
        return (
          <div key={c.id} onClick={() => onOpenChapter(c.id)} className={`flex flex-col gap-2 p-4 rounded-2xl border cursor-pointer transition-all hover:translate-x-1 ${cardBg}`}>
            <div className="flex items-center gap-4">
              <div className={`w-8 h-8 rounded-lg flex items-center justify-center font-mono text-[10px] font-black ${isDark ? 'bg-slate-950 text-indigo-400' : 'bg-indigo-50 text-indigo-600'}`}>{c.index}</div>
              <div className="flex-1 min-w-0 font-black text-sm truncate flex items-center">{c.title}{renderTextStatusIcon(c)}</div>
              <div className="flex items-center gap-3">
                <span className="text-[9px] font-black opacity-40 uppercase">{percent}%</span>
                {renderAudioStatusIcon(c)}
                <div className="flex md:hidden gap-1 items-center">
                  <button onClick={(e) => { e.stopPropagation(); setMobileMenuId(c.id); }} className="p-1.5 opacity-40">
                    <GearIcon className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            </div>
            <div className={`h-0.5 w-full rounded-full overflow-hidden ${isDark ? 'bg-slate-700' : 'bg-black/5'}`}>
               <div className="h-full bg-indigo-500 transition-all duration-300" style={{ width: `${percent}%` }} />
            </div>
          </div>
        );
      })}
      {hasMoreChapters && (
        <div ref={loadMoreSentinelRef} className={`py-4 text-center text-xs ${subtleText}`}>
          {isLoadingMoreChapters ? 'Loading more…' : 'Scroll to load more'}
        </div>
      )}
    </div>
  );

  const renderGridView = () => (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
      {chapters.map(c => {
        let percent = c.progress !== undefined ? Math.floor(c.progress * 100) : 0;
        if (playbackSnapshot && playbackSnapshot.chapterId === c.id) {
             percent = Math.floor(playbackSnapshot.percent * 100);
        }
        const isCompleted = c.isCompleted || false;
        return (
          <div key={c.id} onClick={() => onOpenChapter(c.id)} className={`aspect-square p-4 rounded-3xl border flex flex-col items-center justify-center text-center gap-2 cursor-pointer transition-all hover:scale-105 group relative ${cardBg}`}>
            <div className="absolute top-3 right-3 flex gap-1">{renderTextStatusIcon(c)}{renderAudioStatusIcon(c)}</div>
            <div className={`w-12 h-12 rounded-2xl flex items-center justify-center font-mono text-lg font-black mb-1 ${isDark ? 'bg-slate-950 text-indigo-400' : 'bg-indigo-50 text-indigo-600'}`}>{c.index}</div>
            <div className="font-black text-xs line-clamp-2 leading-tight px-1">{c.title}</div>
            <div className="mt-2 w-full px-4">
               <div className={`h-1 w-full rounded-full overflow-hidden ${isDark ? 'bg-slate-700' : 'bg-black/5'}`}><div className="h-full bg-indigo-500 transition-all duration-300" style={{ width: `${percent}%` }} /></div>
               <div className="text-[8px] font-black uppercase mt-1">{percent}%</div>
            </div>
            <button onClick={(e) => { e.stopPropagation(); if (confirm('Delete?')) onDeleteChapter(c.id); }} className="hidden md:block absolute bottom-2 right-2 p-2 opacity-0 group-hover:opacity-100 text-red-500 transition-opacity"><Trash2 className="w-3.5 h-3.5" /></button>
            <div className="md:hidden absolute bottom-2 left-0 right-0 flex justify-center gap-2 px-2">
               <button onClick={(e) => { e.stopPropagation(); setMobileMenuId(c.id); }} className="p-2 bg-black/5 rounded-xl opacity-60">
                 <GearIcon className="w-3.5 h-3.5" />
               </button>
            </div>
          </div>
        );
      })}
      {hasMoreChapters && (
        <div ref={loadMoreSentinelRef} className={`py-4 text-center text-xs ${subtleText}`}>
          {isLoadingMoreChapters ? 'Loading more…' : 'Scroll to load more'}
        </div>
      )}
    </div>
  );

  const hasIssues =
    !!lastScan &&
    (lastScan.missingTextIds.length > 0 ||
      lastScan.missingAudioIds.length > 0 ||
      lastScan.strayFiles.length > 0);

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
             <div className="space-y-4"><label className="text-[10px] font-black uppercase tracking-widest opacity-60">Actions to Perform</label><div className="space-y-3"><label className="flex items-center gap-4 p-4 rounded-2xl border-2 border-black/5 cursor-pointer hover:bg-black/5 transition-colors"><input type="checkbox" className="w-5 h-5 accent-indigo-600" checked={fixOptions.restoreText} onChange={e => setFixOptions(o => ({...o, restoreText: e.target.checked}))} /><div><div className="text-sm font-black">Restore Missing Text</div><p className="text-[10px] opacity-60 uppercase font-bold">Re-upload local content to Drive</p></div></label><label className="flex items-center gap-4 p-4 rounded-2xl border-2 border-black/5 cursor-pointer hover:bg-black/5 transition-colors"><input type="checkbox" className="w-5 h-5 accent-indigo-600" checked={fixOptions.genAudio} onChange={e => setFixOptions(o => ({...o, genAudio: e.target.checked}))} /><div><div className="text-sm font-black">Generate Missing Audio</div><p className="text-[10px] opacity-60 uppercase font-bold">Synthesize and upload MP3s</p></div></label><label className="flex items-center gap-4 p-4 rounded-2xl border-2 border-black/5 cursor-pointer hover:bg-black/5 transition-colors"><input type="checkbox" className="w-5 h-5 accent-indigo-600" checked={fixOptions.cleanupStrays} onChange={e => setFixOptions(o => ({...o, cleanupStrays: e.target.checked}))} /><div><div className="text-sm font-black">Cleanup Book Folder</div><p className="text-[10px] opacity-60 uppercase font-bold">Move unrecognized files to trash</p></div></label></div></div>
             <div className="max-h-[25vh] overflow-y-auto border rounded-2xl p-4 bg-black/5 space-y-2"><span className="text-[10px] font-black uppercase opacity-40 sticky top-0 bg-inherit py-1">Detailed Breakdown</span>{fixOptions.restoreText && lastScan.missingTextIds.map(cid => (<div key={`txt-${cid}`} className="text-xs font-bold flex items-center gap-2 text-indigo-600"><Plus className="w-3 h-3" /> Re-upload: {chapters.find(c=>c.id===cid)?.title}</div>))}{fixOptions.genAudio && lastScan.missingAudioIds.map(cid => (<div key={`aud-${cid}`} className="text-xs font-bold flex items-center gap-2 text-amber-600"><Headphones className="w-3 h-3" /> Synthesize: {chapters.find(c=>c.id===cid)?.title}</div>))}{fixOptions.cleanupStrays && lastScan.strayFiles.map(f => (<div key={`stray-${f.id}`} className="text-xs font-bold flex items-center gap-2 text-red-600"><History className="w-3 h-3" /> Move to trash: {f.name}</div>))}</div>
             {isFixing ? (
               <div className="space-y-4 pt-4">
                 <div className="flex justify-between items-center"><span className="text-sm font-black">Restoring Integrity...</span><span className="text-xs font-mono font-black">{fixProgress.current} / {fixProgress.total}</span></div>
                 <div className="h-3 w-full bg-black/5 rounded-full overflow-hidden"><div className="h-full bg-indigo-600 transition-all duration-300" style={{ width: `${(fixProgress.current / fixProgress.total) * 100}%` }} /></div>
                 <button onClick={() => { abortFixRef.current = true; }} className="w-full py-3 mt-2 bg-red-500/10 text-red-600 rounded-xl font-black uppercase text-[10px] tracking-widest hover:bg-red-500/20">Stop Generation</button>
               </div>
             ) : (
               <div className="grid grid-cols-2 gap-4"><button onClick={() => setShowFixModal(false)} className="py-4 rounded-2xl font-black uppercase text-[10px] tracking-widest border-2 hover:bg-black/5">Cancel</button><button onClick={handleRunFix} className="py-4 bg-indigo-600 text-white rounded-2xl font-black uppercase text-[10px] tracking-widest shadow-xl hover:scale-[1.02] active:scale-95 transition-all">Start Fixing</button></div>
             )}
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
            <button onClick={handleCheckIntegrity} disabled={isCheckingDrive} className="flex-1 sm:flex-none px-4 py-2 sm:px-6 sm:py-3 bg-white text-indigo-600 border border-indigo-600/20 rounded-xl sm:rounded-2xl font-black uppercase text-[9px] sm:text-[10px] tracking-widest shadow-lg hover:bg-indigo-50 active:scale-95 transition-all flex items-center justify-center gap-2">{isCheckingDrive ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}{isCheckingDrive ? '...' : 'Check'}</button>
            <button
              disabled={!hasIssues}
              className={hasIssues ? "flex-1 sm:flex-none px-4 py-2 sm:px-6 sm:py-3 bg-orange-500 text-white rounded-xl sm:rounded-2xl font-black uppercase text-[9px] sm:text-[10px] tracking-widest shadow-xl hover:scale-105 active:scale-95 transition-all flex items-center justify-center gap-2" : "flex-1 sm:flex-none px-4 py-2 sm:px-6 sm:py-3 bg-orange-500/40 text-white/60 rounded-xl sm:rounded-2xl font-black uppercase text-[9px] sm:text-[10px] tracking-widest cursor-not-allowed flex items-center justify-center gap-2"}
              onClick={() => setShowFixModal(true)}
            >
              <Wrench className="w-3.5 h-3.5" /> FIX
            </button>
          </div>
        </div>
      </div>

      {notice && (
        <div className="px-4 sm:px-6">
          <div
            className={`mt-3 px-4 py-3 rounded-2xl text-xs font-black tracking-tight ${
              notice.kind === 'error'
                ? 'bg-red-600/10 text-red-700 border border-red-600/20'
                : notice.kind === 'success'
                ? 'bg-emerald-600/10 text-emerald-700 border border-emerald-600/20'
                : 'bg-indigo-600/10 text-indigo-700 border border-indigo-600/20'
            }`}
          >
            {notice.message}
          </div>
        </div>
      )}

      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto px-4 sm:px-6 py-6 sm:py-8">{chapters.length === 0 ? (<div className="p-12 text-center text-xs font-black opacity-30 uppercase">No chapters found</div>) : (<>{viewMode === 'details' && renderDetailsView()}{viewMode === 'list' && renderListView()}{viewMode === 'grid' && renderGridView()}</>)}</div>
    </div>
  );
};

export default ChapterFolderView;
