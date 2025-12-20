
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
import { synthesizeChunk } from './services/cloudTtsService';
import { saveAudioToCache, generateAudioKey, getAudioFromCache } from './services/audioCache';
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

  const handlePause = useCallback(() => { 
    speechController.pause(); 
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

  // Fix: Implemented missing handleUpdateChapterTitle
  // Updates the title of a specific chapter within state
  const handleUpdateChapterTitle = useCallback((bookId: string, chapterId: string, newTitle: string) => {
    setState(prev => ({
      ...prev,
      books: prev.books.map(b => b.id === bookId ? {
        ...b,
        chapters: b.chapters.map(c => c.id === chapterId ? { ...c, title: newTitle } : c)
      } : b)
    }));
  }, []);

  // Fix: Implemented missing handleDeleteChapter to resolve signature mismatch and redundancy
  // Centralized chapter deletion logic with Drive cleanup and state updates
  const handleDeleteChapter = useCallback(async (bookId: string, chapterId: string) => {
    const book = stateRef.current.books.find(b => b.id === bookId);
    if (!book) return;
    
    if (confirm(`Delete chapter?`)) {
      if (book.backend === StorageBackend.DRIVE && stateRef.current.driveToken) {
        const ch = book.chapters.find(c => c.id === chapterId);
        if (ch?.driveId) {
          try {
            await deleteDriveFile(stateRef.current.driveToken, ch.driveId);
          } catch (e) {
            console.error("Failed to delete drive file", e);
          }
        }
      }
      
      setState(prev => ({
        ...prev,
        books: prev.books.map(b => b.id === bookId ? {
          ...b,
          chapters: b.chapters.filter(c => c.id !== chapterId),
          currentChapterId: b.currentChapterId === chapterId ? undefined : b.currentChapterId
        } : b)
      }));
    }
  }, []);

  const handleUpdateBookSettings = useCallback((settings: any) => {
     setState(prev => ({
        ...prev,
        books: prev.books.map(b => b.id === prev.activeBookId ? { ...b, settings: { ...b.settings, ...settings } } : b)
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

  const handleJumpToOffset = useCallback((offset: number) => {
    const text = applyRules(activeChapterText, activeBook?.rules || []);
    const boundedOffset = Math.min(Math.max(0, offset), text.length || 1);
    
    speechController.seekToOffset(boundedOffset);
    setState(prev => ({ ...prev, currentOffset: boundedOffset }));
    
    if (stateRef.current.activeBookId && activeBook?.currentChapterId) {
      updateChapterProgress(stateRef.current.activeBookId, activeBook.currentChapterId, boundedOffset, text.length, boundedOffset >= text.length * 0.98);
    }
  }, [activeBook, activeChapterText, updateChapterProgress]);

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

  const handleNextChapter = useCallback(async (auto = false) => {
    const book = stateRef.current.books.find(b => b.id === stateRef.current.activeBookId);
    if (!book) return;
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

      console.log("[Autoplay] Advancing to next chapter", { nextIdx: next.index, auto });
    } else {
      setIsPlaying(false);
    }
  }, []);

  const handlePlay = useCallback(async () => {
    const book = stateRef.current.books.find(b => b.id === stateRef.current.activeBookId);
    if (!book || !book.currentChapterId || !stateRef.current.driveToken) return;
    
    const chapter = book.chapters.find(c => c.id === book.currentChapterId);
    if (!chapter || !chapter.audioDriveId) {
       alert("This chapter has no audio generated yet.");
       setIsPlaying(false);
       return;
    }
    
    const text = applyRules(activeChapterText, book.rules);
    const speed = (book.settings.useBookSettings && book.settings.playbackSpeed) ? book.settings.playbackSpeed : stateRef.current.playbackSpeed;
    
    setIsPlaying(true);
    // Use offset ratio to estimate start time if not currently playing
    const estimatedTime = (stateRef.current.currentOffset / Math.max(1, text.length)) * audioDuration;

    try {
      await speechController.loadAndPlayDriveFile(
        stateRef.current.driveToken,
        chapter.audioDriveId,
        text.length,
        estimatedTime,
        speed,
        () => {
           console.log("[Autoplay] Chapter ended event received", { stopAfterChapter });
           updateChapterProgress(book.id, chapter.id, text.length, text.length, true);
           if (stopAfterChapter) {
             setIsPlaying(false);
           } else {
             handleNextChapter(true);
           }
        },
        (meta) => {
           setState(prev => ({ ...prev, currentOffset: meta.charOffset }));
           setAudioCurrentTime(meta.currentTime);
           setAudioDuration(meta.duration);
        }
      );
    } catch (err) {
      setIsPlaying(false);
      if (err instanceof Error && err.name === 'NotAllowedError') {
        setTransitionToast({ number: 0, title: "Tap Play to continue" });
      } else {
        console.error("Playback failed:", err);
      }
    }
  }, [activeChapterText, audioDuration, stopAfterChapter, handleNextChapter, updateChapterProgress]);

  // Restart playback when chapter ID changes during isPlaying (Autoplay)
  useEffect(() => {
     if (isPlaying && activeChapterMetadata?.audioDriveId && activeChapterText) {
        handlePlay();
     }
  }, [activeBook?.currentChapterId]);

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
    setActiveTab('reader');

    if (activeBook.settings.defaultVoiceId && state.driveToken && activeBook.backend === StorageBackend.DRIVE) {
       console.info("[Audio] Auto-generating chapter audio...");
       const MAX = 4800;
       const textChunks = [];
       const content = newChapter.content;
       for (let i = 0; i < content.length; i += MAX) { textChunks.push(content.substring(i, i + MAX)); }
       const blobs = [];
       for (const t of textChunks) {
          const res = await synthesizeChunk(t, activeBook.settings.defaultVoiceId, 1.0);
          blobs.push(await fetch(res.audioUrl).then(r => r.blob()));
       }
       const combined = new Blob(blobs, { type: 'audio/mpeg' });
       const adid = await uploadToDrive(state.driveToken, activeBook.driveFolderId!, `${newChapter.index.toString().padStart(3, '0')}.mp3`, combined, undefined, 'audio/mpeg');
       
       setState(prev => ({
          ...prev,
          books: prev.books.map(b => b.id === prev.activeBookId ? {
             ...b,
             chapters: b.chapters.map(c => c.id === newChapter.id ? { ...c, audioDriveId: adid } : c)
          } : b)
       }));
    }
  };

  return (
    <div className={`flex flex-col h-screen overflow-hidden font-sans transition-colors duration-500 ${state.theme === Theme.DARK ? 'bg-slate-950 text-slate-100' : state.theme === Theme.SEPIA ? 'bg-[#f4ecd8] text-[#3c2f25]' : 'bg-white text-black'}`}>
      <div className="flex flex-1 overflow-hidden relative">
        <Library 
          isOpen={isSidebarOpen} onClose={() => setIsSidebarOpen(false)} books={state.books} activeBookId={state.activeBookId} lastSession={state.lastSession} 
          onSelectBook={(id) => { 
            speechController.stop(); 
            setIsPlaying(false); 
            setState(p => ({ ...p, activeBookId: id, currentOffset: 0, books: p.books.map(b => b.id === id ? { ...b, currentChapterId: undefined } : b) })); 
            setActiveTab('reader'); 
          }} 
          onDeleteBook={id => setState(p => ({ ...p, books: p.books.filter(b => b.id !== id), activeBookId: p.activeBookId === id ? undefined : p.activeBookId }))} 
          onSelectChapter={(bid, cid, offset) => { 
            speechController.stop(); 
            setIsPlaying(false); 
            setState(p => ({ ...p, activeBookId: bid, books: p.books.map(b => b.id === bid ? { ...b, currentChapterId: cid } : b), currentOffset: offset ?? 0 })); 
            setActiveTab('reader'); 
            setIsSidebarOpen(false); 
          }} 
          // Fix: Passing handleDeleteChapter to Library's onDeleteChapter prop
          onDeleteChapter={handleDeleteChapter} 
          theme={state.theme} onAddBook={async (t, b, d, dfid, dfn) => {
            const newBook: Book = { id: crypto.randomUUID(), title: t, chapters: [], rules: [], backend: b, directoryHandle: d, driveFolderId: dfid, driveFolderName: dfn, settings: { useBookSettings: false, highlightMode: HighlightMode.WORD } };
            setState(prev => ({ ...prev, books: [...prev.books, newBook], activeBookId: newBook.id }));
          }} googleClientId={state.googleClientId}
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
             {activeTab === 'reader' ? (activeBook ? (activeBook.currentChapterId ? (<Reader chapter={activeChapterMetadata || null} rules={activeBook.rules} currentOffset={state.currentOffset} theme={state.theme} debugMode={state.debugMode} onToggleDebug={() => setState(p => ({ ...p, debugMode: !p.debugMode }))} onJumpToOffset={handleJumpToOffset} highlightMode={activeBook.settings.highlightMode} onBackToChapters={() => setState(p => ({ ...p, books: p.books.map(b => b.id === p.activeBookId ? { ...b, currentChapterId: undefined } : b) }))} onAddChapter={() => setIsAddChapterOpen(true)} readerSettings={state.readerSettings} />) : (<ChapterFolderView book={activeBook} theme={state.theme} onAddChapter={() => setIsAddChapterOpen(true)} onOpenChapter={(id) => setState(prev => ({ ...prev, books: prev.books.map(b => b.id === activeBook.id ? { ...b, currentChapterId: id } : b), currentOffset: 0 }))} onToggleFavorite={() => {}} 
             // Fix: correctly passing handleUpdateChapterTitle and handleDeleteChapter with activeBook scoping
             onUpdateChapterTitle={(cid, nt) => handleUpdateChapterTitle(activeBook.id, cid, nt)} 
             onDeleteChapter={(cid) => handleDeleteChapter(activeBook.id, cid)} 
             onRefreshDriveFolder={() => {}} onUpdateChapter={handleUpdateChapter} onUpdateBookSettings={handleUpdateBookSettings} driveToken={state.driveToken} />)) : (<div className="h-full flex flex-col items-center justify-center font-black tracking-widest text-lg opacity-40 uppercase">Select a book to begin</div>)) : activeTab === 'rules' ? (
               <RuleManager rules={activeBook?.rules || []} theme={state.theme} onAddRule={r => setState(p => ({ ...p, books: p.books.map(b => b.id === p.activeBookId ? { ...b, rules: [...b.rules, r] } : b) }))} onUpdateRule={r => setState(p => ({ ...p, books: p.books.map(b => b.id === p.activeBookId ? { ...b, rules: b.rules.map(old => old.id === r.id ? r : old) } : b) }))} onDeleteRule={id => setState(p => ({ ...p, books: p.books.map(b => b.id === p.activeBookId ? { ...b, rules: b.rules.filter(r => r.id !== id) } : b) }))} onImportRules={nr => setState(p => ({ ...p, books: p.books.map(b => b.id === p.activeBookId ? { ...b, rules: nr } : b) }))} selectedVoice={(activeBook?.settings.useBookSettings && activeBook.settings.selectedVoiceName) ? activeBook.settings.selectedVoiceName : state.selectedVoiceName || ''} playbackSpeed={(activeBook?.settings.useBookSettings && activeBook.settings.playbackSpeed) ? activeBook.settings.playbackSpeed : state.playbackSpeed} />
             ) : (<Settings settings={state.readerSettings} onUpdate={s => setState(p => ({ ...p, readerSettings: { ...p.readerSettings, ...s } }))} theme={state.theme} keepAwake={state.keepAwake} onSetKeepAwake={v => setState(p => ({ ...p, keepAwake: v }))} onCheckForUpdates={() => window.location.reload()} isCloudLinked={!!state.driveToken} onLinkCloud={async () => { const t = await authenticateDrive(state.googleClientId); setState(p => ({ ...p, driveToken: t })); }} onSyncNow={() => handleSync(true)} isSyncing={isSyncing} googleClientId={state.googleClientId} onUpdateGoogleClientId={id => setState(p => ({ ...p, googleClientId: id }))} onClearAuth={() => setState(p => ({ ...p, driveToken: undefined }))} />)}
          </div>
          {activeChapterMetadata && activeTab === 'reader' && (
            <Player 
              isPlaying={isPlaying} onPlay={handlePlay} onPause={handlePause} onStop={() => { speechController.stop(); setIsPlaying(false); }} onNext={() => handleNextChapter()} onPrev={() => {}} onSeek={d => handleJumpToOffset(state.currentOffset + d)}
              speed={(activeBook?.settings.useBookSettings && activeBook.settings.playbackSpeed) ? activeBook.settings.playbackSpeed : state.playbackSpeed} onSpeedChange={s => setState(prev => prev.books.find(b => b.id === prev.activeBookId)?.settings.useBookSettings ? { ...prev, books: prev.books.map(b => b.id === prev.activeBookId ? { ...b, settings: { ...b.settings, playbackSpeed: s } } : b) } : { ...prev, playbackSpeed: s })}
              selectedVoice={activeBook?.settings.defaultVoiceId || ''} onVoiceChange={() => {}}
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
            {transitionToast.number > 0 ? `Chapter ${transitionToast.number}: ${transitionToast.title}` : transitionToast.title}
          </div>
        </div>
      )}
    </div>
  );
};

export default App;
