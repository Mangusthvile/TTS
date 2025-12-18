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
import { authenticateDrive, fetchDriveFile, uploadToDrive, createDriveFolder, findFileSync, findFolderSync, listFilesInFolder } from './services/driveService';
import { BookText, Zap, Sun, Coffee, Moon, X, Settings as SettingsIcon, Menu, RefreshCw, Loader2 } from 'lucide-react';

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
  const [transitionToast, setTransitionToast] = useState<{ number: number; title: string } | null>(null);
  const [sleepTimerSeconds, setSleepTimerSeconds] = useState<number | null>(null);
  const [stopAfterChapter, setStopAfterChapter] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);

  const stateRef = useRef(state);
  useEffect(() => { stateRef.current = state; }, [state]);

  const activeBook = state.books.find(b => b.id === state.activeBookId);

  const activeChapterMetadata = useMemo(() => {
    if (!activeBook || !activeBook.currentChapterId) return null;
    return activeBook.chapters.find(c => c.id === activeBook.currentChapterId) || null;
  }, [activeBook]);

  // Persistence logic
  useEffect(() => {
    const { driveToken, books, ...rest } = state;
    const persistentBooks = books.map(({ directoryHandle, ...b }) => ({ ...b, directoryHandle: undefined }));
    localStorage.setItem('talevox_pro_v2', JSON.stringify({ 
      ...rest, 
      books: persistentBooks,
      lastSession: state.activeBookId && activeBook?.currentChapterId ? {
        bookId: state.activeBookId,
        chapterId: activeBook.currentChapterId,
        offset: state.currentOffset
      } : state.lastSession
    }));
  }, [state, activeBook]);

  const handlePause = useCallback(() => { 
    speechController.stop(); 
    setIsPlaying(false); 
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
    handlePause(); // MANDATORY PAUSE: Jumping sections
    const finalPlaybackText = applyRules(activeChapterText, activeBook?.rules || []);
    const total = finalPlaybackText.length || 1;
    const boundedOffset = Math.min(Math.max(0, offset), total);
    const isFinished = boundedOffset >= total * 0.98;
    
    setState(prev => ({ ...prev, currentOffset: boundedOffset }));
    if (stateRef.current.activeBookId && activeBook?.currentChapterId) {
      updateChapterProgress(stateRef.current.activeBookId, activeBook.currentChapterId, boundedOffset, total, isFinished);
    }
  }, [handlePause, activeBook, activeChapterText, updateChapterProgress]);

  const handleSpeedChange = useCallback((v: number) => {
    handlePause(); // MANDATORY PAUSE: Speed change
    if (activeBook?.settings.useBookSettings) {
      setState(prev => ({ ...prev, books: prev.books.map(b => b.id === prev.activeBookId ? { ...b, settings: { ...b.settings, playbackSpeed: v } } : b) }));
    } else {
      setState(prev => ({ ...prev, playbackSpeed: v }));
    }
  }, [handlePause, activeBook?.settings.useBookSettings]);

  const handleVoiceChange = useCallback((v: string) => {
    handlePause(); // MANDATORY PAUSE: Voice change
    if (activeBook?.settings.useBookSettings) {
      setState(prev => ({ ...prev, books: prev.books.map(b => b.id === prev.activeBookId ? { ...b, settings: { ...b.settings, selectedVoiceName: v } } : b) }));
    } else {
      setState(prev => ({ ...prev, selectedVoiceName: v }));
    }
  }, [handlePause, activeBook?.settings.useBookSettings]);

  const handleRuleOperation = useCallback((op: 'add' | 'update' | 'delete' | 'import', rule?: Rule, rules?: Rule[]) => {
    handlePause(); // MANDATORY PAUSE: Rules change
    setState(prev => {
      const books = prev.books.map(b => {
        if (b.id !== prev.activeBookId) return b;
        let newRules = [...b.rules];
        if (op === 'add' && rule) newRules.push(rule);
        if (op === 'update' && rule) newRules = newRules.map(r => r.id === rule.id ? rule : r);
        if (op === 'delete' && rule) newRules = newRules.filter(r => r.id !== rule.id);
        if (op === 'import' && rules) newRules = rules;
        return { ...b, rules: newRules };
      });
      return { ...prev, books };
    });
  }, [handlePause]);

  const handleSync = useCallback(async (manual = false) => {
    if (!state.driveToken) return;
    setIsSyncing(true);
    try {
      const existingFileId = await findFileSync(state.driveToken, SYNC_FILENAME);
      if (existingFileId) {
        const remoteDataRaw = await fetchDriveFile(state.driveToken, existingFileId);
        const remoteData = JSON.parse(remoteDataRaw);
        setState(prev => {
          const mergedBooks = [...prev.books];
          remoteData.books.forEach((remoteBook: Book) => {
            const localIdx = mergedBooks.findIndex(b => b.id === remoteBook.id);
            if (localIdx === -1) {
              mergedBooks.push({ ...remoteBook, directoryHandle: undefined });
            } else {
              mergedBooks[localIdx] = {
                ...remoteBook,
                directoryHandle: mergedBooks[localIdx].directoryHandle,
                backend: mergedBooks[localIdx].backend,
                driveFolderId: remoteBook.driveFolderId || mergedBooks[localIdx].driveFolderId,
                driveFolderName: remoteBook.driveFolderName || mergedBooks[localIdx].driveFolderName
              };
            }
          });
          return { ...prev, books: mergedBooks };
        });
      }
      const manifestContent = JSON.stringify({
        books: stateRef.current.books.map(({ directoryHandle, ...b }) => b),
        readerSettings: stateRef.current.readerSettings,
        updatedAt: new Date().toISOString()
      });
      await uploadToDrive(state.driveToken, null, SYNC_FILENAME, manifestContent, existingFileId || undefined, 'application/json');
      if (manual) alert("Cloud Sync Complete");
    } catch (err) {
      console.error("Sync failed:", err);
    } finally {
      setIsSyncing(false);
    }
  }, [state.driveToken]);

  useEffect(() => {
    if (state.driveToken) handleSync();
  }, [state.driveToken, handleSync]);

  const handleLinkCloud = async () => {
    try {
      const token = await authenticateDrive(state.googleClientId);
      setState(prev => ({ ...prev, driveToken: token }));
      return token;
    } catch (err) {
      throw err;
    }
  };

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
      } else {
        content = chapter.content || ""; 
      }
      setActiveChapterText(content);
      setState(prev => ({ ...prev, currentOffset: chapter.progress || 0 }));
    } catch (err) {
      alert(`Error loading chapter: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setIsLoadingChapter(false);
    }
  }, []);

  useEffect(() => {
    if (state.activeBookId && activeBook?.currentChapterId) {
      loadChapterContent(state.activeBookId, activeBook.currentChapterId);
    } else { setActiveChapterText(''); }
  }, [state.activeBookId, activeBook?.currentChapterId, loadChapterContent]);

  const handleSelectBook = useCallback((id: string) => {
    handlePause(); // MANDATORY PAUSE: Switch book
    setState(prev => ({
      ...prev,
      activeBookId: id,
      lastSession: undefined, // Clear resume card after interaction
      books: prev.books.map(b => b.id === id ? { ...b, currentChapterId: undefined } : b),
      currentOffset: 0
    }));
    setActiveTab('reader');
  }, [handlePause]);

  const handleSelectChapter = useCallback(async (bookId: string, chapterId: string, offset?: number, isInternalTransition = false) => {
    if (!isInternalTransition) handlePause(); // MANDATORY PAUSE: Switch chapter
    setState(prev => ({
      ...prev, 
      activeBookId: bookId,
      lastSession: undefined, // Clear resume card after interaction
      books: prev.books.map(b => b.id === bookId ? { ...b, currentChapterId: chapterId } : b),
      currentOffset: offset ?? 0
    }));
    setActiveTab('reader');
    setIsSidebarOpen(false);
  }, [handlePause]);

  const handlePlay = useCallback(() => {
    if (!activeBook || !activeChapterMetadata || isLoadingChapter) return;
    const finalPlaybackText = applyRules(activeChapterText, activeBook.rules);
    if (!finalPlaybackText) return;
    const totalLen = finalPlaybackText.length;
    setIsPlaying(true);
    speechController.speak(
      finalPlaybackText, 
      (activeBook.settings.useBookSettings && activeBook.settings.selectedVoiceName) ? activeBook.settings.selectedVoiceName : state.selectedVoiceName || '', 
      (activeBook.settings.useBookSettings && activeBook.settings.playbackSpeed) ? activeBook.settings.playbackSpeed : state.playbackSpeed, 
      state.currentOffset,
      () => setIsPlaying(false),
      (offset) => { 
        if (Math.abs(stateRef.current.currentOffset - offset) >= 1) {
          setState(prev => ({ ...prev, currentOffset: offset }));
          updateChapterProgress(stateRef.current.activeBookId!, activeBook.currentChapterId!, offset, totalLen);
        }
      },
      async () => {
        const s = stateRef.current;
        const book = s.books.find(b => b.id === s.activeBookId);
        if (!book || stopAfterChapter || (sleepTimerSeconds !== null && sleepTimerSeconds <= 0)) return null;
        
        const currentIdx = book.chapters.findIndex(c => c.id === book.currentChapterId);
        
        // Mark current chapter as finished
        if (book.currentChapterId) {
          const currentChapter = book.chapters[currentIdx];
          const textAtEnd = applyRules(currentChapter.content, book.rules);
          updateChapterProgress(book.id, book.currentChapterId, textAtEnd.length, textAtEnd.length, true);
        }

        if (currentIdx < book.chapters.length - 1) {
          const next = book.chapters[currentIdx + 1];
          setTransitionToast({ number: next.index, title: next.title });
          setTimeout(() => setTransitionToast(null), 3500);
          
          // Switch state internally
          handleSelectChapter(book.id, next.id, 0, true);
          const nextText = applyRules(next.content, book.rules);
          
          // Immediately update activeChapterText to keep Reader's segments in sync
          setActiveChapterText(next.content);
          
          return {
            announcementPrefix: `Chapter ${next.index}: ${next.title}. `,
            content: nextText,
            bookTitle: book.title, 
            chapterTitle: next.title
          };
        }
        return null;
      },
      activeBook.title, activeChapterMetadata.title
    );
  }, [activeBook, activeChapterMetadata, isLoadingChapter, activeChapterText, state.selectedVoiceName, state.playbackSpeed, state.currentOffset, stopAfterChapter, sleepTimerSeconds, updateChapterProgress, handleSelectChapter]);

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
    setState(prev => ({
      ...prev,
      books: [...prev.books, newBook],
      activeBookId: newBook.id
    }));
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

  const handleDeleteBook = (id: string) => {
     setState(p => ({
        ...p,
        books: p.books.filter(b => b.id !== id),
        activeBookId: p.activeBookId === id ? undefined : p.activeBookId
     }));
  };

  return (
    <div className={`flex flex-col h-screen overflow-hidden font-sans transition-colors duration-500 ${state.theme === Theme.DARK ? 'bg-slate-950 text-slate-100' : state.theme === Theme.SEPIA ? 'bg-[#f4ecd8] text-[#3c2f25]' : 'bg-white text-black'}`}>
      <div className="flex flex-1 overflow-hidden relative">
        <Library 
          isOpen={isSidebarOpen} 
          onClose={() => setIsSidebarOpen(false)} 
          books={state.books} 
          activeBookId={state.activeBookId} 
          lastSession={state.lastSession} 
          onSelectBook={handleSelectBook} 
          onDeleteBook={handleDeleteBook} 
          onSelectChapter={handleSelectChapter} 
          theme={state.theme} 
          onAddBook={handleAddBook}
          googleClientId={state.googleClientId}
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
            <div className="flex items-center gap-3"><div className="flex items-center gap-1 p-1 rounded-xl bg-black/5"><button onClick={() => setState(p => ({ ...p, theme: Theme.LIGHT }))} className={`p-1.5 rounded-lg ${state.theme === Theme.LIGHT ? 'bg-white shadow-sm text-indigo-600' : 'opacity-60'}`}><Sun className="w-4 h-4" /></button><button onClick={() => setState(p => ({ ...p, theme: Theme.SEPIA }))} className={`p-1.5 rounded-lg ${state.theme === Theme.SEPIA ? 'bg-[#f4ecd8] shadow-sm text-[#9c6644]' : 'opacity-60'}`}><Coffee className="w-4 h-4" /></button><button onClick={() => setState(p => ({ ...p, theme: Theme.DARK }))} className={`p-1.5 rounded-lg ${state.theme === Theme.DARK ? 'bg-slate-800 shadow-sm text-indigo-400' : 'opacity-60'}`}><Moon className="w-4 h-4" /></button></div></div>
          </header>
          <div className="flex-1 overflow-y-auto relative">
             {isLoadingChapter && (<div className="absolute inset-0 flex items-center justify-center bg-inherit z-[5] animate-in fade-in duration-300"><div className="flex flex-col items-center gap-4"><Loader2 className="w-10 h-10 text-indigo-600 animate-spin" /><span className="text-xs font-black uppercase tracking-widest opacity-40">Loading Content...</span></div></div>)}
             {isAddChapterOpen && (
               <div className="absolute inset-0 z-20 overflow-y-auto p-4 lg:p-12 animate-in slide-in-from-bottom-8 duration-500">
                  <div className="max-w-4xl mx-auto relative">
                    <button onClick={() => setIsAddChapterOpen(false)} className="absolute -top-4 -right-4 lg:-right-8 p-3 bg-white text-black shadow-2xl rounded-full z-30 hover:scale-110 active:scale-95 transition-transform"><X className="w-6 h-6" /></button>
                    <Extractor onChapterExtracted={handleChapterExtracted} suggestedIndex={activeBook?.chapters.length ? Math.max(...activeBook.chapters.map(c => c.index)) + 1 : 1} theme={state.theme} />
                  </div>
               </div>
             )}
             {activeTab === 'reader' ? (activeBook ? (activeBook.currentChapterId ? (<Reader chapter={activeChapterMetadata || null} rules={activeBook.rules} currentOffset={state.currentOffset} theme={state.theme} debugMode={state.debugMode} onToggleDebug={() => setState(p => ({ ...p, debugMode: !p.debugMode }))} onJumpToOffset={handleJumpToOffset} highlightMode={activeBook.settings.highlightMode} onBackToChapters={() => handleSelectBook(activeBook.id)} onAddChapter={() => setIsAddChapterOpen(true)} readerSettings={state.readerSettings} />) : (<ChapterFolderView book={activeBook} theme={state.theme} onAddChapter={() => setIsAddChapterOpen(true)} onOpenChapter={(id) => handleSelectChapter(activeBook.id, id)} onToggleFavorite={() => {}} />)) : (<div className="h-full flex flex-col items-center justify-center font-black tracking-widest text-lg opacity-40 uppercase">Select a book to begin</div>)) : activeTab === 'rules' ? (
               <RuleManager 
                 rules={activeBook?.rules || []} 
                 theme={state.theme} 
                 onAddRule={r => handleRuleOperation('add', r)} 
                 onUpdateRule={r => handleRuleOperation('update', r)} 
                 onDeleteRule={id => handleRuleOperation('delete', { id } as Rule)} 
                 onImportRules={nr => handleRuleOperation('import', undefined, nr)}
                 selectedVoice={(activeBook?.settings.useBookSettings && activeBook.settings.selectedVoiceName) ? activeBook.settings.selectedVoiceName : state.selectedVoiceName || ''}
                 playbackSpeed={(activeBook?.settings.useBookSettings && activeBook.settings.playbackSpeed) ? activeBook.settings.playbackSpeed : state.playbackSpeed}
               />
             ) : (<Settings settings={state.readerSettings} onUpdate={s => setState(p => ({ ...p, readerSettings: { ...p.readerSettings, ...s } }))} theme={state.theme} keepAwake={state.keepAwake} onSetKeepAwake={v => setState(p => ({ ...p, keepAwake: v }))} onCheckForUpdates={() => {}} isCloudLinked={!!state.driveToken} onLinkCloud={handleLinkCloud} onSyncNow={() => handleSync(true)} isSyncing={isSyncing} googleClientId={state.googleClientId} onUpdateGoogleClientId={id => setState(p => ({ ...p, googleClientId: id }))} onClearAuth={() => setState(p => ({ ...p, driveToken: undefined }))} />)}
          </div>
          {activeChapterMetadata && activeTab === 'reader' && (
            <Player 
              isPlaying={isPlaying} onPlay={handlePlay} onPause={handlePause} onStop={handlePause} onNext={() => {}} onPrev={() => {}} onSeek={d => handleJumpToOffset(state.currentOffset + d)}
              speed={(activeBook?.settings.useBookSettings && activeBook.settings.playbackSpeed) ? activeBook.settings.playbackSpeed : state.playbackSpeed} onSpeedChange={handleSpeedChange}
              selectedVoice={(activeBook?.settings.useBookSettings && activeBook.settings.selectedVoiceName) ? activeBook.settings.selectedVoiceName : state.selectedVoiceName || ''} onVoiceChange={handleVoiceChange}
              theme={state.theme} onThemeChange={() => {}} progress={state.currentOffset} totalLength={applyRules(activeChapterText, activeBook?.rules || []).length} wordCount={activeChapterMetadata.wordCount} onSeekToOffset={handleJumpToOffset}
              sleepTimer={sleepTimerSeconds} onSetSleepTimer={setSleepTimerSeconds} stopAfterChapter={stopAfterChapter} onSetStopAfterChapter={setStopAfterChapter}
              useBookSettings={activeBook?.settings.useBookSettings || false} onSetUseBookSettings={v => { handlePause(); setState(p => ({ ...p, books: p.books.map(b => b.id === p.activeBookId ? { ...b, settings: { ...b.settings, useBookSettings: v } } : b) })); }}
              highlightMode={activeBook?.settings.highlightMode || HighlightMode.WORD} onSetHighlightMode={m => setState(p => ({ ...p, books: p.books.map(b => b.id === p.activeBookId ? { ...b, settings: { ...b.settings, highlightMode: m } } : b) }))}
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