import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Book, Chapter, AppState, Theme, HighlightMode, StorageBackend, RuleType, SavedSnapshot, AudioStatus, CLOUD_VOICES, SyncDiagnostics, Rule, PlaybackMetadata, PlaybackPhase, UiMode, ReaderSettings } from './types';
import Library from './components/Library';
import Reader from './components/Reader';
import Player from './components/Player';
import RuleManager from './components/RuleManager';
import Settings from './components/Settings';
import Extractor from './components/Extractor';
import ChapterFolderView from './components/ChapterFolderView';
import ChapterSidebar from './components/ChapterSidebar';
import { speechController, applyRules, PROGRESS_STORE_V4 } from './services/speechService';
import { reflowLineBreaks } from './services/textFormat';
import { fetchDriveFile, fetchDriveBinary, uploadToDrive, buildMp3Name, listFilesInFolder, findFileSync, buildTextName, ensureRootStructure, ensureBookFolder, moveFile, openFolderPicker, listFilesSortedByModified, resolveFolderIdByName, listSaveFileCandidates, createDriveFolder, listFoldersInFolder, findTaleVoxRoots } from './services/driveService';
import { initDriveAuth, getValidDriveToken, clearStoredToken, isTokenValid, ensureValidToken } from './services/driveAuth';
import { authManager, AuthState } from './services/authManager';
import { saveChapterToFile } from './services/fileService';
import { synthesizeChunk } from './services/cloudTtsService';
import { extractChapterWithAI } from './services/geminiService';
import { saveAudioToCache, getAudioFromCache, generateAudioKey } from './services/audioCache';
import { idbSet } from './services/storageService';
import { listBooks as libraryListBooks, upsertBook as libraryUpsertBook, deleteBook as libraryDeleteBook, listChaptersPage as libraryListChaptersPage, upsertChapterMeta as libraryUpsertChapterMeta, deleteChapter as libraryDeleteChapter, saveChapterText as librarySaveChapterText, loadChapterText as libraryLoadChapterText } from './services/libraryStore';
import { migrateLegacyLocalStorageIfNeeded } from './services/libraryMigration';
import { Sun, Coffee, Moon, X, Settings as SettingsIcon, Loader2, Save, Library as LibraryIcon, Zap, Menu, LogIn, RefreshCw, AlertCircle, Cloud, Terminal, List, FolderSync, CheckCircle2, Plus } from 'lucide-react';
import { trace, traceError } from './utils/trace';
import { computeMobileMode } from './utils/platform';

const STATE_FILENAME = 'talevox_state_v2917.json';
const STABLE_POINTER_NAME = 'talevox-latest.json';
const SNAPSHOT_KEY = "talevox_saved_snapshot_v1";
const BACKUP_KEY = "talevox_sync_backup";
const UI_MODE_KEY = "talevox_ui_mode";
const PREFS_KEY = 'talevox_prefs_v3';

// --- Safe Storage Helper ---
const safeSetLocalStorage = (key: string, value: string) => {
  if (value.length > 250000 && (key === BACKUP_KEY || key.includes('backup'))) {
     console.warn(`[SafeStorage] Skipping backup write for ${key} (size ${value.length} > 250kb) to prevent quota issues.`);
     return;
  }
  try {
    localStorage.setItem(key, value);
  } catch (e: any) {
    console.warn(`LocalStorage write failed for key "${key}":`, e.message);
    if (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED') {
      const diagStr = localStorage.getItem('talevox_sync_diag') || '{}';
      try {
        const diag = JSON.parse(diagStr);
        diag.lastSyncError = `Storage Quota Exceeded: ${e.message}`;
        localStorage.setItem('talevox_sync_diag', JSON.stringify(diag));
      } catch (inner) {}
    }
  }
};

const normalizeChapterProgress = (c: Chapter): Chapter => {
  let percent = 0;
  if (c.progress !== undefined) percent = c.progress;
  else if (c.progressSec && c.durationSec) percent = c.progressSec / c.durationSec;
  else if (c.progressChars && c.textLength) percent = c.progressChars / c.textLength;
  
  percent = Math.min(Math.max(percent, 0), 1);
  let isCompleted = c.isCompleted;
  if (isCompleted) {
    percent = 1;
  } else if (percent >= 0.99) {
    isCompleted = true;
    percent = 1;
  }
  return { ...c, progress: percent, isCompleted };
};

const App: React.FC = () => {
  const [isDirty, setIsDirty] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isScanningRules, setIsScanningRules] = useState(false);
  const [scanProgress, setScanProgress] = useState('');
  const [isLinkModalOpen, setIsLinkModalOpen] = useState(false);

  const [playbackPhase, setPlaybackPhase] = useState<PlaybackPhase>('IDLE');
  const [phaseSince, setPhaseSince] = useState(Date.now());
  const [lastPlaybackError, setLastPlaybackError] = useState<string | null>(null);
  const [currentIntroDurSec, setCurrentIntroDurSec] = useState(5);
  const [isScrubbing, setIsScrubbing] = useState(false);
  
  const [playbackSnapshot, setPlaybackSnapshot] = useState<{chapterId: string, percent: number} | null>(null);
  const lastSnapshotRef = useRef(0);
  
  const chapterSessionRef = useRef(0);
  const isInIntroRef = useRef(false);
  const lastProgressCommitTime = useRef(0);
  const isScrubbingRef = useRef(false);
  const scrubPreviewSecRef = useRef(0);
  
  const gestureArmedRef = useRef(false);
  const lastGestureAt = useRef(0);
  const [autoplayBlocked, setAutoplayBlocked] = useState(false);

  useEffect(() => {
    if (playbackPhase === 'SEEKING') {
      const timer = setTimeout(() => {
        trace('watchdog:seek_timeout');
        setPlaybackPhase('READY'); 
        pushNotice({ message: "Seek timed out", type: 'error' });
      }, 6000);
      return () => clearTimeout(timer);
    }
  }, [playbackPhase]);

  useEffect(() => {
    const handleVisChange = () => {
      if (document.visibilityState === 'visible') {
        speechController.emitSyncTick();
      } else {
        const s = stateRef.current;
        if (s.activeBookId && s.books) {
           const b = s.books.find(bk => bk.id === s.activeBookId);
           if (b && b.currentChapterId) {
              const meta = speechController.getMetadata();
              commitProgressUpdate(b.id, b.currentChapterId, meta, false, true);
           }
        }
      }
    };
    document.addEventListener('visibilitychange', handleVisChange);
    return () => document.removeEventListener('visibilitychange', handleVisChange);
  }, []);

  useEffect(() => {
    const handleUnload = () => {
        const s = stateRef.current;
        if (s.activeBookId && s.books) {
           const b = s.books.find(bk => bk.id === s.activeBookId);
           if (b && b.currentChapterId) {
              const meta = speechController.getMetadata();
              try {
                 const storeRaw = localStorage.getItem(PROGRESS_STORE_V4);
                 const store = storeRaw ? JSON.parse(storeRaw) : {};
                 if (!store[b.id]) store[b.id] = {};
                 store[b.id][b.currentChapterId] = {
                   timeSec: meta.currentTime,
                   durationSec: meta.duration,
                   percent: meta.duration ? meta.currentTime/meta.duration : 0,
                   completed: false,
                   updatedAt: Date.now()
                 };
                 localStorage.setItem(PROGRESS_STORE_V4, JSON.stringify(store));
              } catch(e) {}
           }
        }
    };
    window.addEventListener('beforeunload', handleUnload);
    return () => window.removeEventListener('beforeunload', handleUnload);
  }, []);

  useEffect(() => {
    const armGesture = () => {
      gestureArmedRef.current = true;
      lastGestureAt.current = Date.now();
    };
    window.addEventListener('pointerdown', armGesture, { capture: true });
    window.addEventListener('keydown', armGesture, { capture: true });
    return () => {
      window.removeEventListener('pointerdown', armGesture, { capture: true });
      window.removeEventListener('keydown', armGesture, { capture: true });
    };
  }, []);

  const [state, setState] = useState<AppState>(() => {
    const prefsRaw = localStorage.getItem(PREFS_KEY);
    const parsed = prefsRaw ? JSON.parse(prefsRaw) : {};
    const savedDiag = localStorage.getItem('talevox_sync_diag');
    const savedUiMode = localStorage.getItem(UI_MODE_KEY) as UiMode | null;

    const defaultReaderSettings: ReaderSettings = {
      fontFamily: "'Source Serif 4', serif",
      fontSizePx: 20,
      lineHeight: 1.55,
      paragraphSpacing: 1,
      reflowLineBreaks: true,
      highlightColor: '#4f46e5',
      followHighlight: true,
      uiMode: savedUiMode || 'auto',
    };

    const mergedReaderSettings: ReaderSettings = {
      ...defaultReaderSettings,
      ...(parsed.readerSettings || {}),
      uiMode: savedUiMode || parsed.readerSettings?.uiMode || defaultReaderSettings.uiMode,
    };

    return {
      books: [],
      activeBookId: parsed.activeBookId,
      playbackSpeed: parsed.playbackSpeed || 1.0,
      selectedVoiceName: parsed.selectedVoiceName,
      theme: parsed.theme || Theme.LIGHT,
      currentOffsetChars: 0,
      debugMode: parsed.debugMode || false,
      readerSettings: mergedReaderSettings,
      driveToken: parsed.driveToken,
      googleClientId: parsed.googleClientId,
      keepAwake: parsed.keepAwake ?? false,
      lastSavedAt: parsed.lastSavedAt,
      driveRootFolderId: parsed.driveRootFolderId,
      driveRootFolderName: parsed.driveRootFolderName,
      driveSubfolders: parsed.driveSubfolders,
      syncDiagnostics: savedDiag ? JSON.parse(savedDiag) : {},
      autoSaveInterval: parsed.autoSaveInterval || 30,
      globalRules: parsed.globalRules || [],
      showDiagnostics: parsed.showDiagnostics || false
    };
  });

  useEffect(() => {
    const pref = state.readerSettings.uiMode || 'auto';
    localStorage.setItem(UI_MODE_KEY, pref);
  }, [state.readerSettings.uiMode]);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        await migrateLegacyLocalStorageIfNeeded();
        const books = await libraryListBooks();
        if (cancelled) return;

        let nextActiveBookId: string | undefined;

        setState((p) => {
          const desired = p.activeBookId;
          const valid = desired && books.some((b) => b.id === desired);
          nextActiveBookId = valid ? desired : (books[0]?.id ?? undefined);
          return { ...p, books, activeBookId: nextActiveBookId };
        });

        console.log("[TaleVox][Library] Loaded books:", books.length);

        if (nextActiveBookId) {
          void loadMoreChapters(nextActiveBookId, true);
        }
      } catch (e: any) {
        console.error("Library bootstrap failed", e);
      }
    })();

    return () => { cancelled = true; };
  }, []);

  const [effectiveMobileMode, setEffectiveMobileMode] = useState(computeMobileMode(state.readerSettings.uiMode));

  useEffect(() => {
    const recompute = () => {
      const isMob = computeMobileMode(state.readerSettings.uiMode);
      setEffectiveMobileMode(isMob);
      speechController.setMobileMode(isMob);
    };
    recompute();
    if (state.readerSettings.uiMode === 'auto') {
      window.addEventListener('resize', recompute);
      return () => window.removeEventListener('resize', recompute);
    }
  }, [state.readerSettings.uiMode]);

  const [activeTab, setActiveTab] = useState<'library' | 'collection' | 'reader' | 'rules' | 'settings'>('library');
  const [isAddChapterOpen, setIsAddChapterOpen] = useState(false);
  const [isChapterSidebarOpen, setIsChapterSidebarOpen] = useState(false);
  const [chapterPagingByBook, setChapterPagingByBook] = useState<Record<string, { afterIndex: number; hasMore: boolean; loading: boolean }>>({});
  const chapterPagingRef = useRef<Record<string, { afterIndex: number; hasMore: boolean; loading: boolean }>>({});

  useEffect(() => { chapterPagingRef.current = chapterPagingByBook; }, [chapterPagingByBook]);

  const loadMoreChapters = useCallback(async (bookId: string, reset: boolean = false) => {
    const limit = 200;

    const current = chapterPagingRef.current[bookId] ?? { afterIndex: -1, hasMore: true, loading: false };
    if (current.loading) return;
    if (!current.hasMore && !reset) return;

    if (reset) {
      setState((p) => ({
        ...p,
        books: p.books.map((b) => (b.id === bookId ? { ...b, chapters: [] } : b)),
      }));
    }

    setChapterPagingByBook((p) => ({
      ...p,
      [bookId]: { ...current, afterIndex: reset ? -1 : current.afterIndex, hasMore: true, loading: true },
    }));

    try {
      const afterIndex = reset ? -1 : current.afterIndex;
      const page = await libraryListChaptersPage(bookId, afterIndex, limit);

      setState((p) => {
        const books = p.books.map((b) => {
          if (b.id !== bookId) return b;
          const existing = reset ? [] : b.chapters;
          const combined = [...existing, ...page.chapters];

          const seen = new Set<string>();
          const deduped = combined.filter((c) => {
            if (seen.has(c.id)) return false;
            seen.add(c.id);
            return true;
          });

          deduped.sort((a, b2) => a.index - b2.index);
          return {
            ...b,
            chapters: deduped,
            chapterCount: page.totalCount ?? b.chapterCount,
          };
        });

        return { ...p, books };
      });

      const hasMore = page.chapters.length === limit;
      const nextAfterIndex = page.nextAfterIndex ?? (reset ? -1 : current.afterIndex);

      setChapterPagingByBook((p) => ({
        ...p,
        [bookId]: { afterIndex: nextAfterIndex, hasMore, loading: false },
      }));
    } catch (e) {
      console.error("Failed to load chapters page", e);
      setChapterPagingByBook((p) => ({
        ...p,
        [bookId]: { ...current, loading: false },
      }));
    }
  }, []);
  
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLoadingChapter, setIsLoadingChapter] = useState(false);
  const isPlayingRef = useRef(isPlaying);
  useEffect(() => { isPlayingRef.current = isPlaying }, [isPlaying]);

  const [sleepTimerSeconds, setSleepTimerSeconds] = useState<number | null>(null);
  const [stopAfterChapter, setStopAfterChapter] = useState(false);
  const [audioDuration, setAudioDuration] = useState(0);
  const [audioCurrentTime, setAudioCurrentTime] = useState(0);
  
  const [authState, setAuthState] = useState<AuthState>(authManager.getState());
  const isAuthorized = authState.status === 'signed_in' && !!authManager.getToken();

  useEffect(() => {
    const unsubscribe = authManager.subscribe(setAuthState);
    return () => { unsubscribe(); };
  }, []);

  useEffect(() => {
    if (state.googleClientId) {
      authManager.init(state.googleClientId);
    }
  }, [state.googleClientId]);

  useEffect(() => {
    if (authState.status === 'error') {
      pushNotice({ message: `Auth Error: ${authState.lastError}`, type: 'error' });
    }
    if (authState.status === 'expired') {
      pushNotice({ message: 'Drive session expired. Reconnect required.', type: 'reconnect', ms: 6000 });
    }
  }, [authState.status, authState.lastError]);

  const handleReconnectDrive = useCallback(async () => {
    try {
      await ensureValidToken(true);
      if (stateRef.current.driveRootFolderId) {
        await handleSync(true);
      }
      pushNotice({ message: 'Drive reconnected.', type: 'success' });
    } catch (e: any) {
      pushNotice({ message: e?.message || 'Reconnect failed', type: 'error' });
    }
  }, [handleSync, pushNotice]);

  const stateRef = useRef(state);
  useEffect(() => { stateRef.current = state; }, [state]);

  const activeBook = useMemo(() => state.books.find(b => b.id === state.activeBookId), [state.books, state.activeBookId]);
  const activeChapterMetadata = useMemo(() => activeBook?.chapters.find(c => c.id === activeBook.currentChapterId), [activeBook]);

  const [toast, setToast] = useState<{ message: string; type: 'info' | 'success' | 'error' | 'reconnect' } | null>(null);
  const noticeTimerRef = useRef<number | null>(null);

  const pushNotice = useCallback((n: { type: "info"|"success"|"error"|"reconnect"; message: string; ms?: number }) => {
    setToast({ message: n.message, type: n.type });

    if (noticeTimerRef.current) window.clearTimeout(noticeTimerRef.current);

    const ms = n.ms ?? (n.type === "error" ? 4500 : 2500);
    noticeTimerRef.current = window.setTimeout(() => setToast(null), ms);
  }, []);

  useEffect(() => {
    return () => {
      if (noticeTimerRef.current) window.clearTimeout(noticeTimerRef.current);
    };
  }, []);

  const updatePhase = useCallback((p: PlaybackPhase) => {
    const validPhases: PlaybackPhase[] = ['IDLE', 'LOADING_TEXT', 'READY', 'LOADING_AUDIO', 'SEEKING', 'SCRUBBING', 'PLAYING_INTRO', 'PLAYING_BODY', 'ENDING_SETTLE', 'TRANSITIONING', 'ERROR'];
    if (validPhases.includes(p)) {
        trace(`phase:change`, { from: playbackPhase, to: p });
    }
    setPlaybackPhase(p);
    setPhaseSince(Date.now());
  }, [playbackPhase]);

  const updateDiagnostics = useCallback((updates: Partial<SyncDiagnostics>) => {
    setState(p => {
      const next = { ...p.syncDiagnostics, ...updates };
      safeSetLocalStorage('talevox_sync_diag', JSON.stringify(next));
      return { ...p, syncDiagnostics: next };
    });
  }, []);

  const markDirty = useCallback(() => {
    setIsDirty(true);
    updateDiagnostics({ isDirty: true, dirtySince: Date.now() });
  }, [updateDiagnostics]);

  const commitProgressUpdate = useCallback((
    bookId: string, 
    chapterId: string, 
    meta: PlaybackMetadata & { completed?: boolean }, 
    force: boolean = false,
    bypassThrottle: boolean = false
  ) => {
    const now = Date.now();
    const throttleMs = effectiveMobileMode ? 800 : 250;
    
    const s = stateRef.current;
    const bIdx = s.books.findIndex(b => b.id === bookId);
    if (bIdx === -1) return;
    const book = s.books[bIdx];
    
    if (book.currentChapterId !== chapterId) {
        return;
    }

    if (!force && !bypassThrottle && !meta.completed && now - lastProgressCommitTime.current < throttleMs) {
      return;
    }
    lastProgressCommitTime.current = now;

    const cIdx = book.chapters.findIndex(c => c.id === chapterId);
    if (cIdx === -1) return;
    
    const chapter = book.chapters[cIdx];
    
    const durationSec = Math.max(meta.duration || 0, chapter.durationSec || 0);
    const progressSec = Math.min(Math.max(meta.currentTime || 0, 0), durationSec);
    const progressChars = Math.max(meta.charOffset || 0, 0);
    const textLength = Math.max(meta.textLength || 0, chapter.textLength || chapter.content?.length || 0);

    const rawChapter = {
        ...chapter,
        progressSec,
        progressChars,
        durationSec,
        textLength,
        isCompleted: meta.completed || chapter.isCompleted || false
    };

    const normalized = normalizeChapterProgress(rawChapter);
    
    if (force || normalized.isCompleted !== chapter.isCompleted || Math.abs(normalized.progress - chapter.progress) > 0.01 || Math.abs((normalized.progressSec || 0) - (chapter.progressSec || 0)) > 2) {
       setState(prev => {
         const newBooks = [...prev.books];
         const newChapters = [...newBooks[bIdx].chapters];
         newChapters[cIdx] = {
           ...normalized,
           updatedAt: now
         };
         newBooks[bIdx] = { ...newBooks[bIdx], chapters: newChapters };
         return { ...prev, books: newBooks };
       });

       try {
         const storeRaw = localStorage.getItem(PROGRESS_STORE_V4);
         const store = storeRaw ? JSON.parse(storeRaw) : {};
         if (!store[bookId]) store[bookId] = {};
         store[bookId][chapterId] = {
           timeSec: normalized.progressSec,
           durationSec: normalized.durationSec,
           percent: normalized.progress,
           completed: normalized.isCompleted,
           updatedAt: now
         };
         localStorage.setItem(PROGRESS_STORE_V4, JSON.stringify(store));
       } catch (e) { console.warn("Progress write failed", e); }
       
       markDirty();
    }

  }, [effectiveMobileMode, markDirty]);

  const handleSyncUpdate = useCallback((meta: PlaybackMetadata & { completed?: boolean }) => {
    if (isScrubbingRef.current) return;

    if (['LOADING_AUDIO', 'SEEKING', 'TRANSITIONING', 'LOADING_TEXT', 'SCRUBBING'].includes(playbackPhase)) {
        if (playbackPhase === 'SEEKING') {
             const now = Date.now();
             if (now - lastSnapshotRef.current > 50) {
                 const percent = meta.duration > 0 ? meta.currentTime / meta.duration : 0;
                 const s = stateRef.current;
                 const b = s.books.find(bk => bk.id === s.activeBookId);
                 if (b && b.currentChapterId) {
                    setPlaybackSnapshot({ chapterId: b.currentChapterId, percent });
                 }
                 lastSnapshotRef.current = now;
             }
        }
        return;
    }
    
    if (playbackPhase === 'READY' || playbackPhase === 'PLAYING_INTRO' || playbackPhase === 'PLAYING_BODY') {
        if (meta.currentTime > (currentIntroDurSec + 0.6) && playbackPhase !== 'PLAYING_BODY') {
            updatePhase('PLAYING_BODY');
            isInIntroRef.current = false;
        } else if (meta.currentTime <= (currentIntroDurSec + 0.6) && playbackPhase !== 'PLAYING_INTRO') {
            updatePhase('PLAYING_INTRO');
            isInIntroRef.current = true;
        }
    }

    setAudioCurrentTime(meta.currentTime);
    setAudioDuration(meta.duration);
    
    if (Math.abs(meta.charOffset - stateRef.current.currentOffsetChars) > 5) {
        setState(p => ({ ...p, currentOffsetChars: meta.charOffset }));
    }

    const s = stateRef.current;
    if (s.activeBookId && s.books) {
       const b = s.books.find(b => b.id === s.activeBookId);
       if (b && b.currentChapterId) {
          const now = Date.now();
          if (now - lastSnapshotRef.current > 100) {
             const percent = meta.duration > 0 ? meta.currentTime / meta.duration : 0;
             setPlaybackSnapshot({ chapterId: b.currentChapterId, percent });
             lastSnapshotRef.current = now;
          }
          
          commitProgressUpdate(b.id, b.currentChapterId, meta, !!meta.completed);
       }
    }

  }, [playbackPhase, currentIntroDurSec, updatePhase, commitProgressUpdate]);

  useEffect(() => {
    speechController.setSyncCallback(handleSyncUpdate);
  }, [handleSyncUpdate]);

  useEffect(() => {
    document.documentElement.style.setProperty('--highlight-color', state.readerSettings.highlightColor);
  }, [state.readerSettings.highlightColor]);

  const handleSaveState = useCallback(async (force = false, silent = false) => {
      if (!stateRef.current.driveRootFolderId) return;
      if (!force && !isDirty) return;
      
      if (!silent) pushNotice({ message: "Saving to Cloud...", type: 'info', ms: 0 });
      
      try {
          const s = stateRef.current;
          let savesId = s.driveSubfolders?.savesId;
          if (!savesId && s.driveRootFolderId) {
              const subs = await ensureRootStructure(s.driveRootFolderId);
              savesId = subs.savesId;
              setState(p => ({ ...p, driveSubfolders: subs }));
          }
          if (!savesId) throw new Error("No saves folder");

          const snapshot: SavedSnapshot = {
              version: "v1",
              savedAt: Date.now(),
              state: {
                  books: s.books,
                  readerSettings: s.readerSettings,
                  activeBookId: s.activeBookId,
                  playbackSpeed: s.playbackSpeed,
                  selectedVoiceName: s.selectedVoiceName,
                  theme: s.theme,
                  progressStore: {},
                  driveRootFolderId: s.driveRootFolderId,
                  driveRootFolderName: s.driveRootFolderName,
                  driveSubfolders: s.driveSubfolders,
                  autoSaveInterval: s.autoSaveInterval,
                  globalRules: s.globalRules,
                  showDiagnostics: s.showDiagnostics
              }
          };
          
          const content = JSON.stringify(snapshot);
          
          // 1. Upload timestamped snapshot
          await uploadToDrive(savesId, `talevox_state_${window.__APP_VERSION__}_${Date.now()}.json`, content, undefined, 'application/json');
          
          // 2. Upload/Overwrite stable pointer file
          const existingPointerId = await findFileSync(STABLE_POINTER_NAME, savesId);
          await uploadToDrive(savesId, STABLE_POINTER_NAME, content, existingPointerId || undefined, 'application/json');
          
          setState(p => ({ ...p, lastSavedAt: Date.now() }));
          setIsDirty(false);
          if (!silent) pushNotice({ message: "Cloud Save Complete", type: 'success' });
      } catch (e: any) {
          if (!silent) pushNotice({ message: "Save Failed: " + e.message, type: 'error' });
          console.error(e);
      }
  }, [isDirty, pushNotice]);

  const ensureChapterContentLoaded = useCallback(
    async (bookId: string, chapterId: string, session: number): Promise<string | null> => {
      const s = stateRef.current;
      const book = s.books.find(b => b.id === bookId);
      const chapter = book?.chapters.find(c => c.id === chapterId);
      if (!book || !chapter) return null;

      // If we already have content in memory, accept it even if short.
      if (typeof chapter.content === "string") {
        return chapter.content;
      }

      // Local cache first. Only null means missing. Short strings are valid.
      try {
        const cached = await libraryLoadChapterText(bookId, chapterId);

        if (cached !== null) {
          if (chapterSessionRef.current !== session) return null;

          setState(p => ({
            ...p,
            books: p.books.map(b =>
              b.id === bookId
                ? {
                    ...b,
                    chapters: b.chapters.map(c =>
                      c.id === chapterId
                        ? { ...c, content: cached, textLength: cached.length, updatedAt: Date.now() }
                        : c
                    ),
                  }
                : b
            ),
          }));

          trace("text:cache:hit", { chapterId, len: cached.length });
          return cached;
        }

        trace("text:cache:miss", { chapterId });
      } catch (e: any) {
        traceError("text:cache:error", e);
        // ignore and fall back to Drive below
      }

      // Drive fallback only if authorized
      if (chapter.cloudTextFileId && isAuthorized) {
        trace("text:drive:load:start", { chapterId, fileId: chapter.cloudTextFileId, session });

        try {
          const text = await fetchDriveFile(chapter.cloudTextFileId);

          if (typeof text === "string") {
            if (chapterSessionRef.current !== session) {
              trace("text:drive:load:aborted", { reason: "stale_session" });
              return null;
            }

            setState(p => ({
              ...p,
              books: p.books.map(b =>
                b.id === bookId
                  ? {
                      ...b,
                      chapters: b.chapters.map(c =>
                        c.id === chapterId
                          ? { ...c, content: text, textLength: text.length, updatedAt: Date.now() }
                          : c
                      ),
                    }
                  : b
              ),
            }));

            try {
              await librarySaveChapterText(bookId, chapterId, text);
            } catch {}

            trace("text:drive:load:success", { chapterId, len: text.length });
            return text;
          }
        } catch (e: any) {
          traceError("text:drive:load:failed", e);
          pushNotice({ message: "Failed to load text: " + (e?.message ?? String(e)), type: "error" });
        }
      }

      return null;
    },
    [isAuthorized, pushNotice]
  );

  const hardRefreshForChapter = useCallback(async (bookId: string, chapterId: string) => {
       const s = stateRef.current;
       const book = s.books.find(b => b.id === bookId);
       if (!book || !book.driveFolderId || !isAuthorized) return;
       const chapter = book.chapters.find(c => c.id === chapterId);
       if (!chapter) return;

       try {
           const textName = buildTextName(book.id, chapter.id);
           const audioName = buildMp3Name(book.id, chapter.id);
           
           const [textId, audioId] = await Promise.all([
               findFileSync(textName, book.driveFolderId),
               findFileSync(audioName, book.driveFolderId)
           ]);
           
           if (textId !== chapter.cloudTextFileId || audioId !== chapter.cloudAudioFileId) {
                setState(p => ({
                       ...p,
                       books: p.books.map(b => b.id === bookId ? {
                           ...b,
                           chapters: b.chapters.map(c => c.id === chapterId ? { 
                               ...c, 
                               cloudTextFileId: textId || c.cloudTextFileId,
                               cloudAudioFileId: audioId || c.cloudAudioFileId,
                               audioStatus: audioId ? AudioStatus.READY : c.audioStatus
                           } : c)
                       } : b)
                   }));
           }
       } catch (e) { console.warn("Hard refresh failed", e); }
  }, [isAuthorized]);

  const handleReconcileProgress = useCallback(() => {
      const s = stateRef.current;
      if (!s.activeBookId) return;
      
      let changedCount = 0;
      const newBooks = s.books.map(b => {
          if (b.id !== s.activeBookId) return b;
          
          const newChapters = b.chapters.map(c => {
              const normalized = normalizeChapterProgress(c);
              if (normalized.isCompleted !== c.isCompleted || Math.abs(normalized.progress - c.progress) > 0.01) {
                  changedCount++;
                  return normalized;
              }
              return c;
          });
          return { ...b, chapters: newChapters };
      });
      
      if (changedCount > 0) {
          setState(p => ({ ...p, books: newBooks }));
          markDirty();
          pushNotice({ message: `Reconciled ${changedCount} chapters`, type: 'success' });
      } else {
          pushNotice({ message: "Progress already consistent", type: 'info' });
      }
  }, [markDirty, pushNotice]);

  const handleResetChapterProgress = (bid: string, cid: string) => {
      commitProgressUpdate(bid, cid, { currentTime: 0, duration: 0, charOffset: 0, completed: false }, true, true);
      pushNotice({ message: "Reset", type: 'info', ms: 1000 });
  };

  const handleNextChapterRef = useRef<(autoTrigger?: boolean) => void>(() => {});

  const loadChapterSession = useCallback(async (targetChapterId: string, reason: 'user' | 'auto') => {
    const session = ++chapterSessionRef.current;
    const s = stateRef.current;
    const book = s.books.find(b => b.id === s.activeBookId);
    if (!book) return;
    const chapter = book.chapters.find(c => c.id === targetChapterId);
    if (!chapter) return;

    updatePhase('LOADING_TEXT');
    trace('chapter:load:start', { targetChapterId, reason, session });

    speechController.safeStop(); 
    setAutoplayBlocked(false);
    
    setState(p => ({ 
        ...p, 
        books: p.books.map(b => b.id === book.id ? { ...b, currentChapterId: targetChapterId } : b),
        currentOffsetChars: 0 
    }));
    setAudioCurrentTime(0);
    setAudioDuration(0);
    setPlaybackSnapshot(null);

    const content = await ensureChapterContentLoaded(book.id, chapter.id, session);
    
    if (session !== chapterSessionRef.current) return;

    if (content === null && typeof chapter.content !== "string") {
        pushNotice({ message: "Chapter text missing. Check Drive.", type: 'error', ms: 5000 });
        updatePhase('READY');
        return;
    }

    updatePhase('LOADING_AUDIO');
    
    setCurrentIntroDurSec(chapter.audioIntroDurSec || 5);
    const voice = book.settings.defaultVoiceId || 'en-US-Standard-C';
    const allRules = [...s.globalRules, ...book.rules];
    let textToSpeak = applyRules((content ?? chapter.content ?? ""), allRules);
    if (s.readerSettings?.reflowLineBreaks) textToSpeak = reflowLineBreaks(textToSpeak);

    const rawIntro = `Chapter ${chapter.index}. ${chapter.title}. `;
    const introText = applyRules(rawIntro, allRules);
    
    const cacheKey = generateAudioKey(introText + textToSpeak, voice, 1.0);
    let audioBlob = await getAudioFromCache(cacheKey);
    
    if (!audioBlob && chapter.cloudAudioFileId && isAuthorized) {
        try { 
            audioBlob = await fetchDriveBinary(chapter.cloudAudioFileId); 
            if (audioBlob) await saveAudioToCache(cacheKey, audioBlob); 
        } catch(e) {}
    }

    if (session !== chapterSessionRef.current) return;

    if (audioBlob && audioBlob.size > 0) {
        const url = URL.createObjectURL(audioBlob);
        speechController.setContext({ bookId: book.id, chapterId: chapter.id });
        speechController.updateMetadata(textToSpeak.length, chapter.audioIntroDurSec || 5, chapter.audioChunkMap || []);
        
        let startSec = 0;
        if (!chapter.isCompleted) {
            if (chapter.progressSec && chapter.progressSec > 0) {
                startSec = chapter.progressSec;
            } else if (chapter.progress && chapter.durationSec && chapter.progress < 0.99) {
                startSec = chapter.durationSec * chapter.progress;
            }
        }
        
        if (!isFinite(startSec) || startSec < 0) startSec = 0;
        
        await speechController.loadAndPlayDriveFile(
            '', 'LOCAL_ID', textToSpeak.length, chapter.audioIntroDurSec || 5, chapter.audioChunkMap, 
            startSec, 
            state.playbackSpeed, 
            () => {
                if (session === chapterSessionRef.current) {
                    updatePhase('ENDING_SETTLE');
                    setTimeout(() => {
                        if (session === chapterSessionRef.current) {
                            handleNextChapterRef.current(true); 
                        }
                    }, 300);
                }
            }, 
            null, url, 
            () => {
                if (session === chapterSessionRef.current) {
                    if (startSec > 1) {
                       updatePhase('PLAYING_BODY');
                       isInIntroRef.current = false;
                    } else {
                       updatePhase('PLAYING_INTRO'); 
                       isInIntroRef.current = true; 
                    }
                }
            }
        );

        if (session !== chapterSessionRef.current) return;

        if (effectiveMobileMode && reason === 'auto') {
           const timeSinceGesture = Date.now() - lastGestureAt.current;
           if (!gestureArmedRef.current || timeSinceGesture > 60000) { 
              setAutoplayBlocked(true);
              setIsPlaying(false);
              updatePhase('READY');
              return;
           }
        }

        try {
            const result = await speechController.safePlay();
            if (result === 'blocked') {
                setAutoplayBlocked(true);
                setIsPlaying(false);
                updatePhase('READY');
            } else {
                setAutoplayBlocked(false);
                setIsPlaying(true);
                updatePhase('PLAYING_BODY');
                speechController.setPlaybackRate(state.playbackSpeed);
            }
        } catch (e: any) {
            setAutoplayBlocked(true);
            setIsPlaying(false);
            updatePhase('READY');
        }

    } else {
        pushNotice({ message: "Audio not found. Try generating it.", type: 'info', ms: 3000 });
        updatePhase('READY');
        setIsPlaying(false);
    }

  }, [isAuthorized, ensureChapterContentLoaded, pushNotice, updatePhase, effectiveMobileMode, state.playbackSpeed]);

  const handleSmartOpenChapter = (id: string) => {
    const s = stateRef.current;
    const book = s.books.find(b => b.id === s.activeBookId);
    if (!book) return;
    
    const clickedChapter = book.chapters.find(c => c.id === id);
    if (!clickedChapter) return;

    setActiveTab('reader');

    if (clickedChapter.isCompleted) {
        const sorted = [...book.chapters].sort((a,b) => a.index - b.index);
        const clickedIdx = sorted.findIndex(c => c.id === id);
        const nextIncomplete = sorted.slice(clickedIdx + 1).find(c => !c.isCompleted);
        
        if (nextIncomplete) {
            pushNotice({ message: `Skipping completed ch.${clickedChapter.index} → ch.${nextIncomplete.index}`, type: 'info' });
            loadChapterSession(nextIncomplete.id, 'user');
            return;
        }
        pushNotice({ message: "Re-opening completed chapter", type: 'info', ms: 1000 });
    }
    
    loadChapterSession(id, 'user');
  };

  const handleManualPlay = () => {
    gestureArmedRef.current = true;
    lastGestureAt.current = Date.now();
    speechController.setPlaybackRate(state.playbackSpeed);
    
    speechController.safePlay().then(res => {
        if (res === 'blocked') {
            setAutoplayBlocked(true);
            setIsPlaying(false);
        } else {
            setAutoplayBlocked(false);
            setIsPlaying(true);
            updatePhase('PLAYING_BODY');
        }
    });
  };

  const handleNextChapter = useCallback((autoTrigger = false) => {
    const s = stateRef.current;
    const book = s.books.find(b => b.id === s.activeBookId);
    if (!book || !book.currentChapterId) return;
    const sorted = [...book.chapters].sort((a, b) => a.index - b.index);
    const idx = sorted.findIndex(c => c.id === book.currentChapterId);
    
    if (idx >= 0 && idx < sorted.length - 1) {
      const next = sorted[idx + 1];
      pushNotice({ message: `Next: Chapter ${next.index}`, type: 'info' });
      loadChapterSession(next.id, autoTrigger ? 'auto' : 'user');
    } else {
      setIsPlaying(false); updatePhase('IDLE'); pushNotice({ message: "End of book", type: 'success', ms: 3000 });
    }
  }, [loadChapterSession, updatePhase, pushNotice]);

  useEffect(() => { handleNextChapterRef.current = handleNextChapter; }, [handleNextChapter]);

  const handlePrevChapter = useCallback(() => {
    const s = stateRef.current;
    const book = s.books.find(b => b.id === s.activeBookId);
    if (!book || !book.currentChapterId) return;
    const sorted = [...book.chapters].sort((a, b) => a.index - b.index);
    const idx = sorted.findIndex(c => c.id === book.currentChapterId);
    if (idx > 0) {
      const prev = sorted[idx - 1];
      loadChapterSession(prev.id, 'user');
    }
  }, [loadChapterSession]);

  const handleManualPause = () => { 
      speechController.pause(); 
      setIsPlaying(false); 
      updatePhase('IDLE'); 
      
      const s = stateRef.current;
      if (s.activeBookId && s.books) {
         const b = s.books.find(bk => bk.id === s.activeBookId);
         if (b && b.currentChapterId) {
            const meta = speechController.getMetadata();
            commitProgressUpdate(b.id, b.currentChapterId, meta, false, true);
         }
      }
  };
  
  const handleManualStop = () => { speechController.stop(); setIsPlaying(false); updatePhase('IDLE'); };
  
  const handleSeekByDelta = (delta: number) => {
    const t = speechController.getCurrentTime() + delta;
    speechController.seekTo(t).then(() => {
        if (isPlayingRef.current) handleManualPlay();
    });
  };
  
  const handleJumpToOffset = (o: number) => { updatePhase('SEEKING'); speechController.seekToOffset(o); };
  
  const handleSeekCommit = useCallback(async (time: number) => {
    isScrubbingRef.current = false;
    setIsScrubbing(false);
    updatePhase('SEEKING');
    try {
      await speechController.seekTo(time);
      if (isPlayingRef.current) {
         handleManualPlay();
      } else {
         updatePhase('READY');
      }
      speechController.emitSyncTick();
    } catch (e: any) {
      updatePhase('READY');
    }
  }, []);

  const handleScrubStart = useCallback(() => {
    isScrubbingRef.current = true;
    setIsScrubbing(true);
    updatePhase('SCRUBBING');
  }, [updatePhase]);

  const handleScrubMove = useCallback((time: number) => {
    scrubPreviewSecRef.current = time;
  }, []);

  const handleAddBook = async (title: string, backend: StorageBackend, directoryHandle?: any, driveFolderId?: string, driveFolderName?: string) => {
      const newBook: Book = {
          id: driveFolderId || crypto.randomUUID(),
          title, backend, directoryHandle, driveFolderId, driveFolderName, chapters: [], rules: [], settings: { useBookSettings: false, highlightMode: HighlightMode.WORD }, updatedAt: Date.now()
      };
      if (backend === StorageBackend.DRIVE && !driveFolderId && state.driveRootFolderId) {
          try {
              const { booksId } = await ensureRootStructure(state.driveRootFolderId);
              const newFolderId = await createDriveFolder(title, booksId);
              newBook.id = newFolderId;
              newBook.driveFolderId = newFolderId;
              newBook.driveFolderName = title;
          } catch(e: any) { pushNotice({ message: "Failed to create Drive folder", type: 'error', ms: 0 }); return; }
      }
      await libraryUpsertBook({ ...newBook, directoryHandle: undefined });
      setState(p => ({ ...p, books: [...p.books, newBook], activeBookId: newBook.id }));
      markDirty();
      setActiveTab('library');
  };

  const handleChapterExtracted = async (data: any) => {
      const s = stateRef.current;
      const book = s.books.find(b => b.id === s.activeBookId);
      if (!book) return;
      const chapterId = crypto.randomUUID();
      const newChapter: Chapter = {
          id: chapterId, index: data.index, title: data.title, content: data.content, wordCount: 0, textLength: data.content.length, filename: buildTextName(book.id, chapterId), progress: 0, progressChars: 0, audioStatus: AudioStatus.PENDING, updatedAt: Date.now()
      };
      if (book.driveFolderId && isAuthorized) {
          try { newChapter.cloudTextFileId = await uploadToDrive(book.driveFolderId, newChapter.filename, data.content); newChapter.hasTextOnDrive = true; } catch {}
      }
      await libraryUpsertChapterMeta(book.id, { ...newChapter, content: undefined });
      await librarySaveChapterText(book.id, newChapter.id, data.content);
      setState(p => ({ ...p, books: p.books.map(b => b.id === book.id ? { ...b, chapters: [...b.chapters, newChapter].sort((a,b)=>a.index-b.index) } : b) }));
      markDirty();
      if (!data.keepOpen) setIsAddChapterOpen(false); else pushNotice({ message: "Added", type: 'success', ms: 1000 });
  };

  const handleSelectRoot = async () => {
      setIsLinkModalOpen(true);
  };

  const performFullDriveSync = async (manual = false) => {
      if(!isAuthorized || !stateRef.current.driveRootFolderId) return;
      setIsSyncing(true);
      if(manual) pushNotice({ message: "Scanning Drive...", type: 'info', ms: 0 });
      
      try {
         const s = stateRef.current;
         const { booksId, savesId, trashId } = await ensureRootStructure(s.driveRootFolderId);
         const driveBooks = await listFoldersInFolder(booksId);
         
         const updatedBooks = [...s.books];
         
         for (const db of driveBooks) {
             const files = await listFilesInFolder(db.id);
             const chaptersMap = new Map<string, Partial<Chapter>>();
             
             for (const f of files) {
                 // Support new c_<id> format
                 const match = f.name.match(/^c_(.*?)\.(txt|mp3)$/i);
                 if (match) {
                     const id = match[1];
                     const ext = match[2].toLowerCase();
                     
                     if (!chaptersMap.has(id)) {
                         chaptersMap.set(id, { id, index: 0, title: 'Imported Chapter', filename: '', content: '', wordCount: 0, progress: 0, progressChars: 0, updatedAt: Date.now() });
                     }
                     const ch = chaptersMap.get(id)!;
                     if (ext === 'txt') {
                         ch.cloudTextFileId = f.id;
                         ch.filename = f.name;
                         ch.hasTextOnDrive = true;
                     } else {
                         ch.cloudAudioFileId = f.id;
                         ch.audioStatus = AudioStatus.READY;
                     }
                 }
             }
             
             const driveChapters: Chapter[] = Array.from(chaptersMap.values())
                 .filter(c => c.cloudTextFileId || c.cloudAudioFileId)
                 .map(c => ({
                     ...c,
                     id: c.id || crypto.randomUUID(),
                 } as Chapter));

             const existingBookIdx = updatedBooks.findIndex(b => b.driveFolderId === db.id);
             if (existingBookIdx !== -1) {
                 const existingBook = updatedBooks[existingBookIdx];
                 const mergedChapters = [...existingBook.chapters];
                 
                 for (const dc of driveChapters) {
                     const existingChIdx = mergedChapters.findIndex(ec => 
                         ec.id === dc.id || ec.cloudTextFileId === dc.cloudTextFileId
                     );
                     
                     if (existingChIdx !== -1) {
                         mergedChapters[existingChIdx] = {
                             ...mergedChapters[existingChIdx],
                             ...dc,
                             progress: mergedChapters[existingChIdx].progress,
                             progressSec: mergedChapters[existingChIdx].progressSec,
                             isCompleted: mergedChapters[existingChIdx].isCompleted
                         };
                     } else {
                         mergedChapters.push(dc);
                     }
                 }
                 updatedBooks[existingBookIdx] = { ...existingBook, chapters: mergedChapters.sort((a,b) => a.index - b.index) };
             } else {
                 updatedBooks.push({
                     id: db.id,
                     title: db.name,
                     backend: StorageBackend.DRIVE,
                     driveFolderId: db.id,
                     driveFolderName: db.name,
                     chapters: driveChapters.sort((a,b) => a.index - b.index),
                     rules: [],
                     settings: { useBookSettings: false, highlightMode: HighlightMode.WORD },
                     updatedAt: Date.now()
                 });
             }
         }
         
         setState(p => ({ ...p, books: updatedBooks, driveSubfolders: { booksId, savesId, trashId } }));
         markDirty();
         setIsSyncing(false);
         if(manual) pushNotice({ message: "Sync Complete", type: 'success' });
      } catch (e: any) {
         setIsSyncing(false);
         pushNotice({ message: "Sync Failed: " + e.message, type: 'error', ms: 0 });
      }
  };

  const handleSync = async (manual = false) => {
      await performFullDriveSync(manual);
  };

  const handleRunMigration = () => pushNotice({ message: "Not implemented", type: 'info', ms: 0 });
  
  const handleScanAndRebuild = useCallback(async () => {
    setIsScanningRules(true);
    setScanProgress('Updating...');
    try {
      const s = stateRef.current;
      const book = s.books.find(b => b.id === s.activeBookId);
      if (book && book.currentChapterId) {
         await hardRefreshForChapter(book.id, book.currentChapterId);
         pushNotice({ message: "Chapter Refreshed", type: 'success', ms: 1000 });
      } else {
         pushNotice({ message: "Refreshed", type: 'info', ms: 1000 });
      }
    } catch (e) {
      console.warn(e);
    } finally {
      setIsScanningRules(false);
      setScanProgress('');
    }
  }, [hardRefreshForChapter, pushNotice]);

  const prefsJson = useMemo(() => {
    const prefs = {
      activeBookId: state.activeBookId,
      playbackSpeed: state.playbackSpeed,
      selectedVoiceName: state.selectedVoiceName,
      theme: state.theme,
      debugMode: state.debugMode,
      readerSettings: state.readerSettings,
      driveToken: state.driveToken,
      googleClientId: state.googleClientId,
      keepAwake: state.keepAwake,
      lastSavedAt: state.lastSavedAt,
      driveRootFolderId: state.driveRootFolderId,
      driveRootFolderName: state.driveRootFolderName,
      driveSubfolders: state.driveSubfolders,
      autoSaveInterval: state.autoSaveInterval,
      globalRules: state.globalRules,
      showDiagnostics: state.showDiagnostics
    };
    return JSON.stringify(prefs);
  }, [
    state.activeBookId,
    state.playbackSpeed,
    state.selectedVoiceName,
    state.theme,
    state.debugMode,
    state.readerSettings,
    state.driveToken,
    state.googleClientId,
    state.keepAwake,
    state.lastSavedAt,
    state.driveRootFolderId,
    state.driveRootFolderName,
    state.driveSubfolders,
    state.autoSaveInterval,
    state.globalRules,
    state.showDiagnostics
  ]);

  useEffect(() => {
    safeSetLocalStorage(PREFS_KEY, prefsJson);
  }, [prefsJson]);

  const LinkCloudModal = () => {
    const [candidates, setCandidates] = useState<{id: string, name: string, hasState: boolean}[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
      findTaleVoxRoots().then(res => {
        setCandidates(res);
        setLoading(false);
      }).catch(() => setLoading(false));
    }, []);

    const handleSelect = async (id: string, name: string) => {
      setState(p => ({ ...p, driveRootFolderId: id, driveRootFolderName: name }));
      setIsLinkModalOpen(false);
      markDirty();
      setTimeout(() => performFullDriveSync(true), 500);
    };

    const handleCreateNew = async () => {
      setLoading(true);
      try {
        const id = await createDriveFolder("TaleVox");
        handleSelect(id, "TaleVox");
      } catch (e: any) {
        pushNotice({ message: "Failed to create folder", type: 'error', ms: 0 });
        setLoading(false);
      }
    };

    return (
      <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-black/60 backdrop-blur-md">
        <div className={`w-full max-w-md rounded-[2.5rem] shadow-2xl p-8 space-y-6 animate-in zoom-in-95 ${state.theme === Theme.DARK ? 'bg-slate-900 border border-white/10' : 'bg-white'}`}>
          <div className="flex justify-between items-center">
            <h3 className="text-xl font-black tracking-tight flex items-center gap-3"><FolderSync className="w-6 h-6 text-indigo-600" /> Link Cloud Folder</h3>
            <button onClick={() => setIsLinkModalOpen(false)} className="p-2 opacity-40 hover:opacity-100"><X className="w-5 h-5" /></button>
          </div>
          
          <div className="space-y-4">
            <p className="text-xs font-bold opacity-60 leading-relaxed">Select an existing TaleVox folder or create a new one to sync your library.</p>
            
            <div className="max-h-[40vh] overflow-y-auto space-y-2 pr-2">
              {loading ? (
                <div className="py-12 flex flex-col items-center gap-3 opacity-40">
                  <Loader2 className="w-6 h-6 animate-spin" />
                  <span className="text-[10px] font-black uppercase tracking-widest">Searching Drive...</span>
                </div>
              ) : candidates.length === 0 ? (
                <div className="py-8 text-center text-[10px] font-black uppercase opacity-30">No existing folders found</div>
              ) : (
                candidates.map(c => (
                  <button key={c.id} onClick={() => handleSelect(c.id, c.name)} className={`w-full p-4 rounded-2xl border-2 text-left transition-all flex items-center justify-between ${state.theme === Theme.DARK ? 'bg-white/5 border-white/5 hover:border-indigo-600' : 'bg-black/5 border-transparent hover:border-indigo-600'}`}>
                    <div className="min-w-0">
                      <div className="text-sm font-black truncate">{c.name}</div>
                      {c.hasState && <div className="text-[9px] font-black text-emerald-500 uppercase mt-0.5 flex items-center gap-1"><CheckCircle2 className="w-3 h-3" /> Contains TaleVox State</div>}
                    </div>
                    <FolderSync className="w-4 h-4 opacity-20" />
                  </button>
                ))
              )}
            </div>

            <button onClick={handleCreateNew} disabled={loading} className="w-full py-4 bg-indigo-600 text-white rounded-2xl font-black uppercase text-[10px] tracking-widest shadow-xl hover:scale-[1.02] active:scale-95 transition-all flex items-center justify-center gap-2">
              <Plus className="w-4 h-4" /> Create New "TaleVox" Folder
            </button>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className={`flex flex-col h-screen overflow-hidden font-sans transition-colors duration-500 ${state.theme === Theme.DARK ? 'bg-slate-950 text-slate-100' : state.theme === Theme.SEPIA ? 'bg-[#f4ecd8] text-[#3c2f25]' : 'bg-white text-black'}`}>
      
      {isLinkModalOpen && <LinkCloudModal />}

      {state.showDiagnostics && (
        <div className="fixed top-20 right-4 z-[1000] p-4 bg-black/80 backdrop-blur-md text-white text-[10px] font-mono rounded-xl shadow-2xl border border-white/10 pointer-events-none opacity-80">
          <div className="flex items-center gap-2 mb-2 border-b border-white/20 pb-1">
            <Terminal className="w-3 h-3 text-indigo-400" />
            <span className="font-bold">Playback Diagnostics {effectiveMobileMode ? '(Mobile)' : ''}</span>
          </div>
          <div>Phase: <span className="text-emerald-400">{playbackPhase}</span></div>
          <div>Session: {chapterSessionRef.current}</div>
          <div>Audio Time: {audioCurrentTime.toFixed(2)}s</div>
          <div>Duration: {audioDuration.toFixed(2)}s</div>
          <div>Gesture Armed: {gestureArmedRef.current ? 'YES' : 'NO'}</div>
          <div>Blocked: {autoplayBlocked ? 'YES' : 'NO'}</div>
        </div>
      )}

      {toast && (
        <div className="fixed bottom-8 left-1/2 -translate-x-1/2 z-[100] animate-in fade-in slide-in-from-bottom-4">
           <div className={`px-6 py-3 rounded-2xl shadow-2xl font-black text-xs uppercase tracking-widest flex items-center gap-3 ${toast.type === 'error' ? 'bg-red-500 text-white' : toast.type === 'success' ? 'bg-emerald-500 text-white' : 'bg-slate-900 text-white'}`}>
             {toast.type === 'error' ? <AlertCircle className="w-4 h-4" /> : toast.type === 'success' ? <Cloud className="w-4 h-4" /> : <Loader2 className="w-4 h-4 animate-spin" />}
             {toast.message}
           </div>
        </div>
      )}

      <header className={`h-16 border-b flex items-center justify-between px-4 lg:px-8 z-10 sticky top-0 transition-colors ${state.theme === Theme.DARK ? 'border-slate-800 bg-slate-900/80 backdrop-blur-md' : state.theme === Theme.SEPIA ? 'border-[#d8ccb6] bg-[#efe6d5]/90 backdrop-blur-md' : 'border-black/5 bg-white/90 backdrop-blur-md'}`}>
        <div className="flex items-center gap-4">
          {activeTab === 'reader' && (
            <button onClick={() => setIsChapterSidebarOpen(true)} className="flex items-center gap-2 px-3 py-2 bg-black/5 rounded-xl text-[10px] font-black uppercase tracking-widest lg:hidden hover:bg-black/10">
              <List className="w-4 h-4" /> <span className="hidden xs:inline">Chapters</span>
            </button>
          )}
          <nav className="flex items-center gap-4 sm:gap-6 overflow-x-auto no-scrollbar">
            <button onClick={() => setActiveTab('library')} className={`flex items-center gap-2 h-16 border-b-2 font-black uppercase text-[10px] tracking-widest flex-shrink-0 ${activeTab === 'library' || activeTab === 'collection' ? 'border-indigo-600 text-indigo-600' : 'border-transparent opacity-60'}`}><LibraryIcon className="w-4 h-4" /> <span className="hidden sm:inline">Library</span></button>
            <button onClick={() => setActiveTab('rules')} className={`flex items-center gap-2 h-16 border-b-2 font-black uppercase text-[10px] tracking-widest flex-shrink-0 ${activeTab === 'rules' ? 'border-indigo-600 text-indigo-600' : 'border-transparent opacity-60'}`}><Zap className="w-4 h-4" /> <span className="hidden sm:inline">Rules</span></button>
            <button onClick={() => setActiveTab('settings')} className={`flex items-center gap-2 h-16 border-b-2 font-black uppercase text-[10px] tracking-widest flex-shrink-0 ${activeTab === 'settings' ? 'border-indigo-600 text-indigo-600' : 'border-transparent opacity-60'}`}><SettingsIcon className="w-4 h-4" /> <span className="hidden sm:inline">Settings</span></button>
          </nav>
        </div>
        <div className="flex items-center gap-2 sm:gap-4">
          {authState.status === 'signing_in' ? (
             <span className="flex items-center gap-2 px-3 py-2 bg-black/5 rounded-xl text-[10px] font-black uppercase tracking-widest"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Signing In...</span>
          ) : authState.status === 'expired' || !isAuthorized ? (
            <button onClick={handleReconnectDrive} className="flex items-center gap-2 px-3 py-2 bg-amber-600 text-white rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-amber-700 transition-all shadow-md"><LogIn className="w-3.5 h-3.5" /> <span className="hidden xs:inline">Reconnect Drive</span></button>
          ) : (
            <button onClick={() => handleSync(true)} disabled={isSyncing} className={`flex items-center gap-2 px-3 py-2 bg-indigo-600/10 text-indigo-600 rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-indigo-600/20 transition-all ${isSyncing ? 'animate-pulse' : ''}`}><RefreshCw className="w-3.5 h-3.5" /> <span className="hidden xs:inline">Sync</span></button>
          )}
          <button onClick={() => handleSaveState(true, false)} className={`p-2.5 rounded-xl bg-indigo-600/10 text-indigo-600 hover:bg-indigo-600/20 transition-all ${isDirty ? 'ring-2 ring-indigo-600 animate-pulse' : ''}`} title="Manual Cloud Save"><Save className="w-4 h-4" /></button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto relative flex">
        {(isLoadingChapter || playbackPhase === 'LOADING_TEXT' || playbackPhase === 'LOADING_AUDIO') && (
            <div className="absolute inset-0 flex items-center justify-center bg-inherit z-[70]">
                <div className="flex flex-col items-center gap-3">
                    <Loader2 className="w-10 h-10 text-indigo-600 animate-spin" />
                    <span className="text-[10px] font-black uppercase tracking-widest opacity-60">
                        {playbackPhase === 'LOADING_TEXT' ? 'Loading Text...' : 'Loading Audio...'}
                    </span>
                </div>
            </div>
        )}
        
        {isSyncing && !toast && (
          <div className="fixed top-20 right-4 z-[80] animate-in slide-in-from-right duration-300">
             <div className="bg-indigo-600 text-white px-4 py-2 rounded-xl shadow-2xl flex items-center gap-3 font-black text-[10px] uppercase tracking-widest">
               <Loader2 className="w-3.5 h-3.5 animate-spin" /> Syncing...
             </div>
          </div>
        )}
        {isAddChapterOpen && (
          <div className="absolute inset-0 z-[60] overflow-y-auto p-4 lg:p-12 backdrop-blur-md bg-black/10">
            <div className="max-w-4xl mx-auto relative">
              <button onClick={() => setIsAddChapterOpen(false)} className="absolute -top-4 -right-4 p-3 bg-white text-black shadow-2xl rounded-full hover:scale-110 active:scale-95 transition-transform z-10"><X className="w-6 h-6" /></button>
              <Extractor 
                onChapterExtracted={handleChapterExtracted} 
                suggestedIndex={activeBook?.chapters.length ? Math.max(...activeBook.chapters.map(c => c.index)) + 1 : 1} 
                theme={state.theme} 
                defaultVoiceId={activeBook?.settings.defaultVoiceId} 
                existingChapters={activeBook?.chapters || []}
              />
            </div>
          </div>
        )}
        
        {activeTab === 'reader' && activeBook && (
          <aside className="hidden lg:block w-72 border-r border-black/5 bg-black/5 overflow-y-auto">
             <ChapterSidebar 
               book={activeBook} theme={state.theme} onSelectChapter={handleSmartOpenChapter} 
               onClose={() => {}} isDrawer={false}
               playbackSnapshot={playbackSnapshot}
               onLoadMoreChapters={() => void loadMoreChapters(activeBook.id, false)}
               hasMoreChapters={chapterPagingByBook[activeBook.id]?.hasMore ?? true}
               isLoadingMoreChapters={chapterPagingByBook[activeBook.id]?.loading ?? false}
             />
          </aside>
        )}

        {isChapterSidebarOpen && activeBook && (
          <div className="fixed inset-0 z-[60] flex">
            <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setIsChapterSidebarOpen(false)} />
            <div className={`relative w-[85%] max-sm max-w-sm h-full shadow-2xl animate-in slide-in-from-left duration-300 ${state.theme === Theme.DARK ? 'bg-slate-900' : state.theme === Theme.SEPIA ? 'bg-[#efe6d5]' : 'bg-white'}`}>
              <ChapterSidebar 
                book={activeBook} theme={state.theme} onSelectChapter={(id) => { handleSmartOpenChapter(id); setIsChapterSidebarOpen(false); }} 
                onClose={() => setIsChapterSidebarOpen(false)} isDrawer={true}
                playbackSnapshot={playbackSnapshot}
                onLoadMoreChapters={() => void loadMoreChapters(activeBook.id, false)}
                hasMoreChapters={chapterPagingByBook[activeBook.id]?.hasMore ?? true}
                isLoadingMoreChapters={chapterPagingByBook[activeBook.id]?.loading ?? false}
              />
            </div>
          </div>
        )}

        <div className="flex-1 min-w-0 h-full overflow-y-auto">
          {activeTab === 'library' && (
            <Library 
              books={state.books} activeBookId={state.activeBookId}
              onSelectBook={id => {
                setState(p => ({ ...p, activeBookId: id }));
                setActiveTab('collection');
                void loadMoreChapters(id, true);
              }} 
              onAddBook={handleAddBook}
              onDeleteBook={async (id) => {
                try {
                  await libraryDeleteBook(id);
                } catch (e: any) {
                  console.error('[TaleVox][Library] delete failed', e);
                }
                setState(p => ({ ...p, books: p.books.filter(b => b.id !== id), activeBookId: p.activeBookId === id ? undefined : p.activeBookId }));
                markDirty();
              }}
              onUpdateBook={async (book) => {
                // Fix: Merge fields into existing book to preserve chapterCount
                const s = stateRef.current;
                const existing = s.books.find(b => b.id === book.id);
                const merged = {
                   ...existing,
                   ...book,
                   chapterCount: existing?.chapterCount ?? book.chapterCount,
                   chapters: existing?.chapters ?? book.chapters ?? []
                };

                try {
                  await libraryUpsertBook({ ...merged, directoryHandle: undefined });
                } catch (e: any) {
                  console.error('[TaleVox][Library] update failed', e);
                }
                setState(p => ({
                  ...p,
                  books: p.books.map(b => {
                    if (b.id !== book.id) return b;

                    return {
                      ...b,
                      ...book,

                      // Preserve the currently loaded chapter page and the known total count.
                      chapterCount: b.chapterCount,
                      chapters: b.chapters,
                    };
                  })
                }));
                markDirty();
              }}
              theme={state.theme}
              isCloudLinked={!!state.driveRootFolderId}
              onLinkCloud={handleSelectRoot}
            />
          )}
          
          {activeTab === 'collection' && activeBook && (
            <ChapterFolderView 
              book={activeBook} theme={state.theme} onAddChapter={() => setIsAddChapterOpen(true)}
              onOpenChapter={handleSmartOpenChapter}
              onToggleFavorite={() => {}} onUpdateChapterTitle={(id, t) => { setState(p => ({ ...p, books: p.books.map(b => b.id === activeBook.id ? { ...b, chapters: b.chapters.map(c => c.id === id ? { ...c, title: t } : c) } : b) })); markDirty(); }}
              onDeleteChapter={id => { setState(p => ({ ...p, books: p.books.map(b => b.id === activeBook.id ? { ...b, chapters: b.chapters.filter(c => c.id !== id) } : b) })); markDirty(); }}
              onUpdateChapter={c => { setState(prev => ({ ...prev, books: prev.books.map(b => b.id === activeBook.id ? { ...b, chapters: b.chapters.map(ch => ch.id === c.id ? c : ch) } : b) })); markDirty(); }}
              onUpdateBookSettings={s => {
                const updatedBook = { ...activeBook, settings: { ...activeBook.settings, ...s } };
                setState(p => {
                  const next = { ...p, books: p.books.map(b => b.id === activeBook.id ? updatedBook : b) };
                  if (s.defaultVoiceId) {
                    next.selectedVoiceName = s.defaultVoiceId;
                  }
                  return next;
                });
                void libraryUpsertBook(updatedBook);
                markDirty();
              }}
              onBackToLibrary={() => setActiveTab('library')}
              onResetChapterProgress={handleResetChapterProgress}
              playbackSnapshot={playbackSnapshot}
              onLoadMoreChapters={() => void loadMoreChapters(activeBook.id, false)}
              hasMoreChapters={chapterPagingByBook[activeBook.id]?.hasMore ?? true}
              isLoadingMoreChapters={chapterPagingByBook[activeBook.id]?.loading ?? false}
              globalRules={state.globalRules}
              reflowLineBreaksEnabled={state.readerSettings.reflowLineBreaks}
              onAppendChapters={(newChapters) => {
                setState((prev) => ({
                  ...prev,
                  books: prev.books.map((b) => {
                    if (b.id !== activeBook.id) return b;

                    const combined = [...(b.chapters || []), ...newChapters];

                    // Deduplicate by chapter id
                    const seen = new Set<string>();
                    const deduped = combined.filter((c) => {
                      if (seen.has(c.id)) return false;
                      seen.add(c.id);
                      return true;
                    });

                    // Keep list ordered by chapter index
                    deduped.sort((a, c) => a.index - c.index);

                    return {
                      ...b,
                      chapters: deduped,

                      // Total chapter count should be the known total, not just the loaded page.
                      // These are newly created chapters, so adding is correct here.
                      chapterCount: (b.chapterCount ?? 0) + newChapters.length,
                    };
                  }),
                }));

                markDirty();
              }}
            />
          )}

          {activeTab === 'reader' && activeBook && activeChapterMetadata && (
            <Reader 
              chapter={activeChapterMetadata} rules={[...state.globalRules, ...activeBook.rules]} currentOffsetChars={state.currentOffsetChars} theme={state.theme}
              debugMode={state.debugMode} onToggleDebug={() => setState(p => ({ ...p, debugMode: !p.debugMode }))} onJumpToOffset={handleJumpToOffset}
              onBackToCollection={() => setActiveTab('collection')} onAddChapter={() => setIsAddChapterOpen(true)}
              highlightMode={activeBook.settings.highlightMode} readerSettings={state.readerSettings}
              isMobile={effectiveMobileMode}
            />
          )}

          {activeTab === 'rules' && (
            <RuleManager 
              rules={activeBook?.rules || []} globalRules={state.globalRules} theme={state.theme} 
              onAddRule={r => { 
                if (r.global) {
                  setState(p => ({ ...p, globalRules: [...p.globalRules, r] }));
                } else if (activeBook) {
                  setState(p => ({ ...p, books: p.books.map(b => b.id === activeBook.id ? { ...b, rules: [...b.rules, r] } : b) })); 
                }
                markDirty(); 
              }}
              onUpdateRule={() => {}} 
              onDeleteRule={(id, isGlobal) => { 
                if (isGlobal) {
                  setState(p => ({ ...p, globalRules: p.globalRules.filter(r => r.id !== id) }));
                } else if (activeBook) {
                  setState(p => ({ ...p, books: p.books.map(b => b.id === activeBook.id ? { ...b, rules: b.rules.filter(r => r.id !== id) } : b) })); 
                }
                markDirty(); 
              }}
              onImportRules={rules => {
                 if (activeBook) {
                    setState(p => ({ ...p, books: p.books.map(b => b.id === activeBook.id ? { ...b, rules: [...b.rules, ...rules] } : b) })); 
                    markDirty();
                 }
              }}
              selectedVoice={activeBook?.settings.defaultVoiceId || 'en-US-Standard-C'}
              playbackSpeed={activeBook?.settings.useBookSettings && activeBook.settings.playbackSpeed ? activeBook.settings.playbackSpeed : state.playbackSpeed}
              onScanAndRebuild={handleScanAndRebuild}
              isScanning={isScanningRules}
              scanProgress={scanProgress}
            />
          )}

          {activeTab === 'settings' && (
            <Settings 
              settings={state.readerSettings} 
              onUpdate={s => setState(p => ({ ...p, readerSettings: { ...p.readerSettings, ...s } }))}
              theme={state.theme} 
              onSetTheme={t => setState(p => ({ ...p, theme: t }))}
              keepAwake={state.keepAwake}
              onSetKeepAwake={k => setState(p => ({ ...p, keepAwake: k }))}
              onCheckForUpdates={() => window.location.reload()}
              isCloudLinked={!!state.driveRootFolderId}
              onLinkCloud={handleSelectRoot}
              onSyncNow={() => handleSync(true)}
              isSyncing={isSyncing}
              googleClientId={state.googleClientId}
              onUpdateGoogleClientId={id => setState(p => ({ ...p, googleClientId: id }))}
              onClearAuth={() => { authManager.signOut(); setState(p => ({ ...p, driveRootFolderId: undefined })); }}
              onSaveState={() => handleSaveState(true, false)}
              lastSavedAt={state.lastSavedAt}
              driveRootName={state.driveRootFolderName}
              onSelectRoot={handleSelectRoot}
              onRunMigration={handleSaveState}
              syncDiagnostics={state.syncDiagnostics}
              autoSaveInterval={state.autoSaveInterval}
              onSetAutoSaveInterval={v => setState(p => ({ ...p, autoSaveInterval: v }))}
              isDirty={isDirty}
              showDiagnostics={state.showDiagnostics}
              onSetShowDiagnostics={v => setState(p => ({ ...p, showDiagnostics: v }))}
              onRecalculateProgress={handleReconcileProgress}
            />
          )}
        </div>
      </div>

      {activeTab === 'reader' && (
        <Player 
          isPlaying={isPlaying} onPlay={() => handleManualPlay()} onPause={handleManualPause} onStop={handleManualStop}
          onNext={() => handleNextChapterRef.current(false)} onPrev={handlePrevChapter} onSeek={handleSeekByDelta}
          speed={state.playbackSpeed} onSpeedChange={s => setState(p => ({ ...p, playbackSpeed: s }))}
          selectedVoice={state.selectedVoiceName || ''} onVoiceChange={() => {}}
          theme={state.theme} onThemeChange={t => setState(p => ({ ...p, theme: t }))}
          progressChars={state.currentOffsetChars} totalLengthChars={activeChapterMetadata?.content?.length || 0} wordCount={activeChapterMetadata?.wordCount || 0}
          onSeekToOffset={handleJumpToOffset}
          sleepTimer={sleepTimerSeconds} onSetSleepTimer={setSleepTimerSeconds}
          stopAfterChapter={stopAfterChapter} onSetStopAfterChapter={setStopAfterChapter}
          useBookSettings={activeBook?.settings.useBookSettings || false}
          onSetUseBookSettings={v => { if(activeBook) setState(p => ({ ...p, books: p.books.map(b => b.id === activeBook.id ? { ...b, settings: { ...b.settings, useBookSettings: v } } : b) })); }}
          highlightMode={activeBook?.settings.highlightMode || HighlightMode.WORD}
          onSetHighlightMode={v => { if(activeBook) setState(p => ({ ...p, books: p.books.map(b => b.id === activeBook.id ? { ...b, settings: { ...b.settings, highlightMode: v } } : b) })); }}
          playbackCurrentTime={audioCurrentTime} playbackDuration={audioDuration} isFetching={playbackPhase === 'LOADING_AUDIO' || playbackPhase === 'SEEKING' || playbackPhase === 'LOADING_TEXT'}
          onSeekToTime={handleSeekCommit} 
          autoplayBlocked={autoplayBlocked}
          onScrubStart={handleScrubStart}
          onScrubMove={handleScrubMove}
          onScrubEnd={handleSeekCommit}
          isMobile={effectiveMobileMode}
        />
      )}
    </div>
  );
};

export default App;
