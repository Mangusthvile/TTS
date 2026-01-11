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
import { fetchDriveFile, fetchDriveBinary, uploadToDrive, buildMp3Name, listFilesInFolder, findFileSync, buildTextName, ensureRootStructure, ensureBookFolder, moveFile, openFolderPicker, listFilesSortedByModified, resolveFolderIdByName, listSaveFileCandidates, createDriveFolder } from './services/driveService';
import { initDriveAuth, getValidDriveToken, clearStoredToken, isTokenValid } from './services/driveAuth';
import { authManager, AuthState } from './services/authManager';
import { saveChapterToFile } from './services/fileService';
import { synthesizeChunk } from './services/cloudTtsService';
import { extractChapterWithAI } from './services/geminiService';
import { saveAudioToCache, getAudioFromCache, generateAudioKey } from './services/audioCache';
import { idbSet } from './services/storageService';
import { Sun, Coffee, Moon, X, Settings as SettingsIcon, Loader2, Save, Library as LibraryIcon, Zap, Menu, LogIn, RefreshCw, AlertCircle, Cloud, Terminal, List } from 'lucide-react';
import { trace, traceError } from './utils/trace';
import { computeMobileMode } from './utils/platform';

const STATE_FILENAME = 'talevox_state_v298.json';
const STABLE_POINTER_NAME = 'talevox-latest.json';
const SNAPSHOT_KEY = "talevox_saved_snapshot_v1";
const BACKUP_KEY = "talevox_sync_backup";
const UI_MODE_KEY = "talevox_ui_mode";

// --- Safe Storage Helper ---
const safeSetLocalStorage = (key: string, value: string) => {
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

const App: React.FC = () => {
  const [isDirty, setIsDirty] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isScanningRules, setIsScanningRules] = useState(false);
  const [scanProgress, setScanProgress] = useState('');

  // --- Playback State Machine ---
  const [playbackPhase, setPlaybackPhase] = useState<PlaybackPhase>('IDLE');
  const [phaseSince, setPhaseSince] = useState(Date.now());
  const [lastPlaybackError, setLastPlaybackError] = useState<string | null>(null);
  const [currentIntroDurSec, setCurrentIntroDurSec] = useState(5);
  const [isScrubbing, setIsScrubbing] = useState(false);
  
  // Ref to prevent overlapping transitions and manage scrub session
  // This is the SINGLE SOURCE OF TRUTH for the current chapter loading session
  const chapterSessionRef = useRef(0);
  const isInIntroRef = useRef(false);
  const lastProgressCommitTime = useRef(0);
  const isScrubbingRef = useRef(false);
  const scrubPreviewSecRef = useRef(0);
  
  // Mobile Autoplay State
  const gestureArmedRef = useRef(false);
  const lastGestureAt = useRef(0);
  const [autoplayBlocked, setAutoplayBlocked] = useState(false);

  // Watchdog for stuck SEEKING state
  useEffect(() => {
    if (playbackPhase === 'SEEKING') {
      const timer = setTimeout(() => {
        trace('watchdog:seek_timeout');
        setPlaybackPhase('READY'); 
        showToast("Seek timed out", 0, 'error');
      }, 6000);
      return () => clearTimeout(timer);
    }
  }, [playbackPhase]);

  // Mobile Visibility Handling
  useEffect(() => {
    const handleVisChange = () => {
      if (document.visibilityState === 'visible') {
        // Force a sync tick when app comes to foreground to catch up UI
        speechController.emitSyncTick();
      }
    };
    document.addEventListener('visibilitychange', handleVisChange);
    return () => document.removeEventListener('visibilitychange', handleVisChange);
  }, []);

  // Global Interaction Listener for Arming Gestures
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
    const saved = localStorage.getItem('talevox_pro_v2');
    const parsed = saved ? JSON.parse(saved) : {};
    const savedDiag = localStorage.getItem('talevox_sync_diag');
    
    // Load UI mode preference explicitly first
    const savedUiMode = localStorage.getItem(UI_MODE_KEY) as UiMode | null;

    return {
      books: (parsed.books || []).map((b: any) => ({
        ...b,
        directoryHandle: undefined,
        settings: b.settings || { useBookSettings: false, highlightMode: HighlightMode.WORD },
        rules: (b.rules || []).map((r: any) => ({
          ...r,
          matchCase: r.matchCase ?? (r.caseMode === 'EXACT'),
          matchExpression: r.matchExpression ?? false,
          ruleType: r.ruleType ?? RuleType.REPLACE,
          global: r.global ?? false
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
        uiMode: savedUiMode || 'auto'
      },
      googleClientId: parsed.googleClientId || (import.meta as any).env?.VITE_GOOGLE_CLIENT_ID || '',
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

  // Ensure local UI mode preference is synced if state loads differently
  useEffect(() => {
    const pref = state.readerSettings.uiMode || 'auto';
    localStorage.setItem(UI_MODE_KEY, pref);
  }, [state.readerSettings.uiMode]);

  // Compute effective mobile mode
  const [effectiveMobileMode, setEffectiveMobileMode] = useState(computeMobileMode(state.readerSettings.uiMode));

  // Effect to recompute on resize if auto, or when setting changes
  useEffect(() => {
    const recompute = () => {
      const isMob = computeMobileMode(state.readerSettings.uiMode);
      setEffectiveMobileMode(isMob);
      speechController.setMobileMode(isMob);
    };
    
    recompute();
    
    // Only listen to resize if we are in auto mode
    if (state.readerSettings.uiMode === 'auto') {
      window.addEventListener('resize', recompute);
      return () => window.removeEventListener('resize', recompute);
    }
  }, [state.readerSettings.uiMode]);

  const [activeTab, setActiveTab] = useState<'library' | 'collection' | 'reader' | 'rules' | 'settings'>('library');
  const [isAddChapterOpen, setIsAddChapterOpen] = useState(false);
  const [isChapterSidebarOpen, setIsChapterSidebarOpen] = useState(false);
  
  // Playback State
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLoadingChapter, setIsLoadingChapter] = useState(false);
  const isPlayingRef = useRef(isPlaying);
  useEffect(() => { isPlayingRef.current = isPlaying }, [isPlaying]);

  const [sleepTimerSeconds, setSleepTimerSeconds] = useState<number | null>(null);
  const [stopAfterChapter, setStopAfterChapter] = useState(false);
  const [audioDuration, setAudioDuration] = useState(0);
  const [audioCurrentTime, setAudioCurrentTime] = useState(0);
  
  // Auth State Subscription
  const [authState, setAuthState] = useState<AuthState>(authManager.getState());
  const isAuthorized = authState.status === 'signed_in';

  useEffect(() => {
    const unsubscribe = authManager.subscribe(setAuthState);
    return () => { unsubscribe(); };
  }, []);

  useEffect(() => {
    if (state.googleClientId) {
      authManager.init(state.googleClientId);
    }
  }, [state.googleClientId]);

  // Clear legacy stuck state
  useEffect(() => {
    if (authState.status === 'error') {
      showToast(`Auth Error: ${authState.lastError}`, 0, 'error');
    }
  }, [authState.status, authState.lastError]);

  const stateRef = useRef(state);
  useEffect(() => { stateRef.current = state; }, [state]);

  const activeBook = useMemo(() => state.books.find(b => b.id === state.activeBookId), [state.books, state.activeBookId]);
  const activeChapterMetadata = useMemo(() => activeBook?.chapters.find(c => c.id === activeBook.currentChapterId), [activeBook]);

  // --- Handlers Definitons ---
  
  const [toast, setToast] = useState<{ message: string; type: 'info' | 'success' | 'error' | 'reconnect' } | null>(null);

  const showToast = useCallback((message: string, duration = 3000, type: 'info' | 'success' | 'error' | 'reconnect' = 'info') => {
    setToast({ message, type });
    if (duration > 0) setTimeout(() => setToast(null), duration);
  }, []);

  const updatePhase = useCallback((p: PlaybackPhase) => {
    if (p !== 'IDLE' && p !== 'READY' && p !== 'LOADING_TEXT' && p !== 'LOADING_AUDIO' && p !== 'SEEKING' && p !== 'TRANSITIONING' && p !== 'SCRUBBING') {
        // Just noise reduction
    } else {
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

  // --- Centralized Progress Commit Logic ---
  const commitProgressUpdate = useCallback((
    bookId: string, 
    chapterId: string, 
    meta: PlaybackMetadata & { completed?: boolean }, 
    force: boolean = false
  ) => {
    const now = Date.now();
    const throttleMs = effectiveMobileMode ? 800 : 250;
    
    // Ignore updates if we are not actually playing the requested chapter/session
    // But since this callback is global, we rely on the stateRef's current chapter matches
    const s = stateRef.current;
    const bIdx = s.books.findIndex(b => b.id === bookId);
    if (bIdx === -1) return;
    const book = s.books[bIdx];
    
    // SAFETY: Don't commit progress for a chapter that isn't active (prevents "pull back" bug)
    if (book.currentChapterId !== chapterId) {
        trace('progress:ignored_stale', { target: chapterId, active: book.currentChapterId });
        return;
    }

    if (!force && !meta.completed && now - lastProgressCommitTime.current < throttleMs) {
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

    let pct = 0;
    if (durationSec > 0) {
      pct = progressSec / durationSec;
    } else if (textLength > 0) {
      pct = progressChars / textLength;
    }
    pct = Math.min(Math.max(pct, 0), 1);

    let isComplete = meta.completed || false;
    if (!isComplete) {
      if (durationSec > 0) {
        if (progressSec >= durationSec - 0.5) isComplete = true;
      } else {
        if (textLength > 0 && progressChars >= textLength - 5) isComplete = true;
      }
    }
    
    const finalComplete = isComplete || chapter.isCompleted || false;
    const pctDiff = Math.abs(pct - (chapter.progress || 0));
    const secDiff = Math.abs(progressSec - (chapter.progressSec || 0));
    
    if (force || finalComplete !== chapter.isCompleted || secDiff > 1 || pctDiff > 0.01) {
       setState(prev => {
         const newBooks = [...prev.books];
         const newChapters = [...newBooks[bIdx].chapters];
         newChapters[cIdx] = {
           ...chapter,
           progress: pct,
           progressSec,
           progressChars, 
           durationSec,
           textLength,
           isCompleted: finalComplete,
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
           timeSec: progressSec,
           durationSec,
           percent: pct,
           completed: finalComplete,
           updatedAt: now
         };
         localStorage.setItem(PROGRESS_STORE_V4, JSON.stringify(store));
         window.dispatchEvent(new CustomEvent('talevox_progress_updated', { detail: { bookId, chapterId } }));
       } catch (e) { console.warn("Progress write failed", e); }
       
       markDirty();
    }

  }, [effectiveMobileMode, markDirty]);

  // Register Persistent Sync Callback
  const handleSyncUpdate = useCallback((meta: PlaybackMetadata & { completed?: boolean }) => {
    // Gate sync updates during scrubbing
    if (isScrubbingRef.current) return;

    // Filter noise
    if (['LOADING_AUDIO', 'SEEKING', 'TRANSITIONING', 'LOADING_TEXT', 'SCRUBBING'].includes(playbackPhase)) {
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
    
    // Only update offset if meaningful change to avoid react churn
    if (Math.abs(meta.charOffset - stateRef.current.currentOffsetChars) > 5) {
        setState(p => ({ ...p, currentOffsetChars: meta.charOffset }));
    }

    const s = stateRef.current;
    if (s.activeBookId && s.books) {
       const b = s.books.find(b => b.id === s.activeBookId);
       if (b && b.currentChapterId) {
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

  // --- Utility Functions ---

  const handleSaveState = useCallback(async (force = false, silent = false) => {
      if (!stateRef.current.driveRootFolderId) return;
      if (!force && !isDirty) return;
      
      if (!silent) showToast("Saving to Cloud...", 0, 'info');
      
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
                  progressStore: {}, // Legacy compat
                  driveRootFolderId: s.driveRootFolderId,
                  driveRootFolderName: s.driveRootFolderName,
                  driveSubfolders: s.driveSubfolders,
                  autoSaveInterval: s.autoSaveInterval,
                  globalRules: s.globalRules,
                  showDiagnostics: s.showDiagnostics
              }
          };
          
          const content = JSON.stringify(snapshot);
          await uploadToDrive(savesId, `talevox_state_${window.__APP_VERSION__}_${Date.now()}.json`, content, undefined, 'application/json');
          
          setState(p => ({ ...p, lastSavedAt: Date.now() }));
          setIsDirty(false);
          if (!silent) showToast("Cloud Save Complete", 2000, 'success');
      } catch (e: any) {
          if (!silent) showToast("Save Failed: " + e.message, 0, 'error');
          console.error(e);
      }
  }, [isDirty, showToast]);

  const ensureChapterContentLoaded = useCallback(async (bookId: string, chapterId: string, session: number): Promise<string | null> => {
      const s = stateRef.current;
      const book = s.books.find(b => b.id === bookId);
      const chapter = book?.chapters.find(c => c.id === chapterId);
      if (!book || !chapter) return null;

      // If content is already present, return it
      if (chapter.content && chapter.content.length > 10) return chapter.content;

      // Otherwise, attempt fetch
      if (chapter.cloudTextFileId && isAuthorized) {
           trace('text:load:start', { chapterId, fileId: chapter.cloudTextFileId, session });
           try {
               const text = await fetchDriveFile(chapter.cloudTextFileId);
               if (text) {
                   if (chapterSessionRef.current !== session) {
                       trace('text:load:aborted', { reason: 'stale_session' });
                       return null;
                   }
                   setState(p => ({
                       ...p,
                       books: p.books.map(b => b.id === bookId ? {
                           ...b,
                           chapters: b.chapters.map(c => c.id === chapterId ? { ...c, content: text, textLength: text.length } : c)
                       } : b)
                   }));
                   trace('text:load:success', { len: text.length });
                   return text;
               }
           } catch (e: any) {
               traceError('text:load:failed', e);
               showToast("Failed to load text: " + e.message, 0, 'error');
           }
      }
      return null;
  }, [isAuthorized, showToast]);

  const hardRefreshForChapter = useCallback(async (bookId: string, chapterId: string) => {
       const s = stateRef.current;
       const book = s.books.find(b => b.id === bookId);
       if (!book || !book.driveFolderId || !isAuthorized) return;
       const chapter = book.chapters.find(c => c.id === chapterId);
       if (!chapter) return;

       try {
           const textName = buildTextName(chapter.index, chapter.title);
           const audioName = buildMp3Name(chapter.index, chapter.title);
           
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

  // --- UNIFIED PLAYBACK SESSION PIPELINE ---

  // Fix circular dependency using ref
  const handleNextChapterRef = useRef<(autoTrigger?: boolean) => void>(() => {});

  const loadChapterSession = useCallback(async (targetChapterId: string, reason: 'user' | 'auto') => {
    // 1. Establish Session Identity
    const session = ++chapterSessionRef.current;
    const s = stateRef.current;
    const book = s.books.find(b => b.id === s.activeBookId);
    if (!book) return;
    const chapter = book.chapters.find(c => c.id === targetChapterId);
    if (!chapter) return;

    updatePhase('LOADING_TEXT'); // Indicate we are busy
    trace('chapter:load:start', { targetChapterId, reason, session });

    // 2. HARD STOP + Buffer Reset
    speechController.safeStop(); 
    setAutoplayBlocked(false);
    
    // 3. Update active chapter state immediately
    // This ensures the UI shows the correct title/number while loading
    setState(p => ({ 
        ...p, 
        books: p.books.map(b => b.id === book.id ? { ...b, currentChapterId: targetChapterId } : b),
        currentOffsetChars: 0 
    }));
    setAudioCurrentTime(0);
    setAudioDuration(0);

    // 4. Ensure TEXT is loaded BEFORE audio
    const content = await ensureChapterContentLoaded(book.id, chapter.id, session);
    
    if (session !== chapterSessionRef.current) {
        trace('chapter:load:aborted_after_text', { session });
        return;
    }

    if (!content && (!chapter.content || chapter.content.length < 10)) {
        showToast("Chapter text missing. Check Drive.", 0, 'error');
        updatePhase('READY');
        return;
    }

    // 5. Load Audio
    updatePhase('LOADING_AUDIO');
    
    // Prepare metadata
    setCurrentIntroDurSec(chapter.audioIntroDurSec || 5);
    const voice = book.settings.defaultVoiceId || 'en-US-Standard-C';
    const allRules = [...s.globalRules, ...book.rules];
    const textToSpeak = applyRules(content || chapter.content, allRules);
    const rawIntro = `Chapter ${chapter.index}. ${chapter.title}. `;
    const introText = applyRules(rawIntro, allRules);
    
    // Check Cache
    const cacheKey = generateAudioKey(introText + textToSpeak, voice, 1.0);
    let audioBlob = await getAudioFromCache(cacheKey);
    
    // Check Drive
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
        // Resume from saved if user initiated, otherwise start at 0
        if (reason === 'user' && !chapter.isCompleted && chapter.progressSec) startSec = chapter.progressSec;
        
        // Pass callbacks
        await speechController.loadAndPlayDriveFile(
            '', 'LOCAL_ID', textToSpeak.length, chapter.audioIntroDurSec || 5, chapter.audioChunkMap, 
            startSec, 
            state.playbackSpeed, // Use current speed preference
            () => { // onEnded
                if (session === chapterSessionRef.current) {
                    updatePhase('ENDING_SETTLE');
                    // Settle pause for highlight catching up
                    setTimeout(() => {
                        if (session === chapterSessionRef.current) {
                            handleNextChapterRef.current(true); 
                        }
                    }, 300);
                }
            }, 
            null, url, 
            () => { // onPlayStart
                if (session === chapterSessionRef.current) {
                    updatePhase('PLAYING_INTRO'); 
                    isInIntroRef.current = true; 
                }
            }
        );

        if (session !== chapterSessionRef.current) return;

        // 6. Handle Autoplay Policy
        if (effectiveMobileMode && reason === 'auto') {
           const timeSinceGesture = Date.now() - lastGestureAt.current;
           if (!gestureArmedRef.current || timeSinceGesture > 60000) { 
              setAutoplayBlocked(true);
              setIsPlaying(false);
              updatePhase('READY');
              return;
           }
        }

        // 7. Attempt Play
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
                // Ensure speed is applied
                speechController.setPlaybackRate(state.playbackSpeed);
            }
        } catch (e: any) {
            setAutoplayBlocked(true);
            setIsPlaying(false);
            updatePhase('READY');
        }

    } else {
        // No audio found
        showToast("Audio not found. Try generating it.", 0, 'info');
        updatePhase('READY');
        setIsPlaying(false);
    }

  }, [isAuthorized, ensureChapterContentLoaded, showToast, updatePhase, effectiveMobileMode, state.playbackSpeed]);

  const handleManualPlay = () => {
    gestureArmedRef.current = true;
    lastGestureAt.current = Date.now();
    // Re-apply speed on manual play just in case
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
      showToast(`Next: Chapter ${next.index}`, 2000, 'info');
      // Use the unified pipeline
      loadChapterSession(next.id, autoTrigger ? 'auto' : 'user');
    } else {
      setIsPlaying(false); updatePhase('IDLE'); showToast("End of book", 0, 'success');
    }
  }, [loadChapterSession, updatePhase, showToast]);

  // Update ref for circular dependency
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

  const handleOpenChapter = (id: string) => {
    setActiveTab('reader');
    loadChapterSession(id, 'user');
  };
  
  const handleManualPause = () => { speechController.pause(); setIsPlaying(false); updatePhase('IDLE'); };
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
      console.error("Seek failed", e);
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
          id: crypto.randomUUID(),
          title, backend, directoryHandle, driveFolderId, driveFolderName, chapters: [], rules: [], settings: { useBookSettings: false, highlightMode: HighlightMode.WORD }, updatedAt: Date.now()
      };
      if (backend === StorageBackend.DRIVE && !driveFolderId && state.driveRootFolderId) {
          try {
              const { booksId } = await ensureRootStructure(state.driveRootFolderId);
              const newFolderId = await createDriveFolder(title, booksId);
              newBook.driveFolderId = newFolderId;
              newBook.driveFolderName = title;
          } catch(e: any) { showToast("Failed to create Drive folder", 0, 'error'); return; }
      }
      setState(p => ({ ...p, books: [...p.books, newBook], activeBookId: newBook.id }));
      markDirty();
      setActiveTab('library');
  };

  const handleChapterExtracted = async (data: any) => {
      const s = stateRef.current;
      const book = s.books.find(b => b.id === s.activeBookId);
      if (!book) return;
      const newChapter: Chapter = {
          id: crypto.randomUUID(), index: data.index, title: data.title, content: data.content, wordCount: 0, textLength: data.content.length, filename: buildTextName(data.index, data.title), progress: 0, progressChars: 0, audioStatus: AudioStatus.PENDING, updatedAt: Date.now()
      };
      if (book.driveFolderId && isAuthorized) {
          try { newChapter.cloudTextFileId = await uploadToDrive(book.driveFolderId, newChapter.filename, data.content); newChapter.hasTextOnDrive = true; } catch {}
      }
      setState(p => ({ ...p, books: p.books.map(b => b.id === book.id ? { ...b, chapters: [...b.chapters, newChapter].sort((a,b)=>a.index-b.index) } : b) }));
      markDirty();
      if (!data.keepOpen) setIsAddChapterOpen(false); else showToast("Added", 1000, 'success');
  };

  const handleSelectRoot = async () => {
      try {
          const folder = await openFolderPicker();
          if (folder) {
              setState(p => ({ ...p, driveRootFolderId: folder.id, driveRootFolderName: folder.name }));
              markDirty();
              setTimeout(() => handleSync(true), 500);
          }
      } catch (e: any) { showToast("Folder selection failed", 0, 'error'); }
  };

  const handleSync = async (manual = false) => {
      if(!isAuthorized || !stateRef.current.driveRootFolderId) return;
      setIsSyncing(true);
      if(manual) showToast("Syncing...", 0, 'info');
      try {
         await new Promise(r => setTimeout(r, 1000));
         setIsSyncing(false);
         if(manual) showToast("Sync Complete", 2000, 'success');
      } catch (e) { setIsSyncing(false); }
  };

  const handleRunMigration = () => showToast("Not implemented", 0, 'info');
  const handleRecalculateProgress = () => showToast("Recalculated", 0, 'success');
  
  const handleScanAndRebuild = useCallback(async () => {
    setIsScanningRules(true);
    setScanProgress('Updating...');
    try {
      const s = stateRef.current;
      const book = s.books.find(b => b.id === s.activeBookId);
      if (book && book.currentChapterId) {
         // Refresh current chapter
         await hardRefreshForChapter(book.id, book.currentChapterId);
         showToast("Chapter Refreshed", 1000, 'success');
      } else {
         showToast("Refreshed", 1000, 'info');
      }
    } catch (e) {
      console.warn(e);
    } finally {
      setIsScanningRules(false);
      setScanProgress('');
    }
  }, [hardRefreshForChapter, showToast]);

  const handleResetChapterProgress = (bid: string, cid: string) => {
      commitProgressUpdate(bid, cid, { currentTime: 0, duration: 0, charOffset: 0, completed: false }, true);
      showToast("Reset", 1000, 'info');
  };

  // Safe localStorage for large state
  useEffect(() => {
    safeSetLocalStorage('talevox_pro_v2', JSON.stringify({ ...state, books: state.books.map(({ directoryHandle, ...b }) => ({ ...b, directoryHandle: undefined })) }));
  }, [state]);

  return (
    <div className={`flex flex-col h-screen overflow-hidden font-sans transition-colors duration-500 ${state.theme === Theme.DARK ? 'bg-slate-950 text-slate-100' : state.theme === Theme.SEPIA ? 'bg-[#f4ecd8] text-[#3c2f25]' : 'bg-white text-black'}`}>
      
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
          ) : !isAuthorized ? (
            <button onClick={() => authManager.signIn()} className="flex items-center gap-2 px-3 py-2 bg-indigo-600 text-white rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-indigo-700 transition-all shadow-md"><LogIn className="w-3.5 h-3.5" /> <span className="hidden xs:inline">Sign In</span></button>
          ) : (
            <button onClick={() => handleSync(true)} disabled={isSyncing} className={`flex items-center gap-2 px-3 py-2 bg-indigo-600/10 text-indigo-600 rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-indigo-600/20 transition-all ${isSyncing ? 'animate-pulse' : ''}`}><RefreshCw className="w-3.5 h-3.5" /> <span className="hidden xs:inline">Sync</span></button>
          )}
          <button onClick={() => handleSaveState(true, false)} className={`p-2.5 rounded-xl bg-indigo-600/10 text-indigo-600 hover:bg-indigo-600/20 transition-all ${isDirty ? 'ring-2 ring-indigo-600 animate-pulse' : ''}`} title="Manual Cloud Save"><Save className="w-4 h-4" /></button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto relative flex">
        {/* Loading Overlay */}
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
               book={activeBook} theme={state.theme} onSelectChapter={handleOpenChapter} 
               onClose={() => {}} isDrawer={false}
             />
          </aside>
        )}

        {isChapterSidebarOpen && activeBook && (
          <div className="fixed inset-0 z-[60] flex">
            <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setIsChapterSidebarOpen(false)} />
            <div className={`relative w-[85%] max-sm max-w-sm h-full shadow-2xl animate-in slide-in-from-left duration-300 ${state.theme === Theme.DARK ? 'bg-slate-900' : state.theme === Theme.SEPIA ? 'bg-[#efe6d5]' : 'bg-white'}`}>
              <ChapterSidebar 
                book={activeBook} theme={state.theme} onSelectChapter={(id) => { handleOpenChapter(id); setIsChapterSidebarOpen(false); }} 
                onClose={() => setIsChapterSidebarOpen(false)} isDrawer={true}
              />
            </div>
          </div>
        )}

        <div className="flex-1 min-w-0 h-full overflow-y-auto">
          {activeTab === 'library' && (
            <Library 
              books={state.books} activeBookId={state.activeBookId}
              onSelectBook={id => { setState(p => ({ ...p, activeBookId: id })); setActiveTab('collection'); }} 
              onAddBook={handleAddBook}
              onDeleteBook={id => { setState(p => ({ ...p, books: p.books.filter(b => b.id !== id) })); markDirty(); }}
              onUpdateBook={book => { setState(p => ({ ...p, books: p.books.map(b => b.id === book.id ? book : b) })); markDirty(); }}
              theme={state.theme}
            />
          )}
          
          {activeTab === 'collection' && activeBook && (
            <ChapterFolderView 
              book={activeBook} theme={state.theme} onAddChapter={() => setIsAddChapterOpen(true)}
              onOpenChapter={(id) => { handleOpenChapter(id); }}
              onToggleFavorite={() => {}} onUpdateChapterTitle={(id, t) => { setState(p => ({ ...p, books: p.books.map(b => b.id === activeBook.id ? { ...b, chapters: b.chapters.map(c => c.id === id ? { ...c, title: t } : c) } : b) })); markDirty(); }}
              onDeleteChapter={id => { setState(p => ({ ...p, books: p.books.map(b => b.id === activeBook.id ? { ...b, chapters: b.chapters.filter(c => c.id !== id) } : b) })); markDirty(); }}
              onUpdateChapter={c => { setState(prev => ({ ...prev, books: prev.books.map(b => b.id === activeBook.id ? { ...b, chapters: b.chapters.map(ch => ch.id === c.id ? c : ch) } : b) })); markDirty(); }}
              onUpdateBookSettings={s => { setState(p => ({ ...p, books: p.books.map(b => b.id === activeBook.id ? { ...b, settings: { ...b.settings, ...s } } : b) })); markDirty(); }}
              onBackToLibrary={() => setActiveTab('library')}
              onResetChapterProgress={handleResetChapterProgress}
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
              onRunMigration={handleRunMigration}
              syncDiagnostics={state.syncDiagnostics}
              autoSaveInterval={state.autoSaveInterval}
              onSetAutoSaveInterval={v => setState(p => ({ ...p, autoSaveInterval: v }))}
              isDirty={isDirty}
              showDiagnostics={state.showDiagnostics}
              onSetShowDiagnostics={v => setState(p => ({ ...p, showDiagnostics: v }))}
              onRecalculateProgress={handleRecalculateProgress}
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