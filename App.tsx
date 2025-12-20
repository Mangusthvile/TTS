import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Book, Chapter, AppState, Theme, HighlightMode, StorageBackend, ReaderSettings, RuleType, Rule } from './types';
import Library from './components/Library';
import Reader from './components/Reader';
import Player from './components/Player';
import RuleManager from './components/RuleManager';
import Settings from './components/Settings';
import Extractor from './components/Extractor';
import ChapterFolderView from './components/ChapterFolderView';
import { speechController, applyRules } from './services/speechService';
import { authenticateDrive, fetchDriveFile, uploadToDrive, deleteDriveFile, findFileSync, listFilesInFolder, fetchDriveBinary } from './services/driveService';
import { saveChapterToFile, deleteChapterFile } from './services/fileService';
import { BookText, Zap, Sun, Coffee, Moon, X, Settings as SettingsIcon, Menu, RefreshCw, Loader2, Cloud, Volume2 } from 'lucide-react';

const SYNC_FILENAME = 'talevox_sync_manifest.json';

const App: React.FC = () => {
  const [state, setState] = useState<AppState>(() => {
    const saved = localStorage.getItem('talevox_pro_v2');
    const parsed = saved ? JSON.parse(saved) : {};
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
      currentOffset: parsed.lastSession?.bookId === parsed.activeBookId ? parsed.lastSession?.offset || 0 : 0,
      debugMode: parsed.debugMode || false,
      keepAwake: parsed.keepAwake ?? false,
      readerSettings: parsed.readerSettings || {
        fontFamily: "'Source Serif 4', serif",
        fontSizePx: 20,
        lineHeight: 1.8,
        paragraphSpacing: 1
      },
      driveToken: parsed.driveToken,
      googleClientId: parsed.googleClientId,
      lastSession: parsed.lastSession
    };
  });

  const [activeTab, setActiveTab] = useState<'reader' | 'rules' | 'settings'>('reader');
  const [isAddChapterOpen, setIsAddChapterOpen] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [activeChapterText, setActiveChapterText] = useState<string>('');
  const [isLoadingChapter, setIsLoadingChapter] = useState(false);
  const [isFetchingAudio, setIsFetchingAudio] = useState(false);
  const [transitionToast, setTransitionToast] = useState<{ number: number; title: string } | null>(null);
  const [sleepTimerSeconds, setSleepTimerSeconds] = useState<number | null>(null);
  const [stopAfterChapter, setStopAfterChapter] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);

  const [audioDuration, setAudioDuration] = useState(0);
  const [audioCurrentTime, setAudioCurrentTime] = useState(0);

  const stateRef = useRef(state);
  useEffect(() => { stateRef.current = state; }, [state]);

  const activeBook = state.books.find(b => b.id === state.activeBookId);

  const activeChapterMetadata = useMemo(() => {
    if (!activeBook || !activeBook.currentChapterId) return null;
    return activeBook.chapters.find(c => c.id === activeBook.currentChapterId) || null;
  }, [activeBook]);

  // Hook speechController fetching state to UI
  useEffect(() => {
    speechController.setFetchStateListener((fetching) => {
      setIsFetchingAudio(fetching);
    });
  }, []);

  const saveCurrentState = useCallback(() => {
    const s = stateRef.current;
    const { driveToken, books, ...rest } = s;
    const persistentBooks = books.map(({ directoryHandle, ...b }) => ({ ...b, directoryHandle: undefined }));
    const activeBook = books.find(b => b.id === s.activeBookId);
    
    localStorage.setItem('talevox_pro_v2', JSON.stringify({ 
      ...rest, 
      books: persistentBooks,
      lastSession: s.activeBookId && activeBook?.currentChapterId ? {
        bookId: s.activeBookId,
        chapterId: activeBook.currentChapterId,
        offset: s.currentOffset
      } : s.lastSession
    }));
  }, []);

  useEffect(() => { saveCurrentState(); }, [state, saveCurrentState]);

  useEffect(() => {
    const handleUnload = () => {
      if (speechController.isPaused) handlePause();
      saveCurrentState();
    };
    window.addEventListener('pagehide', handleUnload);
    window.addEventListener('visibilitychange', () => {
      if (document.hidden) saveCurrentState();
    });
    return () => window.removeEventListener('pagehide', handleUnload);
  }, [saveCurrentState]);

  const handlePause = useCallback(() => { 
    speechController.stop(); 
    setIsPlaying(false); 
  }, []);

  const handleUpdateChapter = useCallback((chapter: Chapter) => {
    if (!stateRef.current.activeBookId) return;
    setState(prev => ({
      ...prev,
      books: prev.books.map(b => b.id === stateRef.current.activeBookId ? {
        ...b,
        chapters: b.chapters.map(c => c.id === chapter.id ? chapter : c)
      } : b)
    }));
  }, []);

  const updateChapterProgress = useCallback((bookId: string, chapterId: string, offset: number, total: number, completed: boolean = false) => {
    setState(prev => ({
      ...prev,
      books: prev.books.map(b => b.id === bookId ? {
        ...b,
        chapters: b.chapters.map(c => c.id === chapterId ? { 
          ...c, 
          progress: offset, 
          progressTotalLength: total,
          isCompleted: completed || c.isCompleted
        } : c)
      } : b)
    }));
  }, []);

  const handleUpdateChapterTitle = useCallback((bookId: string, chapterId: string, newTitle: string) => {
    setState(prev => ({
      ...prev,
      books: prev.books.map(b => b.id === bookId ? {
        ...b,
        chapters: b.chapters.map(c => c.id === chapterId ? { ...c, title: newTitle } : c)
      } : b)
    }));
  }, []);

  const handleDeleteChapter = useCallback(async (bookId: string, chapterId: string) => {
    const book = stateRef.current.books.find(b => b.id === bookId);
    const chapter = book?.chapters.find(c => c.id === chapterId);
    if (!book || !chapter) return;

    if (!confirm(`Permanently delete "${chapter.title}"?`)) return;

    if (book.currentChapterId === chapterId) handlePause();

    setIsLoadingChapter(true);
    try {
      if (book.backend === StorageBackend.DRIVE && stateRef.current.driveToken && chapter.driveId) {
        await deleteDriveFile(stateRef.current.driveToken, chapter.driveId);
        if (chapter.audioDriveId) await deleteDriveFile(stateRef.current.driveToken, chapter.audioDriveId);
      } else if (book.backend === StorageBackend.LOCAL && book.directoryHandle) {
        await deleteChapterFile(book.directoryHandle, chapter.filename);
      }

      setState(prev => ({
        ...prev,
        books: prev.books.map(b => b.id === bookId ? {
          ...b,
          currentChapterId: b.currentChapterId === chapterId ? undefined : b.currentChapterId,
          chapters: b.chapters.filter(c => c.id !== chapterId)
        } : b)
      }));
    } catch (err) {
      alert("Deletion failed: " + (err instanceof Error ? err.message : 'Unknown error'));
    } finally {
      setIsLoadingChapter(false);
    }
  }, [handlePause]);

  const handleJumpToOffset = useCallback((offset: number) => {
    const finalPlaybackText = applyRules(activeChapterText, activeBook?.rules || []);
    const total = finalPlaybackText.length || 1;
    const boundedOffset = Math.min(Math.max(0, offset), total);
    
    if (isPlaying) {
      speechController.seekToOffset(boundedOffset);
    } else {
      setState(prev => ({ ...prev, currentOffset: boundedOffset }));
    }
    
    if (stateRef.current.activeBookId && activeBook?.currentChapterId) {
      updateChapterProgress(stateRef.current.activeBookId, activeBook.currentChapterId, boundedOffset, total, boundedOffset >= total * 0.98);
    }
  }, [isPlaying, activeBook, activeChapterText, updateChapterProgress]);

  const handleSync = useCallback(async (manual = false) => {
    if (!state.driveToken) return;
    setIsSyncing(true);
    try {
      const existingFileId = await findFileSync(state.driveToken, SYNC_FILENAME);
      let currentBooks = [...stateRef.current.books];
      let currentSettings = { ...stateRef.current.readerSettings };

      if (existingFileId) {
        const remoteDataRaw = await fetchDriveFile(state.driveToken, existingFileId);
        const remoteData = JSON.parse(remoteDataRaw);
        const remoteBooks: Book[] = remoteData.books || [];
        
        remoteBooks.forEach(rb => {
          const localIdx = currentBooks.findIndex(lb => lb.id === rb.id);
          if (localIdx === -1) {
            currentBooks.push({ ...rb, directoryHandle: undefined });
          } else {
            const localBook = currentBooks[localIdx];
            if (rb.chapters.length >= localBook.chapters.length) {
              currentBooks[localIdx] = {
                ...rb,
                directoryHandle: localBook.directoryHandle,
                backend: localBook.backend,
                driveFolderId: rb.driveFolderId || localBook.driveFolderId,
              };
            }
          }
        });
        currentSettings = { ...currentSettings, ...remoteData.readerSettings };
      }

      for (const book of currentBooks) {
        if (book.backend === StorageBackend.DRIVE && book.driveFolderId) {
          try {
            const files = await listFilesInFolder(state.driveToken, book.driveFolderId);
            book.chapters.forEach(chapter => {
              if (!chapter.audioDriveId) {
                const idxStr = chapter.index.toString().padStart(3, '0');
                const matchingAudio = files.find(f => f.name.startsWith(idxStr) && f.name.endsWith('.mp3'));
                if (matchingAudio) {
                  chapter.audioDriveId = matchingAudio.id;
                }
              }
            });
          } catch (e) {
            console.warn(`Failed to scan folder for book ${book.title}:`, e);
          }
        }
      }

      setState(prev => ({ ...prev, books: currentBooks, readerSettings: currentSettings }));
      const manifestContent = JSON.stringify({
        books: currentBooks.map(({ directoryHandle, ...b }) => b),
        readerSettings: currentSettings,
        updatedAt: new Date().toISOString()
      });
      await uploadToDrive(state.driveToken, null, SYNC_FILENAME, manifestContent, existingFileId || undefined, 'application/json');
      if (manual) alert("Cloud Sync Complete.");
    } catch (err) {
      console.error("Sync failed:", err);
    } finally {
      setIsSyncing(false);
    }
  }, [state.driveToken]);

  useEffect(() => { if (state.driveToken) handleSync(); }, [state.driveToken]);

  const loadChapterContent = useCallback(async (bookId: string, chapterId: string) => {
    const book = stateRef.current.books.find(b => b.id === bookId);
    const chapter = book?.chapters.find(c => c.id === chapterId);
    if (!book || !chapter) return;
    setIsLoadingChapter(true);
    try {
      let content = "";
      if (book.backend === StorageBackend.DRIVE && stateRef.current.driveToken) {
        content = await fetchDriveFile(stateRef.current.driveToken, chapter.driveId!);
      } else if (book.backend === StorageBackend.LOCAL && book.directoryHandle) {
        const fileHandle = await book.directoryHandle.getFileHandle(chapter.filename);
        content = await (await fileHandle.getFile()).text();
      } else content = chapter.content || "";
      setActiveChapterText(content);
      setState(prev => ({ ...prev, currentOffset: chapter.progress || 0 }));
    } catch (err) {
      alert(`Error loading chapter: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally { setIsLoadingChapter(false); }
  }, []);

  useEffect(() => {
    if (state.activeBookId && activeBook?.currentChapterId) loadChapterContent(state.activeBookId, activeBook.currentChapterId);
  }, [state.activeBookId, activeBook?.currentChapterId, loadChapterContent]);

  const handlePlay = useCallback(async () => {
    if (!activeBook || !activeChapterMetadata || isLoadingChapter) return;
    const finalPlaybackText = applyRules(activeChapterText, activeBook.rules);
    if (!finalPlaybackText) return;
    
    let audioBlob: Blob | undefined;
    
    // v2.5.2 Check if cloud audio exists and fetch it for direct playback
    if (activeBook.backend === StorageBackend.DRIVE && activeChapterMetadata.audioDriveId && state.driveToken) {
      setIsFetchingAudio(true);
      try {
        audioBlob = await fetchDriveBinary(state.driveToken, activeChapterMetadata.audioDriveId);
      } catch (err) {
        console.warn("Failed to fetch cloud audio, falling back to local synthesis:", err);
      } finally {
        setIsFetchingAudio(false);
      }
    }

    setIsPlaying(true);
    speechController.speak(
      finalPlaybackText, 
      (activeBook.settings.useBookSettings && activeBook.settings.selectedVoiceName) ? activeBook.settings.selectedVoiceName : state.selectedVoiceName || '', 
      (activeBook.settings.useBookSettings && activeBook.settings.playbackSpeed) ? activeBook.settings.playbackSpeed : state.playbackSpeed, 
      state.currentOffset,
      () => setIsPlaying(false),
      (meta) => { 
        setState(prev => ({ ...prev, currentOffset: meta.charOffset }));
        setAudioCurrentTime(meta.currentTime);
        setAudioDuration(meta.duration);
      },
      async () => {
        if (document.hidden) return null;
        const s = stateRef.current;
        const book = s.books.find(b => b.id === s.activeBookId);
        if (!book || stopAfterChapter || (sleepTimerSeconds !== null && sleepTimerSeconds <= 0)) return null;
        const currentIdx = book.chapters.findIndex(c => c.id === book.currentChapterId);
        if (currentIdx < book.chapters.length - 1) {
          const next = book.chapters[currentIdx + 1];
          setTransitionToast({ number: next.index, title: next.title });
          setTimeout(() => setTransitionToast(null), 3500);
          setState(prev => ({
            ...prev, 
            books: prev.books.map(b => b.id === book.id ? { ...b, currentChapterId: next.id } : b),
            currentOffset: 0
          }));
          return {
            announcementPrefix: `Chapter ${next.index}: ${next.title}. `,
            content: applyRules(next.content, book.rules),
            bookTitle: book.title, 
            chapterTitle: next.title
          };
        }
        return null;
      },
      audioBlob
    );
  }, [activeBook, activeChapterMetadata, isLoadingChapter, activeChapterText, state.selectedVoiceName, state.playbackSpeed, state.currentOffset, state.driveToken, stopAfterChapter, sleepTimerSeconds]);

  const handleAddBook = async (title: string, backend: StorageBackend, directoryHandle?: any, driveFolderId?: string, driveFolderName?: string) => {
    const newBook: Book = {
      id: crypto.randomUUID(),
      title,
      chapters: [],
      rules: [],
      backend,
      directoryHandle,
      driveFolderId,
      driveFolderName,
      settings: { useBookSettings: false, highlightMode: HighlightMode.WORD }
    };
    setState(prev => ({ ...prev, books: [...prev.books, newBook], activeBookId: newBook.id }));
  };

  const handleChapterExtracted = async (data: { title: string; content: string; url: string; index: number }) => {
    if (!activeBook) return;
    const newChapter: Chapter = {
      id: crypto.randomUUID(),
      title: data.title,
      content: data.content,
      index: data.index,
      wordCount: data.content.split(/\s+/).length,
      progress: 0,
      filename: `${data.index.toString().padStart(3, '0')}.txt`
    };

    let driveId: string | undefined;
    if (activeBook.backend === StorageBackend.DRIVE && state.driveToken) {
      driveId = await uploadToDrive(state.driveToken, activeBook.driveFolderId!, newChapter.filename, newChapter.content);
    } else if (activeBook.backend === StorageBackend.LOCAL && activeBook.directoryHandle) {
      await saveChapterToFile(activeBook.directoryHandle, newChapter);
    }

    setState(prev => ({
      ...prev,
      books: prev.books.map(b => b.id === prev.activeBookId ? {
        ...b,
        chapters: [...b.chapters, { ...newChapter, driveId }].sort((a, b) => a.index - b.index)
      } : b)
    }));
    setIsAddChapterOpen(false);
  };

  return (
    <div className={`flex flex-col h-screen overflow-hidden font-sans transition-colors duration-500 ${state.theme === Theme.DARK ? 'bg-slate-950 text-slate-100' : state.theme === Theme.SEPIA ? 'bg-[#f4ecd8] text-[#3c2f25]' : 'bg-white text-black'}`}>
      <div className="flex flex-1 overflow-hidden relative">
        <Library 
          isOpen={isSidebarOpen} onClose={() => setIsSidebarOpen(false)} books={state.books} activeBookId={state.activeBookId} lastSession={state.lastSession} 
          onSelectBook={(id) => { handlePause(); setState(p => ({ ...p, activeBookId: id, currentOffset: 0 })); setActiveTab('reader'); }} 
          onDeleteBook={id => setState(p => ({ ...p, books: p.books.filter(b => b.id !== id), activeBookId: p.activeBookId === id ? undefined : p.activeBookId }))} 
          onSelectChapter={(bid, cid, offset) => { handlePause(); setState(p => ({ ...p, activeBookId: bid, books: p.books.map(b => b.id === bid ? { ...b, currentChapterId: cid } : b), currentOffset: offset ?? 0 })); setActiveTab('reader'); setIsSidebarOpen(false); }} 
          onDeleteChapter={handleDeleteChapter} theme={state.theme} onAddBook={handleAddBook} googleClientId={state.googleClientId}
        />
        <main className={`flex-1 flex flex-col min-w-0 shadow-2xl relative transition-colors duration-500 ${state.theme === Theme.DARK ? 'bg-slate-900' : state.theme === Theme.SEPIA ? 'bg-[#efe6d5]' : 'bg-white'}`}>
          <header className={`h-16 border-b flex items-center justify-between px-4 lg:px-8 z-10 sticky top-0 transition-colors duration-300 ${state.theme === Theme.DARK ? 'border-slate-800 bg-slate-900/80 backdrop-blur-md' : state.theme === Theme.SEPIA ? 'border-[#d8ccb6] bg-[#efe6d5]/90 backdrop-blur-md' : 'border-black/5 bg-white/90 backdrop-blur-md'}`}>
            <div className="flex items-center gap-2 lg:gap-6"><button onClick={() => setIsSidebarOpen(true)} className="p-2 lg:hidden rounded-lg hover:bg-black/5 text-inherit"><Menu className="w-5 h-5" /></button>
              <nav className="flex items-center gap-6">
                <button onClick={() => setActiveTab('reader')} className={`flex items-center gap-2 h-16 border-b-2 transition-all font-black uppercase text-[10px] tracking-widest ${activeTab === 'reader' ? 'border-indigo-600 text-indigo-600' : 'border-transparent opacity-60 hover:opacity-100'}`}><BookText className="w-4 h-4" /> <span className="hidden sm:inline">Reader</span></button>
                <button onClick={() => setActiveTab('rules')} className={`flex items-center gap-2 h-16 border-b-2 transition-all font-black uppercase text-[10px] tracking-widest ${activeTab === 'rules' ? 'border-indigo-600 text-indigo-600' : 'border-transparent opacity-60 hover:opacity-100'}`}><Zap className="w-4 h-4" /> <span className="hidden sm:inline">Rules</span></button>
                <button onClick={() => setActiveTab('settings')} className={`flex items-center gap-2 h-16 border-b-2 transition-all font-black uppercase text-[10px] tracking-widest ${activeTab === 'settings' ? 'border-indigo-600 text-indigo-600' : 'border-transparent opacity-60 hover:opacity-100'}`}><SettingsIcon className="w-4 h-4" /> <span className="hidden sm:inline">Settings</span></button>
              </nav>
            </div>
            <div className="flex items-center gap-4">
              {state.driveToken && (
                <button onClick={() => handleSync(true)} className={`flex items-center gap-2 px-3 py-1.5 rounded-xl text-[9px] font-black uppercase tracking-widest transition-all ${isSyncing ? 'text-indigo-500 animate-pulse' : 'text-slate-400 hover:text-indigo-600'}`}>
                  <Cloud className="w-3.5 h-3.5" /> {isSyncing ? 'Syncing...' : 'Sync'}
                </button>
              )}
              <div className="flex items-center gap-1 p-1 rounded-xl bg-black/5">
                <button onClick={() => setState(p => ({ ...p, theme: Theme.LIGHT }))} className={`p-1.5 rounded-lg ${state.theme === Theme.LIGHT ? 'bg-white shadow-sm text-indigo-600' : 'opacity-60'}`}><Sun className="w-4 h-4" /></button>
                <button onClick={() => setState(p => ({ ...p, theme: Theme.SEPIA }))} className={`p-1.5 rounded-lg ${state.theme === Theme.SEPIA ? 'bg-[#f4ecd8] shadow-sm text-[#9c6644]' : 'opacity-60'}`}><Coffee className="w-4 h-4" /></button>
                <button onClick={() => setState(p => ({ ...p, theme: Theme.DARK }))} className={`p-1.5 rounded-lg ${state.theme === Theme.DARK ? 'bg-slate-800 shadow-sm text-indigo-400' : 'opacity-60'}`}><Moon className="w-5 h-5" /></button>
              </div>
            </div>
          </header>
          <div className="flex-1 overflow-y-auto relative">
             {isLoadingChapter && (<div className="absolute inset-0 flex items-center justify-center bg-inherit z-[5] animate-in fade-in duration-300"><div className="flex flex-col items-center gap-4"><Loader2 className="w-10 h-10 text-indigo-600 animate-spin" /><span className="text-xs font-black uppercase tracking-widest opacity-40">Processing...</span></div></div>)}
             {(isFetchingAudio || isLoadingChapter) && (<div className="absolute inset-0 flex items-center justify-center bg-inherit/60 z-30 animate-in fade-in duration-300 backdrop-blur-sm"><div className="flex flex-col items-center gap-4 bg-indigo-600 text-white p-8 rounded-3xl shadow-2xl"><Volume2 className="w-10 h-10 animate-bounce" /><span className="text-xs font-black uppercase tracking-widest">Loading Audio Data...</span></div></div>)}
             {isAddChapterOpen && (
               <div className="absolute inset-0 z-20 overflow-y-auto p-4 lg:p-12 animate-in slide-in-from-bottom-8 duration-500">
                  <div className="max-w-4xl mx-auto relative">
                    <button onClick={() => setIsAddChapterOpen(false)} className="absolute -top-4 -right-4 lg:-right-8 p-3 bg-white text-black shadow-2xl rounded-full z-30 hover:scale-110 active:scale-95 transition-transform"><X className="w-6 h-6" /></button>
                    <Extractor onChapterExtracted={handleChapterExtracted} suggestedIndex={activeBook?.chapters.length ? Math.max(...activeBook.chapters.map(c => c.index)) + 1 : 1} theme={state.theme} />
                  </div>
               </div>
             )}
             {activeTab === 'reader' ? (activeBook ? (activeBook.currentChapterId ? (<Reader chapter={activeChapterMetadata || null} rules={activeBook.rules} currentOffset={state.currentOffset} theme={state.theme} debugMode={state.debugMode} onToggleDebug={() => setState(p => ({ ...p, debugMode: !p.debugMode }))} onJumpToOffset={handleJumpToOffset} highlightMode={activeBook.settings.highlightMode} onBackToChapters={() => setState(p => ({ ...p, books: p.books.map(b => b.id === p.activeBookId ? { ...b, currentChapterId: undefined } : b) }))} onAddChapter={() => setIsAddChapterOpen(true)} readerSettings={state.readerSettings} />) : (<ChapterFolderView book={activeBook} theme={state.theme} onAddChapter={() => setIsAddChapterOpen(true)} onOpenChapter={(id) => setState(prev => ({ ...prev, books: prev.books.map(b => b.id === activeBook.id ? { ...b, currentChapterId: id } : b), currentOffset: 0 }))} onToggleFavorite={() => {}} onUpdateChapterTitle={(cid, nt) => handleUpdateChapterTitle(activeBook.id, cid, nt)} onDeleteChapter={(cid) => handleDeleteChapter(activeBook.id, cid)} onRefreshDriveFolder={() => {}} onUpdateChapter={handleUpdateChapter} driveToken={state.driveToken} />)) : (<div className="h-full flex flex-col items-center justify-center font-black tracking-widest text-lg opacity-40 uppercase">Select a book to begin</div>)) : activeTab === 'rules' ? (
               <RuleManager 
                 rules={activeBook?.rules || []} 
                 theme={state.theme} 
                 onAddRule={r => setState(p => ({ ...p, books: p.books.map(b => b.id === p.activeBookId ? { ...b, rules: [...b.rules, r] } : b) }))} 
                 onUpdateRule={r => setState(p => ({ ...p, books: p.books.map(b => b.id === p.activeBookId ? { ...b, rules: b.rules.map(old => old.id === r.id ? r : old) } : b) }))} 
                 onDeleteRule={id => setState(p => ({ ...p, books: p.books.map(b => b.id === p.activeBookId ? { ...b, rules: b.rules.filter(r => r.id !== id) } : b) }))} 
                 onImportRules={nr => setState(p => ({ ...p, books: p.books.map(b => b.id === p.activeBookId ? { ...b, rules: nr } : b) }))}
                 selectedVoice={(activeBook?.settings.useBookSettings && activeBook.settings.selectedVoiceName) ? activeBook.settings.selectedVoiceName : state.selectedVoiceName || ''}
                 playbackSpeed={(activeBook?.settings.useBookSettings && activeBook.settings.playbackSpeed) ? activeBook.settings.playbackSpeed : state.playbackSpeed}
               />
             ) : (<Settings settings={state.readerSettings} onUpdate={s => setState(p => ({ ...p, readerSettings: { ...p.readerSettings, ...s } }))} theme={state.theme} keepAwake={state.keepAwake} onSetKeepAwake={v => setState(p => ({ ...p, keepAwake: v }))} onCheckForUpdates={() => window.location.reload()} isCloudLinked={!!state.driveToken} onLinkCloud={async () => { const t = await authenticateDrive(state.googleClientId); setState(p => ({ ...p, driveToken: t })); }} onSyncNow={() => handleSync(true)} isSyncing={isSyncing} googleClientId={state.googleClientId} onUpdateGoogleClientId={id => setState(p => ({ ...p, googleClientId: id }))} onClearAuth={() => setState(p => ({ ...p, driveToken: undefined }))} />)}
          </div>
          {activeChapterMetadata && activeTab === 'reader' && (
            <Player 
              isPlaying={isPlaying} onPlay={handlePlay} onPause={handlePause} onStop={handlePause} onNext={() => {}} onPrev={() => {}} onSeek={d => handleJumpToOffset(state.currentOffset + d)}
              speed={(activeBook?.settings.useBookSettings && activeBook.settings.playbackSpeed) ? activeBook.settings.playbackSpeed : state.playbackSpeed} onSpeedChange={s => setState(prev => prev.books.find(b => b.id === prev.activeBookId)?.settings.useBookSettings ? { ...prev, books: prev.books.map(b => b.id === prev.activeBookId ? { ...b, settings: { ...b.settings, playbackSpeed: s } } : b) } : { ...prev, playbackSpeed: s })}
              selectedVoice={(activeBook?.settings.useBookSettings && activeBook.settings.selectedVoiceName) ? activeBook.settings.selectedVoiceName : state.selectedVoiceName || ''} onVoiceChange={v => setState(prev => prev.books.find(b => b.id === prev.activeBookId)?.settings.useBookSettings ? { ...prev, books: prev.books.map(b => b.id === prev.activeBookId ? { ...b, settings: { ...b.settings, selectedVoiceName: v } } : b) } : { ...prev, selectedVoiceName: v })}
              theme={state.theme} onThemeChange={() => {}} progress={state.currentOffset} totalLength={applyRules(activeChapterText, activeBook?.rules || []).length} wordCount={activeChapterMetadata.wordCount} onSeekToOffset={handleJumpToOffset}
              sleepTimer={sleepTimerSeconds} onSetSleepTimer={setSleepTimerSeconds} stopAfterChapter={stopAfterChapter} onSetStopAfterChapter={setStopAfterChapter}
              useBookSettings={activeBook?.settings.useBookSettings || false} onSetUseBookSettings={v => setState(p => ({ ...p, books: p.books.map(b => b.id === p.activeBookId ? { ...b, settings: { ...b.settings, useBookSettings: v } } : b) }))}
              highlightMode={activeBook?.settings.highlightMode || HighlightMode.WORD} onSetHighlightMode={m => setState(p => ({ ...p, books: p.books.map(b => b.id === b.id ? { ...b, settings: { ...b.settings, highlightMode: m } } : b) }))}
              playbackCurrentTime={audioCurrentTime} playbackDuration={audioDuration}
              isFetching={isFetchingAudio}
            />
          )}
        </main>
      </div>
      {transitionToast && (
        <div className="fixed bottom-32 left-1/2 -translate-x-1/2 z-[100] toast-animate">
          <div className="bg-indigo-600 text-white px-8 py-4 rounded-2xl shadow-2xl font-black text-sm flex items-center gap-4">
            <RefreshCw className="w-5 h-5 animate-spin" />
            Chapter {transitionToast.number}: {transitionToast.title}
          </div>
        </div>
      )}
    </div>
  );
};

export default App;