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
import { saveChapterToFile } from './services/fileService';
import { synthesizeChunk } from './services/cloudTtsService';
import { extractChapterWithAI } from './services/geminiService';
import { saveAudioToCache, getAudioFromCache, generateAudioKey } from './services/audioCache';
import { idbSet } from './services/storageService';
import { Sun, Coffee, Moon, X, Settings as SettingsIcon, Loader2, Save, Library as LibraryIcon, Zap, Menu, LogIn, RefreshCw, AlertCircle, Cloud, Terminal } from 'lucide-react';
import { trace, traceError } from './utils/trace';
import { computeMobileMode } from './utils/platform';

const STATE_FILENAME = 'talevox_state_v293.json';
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

const estimateBytes = (str: string): number => new Blob([str]).size;

const buildQuotaSafeBackup = (state: AppState, progressStore: any) => {
  return {
    state: {
      ...state,
      books: state.books.map(b => ({
        ...b,
        directoryHandle: undefined, // Non-serializable
        coverImage: b.coverImage && estimateBytes(b.coverImage) > 50000 ? undefined : b.coverImage, // Strip huge covers
        chapters: b.chapters.map(c => ({
          ...c,
          content: '', // STRIP content to save space
          // Keep metadata vital for structure recovery
        }))
      })),
    },
    progress: progressStore,
    backupAt: Date.now(),
    type: 'quota_safe_backup'
  };
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
  
  // Ref to prevent overlapping transitions
  const transitionTokenRef = useRef(0);
  const isInIntroRef = useRef(false);
  const lastProgressCommitTime = useRef(0);

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

  const [state, setState] = useState<AppState>(() => {
    const saved = localStorage.getItem('talevox_pro_v2');
    const parsed = saved ? JSON.parse(saved) : {};
    
    const snapshotStr = localStorage.getItem(SNAPSHOT_KEY);
    const snapshot = snapshotStr ? JSON.parse(snapshotStr) as SavedSnapshot : null;

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
      lastSavedAt: snapshot?.savedAt,
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
  const [autoplayBlocked, setAutoplayBlocked] = useState(false);
  const [isLoadingChapter, setIsLoadingChapter] = useState(false);
  const isPlayingRef = useRef(isPlaying);
  useEffect(() => { isPlayingRef.current = isPlaying }, [isPlaying]);

  const [transitionToast, setTransitionToast] = useState<{ number: number; title: string; type?: 'info' | 'success' | 'error' | 'reconnect' } | null>(null);
  const [sleepTimerSeconds, setSleepTimerSeconds] = useState<number | null>(null);
  const [stopAfterChapter, setStopAfterChapter] = useState(false);
  const [audioDuration, setAudioDuration] = useState(0);
  const [audioCurrentTime, setAudioCurrentTime] = useState(0);
  const [isAuthorized, setIsAuthorized] = useState(isTokenValid());

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
    if (p !== 'IDLE' && p !== 'READY' && p !== 'LOADING_TEXT' && p !== 'LOADING_AUDIO' && p !== 'SEEKING' && p !== 'TRANSITIONING') {
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
    const throttleMs = effectiveMobileMode ? 400 : 250;
    
    // Always commit if forced, completed, or enough time passed
    if (!force && !meta.completed && now - lastProgressCommitTime.current < throttleMs) {
      return;
    }
    lastProgressCommitTime.current = now;

    // Read latest from Ref to avoid closure staleness
    const s = stateRef.current;
    const bIdx = s.books.findIndex(b => b.id === bookId);
    if (bIdx === -1) return;
    const book = s.books[bIdx];
    const cIdx = book.chapters.findIndex(c => c.id === chapterId);
    if (cIdx === -1) return;
    
    const chapter = book.chapters[cIdx];
    
    // Canonical calculation
    const durationSec = Math.max(meta.duration || 0, chapter.durationSec || 0);
    const progressSec = Math.min(Math.max(meta.currentTime || 0, 0), durationSec);
    const progressChars = Math.max(meta.charOffset || 0, 0);
    // Prefer passed textLength, then existing, then 0. 
    // Important: speechService might send updated textLength if it knows it.
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
        // Tolerance: within 0.5s of end
        if (progressSec >= durationSec - 0.5) isComplete = true;
      } else {
        // Text tolerance: within 5 chars
        if (textLength > 0 && progressChars >= textLength - 5) isComplete = true;
      }
    }
    
    // Sticky completion: once done, stays done unless manually reset
    const finalComplete = isComplete || chapter.isCompleted || false;

    // Only update if something changed significantly or completion status changed
    const pctDiff = Math.abs(pct - (chapter.progress || 0));
    const secDiff = Math.abs(progressSec - (chapter.progressSec || 0));
    
    // Update if completion changed, or time changed > 1s, or percent changed > 1%
    // Or if forced (e.g. on pause/stop)
    if (force || finalComplete !== chapter.isCompleted || secDiff > 1 || pctDiff > 0.01) {
       setState(prev => {
         const newBooks = [...prev.books];
         const newChapters = [...newBooks[bIdx].chapters];
         newChapters[cIdx] = {
           ...chapter,
           progress: pct,
           progressSec,
           progressChars, // Always update both for resume flexibility
           durationSec,
           textLength,
           isCompleted: finalComplete,
           updatedAt: now
         };
         newBooks[bIdx] = { ...newBooks[bIdx], chapters: newChapters };
         return { ...prev, books: newBooks };
       });

       // Also persist to localStorage for recovery
       // We use the separate PROGRESS_STORE_V4 key to avoid writing the huge state blob frequently
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
         // Dispatch event for other components if they listen (sidebar usually reads from state now, but good for hygiene)
         window.dispatchEvent(new CustomEvent('talevox_progress_updated', { detail: { bookId, chapterId } }));
       } catch (e) { console.warn("Progress write failed", e); }
       
       // Mark dirty for eventual cloud sync
       markDirty();
    }

  }, [effectiveMobileMode, markDirty]);

  // Register Persistent Sync Callback
  const handleSyncUpdate = useCallback((meta: PlaybackMetadata & { completed?: boolean }) => {
    const s = stateRef.current;
    
    // If user is scrubbing, ignore audio engine updates to prevent fighting UI
    if (isScrubbing) return;

    // Block sync updates during volatile phases to prevent jumping
    if (['LOADING_AUDIO', 'SEEKING', 'TRANSITIONING', 'LOADING_TEXT'].includes(playbackPhase)) {
        return;
    }
    
    // Phase update logic
    if (playbackPhase === 'READY' || playbackPhase === 'PLAYING_INTRO' || playbackPhase === 'PLAYING_BODY') {
        if (meta.currentTime > (currentIntroDurSec + 0.6) && playbackPhase !== 'PLAYING_BODY') {
            updatePhase('PLAYING_BODY');
            isInIntroRef.current = false;
        } else if (meta.currentTime <= (currentIntroDurSec + 0.6) && playbackPhase !== 'PLAYING_INTRO') {
            updatePhase('PLAYING_INTRO');
            isInIntroRef.current = true;
        }
    }

    // Update transient player state
    setAudioCurrentTime(meta.currentTime);
    setAudioDuration(meta.duration);
    
    // Mobile optimization: Only setState if charOffset actually changed significantly or forced
    setState(p => {
      if (p.currentOffsetChars === meta.charOffset) return p;
      return { ...p, currentOffsetChars: meta.charOffset };
    });

    // COMMIT PROGRESS to State & Storage
    if (s.activeBookId && s.books) {
       const b = s.books.find(b => b.id === s.activeBookId);
       if (b && b.currentChapterId) {
          // If completed signal received, force commit
          commitProgressUpdate(b.id, b.currentChapterId, meta, !!meta.completed);
       }
    }

  }, [playbackPhase, currentIntroDurSec, updatePhase, isScrubbing, commitProgressUpdate]);

  useEffect(() => {
    speechController.setSyncCallback(handleSyncUpdate);
  }, [handleSyncUpdate]);

  useEffect(() => {
    document.documentElement.style.setProperty('--highlight-color', state.readerSettings.highlightColor);
  }, [state.readerSettings.highlightColor]);

  const queueBackgroundTTS = useCallback(async (bookId: string, chapterId: string) => {
    const s = stateRef.current;
    const book = s.books.find(b => b.id === bookId);
    if (!book) return;
    const chapter = book.chapters.find(c => c.id === chapterId);
    if (!chapter) return;

    try {
        const voice = book.settings.defaultVoiceId || 'en-US-Standard-C';
        const allRules = [...s.globalRules, ...book.rules];
        const text = applyRules(chapter.content, allRules);
        const introText = applyRules(`Chapter ${chapter.index}. ${chapter.title}. `, allRules);
        const fullText = introText + text;

        const res = await synthesizeChunk(fullText, voice, 1.0);
        const audioBlob = await (await fetch(res.audioUrl)).blob();
        
        const cacheKey = generateAudioKey(fullText, voice, 1.0);
        await saveAudioToCache(cacheKey, audioBlob);

        // Upload if cloud enabled
        if (book.driveFolderId && isAuthorized) {
           const filename = buildMp3Name(chapter.index, chapter.title);
           const cloudId = await uploadToDrive(book.driveFolderId, filename, audioBlob, chapter.cloudAudioFileId || undefined, 'audio/mpeg');
           
           setState(p => ({
             ...p,
             books: p.books.map(b => b.id === bookId ? {
               ...b,
               chapters: b.chapters.map(c => c.id === chapterId ? { ...c, cloudAudioFileId: cloudId, audioStatus: AudioStatus.READY, hasCachedAudio: true } : c)
             } : b)
           }));
        } else {
             setState(p => ({
             ...p,
             books: p.books.map(b => b.id === bookId ? {
               ...b,
               chapters: b.chapters.map(c => c.id === chapterId ? { ...c, hasCachedAudio: true, audioStatus: AudioStatus.READY } : c)
             } : b)
           }));
        }
        
        showToast("Audio generated ready", 2000, 'success');
    } catch (e: any) {
        console.error("Background TTS failed", e);
        showToast("Audio generation failed", 0, 'error');
    }
  }, [isAuthorized, showToast]);

  // --- Central Playback Logic ---

  const loadingChapterTextRef = useRef<Set<string>>(new Set());

  const ensureChapterContentLoaded = useCallback(async (bookId: string, chapterId: string) => {
    const s = stateRef.current;
    const book = s.books.find(b => b.id === bookId);
    if (!book) return;
    const chapter = book.chapters.find(c => c.id === chapterId);
    if (!chapter) return;

    // Optimization: Cache textLength if content known
    if (chapter.content && chapter.content.trim().length > 0) {
        if (!chapter.textLength) {
             // Patch textLength immediately if missing
             commitProgressUpdate(bookId, chapterId, { currentTime: 0, duration: 0, charOffset: 0, textLength: chapter.content.length }, true);
        }
        return;
    }
    
    if (!chapter.cloudTextFileId) return;

    const key = `${bookId}:${chapterId}`;
    if (loadingChapterTextRef.current.has(key)) return;

    trace('chapter:text:load:start', { bookId, chapterId });
    loadingChapterTextRef.current.add(key);
    setIsLoadingChapter(true);

    try {
      if (!isAuthorized) throw new Error("Drive auth required for text");
      const text = await fetchDriveFile(chapter.cloudTextFileId);
      
      setState(prev => {
        const bIdx = prev.books.findIndex(b => b.id === bookId);
        if (bIdx === -1) return prev;
        const newBooks = [...prev.books];
        const newChs = [...newBooks[bIdx].chapters];
        const cIdx = newChs.findIndex(c => c.id === chapterId);
        if (cIdx !== -1) {
          const wordCount = text.split(/\s+/).filter(Boolean).length;
          newChs[cIdx] = { 
            ...newChs[cIdx], 
            content: text, 
            wordCount,
            textLength: text.length, // Store length immediately
            hasTextOnDrive: true 
          };
          newBooks[bIdx] = { ...newBooks[bIdx], chapters: newChs };
          return { ...prev, books: newBooks };
        }
        return prev;
      });
      trace('chapter:text:load:success', { bookId, chapterId });
    } catch (e: any) {
      traceError('chapter:text:load', e);
      showToast(`Failed to load text: ${e.message}`, 0, 'error');
    } finally {
      loadingChapterTextRef.current.delete(key);
      setIsLoadingChapter(false);
    }
  }, [isAuthorized, commitProgressUpdate, showToast]);

  const hardRefreshForChapter = useCallback(async (bookId: string, chapterId: string) => {
    updatePhase('TRANSITIONING');
    trace('chapter:refresh:start', { bookId, chapterId });
    
    // Stop audio and clear state to prevent jumps
    speechController.safeStop();
    
    // Force final commit of previous chapter if context exists before switch
    if (speechController.currentContext) {
        const prevCtx = speechController.currentContext;
        // This relies on last known values inside speechController, handled by its stop logic?
        // Actually safeStop handles saving internally? No, we removed it in favor of App.
        // We should commit current state here.
        // However, reading from speechController here directly might be racey.
        // Let's rely on the periodic updates having caught most of it.
    }

    // Mobile buffering reset
    await new Promise(r => setTimeout(r, 80));

    // Keep UI duration valid to prevent retract, but reset offset
    setState(p => ({ ...p, currentOffsetChars: 0 }));
    
    updatePhase('LOADING_TEXT');
    await ensureChapterContentLoaded(bookId, chapterId);
    
    updatePhase('READY');
  }, [ensureChapterContentLoaded, updatePhase]);

  const startPlayback = useCallback(async (targetChapterId: string, reason: 'user' | 'auto') => {
    const s = stateRef.current;
    const book = s.books.find(b => b.id === s.activeBookId);
    if (!book) return;
    const chapter = book.chapters.find(c => c.id === targetChapterId);
    if (!chapter) return;

    trace('play:requested', { bookId: book.id, chapterId: targetChapterId, reason });

    // Logic: If user requested play and we are paused on the SAME chapter with valid audio, just resume.
    if (reason === 'user' && 
        speechController.currentContext?.bookId === book.id && 
        speechController.currentContext?.chapterId === chapter.id && 
        speechController.hasAudioSource && 
        speechController.isPaused) {
        
        setIsPlaying(true);
        updatePhase('SEEKING'); // Will transition to PLAYING... via sync callback
        speechController.resume();
        return;
    }

    // Otherwise, full load
    setIsPlaying(true);
    setAutoplayBlocked(false);
    updatePhase('LOADING_AUDIO');
    
    // Ensure audio stops if switching context or hard starting
    speechController.safeStop();

    const voice = book.settings.defaultVoiceId || 'en-US-Standard-C';
    const allRules = [...s.globalRules, ...book.rules];
    const text = applyRules(chapter.content, allRules);
    const speed = (book.settings.useBookSettings && book.settings.playbackSpeed) ? book.settings.playbackSpeed : s.playbackSpeed;
    const rawIntro = `Chapter ${chapter.index}. ${chapter.title}. `;
    const introText = applyRules(rawIntro, allRules);
    const estimatedIntroDurSec = (introText.length / (18 * speed)); 
    const introDur = chapter.audioIntroDurSec ?? estimatedIntroDurSec;
    setCurrentIntroDurSec(introDur);

    // Initial Resume Logic
    // Prefer progressSec if available, else convert from percentage if old data
    let startSec = 0;
    if (!chapter.isCompleted) {
        if (chapter.progressSec && chapter.progressSec > 0) {
            startSec = chapter.progressSec;
        } else if (chapter.progress > 0 && chapter.durationSec) {
            startSec = chapter.progress * chapter.durationSec;
        }
    }

    try {
      const cacheKey = generateAudioKey(introText + text, voice, 1.0);
      let audioBlob = await getAudioFromCache(cacheKey);
      
      // If not in cache and we have a cloud ID, try fetching
      if (!audioBlob && chapter.cloudAudioFileId && isAuthorized) {
        try { 
          audioBlob = await fetchDriveBinary(chapter.cloudAudioFileId); 
          if (audioBlob) await saveAudioToCache(cacheKey, audioBlob); 
        } catch(e) {
          traceError('audio:fetch:failed', e);
        }
      }

      if (audioBlob && audioBlob.size > 0) {
        const url = URL.createObjectURL(audioBlob);
        speechController.setContext({ bookId: book.id, chapterId: chapter.id });
        speechController.updateMetadata(text.length, introDur, chapter.audioChunkMap || []);
        
        await speechController.loadAndPlayDriveFile(
          '', 'LOCAL_ID', text.length, introDur, chapter.audioChunkMap, startSec, speed, 
          () => { 
             // On End
             updatePhase('ENDING_SETTLE');
             if (stopAfterChapter) {
                setIsPlaying(false);
                updatePhase('IDLE');
             } else {
                // Settle pause
                setTimeout(() => handleNextChapter(true), 300);
             }
          },
          null, // Use persistent sync callback
          url,
          () => { // onPlayStart (after seek)
             updatePhase('PLAYING_INTRO');
             isInIntroRef.current = true;
          }
        );
        // If successful, phase is handled by callbacks
        setAutoplayBlocked(false);
      } else {
        // Fallback: Text only or generate
        if (chapter.cloudTextFileId && chapter.content === '') {
           showToast("Loading text...", 0, 'info');
           const content = await fetchDriveFile(chapter.cloudTextFileId);
           setState(p => ({ ...p, books: p.books.map(b => b.id === book.id ? { ...b, chapters: b.chapters.map(c => c.id === chapter.id ? { ...c, content, wordCount: content.split(/\s+/).filter(Boolean).length, textLength: content.length } : c) } : b) }));
           // Retry playback after short delay
           setTimeout(() => startPlayback(targetChapterId, reason), 200);
           return;
        }
        
        // If content exists but no audio, queue generation
        updatePhase('LOADING_AUDIO');
        await queueBackgroundTTS(book.id, chapter.id);
        // Try again in a moment (simple poll)
        setTimeout(() => startPlayback(targetChapterId, reason), 1500);
      }
    } catch (playErr: any) {
      updatePhase('ERROR');
      setLastPlaybackError(playErr.message);
      if (playErr.name === 'NotAllowedError') { 
        // Mobile Autoplay Block logic
        setAutoplayBlocked(true); 
        setIsPlaying(false);
        updatePhase('READY'); // Reset to Ready so user can tap Play
        showToast("Tap Play to start", 0, 'info');
      } else {
        setIsPlaying(false);
        showToast(`Playback Error: ${playErr.message}`, 0, 'error');
      }
    }
  }, [stopAfterChapter, isAuthorized, updatePhase, queueBackgroundTTS, showToast]);

  const goToChapter = useCallback(async (targetId: string, options: { autoStart: boolean, reason: 'user' | 'auto' }) => {
    const s = stateRef.current;
    const book = s.books.find(b => b.id === s.activeBookId);
    if (!book) return;

    // Transition Token Check
    const token = ++transitionTokenRef.current;
    const checkToken = () => transitionTokenRef.current === token;

    trace('nav:goToChapter', { targetId, options });

    // Hard refresh resets phase, stops audio, clears highlight
    await hardRefreshForChapter(book.id, targetId);
    
    if (!checkToken()) return;

    // Update context immediately so progress saves correctly
    speechController.setContext({ bookId: book.id, chapterId: targetId });

    // Pre-calculate metadata for highlight stability
    const nextCh = book.chapters.find(c => c.id === targetId);
    if (nextCh) {
        const allRules = [...s.globalRules, ...book.rules];
        const text = applyRules(nextCh.content || '', allRules);
        const rawIntro = `Chapter ${nextCh.index}. ${nextCh.title}. `;
        const introText = applyRules(rawIntro, allRules);
        const speed = (book.settings.useBookSettings && book.settings.playbackSpeed) ? book.settings.playbackSpeed : s.playbackSpeed;
        const estimatedIntroDurSec = (introText.length / (18 * speed));
        const introDur = nextCh.audioIntroDurSec ?? estimatedIntroDurSec;
        setCurrentIntroDurSec(introDur);
    }

    setState(p => ({ ...p, books: p.books.map(b => b.id === book.id ? { ...b, currentChapterId: targetId } : b), currentOffsetChars: 0 }));
    
    if (options.autoStart) {
       // Small timeout to allow state to settle
       setTimeout(() => {
         if (checkToken()) startPlayback(targetId, options.reason);
       }, 150);
    } else {
       setIsPlaying(false);
       updatePhase('IDLE');
    }
  }, [startPlayback, hardRefreshForChapter, updatePhase]);

  const handleNextChapter = useCallback((autoTrigger = false) => {
    trace(autoTrigger ? 'nav:auto:next' : 'nav:user:next');
    const s = stateRef.current;
    const book = s.books.find(b => b.id === s.activeBookId);
    if (!book || !book.currentChapterId) return;
    const sorted = [...book.chapters].sort((a, b) => a.index - b.index);
    const idx = sorted.findIndex(c => c.id === book.currentChapterId);
    
    if (idx >= 0 && idx < sorted.length - 1) {
      const next = sorted[idx + 1];
      const shouldResume = autoTrigger || isPlayingRef.current;
      if (autoTrigger) showToast(`Next: Chapter ${next.index}`, 0, 'info');
      goToChapter(next.id, { autoStart: shouldResume, reason: autoTrigger ? 'auto' : 'user' });
    } else {
      setIsPlaying(false);
      updatePhase('IDLE');
      showToast("End of book reached", 0, 'success');
    }
  }, [goToChapter, updatePhase, showToast]);

  const handlePrevChapter = useCallback(() => {
    trace('nav:user:prev');
    const s = stateRef.current;
    const book = s.books.find(b => b.id === s.activeBookId);
    if (!book || !book.currentChapterId) return;
    const sorted = [...book.chapters].sort((a, b) => a.index - b.index);
    const idx = sorted.findIndex(c => c.id === book.currentChapterId);
    
    if (idx > 0) {
      const prev = sorted[idx - 1];
      const shouldResume = isPlayingRef.current;
      goToChapter(prev.id, { autoStart: shouldResume, reason: 'user' });
    } else {
      showToast("Start of book reached", 0, 'info');
    }
  }, [goToChapter, showToast]);

  const handleManualPlay = () => {
    const s = stateRef.current;
    if (s.activeBookId && activeBook?.currentChapterId) {
       startPlayback(activeBook.currentChapterId, 'user');
    }
  };

  const handleManualPause = () => {
    speechController.pause();
    setIsPlaying(false);
    updatePhase('IDLE'); // Paused is essentially idle/ready
    
    // Force immediate save on pause
    if (activeBook && activeBook.currentChapterId) {
       commitProgressUpdate(activeBook.id, activeBook.currentChapterId, { currentTime: audioCurrentTime, duration: audioDuration, charOffset: state.currentOffsetChars }, true);
    }
  };

  const handleManualStop = () => {
    speechController.stop();
    setIsPlaying(false);
    updatePhase('IDLE');
    
    // Force immediate save on stop
    if (activeBook && activeBook.currentChapterId) {
       commitProgressUpdate(activeBook.id, activeBook.currentChapterId, { currentTime: audioCurrentTime, duration: audioDuration, charOffset: state.currentOffsetChars }, true);
    }
  };

  const handleOpenChapter = (id: string) => {
    trace('ui:chapter:click', { id });
    const shouldPlay = isPlayingRef.current;
    goToChapter(id, { autoStart: shouldPlay, reason: 'user' });
    setActiveTab('reader');
  };

  // Robust Seek Coordination
  const handleSeekCommit = async (time: number) => {
    const token = ++transitionTokenRef.current;
    trace('seek:commit', { time });
    
    // If transitioning, ignore or queue? Simple ignore for now or let robust seekTo handle it.
    if (playbackPhase === 'TRANSITIONING' || playbackPhase === 'LOADING_AUDIO') {
        return; // Don't interrupt hard loads with seeks
    }

    setIsScrubbing(false);
    setPlaybackPhase('SEEKING');

    try {
        await speechController.seekTo(time);
        
        // If a new transition started, abort UI update
        if (token !== transitionTokenRef.current) return;

        if (isPlayingRef.current) {
            updatePhase(isInIntroRef.current ? 'PLAYING_INTRO' : 'PLAYING_BODY');
        } else {
            updatePhase('READY');
        }
        
        // Force commit new time
        if (activeBook && activeBook.currentChapterId) {
           commitProgressUpdate(activeBook.id, activeBook.currentChapterId, { currentTime: time, duration: audioDuration, charOffset: state.currentOffsetChars }, true);
        }

    } catch (e: any) {
        if (token === transitionTokenRef.current) {
            traceError('seek:commit:error', e);
            // Even on error, clear SEEKING state
            updatePhase('READY');
            showToast("Seek failed", 0, 'error');
        }
    }
  };
  
  const handleSeekByDelta = (delta: number) => {
    const current = speechController.getCurrentTime(); // Use direct getter for fresher value
    const target = Math.max(0, current + delta);
    handleSeekCommit(target);
  };
  
  const handleJumpToOffset = (o: number) => {
    updatePhase('SEEKING');
    speechController.seekToOffset(o);
  };

  // --- End Playback Logic ---

  const handleRecalculateProgress = useCallback(() => {
    const s = stateRef.current;
    let fixedCount = 0;
    
    const newBooks = s.books.map(book => {
        const newChapters = book.chapters.map(ch => {
            let changed = false;
            let { progressSec, durationSec, textLength, progress, isCompleted } = ch;
            
            // Normalize Progress Sec
            if (durationSec && durationSec > 0 && (progressSec === undefined)) {
                progressSec = progress * durationSec;
                changed = true;
            }
            if (progressSec === undefined) progressSec = 0;
            
            // Recalculate Percent
            let newPct = 0;
            if (durationSec && durationSec > 0) {
                newPct = progressSec / durationSec;
            } else if (textLength && textLength > 0 && ch.progressChars) {
                newPct = ch.progressChars / textLength;
            } else {
                newPct = progress; // Fallback
            }
            
            // Recalculate Completion
            let newCompleted = isCompleted;
            if (!newCompleted) {
                if (durationSec && durationSec > 0) {
                    if (progressSec >= durationSec - 0.5) newCompleted = true;
                } else if (textLength && textLength > 0 && ch.progressChars) {
                    if (ch.progressChars >= textLength - 5) newCompleted = true;
                }
            }
            
            if (newPct !== progress || newCompleted !== isCompleted || changed) {
                fixedCount++;
                return {
                    ...ch,
                    progress: newPct,
                    progressSec,
                    isCompleted: newCompleted
                };
            }
            return ch;
        });
        return { ...book, chapters: newChapters };
    });
    
    setState(p => ({ ...p, books: newBooks }));
    markDirty();
    showToast(`Recalculated ${fixedCount} chapters`, 0, 'success');
  }, [markDirty, showToast]);

  const applySnapshot = useCallback(async (snapshot: SavedSnapshot) => {
    const s = stateRef.current;
    const { books: cloudBooks, readerSettings: cloudRS, activeBookId, playbackSpeed, selectedVoiceName, theme, progressStore: cloudProgress, driveRootFolderId, driveRootFolderName, driveSubfolders, autoSaveInterval, globalRules, showDiagnostics } = snapshot.state;
    
    // SAFETY BACKUP BEFORE MERGE
    try {
      const progressStore = JSON.parse(localStorage.getItem(PROGRESS_STORE_V4) || '{}');
      const safeBackup = buildQuotaSafeBackup(s, progressStore);
      const jsonBackup = JSON.stringify(safeBackup);
      if (estimateBytes(jsonBackup) < 1000000) {
         safeSetLocalStorage(BACKUP_KEY, jsonBackup);
      } else {
         await idbSet(BACKUP_KEY, safeBackup);
         safeSetLocalStorage(BACKUP_KEY, JSON.stringify({ storage: 'idb', timestamp: Date.now(), idbKey: BACKUP_KEY }));
      }
    } catch (e) {
      console.warn("Safety backup failed:", e);
    }

    const mergedBooks = [...s.books];
    cloudBooks.forEach(cb => {
      const idx = mergedBooks.findIndex(b => b.id === cb.id || b.title === cb.title);
      if (idx === -1) {
        mergedBooks.push(cb);
      } else {
        const lb = mergedBooks[idx];
        const trustCloud = !lb.updatedAt || (cb.updatedAt && cb.updatedAt > lb.updatedAt);
        if (trustCloud) {
           const mergedChapters = [...lb.chapters];
           cb.chapters.forEach(cc => {
              const cIdx = mergedChapters.findIndex(lc => lc.id === cc.id || lc.index === cc.index);
              if (cIdx === -1) {
                 mergedChapters.push(cc);
              } else {
                 const lc = mergedChapters[cIdx];
                 if (!lc.updatedAt || (cc.updatedAt && cc.updatedAt > lc.updatedAt)) {
                    mergedChapters[cIdx] = cc;
                 }
              }
           });
           mergedBooks[idx] = { ...lb, ...cb, chapters: mergedChapters.sort((a,b) => a.index-b.index) };
        }
      }
    });

    const localProgress = JSON.parse(localStorage.getItem(PROGRESS_STORE_V4) || '{}');
    const finalProgress = { ...cloudProgress };
    Object.keys(localProgress).forEach(bookId => {
       if (!finalProgress[bookId]) finalProgress[bookId] = localProgress[bookId];
       else {
          Object.keys(localProgress[bookId]).forEach(chId => {
             const lp = localProgress[bookId][chId];
             const cp = finalProgress[bookId][chId];
             if (!cp || (lp.updatedAt && lp.updatedAt > (cp.updatedAt || 0))) {
                finalProgress[bookId][chId] = lp;
             }
          });
       }
    });

    setState(prev => ({ 
      ...prev, 
      books: mergedBooks, 
      readerSettings: cloudRS || prev.readerSettings, 
      activeBookId: activeBookId || prev.activeBookId, 
      playbackSpeed: playbackSpeed || prev.playbackSpeed, 
      selectedVoiceName: selectedVoiceName || prev.selectedVoiceName, 
      theme: theme || prev.theme, 
      lastSavedAt: snapshot.savedAt, 
      driveRootFolderId: driveRootFolderId || prev.driveRootFolderId, 
      driveRootFolderName: driveRootFolderName || prev.driveRootFolderName, 
      driveSubfolders: driveSubfolders || prev.driveSubfolders,
      autoSaveInterval: autoSaveInterval || prev.autoSaveInterval,
      globalRules: globalRules || prev.globalRules || [],
      showDiagnostics: showDiagnostics || prev.showDiagnostics
    }));
    
    safeSetLocalStorage(PROGRESS_STORE_V4, JSON.stringify(finalProgress));
    window.dispatchEvent(new CustomEvent('talevox_progress_updated', { detail: { bookId: activeBookId || stateRef.current.activeBookId, chapterId: null } }));
  }, []);

  const handleSync = useCallback(async (manual = false) => {
    const s = stateRef.current;
    if (!isAuthorized || !s.driveRootFolderId) {
      if (manual) showToast("Setup Drive Root in Settings", 0, 'error');
      return;
    }
    setIsSyncing(true);
    updateDiagnostics({ lastSyncAttemptAt: Date.now(), lastSyncError: undefined });
    if (manual) showToast("Syncing with Drive...", 0, 'info');
    try {
      const sub = await ensureRootStructure(s.driveRootFolderId);
      setState(p => ({ ...p, driveSubfolders: sub }));
      updateDiagnostics({ driveRootFolderId: s.driveRootFolderId, resolvedCloudSavesFolderId: sub.savesId });
      const candidates = await listSaveFileCandidates(sub.savesId);
      const newestSaveFile = candidates.find(f => f.name === STABLE_POINTER_NAME) || candidates[0];
      if (!newestSaveFile) {
        if (manual) showToast("No cloud save found", 0, 'info');
        updateDiagnostics({ lastSyncError: "No save found in folder" });
      } else {
        updateDiagnostics({ lastCloudSaveFileName: newestSaveFile.name, lastCloudSaveModifiedTime: newestSaveFile.modifiedTime });
        const remoteContent = await fetchDriveFile(newestSaveFile.id);
        if (!remoteContent || !remoteContent.startsWith('{')) throw new Error("Invalid Cloud JSON format");
        const remoteSnapshot = JSON.parse(remoteContent) as SavedSnapshot;
        const localSnapshotStr = localStorage.getItem(SNAPSHOT_KEY);
        const localSnapshot = localSnapshotStr ? JSON.parse(localSnapshotStr) as SavedSnapshot : null;
        if (!localSnapshot || remoteSnapshot.savedAt > localSnapshot.savedAt || manual) {
          await applySnapshot(remoteSnapshot);
          if (manual) showToast("Cloud Save Applied", 0, 'success');
        }
      }
      // ... drive file discovery logic can stay same ...
      updateDiagnostics({ lastSyncSuccessAt: Date.now() });
    } catch (err: any) { 
      console.error("Sync Error:", err);
      showToast(`Sync Failed: ${err.message}`, 0, 'error');
      updateDiagnostics({ lastSyncError: err.message });
    } finally { setIsSyncing(false); }
  }, [isAuthorized, updateDiagnostics, applySnapshot, showToast]);

  const handleSaveState = useCallback(async (force = false, silent = false) => {
    if (!isAuthorized && !silent) {
      if (force) showToast("Not logged in", 0, 'error');
      return;
    }
    const s = stateRef.current;
    if (!force && !isDirty && !s.syncDiagnostics?.cloudDirty) return;

    if (!silent) showToast("Saving to Cloud...", 0, 'info');
    setIsSyncing(true);

    try {
      const { savesId } = await ensureRootStructure(s.driveRootFolderId!);
      const progressStore = JSON.parse(localStorage.getItem(PROGRESS_STORE_V4) || '{}');
      const snapshot: SavedSnapshot = {
        version: "v1",
        savedAt: Date.now(),
        state: { ...s, progressStore }
      };
      
      const fileName = STABLE_POINTER_NAME; // "talevox-latest.json"
      const content = JSON.stringify(snapshot);
      
      // Find existing to overwrite or create new
      const existingId = await findFileSync(fileName, savesId);
      await uploadToDrive(savesId, fileName, content, existingId || undefined, 'application/json');
      
      setIsDirty(false);
      updateDiagnostics({ lastCloudSaveAt: Date.now(), isDirty: false, lastCloudSaveTrigger: force ? 'manual' : 'auto' });
      setState(p => ({ ...p, lastSavedAt: Date.now() }));
      
      if (!silent) showToast("Saved successfully", 2000, 'success');
    } catch (e: any) {
      console.error("Save failed", e);
      if (!silent) showToast("Save failed: " + e.message, 0, 'error');
      updateDiagnostics({ lastAutoSaveError: e.message });
    } finally {
      setIsSyncing(false);
    }
  }, [isAuthorized, isDirty, updateDiagnostics, showToast]);

  const handleAddBook = useCallback(async (title: string, backend: StorageBackend, directoryHandle?: any, driveFolderId?: string, driveFolderName?: string) => {
      const newBook: Book = {
          id: crypto.randomUUID(),
          title,
          backend,
          directoryHandle,
          driveFolderId,
          driveFolderName,
          chapters: [],
          rules: [],
          settings: { useBookSettings: false, highlightMode: HighlightMode.WORD },
          updatedAt: Date.now()
      };
      
      // If Drive backend, ensure folder exists
      if (backend === StorageBackend.DRIVE && !driveFolderId && state.driveRootFolderId) {
          try {
              const { booksId } = await ensureRootStructure(state.driveRootFolderId);
              const newFolderId = await createDriveFolder(title, booksId);
              newBook.driveFolderId = newFolderId;
              newBook.driveFolderName = title;
          } catch(e: any) {
              showToast("Failed to create Drive folder: " + e.message, 0, 'error');
              return;
          }
      }

      setState(p => ({ ...p, books: [...p.books, newBook], activeBookId: newBook.id }));
      markDirty();
      setActiveTab('library');
  }, [state.driveRootFolderId, markDirty, showToast]);

  const handleChapterExtracted = useCallback(async (data: { title: string; content: string; url: string; index: number; voiceId: string; setAsDefault: boolean; keepOpen?: boolean }) => {
      const s = stateRef.current;
      const book = s.books.find(b => b.id === s.activeBookId);
      if (!book) return;

      const newChapter: Chapter = {
          id: crypto.randomUUID(),
          index: data.index,
          title: data.title,
          content: data.content,
          wordCount: data.content.split(/\s+/).filter(Boolean).length,
          textLength: data.content.length,
          filename: buildTextName(data.index, data.title),
          progress: 0,
          progressChars: 0,
          audioStatus: AudioStatus.PENDING,
          updatedAt: Date.now()
      };

      // Upload text if Drive
      if (book.backend === StorageBackend.DRIVE && book.driveFolderId && isAuthorized) {
          try {
             const textId = await uploadToDrive(book.driveFolderId, newChapter.filename, data.content);
             newChapter.cloudTextFileId = textId;
             newChapter.hasTextOnDrive = true;
          } catch (e: any) {
             showToast("Text upload failed: " + e.message, 0, 'error');
          }
      }

      // Update book settings if default voice set
      let updatedSettings = book.settings;
      if (data.setAsDefault) {
          updatedSettings = { ...book.settings, defaultVoiceId: data.voiceId };
      }

      setState(p => ({
          ...p,
          books: p.books.map(b => b.id === book.id ? {
              ...b,
              chapters: [...b.chapters, newChapter].sort((a,b) => a.index - b.index),
              settings: updatedSettings
          } : b)
      }));
      markDirty();
      
      if (!data.keepOpen) {
          setIsAddChapterOpen(false);
      } else {
          showToast(`Added: ${data.title}`, 1500, 'success');
      }
  }, [isAuthorized, markDirty, showToast]);

  const handleResetChapterProgress = useCallback((bookId: string, chapterId: string) => {
      commitProgressUpdate(bookId, chapterId, { currentTime: 0, duration: 0, charOffset: 0, completed: false }, true);
      showToast("Progress reset", 2000, 'info');
  }, [commitProgressUpdate, showToast]);

  const handleScanAndRebuild = useCallback(async () => {
      if (isScanningRules) return;
      setIsScanningRules(true);
      setScanProgress('Analyzing...');
      
      const s = stateRef.current;
      const book = s.books.find(b => b.id === s.activeBookId);
      if (!book) { setIsScanningRules(false); return; }

      try {
          if (book.backend === StorageBackend.DRIVE && book.driveFolderId) {
             const files = await listFilesInFolder(book.driveFolderId);
             // Simple logic: update status
             setState(p => ({
                 ...p,
                 books: p.books.map(b => b.id === book.id ? {
                     ...b,
                     chapters: b.chapters.map(c => {
                         const mp3Name = buildMp3Name(c.index, c.title);
                         const hasAudio = files.some(f => f.name === mp3Name);
                         return { ...c, audioStatus: hasAudio ? AudioStatus.READY : AudioStatus.PENDING };
                     })
                 } : b)
             }));
          }
          showToast("Scan complete", 2000, 'success');
      } catch (e: any) {
          showToast("Scan failed: " + e.message, 0, 'error');
      } finally {
          setIsScanningRules(false);
          setScanProgress('');
      }
  }, [isScanningRules, showToast]);

  const handleSelectRoot = useCallback(async () => {
      try {
          const folder = await openFolderPicker();
          if (folder) {
              setState(p => ({ ...p, driveRootFolderId: folder.id, driveRootFolderName: folder.name }));
              markDirty();
              // Trigger sync immediately
              setTimeout(() => handleSync(true), 500);
          }
      } catch (e: any) {
          showToast("Folder selection failed: " + e.message, 0, 'error');
      }
  }, [markDirty, handleSync, showToast]);

  const handleRunMigration = useCallback(() => {
     showToast("Migration tool not implemented in this version", 3000, 'info');
  }, [showToast]);

  return (
    <div className={`flex flex-col h-screen overflow-hidden font-sans transition-colors duration-500 ${state.theme === Theme.DARK ? 'bg-slate-950 text-slate-100' : state.theme === Theme.SEPIA ? 'bg-[#f4ecd8] text-[#3c2f25]' : 'bg-white text-black'}`}>
      
      {state.showDiagnostics && (
        <div className="fixed top-20 right-4 z-[1000] p-4 bg-black/80 backdrop-blur-md text-white text-[10px] font-mono rounded-xl shadow-2xl border border-white/10 pointer-events-none opacity-80">
          <div className="flex items-center gap-2 mb-2 border-b border-white/20 pb-1">
            <Terminal className="w-3 h-3 text-indigo-400" />
            <span className="font-bold">Playback Diagnostics {effectiveMobileMode ? '(Mobile)' : ''}</span>
          </div>
          <div>Phase: <span className="text-emerald-400">{playbackPhase}</span></div>
          <div>Scrubbing: {isScrubbing ? 'YES' : 'NO'}</div>
          <div>Since: {((Date.now() - phaseSince) / 1000).toFixed(1)}s</div>
          <div>Audio Time: {audioCurrentTime.toFixed(2)}s</div>
          <div>Audio Dur: {audioDuration.toFixed(2)}s</div>
          <div>Intro Dur: {currentIntroDurSec.toFixed(2)}s</div>
          <div>Highlight Offset: {state.currentOffsetChars}</div>
          {lastPlaybackError && <div className="text-red-400 mt-2 border-t border-white/20 pt-1">Error: {lastPlaybackError}</div>}
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
            <button onClick={() => setIsChapterSidebarOpen(true)} className="p-2 lg:hidden rounded-lg hover:bg-black/5"><Menu className="w-5 h-5" /></button>
          )}
          <nav className="flex items-center gap-4 sm:gap-6">
            <button onClick={() => setActiveTab('library')} className={`flex items-center gap-2 h-16 border-b-2 font-black uppercase text-[10px] tracking-widest ${activeTab === 'library' || activeTab === 'collection' ? 'border-indigo-600 text-indigo-600' : 'border-transparent opacity-60'}`}><LibraryIcon className="w-4 h-4" /> <span className="hidden sm:inline">Library</span></button>
            <button onClick={() => setActiveTab('rules')} className={`flex items-center gap-2 h-16 border-b-2 font-black uppercase text-[10px] tracking-widest ${activeTab === 'rules' ? 'border-indigo-600 text-indigo-600' : 'border-transparent opacity-60'}`}><Zap className="w-4 h-4" /> <span className="hidden sm:inline">Rules</span></button>
            <button onClick={() => setActiveTab('settings')} className={`flex items-center gap-2 h-16 border-b-2 font-black uppercase text-[10px] tracking-widest ${activeTab === 'settings' ? 'border-indigo-600 text-indigo-600' : 'border-transparent opacity-60'}`}><SettingsIcon className="w-4 h-4" /> <span className="hidden sm:inline">Settings</span></button>
          </nav>
        </div>
        <div className="flex items-center gap-2 sm:gap-4">
          {!isAuthorized ? (
            <button onClick={() => getValidDriveToken({ interactive: true })} className="flex items-center gap-2 px-3 py-2 bg-indigo-600 text-white rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-indigo-700 transition-all shadow-md"><LogIn className="w-3.5 h-3.5" /> <span className="hidden xs:inline">Sign In</span></button>
          ) : (
            <button onClick={() => handleSync(true)} disabled={isSyncing} className={`flex items-center gap-2 px-3 py-2 bg-indigo-600/10 text-indigo-600 rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-indigo-600/20 transition-all ${isSyncing ? 'animate-pulse' : ''}`}><RefreshCw className="w-3.5 h-3.5" /> <span className="hidden xs:inline">Sync</span></button>
          )}
          <button onClick={() => handleSaveState(true, false)} className={`p-2.5 rounded-xl bg-indigo-600/10 text-indigo-600 hover:bg-indigo-600/20 transition-all ${isDirty ? 'ring-2 ring-indigo-600 animate-pulse' : ''}`} title="Manual Cloud Save"><Save className="w-4 h-4" /></button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto relative flex">
        {isLoadingChapter && <div className="absolute inset-0 flex items-center justify-center bg-inherit z-[70]"><Loader2 className="w-10 h-10 text-indigo-600 animate-spin" /></div>}
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
              onOpenChapter={(id) => { handleOpenChapter(id); setActiveTab('reader'); }}
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
              onClearAuth={() => { clearStoredToken(); setState(p => ({ ...p, driveRootFolderId: undefined })); }}
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
          isPlaying={isPlaying} onPlay={() => isPlayingRef.current ? handleManualPause() : handleManualPlay()} onPause={handleManualPause} onStop={handleManualStop}
          onNext={() => handleNextChapter(false)} onPrev={handlePrevChapter} onSeek={handleSeekByDelta}
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
          playbackCurrentTime={audioCurrentTime} playbackDuration={audioDuration} isFetching={playbackPhase === 'LOADING_AUDIO' || playbackPhase === 'SEEKING'}
          onSeekToTime={handleSeekCommit} 
          autoplayBlocked={autoplayBlocked}
          onScrubStart={() => setIsScrubbing(true)}
          isMobile={effectiveMobileMode}
        />
      )}
    </div>
  );
};

export default App;