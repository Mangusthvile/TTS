
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
import { BookText, Zap, Sun, Coffee, Moon, X, Settings as SettingsIcon, Menu, RefreshCw, Loader2, Cloud, Volume2, Save } from 'lucide-react';

const SYNC_FILENAME = 'talevox_sync_manifest_json_v4.json'; 
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
  const [transitionToast, setTransitionToast] = useState<{ number: number; title: string; type?: 'info' | 'success' } | null>(null);
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

  const showToast = (title: string, number = 0, type: 'info' | 'success' = 'info') => {
    setTransitionToast({ number, title, type });
    setTimeout(() => setTransitionToast(null), 3500);
  };

  const applySnapshot = useCallback((snapshot: SavedSnapshot) => {
    const { books, readerSettings, activeBookId, playbackSpeed, selectedVoiceName, theme, progressStore } = snapshot.state;
    setState(prev => ({
      ...prev, books, readerSettings, activeBookId, playbackSpeed, selectedVoiceName, theme, lastSavedAt: snapshot.savedAt
    }));
    localStorage.setItem(PROGRESS_STORE_V4, JSON.stringify(progressStore));
    if (activeBookId) {
      window.dispatchEvent(new CustomEvent('talevox_progress_updated', { 
        detail: { bookId: activeBookId, chapterId: books.find(b => b.id === activeBookId)?.currentChapterId } 
      }));
    }
  }, []);

  const handleSaveState = useCallback(() => {
    const s = stateRef.current;
    const progressStore = JSON.parse(localStorage.getItem(PROGRESS_STORE_V4) || '{}');
    const snapshot: SavedSnapshot = {
      version: "v1", savedAt: Date.now(),
      state: {
        books: s.books.map(({ directoryHandle, ...b }) => ({ ...b, directoryHandle: undefined })),
        readerSettings: s.readerSettings, activeBookId: s.activeBookId,
        playbackSpeed: s.playbackSpeed, selectedVoiceName: s.selectedVoiceName,
        theme: s.theme, progressStore
      }
    };
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snapshot));
    setState(prev => ({ ...prev, lastSavedAt: snapshot.savedAt }));
    showToast(`App State Frozen: ${new Date(snapshot.savedAt).toLocaleTimeString()}`, 0, 'success');
  }, []);

  useEffect(() => {
    const handleProgressSync = (e: any) => {
      const { bookId, chapterId } = e.detail;
      const store = JSON.parse(localStorage.getItem(PROGRESS_STORE_V4) || '{}');
      const saved = store[bookId]?.[chapterId];
      if (saved) {
        setState(prev => ({
          ...prev,
          books: prev.books.map(b => b.id === bookId ? {
            ...b,
            chapters: b.chapters.map(c => c.id === chapterId ? {
              ...c, progress: saved.percent, isCompleted: saved.completed
            } : c)
          } : b)
        }));
      }
    };
    window.addEventListener('talevox_progress_updated', handleProgressSync);
    return () => window.removeEventListener('talevox_progress_updated', handleProgressSync);
  }, []);

  useEffect(() => {
    speechController.setFetchStateListener(f => setIsFetchingAudio(f));
  }, []);

  const saveCurrentState = useCallback(() => {
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

  useEffect(() => { saveCurrentState(); }, [state, saveCurrentState]);

  const handlePause = useCallback(() => { 
    speechController.pause();
    setIsPlaying(false); 
  }, []);

  const handleJumpToOffset = useCallback((offset: number) => {
    if (!activeBook) return;
    const text = applyRules(activeChapterText, activeBook.rules);
    const boundedOffset = Math.min(Math.max(0, offset), text.length || 1);
    speechController.seekToOffset(boundedOffset);
    // currentOffsetChars will be updated via engine onSync callback
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
      } else if (book.backend === StorageBackend.DRIVE && stateRef.current.driveToken && book.driveFolderId) {
        // Fix: Changed first arg from stateRef.current.driveFolderId to driveToken
        // and second arg from null to book.driveFolderId to fix drive extraction error.
        const driveId = await uploadToDrive(stateRef.current.driveToken!, book.driveFolderId, newChapter.filename, newChapter.content);
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
    } catch (err) {
      console.error("Failed to save chapter:", err);
      alert("Error saving chapter: " + (err instanceof Error ? err.message : String(err)));
    }
  }, []);

  const loadChapterContent = useCallback(async (bookId: string, chapterId: string) => {
    const book = stateRef.current.books.find(b => b.id === bookId);
    const chapter = book?.chapters.find(c => c.id === chapterId);
    if (!book || !chapter) return;
    setIsLoadingChapter(true);
    try {
      let content = "";
      if (book.backend === StorageBackend.DRIVE && stateRef.current.driveToken) content = await fetchDriveFile(stateRef.current.driveToken, chapter.driveId!);
      else if (book.backend === StorageBackend.LOCAL && book.directoryHandle) content = await (await (await book.directoryHandle.getFileHandle(chapter.filename)).getFile()).text();
      else content = chapter.content || "";
      
      const speakText = applyRules(content, book.rules);
      setActiveChapterText(content);
      
      // Warm up metadata for the highlight engine (v2.6.2)
      speechController.updateMetadata(speakText.length, chapter.audioIntroDurSec || 0, chapter.audioChunkMap || []);
      speechController.setContext({ bookId, chapterId });
      
      const store = JSON.parse(localStorage.getItem(PROGRESS_STORE_V4) || '{}');
      const saved = store[bookId]?.[chapterId];
      if (saved) {
        setAudioCurrentTime(saved.timeSec);
        setAudioDuration(saved.durationSec);
        
        // Compute initial offset for highlight even before playing
        const offset = speechController.getOffsetFromTime(saved.timeSec, saved.durationSec);
        setState(p => ({ ...p, currentOffsetChars: offset }));
      } else {
        setAudioCurrentTime(0);
        setAudioDuration(0);
        setState(p => ({ ...p, currentOffsetChars: 0 }));
      }
    } catch (err) { alert(`Error loading chapter: ${err}`); } finally { setIsLoadingChapter(false); }
  }, []);

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
    const book = stateRef.current.books.find(b => b.id === stateRef.current.activeBookId);
    if (!book || !book.currentChapterId || !stateRef.current.driveToken) return;
    const chapter = book.chapters.find(c => c.id === book.currentChapterId);
    if (!chapter || !chapter.audioDriveId) { alert("Audio not generated yet."); setIsPlaying(false); return; }
    
    const text = applyRules(activeChapterText, book.rules);
    const speed = (book.settings.useBookSettings && book.settings.playbackSpeed) ? book.settings.playbackSpeed : stateRef.current.playbackSpeed;
    
    setIsPlaying(true);
    const contentChars = text.length;
    const introDur = chapter.audioIntroDurSec || 0;

    try {
      await speechController.loadAndPlayDriveFile(
        stateRef.current.driveToken, chapter.audioDriveId, contentChars, introDur, chapter.audioChunkMap, 0, speed,
        () => { if (stopAfterChapter) setIsPlaying(false); else handleNextChapter(); },
        (meta) => {
           setAudioCurrentTime(meta.currentTime);
           setAudioDuration(meta.duration);
           // Crucial Fix: update character offset for Reader highlighting
           setState(prev => ({ ...prev, currentOffsetChars: meta.charOffset }));
        }
      );
    } catch (err) {
      setIsPlaying(false);
      if (err instanceof Error && err.name === 'NotAllowedError') showToast("Tap Play to continue");
    }
  }, [activeChapterText, stopAfterChapter, handleNextChapter]);

  useEffect(() => { if (isPlaying && activeChapterMetadata?.audioDriveId && activeChapterText) handlePlay(); }, [activeBook?.currentChapterId]);

  const handleSync = useCallback(async (manual = false) => {
    if (!state.driveToken) return;
    const snapshotStr = localStorage.getItem(SNAPSHOT_KEY);
    if (!snapshotStr) {
      if (confirm("No saved snapshot. Save current state now?")) { handleSaveState(); } else return;
    }
    const currentSnapshot = JSON.parse(localStorage.getItem(SNAPSHOT_KEY)!) as SavedSnapshot;
    setIsSyncing(true);
    try {
      const existingFileId = await findFileSync(state.driveToken, SYNC_FILENAME);
      if (existingFileId) {
        const remoteData = JSON.parse(await fetchDriveFile(state.driveToken, existingFileId)) as SavedSnapshot;
        if (remoteData.savedAt > currentSnapshot.savedAt) {
          if (confirm(`Cloud has a newer saved state (${new Date(remoteData.savedAt).toLocaleString()}). Load it?`)) {
            localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(remoteData));
            applySnapshot(remoteData);
            showToast("Cloud State Applied", 0, 'success');
            setIsSyncing(false);
            return;
          }
        }
      }
      await uploadToDrive(state.driveToken, null, SYNC_FILENAME, JSON.stringify(currentSnapshot), existingFileId || undefined, 'application/json');
      applySnapshot(currentSnapshot);
      if (manual) showToast("Synced to Cloud", 0, 'success');
    } catch (err) { console.error("Sync failed:", err); alert("Sync failed. Check connection.");
    } finally { setIsSyncing(false); }
  }, [state.driveToken, applySnapshot, handleSaveState]);

  const processedTextLen = useMemo(() => {
    if (!activeChapterText || !activeBook) return 1;
    return applyRules(activeChapterText, activeBook.rules).length;
  }, [activeChapterText, activeBook?.rules]);

  return (
    <div className={`flex flex-col h-screen overflow-hidden font-sans transition-colors duration-500 ${state.theme === Theme.DARK ? 'bg-slate-950 text-slate-100' : state.theme === Theme.SEPIA ? 'bg-[#f4ecd8] text-[#3c2f25]' : 'bg-white text-black'}`}>
      <div className="flex flex-1 overflow-hidden relative">
        <Library 
          isOpen={isSidebarOpen} onClose={() => setIsSidebarOpen(false)} books={state.books} activeBookId={state.activeBookId} lastSession={state.lastSession} 
          onSelectBook={id => { speechController.stop(); setIsPlaying(false); setState(p => ({ ...p, activeBookId: id, currentOffsetChars: 0, books: p.books.map(b => b.id === id ? { ...b, currentChapterId: undefined } : b) })); setActiveTab('reader'); }} 
          onDeleteBook={id => setState(p => ({ ...p, books: p.books.filter(b => b.id !== id), activeBookId: p.activeBookId === id ? undefined : p.activeBookId }))} 
          // Fix: offset parameter renamed to offsetChars to be consistent with AppState
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
                <button onClick={handleSaveState} title="Save App State Checkpoint" className={`flex items-center gap-2 px-3 py-1.5 rounded-xl text-[9px] font-black uppercase tracking-widest bg-emerald-600/10 text-emerald-500 hover:bg-emerald-600/20 transition-all`}><Save className="w-3.5 h-3.5" /> <span className="hidden xs:inline">Save</span></button>
                {state.driveToken && <button onClick={() => handleSync(true)} className={`flex items-center gap-2 px-3 py-1.5 rounded-xl text-[9px] font-black uppercase tracking-widest ${isSyncing ? 'text-indigo-500 animate-pulse' : 'text-slate-400 hover:text-indigo-500'}`}><Cloud className="w-3.5 h-3.5" /> {isSyncing ? 'Syncing...' : <span className="hidden xs:inline">Sync</span>}</button>}
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
             {activeTab === 'reader' ? (activeBook ? (activeBook.currentChapterId ? <Reader chapter={activeChapterMetadata || null} rules={activeBook.rules} currentOffsetChars={state.currentOffsetChars} theme={state.theme} debugMode={state.debugMode} onToggleDebug={() => setState(p => ({ ...p, debugMode: !p.debugMode }))} onJumpToOffset={handleJumpToOffset} highlightMode={activeBook.settings.highlightMode} onBackToChapters={() => setState(p => ({ ...p, books: p.books.map(b => b.id === p.activeBookId ? { ...b, currentChapterId: undefined } : b) }))} onAddChapter={() => setIsAddChapterOpen(true)} readerSettings={state.readerSettings} /> : <ChapterFolderView book={activeBook} theme={state.theme} onAddChapter={() => setIsAddChapterOpen(true)} onOpenChapter={id => setState(p => ({ ...p, books: p.books.map(b => b.id === activeBook.id ? { ...b, currentChapterId: id } : b), currentOffsetChars: 0 }))} onToggleFavorite={() => {}} onUpdateChapterTitle={(id, nt) => setState(p => ({ ...p, books: p.books.map(b => b.id === activeBook.id ? { ...b, chapters: b.chapters.map(c => c.id === id ? { ...c, title: nt } : c) } : b) }))} onDeleteChapter={id => setState(p => ({ ...p, books: p.books.map(b => b.id === activeBook.id ? { ...b, chapters: b.chapters.filter(c => c.id !== id), currentChapterId: b.currentChapterId === id ? undefined : b.currentChapterId } : b) }))} onUpdateChapter={c => setState(p => ({ ...p, books: p.books.map(b => b.id === activeBook.id ? { ...b, chapters: b.chapters.map(ch => ch.id === c.id ? c : ch) } : b) }))} onUpdateBookSettings={s => setState(p => ({ ...p, books: p.books.map(b => b.id === activeBook.id ? { ...b, settings: { ...b.settings, ...s } } : b) }))} driveToken={state.driveToken} />) : <div className="h-full flex items-center justify-center font-black text-lg opacity-40 uppercase">Select a book to begin</div>) : activeTab === 'rules' ? <RuleManager rules={activeBook?.rules || []} theme={state.theme} onAddRule={r => setState(p => ({ ...p, books: p.books.map(b => b.id === p.activeBookId ? { ...b, rules: [...b.rules, r] } : b) }))} onUpdateRule={r => setState(p => ({ ...p, books: p.books.map(b => b.id === p.activeBookId ? { ...b, rules: b.rules.map(o => o.id === r.id ? r : o) } : b) }))} onDeleteRule={id => setState(p => ({ ...p, books: p.books.map(b => b.id === p.activeBookId ? { ...b, rules: b.rules.filter(r => r.id !== id) } : b) }))} onImportRules={nr => setState(p => ({ ...p, books: p.books.map(b => b.id === p.activeBookId ? { ...b, rules: nr } : b) }))} selectedVoice={(activeBook?.settings.useBookSettings && activeBook.settings.selectedVoiceName) ? activeBook.settings.selectedVoiceName : state.selectedVoiceName || ''} playbackSpeed={(activeBook?.settings.useBookSettings && activeBook.settings.playbackSpeed) ? activeBook.settings.playbackSpeed : state.playbackSpeed} /> : <Settings settings={state.readerSettings} onUpdate={s => setState(p => ({ ...p, readerSettings: { ...p.readerSettings, ...s } }))} theme={state.theme} keepAwake={state.keepAwake} onSetKeepAwake={v => setState(p => ({ ...p, keepAwake: v }))} onCheckForUpdates={() => window.location.reload()} isCloudLinked={!!state.driveToken} onLinkCloud={async () => { const t = await authenticateDrive(state.googleClientId); setState(p => ({ ...p, driveToken: t })); }} onSyncNow={() => handleSync(true)} isSyncing={isSyncing} googleClientId={state.googleClientId} onUpdateGoogleClientId={id => setState(p => ({ ...p, googleClientId: id }))} onClearAuth={() => setState(p => ({ ...p, driveToken: undefined }))} onSaveState={handleSaveState} lastSavedAt={state.lastSavedAt} />}
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
      {transitionToast && <div className="fixed bottom-32 left-1/2 -translate-x-1/2 z-[100] toast-animate"><div className={`${transitionToast.type === 'success' ? 'bg-emerald-600' : 'bg-indigo-600'} text-white px-8 py-4 rounded-2xl shadow-2xl font-black text-sm flex items-center gap-4`}>{transitionToast.number === 0 && transitionToast.type !== 'success' ? <RefreshCw className="w-5 h-5 animate-spin" /> : transitionToast.type === 'success' ? <Save className="w-5 h-5" /> : null}{transitionToast.number > 0 ? `Chapter ${transitionToast.number}: ${transitionToast.title}` : transitionToast.title}</div></div>}
    </div>
  );
};

export default App;
