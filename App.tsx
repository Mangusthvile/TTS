import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Book, Chapter, AppState, Theme, HighlightMode, StorageBackend, ReaderSettings, RuleType, Rule, SavedSnapshot } from './types';
import Library from './components/Library';
import Reader from './components/Reader';
import Player from './components/Player';
import RuleManager from './components/RuleManager';
import Settings from './components/Settings';
import Extractor from './components/Extractor';
import ChapterFolderView from './components/ChapterFolderView';
import { speechController, applyRules, PROGRESS_STORE_V4 } from './services/speechService';
import { authenticateDrive, fetchDriveFile, uploadToDrive, deleteDriveFile, findFileSync } from './services/driveService';
import { saveChapterToFile } from './services/fileService';
import { BookText, Zap, Sun, Coffee, Moon, X, Settings as SettingsIcon, Menu, RefreshCw, Loader2, Cloud, Volume2, Save, AlertCircle } from 'lucide-react';

const STATE_FILENAME = 'talevox_state_v263.json';
const SNAPSHOT_KEY = "talevox_saved_snapshot_v1";

const App: React.FC = () => {
  const [state, setState] = useState<AppState>(() => {
    const saved = localStorage.getItem('talevox_pro_v2');
    const parsed = saved ? JSON.parse(saved) : {};
    const snapshotStr = localStorage.getItem(SNAPSHOT_KEY);
    const snapshot = snapshotStr ? JSON.parse(snapshotStr) as SavedSnapshot : null;

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
      currentOffsetChars: 0,
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
      lastSession: parsed.lastSession,
      lastSavedAt: snapshot?.savedAt
    };
  });

  const [activeTab, setActiveTab] = useState<'reader' | 'rules' | 'settings'>('reader');
  const [isAddChapterOpen, setIsAddChapterOpen] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [activeChapterText, setActiveChapterText] = useState<string>('');
  const [isLoadingChapter, setIsLoadingChapter] = useState(false);
  const [isFetchingAudio, setIsFetchingAudio] = useState(false);
  const [transitionToast, setTransitionToast] = useState<{ number: number; title: string; type?: 'info' | 'success' | 'error' } | null>(null);
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

  const showToast = (title: string, number = 0, type: 'info' | 'success' | 'error' = 'info') => {
    setTransitionToast({ number, title, type });
    setTimeout(() => setTransitionToast(null), 3500);
  };

  const ensureDriveToken = useCallback(async () => {
    if (stateRef.current.driveToken) return stateRef.current.driveToken;
    try {
      const token = await authenticateDrive(stateRef.current.googleClientId);
      setState(p => ({ ...p, driveToken: token }));
      return token;
    } catch (e) {
      showToast("Authentication Failed", 0, 'error');
      throw e;
    }
  }, []);

  const mergeProgressStore = (local: any, remote: any) => {
    const merged = { ...remote };
    for (const bookId in local) {
      if (!merged[bookId]) {
        merged[bookId] = local[bookId];
      } else {
        for (const chapterId in local[bookId]) {
          const lProg = local[bookId][chapterId];
          const rProg = merged[bookId][chapterId];
          if (!rProg || (lProg.updatedAt > rProg.updatedAt)) {
            merged[bookId][chapterId] = lProg;
          }
        }
      }
    }
    return merged;
  };

  const applySnapshot = useCallback((snapshot: SavedSnapshot) => {
    const { books, readerSettings, activeBookId, playbackSpeed, selectedVoiceName, theme, progressStore } = snapshot.state;
    
    // Merge remote books into local books (remote takes precedence on match)
    const mergedBooks = [...books];
    stateRef.current.books.forEach(lb => {
      if (!mergedBooks.find(rb => rb.id === lb.id)) {
        mergedBooks.push(lb);
      }
    });

    const localProgress = JSON.parse(localStorage.getItem(PROGRESS_STORE_V4) || '{}');
    const finalProgress = mergeProgressStore(localProgress, progressStore);

    setState(prev => ({
      ...prev, 
      books: mergedBooks, 
      readerSettings, 
      activeBookId: activeBookId || prev.activeBookId, 
      playbackSpeed, 
      selectedVoiceName, 
      theme, 
      lastSavedAt: snapshot.savedAt
    }));

    localStorage.setItem(PROGRESS_STORE_V4, JSON.stringify(finalProgress));
    
    // Notify components of progress changes
    window.dispatchEvent(new CustomEvent('talevox_progress_updated', { 
      detail: { bookId: activeBookId || stateRef.current.activeBookId } 
    }));
  }, []);

  const handleSaveState = useCallback(async (isCloudSave = true) => {
    const s = stateRef.current;
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
        progressStore
      }
    };
    
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snapshot));
    setState(prev => ({ ...prev, lastSavedAt: snapshot.savedAt }));

    if (isCloudSave && s.driveToken) {
      setIsSyncing(true);
      try {
        const existingFileId = await findFileSync(s.driveToken, STATE_FILENAME);
        await uploadToDrive(s.driveToken, null, STATE_FILENAME, JSON.stringify(snapshot), existingFileId || undefined, 'application/json');
        showToast("Synchronized to Cloud", 0, 'success');
      } catch (e) {
        showToast("Cloud Save Failed", 0, 'error');
        console.error(e);
      } finally {
        setIsSyncing(false);
      }
    } else {
      showToast("Checkpoint Saved (Local)", 0, 'success');
    }
  }, []);

  const handleSync = useCallback(async (manual = false) => {
    let token;
    try {
      token = await ensureDriveToken();
    } catch (e) { return; }

    setIsSyncing(true);
    try {
      const fileId = await findFileSync(token, STATE_FILENAME);
      if (!fileId) {
        if (manual) showToast("No Remote State Found", 0, 'info');
        setIsSyncing(false);
        return;
      }

      const remoteContent = await fetchDriveFile(token, fileId);
      const remoteSnapshot = JSON.parse(remoteContent) as SavedSnapshot;
      
      const localSnapshotStr = localStorage.getItem(SNAPSHOT_KEY);
      const localSnapshot = localSnapshotStr ? JSON.parse(localSnapshotStr) as SavedSnapshot : null;

      if (!localSnapshot || remoteSnapshot.savedAt > localSnapshot.savedAt || manual) {
        applySnapshot(remoteSnapshot);
        if (manual) showToast("Cloud Sync Complete", 0, 'success');
      } else {
        if (manual) showToast("Already Up to Date", 0, 'info');
      }
    } catch (err) { 
      console.error("Sync failed:", err); 
      showToast("Sync Failed", 0, 'error');
    } finally { 
      setIsSyncing(false); 
    }
  }, [ensureDriveToken, applySnapshot]);

  useEffect(() => {
    const handleProgressSync = (e: any) => {
      const { bookId, chapterId } = e.detail;
      const store = JSON.parse(localStorage.getItem(PROGRESS_STORE_V4) || '{}');
      
      setState(prev => ({
        ...prev,
        books: prev.books.map(b => b.id === bookId ? {
          ...b,
          chapters: b.chapters.map(c => {
            const saved = store[bookId]?.[c.id];
            if (saved) return { ...c, progress: saved.percent, isCompleted: saved.completed };
            return c;
          })
        } : b)
      }));
    };
    window.addEventListener('talevox_progress_updated', handleProgressSync);
    return () => window.removeEventListener('talevox_progress_updated', handleProgressSync);
  }, []);

  useEffect(() => {
    speechController.setFetchStateListener(f => setIsFetchingAudio(f));
  }, []);

  const saveCurrentStateLocal = useCallback(() => {
    const s = stateRef.current;
    const { driveToken, books, ...rest } = s;
    const persistentBooks = books.map(({ directoryHandle, ...b }) => ({ ...b, directoryHandle: undefined }));
    const activeBook = books.find(b => b.id === s.activeBookId);
    localStorage.setItem('talevox_pro_v2', JSON.stringify({ 
      ...rest, books: persistentBooks,
      lastSession: s.activeBookId && activeBook?.currentChapterId ? {
        bookId: s.activeBookId, chapterId: activeBook.currentChapterId, offsetChars: s.currentOffsetChars
      } : s.lastSession
    }));
  }, []);

  useEffect(() => { saveCurrentStateLocal(); }, [state, saveCurrentStateLocal]);

  const handlePause = useCallback(() => { 
    speechController.pause();
    setIsPlaying(false); 
  }, []);

  const handleJumpToOffset = useCallback((offset: number) => {
    if (!activeBook) return;
    const text = applyRules(activeChapterText, activeBook.rules);
    const boundedOffset = Math.min(Math.max(0, offset), text.length || 1);
    speechController.seekToOffset(boundedOffset);
  }, [activeBook, activeChapterText]);

  const handleSeekToTime = useCallback((time: number) => {
    speechController.seekToTime(time);
  }, []);

  const handleChapterExtracted = useCallback(async (data: { title: string; content: string; url: string; index: number }) => {
    const activeBookId = stateRef.current.activeBookId;
    if (!activeBookId) return;
    const book = stateRef.current.books.find(b => b.id === activeBookId);
    if (!book) return;

    const newChapter: Chapter = {
      id: crypto.randomUUID(), index: data.index, title: data.title, content: data.content,
      filename: `${data.index.toString().padStart(3, '0')}_${data.title.replace(/[^a-z0-9]/gi, '_').toLowerCase()}.txt`,
      wordCount: data.content.split(/\s+/).filter(Boolean).length, progress: 0
    };

    try {
      if (book.backend === StorageBackend.LOCAL && book.directoryHandle) {
        await saveChapterToFile(book.directoryHandle, newChapter);
      } else if (book.backend === StorageBackend.DRIVE && book.driveFolderId) {
        const token = await ensureDriveToken();
        const driveId = await uploadToDrive(token, book.driveFolderId, newChapter.filename, newChapter.content);
        newChapter.driveId = driveId;
      }
      setState(prev => ({
        ...prev,
        books: prev.books.map(b => b.id === activeBookId ? {
          ...b, chapters: [...b.chapters, newChapter].sort((a, b) => a.index - b.index),
          currentChapterId: b.currentChapterId || newChapter.id
        } : b)
      }));
      setIsAddChapterOpen(false);
      showToast("Chapter Imported", data.index, 'success');
    } catch (err) {
      console.error("Failed to save chapter:", err);
      showToast("Import Failed", 0, 'error');
    }
  }, [ensureDriveToken]);

  const loadChapterContent = useCallback(async (bookId: string, chapterId: string) => {
    const book = stateRef.current.books.find(b => b.id === bookId);
    const chapter = book?.chapters.find(c => c.id === chapterId);
    if (!book || !chapter) return;
    setIsLoadingChapter(true);
    try {
      let content = "";
      if (book.backend === StorageBackend.DRIVE) {
        const token = await ensureDriveToken();
        content = await fetchDriveFile(token, chapter.driveId!);
      } else if (book.backend === StorageBackend.LOCAL && book.directoryHandle) {
        content = await (await (await book.directoryHandle.getFileHandle(chapter.filename)).getFile()).text();
      } else content = chapter.content || "";
      
      const speakText = applyRules(content, book.rules);
      setActiveChapterText(content);
      
      speechController.updateMetadata(speakText.length, chapter.audioIntroDurSec || 0, chapter.audioChunkMap || []);
      speechController.setContext({ bookId, chapterId });
      
      const store = JSON.parse(localStorage.getItem(PROGRESS_STORE_V4) || '{}');
      const saved = store[bookId]?.[chapterId];
      if (saved) {
        setAudioCurrentTime(saved.timeSec);
        setAudioDuration(saved.durationSec);
        const offset = speechController.getOffsetFromTime(saved.timeSec, saved.durationSec);
        setState(p => ({ ...p, currentOffsetChars: offset }));
      } else {
        setAudioCurrentTime(0);
        setAudioDuration(0);
        setState(p => ({ ...p, currentOffsetChars: 0 }));
      }
    } catch (err) { 
      console.error(err);
      showToast("Load Failed", 0, 'error');
    } finally { setIsLoadingChapter(false); }
  }, [ensureDriveToken]);

  useEffect(() => {
    if (state.activeBookId && activeBook?.currentChapterId) loadChapterContent(state.activeBookId, activeBook.currentChapterId);
  }, [state.activeBookId, activeBook?.currentChapterId, loadChapterContent]);

  const handleNextChapter = useCallback(async () => {
    const book = stateRef.current.books.find(b => b.id === stateRef.current.activeBookId);
    if (!book) return;
    const currentIdx = book.chapters.findIndex(c => c.id === book.currentChapterId);
    if (currentIdx < book.chapters.length - 1) {
      const next = book.chapters[currentIdx + 1];
      showToast(next.title, next.index);
      setState(prev => ({ ...prev, books: prev.books.map(b => b.id === book.id ? { ...b, currentChapterId: next.id } : b), currentOffsetChars: 0 }));
    } else {
      setIsPlaying(false);
    }
  }, []);

  const handlePlay = useCallback(async () => {
    const s = stateRef.current;
    const book = s.books.find(b => b.id === s.activeBookId);
    if (!book || !book.currentChapterId) return;
    const chapter = book.chapters.find(c => c.id === book.currentChapterId);
    if (!chapter || !chapter.audioDriveId) { 
      showToast("No Audio Available", 0, 'error'); 
      setIsPlaying(false); 
      return; 
    }
    
    const text = applyRules(activeChapterText, book.rules);
    const speed = (book.settings.useBookSettings && book.settings.playbackSpeed) ? book.settings.playbackSpeed : s.playbackSpeed;
    
    setIsPlaying(true);
    const contentChars = text.length;
    const introDur = chapter.audioIntroDurSec || 0;

    try {
      const token = await ensureDriveToken();
      await speechController.loadAndPlayDriveFile(
        token, chapter.audioDriveId, contentChars, introDur, chapter.audioChunkMap, 0, speed,
        () => { if (stopAfterChapter) setIsPlaying(false); else handleNextChapter(); },
        (meta) => {
           setAudioCurrentTime(meta.currentTime);
           setAudioDuration(meta.duration);
           setState(prev => ({ ...prev, currentOffsetChars: meta.charOffset }));
        }
      );
    } catch (err) {
      setIsPlaying(false);
      if (err instanceof Error && err.name === 'NotAllowedError') showToast("Tap Play to Continue");
      else showToast("Playback Error", 0, 'error');
    }
  }, [activeChapterText, stopAfterChapter, handleNextChapter, ensureDriveToken]);

  useEffect(() => { if (isPlaying && activeChapterMetadata?.audioDriveId && activeChapterText) handlePlay(); }, [activeBook?.currentChapterId]);

  const processedTextLen = useMemo(() => {
    if (!activeChapterText || !activeBook) return 1;
    return applyRules(activeChapterText, activeBook.rules).length;
  }, [activeChapterText, activeBook?.rules]);

  // Lifecycle hardening for progress saving
  useEffect(() => {
    const handleSave = () => speechController.saveProgress();
    window.addEventListener('pagehide', handleSave);
    window.addEventListener('beforeunload', handleSave);
    return () => {
      window.removeEventListener('pagehide', handleSave);
      window.removeEventListener('beforeunload', handleSave);
    };
  }, []);

  return (
    <div className={`flex flex-col h-screen overflow-hidden font-sans transition-colors duration-500 ${state.theme === Theme.DARK ? 'bg-slate-950 text-slate-100' : state.theme === Theme.SEPIA ? 'bg-[#f4ecd8] text-[#3c2f25]' : 'bg-white text-black'}`}>
      <div className="flex flex-1 overflow-hidden relative">
        <Library 
          isOpen={isSidebarOpen} onClose={() => setIsSidebarOpen(false)} books={state.books} activeBookId={state.activeBookId} lastSession={state.lastSession} 
          onSelectBook={id => { speechController.stop(); setIsPlaying(false); setState(p => ({ ...p, activeBookId: id, currentOffsetChars: 0, books: p.books.map(b => b.id === id ? { ...b, currentChapterId: undefined } : b) })); setActiveTab('reader'); }} 
          onDeleteBook={id => setState(p => ({ ...p, books: p.books.filter(b => b.id !== id), activeBookId: p.activeBookId === id ? undefined : p.activeBookId }))} 
          onSelectChapter={(bid, cid, offsetChars) => { speechController.stop(); setIsPlaying(false); setState(p => ({ ...p, activeBookId: bid, books: p.books.map(b => b.id === bid ? { ...b, currentChapterId: cid } : b), currentOffsetChars: offsetChars ?? 0 })); setActiveTab('reader'); setIsSidebarOpen(false); }} 
          onDeleteChapter={(bid, cid) => {}} theme={state.theme} googleClientId={state.googleClientId}
          onAddBook={async (t, b, d, dfid, dfn) => {
            const newBook: Book = { id: crypto.randomUUID(), title: t, chapters: [], rules: [], backend: b, directoryHandle: d, driveFolderId: dfid, driveFolderName: dfn, settings: { useBookSettings: false, highlightMode: HighlightMode.WORD } };
            setState(prev => ({ ...prev, books: [...prev.books, newBook], activeBookId: newBook.id }));
          }}
        />
        <main className={`flex-1 flex flex-col min-w-0 shadow-2xl relative ${state.theme === Theme.DARK ? 'bg-slate-900' : state.theme === Theme.SEPIA ? 'bg-[#efe6d5]' : 'bg-white'}`}>
          <header className={`h-16 border-b flex items-center justify-between px-4 lg:px-8 z-10 sticky top-0 transition-colors ${state.theme === Theme.DARK ? 'border-slate-800 bg-slate-900/80 backdrop-blur-md' : state.theme === Theme.SEPIA ? 'border-[#d8ccb6] bg-[#efe6d5]/90 backdrop-blur-md' : 'border-black/5 bg-white/90 backdrop-blur-md'}`}>
            <div className="flex items-center gap-2 lg:gap-6"><button onClick={() => setIsSidebarOpen(true)} className="p-2 lg:hidden rounded-lg"><Menu className="w-5 h-5" /></button>
              <nav className="flex items-center gap-6">
                <button onClick={() => setActiveTab('reader')} className={`flex items-center gap-2 h-16 border-b-2 font-black uppercase text-[10px] tracking-widest ${activeTab === 'reader' ? 'border-indigo-600 text-indigo-600' : 'border-transparent opacity-60'}`}><BookText className="w-4 h-4" /> <span className="hidden sm:inline">Reader</span></button>
                <button onClick={() => setActiveTab('rules')} className={`flex items-center gap-2 h-16 border-b-2 font-black uppercase text-[10px] tracking-widest ${activeTab === 'rules' ? 'border-indigo-600 text-indigo-600' : 'border-transparent opacity-60'}`}><Zap className="w-4 h-4" /> <span className="hidden sm:inline">Rules</span></button>
                <button onClick={() => setActiveTab('settings')} className={`flex items-center gap-2 h-16 border-b-2 font-black uppercase text-[10px] tracking-widest ${activeTab === 'settings' ? 'border-indigo-600 text-indigo-600' : 'border-transparent opacity-60'}`}><SettingsIcon className="w-4 h-4" /> <span className="hidden sm:inline">Settings</span></button>
              </nav>
            </div>
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2">
                <button onClick={() => handleSaveState(true)} title="Save and Sync to Drive" className={`flex items-center gap-2 px-3 py-1.5 rounded-xl text-[9px] font-black uppercase tracking-widest bg-indigo-600/10 text-indigo-600 hover:bg-indigo-600/20 transition-all ${isSyncing ? 'animate-pulse' : ''}`}><Save className="w-3.5 h-3.5" /> <span className="hidden xs:inline">{isSyncing ? 'Saving...' : 'Sync'}</span></button>
              </div>
              <div className="flex items-center gap-1 p-1 rounded-xl bg-black/5">
                <button onClick={() => setState(p => ({ ...p, theme: Theme.LIGHT }))} className={`p-1.5 rounded-lg ${state.theme === Theme.LIGHT ? 'bg-white shadow-sm text-indigo-600' : 'opacity-60'}`}><Sun className="w-4 h-4" /></button>
                <button onClick={() => setState(p => ({ ...p, theme: Theme.SEPIA }))} className={`p-1.5 rounded-lg ${state.theme === Theme.SEPIA ? 'bg-[#f4ecd8] shadow-sm text-[#9c6644]' : 'opacity-60'}`}><Coffee className="w-4 h-4" /></button>
                <button onClick={() => setState(p => ({ ...p, theme: Theme.DARK }))} className={`p-1.5 rounded-lg ${state.theme === Theme.DARK ? 'bg-slate-800 shadow-sm text-indigo-400' : 'opacity-60'}`}><Moon className="w-5 h-5" /></button>
              </div>
            </div>
          </header>
          <div className="flex-1 overflow-y-auto relative">
             {isLoadingChapter && <div className="absolute inset-0 flex items-center justify-center bg-inherit z-5"><Loader2 className="w-10 h-10 text-indigo-600 animate-spin" /></div>}
             {isFetchingAudio && <div className="absolute inset-0 flex items-center justify-center bg-inherit/60 z-30 backdrop-blur-sm"><div className="flex flex-col items-center gap-4 bg-indigo-600 text-white p-8 rounded-3xl shadow-2xl"><Volume2 className="w-10 h-10 animate-bounce" /><span className="text-xs font-black uppercase tracking-widest">Loading Sync Map...</span></div></div>}
             {isAddChapterOpen && <div className="absolute inset-0 z-20 overflow-y-auto p-4 lg:p-12"><div className="max-w-4xl mx-auto relative"><button onClick={() => setIsAddChapterOpen(false)} className="absolute -top-4 -right-4 p-3 bg-white text-black shadow-2xl rounded-full hover:scale-110 active:scale-95 transition-transform"><X className="w-6 h-6" /></button><Extractor onChapterExtracted={handleChapterExtracted} suggestedIndex={activeBook?.chapters.length ? Math.max(...activeBook.chapters.map(c => c.index)) + 1 : 1} theme={state.theme} /></div></div>}
             {activeTab === 'reader' ? (activeBook ? (activeBook.currentChapterId ? <Reader chapter={activeChapterMetadata || null} rules={activeBook.rules} currentOffsetChars={state.currentOffsetChars} theme={state.theme} debugMode={state.debugMode} onToggleDebug={() => setState(p => ({ ...p, debugMode: !p.debugMode }))} onJumpToOffset={handleJumpToOffset} highlightMode={activeBook.settings.highlightMode} onBackToChapters={() => setState(p => ({ ...p, books: p.books.map(b => b.id === p.activeBookId ? { ...b, currentChapterId: undefined } : b) }))} onAddChapter={() => setIsAddChapterOpen(true)} readerSettings={state.readerSettings} /> : <ChapterFolderView book={activeBook} theme={state.theme} onAddChapter={() => setIsAddChapterOpen(true)} onOpenChapter={id => setState(p => ({ ...p, books: p.books.map(b => b.id === activeBook.id ? { ...b, currentChapterId: id } : b), currentOffsetChars: 0 }))} onToggleFavorite={() => {}} onUpdateChapterTitle={(id, nt) => setState(p => ({ ...p, books: p.books.map(b => b.id === activeBook.id ? { ...b, chapters: b.chapters.map(c => c.id === id ? { ...c, title: nt } : c) } : b) }))} onDeleteChapter={id => setState(p => ({ ...p, books: p.books.map(b => b.id === activeBook.id ? { ...b, chapters: b.chapters.filter(c => c.id !== id), currentChapterId: b.currentChapterId === id ? undefined : b.currentChapterId } : b) }))} onUpdateChapter={c => setState(p => ({ ...p, books: p.books.map(b => b.id === activeBook.id ? { ...b, chapters: b.chapters.map(ch => ch.id === c.id ? c : ch) } : b) }))} onUpdateBookSettings={s => setState(p => ({ ...p, books: p.books.map(b => b.id === activeBook.id ? { ...b, settings: { ...b.settings, ...s } } : b) }))} driveToken={state.driveToken} />) : <div className="h-full flex items-center justify-center font-black text-lg opacity-40 uppercase">Select a book to begin</div>) : activeTab === 'rules' ? <RuleManager rules={activeBook?.rules || []} theme={state.theme} onAddRule={r => setState(p => ({ ...p, books: p.books.map(b => b.id === p.activeBookId ? { ...b, rules: [...b.rules, r] } : b) }))} onUpdateRule={r => setState(p => ({ ...p, books: p.books.map(b => b.id === p.activeBookId ? { ...b, rules: b.rules.map(o => o.id === r.id ? r : o) } : b) }))} onDeleteRule={id => setState(p => ({ ...p, books: p.books.map(b => b.id === p.activeBookId ? { ...b, rules: b.rules.filter(r => r.id !== id) } : b) }))} onImportRules={nr => setState(p => ({ ...p, books: p.books.map(b => b.id === p.activeBookId ? { ...b, rules: nr } : b) }))} selectedVoice={(activeBook?.settings.useBookSettings && activeBook.settings.selectedVoiceName) ? activeBook.settings.selectedVoiceName : state.selectedVoiceName || ''} playbackSpeed={(activeBook?.settings.useBookSettings && activeBook.settings.playbackSpeed) ? activeBook.settings.playbackSpeed : state.playbackSpeed} /> : <Settings settings={state.readerSettings} onUpdate={s => setState(p => ({ ...p, readerSettings: { ...p.readerSettings, ...s } }))} theme={state.theme} keepAwake={state.keepAwake} onSetKeepAwake={v => setState(p => ({ ...p, keepAwake: v }))} onCheckForUpdates={() => window.location.reload()} isCloudLinked={!!state.driveToken} onLinkCloud={async () => { const t = await authenticateDrive(state.googleClientId); setState(p => ({ ...p, driveToken: t })); }} onSyncNow={() => handleSync(true)} isSyncing={isSyncing} googleClientId={state.googleClientId} onUpdateGoogleClientId={id => setState(p => ({ ...p, googleClientId: id }))} onClearAuth={() => setState(p => ({ ...p, driveToken: undefined }))} onSaveState={() => handleSaveState(true)} lastSavedAt={state.lastSavedAt} />}
          </div>
          {activeChapterMetadata && activeTab === 'reader' && (
            <Player 
              isPlaying={isPlaying} onPlay={handlePlay} onPause={handlePause} onStop={() => { speechController.stop(); setIsPlaying(false); }} onNext={handleNextChapter} onPrev={() => {}} onSeek={d => handleJumpToOffset(state.currentOffsetChars + d)}
              speed={(activeBook?.settings.useBookSettings && activeBook.settings.playbackSpeed) ? activeBook.settings.playbackSpeed : state.playbackSpeed} onSpeedChange={s => setState(prev => prev.books.find(b => b.id === prev.activeBookId)?.settings.useBookSettings ? { ...prev, books: prev.books.map(b => b.id === prev.activeBookId ? { ...b, settings: { ...b.settings, playbackSpeed: s } } : b) } : { ...prev, playbackSpeed: s })}
              selectedVoice={activeBook?.settings.defaultVoiceId || ''} onVoiceChange={() => {}} theme={state.theme} onThemeChange={() => {}} progressChars={state.currentOffsetChars} totalLengthChars={processedTextLen} wordCount={activeChapterMetadata.wordCount} onSeekToOffset={handleJumpToOffset}
              sleepTimer={sleepTimerSeconds} onSetSleepTimer={setSleepTimerSeconds} stopAfterChapter={stopAfterChapter} onSetStopAfterChapter={setStopAfterChapter} useBookSettings={activeBook?.settings.useBookSettings || false} onSetUseBookSettings={v => setState(p => ({ ...p, books: p.books.map(b => b.id === p.activeBookId ? { ...b, settings: { ...b.settings, useBookSettings: v } } : b) }))}
              highlightMode={activeBook?.settings.highlightMode || HighlightMode.WORD} onSetHighlightMode={m => setState(p => ({ ...p, books: p.books.map(b => b.id === b.id ? { ...b, settings: { ...b.settings, highlightMode: m } } : b) }))} playbackCurrentTime={audioCurrentTime} playbackDuration={audioDuration} isFetching={isFetchingAudio} onSeekToTime={handleSeekToTime}
            />
          )}
        </main>
      </div>
      {transitionToast && <div className="fixed bottom-32 left-1/2 -translate-x-1/2 z-[100] toast-animate"><div className={`${transitionToast.type === 'success' ? 'bg-emerald-600' : transitionToast.type === 'error' ? 'bg-red-600' : 'bg-indigo-600'} text-white px-8 py-4 rounded-2xl shadow-2xl font-black text-sm flex items-center gap-4`}>{transitionToast.type === 'error' ? <AlertCircle className="w-5 h-5" /> : transitionToast.number === 0 && transitionToast.type !== 'success' ? <RefreshCw className="w-5 h-5 animate-spin" /> : transitionToast.type === 'success' ? <Save className="w-5 h-5" /> : null}{transitionToast.number > 0 ? `Chapter ${transitionToast.number}: ${transitionToast.title}` : transitionToast.title}</div></div>}
    </div>
  );
};

export default App;