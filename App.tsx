import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Book, Chapter, AppState, Theme, HighlightMode, StorageBackend, ReaderSettings } from './types';
import Library from './components/Library';
import Reader from './components/Reader';
import Player from './components/Player';
import RuleManager from './components/RuleManager';
import Settings from './components/Settings';
import Extractor from './components/Extractor';
import ChapterFolderView from './components/ChapterFolderView';
import { speechController, applyRules } from './services/speechService';
import { authenticateDrive, fetchDriveFile, uploadToDrive, createDriveFolder } from './services/driveService';
import { BookText, Zap, Sun, Coffee, Moon, X, Settings as SettingsIcon, Menu, RefreshCw } from 'lucide-react';

const usePWAUpdate = () => {
  const [offlineReady, setOfflineReady] = useState(false);
  const [needRefresh, setNeedRefresh] = useState(false);
  
  const updateServiceWorker = (reload: boolean) => {
    if (reload) window.location.reload();
  };

  return {
    offlineReady: [offlineReady, setOfflineReady],
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  };
};

const App: React.FC = () => {
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = usePWAUpdate();

  const [state, setState] = useState<AppState>(() => {
    const saved = localStorage.getItem('talevox_pro_v2');
    const parsed = saved ? JSON.parse(saved) : {};
    return {
      books: (parsed.books || []).map((b: any) => ({
        ...b,
        directoryHandle: undefined,
        settings: b.settings || { useBookSettings: false, highlightMode: HighlightMode.WORD }
      })),
      activeBookId: parsed.activeBookId,
      playbackSpeed: parsed.playbackSpeed || 1.0,
      selectedVoiceName: parsed.selectedVoiceName,
      theme: parsed.theme || Theme.LIGHT,
      currentOffset: 0,
      debugMode: parsed.debugMode || false,
      keepAwake: parsed.keepAwake ?? false,
      readerSettings: parsed.readerSettings || {
        fontFamily: "'Source Serif 4', serif",
        fontSizePx: 20,
        lineHeight: 1.8,
        paragraphSpacing: 1
      },
      driveToken: parsed.driveToken,
      lastSession: parsed.lastSession
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

  const stateRef = useRef(state);
  useEffect(() => { stateRef.current = state; }, [state]);

  const wakeLockSentinel = useRef<any>(null);

  useEffect(() => {
    const { driveToken, books, ...rest } = state;
    const persistentBooks = books.map(({ directoryHandle, ...b }) => b);
    localStorage.setItem('talevox_pro_v2', JSON.stringify({ ...rest, books: persistentBooks }));
  }, [state]);

  useEffect(() => {
    const handleWakeLock = async () => {
      if (isPlaying && state.keepAwake && 'wakeLock' in navigator && !wakeLockSentinel.current) {
        try {
          wakeLockSentinel.current = await (navigator as any).wakeLock.request('screen');
        } catch (err) {
          console.error("Wake Lock error:", err);
        }
      } else if ((!isPlaying || !state.keepAwake) && wakeLockSentinel.current) {
        try {
          await wakeLockSentinel.current.release();
          wakeLockSentinel.current = null;
        } catch (err) {}
      }
    };
    handleWakeLock();
  }, [isPlaying, state.keepAwake]);

  const activeBook = state.books.find(b => b.id === state.activeBookId);
  const activeChapterMetadata = activeBook?.chapters.find(c => c.id === activeBook.currentChapterId);

  const playbackText = useMemo(() => {
    if (!activeChapterText) return "";
    return applyRules(activeChapterText, activeBook?.rules || []);
  }, [activeChapterText, activeBook?.rules]);

  const loadChapterContent = async (bookId: string, chapterId: string) => {
    const book = state.books.find(b => b.id === bookId);
    const chapter = book?.chapters.find(c => c.id === chapterId);
    if (!book || !chapter) return;

    setIsLoadingChapter(true);
    try {
      let content = "";
      if (book.backend === StorageBackend.DRIVE) {
        if (!state.driveToken) {
          const token = await authenticateDrive();
          setState(prev => ({ ...prev, driveToken: token }));
          content = await fetchDriveFile(token, chapter.driveId!);
        } else {
          try {
            content = await fetchDriveFile(state.driveToken, chapter.driveId!);
          } catch (e: any) {
            if (e.message === 'UNAUTHORIZED') {
              const token = await authenticateDrive();
              setState(prev => ({ ...prev, driveToken: token }));
              content = await fetchDriveFile(token, chapter.driveId!);
            }
          }
        }
      } else if (book.backend === StorageBackend.LOCAL && book.directoryHandle) {
        const handle = book.directoryHandle;
        const fileHandle = await handle.getFileHandle(chapter.filename);
        const file = await fileHandle.getFile();
        content = await file.text();
      } else {
        content = chapter.content; 
      }
      setActiveChapterText(content);
    } catch (err) {
      console.error("Failed to load chapter:", err);
    } finally {
      setIsLoadingChapter(false);
    }
  };

  useEffect(() => {
    if (state.activeBookId && activeBook?.currentChapterId) {
        loadChapterContent(state.activeBookId, activeBook.currentChapterId);
    }
  }, []);

  const handleAddBook = async (title: string, backend: StorageBackend, directoryHandle?: any) => {
    let driveFolderId = undefined;
    if (backend === StorageBackend.DRIVE) {
      try {
        const token = await authenticateDrive();
        setState(prev => ({ ...prev, driveToken: token }));
        driveFolderId = await createDriveFolder(token, `Talevox - ${title}`);
      } catch (err) {
        console.error("Failed to create Drive folder:", err);
        return;
      }
    }

    const newBook: Book = {
      id: crypto.randomUUID(),
      title,
      backend,
      chapters: [],
      rules: [],
      directoryHandle,
      driveFolderId,
      settings: { useBookSettings: false, highlightMode: HighlightMode.WORD }
    };

    setState(prev => ({ ...prev, books: [...prev.books, newBook], activeBookId: newBook.id }));
    setIsAddChapterOpen(true);
    setIsSidebarOpen(false);
  };

  const handleSelectChapter = useCallback(async (bookId: string, chapterId: string, offset?: number) => {
    const book = state.books.find(b => b.id === bookId);
    if (!book) return;

    speechController.stop();
    setIsPlaying(false);
    
    setState(prev => ({
      ...prev,
      activeBookId: bookId,
      books: prev.books.map(b => b.id === bookId ? { ...b, currentChapterId: chapterId } : b),
      currentOffset: offset ?? 0
    }));

    await loadChapterContent(bookId, chapterId);
    setActiveTab('reader');
    setIsSidebarOpen(false);
  }, [state.books, state.driveToken]);

  const handleSelectBook = (id: string) => {
    speechController.stop();
    setIsPlaying(false);
    setState(prev => ({ 
      ...prev, 
      activeBookId: id,
      books: prev.books.map(b => b.id === id ? { ...b, currentChapterId: undefined } : b)
    }));
    setActiveTab('reader');
    setIsSidebarOpen(false);
  };

  const handleChapterExtracted = async (data: { title: string; content: string; url: string; index: number }) => {
    if (!activeBook) return;

    const newChapter: Chapter = {
      id: crypto.randomUUID(),
      index: data.index,
      title: data.title,
      content: data.content,
      wordCount: data.content.trim().split(/\s+/).length,
      progress: 0,
      filename: `ch_${data.index}_${Date.now()}.txt`,
      sourceUrl: data.url
    };

    if (activeBook.backend === StorageBackend.DRIVE && state.driveToken) {
      const driveId = await uploadToDrive(state.driveToken, activeBook.driveFolderId!, newChapter.filename, data.content);
      newChapter.driveId = driveId;
    } else if (activeBook.backend === StorageBackend.LOCAL && activeBook.directoryHandle) {
      const handle = activeBook.directoryHandle;
      const fileHandle = await handle.getFileHandle(newChapter.filename, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(data.content);
      await writable.close();
    }

    setState(prev => ({
      ...prev,
      books: prev.books.map(b => b.id === activeBook.id ? {
        ...b,
        chapters: [...b.chapters, newChapter].sort((a, b) => a.index - b.index)
      } : b)
    }));

    setIsAddChapterOpen(false);
    handleSelectChapter(activeBook.id, newChapter.id, 0);
  };

  const handlePlay = useCallback(() => {
    if (!playbackText || !activeBook || !activeChapterMetadata) return;
    setIsPlaying(true);
    speechController.speak(
      playbackText,
      state.selectedVoiceName || '',
      state.playbackSpeed,
      state.currentOffset,
      () => setIsPlaying(false),
      (offset) => {
        if (Math.abs(stateRef.current.currentOffset - offset) > 20) {
          setState(prev => ({ ...prev, currentOffset: offset }));
        }
      },
      async () => {
        const s = stateRef.current;
        const book = s.books.find(b => b.id === s.activeBookId);
        if (!book || stopAfterChapter) return null;
        const currentIdx = book.chapters.findIndex(c => c.id === book.currentChapterId);
        if (currentIdx < book.chapters.length - 1) {
          const next = book.chapters[currentIdx + 1];
          setTransitionToast({ number: next.index, title: next.title });
          setTimeout(() => setTransitionToast(null), 2500);
          await handleSelectChapter(book.id, next.id, 0);
          return {
            announcementPrefix: `Chapter ${next.index}: ${next.title}. `,
            content: applyRules(activeChapterText, book.rules),
            bookTitle: book.title,
            chapterTitle: next.title
          };
        }
        return null;
      },
      activeBook.title,
      activeChapterMetadata.title
    );
  }, [playbackText, state.selectedVoiceName, state.playbackSpeed, state.currentOffset, stopAfterChapter, activeChapterText, activeBook, activeChapterMetadata]);

  const handlePause = useCallback(() => {
    speechController.stop();
    setIsPlaying(false);
  }, []);

  return (
    <div className={`flex flex-col h-screen overflow-hidden font-sans transition-colors duration-500 ${state.theme === Theme.DARK ? 'bg-slate-950 text-slate-100' : state.theme === Theme.SEPIA ? 'bg-[#f4ecd8] text-[#3c2f25]' : 'bg-white text-black'}`}>
      
      {needRefresh && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[200] w-full max-w-sm px-4">
          <div className="bg-indigo-600 text-white p-4 rounded-2xl shadow-2xl flex items-center justify-between border border-white/20 backdrop-blur-md">
            <div className="flex items-center gap-3">
              <RefreshCw className="w-5 h-5 animate-spin-slow" />
              <span className="font-bold text-sm">Update available</span>
            </div>
            <button 
              onClick={() => updateServiceWorker(true)}
              className="bg-white text-indigo-600 px-4 py-1.5 rounded-xl font-black text-xs hover:bg-indigo-50 transition-colors"
            >
              REFRESH
            </button>
          </div>
        </div>
      )}

      {transitionToast && (
        <div className="fixed top-24 left-1/2 -translate-x-1/2 z-[100] pointer-events-none">
          <div className="bg-indigo-600 text-white px-8 py-4 rounded-3xl shadow-2xl flex items-center gap-4 border border-white/20 backdrop-blur-md toast-animate">
            <div className="text-lg font-black leading-tight">Chapter {transitionToast.number}: {transitionToast.title}</div>
          </div>
        </div>
      )}

      <div className="flex flex-1 overflow-hidden relative">
        <Library 
          isOpen={isSidebarOpen} onClose={() => setIsSidebarOpen(false)}
          books={state.books} activeBookId={state.activeBookId} lastSession={state.lastSession}
          onSelectBook={handleSelectBook} onDeleteBook={id => setState(p => ({ ...p, books: p.books.filter(b => b.id !== id) }))}
          onSelectChapter={handleSelectChapter} theme={state.theme}
          onAddBook={handleAddBook}
        />
        
        <main className={`flex-1 flex flex-col min-w-0 shadow-2xl relative transition-colors duration-500 ${state.theme === Theme.DARK ? 'bg-slate-900' : state.theme === Theme.SEPIA ? 'bg-[#efe6d5]' : 'bg-white'}`}>
          <header className={`h-16 border-b flex items-center justify-between px-4 lg:px-8 z-10 sticky top-0 transition-colors duration-300 ${state.theme === Theme.DARK ? 'border-slate-800 bg-slate-900/80 backdrop-blur-md' : state.theme === Theme.SEPIA ? 'border-[#d8ccb6] bg-[#efe6d5]/90 backdrop-blur-md' : 'border-black/5 bg-white/90 backdrop-blur-md'}`}>
            <div className="flex items-center gap-2 lg:gap-6">
              <button onClick={() => setIsSidebarOpen(true)} className="p-2 lg:hidden rounded-lg hover:bg-black/5 text-inherit"><Menu className="w-5 h-5" /></button>
              <nav className="flex items-center gap-6">
                <button onClick={() => setActiveTab('reader')} className={`flex items-center gap-2 h-16 border-b-2 transition-all font-black uppercase text-[10px] tracking-widest ${activeTab === 'reader' ? 'border-indigo-600 text-indigo-600' : 'border-transparent opacity-60 hover:opacity-100'}`}><BookText className="w-4 h-4" /> <span className="hidden sm:inline">Reader</span></button>
                <button onClick={() => setActiveTab('rules')} className={`flex items-center gap-2 h-16 border-b-2 transition-all font-black uppercase text-[10px] tracking-widest ${activeTab === 'rules' ? 'border-indigo-600 text-indigo-600' : 'border-transparent opacity-60 hover:opacity-100'}`}><Zap className="w-4 h-4" /> <span className="hidden sm:inline">Rules</span></button>
                <button onClick={() => setActiveTab('settings')} className={`flex items-center gap-2 h-16 border-b-2 transition-all font-black uppercase text-[10px] tracking-widest ${activeTab === 'settings' ? 'border-indigo-600 text-indigo-600' : 'border-transparent opacity-60 hover:opacity-100'}`}><SettingsIcon className="w-4 h-4" /> <span className="hidden sm:inline">Settings</span></button>
              </nav>
            </div>

            <div className="flex items-center gap-3">
              <div className="flex items-center gap-1 p-1 rounded-xl bg-black/5">
                <button onClick={() => setState(p => ({ ...p, theme: Theme.LIGHT }))} className={`p-1.5 rounded-lg ${state.theme === Theme.LIGHT ? 'bg-white shadow-sm text-indigo-600' : 'opacity-60'}`}><Sun className="w-4 h-4" /></button>
                <button onClick={() => setState(p => ({ ...p, theme: Theme.SEPIA }))} className={`p-1.5 rounded-lg ${state.theme === Theme.SEPIA ? 'bg-[#f4ecd8] shadow-sm text-[#9c6644]' : 'opacity-60'}`}><Coffee className="w-4 h-4" /></button>
                <button onClick={() => setState(p => ({ ...p, theme: Theme.DARK }))} className={`p-1.5 rounded-lg ${state.theme === Theme.DARK ? 'bg-slate-800 shadow-sm text-indigo-400' : 'opacity-60'}`}><Moon className="w-4 h-4" /></button>
              </div>
            </div>
          </header>

          <div className="flex-1 overflow-y-auto">
             {activeTab === 'reader' ? (
              activeBook ? (
                activeBook.currentChapterId ? (
                  <Reader 
                    chapter={activeChapterMetadata || null} rules={activeBook.rules} 
                    currentOffset={state.currentOffset} theme={state.theme}
                    debugMode={state.debugMode} onToggleDebug={() => setState(p => ({ ...p, debugMode: !p.debugMode }))}
                    onJumpToOffset={(off) => setState(p => ({ ...p, currentOffset: off }))}
                    highlightMode={activeBook.settings.highlightMode}
                    onBackToChapters={() => handleSelectBook(activeBook.id)}
                    readerSettings={state.readerSettings}
                  />
                ) : (
                  <ChapterFolderView 
                    book={activeBook} theme={state.theme} onAddChapter={() => setIsAddChapterOpen(true)}
                    onOpenChapter={(id) => handleSelectChapter(activeBook.id, id)}
                    onToggleFavorite={(id) => {}}
                  />
                )
              ) : (
                <div className="h-full flex flex-col items-center justify-center font-black tracking-widest text-lg opacity-40 uppercase">Select a book to begin</div>
              )
            ) : activeTab === 'rules' ? (
              <RuleManager 
                rules={activeBook?.rules || []} theme={state.theme}
                onAddRule={r => setState(p => ({ ...p, books: p.books.map(b => b.id === p.activeBookId ? { ...b, rules: [...b.rules, r] } : b) }))}
                onUpdateRule={r => setState(p => ({ ...p, books: p.books.map(b => b.id === p.activeBookId ? { ...b, rules: b.rules.map(old => old.id === r.id ? r : old) } : b) }))}
                onDeleteRule={id => setState(p => ({ ...p, books: p.books.map(b => b.id === p.activeBookId ? { ...b, rules: b.rules.filter(r => r.id !== id) } : b) }))}
                onImportRules={nr => setState(p => ({ ...p, books: p.books.map(b => b.id === p.activeBookId ? { ...b, rules: nr } : b) }))}
              />
            ) : (
              <Settings 
                settings={state.readerSettings} 
                onUpdate={s => setState(p => ({ ...p, readerSettings: { ...p.readerSettings, ...s } }))} 
                theme={state.theme}
                keepAwake={state.keepAwake}
                onSetKeepAwake={v => setState(p => ({ ...p, keepAwake: v }))}
                onCheckForUpdates={async () => {
                  try {
                    const registration = await navigator.serviceWorker.getRegistration();
                    if (registration) await registration.update();
                  } catch (e) {}
                }}
              />
            )}
          </div>

          {activeChapterMetadata && activeTab === 'reader' && (
            <Player 
              isPlaying={isPlaying} onPlay={handlePlay} onPause={handlePause}
              onStop={handlePause} onNext={() => {}} onPrev={() => {}} onSeek={d => setState(p => ({ ...p, currentOffset: p.currentOffset + d }))}
              speed={state.playbackSpeed} onSpeedChange={v => setState(p => ({ ...p, playbackSpeed: v }))}
              selectedVoice={state.selectedVoiceName || ''} onVoiceChange={v => setState(p => ({ ...p, selectedVoiceName: v }))}
              theme={state.theme} onThemeChange={() => {}} progress={state.currentOffset} totalLength={playbackText.length}
              wordCount={activeChapterMetadata.wordCount} onSeekToOffset={o => setState(p => ({ ...p, currentOffset: o }))}
              sleepTimer={sleepTimerSeconds} onSetSleepTimer={setSleepTimerSeconds}
              stopAfterChapter={stopAfterChapter} onSetStopAfterChapter={setStopAfterChapter}
              useBookSettings={false} onSetUseBookSettings={() => {}}
              highlightMode={activeBook?.settings.highlightMode || HighlightMode.WORD}
              onSetHighlightMode={m => setState(p => ({ ...p, books: p.books.map(b => b.id === p.activeBookId ? { ...b, settings: { ...b.settings, highlightMode: m } } : b) }))}
            />
          )}

          {isAddChapterOpen && (
            <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/80 backdrop-blur-md">
               <button onClick={() => setIsAddChapterOpen(false)} className="fixed top-8 right-8 z-[110] p-3 bg-white/10 text-white rounded-full"><X className="w-6 h-6" /></button>
               <div className="w-full max-w-4xl max-h-[90vh] overflow-y-auto rounded-3xl shadow-2xl">
                  <Extractor onChapterExtracted={handleChapterExtracted} suggestedIndex={activeBook?.chapters.length ? Math.max(...activeBook.chapters.map(c => c.index)) + 1 : 1} theme={state.theme} />
               </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
};

export default App;