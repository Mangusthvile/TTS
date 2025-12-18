
import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Book, Chapter, AppState, Theme, HighlightMode, StorageBackend, ReaderSettings, RuleType } from './types';
import Library from './components/Library';
import Reader from './components/Reader';
import Player from './components/Player';
import RuleManager from './components/RuleManager';
import Settings from './components/Settings';
import Extractor from './components/Extractor';
import ChapterFolderView from './components/ChapterFolderView';
import { speechController, applyRules } from './services/speechService';
import { authenticateDrive, fetchDriveFile, uploadToDrive, createDriveFolder, findFileSync } from './services/driveService';
import { BookText, Zap, Sun, Coffee, Moon, X, Settings as SettingsIcon, Menu, RefreshCw, Loader2, Cloud } from 'lucide-react';

const SYNC_FILENAME = 'talevox_sync_manifest.json';
const STORAGE_KEY = 'talevox_pro_v2';
const SESSION_KEY = 'talevox_pro_v2_session';

const App: React.FC = () => {
  const [state, setState] = useState<AppState>(() => {
    let parsed: any = {};
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      parsed = saved ? JSON.parse(saved) : {};
    } catch (e) {
      parsed = {};
    }

    let storedSession: any = undefined;
    try {
      const sessionRaw = localStorage.getItem(SESSION_KEY);
      storedSession = sessionRaw ? JSON.parse(sessionRaw) : undefined;
    } catch (e) {
      storedSession = undefined;
    }

    const lastSession = storedSession || parsed.lastSession;
    return {
      books: (parsed.books || []).map((b: any) => ({
        ...b,
        directoryHandle: undefined,
        settings: b.settings || { useBookSettings: false, highlightMode: HighlightMode.WORD },
        rules: (b.rules || []).map((r: any) => ({
          ...r,
          matchCase: r.matchCase ?? (r.caseMode === 'EXACT'),
          matchExpression: r.matchExpression ?? false,
          ruleType: r.ruleType ?? RuleType.REPLACE
        }))
      })),
      activeBookId: parsed.activeBookId,
      playbackSpeed: parsed.playbackSpeed || 1.0,
      selectedVoiceName: parsed.selectedVoiceName,
      theme: parsed.theme || Theme.LIGHT,
      currentOffset: lastSession?.bookId === parsed.activeBookId ? lastSession?.offset || 0 : 0,
      debugMode: parsed.debugMode || false,
      keepAwake: parsed.keepAwake ?? false,
      readerSettings: parsed.readerSettings || {
        fontFamily: "'Source Serif 4', serif",
        fontSizePx: 20,
        lineHeight: 1.8,
        paragraphSpacing: 1
      },
      driveToken: parsed.driveToken,
      lastSession: lastSession
    };
  });

  const [activeTab, setActiveTab] = useState<'reader' | 'rules' | 'settings'>('reader');
  const [isAddChapterOpen, setIsAddChapterOpen] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [activeChapterText, setActiveChapterText] = useState<string>('');
  const [isLoadingChapter, setIsLoadingChapter] = useState(false);
  const [transitionToast, setTransitionToast] = useState<{ number: number; title: string } | null>(null);
  const [sleepTimerSeconds, setSleepTimerSeconds] = useState<number | null>(null);
  const [stopAfterChapter, setStopAfterChapter] = useState(false);
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);

  const stateRef = useRef(state);
  useEffect(() => { stateRef.current = state; }, [state]);

  const activeBook = useMemo(() => state.books.find(b => b.id === state.activeBookId), [state.books, state.activeBookId]);
  const activeChapterMetadata = useMemo(
    () => activeBook?.chapters.find(c => c.id === activeBook.currentChapterId),
    [activeBook]
  );

  const lastSession = useMemo(() => {
    if (state.activeBookId && activeBook?.currentChapterId) {
      return {
        bookId: state.activeBookId,
        chapterId: activeBook.currentChapterId,
        offset: state.currentOffset
      };
    }
    return state.lastSession;
  }, [state.activeBookId, activeBook?.currentChapterId, state.currentOffset, state.lastSession]);

  const wakeLockSentinel = useRef<any>(null);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      const stateToPersist = stateRef.current;
      const { books, ...rest } = stateToPersist;
      const persistentBooks = books.map(({ directoryHandle, ...b }) => {
        const chapters = (b.chapters || []).map((c: Chapter) => {
          if (b.backend === StorageBackend.DRIVE) return { ...c, content: "" };
          return c;
        });
        return { ...b, directoryHandle: undefined, chapters };
      });

      const currentBook = stateToPersist.books.find(b => b.id === stateToPersist.activeBookId);
      const computedLastSession = stateToPersist.activeBookId && currentBook?.currentChapterId
        ? {
            bookId: stateToPersist.activeBookId,
            chapterId: currentBook.currentChapterId,
            offset: stateToPersist.currentOffset
          }
        : stateToPersist.lastSession;

      const payload = { ...rest, books: persistentBooks, lastSession: computedLastSession };

      const write = () => {
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
        } catch (e) {}
      };

      if ('requestIdleCallback' in window) {
        try {
          (window as any).requestIdleCallback(write, { timeout: 1500 });
          return;
        } catch (e) {}
      }

      write();
    }, 800);

    return () => window.clearTimeout(timeout);
  }, [
    state.books,
    state.activeBookId,
    state.playbackSpeed,
    state.selectedVoiceName,
    state.theme,
    state.debugMode,
    state.keepAwake,
    state.readerSettings,
    state.driveToken
  ]);

  useEffect(() => {
    if (!lastSession) return;
    const timeout = window.setTimeout(() => {
      try {
        localStorage.setItem(SESSION_KEY, JSON.stringify(lastSession));
      } catch (e) {}
    }, 1200);
    return () => window.clearTimeout(timeout);
  }, [lastSession]);

  // Handle Cloud Syncing
  const handleSync = useCallback(async (manual = false) => {
    if (!state.driveToken) return;
    setIsSyncing(true);
    try {
      const existingFileId = await findFileSync(state.driveToken, SYNC_FILENAME);
      
      if (existingFileId) {
        const remoteDataRaw = await fetchDriveFile(state.driveToken, existingFileId);
        const remoteData = JSON.parse(remoteDataRaw);
        
        // Merge strategy: 
        // 1. Keep all remote books that aren't local
        // 2. Overwrite local metadata with remote if newer (simple ID match for now)
        setState(prev => {
          const mergedBooks = [...prev.books];
          remoteData.books.forEach((remoteBook: Book) => {
            const localIdx = mergedBooks.findIndex(b => b.id === remoteBook.id);
            if (localIdx === -1) {
              mergedBooks.push({ ...remoteBook, directoryHandle: undefined });
            } else {
              // Merge rules and settings but keep local directory handle
              mergedBooks[localIdx] = {
                ...remoteBook,
                directoryHandle: mergedBooks[localIdx].directoryHandle,
                backend: mergedBooks[localIdx].backend // Keep local backend type
              };
            }
          });
          return { ...prev, books: mergedBooks };
        });
      }

      // After pulling, push current state back to manifest
      const manifestContent = JSON.stringify({
        books: stateRef.current.books.map(({ directoryHandle, ...b }) => b),
        readerSettings: stateRef.current.readerSettings,
        updatedAt: new Date().toISOString()
      });

      await uploadToDrive(state.driveToken, null, SYNC_FILENAME, manifestContent, existingFileId || undefined);
      if (manual) alert("Cloud Sync Complete");
    } catch (err) {
      console.error("Sync failed:", err);
      if (err instanceof Error && err.message === 'UNAUTHORIZED') {
        setState(prev => ({ ...prev, driveToken: undefined }));
      }
    } finally {
      setIsSyncing(false);
    }
  }, [state.driveToken]);

  // Auto-sync on load
  useEffect(() => {
    if (state.driveToken) handleSync();
  }, [state.driveToken]);

  const handleLinkCloud = async () => {
    try {
      const token = await authenticateDrive();
      setState(prev => ({ ...prev, driveToken: token }));
      handleSync(true);
    } catch (err) {
      console.error("Cloud link failed", err);
    }
  };

  useEffect(() => {
    const handleWakeLock = async () => {
      if (isPlaying && state.keepAwake && 'wakeLock' in navigator && !wakeLockSentinel.current) {
        try { wakeLockSentinel.current = await (navigator as any).wakeLock.request('screen'); } catch (err) {}
      } else if ((!isPlaying || !state.keepAwake) && wakeLockSentinel.current) {
        try { await wakeLockSentinel.current.release(); wakeLockSentinel.current = null; } catch (err) {}
      }
    };
    handleWakeLock();
  }, [isPlaying, state.keepAwake]);

  const currentSpeed = (activeBook?.settings.useBookSettings && activeBook.settings.playbackSpeed) ? activeBook.settings.playbackSpeed : state.playbackSpeed;
  const currentVoice = (activeBook?.settings.useBookSettings && activeBook.settings.selectedVoiceName) ? activeBook.settings.selectedVoiceName : state.selectedVoiceName;

  const playbackText = useMemo(() => {
    if (!activeChapterText) return "";
    return applyRules(activeChapterText, activeBook?.rules || []);
  }, [activeChapterText, activeBook?.rules]);

  const pendingOffsetRef = useRef<number | null>(null);
  const offsetRafRef = useRef<number | null>(null);
  useEffect(() => {
    return () => {
      if (offsetRafRef.current !== null) cancelAnimationFrame(offsetRafRef.current);
    };
  }, []);

  const flushOffsetUpdate = useCallback(() => {
    offsetRafRef.current = null;
    const nextOffset = pendingOffsetRef.current;
    if (nextOffset === null) return;
    if (Math.abs(stateRef.current.currentOffset - nextOffset) >= 1) {
      setState(prev => ({ ...prev, currentOffset: nextOffset }));
    }
  }, []);

  const loadChapterContent = useCallback(async (bookId: string, chapterId: string) => {
    const book = state.books.find(b => b.id === bookId);
    const chapter = book?.chapters.find(c => c.id === chapterId);
    if (!book || !chapter) return;
    setIsLoadingChapter(true);
    try {
      let content = "";
      if (book.backend === StorageBackend.DRIVE && state.driveToken) {
        content = await fetchDriveFile(state.driveToken, chapter.driveId!);
      } else if (book.backend === StorageBackend.LOCAL && book.directoryHandle) {
        const fileHandle = await book.directoryHandle.getFileHandle(chapter.filename);
        content = await (await fileHandle.getFile()).text();
      } else {
        content = chapter.content || ""; 
      }
      setActiveChapterText(content);
    } catch (err) {
      console.error("Failed to load chapter:", err);
    } finally {
      setIsLoadingChapter(false);
    }
  }, [state.books, state.driveToken]);

  useEffect(() => {
    if (state.activeBookId && activeBook?.currentChapterId) {
      loadChapterContent(state.activeBookId, activeBook.currentChapterId);
    } else { setActiveChapterText(''); }
  }, [state.activeBookId, activeBook?.currentChapterId, loadChapterContent]);

  const handleAddBook = async (title: string, backend: StorageBackend, directoryHandle?: any) => {
    let driveFolderId = undefined;
    if (backend === StorageBackend.DRIVE) {
      try {
        const token = state.driveToken || await authenticateDrive();
        if (!state.driveToken) setState(prev => ({ ...prev, driveToken: token }));
        driveFolderId = await createDriveFolder(token, `Talevox - ${title}`);
      } catch (err) { return; }
    }
    const newBook: Book = {
      id: crypto.randomUUID(),
      title, backend, chapters: [], rules: [], directoryHandle, driveFolderId,
      settings: { useBookSettings: false, highlightMode: HighlightMode.WORD }
    };
    setState(prev => ({ ...prev, books: [...prev.books, newBook], activeBookId: newBook.id }));
    setIsAddChapterOpen(true);
    setIsSidebarOpen(false);
  };

  const handleSelectBook = useCallback((id: string) => {
    speechController.stop();
    setIsPlaying(false);
    setState(prev => ({
      ...prev,
      activeBookId: id,
      books: prev.books.map(b => b.id === id ? { ...b, currentChapterId: undefined } : b),
      currentOffset: 0
    }));
    setActiveTab('reader');
  }, []);

  const handleSelectChapter = useCallback(async (bookId: string, chapterId: string, offset?: number, isInternalTransition = false) => {
    if (!isInternalTransition) {
      speechController.stop();
      setIsPlaying(false);
    }
    
    setState(prev => ({
      ...prev, activeBookId: bookId,
      books: prev.books.map(b => b.id === bookId ? { ...b, currentChapterId: chapterId } : b),
      currentOffset: offset ?? 0
    }));
    setActiveTab('reader');
    setIsSidebarOpen(false);
  }, []);

  const handleChapterExtracted = async (data: { title: string; content: string; url: string; index: number }) => {
    if (!activeBook) return;
    const newChapter: Chapter = {
      id: crypto.randomUUID(), index: data.index, title: data.title, content: data.content,
      wordCount: data.content.trim().split(/\s+/).length, progress: 0,
      filename: `ch_${data.index}_${Date.now()}.txt`, sourceUrl: data.url
    };
    if (activeBook.backend === StorageBackend.DRIVE && state.driveToken) {
      newChapter.driveId = await uploadToDrive(state.driveToken, activeBook.driveFolderId!, newChapter.filename, data.content);
    } else if (activeBook.backend === StorageBackend.LOCAL && activeBook.directoryHandle) {
      const fileHandle = await activeBook.directoryHandle.getFileHandle(newChapter.filename, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(data.content);
      await writable.close();
    }
    setState(prev => ({
      ...prev, books: prev.books.map(b => b.id === activeBook.id ? { ...b, chapters: [...b.chapters, newChapter].sort((a, b) => a.index - b.index) } : b)
    }));
    setIsAddChapterOpen(false);
    handleSelectChapter(activeBook.id, newChapter.id, 0);
  };

  const handlePlay = useCallback(() => {
    if (!playbackText || !activeBook || !activeChapterMetadata || isLoadingChapter) return;
    setIsPlaying(true);
    speechController.speak(
      playbackText, currentVoice || '', currentSpeed, state.currentOffset,
      () => setIsPlaying(false),
      (offset) => { 
        pendingOffsetRef.current = offset;
        if (offsetRafRef.current === null) {
          offsetRafRef.current = requestAnimationFrame(flushOffsetUpdate);
        }
      },
      async () => {
        const s = stateRef.current;
        const book = s.books.find(b => b.id === s.activeBookId);
        if (!book || stopAfterChapter || (sleepTimerSeconds !== null && sleepTimerSeconds <= 0)) return null;
        
        const currentIdx = book.chapters.findIndex(c => c.id === book.currentChapterId);
        if (currentIdx < book.chapters.length - 1) {
          const next = book.chapters[currentIdx + 1];
          setTransitionToast({ number: next.index, title: next.title });
          setTimeout(() => setTransitionToast(null), 3500);
          await handleSelectChapter(book.id, next.id, 0, true);
          return {
            announcementPrefix: `Chapter ${next.index}: ${next.title}. `,
            content: applyRules(next.content, book.rules),
            bookTitle: book.title, 
            chapterTitle: next.title
          };
        }
        return null;
      },
      activeBook.title, activeChapterMetadata.title
    );
  }, [playbackText, currentVoice, currentSpeed, state.currentOffset, stopAfterChapter, sleepTimerSeconds, activeBook, activeChapterMetadata, isLoadingChapter, handleSelectChapter, flushOffsetUpdate]);

  const handlePause = useCallback(() => { speechController.stop(); setIsPlaying(false); }, []);

  useEffect(() => {
    let timer: number;
    if (isPlaying && sleepTimerSeconds !== null && sleepTimerSeconds > 0) {
      timer = window.setInterval(() => {
        setSleepTimerSeconds(prev => {
          if (prev === null || prev <= 0) {
            handlePause();
            return null;
          }
          return prev - 1;
        });
      }, 1000);
    }
    return () => clearInterval(timer);
  }, [isPlaying, sleepTimerSeconds, handlePause]);

  return (
    <div className={`flex flex-col h-screen overflow-hidden font-sans transition-colors duration-500 ${state.theme === Theme.DARK ? 'bg-slate-950 text-slate-100' : state.theme === Theme.SEPIA ? 'bg-[#f4ecd8] text-[#3c2f25]' : 'bg-white text-black'}`}>
      {updateAvailable && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[200] w-full max-w-sm px-4"><div className="bg-indigo-600 text-white p-4 rounded-2xl shadow-2xl flex items-center justify-between border border-white/20 backdrop-blur-md"><div className="flex items-center gap-3"><RefreshCw className="w-5 h-5 animate-spin" /><span className="font-bold text-sm">Update ready</span></div><button onClick={() => window.location.reload()} className="bg-white text-indigo-600 px-4 py-1.5 rounded-xl font-black text-xs">REFRESH</button></div></div>
      )}
      {transitionToast && (
        <div className="fixed top-24 left-1/2 -translate-x-1/2 z-[100] pointer-events-none">
          <div className="bg-indigo-600 text-white px-8 py-4 rounded-3xl shadow-2xl flex flex-col items-center gap-1 border border-white/20 backdrop-blur-md toast-animate">
            <div className="text-[10px] font-black uppercase tracking-[0.2em] opacity-80">Next Chapter</div>
            <div className="text-lg font-black leading-tight">Chapter {transitionToast.number}: {transitionToast.title}</div>
          </div>
        </div>
      )}
      <div className="flex flex-1 overflow-hidden relative">
        <Library isOpen={isSidebarOpen} onClose={() => setIsSidebarOpen(false)} books={state.books} activeBookId={state.activeBookId} lastSession={lastSession} onSelectBook={(id) => { handleSelectBook(id); setIsSidebarOpen(false); }} onDeleteBook={id => setState(p => ({ ...p, books: p.books.filter(b => b.id !== id) }))} onSelectChapter={handleSelectChapter} theme={state.theme} onAddBook={handleAddBook} />
        <main className={`flex-1 flex flex-col min-w-0 shadow-2xl relative transition-colors duration-500 ${state.theme === Theme.DARK ? 'bg-slate-900' : state.theme === Theme.SEPIA ? 'bg-[#efe6d5]' : 'bg-white'}`}>
          <header className={`h-16 border-b flex items-center justify-between px-4 lg:px-8 z-10 sticky top-0 transition-colors duration-300 ${state.theme === Theme.DARK ? 'border-slate-800 bg-slate-900/80 backdrop-blur-md' : state.theme === Theme.SEPIA ? 'border-[#d8ccb6] bg-[#efe6d5]/90 backdrop-blur-md' : 'border-black/5 bg-white/90 backdrop-blur-md'}`}>
            <div className="flex items-center gap-2 lg:gap-6"><button onClick={() => setIsSidebarOpen(true)} className="p-2 lg:hidden rounded-lg hover:bg-black/5 text-inherit"><Menu className="w-5 h-5" /></button>
              <nav className="flex items-center gap-6">
                <button onClick={() => setActiveTab('reader')} className={`flex items-center gap-2 h-16 border-b-2 transition-all font-black uppercase text-[10px] tracking-widest ${activeTab === 'reader' ? 'border-indigo-600 text-indigo-600' : 'border-transparent opacity-60 hover:opacity-100'}`}><BookText className="w-4 h-4" /> <span className="hidden sm:inline">Reader</span></button>
                <button onClick={() => setActiveTab('rules')} className={`flex items-center gap-2 h-16 border-b-2 transition-all font-black uppercase text-[10px] tracking-widest ${activeTab === 'rules' ? 'border-indigo-600 text-indigo-600' : 'border-transparent opacity-60 hover:opacity-100'}`}><Zap className="w-4 h-4" /> <span className="hidden sm:inline">Rules</span></button>
                <button onClick={() => setActiveTab('settings')} className={`flex items-center gap-2 h-16 border-b-2 transition-all font-black uppercase text-[10px] tracking-widest ${activeTab === 'settings' ? 'border-indigo-600 text-indigo-600' : 'border-transparent opacity-60 hover:opacity-100'}`}><SettingsIcon className="w-4 h-4" /> <span className="hidden sm:inline">Settings</span></button>
              </nav>
            </div>
            <div className="flex items-center gap-3"><div className="flex items-center gap-1 p-1 rounded-xl bg-black/5"><button onClick={() => setState(p => ({ ...p, theme: Theme.LIGHT }))} className={`p-1.5 rounded-lg ${state.theme === Theme.LIGHT ? 'bg-white shadow-sm text-indigo-600' : 'opacity-60'}`}><Sun className="w-4 h-4" /></button><button onClick={() => setState(p => ({ ...p, theme: Theme.SEPIA }))} className={`p-1.5 rounded-lg ${state.theme === Theme.SEPIA ? 'bg-[#f4ecd8] shadow-sm text-[#9c6644]' : 'opacity-60'}`}><Coffee className="w-4 h-4" /></button><button onClick={() => setState(p => ({ ...p, theme: Theme.DARK }))} className={`p-1.5 rounded-lg ${state.theme === Theme.DARK ? 'bg-slate-800 shadow-sm text-indigo-400' : 'opacity-60'}`}><Moon className="w-4 h-4" /></button></div></div>
          </header>
          <div className="flex-1 overflow-y-auto relative">
             {isLoadingChapter && (<div className="absolute inset-0 flex items-center justify-center bg-inherit z-[5] animate-in fade-in duration-300"><div className="flex flex-col items-center gap-4"><Loader2 className="w-10 h-10 text-indigo-600 animate-spin" /><span className="text-xs font-black uppercase tracking-widest opacity-40">Loading Content...</span></div></div>)}
             {activeTab === 'reader' ? (activeBook ? (activeBook.currentChapterId ? (<Reader chapter={activeChapterMetadata || null} chapterText={activeChapterText} rules={activeBook.rules} currentOffset={state.currentOffset} theme={state.theme} debugMode={state.debugMode} onToggleDebug={() => setState(p => ({ ...p, debugMode: !p.debugMode }))} onJumpToOffset={(off) => setState(p => ({ ...p, currentOffset: off }))} highlightMode={activeBook.settings.highlightMode} onBackToChapters={() => handleSelectBook(activeBook.id)} onAddChapter={() => setIsAddChapterOpen(true)} readerSettings={state.readerSettings} />) : (<ChapterFolderView book={activeBook} theme={state.theme} onAddChapter={() => setIsAddChapterOpen(true)} onOpenChapter={(id) => handleSelectChapter(activeBook.id, id)} onToggleFavorite={(id) => {}} />)) : (<div className="h-full flex flex-col items-center justify-center font-black tracking-widest text-lg opacity-40 uppercase">Select a book to begin</div>)) : activeTab === 'rules' ? (
               <RuleManager 
                 rules={activeBook?.rules || []} 
                 theme={state.theme} 
                 onAddRule={r => setState(p => ({ ...p, books: p.books.map(b => b.id === p.activeBookId ? { ...b, rules: [...b.rules, r] } : b) }))} 
                 onUpdateRule={r => setState(p => ({ ...p, books: p.books.map(b => b.id === p.activeBookId ? { ...b, rules: b.rules.map(old => old.id === r.id ? r : old) } : b) }))} 
                 onDeleteRule={id => setState(p => ({ ...p, books: p.books.map(b => b.id === p.activeBookId ? { ...b, rules: b.rules.filter(r => r.id !== id) } : b) }))} 
                 onImportRules={nr => setState(p => ({ ...p, books: p.books.map(b => b.id === p.activeBookId ? { ...b, rules: nr } : b) }))}
                 selectedVoice={currentVoice || ''}
                 playbackSpeed={currentSpeed}
               />
             ) : (<Settings settings={state.readerSettings} onUpdate={s => setState(p => ({ ...p, readerSettings: { ...p.readerSettings, ...s } }))} theme={state.theme} keepAwake={state.keepAwake} onSetKeepAwake={v => setState(p => ({ ...p, keepAwake: v }))} onCheckForUpdates={async () => { if ('serviceWorker' in navigator) { const reg = await navigator.serviceWorker.getRegistration(); if (reg) await reg.update(); } }} isCloudLinked={!!state.driveToken} onLinkCloud={handleLinkCloud} onSyncNow={() => handleSync(true)} isSyncing={isSyncing} />)}
          </div>
          {activeChapterMetadata && activeTab === 'reader' && (
            <Player 
              isPlaying={isPlaying} onPlay={handlePlay} onPause={handlePause} onStop={handlePause} onNext={() => {}} onPrev={() => {}} onSeek={d => setState(p => ({ ...p, currentOffset: p.currentOffset + d }))}
              speed={currentSpeed} onSpeedChange={v => { if (activeBook?.settings.useBookSettings) setState(p => ({ ...p, books: p.books.map(b => b.id === p.activeBookId ? { ...b, settings: { ...b.settings, playbackSpeed: v } } : b) })); else setState(p => ({ ...p, playbackSpeed: v })); }}
              selectedVoice={currentVoice || ''} onVoiceChange={v => { if (activeBook?.settings.useBookSettings) setState(p => ({ ...p, books: p.books.map(b => b.id === p.activeBookId ? { ...b, settings: { ...b.settings, selectedVoiceName: v } } : b) })); else setState(p => ({ ...p, selectedVoiceName: v })); }}
              theme={state.theme} onThemeChange={() => {}} progress={state.currentOffset} totalLength={playbackText.length} wordCount={activeChapterMetadata.wordCount} onSeekToOffset={o => setState(p => ({ ...p, currentOffset: o }))}
              sleepTimer={sleepTimerSeconds} onSetSleepTimer={setSleepTimerSeconds} stopAfterChapter={stopAfterChapter} onSetStopAfterChapter={setStopAfterChapter}
              useBookSettings={activeBook?.settings.useBookSettings || false} onSetUseBookSettings={v => setState(p => ({ ...p, books: p.books.map(b => b.id === p.activeBookId ? { ...b, settings: { ...b.settings, useBookSettings: v } } : b) }))}
              highlightMode={activeBook?.settings.highlightMode || HighlightMode.WORD} onSetHighlightMode={m => setState(p => ({ ...p, books: p.books.map(b => b.id === p.activeBookId ? { ...b, settings: { ...b.settings, highlightMode: m } } : b) }))}
            />
          )}
          {isAddChapterOpen && (<div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/80 backdrop-blur-md"><button onClick={() => setIsAddChapterOpen(false)} className="fixed top-8 right-8 z-[110] p-3 bg-white/10 text-white rounded-full"><X className="w-6 h-6" /></button><div className="w-full max-w-4xl max-h-[90vh] overflow-y-auto rounded-3xl shadow-2xl"><Extractor onChapterExtracted={handleChapterExtracted} suggestedIndex={activeBook?.chapters.length ? Math.max(...activeBook.chapters.map(c => c.index)) + 1 : 1} theme={state.theme} /></div></div>)}
        </main>
      </div>
    </div>
  );
};

export default App;
