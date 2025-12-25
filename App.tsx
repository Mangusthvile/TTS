
import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Book, Chapter, AppState, Theme, HighlightMode, StorageBackend, RuleType, SavedSnapshot, AudioStatus, CLOUD_VOICES, ProgressStore, ProgressEntry } from './types';
import Library from './components/Library';
import Reader from './components/Reader';
import Player from './components/Player';
import RuleManager from './components/RuleManager';
import Settings from './components/Settings';
import Extractor from './components/Extractor';
import ChapterFolderView from './components/ChapterFolderView';
import ChapterSidebar from './components/ChapterSidebar';
import { speechController, applyRules, PROGRESS_STORE_V4 } from './services/speechService';
import { fetchDriveFile, fetchDriveBinary, uploadToDrive, buildMp3Name, listFilesInFolder, findFileSync, buildTextName, ensureRootStructure, ensureBookFolder, moveFile, openFolderPicker, STATE_FILENAME, runLibraryMigration } from './services/driveService';
import { initDriveAuth, getValidDriveToken, clearStoredToken, isTokenValid } from './services/driveAuth';
import { saveChapterToFile } from './services/fileService';
import { synthesizeChunk } from './services/cloudTtsService';
import { saveAudioToCache, getAudioFromCache, generateAudioKey } from './services/audioCache';
import { Sun, Coffee, Moon, X, Settings as SettingsIcon, Loader2, Save, Library as LibraryIcon, Zap, Menu, LogIn, RefreshCw, AlertCircle } from 'lucide-react';

const SNAPSHOT_KEY = "talevox_saved_snapshot_v1";
const APP_DATA_KEY = "talevox_pro_v2_7_7";

const App: React.FC = () => {
  const [state, setState] = useState<AppState>(() => {
    const saved = localStorage.getItem(APP_DATA_KEY);
    const parsed = saved ? JSON.parse(saved) : {};
    const progressStore = JSON.parse(localStorage.getItem(PROGRESS_STORE_V4) || '{}');

    return {
      books: (parsed.books || []).map((b: any) => ({
        ...b,
        directoryHandle: undefined,
        chapters: (b.chapters || []).map((c: any) => ({
          ...c,
          isCompleted: !!progressStore[b.id]?.[c.id]?.completed
        })),
        settings: b.settings || { useBookSettings: false, highlightMode: HighlightMode.WORD },
        rules: (b.rules || []).map((r: any) => ({
          ...r,
          ruleType: r.ruleType ?? RuleType.REPLACE
        }))
      })),
      activeBookId: parsed.activeBookId,
      playbackSpeed: parsed.playbackSpeed || 1.0,
      selectedVoiceName: parsed.selectedVoiceName,
      theme: parsed.theme || Theme.LIGHT,
      currentOffsetChars: 0,
      debugMode: parsed.debugMode || false,
      keepAwake: parsed.keepAwake ?? false,
      readerSettings: parsed.readerSettings || {
        fontFamily: "'Source Serif 4', serif",
        fontSizePx: 20,
        lineHeight: 1.8,
        paragraphSpacing: 1,
        highlightColor: '#4f46e5',
        followHighlight: true,
        updatedAt: Date.now()
      },
      googleClientId: parsed.googleClientId || (import.meta as any).env?.VITE_GOOGLE_CLIENT_ID || '',
      lastSession: parsed.lastSession,
      updatedAt: parsed.updatedAt || Date.now(),
      driveRootFolderId: parsed.driveRootFolderId,
      driveRootFolderName: parsed.driveRootFolderName,
      driveSubfolders: parsed.driveSubfolders
    };
  });

  const [activeTab, setActiveTab] = useState<'library' | 'collection' | 'reader' | 'rules' | 'settings'>('library');
  const [isAddChapterOpen, setIsAddChapterOpen] = useState(false);
  const [isChapterSidebarOpen, setIsChapterSidebarOpen] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [autoplayBlocked, setAutoplayBlocked] = useState(false);
  const [isLoadingChapter, setIsLoadingChapter] = useState(false);
  const [transitionToast, setTransitionToast] = useState<{ number: number; title: string; type?: 'info' | 'success' | 'error' | 'reconnect' } | null>(null);
  const [sleepTimerSeconds, setSleepTimerSeconds] = useState<number | null>(null);
  const [stopAfterChapter, setStopAfterChapter] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [audioDuration, setAudioDuration] = useState(0);
  const [audioCurrentTime, setAudioCurrentTime] = useState(0);
  const [isAuthorized, setIsAuthorized] = useState(isTokenValid());
  const [syncStatus, setSyncStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  const stateRef = useRef(state);
  useEffect(() => { stateRef.current = state; }, [state]);

  const autosaveTimerRef = useRef<number | null>(null);

  const activeBook = useMemo(() => state.books.find(b => b.id === state.activeBookId), [state.books, state.activeBookId]);
  const activeChapterMetadata = useMemo(() => activeBook?.chapters.find(c => c.id === activeBook.currentChapterId), [activeBook]);

  useEffect(() => {
    document.documentElement.style.setProperty('--highlight-color', state.readerSettings.highlightColor);
  }, [state.readerSettings.highlightColor]);

  useEffect(() => {
    if (state.googleClientId) initDriveAuth(state.googleClientId);
    const handleAuthEvent = () => setIsAuthorized(isTokenValid());
    window.addEventListener('talevox_auth_changed', handleAuthEvent);
    window.addEventListener('talevox_auth_invalid', handleAuthEvent);
    return () => {
      window.removeEventListener('talevox_auth_changed', handleAuthEvent);
      window.removeEventListener('talevox_auth_invalid', handleAuthEvent);
    };
  }, [state.googleClientId]);

  const showToast = (title: string, number = 0, type: 'info' | 'success' | 'error' | 'reconnect' = 'info') => {
    setTransitionToast({ number, title, type });
    if (type !== 'reconnect') setTimeout(() => setTransitionToast(null), 3500);
  };

  const mergeState = useCallback((local: AppState, remote: SavedSnapshot['state']): AppState => {
    const remoteProgress = remote.progressStore;
    const localProgress = JSON.parse(localStorage.getItem(PROGRESS_STORE_V4) || '{}') as ProgressStore;

    // Merge progress entries chapter by chapter
    const mergedProgress: ProgressStore = { ...localProgress };
    Object.keys(remoteProgress).forEach(bookId => {
      if (!mergedProgress[bookId]) {
        mergedProgress[bookId] = remoteProgress[bookId];
      } else {
        Object.keys(remoteProgress[bookId]).forEach(chapterId => {
          const remoteEntry = remoteProgress[bookId][chapterId];
          const localEntry = mergedProgress[bookId][chapterId];
          if (!localEntry || remoteEntry.updatedAt > localEntry.updatedAt) {
            mergedProgress[bookId][chapterId] = remoteEntry;
          }
        });
      }
    });
    localStorage.setItem(PROGRESS_STORE_V4, JSON.stringify(mergedProgress));

    // Merge books
    const mergedBooks = [...local.books];
    remote.books.forEach(rb => {
      const idx = mergedBooks.findIndex(lb => lb.id === rb.id);
      if (idx === -1) {
        mergedBooks.push(rb);
      } else {
        // Simple "remote wins" if updatedAt exists and is newer
        if ((rb.updatedAt || 0) > (mergedBooks[idx].updatedAt || 0)) {
          mergedBooks[idx] = { ...rb, directoryHandle: mergedBooks[idx].directoryHandle };
        }
      }
    });

    // Reader settings merge
    const mergedReaderSettings = (remote.readerSettings.updatedAt || 0) > (local.readerSettings.updatedAt || 0)
      ? remote.readerSettings : local.readerSettings;

    return {
      ...local,
      books: mergedBooks,
      readerSettings: mergedReaderSettings,
      updatedAt: Math.max(local.updatedAt, remote.updatedAt),
      driveRootFolderId: remote.driveRootFolderId || local.driveRootFolderId,
      driveRootFolderName: remote.driveRootFolderName || local.driveRootFolderName,
      driveSubfolders: remote.driveSubfolders || local.driveSubfolders
    };
  }, []);

  const handleSaveStateToCloud = useCallback(async () => {
    const s = stateRef.current;
    if (!isAuthorized || !s.driveSubfolders?.savesId) return;
    
    setSyncStatus('saving');
    try {
      const progressStore = JSON.parse(localStorage.getItem(PROGRESS_STORE_V4) || '{}');
      const snapshot: SavedSnapshot = {
        version: "v1",
        savedAt: Date.now(),
        state: { 
          books: s.books.map(({ directoryHandle, ...b }) => ({ ...b, directoryHandle: undefined })), 
          readerSettings: s.readerSettings, 
          activeBookId: s.activeBookId, 
          playbackSpeed: s.playbackSpeed, 
          selectedVoiceName: s.selectedVoiceName, 
          theme: s.theme, 
          progressStore,
          driveRootFolderId: s.driveRootFolderId,
          driveRootFolderName: s.driveRootFolderName,
          driveSubfolders: s.driveSubfolders,
          updatedAt: s.updatedAt
        }
      };

      const fileId = await findFileSync(STATE_FILENAME, s.driveSubfolders.savesId);
      await uploadToDrive(s.driveSubfolders.savesId, STATE_FILENAME, JSON.stringify(snapshot), fileId || undefined, 'application/json');
      setSyncStatus('saved');
    } catch (e) {
      setSyncStatus('error');
    }
  }, [isAuthorized]);

  // Debounced cloud save
  useEffect(() => {
    if (autosaveTimerRef.current) window.clearTimeout(autosaveTimerRef.current);
    autosaveTimerRef.current = window.setTimeout(() => {
      handleSaveStateToCloud();
    }, 2000);
    return () => { if (autosaveTimerRef.current) window.clearTimeout(autosaveTimerRef.current); };
  }, [state.books, state.readerSettings, state.playbackSpeed, state.theme, handleSaveStateToCloud]);

  const handleSyncFromCloud = useCallback(async (manual = false) => {
    const s = stateRef.current;
    if (!isAuthorized || !s.driveSubfolders?.savesId) {
      if (manual) showToast("Cloud setup required", 0, 'error');
      return;
    }
    setIsSyncing(true);
    try {
      const fileId = await findFileSync(STATE_FILENAME, s.driveSubfolders.savesId);
      if (fileId) {
        const remoteContent = await fetchDriveFile(fileId);
        const remoteSnapshot = JSON.parse(remoteContent) as SavedSnapshot;
        setState(prev => mergeState(prev, remoteSnapshot.state));
        if (manual) showToast("Sync Complete", 0, 'success');
      } else if (manual) {
        showToast("No cloud backup found", 0, 'info');
      }
    } catch (err) {
      if (manual) showToast("Sync Error", 0, 'error');
    } finally { setIsSyncing(false); }
  }, [isAuthorized, mergeState]);

  // Initial cloud load
  useEffect(() => {
    if (isAuthorized && state.driveSubfolders?.savesId) {
      handleSyncFromCloud();
    }
  }, [isAuthorized, state.driveSubfolders?.savesId, handleSyncFromCloud]);

  // Folder validation effect
  useEffect(() => {
    if (isAuthorized && state.driveRootFolderId && !state.driveSubfolders) {
      ensureRootStructure(state.driveRootFolderId).then(sub => {
        setState(p => ({ ...p, driveSubfolders: sub }));
      });
    }
  }, [isAuthorized, state.driveRootFolderId, state.driveSubfolders]);

  const handleSelectRoot = useCallback(async () => {
    try {
      const selected = await openFolderPicker();
      if (!selected) return;
      setIsSyncing(true);
      const sub = await ensureRootStructure(selected.id);
      setState(p => ({ ...p, driveRootFolderId: selected.id, driveRootFolderName: selected.name, driveSubfolders: sub, updatedAt: Date.now() }));
      showToast("Drive Root Linked", 0, 'success');
    } catch (e: any) {
      showToast(e.message, 0, 'error');
    } finally { setIsSyncing(false); }
  }, []);

  const handleRunMigration = useCallback(async () => {
    if (!state.driveRootFolderId) return;
    setIsSyncing(true);
    try {
        const result = await runLibraryMigration(state.driveRootFolderId);
        showToast(result.message, 0, 'success');
        // Re-initialize to ensure we're pointing to canonical folders
        const sub = await ensureRootStructure(state.driveRootFolderId);
        setState(p => ({ ...p, driveSubfolders: sub }));
    } catch(e) {
        showToast("Migration Failed", 0, 'error');
    } finally {
        setIsSyncing(false);
    }
  }, [state.driveRootFolderId]);

  const queueBackgroundTTS = useCallback(async (bookId: string, chapterId: string, customVoiceId?: string) => {
    const s = stateRef.current;
    const book = s.books.find(b => b.id === bookId);
    const chapter = book?.chapters.find(c => c.id === chapterId);
    if (!book || !chapter || chapter.audioStatus === AudioStatus.READY) return;

    const voice = customVoiceId || book.settings.defaultVoiceId || 'en-US-Standard-C';
    const rawIntro = `Chapter ${chapter.index}. ${chapter.title}. `;
    const fullText = applyRules(rawIntro + chapter.content, book.rules);
    const cacheKey = generateAudioKey(fullText, voice, 1.0);
    
    if (book.backend === StorageBackend.DRIVE && book.driveFolderId && isAuthorized) {
       const audioName = buildMp3Name(chapter.index, chapter.title);
       const driveId = await findFileSync(audioName, book.driveFolderId);
       if (driveId) {
          updateChapterAudio(bookId, chapterId, { audioStatus: AudioStatus.READY, cloudAudioFileId: driveId });
          return;
       }
    }

    const cached = await getAudioFromCache(cacheKey);
    if (cached) {
      if (book.backend === StorageBackend.DRIVE && book.driveFolderId && isAuthorized) {
         updateChapterAudio(bookId, chapterId, { audioStatus: AudioStatus.GENERATING });
         try {
           const audioName = buildMp3Name(chapter.index, chapter.title);
           const driveFileId = await uploadToDrive(book.driveFolderId, audioName, cached, undefined, 'audio/mpeg');
           updateChapterAudio(bookId, chapterId, { audioStatus: AudioStatus.READY, cloudAudioFileId: driveFileId, hasCachedAudio: true });
         } catch(e) { updateChapterAudio(bookId, chapterId, { audioStatus: AudioStatus.FAILED }); }
      } else { updateChapterAudio(bookId, chapterId, { audioStatus: AudioStatus.READY, hasCachedAudio: true }); }
      return;
    }

    updateChapterAudio(bookId, chapterId, { audioStatus: AudioStatus.GENERATING });
    try {
      const res = await synthesizeChunk(fullText, voice, 1.0);
      const fetchRes = await fetch(res.audioUrl);
      const audioBlob = await fetchRes.blob();
      await saveAudioToCache(cacheKey, audioBlob);
      let cloudId = undefined;
      if (book.backend === StorageBackend.DRIVE && book.driveFolderId && isAuthorized) {
         const audioName = buildMp3Name(chapter.index, chapter.title);
         cloudId = await uploadToDrive(book.driveFolderId, audioName, audioBlob, undefined, 'audio/mpeg');
      }
      updateChapterAudio(bookId, chapterId, { audioStatus: AudioStatus.READY, hasCachedAudio: true, cloudAudioFileId: cloudId, updatedAt: Date.now() });
    } catch (e) { updateChapterAudio(bookId, chapterId, { audioStatus: AudioStatus.FAILED }); }
  }, [isAuthorized]);

  const updateChapterAudio = (bookId: string, chapterId: string, updates: Partial<Chapter>) => {
    setState(prev => ({
      ...prev, books: prev.books.map(b => b.id === bookId ? { ...b, chapters: b.chapters.map(c => c.id === chapterId ? { ...c, ...updates } : c) } : b)
    }));
  };

  const handleChapterExtracted = useCallback(async (data: { 
    title: string; content: string; url: string; index: number; voiceId: string; setAsDefault: boolean;
  }) => {
    const s = stateRef.current;
    if (!s.activeBookId) return;
    const book = s.books.find(b => b.id === s.activeBookId);
    if (!book) return;

    if (data.setAsDefault) {
      setState(prev => ({ ...prev, books: prev.books.map(b => b.id === prev.activeBookId ? { ...b, settings: { ...b.settings, defaultVoiceId: data.voiceId, updatedAt: Date.now() } } : b) }));
    }

    const filename = buildTextName(data.index, data.title);
    let cloudTextId = undefined;
    if (book.backend === StorageBackend.DRIVE && book.driveFolderId && isAuthorized) {
      try { cloudTextId = await uploadToDrive(book.driveFolderId, filename, data.content, undefined, 'text/plain'); } catch (e) {}
    }

    const newChapter: Chapter = { id: crypto.randomUUID(), index: data.index, title: data.title, content: data.content, filename, wordCount: data.content.split(/\s+/).filter(Boolean).length, progress: 0, progressChars: 0, audioStatus: AudioStatus.PENDING, cloudTextFileId: cloudTextId, hasTextOnDrive: !!cloudTextId, updatedAt: Date.now() };
    setState(prev => ({ ...prev, updatedAt: Date.now(), books: prev.books.map(b => b.id === prev.activeBookId ? { ...b, updatedAt: Date.now(), chapters: [...b.chapters, newChapter].sort((a,b) => a.index-b.index), currentChapterId: b.currentChapterId || newChapter.id } : b) }));
    setIsAddChapterOpen(false);
    showToast("Chapter Saved", 0, 'success');
    queueBackgroundTTS(s.activeBookId, newChapter.id, data.voiceId);
  }, [queueBackgroundTTS, isAuthorized]);

  const handleNextChapter = useCallback(() => {
    const s = stateRef.current;
    const book = s.books.find(b => b.id === s.activeBookId);
    if (!book || !book.currentChapterId) return;
    const sorted = [...book.chapters].sort((a, b) => a.index - b.index);
    const idx = sorted.findIndex(c => c.id === book.currentChapterId);
    if (idx >= 0 && idx < sorted.length - 1) {
      const next = sorted[idx + 1];
      setState(p => ({ ...p, books: p.books.map(b => b.id === book.id ? { ...b, currentChapterId: next.id } : b), currentOffsetChars: 0 }));
    } else {
      setIsPlaying(false);
      showToast("End of book", 0, 'success');
    }
  }, []);

  const handlePlay = useCallback(async () => {
    const s = stateRef.current;
    const book = s.books.find(b => b.id === s.activeBookId);
    if (!book || !book.currentChapterId) return;
    const chapter = book.chapters.find(c => c.id === book.currentChapterId);
    if (!chapter) return;

    setIsPlaying(true);
    setAutoplayBlocked(false);
    const voice = book.settings.defaultVoiceId || 'en-US-Standard-C';
    const text = applyRules(chapter.content, book.rules);
    const speed = (book.settings.useBookSettings && book.settings.playbackSpeed) ? book.settings.playbackSpeed : s.playbackSpeed;

    const rawIntro = `Chapter ${chapter.index}. ${chapter.title}. `;
    const introText = applyRules(rawIntro, book.rules);
    const estimatedIntroDurSec = introText.length / 18; 

    try {
      const cacheKey = generateAudioKey(introText + text, voice, 1.0);
      let audioBlob = await getAudioFromCache(cacheKey);

      if (!audioBlob && chapter.cloudAudioFileId && isAuthorized) {
        try { audioBlob = await fetchDriveBinary(chapter.cloudAudioFileId); if (audioBlob) await saveAudioToCache(cacheKey, audioBlob); } catch(e) {}
      }

      if (audioBlob && audioBlob.size > 0) {
        const url = URL.createObjectURL(audioBlob);
        speechController.setContext({ bookId: book.id, chapterId: chapter.id });
        try {
          await speechController.loadAndPlayDriveFile('', 'LOCAL_ID', text.length, estimatedIntroDurSec, undefined, 0, speed, 
            () => { if (stopAfterChapter) setIsPlaying(false); else handleNextChapter(); },
            (meta) => { setAudioCurrentTime(meta.currentTime); setAudioDuration(meta.duration); setState(p => ({ ...p, currentOffsetChars: meta.charOffset })); },
            url
          );
        } catch (playErr: any) {
          if (playErr.name === 'NotAllowedError') {
             setAutoplayBlocked(true);
             setIsPlaying(false);
          }
        }
      } else {
        showToast("Generating audio...", 0, 'info');
        await queueBackgroundTTS(s.activeBookId!, chapter.id);
        setTimeout(() => handlePlay(), 1000);
      }
    } catch (e) { setIsPlaying(false); showToast("Playback error", 0, 'error'); }
  }, [queueBackgroundTTS, stopAfterChapter, handleNextChapter, isAuthorized]);

  useEffect(() => {
    if (isPlaying && activeBook?.currentChapterId) {
      handlePlay();
    }
  }, [activeBook?.currentChapterId, isPlaying, handlePlay]);

  const handlePause = () => { speechController.pause(); setIsPlaying(false); };
  const handleSeekToTime = (t: number) => speechController.seekToTime(t);
  const handleJumpToOffset = (o: number) => speechController.seekToOffset(o);

  const handleAddBook = async (title: string, backend: StorageBackend, directoryHandle?: any) => {
    const s = stateRef.current;
    let driveId = undefined;
    let driveName = undefined;
    if (backend === StorageBackend.DRIVE) {
      if (!s.driveSubfolders?.booksId) { showToast("Link Drive first", 0, 'error'); setActiveTab('settings'); return; }
      try {
        driveId = await ensureBookFolder(s.driveSubfolders.booksId, title);
        driveName = title;
      } catch (e) { showToast("Folder error", 0, 'error'); return; }
    }
    const bk: Book = { id: crypto.randomUUID(), title, chapters: [], rules: [], backend, directoryHandle, driveFolderId: driveId, driveFolderName: driveName, settings: { useBookSettings: false, highlightMode: HighlightMode.WORD }, updatedAt: Date.now() };
    setState(p => ({ ...p, books: [...p.books, bk], activeBookId: bk.id, updatedAt: Date.now() }));
    setActiveTab('collection');
  };

  const handleResetChapterProgress = useCallback(async (bookId: string, chapterId: string) => {
    const storeRaw = localStorage.getItem(PROGRESS_STORE_V4);
    const store = storeRaw ? JSON.parse(storeRaw) : {};
    if (store[bookId] && store[bookId][chapterId]) {
      store[bookId][chapterId] = { timeSec: 0, durationSec: store[bookId][chapterId].durationSec || 0, percent: 0, completed: false, updatedAt: Date.now() };
      localStorage.setItem(PROGRESS_STORE_V4, JSON.stringify(store));
    }
    if (state.activeBookId === bookId && activeBook?.currentChapterId === chapterId) {
      setState(p => ({ ...p, currentOffsetChars: 0 }));
    }
    window.dispatchEvent(new CustomEvent('talevox_progress_updated', { detail: { bookId, chapterId } }));
  }, [activeBook, state.activeBookId]);

  useEffect(() => {
    localStorage.setItem(APP_DATA_KEY, JSON.stringify({ ...state, books: state.books.map(({ directoryHandle, ...b }) => ({ ...b, directoryHandle: undefined })) }));
  }, [state]);

  const syncStatusLabel = useMemo(() => {
    if (syncStatus === 'saving') return 'Syncing...';
    if (syncStatus === 'saved') return 'Cloud Saved';
    if (syncStatus === 'error') return 'Sync Error';
    return isSyncing ? 'Refreshing...' : 'Cloud Idle';
  }, [syncStatus, isSyncing]);

  return (
    <div className={`flex flex-col h-screen overflow-hidden font-sans transition-colors duration-500 ${state.theme === Theme.DARK ? 'bg-slate-950 text-slate-100' : state.theme === Theme.SEPIA ? 'bg-[#f4ecd8] text-[#3c2f25]' : 'bg-white text-black'}`}>
      <header className={`h-16 border-b flex items-center justify-between px-4 lg:px-8 z-10 sticky top-0 transition-colors ${state.theme === Theme.DARK ? 'border-slate-800 bg-slate-900/80 backdrop-blur-md' : state.theme === Theme.SEPIA ? 'border-[#d8ccb6] bg-[#efe6d5]/90 backdrop-blur-md' : 'border-black/5 bg-white/90 backdrop-blur-md'}`}>
        <div className="flex items-center gap-4">
          {activeTab === 'reader' && (
            <button onClick={() => setIsChapterSidebarOpen(true)} className="p-2 lg:hidden rounded-lg hover:bg-black/5"><Menu className="w-5 h-5" /></button>
          )}
          <nav className="flex items-center gap-4 sm:gap-6">
            <button onClick={() => setActiveTab('library')} className={`flex items-center gap-2 h-16 border-b-2 font-black uppercase text-[10px] tracking-widest ${activeTab === 'library' || activeTab === 'collection' ? 'border-indigo-600 text-indigo-600' : 'border-transparent opacity-60'}`}><LibraryIcon className="w-4 h-4" /> <span className="hidden sm:inline">Library</span></button>
            <button onClick={() => setActiveTab('rules')} className={`flex items-center gap-2 h-16 border-b-2 font-black uppercase text-[10px] tracking-widest ${activeTab === 'rules' ? 'border-indigo-600 text-indigo-600' : 'border-transparent opacity-60'}`}><Zap className="w-4 h-4" /> <span className="hidden sm:inline">Rules</span></button>
            <button onClick={() => setActiveTab('settings')} className={`flex items-center gap-2 h-16 border-b-2 font-black uppercase text-[10px] tracking-widest ${activeTab === 'settings' ? 'border-indigo-600 text-indigo-600' : 'border-transparent opacity-60'}`}><SettingsIcon className="w-4 h-4" /> <span className="hidden sm:inline">Settings</span></button>
          </nav>
        </div>
        <div className="flex items-center gap-2 sm:gap-4">
          <div className="hidden md:flex items-center gap-1.5 mr-2 opacity-50">
             <div className={`w-1.5 h-1.5 rounded-full ${syncStatus === 'error' ? 'bg-red-500' : syncStatus === 'saving' || isSyncing ? 'bg-amber-500 animate-pulse' : 'bg-emerald-500'}`} />
             <span className="text-[9px] font-black uppercase tracking-tighter">{syncStatusLabel}</span>
          </div>
          {!isAuthorized ? (
            <button onClick={() => getValidDriveToken({ interactive: true })} className="flex items-center gap-2 px-3 py-2 bg-indigo-600 text-white rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-indigo-700 transition-all shadow-md"><LogIn className="w-3.5 h-3.5" /> <span className="hidden xs:inline">Sign In</span></button>
          ) : (
            <button onClick={() => handleSyncFromCloud(true)} disabled={isSyncing} className={`flex items-center gap-2 px-3 py-2 bg-indigo-600/10 text-indigo-600 rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-indigo-600/20 transition-all ${isSyncing ? 'animate-pulse' : ''}`}><RefreshCw className="w-3.5 h-3.5" /> <span className="hidden xs:inline">Refresh</span></button>
          )}
          <button onClick={() => handleSaveStateToCloud()} className={`p-2.5 rounded-xl bg-indigo-600/10 text-indigo-600 hover:bg-indigo-600/20 transition-all ${syncStatus === 'saving' ? 'animate-spin' : ''}`} title="Save to Drive"><Save className="w-4 h-4" /></button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto relative flex">
        {isLoadingChapter && <div className="absolute inset-0 flex items-center justify-center bg-inherit z-5"><Loader2 className="w-10 h-10 text-indigo-600 animate-spin" /></div>}
        {isAddChapterOpen && (
          <div className="absolute inset-0 z-[60] overflow-y-auto p-4 lg:p-12 backdrop-blur-md bg-black/10">
            <div className="max-w-4xl mx-auto relative">
              <button onClick={() => setIsAddChapterOpen(false)} className="absolute -top-4 -right-4 p-3 bg-white text-black shadow-2xl rounded-full hover:scale-110 active:scale-95 transition-transform z-10"><X className="w-6 h-6" /></button>
              <Extractor 
                onChapterExtracted={handleChapterExtracted} 
                suggestedIndex={activeBook?.chapters.length ? Math.max(...activeBook.chapters.map(c => c.index)) + 1 : 1} 
                theme={state.theme} 
                defaultVoiceId={activeBook?.settings.defaultVoiceId} 
              />
            </div>
          </div>
        )}
        
        {activeTab === 'reader' && activeBook && (
          <aside className="hidden lg:block w-72 border-r border-black/5 bg-black/5 overflow-y-auto">
             <ChapterSidebar 
               book={activeBook} theme={state.theme} onSelectChapter={(cid) => { setState(p => ({ ...p, books: p.books.map(b => b.id === activeBook.id ? { ...b, currentChapterId: cid } : b), currentOffsetChars: 0 })); }} 
               onClose={() => {}} isDrawer={false}
             />
          </aside>
        )}

        {isChapterSidebarOpen && activeBook && (
          <div className="fixed inset-0 z-[60] flex">
            <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setIsChapterSidebarOpen(false)} />
            <div className={`relative w-[85%] max-sm max-w-sm h-full shadow-2xl animate-in slide-in-from-left duration-300 ${state.theme === Theme.DARK ? 'bg-slate-900' : state.theme === Theme.SEPIA ? 'bg-[#efe6d5]' : 'bg-white'}`}>
              <ChapterSidebar 
                book={activeBook} theme={state.theme} onSelectChapter={(cid) => { setState(p => ({ ...p, books: p.books.map(b => b.id === activeBook.id ? { ...b, currentChapterId: cid } : b), currentOffsetChars: 0 })); setIsChapterSidebarOpen(false); }} 
                onClose={() => setIsChapterSidebarOpen(false)} isDrawer={true}
              />
            </div>
          </div>
        )}

        <div className="flex-1 min-w-0 h-full overflow-y-auto">
          {activeTab === 'library' && (
            <Library 
              books={state.books} activeBookId={state.activeBookId} lastSession={state.lastSession} 
              onSelectBook={id => { setState(p => ({ ...p, activeBookId: id })); setActiveTab('collection'); }} 
              onAddBook={handleAddBook}
              onDeleteBook={id => setState(p => ({ ...p, updatedAt: Date.now(), books: p.books.filter(b => b.id !== id) }))}
              onUpdateBook={book => setState(p => ({ ...p, updatedAt: Date.now(), books: p.books.map(b => b.id === book.id ? book : b) }))}
              onSelectChapter={(bid, cid) => { setState(p => ({ ...p, activeBookId: bid, books: p.books.map(b => b.id === bid ? { ...b, currentChapterId: cid } : b) })); setActiveTab('reader'); }}
              theme={state.theme}
            />
          )}
          
          {activeTab === 'collection' && activeBook && (
            <ChapterFolderView 
              book={activeBook} theme={state.theme} onAddChapter={() => setIsAddChapterOpen(true)}
              onOpenChapter={id => { setState(p => ({ ...p, books: p.books.map(b => b.id === activeBook.id ? { ...b, currentChapterId: id } : b) })); setActiveTab('reader'); }}
              onToggleFavorite={() => {}} onUpdateChapterTitle={(id, t) => setState(p => ({ ...p, updatedAt: Date.now(), books: p.books.map(b => b.id === activeBook.id ? { ...b, updatedAt: Date.now(), chapters: b.chapters.map(c => c.id === id ? { ...c, title: t, updatedAt: Date.now() } : c) } : b) }))}
              onDeleteChapter={id => setState(p => ({ ...p, updatedAt: Date.now(), books: p.books.map(b => b.id === activeBook.id ? { ...b, updatedAt: Date.now(), chapters: b.chapters.filter(c => c.id !== id) } : b) }))}
              onUpdateChapter={c => setState(prev => ({ ...prev, updatedAt: Date.now(), books: prev.books.map(b => b.id === activeBook.id ? { ...b, updatedAt: Date.now(), chapters: b.chapters.map(ch => ch.id === c.id ? { ...c, updatedAt: Date.now() } : ch) } : b) }))}
              onUpdateBookSettings={s => setState(p => ({ ...p, updatedAt: Date.now(), books: p.books.map(b => b.id === activeBook.id ? { ...b, updatedAt: Date.now(), settings: { ...b.settings, ...s, updatedAt: Date.now() } } : b) }))}
              onBackToLibrary={() => setActiveTab('library')}
              onResetChapterProgress={handleResetChapterProgress}
            />
          )}

          {activeTab === 'reader' && activeBook && activeChapterMetadata && (
            <Reader 
              chapter={activeChapterMetadata} rules={activeBook.rules} currentOffsetChars={state.currentOffsetChars} theme={state.theme}
              debugMode={state.debugMode} onToggleDebug={() => setState(p => ({ ...p, debugMode: !p.debugMode }))} onJumpToOffset={handleJumpToOffset}
              onBackToCollection={() => setActiveTab('collection')} onAddChapter={() => setIsAddChapterOpen(true)}
              highlightMode={activeBook.settings.highlightMode} readerSettings={state.readerSettings}
            />
          )}

          {activeTab === 'rules' && (
            <RuleManager 
              rules={activeBook?.rules || []} theme={state.theme} onAddRule={r => setState(p => ({ ...p, updatedAt: Date.now(), books: p.books.map(b => b.id === p.activeBookId ? { ...b, updatedAt: Date.now(), rules: [...b.rules, { ...r, updatedAt: Date.now() }] } : b) }))}
              onUpdateRule={r => setState(p => ({ ...p, updatedAt: Date.now(), books: p.books.map(b => b.id === p.activeBookId ? { ...b, updatedAt: Date.now(), rules: b.rules.map(o => o.id === r.id ? { ...r, updatedAt: Date.now() } : o) } : b) }))}
              onDeleteRule={id => setState(p => ({ ...p, updatedAt: Date.now(), books: p.books.map(b => b.id === p.activeBookId ? { ...b, updatedAt: Date.now(), rules: b.rules.filter(ru => ru.id !== id) } : b) }))}
              onImportRules={nr => setState(p => ({ ...p, updatedAt: Date.now(), books: p.books.map(b => b.id === p.activeBookId ? { ...b, updatedAt: Date.now(), rules: nr.map(r => ({ ...r, updatedAt: Date.now() })) } : b) }))}
              selectedVoice={state.selectedVoiceName || ''} playbackSpeed={state.playbackSpeed}
            />
          )}

          {activeTab === 'settings' && (
            <Settings 
              settings={state.readerSettings} onUpdate={s => setState(p => ({ ...p, readerSettings: { ...p.readerSettings, ...s, updatedAt: Date.now() } }))} theme={state.theme} 
              onSetTheme={t => setState(p => ({ ...p, theme: t }))}
              keepAwake={state.keepAwake} onSetKeepAwake={v => setState(p => ({ ...p, keepAwake: v }))} onCheckForUpdates={() => window.location.reload()}
              onLinkCloud={() => getValidDriveToken({ interactive: true })} onSyncNow={() => handleSyncFromCloud(true)}
              googleClientId={state.googleClientId} onUpdateGoogleClientId={id => setState(p => ({ ...p, googleClientId: id }))}
              onClearAuth={() => clearStoredToken()} onSaveState={() => handleSaveStateToCloud()} lastSavedAt={state.lastSavedAt}
              driveRootName={state.driveRootFolderName} onSelectRoot={handleSelectRoot} onRunMigration={handleRunMigration}
            />
          )}
        </div>
      </div>

      {activeChapterMetadata && activeTab === 'reader' && (
        <Player 
          isPlaying={isPlaying} onPlay={handlePlay} onPause={handlePause} onStop={() => setIsPlaying(false)} onNext={handleNextChapter} onPrev={() => {}} onSeek={d => handleJumpToOffset(state.currentOffsetChars + d)}
          speed={state.playbackSpeed} onSpeedChange={s => setState(p => ({ ...p, playbackSpeed: s, updatedAt: Date.now() }))} selectedVoice={''} onVoiceChange={() => {}} theme={state.theme} onThemeChange={() => {}}
          progressChars={state.currentOffsetChars} totalLengthChars={activeChapterMetadata.content.length} wordCount={activeChapterMetadata.wordCount} onSeekToOffset={handleJumpToOffset}
          sleepTimer={sleepTimerSeconds} onSetSleepTimer={setSleepTimerSeconds} stopAfterChapter={stopAfterChapter} onSetStopAfterChapter={setStopAfterChapter}
          useBookSettings={false} onSetUseBookSettings={() => {}} highlightMode={activeBook?.settings.highlightMode || HighlightMode.WORD} onSetHighlightMode={m => setState(p => ({ ...p, books: p.books.map(b => b.id === activeBook?.id ? { ...b, settings: { ...b.settings, highlightMode: m, updatedAt: Date.now() } } : b) }))}
          playbackCurrentTime={audioCurrentTime} playbackDuration={audioDuration} onSeekToTime={handleSeekToTime}
          autoplayBlocked={autoplayBlocked}
        />
      )}
      
      {transitionToast && (
        <div className={`fixed bottom-24 sm:bottom-32 left-1/2 -translate-x-1/2 z-[100] toast-animate`}>
          <div className={`${transitionToast.type === 'success' ? 'bg-emerald-600' : transitionToast.type === 'error' ? 'bg-red-600' : transitionToast.type === 'reconnect' ? 'bg-amber-600' : 'bg-indigo-600'} text-white px-8 py-4 rounded-2xl shadow-2xl font-black text-sm flex items-center gap-4`}>
            <span className="leading-tight">{transitionToast.number > 0 ? `Chapter ${transitionToast.number}: ${transitionToast.title}` : transitionToast.title}</span>
          </div>
        </div>
      )}
    </div>
  );
};

export default App;
