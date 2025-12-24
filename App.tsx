
import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Book, Chapter, AppState, Theme, HighlightMode, StorageBackend, ReaderSettings, RuleType, Rule, SavedSnapshot, AudioStatus } from './types';
import Library from './components/Library';
import Reader from './components/Reader';
import Player from './components/Player';
import RuleManager from './components/RuleManager';
import Settings from './components/Settings';
import Extractor from './components/Extractor';
import ChapterFolderView from './components/ChapterFolderView';
import { speechController, applyRules, PROGRESS_STORE_V4 } from './services/speechService';
import { fetchDriveFile, uploadToDrive, deleteDriveFile, findFileSync, buildMp3Name } from './services/driveService';
import { initDriveAuth, getValidDriveToken, clearStoredToken } from './services/driveAuth';
import { saveChapterToFile } from './services/fileService';
import { synthesizeChunk } from './services/cloudTtsService';
import { saveAudioToCache, getAudioFromCache, generateAudioKey } from './services/audioCache';
import { BookText, Zap, Sun, Coffee, Moon, X, Settings as SettingsIcon, RefreshCw, Loader2, Cloud, Volume2, Save, AlertCircle, LogIn, Library as LibraryIcon } from 'lucide-react';

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
        paragraphSpacing: 1,
        highlightColor: '#4f46e5',
        followHighlight: true
      },
      googleClientId: parsed.googleClientId || (import.meta as any).env?.VITE_GOOGLE_CLIENT_ID || '',
      lastSession: parsed.lastSession,
      lastSavedAt: snapshot?.savedAt
    };
  });

  const [activeTab, setActiveTab] = useState<'library' | 'collection' | 'reader' | 'rules' | 'settings'>('library');
  const [isAddChapterOpen, setIsAddChapterOpen] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [activeChapterText, setActiveChapterText] = useState<string>('');
  const [isLoadingChapter, setIsLoadingChapter] = useState(false);
  const [isFetchingAudio, setIsFetchingAudio] = useState(false);
  const [transitionToast, setTransitionToast] = useState<{ number: number; title: string; type?: 'info' | 'success' | 'error' | 'reconnect' } | null>(null);
  const [sleepTimerSeconds, setSleepTimerSeconds] = useState<number | null>(null);
  const [stopAfterChapter, setStopAfterChapter] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [audioDuration, setAudioDuration] = useState(0);
  const [audioCurrentTime, setAudioCurrentTime] = useState(0);

  const stateRef = useRef(state);
  useEffect(() => { stateRef.current = state; }, [state]);

  const activeBook = useMemo(() => state.books.find(b => b.id === state.activeBookId), [state.books, state.activeBookId]);
  const activeChapterMetadata = useMemo(() => activeBook?.chapters.find(c => c.id === activeBook.currentChapterId), [activeBook]);

  useEffect(() => {
    document.documentElement.style.setProperty('--highlight-color', state.readerSettings.highlightColor);
  }, [state.readerSettings.highlightColor]);

  useEffect(() => {
    if (state.googleClientId) initDriveAuth(state.googleClientId);
  }, [state.googleClientId]);

  const showToast = (title: string, number = 0, type: 'info' | 'success' | 'error' | 'reconnect' = 'info') => {
    setTransitionToast({ number, title, type });
    if (type !== 'reconnect') setTimeout(() => setTransitionToast(null), 3500);
  };

  const handleSaveState = useCallback(async (isCloudSave = true) => {
    const s = stateRef.current;
    const progressStore = JSON.parse(localStorage.getItem(PROGRESS_STORE_V4) || '{}');
    const snapshot: SavedSnapshot = {
      version: "v1", savedAt: Date.now(),
      state: { books: s.books.map(({ directoryHandle, ...b }) => ({ ...b, directoryHandle: undefined })), readerSettings: s.readerSettings, activeBookId: s.activeBookId, playbackSpeed: s.playbackSpeed, selectedVoiceName: s.selectedVoiceName, theme: s.theme, progressStore }
    };
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snapshot));
    setState(prev => ({ ...prev, lastSavedAt: snapshot.savedAt }));
    if (isCloudSave) {
      setIsSyncing(true);
      try {
        const fileId = await findFileSync(STATE_FILENAME);
        await uploadToDrive(null, STATE_FILENAME, JSON.stringify(snapshot), fileId || undefined, 'application/json');
        showToast("Synchronized to Cloud", 0, 'success');
      } catch (e: any) {
        showToast(e.message === "Reconnect Google Drive" ? "Drive Expired" : "Cloud Sync Failed", 0, e.message === "Reconnect Google Drive" ? 'reconnect' : 'error');
      } finally { setIsSyncing(false); }
    }
  }, []);

  const queueBackgroundTTS = useCallback(async (bookId: string, chapterId: string) => {
    const s = stateRef.current;
    const book = s.books.find(b => b.id === bookId);
    const chapter = book?.chapters.find(c => c.id === chapterId);
    if (!book || !chapter || chapter.audioStatus === AudioStatus.READY) return;

    // Check cache first
    const voice = book.settings.defaultVoiceId || 'en-US-Standard-C';
    const rawIntro = `Chapter ${chapter.index}. ${chapter.title}. `;
    const introText = applyRules(rawIntro, book.rules);
    const contentText = applyRules(chapter.content, book.rules);
    const cacheKey = generateAudioKey(introText + contentText, voice, 1.0);
    const cached = await getAudioFromCache(cacheKey);
    if (cached) {
      updateChapterAudio(bookId, chapterId, { audioStatus: AudioStatus.READY, hasCachedAudio: true });
      return;
    }

    // Process
    updateChapterAudio(bookId, chapterId, { audioStatus: AudioStatus.GENERATING });
    try {
      const res = await synthesizeChunk(introText + contentText, voice, 1.0);
      const audioBlob = await fetch(res.audioUrl).then(r => r.blob());
      await saveAudioToCache(cacheKey, audioBlob);
      updateChapterAudio(bookId, chapterId, { audioStatus: AudioStatus.READY, hasCachedAudio: true });
    } catch (e) {
      updateChapterAudio(bookId, chapterId, { audioStatus: AudioStatus.FAILED });
    }
  }, []);

  const updateChapterAudio = (bookId: string, chapterId: string, updates: Partial<Chapter>) => {
    setState(prev => ({
      ...prev,
      books: prev.books.map(b => b.id === bookId ? {
        ...b, chapters: b.chapters.map(c => c.id === chapterId ? { ...c, ...updates } : c)
      } : b)
    }));
  };

  const handleChapterExtracted = useCallback(async (data: { title: string; content: string; url: string; index: number }) => {
    if (!stateRef.current.activeBookId) return;
    const newChapter: Chapter = {
      id: crypto.randomUUID(), index: data.index, title: data.title, content: data.content,
      filename: `${data.index.toString().padStart(3, '0')}_${data.title.replace(/[^a-z0-9]/gi, '_').toLowerCase()}.txt`,
      wordCount: data.content.split(/\s+/).filter(Boolean).length, progress: 0, audioStatus: AudioStatus.PENDING
    };
    setState(prev => ({
      ...prev,
      books: prev.books.map(b => b.id === prev.activeBookId ? { ...b, chapters: [...b.chapters, newChapter].sort((a,b) => a.index-b.index) } : b)
    }));
    setIsAddChapterOpen(false);
    queueBackgroundTTS(stateRef.current.activeBookId, newChapter.id);
  }, [queueBackgroundTTS]);

  const handlePlay = useCallback(async () => {
    const s = stateRef.current;
    const book = s.books.find(b => b.id === s.activeBookId);
    if (!book || !book.currentChapterId) return;
    const chapter = book.chapters.find(c => c.id === book.currentChapterId);
    if (!chapter) return;

    setIsPlaying(true);
    const voice = book.settings.defaultVoiceId || 'en-US-Standard-C';
    const text = applyRules(chapter.content, book.rules);
    const speed = (book.settings.useBookSettings && book.settings.playbackSpeed) ? book.settings.playbackSpeed : s.playbackSpeed;

    try {
      // Local cache or drive logic simplified for demo - priority to cached/just-generated blobs
      const rawIntro = `Chapter ${chapter.index}. ${chapter.title}. `;
      const introText = applyRules(rawIntro, book.rules);
      const cacheKey = generateAudioKey(introText + text, voice, 1.0);
      const cachedBlob = await getAudioFromCache(cacheKey);

      if (cachedBlob) {
        const url = URL.createObjectURL(cachedBlob);
        speechController.loadAndPlayDriveFile('', 'LOCAL_ID', text.length, 0, undefined, 0, speed, 
          () => { if (stopAfterChapter) setIsPlaying(false); else handleNextChapter(); },
          (meta) => { setAudioCurrentTime(meta.currentTime); setAudioDuration(meta.duration); setState(p => ({ ...p, currentOffsetChars: meta.charOffset })); },
          url // Optional local override passed to speechController
        );
      } else {
        showToast("Audio generating...", 0, 'info');
        await queueBackgroundTTS(s.activeBookId!, chapter.id);
        handlePlay();
      }
    } catch (e) { setIsPlaying(false); showToast("Playback Error", 0, 'error'); }
  }, [queueBackgroundTTS]);

  const handleNextChapter = useCallback(() => {
    const b = activeBook; if (!b) return;
    const idx = b.chapters.findIndex(c => c.id === b.currentChapterId);
    if (idx < b.chapters.length - 1) {
      const next = b.chapters[idx + 1];
      setState(p => ({ ...p, books: p.books.map(bk => bk.id === bk.id ? { ...bk, currentChapterId: next.id } : bk), currentOffsetChars: 0 }));
    } else setIsPlaying(false);
  }, [activeBook]);

  const handlePause = () => { speechController.pause(); setIsPlaying(false); };
  const handleSeekToTime = (t: number) => speechController.seekToTime(t);
  const handleJumpToOffset = (o: number) => speechController.seekToOffset(o);

  useEffect(() => {
    localStorage.setItem('talevox_pro_v2', JSON.stringify({ ...state, books: state.books.map(({ directoryHandle, ...b }) => ({ ...b, directoryHandle: undefined })) }));
  }, [state]);

  return (
    <div className={`flex flex-col h-screen overflow-hidden font-sans transition-colors duration-500 ${state.theme === Theme.DARK ? 'bg-slate-950 text-slate-100' : state.theme === Theme.SEPIA ? 'bg-[#f4ecd8] text-[#3c2f25]' : 'bg-white text-black'}`}>
      <header className={`h-16 border-b flex items-center justify-between px-4 lg:px-8 z-10 sticky top-0 transition-colors ${state.theme === Theme.DARK ? 'border-slate-800 bg-slate-900/80 backdrop-blur-md' : state.theme === Theme.SEPIA ? 'border-[#d8ccb6] bg-[#efe6d5]/90 backdrop-blur-md' : 'border-black/5 bg-white/90 backdrop-blur-md'}`}>
        <nav className="flex items-center gap-6">
          <button onClick={() => setActiveTab('library')} className={`flex items-center gap-2 h-16 border-b-2 font-black uppercase text-[10px] tracking-widest ${activeTab === 'library' || activeTab === 'collection' ? 'border-indigo-600 text-indigo-600' : 'border-transparent opacity-60'}`}><LibraryIcon className="w-4 h-4" /> Library</button>
          <button onClick={() => setActiveTab('rules')} className={`flex items-center gap-2 h-16 border-b-2 font-black uppercase text-[10px] tracking-widest ${activeTab === 'rules' ? 'border-indigo-600 text-indigo-600' : 'border-transparent opacity-60'}`}><Zap className="w-4 h-4" /> Rules</button>
          <button onClick={() => setActiveTab('settings')} className={`flex items-center gap-2 h-16 border-b-2 font-black uppercase text-[10px] tracking-widest ${activeTab === 'settings' ? 'border-indigo-600 text-indigo-600' : 'border-transparent opacity-60'}`}><SettingsIcon className="w-4 h-4" /> Settings</button>
        </nav>
        <div className="flex items-center gap-4">
          <button onClick={() => handleSaveState(true)} className={`p-2 rounded-xl bg-indigo-600/10 text-indigo-600 hover:bg-indigo-600/20 transition-all ${isSyncing ? 'animate-pulse' : ''}`}><Save className="w-4 h-4" /></button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto relative">
        {isLoadingChapter && <div className="absolute inset-0 flex items-center justify-center bg-inherit z-5"><Loader2 className="w-10 h-10 text-indigo-600 animate-spin" /></div>}
        {isAddChapterOpen && <div className="absolute inset-0 z-20 overflow-y-auto p-4 lg:p-12"><div className="max-w-4xl mx-auto relative"><button onClick={() => setIsAddChapterOpen(false)} className="absolute -top-4 -right-4 p-3 bg-white text-black shadow-2xl rounded-full"><X className="w-6 h-6" /></button><Extractor onChapterExtracted={handleChapterExtracted} suggestedIndex={activeBook?.chapters.length ? Math.max(...activeBook.chapters.map(c => c.index)) + 1 : 1} theme={state.theme} /></div></div>}
        
        {activeTab === 'library' && (
          <Library 
            books={state.books} activeBookId={state.activeBookId} lastSession={state.lastSession} 
            onSelectBook={id => { setState(p => ({ ...p, activeBookId: id })); setActiveTab('collection'); }} 
            onAddBook={async (t, b, d, dfid, dfn) => { const bk: Book = { id: crypto.randomUUID(), title: t, chapters: [], rules: [], backend: b, directoryHandle: d, driveFolderId: dfid, driveFolderName: dfn, settings: { useBookSettings: false, highlightMode: HighlightMode.WORD } }; setState(p => ({ ...p, books: [...p.books, bk] })); }}
            onDeleteBook={id => setState(p => ({ ...p, books: p.books.filter(b => b.id !== id) }))}
            onUpdateBook={book => setState(p => ({ ...p, books: p.books.map(b => b.id === book.id ? book : b) }))}
            onSelectChapter={(bid, cid) => { setState(p => ({ ...p, activeBookId: bid, books: p.books.map(b => b.id === bid ? { ...b, currentChapterId: cid } : b) })); setActiveTab('reader'); }}
            theme={state.theme}
          />
        )}
        
        {activeTab === 'collection' && activeBook && (
          <ChapterFolderView 
            book={activeBook} theme={state.theme} onAddChapter={() => setIsAddChapterOpen(true)}
            onOpenChapter={id => { setState(p => ({ ...p, books: p.books.map(b => b.id === activeBook.id ? { ...b, currentChapterId: id } : b) })); setActiveTab('reader'); }}
            onToggleFavorite={() => {}} onUpdateChapterTitle={(id, t) => setState(p => ({ ...p, books: p.books.map(b => b.id === activeBook.id ? { ...b, chapters: b.chapters.map(c => c.id === id ? { ...c, title: t } : c) } : b) }))}
            onDeleteChapter={id => setState(p => ({ ...p, books: p.books.map(b => b.id === activeBook.id ? { ...b, chapters: b.chapters.filter(c => c.id !== id) } : b) }))}
            onUpdateChapter={c => updateChapterAudio(activeBook.id, c.id, c)}
            onBackToLibrary={() => setActiveTab('library')}
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
            rules={activeBook?.rules || []} theme={state.theme} onAddRule={r => setState(p => ({ ...p, books: p.books.map(b => b.id === p.activeBookId ? { ...b, rules: [...b.rules, r] } : b) }))}
            onUpdateRule={r => setState(p => ({ ...p, books: p.books.map(b => b.id === p.activeBookId ? { ...b, rules: b.rules.map(o => o.id === r.id ? r : o) } : b) }))}
            onDeleteRule={id => setState(p => ({ ...p, books: p.books.map(b => b.id === p.activeBookId ? { ...b, rules: b.rules.filter(ru => ru.id !== id) } : b) }))}
            onImportRules={nr => setState(p => ({ ...p, books: p.books.map(b => b.id === p.activeBookId ? { ...b, rules: nr } : b) }))}
            selectedVoice={state.selectedVoiceName || ''} playbackSpeed={state.playbackSpeed}
          />
        )}

        {activeTab === 'settings' && (
          <Settings 
            settings={state.readerSettings} onUpdate={s => setState(p => ({ ...p, readerSettings: { ...p.readerSettings, ...s } }))} theme={state.theme} 
            keepAwake={state.keepAwake} onSetKeepAwake={v => setState(p => ({ ...p, keepAwake: v }))} onCheckForUpdates={() => window.location.reload()}
            isCloudLinked={!!state.googleClientId} onLinkCloud={() => getValidDriveToken({ interactive: true })} onSyncNow={() => handleSaveState(true)}
            googleClientId={state.googleClientId} onUpdateGoogleClientId={id => setState(p => ({ ...p, googleClientId: id }))}
            onClearAuth={() => clearStoredToken()} onSaveState={() => handleSaveState(true)} lastSavedAt={state.lastSavedAt}
          />
        )}
      </div>

      {activeChapterMetadata && (activeTab === 'reader' || activeTab === 'collection') && (
        <Player 
          isPlaying={isPlaying} onPlay={handlePlay} onPause={handlePause} onStop={() => setIsPlaying(false)} onNext={handleNextChapter} onPrev={() => {}} onSeek={d => handleJumpToOffset(state.currentOffsetChars + d)}
          speed={state.playbackSpeed} onSpeedChange={s => setState(p => ({ ...p, playbackSpeed: s }))} selectedVoice={''} onVoiceChange={() => {}} theme={state.theme} onThemeChange={() => {}}
          progressChars={state.currentOffsetChars} totalLengthChars={activeChapterMetadata.content.length} wordCount={activeChapterMetadata.wordCount} onSeekToOffset={handleJumpToOffset}
          sleepTimer={sleepTimerSeconds} onSetSleepTimer={setSleepTimerSeconds} stopAfterChapter={stopAfterChapter} onSetStopAfterChapter={setStopAfterChapter}
          useBookSettings={false} onSetUseBookSettings={() => {}} highlightMode={activeBook?.settings.highlightMode || HighlightMode.WORD} onSetHighlightMode={m => setState(p => ({ ...p, books: p.books.map(b => b.id === activeBook?.id ? { ...b, settings: { ...b.settings, highlightMode: m } } : b) }))}
          playbackCurrentTime={audioCurrentTime} playbackDuration={audioDuration} onSeekToTime={handleSeekToTime}
        />
      )}
    </div>
  );
};

export default App;
