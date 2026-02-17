import React, { useState, useEffect, useCallback, useRef, useMemo, Suspense } from 'react';
// Architecture notes: see docs/ARCHITECTURE.md for module map and folder split.
import { Book, Chapter, AppState, Theme, HighlightMode, StorageBackend, RuleType, AudioStatus, CLOUD_VOICES, SyncDiagnostics, Rule, PlaybackMetadata, UiMode, ReaderSettings, JobRecord, CueMap, AudioChunkMetadata, ParagraphMap, BookAttachment, BackupOptions, BackupProgress, BackupTarget, BookSettings } from './types';
import Library from './src/features/library/Library';
import Reader from './src/features/reader/Reader';
import Player from './src/features/reader/Player';
import ChapterSidebar from './src/features/library/ChapterSidebar';
import { speechController, PROGRESS_STORE_KEY } from './services/speechService';
import { type PlaybackAdapter } from './services/playbackAdapter';
import { fetchDriveFile, fetchDriveBinary, uploadToDrive, buildMp3Name, listFilesInFolder, findFileSync, buildTextName, ensureRootStructure, ensureBookFolder, moveFile, moveFileToTrash, openFolderPicker, listFilesSortedByModified, resolveFolderIdByName, listSaveFileCandidates, createDriveFolder, listFoldersInFolder, findTaleVoxRoots, getDriveFileParentIds } from './services/driveService';
import { ensureChapterDriveStorageFolder, findChapterDriveStorageFolder, listVolumeFolders } from "./services/driveChapterFolders";
import type { InventoryManifest } from "./services/bookManifests";
import { initDriveAuth, getValidDriveToken, clearStoredToken, isTokenValid, ensureValidToken } from './services/driveAuth';
import { authManager, AuthState } from './services/authManager';
import { saveChapterToFile } from './services/fileService';
import { getImportAdapter } from "./services/importAdapter";
import { synthesizeChunk } from './services/cloudTtsService';
import { extractChapterWithAI } from './services/geminiService';
import { idbSet } from './services/storageService';
import { listBooks as libraryListBooks, upsertBook as libraryUpsertBook, deleteBook as libraryDeleteBook, listChaptersPage as libraryListChaptersPage, upsertChapterMeta as libraryUpsertChapterMeta, deleteChapter as libraryDeleteChapter, saveChapterText as librarySaveChapterText, loadChapterText as libraryLoadChapterText, getChaptersByIds as libraryGetChaptersByIds, bulkUpsertChapters as libraryBulkUpsertChapters, listBookAttachments as libraryListBookAttachments, upsertBookAttachment as libraryUpsertBookAttachment, bulkUpsertBookAttachments as libraryBulkUpsertBookAttachments, listChapterTombstones as libraryListChapterTombstones } from './services/libraryStore';
import { bootstrapCore } from './src/app/bootstrap';
import { X, Loader2, Terminal, FolderSync, CheckCircle2, Plus } from 'lucide-react';
import { useNotify } from "./hooks/useNotify";
import { trace, traceError } from './utils/trace';
import { computeMobileMode } from './utils/platform';
import { getLogger, setLogEnabled, createCorrelationId } from './utils/logger';
import { MissingTextError, toUserMessage } from "./utils/errors";
import { yieldToUi } from './utils/async';
import { computePercent } from "./utils/progress";
import { buildReaderModel, buildSpeakTextFromContent } from "./utils/markdownBlockParser";
import { parseTtsVoiceId } from "./utils/ttsVoice";
import { JobRunner } from './src/plugins/jobRunner';
import { appConfig } from "./src/config/appConfig";
import { cancelJob as cancelJobService, retryJob as retryJobService, deleteJob as deleteJobService, clearJobs as clearJobsService, enqueueGenerateAudio, getWorkInfo, forceStartJob as forceStartJobService, getJobById, getJobRunnerCapability } from './services/jobRunnerService';
import { getNativeChapterTextCount, ensureNativeBook, ensureNativeChapter, ensureNativeChapterText, hasNativeBook } from "./services/nativeLibraryBridge";
import { type DriveUploadQueuedItem } from './services/driveUploadQueueService';
import { enqueueUploads } from "./services/uploadManager";
import { getChapterAudioPath } from './services/chapterAudioStore';
import { Capacitor } from "@capacitor/core";
import { App as CapacitorApp } from "@capacitor/app";
import { Filesystem, Directory, Encoding } from "@capacitor/filesystem";
import { createDriveFolderAdapter } from "./services/driveFolderAdapter";
import { cueMapFromChunkMap, generateFallbackCueMap, findCueIndex } from './services/cueMaps';
import { getCueMap, saveCueMap, deleteCueMap, getParagraphMap, saveParagraphMap, deleteParagraphMap, buildParagraphMap } from './services/highlightMaps';
import { saveAttachmentBytes, saveAttachmentBlob, resolveAttachmentUri, attachmentExists, guessMimeType } from "./services/attachmentsService";
import { collectDiagnostics, saveDiagnosticsToFile, type DiagnosticsReport } from "./services/diagnosticsService";
import { useHighlightSync } from "./hooks/useHighlightSync";
import { useReaderProgress, type ChapterProgress, type ProgressMap } from "./hooks/useReaderProgress";
import { normalizeChapterTitle } from "./utils/titleCase";
import { safeSetLocalStorage } from './utils/safeStorage';
import { formatBytes } from './utils/formatBytes';
import {
  normalizeChapterProgress,
  orderChaptersForDisplay,
  normalizeBookChapters,
  getEffectivePrefixLen,
  deriveIntroMsFromChunkMap,
  normalizeChunkMapForChapter,
  computeIntroMs,
} from './utils/chapterBookUtils';
import {
  readProgressStore,
  writeProgressStore,
  normalizeProgressStore,
  type ProgressStoreEntry,
  type ProgressStorePayload,
} from './services/progressStore';
import { DEFAULT_BOOK_SETTINGS, normalizeBookSettings } from './src/features/library/bookSettings';
import { handleAndroidBackPriority } from './src/app/androidBack';
import {
  STATE_FILENAME,
  LOG_JOBS_KEY,
  STABLE_POINTER_NAME,
  SNAPSHOT_KEY,
  BACKUP_KEY,
  BACKUP_SETTINGS_KEY,
  UI_MODE_KEY,
  PREFS_KEY,
  NAV_CONTEXT_KEY,
  LAUNCH_SYNC_KEY,
  LAUNCH_SYNC_MIN_MS,
} from './src/app/constants';
import { useUploadQueue } from "./src/app/state/useUploadQueue";
import { useJobs } from "./src/app/state/useJobs";
import { useChapterPaging } from "./src/app/state/useChapterPaging";
import { useBackup } from "./src/app/state/useBackup";
import { useDiagnostics } from "./src/app/state/useDiagnostics";
import { useNotifications } from "./src/app/state/useNotifications";
import { useAppBootstrap } from "./src/app/state/useAppBootstrap";
import { RouteContext } from "./src/app/types";
import { usePlayback } from "./src/app/state/usePlayback";
import AppShell from "./src/app/AppShell";
import {
  applyFullSnapshot,
  buildFullSnapshot,
  readLocalSnapshotMeta,
  restoreFromDriveIfAvailable,
  saveToDrive,
} from "./services/saveRestoreService";
import { generateAndPersistChapterAudio } from "./services/chapterAudioService";
import {
  computeNextSortOrder,
  deriveDisplayIndices,
  fixChapterOrdering,
  getChapterSortOrder,
  normalizeChapterOrder,
} from "./services/chapterOrderingService";
import {
  createFullBackupZip,
  DEFAULT_BACKUP_OPTIONS,
  DEFAULT_BACKUP_SETTINGS,
  listDriveBackupCandidates,
  restoreFromBackupZip,
  restoreFromDriveSave,
  saveBackup,
  type DriveBackupCandidate,
} from "./services/backupService";

type DownloadedChapterInfo = {
  id: string;
  title: string;
  index: number;
  localPath: string;
  hasDriveAudio: boolean;
};

const jobLog = getLogger("Jobs");
const LazyExtractor = React.lazy(() => import('./src/features/library/Extractor'));
const LazyChapterFolderView = React.lazy(() => import('./src/features/library/ChapterFolderView'));
const LazyRuleManager = React.lazy(() => import('./src/features/rules/RuleManager'));
const LazySettings = React.lazy(() => import('./src/features/settings/Settings'));

const RESERVED_DRIVE_BOOK_FOLDER_NAMES = new Set([
  "meta",
  "attachments",
  "trash",
  "text",
  "audio",
]);

const pushVolumeName = (
  target: string[],
  seen: Set<string>,
  value: unknown,
  skipReserved = false
) => {
  if (typeof value !== "string") return;
  const trimmed = value.trim();
  if (!trimmed) return;
  const key = trimmed.toLowerCase();
  if (skipReserved && RESERVED_DRIVE_BOOK_FOLDER_NAMES.has(key)) return;
  if (seen.has(key)) return;
  seen.add(key);
  target.push(trimmed);
};

const buildVolumeOrderFromDriveSync = (
  existingOrder: unknown,
  driveFolderNames: string[],
  chapters: Array<Pick<Chapter, "volumeName">>
): string[] => {
  const next: string[] = [];
  const seen = new Set<string>();
  if (Array.isArray(existingOrder)) {
    existingOrder.forEach((name) => pushVolumeName(next, seen, name));
  }
  driveFolderNames.forEach((name) => pushVolumeName(next, seen, name, true));
  chapters.forEach((chapter) => pushVolumeName(next, seen, (chapter as any).volumeName));
  return next;
};


const App: React.FC = () => {
  const [isDirty, setIsDirty] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isOnline, setIsOnline] = useState(() => {
    if (typeof navigator === "undefined") return true;
    return navigator.onLine;
  });
  const syncRunRef = useRef(0);
  const nativeSyncRunRef = useRef(0);
  const performFullDriveSyncRef = useRef<(manual?: boolean) => Promise<void>>(async () => {});
  const [isScanningRules, setIsScanningRules] = useState(false);
  const [scanProgress, setScanProgress] = useState('');
  const [isLinkModalOpen, setIsLinkModalOpen] = useState(false);

  const chapterBackHandlerRef = useRef<(() => boolean) | null>(null);
  const registerChapterBackHandler = useCallback((handler: (() => boolean) | null) => {
    chapterBackHandlerRef.current = handler;
  }, []);
  const pushNotice = useNotify();
  const pushNoticeSafe = useCallback(
    (opts: { message: string; type?: "info" | "success" | "error" | "reconnect"; ms?: number }) => {
      pushNotice({ message: opts.message, type: opts.type ?? "info", ms: opts.ms });
    },
    [pushNotice]
  );
  const {
    diagnosticsReport,
    refreshDiagnostics,
    handleSaveDiagnostics,
    jobRunnerAvailable,
  } = useDiagnostics(pushNoticeSafe);

  const chapterSessionRef = useRef(0);
  const chapterTextInFlightRef = useRef<Map<string, Promise<string | null>>>(new Map());
  const chapterTextCacheRef = useRef<Map<string, string>>(new Map());
  const isInIntroRef = useRef(false);
  

  useEffect(() => {
    if (Capacitor.getPlatform() !== "android") return;
    let cancelled = false;
    let handle: { remove: () => Promise<void> | void } | null = null;

    const register = async () => {
      try {
        handle = await CapacitorApp.addListener("backButton", ({ canGoBack }) => {
          handleAndroidBackPriority({
            canGoBack: !!canGoBack,
            consumeOverlayBack: () => {
              try {
                return chapterBackHandlerRef.current?.() ?? false;
              } catch (err) {
                console.warn("[BackButton] overlay handler failed", err);
                return false;
              }
            },
            goBack: () => {
              window.history.back();
            },
            exitApp: () => {
              void CapacitorApp.exitApp();
            },
          });
        });
      } catch (err) {
        if (!cancelled) {
          console.warn("[BackButton] failed to register listener", err);
        }
      }
    };

    void register();
    return () => {
      cancelled = true;
      chapterBackHandlerRef.current = null;
      if (handle) {
        void handle.remove();
      }
    };
  }, []);

  const [state, setState] = useState<AppState>(() => {
    const prefsRaw = localStorage.getItem(PREFS_KEY);
    const parsed = prefsRaw ? JSON.parse(prefsRaw) : {};
    const backupRaw = localStorage.getItem(BACKUP_SETTINGS_KEY);
    const parsedBackup = backupRaw ? JSON.parse(backupRaw) : {};
    const backupSettings = {
      ...DEFAULT_BACKUP_SETTINGS,
      ...(parsed.backupSettings || {}),
      ...(parsedBackup || {}),
    };
    const savedDiag = localStorage.getItem('talevox_sync_diag');
    const savedUiMode = localStorage.getItem(UI_MODE_KEY) as UiMode | null;
    const forcedUiMode: UiMode | null = __ANDROID_ONLY__ ? "mobile" : savedUiMode;

    const defaultReaderSettings: ReaderSettings = {
      fontFamily: "'Source Serif 4', serif",
      fontSizePx: 20,
      lineHeight: 1.55,
      paragraphSpacing: 1,
      reflowLineBreaks: true,
      highlightColor: '#4f46e5',
      followHighlight: true,
      highlightEnabled: true,
      highlightUpdateRateMs: 250,
      highlightDebugOverlay: false,
      speakChapterIntro: true,
      uiMode: forcedUiMode || 'auto',
    };

    const mergedReaderSettings: ReaderSettings = {
      ...defaultReaderSettings,
      ...(parsed.readerSettings || {}),
      uiMode: forcedUiMode || parsed.readerSettings?.uiMode || defaultReaderSettings.uiMode,
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
      showDiagnostics: parsed.showDiagnostics || false,
      backupSettings,
      backupInProgress: false,
      lastBackupAt: parsed.lastBackupAt,
      lastBackupLocation: parsed.lastBackupLocation,
      lastBackupError: parsed.lastBackupError,
    };
  });

  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    const pref = __ANDROID_ONLY__ ? "mobile" : state.readerSettings.uiMode || "auto";
    if (__ANDROID_ONLY__ && state.readerSettings.uiMode !== "mobile") {
      setState((s) => ({
        ...s,
        readerSettings: { ...s.readerSettings, uiMode: "mobile" },
      }));
    }
    localStorage.setItem(UI_MODE_KEY, pref);
  }, [state.readerSettings.uiMode]);

  // Sync body theme to avoid black text on dark mode
  useEffect(() => {
    document.body.classList.remove('dark-theme', 'sepia-theme');
    if (state.theme === Theme.DARK) document.body.classList.add('dark-theme');
    else if (state.theme === Theme.SEPIA) document.body.classList.add('sepia-theme');
  }, [state.theme]);

  const [effectiveMobileMode, setEffectiveMobileMode] = useState(
    __ANDROID_ONLY__ ? true : computeMobileMode(state.readerSettings.uiMode)
  );
  const [playbackAdapter, setPlaybackAdapter] = useState<PlaybackAdapter | null>(() =>
    speechController.getPlaybackAdapter()
  );

  useEffect(() => {
    const recompute = () => {
      const isUiMobile = __ANDROID_ONLY__ ? true : computeMobileMode(state.readerSettings.uiMode);
      const isNative = Capacitor.isNativePlatform?.() ?? false;
      setEffectiveMobileMode(isUiMobile);
      speechController.setMobileMode(isUiMobile || isNative);
      setPlaybackAdapter(speechController.getPlaybackAdapter());
    };
    recompute();
    if (!__ANDROID_ONLY__ && state.readerSettings.uiMode === 'auto') {
      window.addEventListener('resize', recompute);
      return () => window.removeEventListener('resize', recompute);
    }
  }, [state.readerSettings.uiMode]);

  const [activeTab, setActiveTab] = useState<'library' | 'collection' | 'reader' | 'rules' | 'settings'>('library');
  const navContextRef = useRef<RouteContext | null>(null);
  const navPersistTimerRef = useRef<number | null>(null);
  const lastNonReaderTabRef = useRef<'library' | 'collection' | 'rules' | 'settings'>('library');
  const [readerInitialScrollTop, setReaderInitialScrollTop] = useState<number | null>(null);
  const [isAddChapterOpen, setIsAddChapterOpen] = useState(false);
  const [addChapterVolumeNames, setAddChapterVolumeNames] = useState<string[]>([]);
  const [isChapterSidebarOpen, setIsChapterSidebarOpen] = useState(false);
  const {
    chapterPagingByBook,
    setChapterPagingByBook,
    loadMoreChapters,
    preserveChapterContent,
  } = useChapterPaging(setState);
  const [logJobs, setLogJobs] = useState<boolean>(() => localStorage.getItem(LOG_JOBS_KEY) === 'true');
  useEffect(() => { localStorage.setItem(LOG_JOBS_KEY, logJobs ? 'true' : 'false'); }, [logJobs]);
  const {
    notificationStatus,
    refreshNotificationStatus,
    handleRequestNotifications,
    handleOpenNotificationSettings,
    handleSendTestNotification,
  } = useNotifications(jobRunnerAvailable, logJobs, pushNoticeSafe);
  useEffect(() => { setLogEnabled("Jobs", logJobs); }, [logJobs]);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(NAV_CONTEXT_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as RouteContext;
        navContextRef.current = parsed;
        if (parsed?.lastNonReaderViewType) {
          lastNonReaderTabRef.current = parsed.lastNonReaderViewType;
        } else if (parsed?.lastViewType && parsed.lastViewType !== "reader") {
          lastNonReaderTabRef.current = parsed.lastViewType;
        }
      }
    } catch {}
  }, []);

  const updateNavContext = useCallback((patch: Partial<RouteContext>) => {
    const next: RouteContext = {
      ...(navContextRef.current ?? {}),
      ...patch,
      updatedAt: Date.now(),
    };
    navContextRef.current = next;
    if (navPersistTimerRef.current) window.clearTimeout(navPersistTimerRef.current);
    navPersistTimerRef.current = window.setTimeout(() => {
      try {
        safeSetLocalStorage(NAV_CONTEXT_KEY, JSON.stringify(next));
      } catch {}
    }, 300);
  }, []);

  
  
  const [authState, setAuthState] = useState<AuthState>(authManager.getState());
  const isAuthorized = authState.status === 'signed_in' && !!authManager.getToken();

  const [downloadedChapters, setDownloadedChapters] = useState<DownloadedChapterInfo[]>([]);
  const [showAttachments, setShowAttachments] = useState(false);
  const [attachmentsBookId, setAttachmentsBookId] = useState<string | null>(null);
  const [attachmentsList, setAttachmentsList] = useState<BookAttachment[]>([]);
  const [attachmentsLocalStatus, setAttachmentsLocalStatus] = useState<Record<string, boolean>>({});
  const [attachmentViewer, setAttachmentViewer] = useState<{ attachment: BookAttachment; uri: string } | null>(null);
  const [attachmentDownloads, setAttachmentDownloads] = useState<Record<string, boolean>>({});

  const [activeCueMap, setActiveCueMap] = useState<CueMap | null>(null);
  const [activeParagraphMap, setActiveParagraphMap] = useState<ParagraphMap | null>(null);
  const [cueMeta, setCueMeta] = useState<{ method?: string; count?: number } | null>(null);
  const activeCueMapRef = useRef<CueMap | null>(null);
  const activeCueIndexRef = useRef<number | null>(null);
  const activeParagraphMapRef = useRef<ParagraphMap | null>(null);
  const pendingCueFallbackRef = useRef<{ chapterId: string; text: string; prefixLen: number } | null>(null);
  const activeSpeakTextRef = useRef<{ chapterId: string; text: string; prefixLen: number } | null>(null);
  const cueIntegrityRef = useRef<{ chapterId: string; driftCount: number; lastRebuildAt: number; lastNoticeAt: number }>({
    chapterId: "",
    driftCount: 0,
    lastRebuildAt: 0,
    lastNoticeAt: 0,
  });
  const cueDurationRef = useRef<{ chapterId: string; lastDurationMs: number; lastRebuildAt: number }>({
    chapterId: "",
    lastDurationMs: 0,
    lastRebuildAt: 0,
  });

  useEffect(() => { activeCueMapRef.current = activeCueMap; }, [activeCueMap]);
  useEffect(() => { activeParagraphMapRef.current = activeParagraphMap; }, [activeParagraphMap]);

  const base64ToBlob = (base64: string, mimeType: string) => {
    const cleaned = base64.replace(/^data:.*;base64,/, "");
    const byteChars = atob(cleaned);
    const byteNumbers = new Array(byteChars.length);
    for (let i = 0; i < byteChars.length; i++) {
      byteNumbers[i] = byteChars.charCodeAt(i);
    }
    const byteArray = new Uint8Array(byteNumbers);
    return new Blob([byteArray], { type: mimeType });
  };

  const blobToDataUrl = (blob: Blob): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? ""));
      reader.onerror = () => reject(new Error("Failed to read blob"));
      reader.readAsDataURL(blob);
    });

  const readLocalAudioBlob = useCallback(async (chapterId: string) => {
    const record = await getChapterAudioPath(chapterId);
    if (!record?.localPath) return null;
    try {
      const res = await Filesystem.readFile({ path: record.localPath });
      if (res.data instanceof Blob) return res.data;
      return base64ToBlob(res.data, 'audio/mpeg');
    } catch {
      try {
        const res = await Filesystem.readFile({ path: `${appConfig.paths.audioDir}/${chapterId}.mp3`, directory: Directory.Data });
        if (res.data instanceof Blob) return res.data;
        return base64ToBlob(res.data, 'audio/mpeg');
      } catch {
        return null;
      }
    }
  }, []);

  const resolveLocalPathForUpload = useCallback(async (chapterId: string, fallbackPath?: string) => {
    const record = await getChapterAudioPath(chapterId);
    if (record?.localPath) return record.localPath;
    if (fallbackPath && (fallbackPath.startsWith("/") || fallbackPath.startsWith("file://"))) {
      return fallbackPath;
    }
    return null;
  }, []);

  const uploadChapterNow = useCallback(async (bookId: string, chapterId: string) => {
    const book = state.books.find((b) => b.id === bookId);
    if (!book || !book.driveFolderId) throw new Error("Drive folder not set");
    const chapter = book.chapters.find((c) => c.id === chapterId);
    if (!chapter) throw new Error("Chapter not found");
    const blob = await readLocalAudioBlob(chapterId);
    if (!blob) throw new Error("Local audio not found");
    const filename = buildMp3Name(bookId, chapterId);
    const targetFolderId = await ensureChapterDriveStorageFolder(book.driveFolderId, chapter);
    const cloudAudioFileId = await uploadToDrive(
      targetFolderId,
      filename,
      blob,
      chapter.cloudAudioFileId,
      "audio/mpeg"
    );
    const updated: Chapter = {
      ...chapter,
      cloudAudioFileId,
      audioDriveId: cloudAudioFileId,
      audioStatus: AudioStatus.READY,
      updatedAt: Date.now(),
    };
    await libraryUpsertChapterMeta(bookId, updated);
    setState((prev) => ({
      ...prev,
      books: prev.books.map((b) =>
        b.id === bookId
          ? { ...b, chapters: b.chapters.map((c) => (c.id === chapterId ? updated : c)) }
          : b
      ),
    }));
    return true;
  }, [readLocalAudioBlob, state.books]);

  const {
    uploadQueueCount,
    uploadQueueItems,
    isUploadingAll,
    showDownloadedChapters,
    setShowDownloadedChapters,
    showUploadQueue,
    setShowUploadQueue,
    refreshUploadQueueCount,
    refreshUploadQueueList,
    handleQueueChapterUpload,
    handleUploadAllChapters,
    handleDismissQueuedUpload,
    kickUploadQueue,
  } = useUploadQueue({
    uiMode: state.readerSettings.uiMode,
    books: state.books,
    activeBookId: state.activeBookId,
    resolveLocalPathForUpload,
    uploadChapterNow,
    pushNotice,
  });


  const { jobs, setJobs, refreshJobs } = useJobs({
    uiMode: state.readerSettings.uiMode,
    refreshUploadQueueCount,
    logJobs,
  });
  const {
    launchStage,
    launchMessage,
    signInError,
    setLaunchStage,
    setLaunchMessage,
    setSignInError,
    bootstrapStatus,
    bootstrapError,
    runBootstrap,
    restoreNavContext,
    runStartup,
    navRestoreRef,
    didRepairIndicesRef,
  } = useAppBootstrap({
    stateRef,
    setState,
    setChapterPagingByBook,
    loadMoreChapters,
    isOnline,
    performFullDriveSyncRef,
    refreshJobs,
    setJobs,
    pushNotice: pushNoticeSafe,
    setIsDirty,
    navContextRef,
  });

  useEffect(() => {
    const unsubscribe = authManager.subscribe(setAuthState);
    return () => { unsubscribe(); };
  }, []);

  useEffect(() => {
    if (activeTab !== "reader") {
      if (activeTab !== "settings") {
        lastNonReaderTabRef.current = activeTab;
        updateNavContext({ lastViewType: activeTab, lastNonReaderViewType: activeTab });
      } else {
        updateNavContext({ lastViewType: activeTab });
      }
      return;
    }
    updateNavContext({ lastViewType: activeTab });
  }, [activeTab, updateNavContext]);

  useEffect(() => {
    if (state.activeBookId) {
      updateNavContext({ bookId: state.activeBookId });
    }
  }, [state.activeBookId, updateNavContext]);

  useEffect(() => {
    if (activeTab === "settings") {
      refreshDiagnostics();
    }
  }, [activeTab, refreshDiagnostics]);

  useEffect(() => {
    let isMounted = true;
    const handles: Array<{ remove: () => Promise<void> }> = [];

    const refreshChapterMetaForJob = async (jobId: string, status: string, error?: any) => {
      try {
        const s = stateRef.current;
        const job = await getJobById(jobId, s.readerSettings.uiMode);
        if (!isMounted || !job) return;

        const payload = (job as any)?.payloadJson ?? {};
        const bookId = typeof payload?.bookId === "string" ? String(payload.bookId) : "";
        if (!bookId) return;

        let chapterIds: string[] = [];
        if (job.type === "generateAudio") {
          if (Array.isArray(payload?.chapterIds)) {
            chapterIds = payload.chapterIds.map((id: any) => String(id));
          }
        } else if (job.type === "fixIntegrity") {
          const book = s.books.find((b) => b.id === bookId);
          chapterIds = (book?.chapters ?? []).map((c) => c.id);
        } else {
          return;
        }

        const ids = Array.from(new Set((chapterIds ?? []).map((id) => String(id)))).filter(Boolean);
        if (!ids.length) return;

        const fresh = await libraryGetChaptersByIds(bookId, ids);
        if (!isMounted || !fresh.length) return;

        const byId = new Map(fresh.map((c) => [c.id, c] as const));

        // Merge DB-backed fields only; preserve progress/content fields owned by the reader pipeline.
        setState((prev) => {
          const bIdx = prev.books.findIndex((b) => b.id === bookId);
          if (bIdx === -1) return prev;
          const book = prev.books[bIdx];
          const updatedChapters = book.chapters.map((c) => {
            const f = byId.get(c.id);
            if (!f) return c;
            return {
              ...c,
              cloudTextFileId: f.cloudTextFileId,
              cloudAudioFileId: f.cloudAudioFileId,
              audioDriveId: (f as any).audioDriveId,
              audioStatus: f.audioStatus,
              audioSignature: f.audioSignature,
              durationSec: f.durationSec,
              textLength: f.textLength,
              wordCount: typeof f.wordCount === "number" ? f.wordCount : c.wordCount,
              isFavorite: typeof f.isFavorite === "boolean" ? f.isFavorite : c.isFavorite,
              updatedAt: typeof f.updatedAt === "number" ? f.updatedAt : c.updatedAt,
            };
          });
          const updatedBooks = [...prev.books];
          updatedBooks[bIdx] = { ...book, chapters: updatedChapters };
          return { ...prev, books: updatedBooks };
        });

        if (status !== "failed") return;

        const errMsg = String(error ?? job.error ?? "").trim() || "Unknown error";
        if (job.type === "generateAudio") {
          pushNotice({ message: `Audio generation failed: ${errMsg}`, type: "error" });

          const now = Date.now();
          const shouldFail = (c: Chapter | undefined) => {
            if (!c) return false;
            const ready = !!(c.cloudAudioFileId || (c as any).audioDriveId || c.audioStatus === AudioStatus.READY);
            return !ready && c.audioStatus !== AudioStatus.FAILED;
          };

          const toFail = ids
            .map((id) => byId.get(id))
            .filter((c) => shouldFail(c)) as Chapter[];

          if (!toFail.length) return;

          // Persist failed state so it doesn't bounce back to yellow on reload.
          const failedUpdates = toFail.map((c) => ({
            ...c,
            audioStatus: AudioStatus.FAILED,
            updatedAt: now,
          }));

          setState((prev) => {
            const bIdx = prev.books.findIndex((b) => b.id === bookId);
            if (bIdx === -1) return prev;
            const book = prev.books[bIdx];
            const failedSet = new Map(failedUpdates.map((c) => [c.id, c] as const));
            const updatedChapters = book.chapters.map((c) => {
              const f = failedSet.get(c.id);
              if (!f) return c;
              return {
                ...c,
                audioStatus: AudioStatus.FAILED,
                updatedAt: now,
              };
            });
            const updatedBooks = [...prev.books];
            updatedBooks[bIdx] = { ...book, chapters: updatedChapters };
            return { ...prev, books: updatedBooks };
          });

          try {
            await libraryBulkUpsertChapters(
              bookId,
              failedUpdates.map((c) => ({ chapter: { ...c, content: undefined }, content: null }))
            );
          } catch (e) {
            console.warn("[Jobs] failed to persist failed audio status", e);
          }
        } else {
          pushNotice({ message: `Job failed: ${errMsg}`, type: "error" });
        }
      } catch (e) {
        console.warn("[Jobs] refreshChapterMetaForJob failed", e);
      }
    };

    const applyJobEvent = (event: any) => {
      if (!isMounted || !event?.jobId) return;
      let progress = event.progress ?? event.progressJson;
      if (typeof progress === "string") {
        try {
          progress = JSON.parse(progress);
        } catch {
          progress = undefined;
        }
      }
      jobLog.info("event", {
        jobId: event.jobId,
        status: event.status,
        completed: progress?.completed,
        total: progress?.total,
        currentChapterId: progress?.currentChapterId,
        workRequestId: progress?.workRequestId,
      });
      setJobs((prev) => {
        const idx = prev.findIndex((j) => j.jobId === event.jobId);
        if (idx === -1) {
          // Fallback: re-fetch so the UI stays accurate.
          refreshJobs();
          refreshUploadQueueCount();
          return prev;
        }
        const current = prev[idx];
        const next: JobRecord = {
          ...current,
          status: event.status ?? current.status,
          progressJson: progress ?? current.progressJson,
          error: event.error ?? current.error,
          updatedAt: Date.now(),
        };
        const copy = [...prev];
        copy[idx] = next;
        return copy;
      });
      refreshUploadQueueCount();

      const nextStatus = String(event.status ?? "");
      if (nextStatus === "completed" || nextStatus === "failed") {
        void refreshChapterMetaForJob(event.jobId, nextStatus, event.error);
      }
    };

    if (jobRunnerAvailable) {
      JobRunner.addListener("jobProgress", applyJobEvent)
        .then((h) => handles.push(h))
        .catch(() => {});
      JobRunner.addListener("jobFinished", applyJobEvent)
        .then((h) => handles.push(h))
        .catch(() => {});
    }

    return () => {
      isMounted = false;
      handles.forEach((h) => h.remove());
    };
  }, [refreshJobs, refreshUploadQueueCount, jobRunnerAvailable, pushNotice]);

  useEffect(() => {
    refreshUploadQueueCount();
  }, [refreshUploadQueueCount]);

  useEffect(() => {
    if (!showUploadQueue) return;
    refreshUploadQueueCount();
    refreshUploadQueueList();
  }, [showUploadQueue, refreshUploadQueueCount, refreshUploadQueueList]);

  const hasActiveJobs = useMemo(() => {
    return jobs.some((j) => j.status === "queued" || j.status === "running");
  }, [jobs]);

  useEffect(() => {
    if (!hasActiveJobs) return;
    const handle = window.setInterval(() => {
      refreshJobs();
    }, 1500);
    return () => {
      window.clearInterval(handle);
    };
  }, [hasActiveJobs, refreshJobs]);

  useEffect(() => {
    let mounted = true;
    const book = state.books.find((b) => b.id === state.activeBookId);
    if (!book) {
      setDownloadedChapters([]);
      return;
    }
    const loadDownloads = async () => {
      const entries: DownloadedChapterInfo[] = [];
      let counter = 0;
      for (const chapter of book.chapters) {
        const record = await getChapterAudioPath(chapter.id);
        const localPath = record?.localPath ?? null;
        if (!localPath) continue;
        if (!mounted) return;
        entries.push({
          id: chapter.id,
          title: chapter.title,
          index: chapter.index,
          localPath,
          hasDriveAudio: !!(chapter.cloudAudioFileId || chapter.audioDriveId),
        });
        counter += 1;
        if (counter % 40 === 0) {
          await yieldToUi();
        }
      }
      if (mounted) {
        setDownloadedChapters(entries);
      }
    };
    loadDownloads();
    return () => {
      mounted = false;
    };
  }, [state.activeBookId, state.books, state.readerSettings.uiMode]);

  const activeBook = useMemo(() => state.books.find(b => b.id === state.activeBookId), [state.books, state.activeBookId]);
  useEffect(() => {
    let cancelled = false;
    const loadAddChapterVolumes = async () => {
      if (!isAddChapterOpen || !activeBook) {
        if (!cancelled) setAddChapterVolumeNames([]);
        return;
      }

      const ordered: string[] = [];
      const seen = new Set<string>();
      const pushName = (value: unknown) => {
        if (typeof value !== "string") return;
        const trimmed = value.trim();
        if (!trimmed) return;
        const key = trimmed.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        ordered.push(trimmed);
      };

      (activeBook.settings?.volumeOrder || []).forEach(pushName);
      (activeBook.chapters || []).forEach((chapter) => pushName((chapter as any).volumeName));

      if (activeBook.backend === StorageBackend.DRIVE && activeBook.driveFolderId && isAuthorized) {
        try {
          const driveFolders = await listVolumeFolders(activeBook.driveFolderId);
          driveFolders.forEach((folder) => pushName(folder.name));
        } catch (e) {
          console.warn("[Extractor] Failed to load Drive volumes", e);
        }
      }

      if (!cancelled) {
        setAddChapterVolumeNames(ordered);
      }
    };

    void loadAddChapterVolumes();
    return () => {
      cancelled = true;
    };
  }, [
    activeBook,
    isAddChapterOpen,
    isAuthorized,
  ]);
  const effectivePlaybackSpeedForUi =
    activeBook?.settings.useBookSettings && activeBook.settings.playbackSpeed
      ? activeBook.settings.playbackSpeed
      : state.playbackSpeed;
  const activeChapterMetadata = useMemo(() => activeBook?.chapters.find(c => c.id === activeBook.currentChapterId), [activeBook]);
  const {
    backupOptions,
    setBackupOptions,
    backupProgress,
    driveBackupCandidates,
    handleBackupToDriveZip,
    handleBackupToDeviceZip,
    handleRestoreFromFileZip,
    handleLoadDriveBackupCandidates,
    handleRestoreFromDriveBackup,
    runBackup,
  } = useBackup({
    stateRef,
    setState,
    jobs,
    activeChapterId: activeChapterMetadata?.id ?? null,
    activeTab,
    pushNotice: pushNoticeSafe,
    isOnline,
  });
  const activeChapterKey = activeBook?.currentChapterId ? `${activeBook.id}:${activeBook.currentChapterId}` : null;
  const activeChapterText = useMemo(() => {
    const content = activeChapterMetadata?.content;
    if (typeof content === "string" && content.length > 0) return content;
    if (activeChapterKey) {
      return chapterTextCacheRef.current.get(activeChapterKey) ?? "";
    }
    return "";
  }, [activeChapterKey, activeChapterMetadata?.content]);

  const activeReaderModel = useMemo(() => {
    if (!activeChapterText) return { blocks: [], speakText: "" };
    const chapterFilename = activeChapterMetadata?.filename ?? "";
    const isMarkdown =
      activeChapterMetadata?.contentFormat === "markdown" ||
      chapterFilename.toLowerCase().endsWith(".md");
    const allRules = [...state.globalRules, ...(activeBook?.rules ?? [])];
    return buildReaderModel(activeChapterText, isMarkdown, allRules, !!state.readerSettings?.reflowLineBreaks);
  }, [
    activeChapterText,
    activeChapterMetadata?.contentFormat,
    activeChapterMetadata?.filename,
    state.globalRules,
    activeBook?.rules,
    state.readerSettings?.reflowLineBreaks,
  ]);

  const activeSpeechText = activeReaderModel.speakText;

  useEffect(() => {
    if (!activeBook || !activeChapterMetadata || !activeChapterKey) return;
    const content = typeof activeChapterMetadata.content === "string" ? activeChapterMetadata.content : "";
    if (content.length > 0) {
      chapterTextCacheRef.current.set(activeChapterKey, content);
      return;
    }
    const cached = chapterTextCacheRef.current.get(activeChapterKey);
    if (cached && cached.length > 0) {
      trace("text:load", { chapterId: activeChapterMetadata.id, source: "memory", len: cached.length });
      setState(p => ({
        ...p,
        books: p.books.map(b =>
          b.id === activeBook.id
            ? {
                ...b,
                chapters: b.chapters.map(c =>
                  c.id === activeChapterMetadata.id
                    ? { ...c, content: cached, textLength: cached.length, updatedAt: Date.now() }
                    : c
                ),
              }
            : b
        ),
      }));
    }
  }, [activeBook, activeChapterMetadata, activeChapterKey]);

  const readerProgressMap = useMemo<ProgressMap>(() => {
    if (!activeBook) return {};
    const map: ProgressMap = {};
    for (const chapter of activeBook.chapters) {
      const textLength =
        typeof chapter.textLength === "number"
          ? chapter.textLength
          : typeof chapter.content === "string"
            ? chapter.content.length
            : 0;
      const progressChars =
        typeof chapter.progressChars === "number" && Number.isFinite(chapter.progressChars)
          ? chapter.progressChars
          : undefined;
      const percent =
        typeof chapter.progress === "number"
          ? chapter.progress
          : progressChars != null && textLength > 0
            ? computePercent(progressChars, textLength) ?? 0
            : 0;
      const index =
        progressChars != null
          ? progressChars
          : textLength > 0
            ? Math.round(percent * textLength)
            : 0;
      map[chapter.id] = {
        chapterId: chapter.id,
        index,
        total: textLength,
        percent,
        isCompleted: !!chapter.isCompleted,
        updatedAt: chapter.updatedAt ?? 0,
        timeSec: chapter.progressSec,
        durationSec: chapter.durationSec,
      };
    }
    return map;
  }, [activeBook]);

  const persistReaderProgress = useCallback((map: ProgressMap) => {
    const bookId = activeBook?.id;
    if (!bookId) return;
    try {
      const store = readProgressStore();
      const books = { ...store.books };
      if (!books[bookId]) books[bookId] = {};
      const book = activeBook;
      for (const [chapterId, entry] of Object.entries(map)) {
        const chapter = book?.chapters.find(c => c.id === chapterId);
        books[bookId][chapterId] = {
          timeSec: chapter?.progressSec ?? entry.timeSec,
          durationSec: chapter?.durationSec ?? entry.durationSec,
          percent: entry.percent,
          completed: entry.isCompleted,
          updatedAt: entry.updatedAt,
        };
      }
      writeProgressStore({ ...store, books });
    } catch (e) {
      console.warn("Progress write failed", e);
    }
  }, [activeBook]);

  useEffect(() => {
    if (activeBook?.currentChapterId) {
      updateNavContext({
        bookId: activeBook.id,
        chapterId: activeBook.currentChapterId,
        chapterIndex: activeChapterMetadata?.index,
      });
    }
  }, [activeBook?.id, activeBook?.currentChapterId, activeChapterMetadata?.index, updateNavContext]);

  const handleReaderScroll = useCallback((scrollTop: number) => {
    if (activeTab !== "reader") return;
    updateNavContext({ scrollTop });
  }, [activeTab, updateNavContext]);

  const handleCollectionScroll = useCallback((scrollTop: number) => {
    if (activeTab !== "collection") return;
    updateNavContext({ collectionScrollTop: scrollTop });
  }, [activeTab, updateNavContext]);

  const handleHighlightOffsetChange = useCallback((offset: number) => {
    if (stateRef.current.currentOffsetChars !== offset) {
      setState(p => ({ ...p, currentOffsetChars: offset }));
    }
  }, []);

  const highlightEnabled = state.readerSettings.highlightEnabled !== false;
  const highlightSync = useHighlightSync({
    chapterId: activeChapterMetadata?.id ?? null,
    text: activeSpeechText,
    cueMap: activeCueMap,
    paragraphMap: activeParagraphMap,
    playbackAdapter,
    enabled: highlightEnabled,
    throttleMs: state.readerSettings.highlightUpdateRateMs ?? 250,
    onOffsetChange: handleHighlightOffsetChange,
  });
  const activeCueIndex = highlightSync.activeCueIndex;
  const activeCueRange = highlightSync.activeCueRange;
  const activeParagraphIndex = highlightSync.activeParagraphIndex;
  const isCueReady = highlightSync.isCueReady;

  const cueMapMaxEnd = useMemo(() => {
    if (!activeCueMap?.cues?.length) return 0;
    return activeCueMap.cues.reduce((acc, cue) => Math.max(acc, cue.endChar), 0);
  }, [activeCueMap]);

  const cuePrefixLen = useMemo(() => {
    const activeChapterId = activeChapterMetadata?.id ?? null;
    const activeSpeak = activeSpeakTextRef.current;
    if (!activeChapterId || !activeSpeak || activeSpeak.chapterId !== activeChapterId) return 0;
    return Number.isFinite(activeSpeak.prefixLen) ? Math.max(0, activeSpeak.prefixLen) : 0;
  }, [activeChapterMetadata?.id, activeCueMap?.chapterId]);

  const cueMapLooksPrefixed =
    cuePrefixLen > 0 && cueMapMaxEnd > activeSpeechText.length + 2;

  const normalizedActiveCueRange = useMemo(() => {
    if (!activeCueRange) return null;
    if (!cueMapLooksPrefixed) return activeCueRange;

    const len = activeSpeechText.length;
    if (len <= 0) return null;

    const correctedStart = activeCueRange.start - cuePrefixLen;
    const correctedEnd = activeCueRange.end - cuePrefixLen;
    const start = Math.max(0, Math.min(correctedStart, len));
    const end = Math.max(start, Math.min(correctedEnd, len));
    return { start, end };
  }, [activeCueRange, cueMapLooksPrefixed, cuePrefixLen, activeSpeechText.length]);

  const cuePrefixWarnRef = useRef<string | null>(null);
  useEffect(() => {
    if (!cueMapLooksPrefixed) return;
    if (!(state.debugMode || state.readerSettings.highlightDebugOverlay)) return;
    const chapterId = activeChapterMetadata?.id ?? null;
    if (!chapterId) return;
    if (cuePrefixWarnRef.current === chapterId) return;
    cuePrefixWarnRef.current = chapterId;
    console.warn("[Highlight] cue map appears prefixed; applying correction", {
      chapterId,
      prefixLen: cuePrefixLen,
      maxCueEnd: cueMapMaxEnd,
      speechTextLen: activeSpeechText.length,
    });
  }, [
    cueMapLooksPrefixed,
    cuePrefixLen,
    cueMapMaxEnd,
    activeSpeechText.length,
    activeChapterMetadata?.id,
    state.debugMode,
    state.readerSettings.highlightDebugOverlay,
  ]);
  const lastSyncAt = state.syncDiagnostics?.lastSyncSuccessAt ?? state.syncDiagnostics?.lastSyncAttemptAt;

  useEffect(() => { activeCueIndexRef.current = activeCueIndex; }, [activeCueIndex]);

  useEffect(() => {
    if (bootstrapStatus === "error" && bootstrapError) {
      pushNotice({ message: `Startup failed: ${bootstrapError}`, type: "error", ms: 6000 });
    }
  }, [bootstrapStatus, bootstrapError, pushNotice]);

  useEffect(() => {
    if (launchStage !== "ready") return;
    if (authState.status === 'error') {
      pushNotice({ message: `Auth Error: ${authState.lastError}`, type: 'error' });
    }
    if (authState.status === 'expired') {
      pushNotice({ message: 'Drive session expired. Reconnect required.', type: 'reconnect', ms: 6000 });
    }
  }, [authState.status, authState.lastError, launchStage, pushNotice]);

  const updateDiagnostics = useCallback((updates: Partial<SyncDiagnostics>) => {
    setState(p => {
      const next = { ...p.syncDiagnostics, ...updates };
      safeSetLocalStorage('talevox_sync_diag', JSON.stringify(next));
      return { ...p, syncDiagnostics: next };
    });
  }, []);

  useEffect(() => {
    const update = () => setIsOnline(typeof navigator !== "undefined" ? navigator.onLine : true);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  useEffect(() => {
    readProgressStore();
  }, []);

  const loadAllChapterMeta = useCallback(async (bookId: string): Promise<Chapter[]> => {
    const all: Chapter[] = [];
    let after: number | null = -1;
    for (;;) {
      const page = await libraryListChaptersPage(bookId, after, 500);
      all.push(...page.chapters);
      if (page.nextAfterIndex == null) break;
      after = page.nextAfterIndex;
    }
    return normalizeChapterOrder(all);
  }, []);

  const mergeProgressEntryIntoChapter = useCallback(
    (chapter: Chapter, progressEntry?: ProgressStoreEntry): Chapter => {
      if (!progressEntry) return normalizeChapterProgress(chapter);

      const chapterUpdatedAt =
        typeof chapter.updatedAt === "number" && Number.isFinite(chapter.updatedAt)
          ? chapter.updatedAt
          : 0;
      const entryUpdatedAt =
        typeof progressEntry.updatedAt === "number" && Number.isFinite(progressEntry.updatedAt)
          ? progressEntry.updatedAt
          : chapterUpdatedAt + 1;
      const entryPercent =
        typeof progressEntry.percent === "number" && Number.isFinite(progressEntry.percent)
          ? Math.max(0, Math.min(1, progressEntry.percent))
          : undefined;
      const entryTimeSec =
        typeof progressEntry.timeSec === "number" && Number.isFinite(progressEntry.timeSec)
          ? Math.max(0, progressEntry.timeSec)
          : undefined;
      const entryDurationSec =
        typeof progressEntry.durationSec === "number" &&
        Number.isFinite(progressEntry.durationSec)
          ? Math.max(0, progressEntry.durationSec)
          : undefined;

      let preferEntry = entryUpdatedAt >= chapterUpdatedAt;
      if (
        !preferEntry &&
        typeof entryPercent === "number" &&
        entryPercent > (chapter.progress ?? 0) + 0.001
      ) {
        preferEntry = true;
      }
      if (!preferEntry && progressEntry.completed === true && !chapter.isCompleted) {
        preferEntry = true;
      }
      if (!preferEntry) {
        return normalizeChapterProgress(chapter);
      }

      const textLength =
        typeof chapter.textLength === "number" && chapter.textLength > 0
          ? chapter.textLength
          : typeof chapter.content === "string" && chapter.content.length > 0
            ? chapter.content.length
            : 0;
      const progressCharsFromPercent =
        typeof entryPercent === "number" && textLength > 0
          ? Math.round(entryPercent * textLength)
          : chapter.progressChars;

      return normalizeChapterProgress({
        ...chapter,
        progress: typeof entryPercent === "number" ? entryPercent : chapter.progress,
        progressSec: entryTimeSec ?? chapter.progressSec,
        durationSec: entryDurationSec ?? chapter.durationSec,
        progressChars:
          typeof progressCharsFromPercent === "number" && Number.isFinite(progressCharsFromPercent)
            ? Math.max(0, progressCharsFromPercent)
            : chapter.progressChars,
        isCompleted:
          typeof progressEntry.completed === "boolean"
            ? progressEntry.completed
            : chapter.isCompleted,
        updatedAt: Math.max(chapterUpdatedAt, entryUpdatedAt),
      });
    },
    []
  );

  const buildSnapshotState = useCallback(
    async (sourceState: AppState, progressStorePayload: ProgressStorePayload): Promise<AppState> => {
      const books = await Promise.all(
        sourceState.books.map(async (book) => {
          const persistedChapters = await loadAllChapterMeta(book.id);
          const chapterById = new Map<string, Chapter>();

          for (const chapter of persistedChapters) {
            chapterById.set(chapter.id, chapter);
          }
          for (const chapter of book.chapters || []) {
            const existing = chapterById.get(chapter.id);
            chapterById.set(chapter.id, existing ? { ...existing, ...chapter } : chapter);
          }

          const progressByChapter = progressStorePayload.books?.[book.id] ?? {};
          const mergedChapters = orderChaptersForDisplay(
            Array.from(chapterById.values()).map((chapter) =>
              mergeProgressEntryIntoChapter(chapter, progressByChapter[chapter.id])
            )
          );

          return {
            ...book,
            chapters: mergedChapters,
            chapterCount:
              typeof book.chapterCount === "number"
                ? Math.max(book.chapterCount, mergedChapters.length)
                : mergedChapters.length,
          };
        })
      );

      return {
        ...sourceState,
        books,
      };
    },
    [loadAllChapterMeta, mergeProgressEntryIntoChapter]
  );

  const markDirty = useCallback(() => {
    setIsDirty(true);
    updateDiagnostics({ isDirty: true, dirtySince: Date.now() });
  }, [updateDiagnostics]);

  const applyReaderProgressCommit = useCallback((chapterId: string, next: ChapterProgress) => {
    const s = stateRef.current;
    const bookId = s.activeBookId;
    if (!bookId) return;
    setState(prev => {
      const bIdx = prev.books.findIndex(b => b.id === bookId);
      if (bIdx === -1) return prev;
      const book = prev.books[bIdx];
      const cIdx = book.chapters.findIndex(c => c.id === chapterId);
      if (cIdx === -1) return prev;
      const updatedChapters = [...book.chapters];
      const current = updatedChapters[cIdx];
      updatedChapters[cIdx] = {
        ...current,
        progress: next.percent,
        progressChars: next.index,
        textLength: next.total || current.textLength,
        isCompleted: next.isCompleted,
        progressSec: typeof next.timeSec === "number" ? next.timeSec : current.progressSec,
        durationSec: typeof next.durationSec === "number" ? next.durationSec : current.durationSec,
        updatedAt: next.updatedAt,
      };
      const updatedBooks = [...prev.books];
      updatedBooks[bIdx] = { ...book, chapters: updatedChapters };
      return { ...prev, books: updatedBooks };
    });
    markDirty();
  }, [markDirty]);

  const { handleManualScrub, handleChapterEnd, handleSkip } = useReaderProgress({
    chapters: activeBook ? activeBook.chapters.map(chapter => ({
      id: chapter.id,
      textLength:
        typeof chapter.textLength === "number"
          ? chapter.textLength
          : typeof chapter.content === "string"
            ? chapter.content.length
            : 0,
    })) : [],
    currentChapterId: activeBook?.currentChapterId ?? null,
    autoplay: false,
    externalProgress: readerProgressMap,
    persist: persistReaderProgress,
    onCommit: applyReaderProgressCommit,
  });

  const handleCueSyncUpdate = useCallback((
    meta: PlaybackMetadata & { completed?: boolean },
    ctx: { currentIntroDurSec: number; setCurrentIntroDurSec: (next: number) => void }
  ) => {
    const s = stateRef.current;
    const b = s.books.find(bk => bk.id === s.activeBookId);
    const activeChapterId = b?.currentChapterId ?? null;
    const chapterExists = !!(b && meta.chapterId && b.chapters.some(c => c.id === meta.chapterId));
    const playingChapterId = chapterExists ? meta.chapterId ?? activeChapterId : activeChapterId;

    const pendingFallback = pendingCueFallbackRef.current;
    if (pendingFallback && meta.duration > 0) {
      if (playingChapterId === pendingFallback.chapterId && !activeCueMapRef.current) {
        pendingCueFallbackRef.current = null;
        void (async () => {
          const chapter = b?.chapters.find(c => c.id === pendingFallback.chapterId);
          const introMs = computeIntroMs({
            audioIntroDurSec: chapter?.audioIntroDurSec,
            audioPrefixLen: pendingFallback.prefixLen,
            textLen: pendingFallback.text.length,
            durationMs: Math.floor(meta.duration * 1000),
          });
          if (introMs > 0) {
            ctx.setCurrentIntroDurSec(introMs / 1000);
          }
          const built = generateFallbackCueMap({
            chapterId: pendingFallback.chapterId,
            text: pendingFallback.text,
            durationMs: Math.floor(meta.duration * 1000),
            introOffsetMs: introMs,
          });
          await saveCueMap(pendingFallback.chapterId, built);
          console.log("[Highlight] cue map generated", {
            chapterId: pendingFallback.chapterId,
            cueCount: built.cues.length,
            method: built.method,
            durationMs: Math.floor(meta.duration * 1000),
          });
          setActiveCueMap(built);
          setCueMeta({ method: built.method, count: built.cues.length });
        })().catch((e) => {
          console.warn("Cue map fallback build failed", e);
        });
      }
    }

    const cueMap = activeCueMapRef.current;
    if (cueMap && cueMap.cues.length > 0) {
      const positionMs = Math.floor(meta.currentTime * 1000);
      const idx = findCueIndex(cueMap.cues, positionMs);

      const activeSpeak = activeSpeakTextRef.current;
      if (
        activeSpeak &&
        playingChapterId === activeSpeak.chapterId &&
        meta.duration > 5 &&
        meta.currentTime > 2 &&
        activeSpeak.text.length > 0
      ) {
        const durationMs = Math.floor(meta.duration * 1000);
        if (durationMs > 0 && cueMap.durationMs) {
          const durationState = cueDurationRef.current;
          if (durationState.chapterId !== activeSpeak.chapterId) {
            durationState.chapterId = activeSpeak.chapterId;
            durationState.lastDurationMs = durationMs;
            durationState.lastRebuildAt = 0;
          }

          const driftMs = Math.abs(cueMap.durationMs - durationMs);
          const now = Date.now();
          if (driftMs > 1500 && now - durationState.lastRebuildAt > 20000) {
            durationState.lastRebuildAt = now;
            void (async () => {
              const introMsForRebuild = Math.max(0, Math.floor(ctx.currentIntroDurSec * 1000));
              const built = generateFallbackCueMap({
                chapterId: activeSpeak.chapterId,
                text: activeSpeak.text,
                durationMs,
                introOffsetMs: introMsForRebuild,
              });
              await saveCueMap(activeSpeak.chapterId, built);
              setActiveCueMap(built);
              setCueMeta({ method: built.method, count: built.cues.length });
              console.log("[Highlight] cue map regenerated (duration change)", {
                chapterId: activeSpeak.chapterId,
                cueCount: built.cues.length,
                method: built.method,
                durationMs,
                previousDurationMs: cueMap.durationMs,
              });
            })().catch((e) => {
              console.warn("Cue map duration rebuild failed", e);
            });
          }
        }

        const driftState = cueIntegrityRef.current;
        if (driftState.chapterId !== activeSpeak.chapterId) {
          driftState.chapterId = activeSpeak.chapterId;
          driftState.driftCount = 0;
          driftState.lastRebuildAt = 0;
        }
        if (meta.duration > 0) {
          const linearOffset = Math.floor((meta.currentTime / meta.duration) * activeSpeak.text.length);
          const cueOffset = cueMap.cues[idx]?.startChar ?? 0;
          const drift = Math.abs(cueOffset - linearOffset);
          const threshold = Math.max(200, Math.floor(activeSpeak.text.length * 0.12));
          if (drift > threshold) {
            driftState.driftCount += 1;
          } else {
            driftState.driftCount = 0;
          }

          const now = Date.now();
          if (driftState.driftCount >= 4 && now - driftState.lastRebuildAt > 30000) {
            driftState.lastRebuildAt = now;
            driftState.driftCount = 0;
            void (async () => {
              const introMsForRebuild = Math.max(0, Math.floor(ctx.currentIntroDurSec * 1000));
              const built = generateFallbackCueMap({
                chapterId: activeSpeak.chapterId,
                text: activeSpeak.text,
                durationMs: Math.floor(meta.duration * 1000),
                introOffsetMs: introMsForRebuild,
              });
              await saveCueMap(activeSpeak.chapterId, built);
              setActiveCueMap(built);
              setCueMeta({ method: built.method, count: built.cues.length });
              console.log("[Highlight] cue map rebuilt", {
                chapterId: activeSpeak.chapterId,
                cueCount: built.cues.length,
                method: built.method,
                durationMs: Math.floor(meta.duration * 1000),
              });
              if (now - driftState.lastNoticeAt > 45000) {
                driftState.lastNoticeAt = now;
                pushNotice({ message: "Rebuilt highlight map", type: 'info', ms: 1200 });
              }
            })().catch((e) => {
              console.warn("Cue map rebuild failed", e);
            });
          }
        }
      }
    } else {
      const nextOffset = Number.isFinite(meta.charOffset) ? meta.charOffset : stateRef.current.currentOffsetChars;
      if (Math.abs(nextOffset - stateRef.current.currentOffsetChars) > 5) {
        setState(p => ({ ...p, currentOffsetChars: nextOffset }));
      }
    }
  }, [pushNotice, setActiveCueMap, setCueMeta]);

  useEffect(() => {
    document.documentElement.style.setProperty('--highlight-color', state.readerSettings.highlightColor);
  }, [state.readerSettings.highlightColor]);

  const handleSaveState = useCallback(async (force = false, silent = false): Promise<boolean> => {
      const s = stateRef.current;
      if (!s.driveRootFolderId) return false;
      if (!force && !isDirty) return false;

      if (!silent) {
        pushNotice({ message: "Saving...", type: "info", ms: 1200 });
      }

      try {
          const preferencesRaw = localStorage.getItem(PREFS_KEY);
          const preferences = preferencesRaw ? (JSON.parse(preferencesRaw) as Record<string, unknown>) : {};
          let readerProgress: Record<string, unknown> = {};
          try {
            const raw = localStorage.getItem("talevox_reader_progress");
            if (raw) readerProgress = JSON.parse(raw);
          } catch {
            readerProgress = {};
          }
          const progressStorePayload = readProgressStore();
          const snapshotState = force ? await buildSnapshotState(stateRef.current, progressStorePayload) : s;
          const attachmentLists = await Promise.all(
            snapshotState.books.map((book) => libraryListBookAttachments(book.id).catch(() => []))
          );
          const attachments = attachmentLists.flat();

          const snapshot = buildFullSnapshot({
            state: snapshotState,
            preferences,
            readerProgress,
            legacyProgressStore: (progressStorePayload as unknown as Record<string, unknown>) || {},
            attachments,
            jobs,
            activeChapterId: activeChapterMetadata?.id,
            activeTab,
          });

          const saveRes = await saveToDrive({
            rootFolderId: snapshotState.driveRootFolderId || s.driveRootFolderId,
            savesFolderId: snapshotState.driveSubfolders?.savesId || s.driveSubfolders?.savesId,
            snapshot,
          });

          const nextSubfolders = saveRes.driveSubfolders
            ? saveRes.driveSubfolders
            : s.driveSubfolders;

          safeSetLocalStorage(SNAPSHOT_KEY, JSON.stringify(snapshot));
          setState((p) => ({
            ...p,
            lastSavedAt: snapshot.createdAt,
            driveSubfolders: nextSubfolders ?? p.driveSubfolders,
          }));
          updateDiagnostics({
            lastAutoSaveSuccessAt: snapshot.createdAt,
            lastCloudSaveAt: snapshot.createdAt,
            lastCloudSaveFileName: saveRes.fileName,
            cloudDirty: false,
            isDirty: false,
            lastCloudSaveTrigger: force ? "manual" : "auto",
          });
          setIsDirty(false);
          return true;
      } catch (e: any) {
          if (!silent) pushNotice({ message: "Save Failed: " + e.message, type: 'error' });
          updateDiagnostics({
            lastAutoSaveError: String(e?.message ?? e),
            lastCloudSaveTrigger: force ? "manual" : "auto",
          });
          console.error(e);
          return false;
      }
  }, [activeChapterMetadata?.id, activeTab, buildSnapshotState, isDirty, jobs, pushNotice, updateDiagnostics]);

  useEffect(() => {
    if (!state.driveRootFolderId) return;
    const intervalMinutes = Math.max(1, Number(state.autoSaveInterval) || 0);
    const intervalMs = intervalMinutes * 60 * 1000;
    const timer = window.setInterval(() => {
      if (!isDirty) return;
      void handleSaveState(false, true);
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [handleSaveState, isDirty, state.autoSaveInterval, state.driveRootFolderId]);

  const ensureChapterContentLoaded = useCallback(
    async (bookId: string, chapterId: string, session: number): Promise<string | null> => {
      const key = `${bookId}:${chapterId}`;
      const inFlight = chapterTextInFlightRef.current.get(key);
      if (inFlight) return inFlight;

      const task = (async () => {
        const s = stateRef.current;
        const book = s.books.find(b => b.id === bookId);
        const chapter = book?.chapters.find(c => c.id === chapterId);
        if (!book || !chapter) return null;

        const stateContent =
          typeof chapter.content === "string" && chapter.content.length > 0 ? chapter.content : null;
        if (stateContent) {
          chapterTextCacheRef.current.set(key, stateContent);
          try {
            await librarySaveChapterText(bookId, chapterId, stateContent);
          } catch {}
          trace("text:load", { chapterId, source: "memory", len: stateContent.length });
          return stateContent;
        }

        const memoryCached = chapterTextCacheRef.current.get(key);
        if (memoryCached && memoryCached.length > 0) {
          setState(p => ({
            ...p,
            books: p.books.map(b =>
              b.id === bookId
                ? {
                    ...b,
                    chapters: b.chapters.map(c =>
                      c.id === chapterId
                        ? { ...c, content: memoryCached, textLength: memoryCached.length, updatedAt: Date.now() }
                        : c
                    ),
                  }
                : b
            ),
          }));
          trace("text:load", { chapterId, source: "memory", len: memoryCached.length });
          return memoryCached;
        }

        // Local cache next.
        try {
          const cached = await libraryLoadChapterText(bookId, chapterId);

          if (typeof cached === "string" && cached.length > 0) {
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

            chapterTextCacheRef.current.set(key, cached);
            trace("text:load", { chapterId, source: "localDB", len: cached.length });
            return cached;
          }
        } catch (e: any) {
          traceError("text:cache:error", e);
          // ignore and fall back to Drive below
        }

        // Local file fallback (mobile/native)
        if (computeMobileMode(s.readerSettings.uiMode)) {
          const book = s.books.find((b) => b.id === bookId);
          const chapter = book?.chapters.find((c) => c.id === chapterId);
          const filename = chapter?.filename || `${chapterId}.txt`;
          const relPath = `${appConfig.paths.textDir}/${filename}`;
          try {
            const res = await Filesystem.readFile({
              path: relPath,
              directory: Directory.Data,
              encoding: Encoding.UTF8,
            });
            const fileText = typeof res.data === "string" ? res.data : "";
            if (fileText && fileText.length > 0) {
              if (chapterSessionRef.current !== session) return null;
              setState(p => ({
                ...p,
                books: p.books.map(b =>
                  b.id === bookId
                    ? {
                        ...b,
                        chapters: b.chapters.map(c =>
                          c.id === chapterId
                            ? { ...c, content: fileText, textLength: fileText.length, updatedAt: Date.now() }
                            : c
                        ),
                      }
                    : b
                ),
              }));
              chapterTextCacheRef.current.set(key, fileText);
              try {
                await librarySaveChapterText(bookId, chapterId, fileText);
              } catch {}
              trace("text:load", { chapterId, source: "file", len: fileText.length });
              return fileText;
            }
          } catch (e: any) {
            traceError("text:file:load:failed", e);
          }
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

              chapterTextCacheRef.current.set(key, text);
              trace("text:load", { chapterId, source: "drive", len: text.length });
              return text;
            }
          } catch (e: any) {
            traceError("text:drive:load:failed", e);
            pushNotice({ message: "Failed to load text: " + (e?.message ?? String(e)), type: "error" });
          }
        }

        return null;
      })();

      chapterTextInFlightRef.current.set(key, task);
      try {
        return await task;
      } finally {
        chapterTextInFlightRef.current.delete(key);
      }
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
           const textName =
             chapter.filename ||
             buildTextName(book.id, chapter.id, chapter.contentFormat === "markdown" ? "markdown" : "text");
           const audioName = buildMp3Name(book.id, chapter.id);
           const volumeFolderId = await findChapterDriveStorageFolder(book.driveFolderId, chapter);
           const searchFolders =
             volumeFolderId && volumeFolderId !== book.driveFolderId
               ? [volumeFolderId, book.driveFolderId]
               : [book.driveFolderId];

           const [textCandidates, audioCandidates] = await Promise.all([
             Promise.all(searchFolders.map((folderId) => findFileSync(textName, folderId))),
             Promise.all(searchFolders.map((folderId) => findFileSync(audioName, folderId))),
           ]);
           const textId = textCandidates.find((id) => !!id) || null;
           const audioId = audioCandidates.find((id) => !!id) || null;
           
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

  const getEffectivePlaybackSpeed = useCallback(() => {
    const s = stateRef.current;
    const book = s.books.find(b => b.id === s.activeBookId);
    const bookSpeed = book?.settings?.useBookSettings ? book?.settings?.playbackSpeed : null;
    return bookSpeed && bookSpeed > 0 ? bookSpeed : s.playbackSpeed;
  }, []);

  const {
    playbackPhase,
    isPlaying,
    isLoadingChapter,
    audioDuration,
    audioCurrentTime,
    seekNudge,
    isScrubbing,
    sleepTimerSeconds,
    stopAfterChapter,
    autoplayBlocked,
    playbackSnapshot,
    currentIntroDurSec,
    lastPlaybackError,
    handleManualPlay,
    handleManualPause,
    handleManualStop,
    handleNextChapter,
    handlePrevChapter,
    handleNextChapterRef,
    handleJumpToOffset,
    handleSeekByDelta,
    handleScrubStart,
    handleScrubMove,
    handleScrubEnd,
    handleScrubEndOffset,
    loadChapterSession,
    commitProgressUpdate,
    setCurrentIntroDurSec,
    setSleepTimerSeconds,
    setStopAfterChapter,
  } = usePlayback({
    stateRef,
    setState,
    pushNotice,
    effectiveMobileMode,
    isAuthorized,
    playbackAdapter,
    markDirty,
    handleManualScrub,
    handleChapterEnd,
    handleSkip,
    chapterSessionRef,
    chapterTextCacheRef,
    ensureChapterContentLoaded,
    getEffectivePlaybackSpeed,
    isOnline,
    setActiveCueMap,
    setActiveParagraphMap,
    setCueMeta,
    pendingCueFallbackRef,
    activeSpeakTextRef,
    cueIntegrityRef,
    cueDurationRef,
    isInIntroRef,
    onSyncMeta: handleCueSyncUpdate,
  });

  const highlightDebugData = useMemo(() => ({
    positionMs: Math.floor(audioCurrentTime * 1000),
    durationMs: Math.floor(audioDuration * 1000),
    cueIndex: highlightEnabled ? activeCueIndex : null,
    cueCount: activeCueMap?.cues?.length ?? 0,
    paragraphIndex: highlightEnabled ? activeParagraphIndex : null,
    paragraphCount: activeParagraphMap?.paragraphs?.length ?? 0,
    mode: "paragraph",
    isPlaying,
  }), [
    audioCurrentTime,
    audioDuration,
    highlightEnabled,
    activeCueIndex,
    activeParagraphIndex,
    activeCueMap,
    activeParagraphMap,
    isPlaying,
  ]);

  const handleResetChapterProgress = (bid: string, cid: string) => {
    commitProgressUpdate(bid, cid, { currentTime: 0, duration: 0, charOffset: 0, completed: false }, "reset", true, true, true);
    pushNotice({ message: "Reset", type: 'info', ms: 1000 });
  };

  const handleSmartOpenChapter = (id: string) => {
    const s = stateRef.current;
    const book = s.books.find(b => b.id === s.activeBookId);
    if (!book) return;
    
    const clickedChapter = book.chapters.find(c => c.id === id);
    if (!clickedChapter) return;

    const prior = navContextRef.current;
    if (prior?.chapterId === id && typeof prior.scrollTop === "number") {
      setReaderInitialScrollTop(prior.scrollTop);
    } else {
      setReaderInitialScrollTop(0);
    }

    setActiveTab('reader');

    if (clickedChapter.isCompleted) {
        const sorted = normalizeChapterOrder(book.chapters || []);
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

  useEffect(() => {
    const pending = navRestoreRef.current;
    if (!pending) return;
    const book = pending.bookId ? state.books.find((b) => b.id === pending.bookId) : null;
    if (!book) return;
    const lastView = pending.lastViewType ?? "library";
    const resolvedView =
      lastView === "settings"
        ? (pending.lastNonReaderViewType ?? "library")
        : lastView;

    if (resolvedView === "reader" && pending.chapterId) {
      const chapter = book.chapters.find((c) => c.id === pending.chapterId);
      if (!chapter) return;
      navRestoreRef.current = null;
      setReaderInitialScrollTop(typeof pending.scrollTop === "number" ? pending.scrollTop : 0);
      setActiveTab("reader");
      loadChapterSession(pending.chapterId, "user");
      return;
    }

    navRestoreRef.current = null;
    setActiveTab(resolvedView);
  }, [state.books, loadChapterSession]);

  const handleUpdateBookMeta = useCallback(async (book: Book) => {
    const s = stateRef.current;
    const existing = s.books.find(b => b.id === book.id);
    const merged = {
      ...existing,
      ...book,
      settings: normalizeBookSettings(book.settings ?? existing?.settings),
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
          settings: normalizeBookSettings(book.settings ?? b.settings),
          chapterCount: b.chapterCount,
          chapters: b.chapters,
        };
      })
    }));
    markDirty();
  }, [markDirty]);

  const handleUpdateChapterTitle = useCallback(async (chapterId: string, title: string) => {
    const s = stateRef.current;
    const book = s.books.find((b) => b.id === s.activeBookId);
    if (!book) return;
    const chapter = book.chapters.find((c) => c.id === chapterId);
    if (!chapter) return;

    const normalizedTitle = normalizeChapterTitle(title, `Chapter ${chapter.index}`);
    const updated: Chapter = { ...chapter, title: normalizedTitle, updatedAt: Date.now() };
    setState((p) => ({
      ...p,
      books: p.books.map((b) =>
        b.id === book.id
          ? { ...b, chapters: b.chapters.map((c) => (c.id === chapterId ? updated : c)) }
          : b
      ),
    }));
    markDirty();

    try {
      await libraryUpsertChapterMeta(book.id, { ...updated, content: undefined });
    } catch (e: any) {
      console.warn("[TaleVox][Library] chapter title update failed", e);
    }

    if (book.backend === StorageBackend.DRIVE && book.driveFolderId && isAuthorized) {
      void syncBookInventoryToDrive(book);
    }
  }, [markDirty, isAuthorized]);

  const handleUpdateChapter = useCallback(async (chapter: Chapter) => {
    const s = stateRef.current;
    const book = s.books.find((b) => b.id === s.activeBookId);
    if (!book) return;
    const existing = book.chapters.find((c) => c.id === chapter.id);
    const merged = existing ? preserveChapterContent(existing, { ...existing, ...chapter }, "handleUpdateChapter") : chapter;
    setState((prev) => ({
      ...prev,
      books: prev.books.map((b) =>
        b.id === book.id
          ? {
              ...b,
              chapters: orderChaptersForDisplay(
                b.chapters.map((c) => (c.id === chapter.id ? merged : c))
              ),
            }
          : b
      ),
    }));
    markDirty();
    try {
      await libraryUpsertChapterMeta(book.id, { ...merged, content: undefined });
    } catch (e: any) {
      console.warn("[TaleVox][Library] chapter update failed", e);
    }

    const normalizeVolumeName = (value: unknown) =>
      typeof value === "string" && value.trim().length ? value.trim() : "";
    const previousVolumeName = normalizeVolumeName((existing as any)?.volumeName);
    const nextVolumeName = normalizeVolumeName((merged as any)?.volumeName);
    const volumeChanged = previousVolumeName !== nextVolumeName;

    if (
      existing &&
      volumeChanged &&
      book.backend === StorageBackend.DRIVE &&
      !!book.driveFolderId &&
      isAuthorized
    ) {
      try {
        const targetFolderId = await ensureChapterDriveStorageFolder(book.driveFolderId, merged);
        const fileIds = Array.from(
          new Set(
            [
              merged.cloudTextFileId,
              merged.cloudAudioFileId,
              (merged as any).audioDriveId,
              existing.cloudTextFileId,
              existing.cloudAudioFileId,
              (existing as any).audioDriveId,
            ].filter((value): value is string => typeof value === "string" && value.trim().length > 0)
          )
        );

        for (const fileId of fileIds) {
          try {
            const parentIds = await getDriveFileParentIds(fileId);
            if (parentIds.includes(targetFolderId)) continue;

            let moved = false;
            for (const parentId of parentIds) {
              if (!parentId || parentId === targetFolderId) continue;
              try {
                await moveFile(fileId, parentId, targetFolderId);
                moved = true;
                break;
              } catch {
                // Continue trying other known parents.
              }
            }

            if (!moved && parentIds.length === 0 && targetFolderId !== book.driveFolderId) {
              try {
                await moveFile(fileId, book.driveFolderId, targetFolderId);
                moved = true;
              } catch {
                // Fall through to warning below.
              }
            }

            if (!moved) {
              console.warn("[Drive] unable to move chapter file after volume change", {
                bookId: book.id,
                chapterId: merged.id,
                fileId,
                fromVolume: previousVolumeName || "(unassigned)",
                toVolume: nextVolumeName || "(unassigned)",
                targetFolderId,
                parentIds,
              });
            }
          } catch (e) {
            console.warn("[Drive] chapter file parent lookup failed", {
              bookId: book.id,
              chapterId: merged.id,
              fileId,
              error: e,
            });
          }
        }
      } catch (e) {
        console.warn("[Drive] volume folder move failed", {
          bookId: book.id,
          chapterId: merged.id,
          fromVolume: previousVolumeName || "(unassigned)",
          toVolume: nextVolumeName || "(unassigned)",
          error: e,
        });
      }
    }
  }, [isAuthorized, markDirty]);

  const handleDeleteChapter = useCallback(async (chapterId: string) => {
    const s = stateRef.current;
    const book = s.books.find((b) => b.id === s.activeBookId);
    if (!book) return;
    const chapter = book.chapters.find((c) => c.id === chapterId);
    if (!chapter) return;

    setState((p) => ({
      ...p,
      books: p.books.map((b) => {
        if (b.id !== book.id) return b;
        const nextChapters = orderChaptersForDisplay(b.chapters.filter((c) => c.id !== chapterId));
        const nextCount =
          typeof b.chapterCount === "number" ? Math.max(0, b.chapterCount - 1) : nextChapters.length;
        return { ...b, chapters: nextChapters, chapterCount: nextCount };
      }),
    }));
    markDirty();

    try {
      await libraryDeleteChapter(book.id, chapterId);
    } catch (e: any) {
      console.warn("[TaleVox][Library] delete chapter failed", e);
    }

    try {
      await deleteCueMap(chapterId);
      await deleteParagraphMap(chapterId);
    } catch {}

    if (book.backend === StorageBackend.DRIVE && book.driveFolderId && isAuthorized) {
      const ids = new Set<string>();
      if (chapter.cloudTextFileId) ids.add(chapter.cloudTextFileId);
      if (chapter.cloudAudioFileId) ids.add(chapter.cloudAudioFileId);
      if (chapter.audioDriveId) ids.add(chapter.audioDriveId);
      for (const id of ids) {
        try {
          await moveFileToTrash(id);
        } catch (e) {
          console.warn("Drive delete failed", e);
        }
      }
      void syncBookInventoryToDrive(book);
    }
  }, [markDirty, isAuthorized]);

  const handleDeleteBookMeta = useCallback(async (id: string) => {
    try {
      await libraryDeleteBook(id);
    } catch (e: any) {
      console.error('[TaleVox][Library] delete failed', e);
    }
    setState(p => ({
      ...p,
      books: p.books.filter(b => b.id !== id),
      activeBookId: p.activeBookId === id ? undefined : p.activeBookId
    }));
    markDirty();
  }, [markDirty]);

  const handleCancelJob = useCallback(async (jobId: string) => {
    if (stateRef.current.backupInProgress) {
      pushNotice({ type: "info", message: "Backup/restore in progress. Try again when finished." });
      return;
    }
    try {
      await cancelJobService(jobId, state.readerSettings.uiMode);
      await refreshJobs();
    } catch (e: any) {
      pushNotice({ type: "error", message: `Cancel failed: ${String(e?.message ?? e)}` });
    }
  }, [refreshJobs, state.readerSettings.uiMode, pushNotice]);

  const handleRetryJob = useCallback(async (jobId: string) => {
    if (stateRef.current.backupInProgress) {
      pushNotice({ type: "info", message: "Backup/restore in progress. Try again when finished." });
      return;
    }
    try {
      await retryJobService(jobId, state.readerSettings.uiMode);
      await refreshJobs();
    } catch (e: any) {
      pushNotice({ type: "error", message: `Retry failed: ${String(e?.message ?? e)}` });
    }
  }, [refreshJobs, state.readerSettings.uiMode, pushNotice]);

  const handleDeleteJob = useCallback(async (jobId: string) => {
    if (stateRef.current.backupInProgress) {
      pushNotice({ type: "info", message: "Backup/restore in progress. Try again when finished." });
      return;
    }
    try {
      await deleteJobService(jobId, state.readerSettings.uiMode);
      await refreshJobs();
    } catch (e: any) {
      pushNotice({ type: "error", message: `Remove failed: ${String(e?.message ?? e)}` });
    }
  }, [refreshJobs, state.readerSettings.uiMode, pushNotice]);

  const handleRefreshSingleJob = useCallback(async (jobId: string) => {
    try {
      const job = await getJobById(jobId, state.readerSettings.uiMode);
      if (job) {
        setJobs(prev => {
          const idx = prev.findIndex(j => j.jobId === jobId);
          if (idx === -1) return prev;
          const copy = [...prev];
          copy[idx] = job;
          return copy;
        });
      } else {
        await refreshJobs();
      }
    } catch {
      await refreshJobs();
    }
  }, [refreshJobs, state.readerSettings.uiMode]);

  const handleForceStartJob = useCallback(async (jobId: string) => {
    if (stateRef.current.backupInProgress) {
      pushNotice({ type: "info", message: "Backup/restore in progress. Try again when finished." });
      return;
    }
    try {
      await forceStartJobService(jobId, state.readerSettings.uiMode);
      await refreshJobs();
    } catch (e: any) {
      pushNotice({ type: "error", message: `Force start failed: ${String(e?.message ?? e)}` });
    }
  }, [refreshJobs, state.readerSettings.uiMode, pushNotice]);

  const handleShowWorkInfo = useCallback(async (jobId: string) => {
    try {
      const info = await getWorkInfo(jobId, state.readerSettings.uiMode);
      alert(`WorkInfo for ${jobId}:\n${JSON.stringify(info, null, 2)}`);
    } catch (e: any) {
      pushNotice({ type: "error", message: `WorkInfo failed: ${String(e?.message ?? e)}` });
    }
  }, [state.readerSettings.uiMode, pushNotice]);

  const handleClearJobs = useCallback(async (statuses: string[]) => {
    try {
      await clearJobsService(statuses, state.readerSettings.uiMode);
      await refreshJobs();
    } catch {
      // ignore
    }
  }, [refreshJobs, state.readerSettings.uiMode]);

  const handleRegenerateCueMap = useCallback(async () => {
    const s = stateRef.current;
    const book = s.books.find(b => b.id === s.activeBookId);
    if (!book || !book.currentChapterId) return;
    const chapter = book.chapters.find(c => c.id === book.currentChapterId);
    if (!chapter) return;
    try {
      await deleteCueMap(chapter.id);
      setActiveCueMap(null);
      let built: CueMap | null = null;
      const rules = [...s.globalRules, ...book.rules];
      const isMarkdown =
        chapter.contentFormat === "markdown" ||
        (chapter.filename ?? "").toLowerCase().endsWith(".md");
      const textToSpeak = buildSpeakTextFromContent(
        chapter.content ?? "",
        isMarkdown,
        rules,
        !!s.readerSettings?.reflowLineBreaks
      );
      const rawIntro = `Chapter ${chapter.index}. ${chapter.title}. `;
      const introText = buildSpeakTextFromContent(
        rawIntro,
        false,
        rules,
        !!s.readerSettings?.reflowLineBreaks
      );
      const prefixLen = getEffectivePrefixLen(chapter, introText.length);
      const { chunkMap: normalizedChunkMap, introMsFromChunk } = normalizeChunkMapForChapter(
        chapter.audioChunkMap,
        textToSpeak.length,
        prefixLen
      );
      const introMs = computeIntroMs({
        audioIntroDurSec: chapter.audioIntroDurSec,
        audioPrefixLen: prefixLen,
        textLen: textToSpeak.length,
        durationMs: audioDuration > 0 ? Math.floor(audioDuration * 1000) : undefined,
        introMsFromChunk,
      });
      setCurrentIntroDurSec(introMs / 1000);
      if (normalizedChunkMap.length > 0) {
        built = cueMapFromChunkMap(chapter.id, normalizedChunkMap, introMs);
      } else if (textToSpeak.length > 0 && audioDuration > 0) {
        built = generateFallbackCueMap({
          chapterId: chapter.id,
          text: textToSpeak,
          durationMs: Math.floor(audioDuration * 1000),
          introOffsetMs: introMs,
        });
      } else if (textToSpeak.length > 0) {
        pendingCueFallbackRef.current = { chapterId: chapter.id, text: textToSpeak, prefixLen };
      }
      if (built) {
        await saveCueMap(chapter.id, built);
        setActiveCueMap(built);
        setCueMeta({ method: built.method, count: built.cues.length });
        pendingCueFallbackRef.current = null;
      }
    } catch (e) {
      console.warn("Regenerate cue map failed", e);
    }
  }, [audioDuration]);

  const handleToggleDownloadedChapters = useCallback(() => {
    setShowDownloadedChapters((prev) => !prev);
  }, []);

  const handleSyncLibraryToNativeDb = useCallback(async (opts?: { bookId?: string; chapterIds?: string[] }) => {
    const runId = ++nativeSyncRunRef.current;
    const isCancelled = () => nativeSyncRunRef.current !== runId;
    const s = stateRef.current;
    const chapterFilter = opts?.chapterIds && opts.chapterIds.length ? new Set(opts.chapterIds) : null;
    let books = 0;
    let chapters = 0;
    let texts = 0;
    let failures = 0;
    const missingFiles: string[] = [];
    const baseDir = appConfig.paths.textDir;

    const targetBooks = opts?.bookId
      ? s.books.filter((b) => b.id === opts.bookId)
      : s.books;

    if (computeMobileMode(s.readerSettings.uiMode)) {
      try {
        await Filesystem.mkdir({ path: baseDir, directory: Directory.Data, recursive: true });
      } catch {
        // ignore if exists
      }
    }

    const syncedChapterIds: string[] = [];

    for (const book of targetBooks) {
      if (isCancelled()) return { books, chapters, texts, failures, chapterTextRows: 0, missingFiles: missingFiles.length };
      try {
        await ensureNativeBook({
          id: book.id,
          title: book.title,
          author: book.author,
          coverImage: book.coverImage,
          backend: book.backend,
          driveFolderId: (book as any).driveFolderId,
          driveFolderName: (book as any).driveFolderName,
          currentChapterId: book.currentChapterId,
          settings: book.settings,
          rules: book.rules,
        });
        books += 1;
      } catch {
        failures += 1;
      }

      let chapterCounter = 0;
      for (const chapter of book.chapters) {
        if (isCancelled()) return { books, chapters, texts, failures, chapterTextRows: 0, missingFiles: missingFiles.length };
        if (chapterFilter && !chapterFilter.has(chapter.id)) continue;
        try {
          await ensureNativeChapter(book.id, {
            id: chapter.id,
            title: chapter.title ?? chapter.id,
            idx: chapter.index,
            sortOrder: getChapterSortOrder(chapter),
            filename: chapter.filename,
            sourceUrl: chapter.sourceUrl,
            cloudTextFileId: chapter.cloudTextFileId,
            cloudAudioFileId: chapter.cloudAudioFileId,
            audioDriveId: chapter.audioDriveId,
            audioStatus: chapter.audioStatus,
            audioSignature: chapter.audioSignature,
            durationSec: chapter.durationSec,
            textLength: chapter.textLength,
            wordCount: chapter.wordCount,
            isFavorite: chapter.isFavorite,
            updatedAt: chapter.updatedAt,
          });
          chapters += 1;
        } catch {
          failures += 1;
        }

        try {
          chapterCounter += 1;
          if (chapterCounter % 25 === 0) {
            await yieldToUi();
          }
          const content = await ensureChapterContentLoaded(
            book.id,
            chapter.id,
            chapterSessionRef.current
          );
          if (content == null) {
            failures += 1;
            continue;
          }
          let relPath: string | null = null;
          if (computeMobileMode(s.readerSettings.uiMode)) {
            relPath = `${baseDir}/${chapter.filename || `${chapter.id}.txt`}`;
            let needsWrite = true;
            try {
              const stat = await Filesystem.stat({ path: relPath, directory: Directory.Data });
              if (stat && typeof stat.size === "number" && stat.size > 0) {
                needsWrite = false;
              }
            } catch {
              needsWrite = true;
            }
            if (needsWrite) {
              try {
                await Filesystem.writeFile({
                  path: relPath,
                  directory: Directory.Data,
                  data: content,
                  encoding: Encoding.UTF8,
                });
              } catch {
                missingFiles.push(chapter.id);
              }
            }
          }
          await ensureNativeChapterText(book.id, chapter.id, content, relPath);
          texts += 1;
          syncedChapterIds.push(chapter.id);
        } catch {
          failures += 1;
        }
      }
    }

    let chapterTextRows = 0;
    let bookPresent = false;
    try {
      chapterTextRows = await getNativeChapterTextCount(syncedChapterIds);
      if (opts?.bookId) {
        const book = targetBooks[0];
        bookPresent = await hasNativeBook(opts.bookId, book?.driveFolderId);
      }
    } catch {
      chapterTextRows = 0;
    }
    console.log("[TaleVox][NativeSync]", {
      bookId: opts?.bookId,
      bookPresent,
      books,
      chapters,
      texts,
      failures,
      chapterTextRows,
      missingFiles,
    });

    return { books, chapters, texts, failures, chapterTextRows, missingFiles: missingFiles.length };
  }, [ensureChapterContentLoaded]);

  const handleToggleUploadQueue = useCallback(() => {
    setShowUploadQueue((prev) => !prev);
  }, []);

  const uploadedChapterCount = downloadedChapters.length;

  const handleAddBook = async (title: string, backend: StorageBackend, directoryHandle?: any, driveFolderId?: string, driveFolderName?: string) => {
      const newBook: Book = {
          id: driveFolderId || crypto.randomUUID(),
          title,
          backend,
          directoryHandle,
          driveFolderId,
          driveFolderName,
          chapters: [],
          rules: [],
          settings: normalizeBookSettings(),
          updatedAt: Date.now()
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
      const allChaptersForOrder = await loadAllChapterMeta(book.id).catch(() => book.chapters || []);
      const usedSortOrder = new Set<number>(
        allChaptersForOrder
          .map((chapter) => getChapterSortOrder(chapter))
          .filter((value) => Number.isFinite(value) && value > 0)
      );
      const parsedRequestedIndex =
        typeof data?.index === "string" ? Number.parseInt(data.index, 10) : Number(data?.index);
      let safeIndex =
        Number.isFinite(parsedRequestedIndex) && parsedRequestedIndex > 0
          ? Math.floor(parsedRequestedIndex)
          : computeNextSortOrder(allChaptersForOrder);
      while (usedSortOrder.has(safeIndex)) {
        safeIndex += 1;
      }
      const nextSortOrder = safeIndex;
      const safeTitle = normalizeChapterTitle(data.title, `Chapter ${safeIndex}`);
      const contentFormat: "text" | "markdown" = data.contentFormat === "markdown" ? "markdown" : "text";
      const stripLeadingTitleLine = (content: string, title: string): string => {
        const rawContent = String(content ?? "");
        const rawTitle = String(title ?? "").trim();
        if (!rawContent.trim() || !rawTitle) return rawContent;

        const normalize = (value: string) =>
          value
            .trim()
            .replace(/^#+\s*/, "")
            .replace(/^[\"'“”‘’]+|[\"'“”‘’]+$/g, "")
            .replace(/\s+/g, " ")
            .toLowerCase();

        const lines = rawContent.replace(/\r\n/g, "\n").split("\n");
        let firstContentLine = -1;
        for (let i = 0; i < lines.length; i += 1) {
          if (lines[i].trim().length > 0) {
            firstContentLine = i;
            break;
          }
        }
        if (firstContentLine === -1) return rawContent;

        const firstLine = lines[firstContentLine].replace(/^[-*]\s+/, "");
        if (normalize(firstLine) !== normalize(rawTitle)) return rawContent;

        lines.splice(firstContentLine, 1);
        if (firstContentLine < lines.length && lines[firstContentLine].trim().length === 0) {
          lines.splice(firstContentLine, 1);
        }
        const candidate = lines.join("\n");
        return candidate.trim().length > 0 ? candidate : rawContent;
      };
      const chapterContent = stripLeadingTitleLine(data.content, safeTitle);
      const volumeName =
        typeof data.volumeName === "string" && data.volumeName.trim().length
          ? data.volumeName.trim()
          : undefined;
      const volumeLocalChapter =
        Number.isFinite(data.volumeLocalChapter) && Number(data.volumeLocalChapter) > 0
          ? Number(data.volumeLocalChapter)
          : undefined;
      const newChapter: Chapter = {
          id: chapterId,
          index: safeIndex,
          sortOrder: nextSortOrder,
          title: safeTitle,
          sourceUrl:
            typeof data.sourceUrl === "string" && data.sourceUrl.trim().length
              ? data.sourceUrl.trim()
              : typeof data.url === "string" && data.url.trim().length
                ? data.url.trim()
                : undefined,
          content: chapterContent,
          contentFormat,
          volumeName,
          volumeLocalChapter,
          wordCount: 0,
          textLength: chapterContent.length,
          filename: buildTextName(book.id, chapterId, contentFormat),
          progress: 0,
          progressChars: 0,
          audioStatus: AudioStatus.PENDING,
          updatedAt: Date.now()
      };
      if (book.driveFolderId && isAuthorized) {
          try {
            const targetFolderId = await ensureChapterDriveStorageFolder(book.driveFolderId, newChapter);
            newChapter.cloudTextFileId = await uploadToDrive(targetFolderId, newChapter.filename, chapterContent);
            newChapter.hasTextOnDrive = true;
          } catch {}
      }
      await libraryUpsertChapterMeta(book.id, { ...newChapter, content: undefined });
      await librarySaveChapterText(book.id, newChapter.id, chapterContent);
      setState(p => ({
        ...p,
        books: p.books.map(b => {
          if (b.id !== book.id) return b;
          const nextChapters = orderChaptersForDisplay([...b.chapters, newChapter]);
          const nextCount =
            typeof b.chapterCount === "number"
              ? Math.max(b.chapterCount + 1, nextChapters.length)
              : nextChapters.length;
          return { ...b, chapters: nextChapters, chapterCount: nextCount };
        })
      }));
      markDirty();
      if (book.backend === StorageBackend.DRIVE && book.driveFolderId && isAuthorized) {
        void syncBookInventoryToDrive(book);
      }
      const isBulkImport = data?.url === "bulk-import";
      const shouldAutoGenerateAudio =
        !isBulkImport && book.settings?.autoGenerateAudioOnAdd !== false;
      const shouldAutoUploadAudio =
        book.backend === StorageBackend.DRIVE &&
        !!book.driveFolderId &&
        isAuthorized &&
        book.settings?.autoUploadOnAdd === true;

      if (shouldAutoGenerateAudio) {
        const updateChapterInState = (updated: Chapter) => {
          setState((prev) => ({
            ...prev,
            books: prev.books.map((b) =>
              b.id !== book.id
                ? b
                : {
                    ...b,
                    chapters: b.chapters.map((c) => (c.id === updated.id ? { ...c, ...updated } : c)),
                  }
            ),
          }));
        };

        const generatingChapter: Chapter = {
          ...newChapter,
          audioStatus: AudioStatus.GENERATING,
          updatedAt: Date.now(),
        };
        updateChapterInState(generatingChapter);
        await libraryUpsertChapterMeta(book.id, { ...generatingChapter, content: undefined });

        void (async () => {
          try {
            await generateAndPersistChapterAudio({
              book,
              chapter: generatingChapter,
              voiceId:
                book.settings?.defaultVoiceId ||
                book.settings?.selectedVoiceName ||
                "en-US-Standard-C",
              playbackSpeed:
                book.settings?.useBookSettings && book.settings?.playbackSpeed
                  ? book.settings.playbackSpeed
                  : 1.0,
              rules: [...(stateRef.current.globalRules || []), ...(book.rules || [])],
              reflowLineBreaksEnabled: stateRef.current.readerSettings.reflowLineBreaks,
              uiMode: stateRef.current.readerSettings.uiMode,
              isAuthorized,
              uploadToCloud: shouldAutoUploadAudio,
              loadChapterText: async () => chapterContent,
              onChapterUpdated: async (updated) => {
                updateChapterInState(updated);
              },
            });
            markDirty();
            if (shouldAutoUploadAudio && book.driveFolderId) {
              void syncBookInventoryToDrive(book);
            }
          } catch (e: any) {
            const failedChapter: Chapter = {
              ...generatingChapter,
              audioStatus: AudioStatus.FAILED,
              updatedAt: Date.now(),
            };
            updateChapterInState(failedChapter);
            await libraryUpsertChapterMeta(book.id, { ...failedChapter, content: undefined });
            pushNotice({ message: `Auto audio generation failed: ${String(e?.message ?? e)}`, type: "error" });
          }
        })();
      }
      if (!data.keepOpen) {
        setIsAddChapterOpen(false);
      } else if (!isBulkImport) {
        pushNotice({ message: "Added", type: 'success', ms: 1000 });
      }
  };

  const handleSelectRoot = async () => {
      setIsLinkModalOpen(true);
  };

  const listAllChapterMeta = useCallback(
    async (bookId: string): Promise<Chapter[]> => loadAllChapterMeta(bookId),
    [loadAllChapterMeta]
  );

  const repairOverwrittenChapterIndices = useCallback(async () => {
    const books = stateRef.current.books;
    if (!books.length) return;

    const updatesByBook = new Map<string, Chapter[]>();
    for (const book of books) {
      const chapters = await listAllChapterMeta(book.id);
      if (!chapters.length) continue;
      const now = Date.now();
      const repaired: Chapter[] = [];
      chapters.forEach((chapter, idx) => {
        const expectedSequential = idx + 1;
        const indexValue = Number(chapter.index);
        const sortOrder = Number(
          Number.isFinite(Number(chapter.sortOrder)) && Number(chapter.sortOrder) > 0
            ? chapter.sortOrder
            : getChapterSortOrder(chapter)
        );
        if (
          Number.isFinite(indexValue) &&
          indexValue === expectedSequential &&
          Number.isFinite(sortOrder) &&
          sortOrder > 0 &&
          sortOrder !== indexValue
        ) {
          repaired.push({
            ...chapter,
            index: Math.floor(sortOrder),
            updatedAt: now,
          });
        }
      });
      if (!repaired.length) continue;
      updatesByBook.set(book.id, repaired);
      await libraryBulkUpsertChapters(
        book.id,
        repaired.map((chapter) => ({
          chapter: { ...chapter, content: undefined },
          content: undefined,
        }))
      );
    }

    if (!updatesByBook.size) return;

    setState((prev) => {
      const nextBooks = prev.books.map((book) => {
        const updates = updatesByBook.get(book.id);
        if (!updates) return book;
        const byId = new Map(updates.map((chapter) => [chapter.id, chapter]));
        const merged = book.chapters.map((chapter) =>
          byId.has(chapter.id) ? { ...chapter, ...byId.get(chapter.id)! } : chapter
        );
        return { ...book, chapters: orderChaptersForDisplay(merged) };
      });
      return { ...prev, books: nextBooks };
    });
    markDirty();
  }, [listAllChapterMeta, markDirty]);

  useEffect(() => {
    if (bootstrapStatus !== "done" || didRepairIndicesRef.current) return;
    didRepairIndicesRef.current = true;
    void repairOverwrittenChapterIndices();
  }, [bootstrapStatus, repairOverwrittenChapterIndices]);

  const syncBookInventoryToDrive = async (book: Book): Promise<void> => {
    if (book.backend !== StorageBackend.DRIVE) return;
    if (!book.driveFolderId) return;
    if (!isAuthorized) return;
    try {
      const adapter = createDriveFolderAdapter();
      const root = { backend: "drive" as const, id: book.driveFolderId, name: book.driveFolderName ?? book.title };
      const metaFolder = await adapter.ensureFolder(root, "meta");
      const existingInventory = await adapter.findByName(metaFolder, "inventory.json");
      const chapters = await listAllChapterMeta(book.id);
      const inventory: InventoryManifest = {
        schemaVersion: "3.0",
        bookId: book.id,
        expectedTotal: chapters.length,
        chapters: chapters.map((c) => ({
          chapterId: c.id,
          idx: typeof c.index === "number" ? c.index : 0,
          title: typeof c.title === "string" ? c.title : "Imported Chapter",
          volumeName: (c as any).volumeName,
          volumeLocalChapter: (c as any).volumeLocalChapter,
           textName:
             c.filename ||
             buildTextName(book.id, c.id, c.contentFormat === "markdown" ? "markdown" : "text"),
          audioName: buildMp3Name(book.id, c.id),
        })),
      };
      await adapter.writeText(metaFolder, "inventory.json", JSON.stringify(inventory, null, 2), existingInventory);
    } catch (e) {
      console.warn("Drive inventory sync failed", e);
    }
  };

  const handleReindexChapters = useCallback(
    async (bookId: string) => {
      const s = stateRef.current;
      const book = s.books.find((b) => b.id === bookId);
      if (!book) {
        return { updated: 0, maxBefore: 0, maxAfter: 0 };
      }

      const result = await fixChapterOrdering(bookId, book.chapters || []);
      const repaired = result.chapters;

      setState((prev) => ({
        ...prev,
        books: prev.books.map((candidate) =>
          candidate.id === bookId
            ? {
                ...candidate,
                chapters: repaired,
                chapterCount:
                  typeof candidate.chapterCount === "number"
                    ? Math.max(candidate.chapterCount, repaired.length)
                    : repaired.length,
              }
            : candidate
        ),
      }));

      try {
        if (repaired.length) {
          await libraryBulkUpsertChapters(
            bookId,
            repaired.map((chapter) => ({ chapter: { ...chapter, content: undefined }, content: undefined }))
          );
        }
      } catch (e: any) {
        console.warn("[TaleVox][Library] reindex persist failed", e);
      }

      if (book.backend === StorageBackend.DRIVE && book.driveFolderId && isAuthorized) {
        void syncBookInventoryToDrive(book);
      }

      if (result.updated > 0) {
        markDirty();
      }

      return {
        updated: result.updated,
        maxBefore: result.maxBefore,
        maxAfter: result.maxAfter,
      };
    },
    [isAuthorized, markDirty, syncBookInventoryToDrive]
  );

  const performFullDriveSync = async (manual = false) => {
      const hasToken = !!authManager.getToken();
      if(!hasToken || !stateRef.current.driveRootFolderId) return;
      const runId = ++syncRunRef.current;
      const isCancelled = () => syncRunRef.current !== runId;
      setIsSyncing(true);
      updateDiagnostics({ lastSyncAttemptAt: Date.now(), lastSyncError: undefined });
      
      try {
         const s = stateRef.current;
         const { booksId, savesId, trashId } = await ensureRootStructure(s.driveRootFolderId);
         const driveBooks = await listFoldersInFolder(booksId);
         
         const updatedBooks = [...s.books];
         
         let bookCounter = 0;
         for (const db of driveBooks) {
             if (isCancelled()) return;
             const files = await listFilesInFolder(db.id);
             const rootFolders = files.filter(
               (f) => f.mimeType === "application/vnd.google-apps.folder"
             );
             const driveVolumeFolderNames = rootFolders
               .map((folder) => folder.name.trim())
               .filter((folderName) => {
                 const key = folderName.toLowerCase();
                 return folderName.length > 0 && !RESERVED_DRIVE_BOOK_FOLDER_NAMES.has(key);
               });
             const chapterScanFiles = [...files];
             const chapterFileVolumeHints = new Map<string, string>();
             const skipNestedFolders = new Set(["meta", "attachments", "trash"]);
             let nestedFolderCounter = 0;
             for (const folder of rootFolders) {
               if (isCancelled()) return;
               if (nestedFolderCounter % 5 === 0) {
                 await yieldToUi();
               }
               nestedFolderCounter += 1;
               const folderName = folder.name.trim();
               const folderKey = folderName.toLowerCase();
               if (!folderKey || skipNestedFolders.has(folderKey)) continue;
               try {
                 const nestedFiles = await listFilesInFolder(folder.id);
                 for (const nested of nestedFiles) {
                   chapterScanFiles.push(nested);
                   if (
                     nested.mimeType !== "application/vnd.google-apps.folder" &&
                     folderKey !== "text" &&
                     folderKey !== "audio"
                   ) {
                     chapterFileVolumeHints.set(nested.id, folderName);
                   }
                 }
               } catch (e) {
                 console.warn("Drive nested folder scan failed", folder.name, e);
               }
             }
             const existingBookIdx = updatedBooks.findIndex(b => b.driveFolderId === db.id);
             let driveCoverImage: string | undefined;
             const existingCover =
               existingBookIdx !== -1 ? updatedBooks[existingBookIdx].coverImage : undefined;
             if (!existingCover) {
               const coverFile = files.find((f) => f.name === "cover.jpg");
               if (coverFile) {
                 try {
                   const blob = await fetchDriveBinary(coverFile.id);
                   driveCoverImage = await blobToDataUrl(blob);
                 } catch (e) {
                   console.warn("Drive cover fetch failed", e);
                 }
               }
             }
             await yieldToUi();
              let inventoryById = new Map<
                string,
                {
                  idx?: number | null;
                  title?: string | null;
                  volumeName?: string | null;
                  volumeLocalChapter?: number | null;
                }
              >();
             let metaFolderId: string | null = null;
             let inventoryFileId: string | null = null;
             let inventoryLoaded = false;
             try {
               const metaFolder = files.find(
                 (f) => f.mimeType === "application/vnd.google-apps.folder" && f.name === "meta"
               );
               if (metaFolder) {
                 metaFolderId = metaFolder.id;
                 const metaFiles = await listFilesInFolder(metaFolder.id);
                 const invFile = metaFiles.find((f) => f.name === "inventory.json");
                 inventoryFileId = invFile?.id ?? null;
                 if (invFile) {
                   const rawInv = await fetchDriveFile(invFile.id);
                   const inventory = JSON.parse(rawInv) as InventoryManifest;
                   if (Array.isArray(inventory?.chapters)) {
                      inventoryById = new Map(
                        inventory.chapters
                          .map((c: any) => {
                            const chapterId =
                              c.chapterId ?? c.id ?? c.chapterID ?? c.chapter_id ?? null;
                            if (!chapterId) return null;
                            const rawIdx =
                              c.idx ??
                              c.index ??
                              c.chapterIndex ??
                              c.chapter_idx ??
                              c.legacy?.legacyIdx ??
                              c.legacyIdx ??
                              null;
                            const parsedIdx =
                              typeof rawIdx === "string" ? parseInt(rawIdx, 10) : rawIdx;
                            const idx =
                              Number.isFinite(parsedIdx) && parsedIdx > 0 ? Number(parsedIdx) : null;
                            const rawTitle =
                              c.title ??
                              c.name ??
                              c.chapterTitle ??
                              c.legacy?.title ??
                              null;
                            const title =
                              typeof rawTitle === "string" && rawTitle.trim().length
                                ? normalizeChapterTitle(rawTitle.trim())
                                : null;

                            const rawVolumeName =
                              c.volumeName ?? c.volume ?? c.book ?? c.group ?? null;
                            const volumeName =
                              typeof rawVolumeName === "string" && rawVolumeName.trim().length
                                ? rawVolumeName.trim()
                                : null;

                            const rawLocal =
                              c.volumeLocalChapter ?? c.localChapter ?? c.local ?? c.bookChapter ?? null;
                            const parsedLocal =
                              typeof rawLocal === "string" ? parseInt(rawLocal, 10) : rawLocal;
                            const volumeLocalChapter =
                              Number.isFinite(parsedLocal) && parsedLocal > 0
                                ? Number(parsedLocal)
                                : null;

                            return [chapterId, { idx, title, volumeName, volumeLocalChapter }] as const;
                          })
                          .filter(Boolean) as Array<[
                            string,
                            {
                              idx?: number | null;
                              title?: string | null;
                              volumeName?: string | null;
                              volumeLocalChapter?: number | null;
                            }
                          ]>
                      );
                      inventoryLoaded = inventoryById.size > 0;
                    }
                 }
               }
             } catch (e) {
               console.warn("Drive inventory load failed", e);
             }
             const chaptersMap = new Map<string, Partial<Chapter>>();
             const fallbackOrder = new Map<string, number>();
             let fallbackCounter = 1;
             let existingMetaById = new Map<string, Chapter>();
             const tombstoneBookId = existingBookIdx !== -1 ? updatedBooks[existingBookIdx].id : db.id;
             let tombstoneIds = new Set<string>();

             if (existingBookIdx !== -1) {
               try {
                 const existingBook = updatedBooks[existingBookIdx];
                 const existingMeta = await listAllChapterMeta(existingBook.id);
                 existingMetaById = new Map(existingMeta.map((c) => [c.id, c]));
               } catch {
                 // best-effort: fall back to in-memory data if the library fetch fails
                 const existingBook = updatedBooks[existingBookIdx];
                 existingMetaById = new Map(existingBook.chapters.map((c) => [c.id, c]));
               }
             }

             if (!inventoryLoaded && inventoryById.size === 0 && existingMetaById.size > 0) {
                inventoryById = new Map(
                  Array.from(existingMetaById.values()).map((c) => [
                    c.id,
                    {
                      idx: typeof c.index === "number" && c.index > 0 ? c.index : null,
                      title: typeof c.title === "string" && c.title.trim().length ? normalizeChapterTitle(c.title.trim()) : null,
                      volumeName:
                        typeof (c as any).volumeName === "string" && (c as any).volumeName.trim().length
                          ? (c as any).volumeName.trim()
                          : null,
                      volumeLocalChapter:
                        Number.isFinite((c as any).volumeLocalChapter) && Number((c as any).volumeLocalChapter) > 0
                          ? Number((c as any).volumeLocalChapter)
                          : null,
                    },
                  ])
                );
                if (manual && metaFolderId) {
                  try {
                   const bookIdForInv = existingBookIdx !== -1 ? updatedBooks[existingBookIdx].id : db.id;
                   const inventory: InventoryManifest = {
                     schemaVersion: "3.0",
                     bookId: bookIdForInv,
                      expectedTotal: existingMetaById.size,
                      chapters: Array.from(existingMetaById.values()).map((c) => ({
                        chapterId: c.id,
                        idx: typeof c.index === "number" ? c.index : 0,
                        title: typeof c.title === "string" ? c.title : "Imported Chapter",
                        volumeName: (c as any).volumeName,
                        volumeLocalChapter: (c as any).volumeLocalChapter,
                        textName:
                          c.filename ||
                          buildTextName(bookIdForInv, c.id, c.contentFormat === "markdown" ? "markdown" : "text"),
                        audioName: buildMp3Name(bookIdForInv, c.id),
                      })),
                   };
                   await uploadToDrive(
                     metaFolderId,
                     "inventory.json",
                     JSON.stringify(inventory, null, 2),
                     inventoryFileId || undefined,
                     "application/json"
                   );
                 } catch (e) {
                   console.warn("Drive inventory rebuild failed", e);
                 }
               }
             }
             
             try {
               const tombstones = await libraryListChapterTombstones(tombstoneBookId);
               tombstoneIds = new Set(tombstones.map((t) => t.chapterId));
               if (tombstoneIds.size && inventoryById.size) {
                 for (const id of tombstoneIds) inventoryById.delete(id);
               }
             } catch (e) {
               console.warn("[TaleVox][Library] tombstone lookup failed", e);
             }
             
             let fileCounter = 0;
             const latestTextByChapterId = new Map<string, number>();
             const latestAudioByChapterId = new Map<string, number>();
             for (const f of chapterScanFiles) {
                 if (isCancelled()) return;
                 if (fileCounter % 40 === 0) {
                   await yieldToUi();
                 }
                 fileCounter += 1;
                 // Support new c_<id> format
                  const match = f.name.match(/^c_(.*?)\.(txt|md|mp3)$/i);
                 if (match) {
                     const id = match[1];
                     if (tombstoneIds.has(id)) {
                       continue;
                     }
                     const ext = match[2].toLowerCase();
                     if (!fallbackOrder.has(id)) {
                       fallbackOrder.set(id, fallbackCounter++);
                     }
                     
                     if (!chaptersMap.has(id)) {
                         const existing = existingMetaById.get(id);
                         const invMeta = inventoryById.get(id);
                         const hintedVolumeName = chapterFileVolumeHints.get(f.id);
                         const invIdx = invMeta?.idx != null && invMeta.idx > 0 ? invMeta.idx : null;
                         const existingIdx = existing?.index != null && existing.index > 0 ? existing.index : null;
                         const fallbackIdx = fallbackOrder.get(id) ?? 0;
                         const invTitle =
                           invMeta?.title && invMeta.title !== "Imported Chapter"
                             ? invMeta.title
                             : null;
                          const title = normalizeChapterTitle(invTitle ?? existing?.title ?? invMeta?.title ?? "Imported Chapter");
                          const existingContent =
                            typeof existing?.content === "string" && existing.content.length > 0
                              ? existing.content
                              : undefined;
                          const base: Partial<Chapter> = {
                            id,
                            index: invIdx ?? existingIdx ?? fallbackIdx,
                            sortOrder:
                              invIdx ??
                              (existing ? getChapterSortOrder(existing) : null) ??
                              existingIdx ??
                              fallbackIdx,
                            title,
                            filename: existing?.filename ?? '',
                            volumeName:
                              (invMeta as any)?.volumeName ??
                              (existing as any)?.volumeName ??
                              hintedVolumeName,
                            volumeLocalChapter:
                              (invMeta as any)?.volumeLocalChapter != null
                                ? Number((invMeta as any).volumeLocalChapter)
                                : (existing as any)?.volumeLocalChapter,
                            wordCount: existing?.wordCount ?? 0,
                            progress: existing?.progress ?? 0,
                            progressChars: existing?.progressChars ?? 0,
                            updatedAt: existing?.updatedAt ?? Date.now()
                          };
                         if (existingContent) {
                           base.content = existingContent;
                           base.textLength = existing?.textLength ?? existingContent.length;
                         }
                         chaptersMap.set(id, base);
                     }
                     const ch = chaptersMap.get(id)!;
                     const modifiedAt = Date.parse(f.modifiedTime || "") || 0;
                     const hintedVolumeName = chapterFileVolumeHints.get(f.id);
                     if (!ch.volumeName && hintedVolumeName) {
                       ch.volumeName = hintedVolumeName;
                     }
                      if (ext === 'txt' || ext === 'md') {
                          const prevModified = latestTextByChapterId.get(id) ?? -1;
                          if (modifiedAt < prevModified) continue;
                          latestTextByChapterId.set(id, modifiedAt);
                          ch.cloudTextFileId = f.id;
                          ch.filename = f.name;
                          ch.contentFormat = ext === "md" ? "markdown" : "text";
                          ch.hasTextOnDrive = true;
                      } else {
                          const prevModified = latestAudioByChapterId.get(id) ?? -1;
                          if (modifiedAt < prevModified) continue;
                          latestAudioByChapterId.set(id, modifiedAt);
                          ch.cloudAudioFileId = f.id;
                          ch.audioStatus = AudioStatus.READY;
                      }
                 }
             }
             
             const driveChapters: Chapter[] = Array.from(chaptersMap.values())
                 .filter(c => (c.cloudTextFileId || c.cloudAudioFileId) && !tombstoneIds.has(String(c.id)))
                 .map(c => {
                     const sortOrder = getChapterSortOrder(c as Chapter);
                     const fallbackTitle =
                       Number.isFinite(sortOrder) && sortOrder > 0 ? `Chapter ${sortOrder}` : undefined;
                     return ({
                       ...c,
                       sortOrder,
                       id: c.id || crypto.randomUUID(),
                       title: normalizeChapterTitle(c.title, fallbackTitle),
                     } as Chapter);
                 });

             let driveAttachments: BookAttachment[] = [];
             try {
               const attachmentFolders = await listFoldersInFolder(db.id);
               const attachmentsFolder = attachmentFolders.find((f) => (f.name || "").toLowerCase() === "attachments");
               if (attachmentsFolder) {
                 const existingAttachments = await libraryListBookAttachments(db.id).catch(() => []);
                 const existingByDriveId = new Map<string, BookAttachment>();
                 for (const att of existingAttachments) {
                   if (att.driveFileId) existingByDriveId.set(att.driveFileId, att);
                 }
                 const attachmentFiles = await listFilesInFolder(attachmentsFolder.id);
                 driveAttachments = attachmentFiles
                   .filter((f) => {
                     const lower = (f.name || "").toLowerCase();
                     return f.mimeType === "application/pdf" || lower.endsWith(".pdf") || f.mimeType?.startsWith("image/");
                   })
                   .map((f) => {
                     const existing = existingByDriveId.get(f.id);
                     return {
                       id: existing?.id ?? f.id,
                       bookId: db.id,
                       driveFileId: f.id,
                       filename: f.name,
                       mimeType: f.mimeType,
                       sizeBytes: existing?.sizeBytes,
                       localPath: existing?.localPath,
                       sha256: existing?.sha256,
                       createdAt: existing?.createdAt ?? Date.now(),
                       updatedAt: Date.now(),
                     } as BookAttachment;
                   });
               }
             } catch (e) {
               console.warn("[Attachments] Drive sync failed", e);
             }

             if (existingBookIdx !== -1) {
                 const existingBook = updatedBooks[existingBookIdx];
                 const mergedChapters = [...existingBook.chapters].filter((c) => !tombstoneIds.has(c.id));
                 for (const meta of existingMetaById.values()) {
                   if (!mergedChapters.find((c) => c.id === meta.id)) {
                     mergedChapters.push(meta);
                   }
                 }
                 
                 for (const dc of driveChapters) {
                     const existingChIdx = mergedChapters.findIndex(ec => 
                         ec.id === dc.id || ec.cloudTextFileId === dc.cloudTextFileId
                     );
                     
                      if (existingChIdx !== -1) {
                           const existing = mergedChapters[existingChIdx];
                           const isPlaceholderTitle = !dc.title || dc.title === 'Imported Chapter';
                           const isPlaceholderIndex = !(typeof dc.index === 'number' && dc.index > 0);
                           const normalizedIncomingVolumeName =
                             typeof (dc as any).volumeName === "string" && (dc as any).volumeName.trim().length
                               ? (dc as any).volumeName.trim()
                               : undefined;
                           const normalizedExistingVolumeName =
                             typeof (existing as any).volumeName === "string" && (existing as any).volumeName.trim().length
                               ? (existing as any).volumeName.trim()
                               : undefined;
                           const normalizedIncomingVolumeLocalChapter =
                             Number.isFinite((dc as any).volumeLocalChapter) && Number((dc as any).volumeLocalChapter) > 0
                               ? Number((dc as any).volumeLocalChapter)
                               : undefined;
                           const normalizedExistingVolumeLocalChapter =
                             Number.isFinite((existing as any).volumeLocalChapter) && Number((existing as any).volumeLocalChapter) > 0
                               ? Number((existing as any).volumeLocalChapter)
                               : undefined;
                           let merged: Chapter = {
                               ...existing,
                               ...dc,
                               sortOrder: getChapterSortOrder(dc),
                               title: isPlaceholderTitle ? existing.title : dc.title,
                               index: isPlaceholderIndex ? existing.index : dc.index,
                               filename: isPlaceholderTitle && existing.filename ? existing.filename : dc.filename,
                               volumeName: normalizedIncomingVolumeName ?? normalizedExistingVolumeName,
                               volumeLocalChapter:
                                 normalizedIncomingVolumeLocalChapter ?? normalizedExistingVolumeLocalChapter,
                               progress: existing.progress,
                               progressSec: existing.progressSec,
                               isCompleted: existing.isCompleted
                           };
                           merged = preserveChapterContent(existing, merged, "driveSync");
                           mergedChapters[existingChIdx] = merged;
                      } else {
                         mergedChapters.push(dc);
                      }
                 }
                 const volumeOrder = buildVolumeOrderFromDriveSync(
                   existingBook.settings?.volumeOrder,
                   driveVolumeFolderNames,
                   mergedChapters
                 );
                 updatedBooks[existingBookIdx] = {
                   ...existingBook,
                   coverImage: existingBook.coverImage ?? driveCoverImage,
                   chapters: orderChaptersForDisplay(mergedChapters),
                   settings: normalizeBookSettings({
                     ...existingBook.settings,
                     volumeOrder,
                   }),
                   chapterCount:
                     typeof existingBook.chapterCount === "number"
                       ? Math.max(existingBook.chapterCount, mergedChapters.length)
                       : mergedChapters.length,
                 };
             } else {
                 const volumeOrder = buildVolumeOrderFromDriveSync([], driveVolumeFolderNames, driveChapters);
                 updatedBooks.push({
                     id: db.id,
                     title: db.name,
                     backend: StorageBackend.DRIVE,
                     driveFolderId: db.id,
                     driveFolderName: db.name,
                 coverImage: driveCoverImage,
                 chapters: orderChaptersForDisplay(driveChapters),
                 rules: [],
                 settings: normalizeBookSettings({ ...DEFAULT_BOOK_SETTINGS, volumeOrder }),
                 updatedAt: Date.now()
             });
             }
             // Persist Drive metadata so paging and restart keep correct titles/indices.
             try {
               const persistedBook =
                 existingBookIdx !== -1
                   ? updatedBooks[existingBookIdx]
                   : updatedBooks[updatedBooks.length - 1];
               if (persistedBook) {
                 await libraryUpsertBook({
                   ...persistedBook,
                   chapters: [],
                 });
                 if (driveChapters.length) {
                   const items = driveChapters.map((c) => ({
                     chapter: { ...c, content: undefined },
                     content: undefined,
                   }));
                   await libraryBulkUpsertChapters(persistedBook.id, items);
                 }
                 if (driveAttachments.length) {
                   await libraryBulkUpsertBookAttachments(persistedBook.id, driveAttachments);
                 }
               }
             } catch (e) {
               console.warn("Drive sync persist failed", e);
             }
             bookCounter += 1;
             if (bookCounter % 4 === 0) {
               await yieldToUi();
             }
         }
         if (isCancelled()) return;
         setState((p) => {
           const latestBookById = new Map(p.books.map((book) => [book.id, book] as const));
           const mergedBooks = updatedBooks.map((book) => {
             const latest = latestBookById.get(book.id);
             const latestVolumeOrder = latest?.settings?.volumeOrder;
             const syncVolumeOrder = book.settings?.volumeOrder;
             const mergedVolumeOrder = buildVolumeOrderFromDriveSync(
               latestVolumeOrder,
               Array.isArray(syncVolumeOrder) ? syncVolumeOrder : [],
               book.chapters
             );
             const mergedSettings = normalizeBookSettings({
               ...book.settings,
               ...latest?.settings,
               volumeOrder: mergedVolumeOrder,
             });
             return normalizeBookChapters({
               ...book,
               settings: mergedSettings,
             });
           });
           return {
             ...p,
             books: mergedBooks,
             driveSubfolders: { booksId, savesId, trashId },
           };
         });
         updateDiagnostics({ lastSyncSuccessAt: Date.now(), lastSyncError: undefined });
         const activeId = stateRef.current.activeBookId;
         if (activeId) {
           void loadMoreChapters(activeId, true);
         }
         if(manual) pushNotice({ message: "Sync Complete", type: 'success' });
      } catch (e: any) {
         updateDiagnostics({ lastSyncError: String(e?.message ?? e) });
         pushNotice({ message: "Sync Failed: " + e.message, type: 'error', ms: 0 });
         return;
      } finally {
         if (syncRunRef.current === runId) {
           setIsSyncing(false);
         }
      }
  };

  const restoreLatestSnapshotBeforeSync = useCallback(async (): Promise<boolean> => {
    const currentState = stateRef.current;
    if (!currentState.driveRootFolderId || !isAuthorized || !isOnline) return false;

    try {
      const restoreResult = await restoreFromDriveIfAvailable({
        rootFolderId: currentState.driveRootFolderId,
        lastSnapshotCreatedAt: readLocalSnapshotMeta().lastSnapshotCreatedAt,
      });
      if (!restoreResult.restored) return false;

      const attachmentLists = await Promise.all(
        currentState.books.map((book) => libraryListBookAttachments(book.id).catch(() => []))
      );
      const merged = applyFullSnapshot({
        snapshot: restoreResult.snapshot,
        currentState,
        currentAttachments: attachmentLists.flat(),
        currentJobs: jobs,
      });

      try {
        if (restoreResult.snapshot.readerProgress) {
          safeSetLocalStorage(
            "talevox_reader_progress",
            JSON.stringify(restoreResult.snapshot.readerProgress)
          );
        }
        if (restoreResult.snapshot.legacyProgressStore) {
          safeSetLocalStorage(
            PROGRESS_STORE_KEY,
            JSON.stringify(restoreResult.snapshot.legacyProgressStore)
          );
        }
      } catch {}

      for (const restoredBook of merged.state.books) {
        await libraryUpsertBook({
          ...restoredBook,
          chapters: [],
          directoryHandle: undefined,
        });
        if (restoredBook.chapters.length > 0) {
          await libraryBulkUpsertChapters(
            restoredBook.id,
            restoredBook.chapters.map((chapter) => ({
              chapter: { ...chapter, content: undefined },
              content: typeof chapter.content === "string" ? chapter.content : null,
            }))
          );
        }
      }

      if (merged.attachments.length) {
        const attachmentsByBook = new Map<string, BookAttachment[]>();
        for (const attachment of merged.attachments) {
          const list = attachmentsByBook.get(attachment.bookId) || [];
          list.push(attachment);
          attachmentsByBook.set(attachment.bookId, list);
        }
        for (const [bookId, items] of attachmentsByBook.entries()) {
          await libraryBulkUpsertBookAttachments(bookId, items);
        }
      }

      setState(merged.state);
      stateRef.current = merged.state;
      setJobs(merged.jobs);
      setIsDirty(false);
      return true;
    } catch (e) {
      console.warn("[Sync] pre-sync snapshot restore failed", e);
      return false;
    }
  }, [isAuthorized, isOnline, jobs, setJobs]);

  const handleSync = async (manual = false) => {
      if (manual) {
        await restoreLatestSnapshotBeforeSync();
      }
      const saved = await handleSaveState(true, false);
      if (!saved) return;
      await performFullDriveSync(manual);
  };
  performFullDriveSyncRef.current = performFullDriveSync;

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

  const handleLaunchSignIn = useCallback(async () => {
    setSignInError(null);
    setLaunchStage("splash");
    setLaunchMessage("Signing in...");
    try {
      await ensureValidToken(true);
      await runStartup();
    } catch (e: any) {
      setSignInError(e?.message || "Sign-in failed");
      setLaunchStage("signin");
    }
  }, [runStartup]);

  const handleContinueOffline = useCallback(() => {
    setLaunchStage("ready");
  }, []);

  const handleLibraryNavClick = useCallback(() => {
    if (activeTab === "library") return;
    setActiveTab("library");
  }, [activeTab]);

  const swipeStartRef = useRef<{ x: number; y: number; t: number } | null>(null);
  const handleTabSwipeStart = useCallback((e: React.TouchEvent<HTMLDivElement>) => {
    if (e.touches.length !== 1) return;
    const touch = e.touches[0];
    swipeStartRef.current = { x: touch.clientX, y: touch.clientY, t: Date.now() };
  }, []);

  const handleTabSwipeEnd = useCallback((e: React.TouchEvent<HTMLDivElement>) => {
    const start = swipeStartRef.current;
    swipeStartRef.current = null;
    if (!start || e.changedTouches.length !== 1) return;

    const touch = e.changedTouches[0];
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    const dt = Date.now() - start.t;

    if (dt > 600) return;
    if (Math.abs(dx) < 70 || Math.abs(dx) < Math.abs(dy) * 1.5) return;

    const swipedLeft = dx < 0;
    const swipedRight = dx > 0;

    if (activeTab === "rules") {
      if (swipedLeft) {
        setActiveTab("library");
      } else if (swipedRight) {
        setActiveTab("settings");
      }
      return;
    }

    if (activeTab === "library" || activeTab === "collection") {
      if (swipedRight) setActiveTab("rules");
      return;
    }

    if (activeTab === "settings") {
      if (swipedLeft) setActiveTab("rules");
    }
  }, [activeTab]);

  const handleReaderBack = useCallback(() => {
    const fallback = stateRef.current.activeBookId ? "collection" : "library";
    const target =
      navContextRef.current?.lastNonReaderViewType ??
      lastNonReaderTabRef.current ??
      fallback;
    setActiveTab(target);
  }, []);

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

  const refreshAttachmentsForBook = useCallback(async (bookId: string) => {
    try {
      const items = await libraryListBookAttachments(bookId);
      const statusEntries = await Promise.all(
        items.map(async (att) => [att.id, await attachmentExists(att.localPath)] as const)
      );
      setAttachmentsList(items);
      setAttachmentsBookId(bookId);
      setAttachmentsLocalStatus(Object.fromEntries(statusEntries));
    } catch (e: any) {
      console.warn("[Attachments] list failed", e);
      pushNotice({ message: "Failed to load attachments", type: "error" });
    }
  }, [pushNotice]);

  const handleOpenAttachments = useCallback(async () => {
    if (!activeBook) return;
    await refreshAttachmentsForBook(activeBook.id);
    setShowAttachments(true);
  }, [activeBook, refreshAttachmentsForBook]);

  const ensureDriveAttachmentsFolder = useCallback(async (driveFolderId: string) => {
    const folders = await listFoldersInFolder(driveFolderId);
    const existing = folders.find((f) => f.name?.toLowerCase() === "attachments");
    if (existing) return existing.id;
    return createDriveFolder("attachments", driveFolderId);
  }, []);

  const handleAddBookAttachment = useCallback(async () => {
    if (!activeBook) return;
    try {
      const adapter = getImportAdapter(state.readerSettings.uiMode);
      if (!adapter.pickAttachmentFiles) {
        pushNotice({ message: "Attachment picker not available", type: "error" });
        return;
      }
      const picks = await adapter.pickAttachmentFiles();
      if (!picks.length) return;
      const picked = picks[0];
      const filename = picked.name || `Attachment-${Date.now()}.pdf`;
      const mimeType = picked.mimeType || guessMimeType(filename);
      const bytes = await adapter.readBytes(picked);
      const saved = await saveAttachmentBytes(activeBook.id, filename, bytes);
      let driveFileId: string | undefined;

      if (activeBook.backend === StorageBackend.DRIVE && activeBook.driveFolderId) {
        if (!isAuthorized) {
          pushNotice({ message: "Drive not connected. Cannot upload attachment.", type: "error" });
        } else if (!isOnline) {
          pushNotice({ message: "Offline. Connect to upload attachment.", type: "info" });
        } else {
          const folderId = await ensureDriveAttachmentsFolder(activeBook.driveFolderId);
          const blob = new Blob([bytes as BlobPart], { type: mimeType });
          driveFileId = await uploadToDrive(folderId, filename, blob, undefined, mimeType);
        }
      }

      const now = Date.now();
      const attachment: BookAttachment = {
        id: crypto.randomUUID(),
        bookId: activeBook.id,
        driveFileId,
        filename,
        mimeType,
        sizeBytes: saved.sizeBytes,
        localPath: saved.localPath,
        createdAt: now,
        updatedAt: now,
      };
      await libraryUpsertBookAttachment(attachment);
      console.log("[Attachments] addAttachment success", { bookId: activeBook.id, filename });
      await refreshAttachmentsForBook(activeBook.id);
      pushNotice({ message: "Attachment added", type: "success" });
    } catch (e: any) {
      console.warn("[Attachments] addAttachment failed", e);
      pushNotice({ message: e?.message || "Failed to add attachment", type: "error" });
    }
  }, [activeBook, ensureDriveAttachmentsFolder, isAuthorized, isOnline, pushNotice, refreshAttachmentsForBook, state.readerSettings.uiMode]);

  const handleDownloadAttachment = useCallback(async (attachment: BookAttachment) => {
    if (!activeBook) return;
    if (!attachment.driveFileId) {
      pushNotice({ message: "Attachment missing Drive link", type: "error" });
      return;
    }
    if (!isAuthorized) {
      pushNotice({ message: "Drive disconnected", type: "error" });
      return;
    }
    if (!isOnline) {
      pushNotice({ message: "Offline. Connect to download.", type: "info" });
      return;
    }
    setAttachmentDownloads((p) => ({ ...p, [attachment.id]: true }));
    try {
      console.log("[Attachments] download start", { id: attachment.id, fileId: attachment.driveFileId });
      const blob = await fetchDriveBinary(attachment.driveFileId);
      const filename = attachment.filename || `Attachment-${attachment.id}.pdf`;
      const saved = await saveAttachmentBlob(activeBook.id, filename, blob);
      const updated: BookAttachment = {
        ...attachment,
        localPath: saved.localPath,
        sizeBytes: saved.sizeBytes,
        updatedAt: Date.now(),
      };
      await libraryUpsertBookAttachment(updated);
      console.log("[Attachments] download done", { id: attachment.id, bytes: saved.sizeBytes });
      await refreshAttachmentsForBook(activeBook.id);
    } catch (e: any) {
      console.warn("[Attachments] download failed", e);
      pushNotice({ message: e?.message || "Attachment download failed", type: "error" });
    } finally {
      setAttachmentDownloads((p) => ({ ...p, [attachment.id]: false }));
    }
  }, [activeBook, isAuthorized, isOnline, pushNotice, refreshAttachmentsForBook]);

  const handleOpenAttachment = useCallback(async (attachment: BookAttachment) => {
    const exists = await attachmentExists(attachment.localPath);
    if (!exists) {
      pushNotice({ message: "Attachment missing locally. Download it first.", type: "info" });
      return;
    }
    const uri = await resolveAttachmentUri(attachment.localPath);
    if (!uri) {
      pushNotice({ message: "Unable to open attachment", type: "error" });
      return;
    }
    setAttachmentViewer({ attachment, uri });
  }, [pushNotice]);

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
      showDiagnostics: state.showDiagnostics,
      backupSettings: state.backupSettings,
      lastBackupAt: state.lastBackupAt,
      lastBackupLocation: state.lastBackupLocation,
      lastBackupError: state.lastBackupError,
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
    state.showDiagnostics,
    state.backupSettings,
    state.lastBackupAt,
    state.lastBackupLocation,
    state.lastBackupError,
  ]);

  useEffect(() => {
    safeSetLocalStorage(PREFS_KEY, prefsJson);
  }, [prefsJson]);

  useEffect(() => {
    safeSetLocalStorage(BACKUP_SETTINGS_KEY, JSON.stringify(state.backupSettings || DEFAULT_BACKUP_SETTINGS));
  }, [state.backupSettings]);

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

  const shellThemeClass =
    state.theme === Theme.DARK
      ? "bg-slate-950 text-slate-100"
      : state.theme === Theme.SEPIA
      ? "bg-[#efe6d5] text-[#3c2f25]"
      : "bg-white text-slate-900";

  const diagnosticsNode = (
    <div className="fixed top-20 right-4 z-[1000] p-4 bg-black/80 backdrop-blur-md text-white text-[10px] font-mono rounded-xl shadow-2xl border border-white/10 pointer-events-none opacity-80">
      <div className="flex items-center gap-2 mb-2 border-b border-white/20 pb-1">
        <Terminal className="w-3 h-3 text-indigo-400" />
        <span className="font-bold">Playback Diagnostics {effectiveMobileMode ? '(Mobile)' : ''}</span>
      </div>
      <div>Phase: <span className="text-emerald-400">{playbackPhase}</span></div>
      <div>Session: {chapterSessionRef.current}</div>
      <div>Audio Time: {audioCurrentTime.toFixed(2)}s</div>
      <div>Duration: {audioDuration.toFixed(2)}s</div>
      <div>Blocked: {autoplayBlocked ? 'YES' : 'NO'}</div>
    </div>
  );

  if (launchStage === "splash") {
    return (
      <div className={`min-h-screen flex items-center justify-center ${shellThemeClass}`}>
        <div className="flex flex-col items-center gap-4">
          <div className="text-3xl font-black tracking-tight">TaleVox</div>
          <Loader2 className="w-7 h-7 animate-spin text-indigo-500" />
          <div className="text-[10px] font-black uppercase tracking-widest opacity-60">
            {launchMessage}
          </div>
        </div>
      </div>
    );
  }

  if (launchStage === "signin") {
    const hasLocalBooks = state.books.length > 0;
    return (
      <div className={`min-h-screen flex items-center justify-center ${shellThemeClass}`}>
        <div className={`w-full max-w-md rounded-[2rem] shadow-2xl p-8 space-y-6 ${state.theme === Theme.DARK ? "bg-slate-900 border border-white/10" : "bg-white border border-black/5"}`}>
          <div className="text-2xl font-black tracking-tight">TaleVox</div>
          <p className="text-xs font-bold opacity-60 leading-relaxed">
            Sign in to sync your library across devices.
          </p>
          {signInError && (
            <div className="text-xs font-bold text-red-400">
              {signInError}
            </div>
          )}
          <button
            onClick={handleLaunchSignIn}
            className="w-full py-4 bg-indigo-600 text-white rounded-2xl font-black uppercase text-[10px] tracking-widest shadow-xl hover:scale-[1.02] active:scale-95 transition-all"
          >
            Sign in with Google
          </button>
          {hasLocalBooks && (
            <button
              onClick={handleContinueOffline}
              className="w-full py-3 rounded-2xl border border-indigo-400 text-indigo-400 font-black uppercase text-[10px] tracking-widest hover:bg-indigo-500/10 transition-all"
            >
              Continue Offline
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <AppShell
      theme={state.theme}
      activeTab={activeTab}
      authStatus={authState.status}
      isAuthorized={isAuthorized}
      isSyncing={isSyncing}
      isDirty={isDirty}
      isLoadingChapter={isLoadingChapter}
      playbackPhase={playbackPhase}
      showDiagnostics={state.showDiagnostics}
      diagnosticsNode={diagnosticsNode}
      linkModal={isLinkModalOpen ? <LinkCloudModal /> : null}
      onOpenSidebar={() => setIsChapterSidebarOpen(true)}
      onLibraryNavClick={handleLibraryNavClick}
      onSetTab={setActiveTab}
      onReconnectDrive={handleReconnectDrive}
      onSync={() => handleSync(true)}
      onSaveState={() => handleSaveState(true, false)}
    >
        
        {isSyncing && (
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
              <Suspense fallback={<div className="p-6 text-xs font-black uppercase tracking-widest opacity-60 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Loading import tools...</div>}>
                <LazyExtractor 
                  onChapterExtracted={handleChapterExtracted} 
                  suggestedIndex={Math.max(
                    computeNextSortOrder(activeBook?.chapters || []),
                    Number(activeBook?.chapterCount || 0) + 1
                  )}
                  theme={state.theme} 
                  uiMode={state.readerSettings.uiMode}
                  defaultVoiceId={activeBook?.settings.defaultVoiceId} 
                  existingChapters={activeBook?.chapters || []}
                  existingVolumeNames={addChapterVolumeNames}
                />
              </Suspense>
            </div>
          </div>
        )}
        
        {activeTab === 'reader' && activeBook && (
          <div className="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden">
            <div className="flex-1 min-w-0 min-h-0 flex overflow-hidden">
              <aside className="hidden lg:block w-72 border-r border-black/5 bg-black/5 overflow-y-auto flex-shrink-0">
                <ChapterSidebar 
                  book={activeBook} theme={state.theme} onSelectChapter={handleSmartOpenChapter} 
                  onClose={() => {}} isDrawer={false}
                  isMobile={computeMobileMode(state.readerSettings.uiMode)}
                  playbackSnapshot={playbackSnapshot}
                  onLoadMoreChapters={() => void loadMoreChapters(activeBook.id, false)}
                  hasMoreChapters={chapterPagingByBook[activeBook.id]?.hasMore ?? true}
                  isLoadingMoreChapters={chapterPagingByBook[activeBook.id]?.loading ?? false}
                />
              </aside>
              <div className="flex-1 min-w-0 min-h-0 overflow-hidden flex flex-col">
                {activeBook && activeChapterMetadata && (
                  <Reader 
                    chapter={activeChapterMetadata} rules={[...state.globalRules, ...activeBook.rules]} theme={state.theme}
                    chapterText={activeChapterText}
                    speechText={activeSpeechText}
                    readerBlocks={activeReaderModel.blocks}
                    activeCueIndex={highlightEnabled ? activeCueIndex : null}
                    activeCueRange={highlightEnabled ? normalizedActiveCueRange : null}
                    activeParagraphIndex={highlightEnabled ? activeParagraphIndex : null}
                    paragraphMap={activeParagraphMap}
                    highlightReady={isCueReady}
                    highlightEnabled={highlightEnabled}
                    highlightDebugData={highlightDebugData}
                    cueMeta={cueMeta || undefined}
                    onRegenerateCueMap={handleRegenerateCueMap}
                    debugMode={state.debugMode} onToggleDebug={() => setState(p => ({ ...p, debugMode: !p.debugMode }))} onJumpToOffset={handleJumpToOffset}
                    onBackToCollection={handleReaderBack} onAddChapter={() => setIsAddChapterOpen(true)}
                    onOpenAttachments={handleOpenAttachments}
                    readerSettings={state.readerSettings}
                    initialScrollTop={readerInitialScrollTop}
                    onScrollPositionChange={handleReaderScroll}
                    isMobile={effectiveMobileMode}
                    isScrubbing={isScrubbing}
                    seekNudge={seekNudge}
                  />
                )}
              </div>
            </div>
            <div className="flex-shrink-0">
              <Player 
                isPlaying={isPlaying} onPlay={() => handleManualPlay()} onPause={handleManualPause} onStop={handleManualStop}
                onNext={() => handleNextChapterRef.current(false)} onPrev={handlePrevChapter} onSeek={handleSeekByDelta}
                speed={effectivePlaybackSpeedForUi}
                onSpeedChange={s => {
                  if (activeBook?.settings.useBookSettings) {
                    setState(p => ({
                      ...p,
                      books: p.books.map(b => b.id === activeBook.id
                        ? { ...b, settings: { ...b.settings, playbackSpeed: s } }
                        : b
                    )
                    }));
                  } else {
                    setState(p => ({ ...p, playbackSpeed: s }));
                  }
                  speechController.getPlaybackAdapter().setSpeed(s);
                  speechController.setPlaybackRate(s);
                }}
                selectedVoice={state.selectedVoiceName || ''} onVoiceChange={() => {}}
                theme={state.theme} onThemeChange={t => setState(p => ({ ...p, theme: t }))}
                readerSettings={state.readerSettings}
                onUpdateReaderSettings={patch => setState(p => ({ ...p, readerSettings: { ...p.readerSettings, ...patch } }))}
                progressChars={state.currentOffsetChars} totalLengthChars={activeSpeechText.length} wordCount={activeChapterMetadata?.wordCount || 0}
                onSeekToOffset={handleJumpToOffset}
                sleepTimer={sleepTimerSeconds} onSetSleepTimer={setSleepTimerSeconds}
                stopAfterChapter={stopAfterChapter} onSetStopAfterChapter={setStopAfterChapter}
                useBookSettings={activeBook?.settings.useBookSettings || false}
                onSetUseBookSettings={v => { if(activeBook) setState(p => ({ ...p, books: p.books.map(b => b.id === activeBook.id ? { ...b, settings: { ...b.settings, useBookSettings: v } } : b) })); }}
                playbackCurrentTime={audioCurrentTime} playbackDuration={audioDuration} isFetching={playbackPhase === 'LOADING_AUDIO' || playbackPhase === 'SEEKING' || playbackPhase === 'LOADING_TEXT'}
                onSeekToTime={handleScrubEnd} 
                autoplayBlocked={autoplayBlocked}
                onScrubStart={handleScrubStart}
                onScrubMove={handleScrubMove}
                onScrubEnd={handleScrubEnd}
                onScrubEndOffset={handleScrubEndOffset}
                isMobile={effectiveMobileMode}
                debugMode={state.debugMode}
              />
            </div>
          </div>
        )}

        {isChapterSidebarOpen && activeBook && (
          <div className="fixed inset-0 z-[60] flex">
            <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setIsChapterSidebarOpen(false)} />
            <div className={`relative w-[85%] max-sm max-w-sm h-full shadow-2xl animate-in slide-in-from-left duration-300 ${state.theme === Theme.DARK ? 'bg-slate-900' : state.theme === Theme.SEPIA ? 'bg-[#efe6d5]' : 'bg-white'}`}>
              <ChapterSidebar 
                book={activeBook} theme={state.theme} onSelectChapter={(id) => { handleSmartOpenChapter(id); setIsChapterSidebarOpen(false); }} 
                onClose={() => setIsChapterSidebarOpen(false)} isDrawer={true}
                isMobile={computeMobileMode(state.readerSettings.uiMode)}
                playbackSnapshot={playbackSnapshot}
                onLoadMoreChapters={() => void loadMoreChapters(activeBook.id, false)}
                hasMoreChapters={chapterPagingByBook[activeBook.id]?.hasMore ?? true}
                isLoadingMoreChapters={chapterPagingByBook[activeBook.id]?.loading ?? false}
              />
            </div>
          </div>
        )}

        {activeTab !== 'reader' && (
        <div
          className="flex-1 min-w-0 min-h-0 h-full overflow-y-hidden"
          onTouchStart={handleTabSwipeStart}
          onTouchEnd={handleTabSwipeEnd}
        >
          {activeTab === 'library' && (
            <Library 
              books={state.books} activeBookId={state.activeBookId}
              onSelectBook={id => {
                setState(p => ({ ...p, activeBookId: id }));
                updateNavContext({
                  bookId: id,
                  collectionScrollTop: 0,
                  chapterId: undefined,
                  chapterIndex: undefined,
                  scrollTop: 0,
                  lastViewType: "collection",
                  lastNonReaderViewType: "collection",
                });
                setActiveTab('collection');
                void loadMoreChapters(id, true);
              }} 
              onAddBook={handleAddBook}
              theme={state.theme}
              isCloudLinked={!!state.driveRootFolderId}
              onLinkCloud={handleSelectRoot}
            />
          )}
          
          {activeTab === 'collection' && activeBook && (
            <Suspense fallback={<div className="p-6 text-xs font-black uppercase tracking-widest opacity-60 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Loading chapters...</div>}>
              <LazyChapterFolderView 
                book={activeBook} theme={state.theme} onAddChapter={() => setIsAddChapterOpen(true)}
                onAddAttachment={handleAddBookAttachment}
                onOpenChapter={handleSmartOpenChapter}
                onToggleFavorite={() => {}}
                onUpdateChapterTitle={handleUpdateChapterTitle}
                onDeleteChapter={handleDeleteChapter}
                onUpdateChapter={handleUpdateChapter}
                onReindexChapters={() => handleReindexChapters(activeBook.id)}
                onUpdateBook={handleUpdateBookMeta}
                onDeleteBook={(id) => { handleDeleteBookMeta(id); setActiveTab('library'); }}
                onUpdateBookSettings={s => {
                  const currentBook =
                    stateRef.current.books.find((book) => book.id === activeBook.id) ?? activeBook;
                  const updatedBook = {
                    ...currentBook,
                    settings: normalizeBookSettings({ ...currentBook.settings, ...s }),
                  };
                  setState((p) => {
                    const next = {
                      ...p,
                      books: p.books.map((book) => (book.id === activeBook.id ? updatedBook : book)),
                    };
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
                jobs={jobs}
                uiMode={state.readerSettings.uiMode}
                onCancelJob={handleCancelJob}
                onRetryJob={handleRetryJob}
                onRefreshJobs={refreshJobs}
                isDirty={isDirty}
                isSyncing={isSyncing}
                onRegisterBackHandler={registerChapterBackHandler}
                lastSavedAt={state.lastSavedAt}
                restoreScrollTop={0}
                restoreChapterId={null}
                restoreChapterIndex={null}
                onScrollPositionChange={handleCollectionScroll}
                onQueueGenerateJob={async (chapterIds: string[], voiceId?: string) => {
                if (stateRef.current.backupInProgress) {
                  pushNotice({ message: "Backup/restore in progress. Try again when finished.", type: "info" });
                  return false;
                }
                if (!computeMobileMode(state.readerSettings.uiMode)) return false;
                if (jobRunnerAvailable && notificationStatus && !notificationStatus.granted) {
                  pushNotice({ message: "Enable notifications to run background jobs.", type: "error" });
                  setActiveTab('settings');
                  await refreshNotificationStatus();
                  return false;
                }
                const activeJobChapterIds = new Set<string>();
                for (const job of jobs) {
                  if (job.type !== "generateAudio") continue;
                  if (!["queued", "running", "paused"].includes(job.status)) continue;
                  const ids = (job as any)?.payloadJson?.chapterIds ?? [];
                  for (const id of ids) activeJobChapterIds.add(String(id));
                }
                const pendingChapterIds = chapterIds.filter((id) => !activeJobChapterIds.has(id));
                if (pendingChapterIds.length !== chapterIds.length) {
                  const skipped = chapterIds.length - pendingChapterIds.length;
                  pushNotice({ message: `Skipping ${skipped} already queued chapter(s).`, type: "info" });
                }
                if (!pendingChapterIds.length) return false;
                const voice =
                  voiceId ||
                  activeBook.settings.defaultVoiceId ||
                  activeBook.settings.selectedVoiceName ||
                  "en-US-Standard-C";
                const parsedVoice = parseTtsVoiceId(voice);
                const selectedChapters: Array<{
                  id: string;
                  title: string;
                  index?: number;
                  filename?: string;
                  sourceUrl?: string;
                  cloudTextFileId?: string;
                  cloudAudioFileId?: string;
                  audioDriveId?: string;
                  audioStatus?: string;
                  audioSignature?: string;
                  durationSec?: number;
                  textLength?: number;
                  wordCount?: number;
                  isFavorite?: boolean;
                  updatedAt?: number;
                  content?: string | null;
                  localPath?: string | null;
                }> = [];
                const chapterTextPaths: Record<string, string> = {};
                const chapterTextLocalPaths: Record<string, string> = {};
                const preparedChapterIds: string[] = [];
                const missingChapterIds: string[] = [];
                try {
                  await Filesystem.mkdir({
                    path: appConfig.paths.textDir,
                    directory: Directory.Data,
                    recursive: true,
                  });
                } catch {}
                for (const chapterId of pendingChapterIds) {
                  const chapter = activeBook.chapters.find((c) => c.id === chapterId);
                  if (!chapter) {
                    missingChapterIds.push(chapterId);
                    continue;
                  }
                  const content = await ensureChapterContentLoaded(
                    activeBook.id,
                    chapterId,
                    chapterSessionRef.current
                  );
                    if (content == null) {
                      const chapterTitle = chapter.title ?? chapterId;
                      const err = new MissingTextError(chapterId, activeBook.id, {
                        operation: "enqueueGenerateAudio",
                        chapterTitle,
                      });
                      jobLog.error("missing text", { chapterId, bookId: activeBook.id, title: chapterTitle });
                      pushNotice({
                        message: `Missing chapter text for "${chapterTitle}". Run Fix Integrity or re-import.`,
                        type: "error",
                      });
                      return false;
                    }
                  const relativePath = `${appConfig.paths.textDir}/${chapter.filename || `${chapter.id}.txt`}`;
                  let needsWrite = false;
                  try {
                    const stat = await Filesystem.stat({ path: relativePath, directory: Directory.Data });
                    const size = typeof (stat as any)?.size === "number" ? (stat as any).size : 0;
                    if (!size || size < 4) needsWrite = true;
                  } catch {
                    needsWrite = true;
                  }
                  if (needsWrite) {
                    await Filesystem.writeFile({
                      path: relativePath,
                      directory: Directory.Data,
                      data: content,
                      encoding: Encoding.UTF8,
                    });
                  }
                  chapterTextLocalPaths[chapter.id] = relativePath;
                  // Keep a relative path so the worker can resolve it via getFilesDir().
                  chapterTextPaths[chapter.id] = relativePath;
                  preparedChapterIds.push(chapter.id);
                  selectedChapters.push({
                    id: chapter.id,
                    title: chapter.title ?? chapter.id,
                    index: chapter.index,
                    filename: chapter.filename,
                    sourceUrl: chapter.sourceUrl,
                    cloudTextFileId: chapter.cloudTextFileId,
                    cloudAudioFileId: chapter.cloudAudioFileId,
                    audioDriveId: chapter.audioDriveId,
                    audioStatus: chapter.audioStatus,
                    audioSignature: chapter.audioSignature,
                    durationSec: chapter.durationSec,
                    textLength: chapter.textLength,
                    wordCount: chapter.wordCount,
                    isFavorite: chapter.isFavorite,
                    updatedAt: chapter.updatedAt,
                    content,
                    localPath: relativePath,
                  });
                }
                if (missingChapterIds.length) {
                  pushNotice({
                    message: `Missing chapters in current book: ${missingChapterIds.length}`,
                    type: "error",
                  });
                  return false;
                }
                if (!preparedChapterIds.length) {
                  pushNotice({ message: "No chapters ready to generate.", type: "error" });
                  return false;
                }
                const correlationId = createCorrelationId("gen");
                const payload = {
                  bookId: activeBook.id,
                  chapterIds: preparedChapterIds,
                  voice: { id: parsedVoice.id, provider: parsedVoice.provider },
                  settings: {
                    playbackSpeed: activeBook.settings.useBookSettings
                      ? activeBook.settings.playbackSpeed ?? 1.0
                      : 1.0,
                  },
                  driveFolderId: (activeBook as any).driveFolderId,
                  chapterTextPaths,
                  correlationId,
                };

                const preparedIdSet = new Set(preparedChapterIds.map((id) => String(id)));
                const prevAudioStatusById = new Map<string, AudioStatus | undefined>();
                for (const id of preparedIdSet) {
                  const ch = activeBook.chapters.find((c) => c.id === id);
                  prevAudioStatusById.set(id, ch?.audioStatus);
                }

                const updateAudioStatusForPrepared = async (nextStatusById: Map<string, AudioStatus | undefined>) => {
                  const updatedAt = Date.now();
                  setState((prev) => ({
                    ...prev,
                    books: prev.books.map((b) =>
                      b.id !== activeBook.id
                        ? b
                        : {
                            ...b,
                            chapters: b.chapters.map((c) => {
                              if (!preparedIdSet.has(c.id)) return c;
                              const nextStatus = nextStatusById.get(c.id);
                              return {
                                ...c,
                                audioStatus: nextStatus,
                                updatedAt,
                              };
                            }),
                          }
                    ),
                  }));
                  try {
                    const items = activeBook.chapters
                      .filter((c) => preparedIdSet.has(c.id))
                      .map((c) => ({
                        chapter: {
                          ...c,
                          audioStatus: nextStatusById.get(c.id),
                          updatedAt,
                          content: undefined,
                        },
                        content: null,
                      }));
                    await libraryBulkUpsertChapters(activeBook.id, items);
                  } catch (e) {
                    console.warn("[Jobs] Failed to persist optimistic audio status", e);
                  }
                };

                let didSetGenerating = false;
                try {
                  jobLog.info("enqueueGenerateAudio", {
                    correlationId,
                    bookId: activeBook.id,
                    chapters: preparedChapterIds.length,
                  });
                  const runPreflight = async () => {
                    const missingFiles: string[] = [];
                     for (const id of preparedChapterIds) {
                       const chapter = selectedChapters.find((c) => c.id === id);
                       const filename = chapter?.filename || `${id}.txt`;
                       const relPath = chapterTextLocalPaths[id] || `${appConfig.paths.textDir}/${filename}`;
                       try {
                         const stat = await Filesystem.stat({ path: relPath, directory: Directory.Data });
                         const size = typeof (stat as any)?.size === "number" ? (stat as any).size : 0;
                        if (!size || size < 4) missingFiles.push(id);
                      } catch {
                        missingFiles.push(id);
                      }
                    }
                    return { missingFiles };
                  };
                  let preflight = await runPreflight();
                    if (preflight.missingFiles.length) {
                      jobLog.warn("preflight.missingFiles", preflight);
                       for (const id of preflight.missingFiles) {
                         const ch = selectedChapters.find((c) => c.id === id);
                         if (!ch || typeof ch.content !== "string" || !ch.content.length) continue;
                       const filename = ch.filename || `${id}.txt`;
                       const relPath = chapterTextLocalPaths[id] || ch.localPath || `${appConfig.paths.textDir}/${filename}`;
                       try {
                         await Filesystem.writeFile({
                           path: relPath,
                          directory: Directory.Data,
                          data: ch.content,
                          encoding: Encoding.UTF8,
                        });
                      } catch (e) {
                        jobLog.warn("preflight.writeFailed", { id, err: String((e as any)?.message ?? e) });
                      }
                    }
                    preflight = await runPreflight();
                  }
                  if (preflight.missingFiles.length) {
                    const details = `${preflight.missingFiles.length} text files missing`;
                    jobLog.warn("preflight.failed", preflight);
                    pushNotice({
                      message: `Cannot start job: ${details}`,
                      type: "error",
                    });
                    return false;
                  }

                  // Flip UI immediately so users can see the job is queued/running.
                  didSetGenerating = true;
                  const generatingById = new Map<string, AudioStatus | undefined>();
                  for (const id of preparedIdSet) generatingById.set(id, AudioStatus.GENERATING);
                  await updateAudioStatusForPrepared(generatingById);

                  await enqueueGenerateAudio(payload, state.readerSettings.uiMode);
                  await refreshJobs();
                  pushNotice({ message: "Background job queued.", type: "success" });
                  return true;
                  } catch (e: any) {
                    if (didSetGenerating) {
                      await updateAudioStatusForPrepared(prevAudioStatusById);
                    }
                    const msg = toUserMessage(e);
                    const causeMsg = String((e as any)?.cause?.message ?? (e as any)?.cause ?? "");
                    const notifDenied =
                      msg.includes("notifications_not_granted") || causeMsg.includes("notifications_not_granted");
                    if (notifDenied) {
                      pushNotice({ message: "Enable notifications to run background jobs.", type: "error" });
                      setActiveTab('settings');
                      await refreshNotificationStatus();
                    } else {
                    pushNotice({ message: `Failed to queue job: ${msg}`, type: "error" });
                  }
                  return false;
                }
              }}
                onSyncNativeLibrary={handleSyncLibraryToNativeDb}
                onAppendChapters={(newChapters) => {
                setState((prev) => ({
                  ...prev,
                  books: prev.books.map((b) => {
                    if (b.id !== activeBook.id) return b;

                    const merged = new Map<string, Chapter>();
                    for (const existing of b.chapters || []) {
                      merged.set(existing.id, existing);
                    }
                    for (const incoming of newChapters) {
                      const existing = merged.get(incoming.id);
                      if (!existing) {
                        merged.set(incoming.id, {
                          ...incoming,
                          sortOrder: getChapterSortOrder(incoming),
                        });
                        continue;
                      }
                      const incomingTitle =
                        typeof incoming.title === "string" && incoming.title.trim().length
                          ? incoming.title.trim()
                          : "";
                      const existingTitle =
                        typeof existing.title === "string" && existing.title.trim().length
                          ? existing.title.trim()
                          : "";
                      const preferIncomingTitle =
                        incomingTitle.length > 0 && !incomingTitle.toLowerCase().startsWith("imported");
                      const incomingIndex =
                        typeof incoming.index === "number" && incoming.index > 0 ? incoming.index : null;
                      const existingIndex =
                        typeof existing.index === "number" && existing.index > 0 ? existing.index : null;
                      merged.set(incoming.id, {
                        ...existing,
                        ...incoming,
                        sortOrder: getChapterSortOrder(incoming),
                        title: preferIncomingTitle ? incomingTitle : existingTitle || incomingTitle,
                        index: incomingIndex ?? existingIndex ?? incoming.index ?? existing.index,
                      });
                    }

                    const deduped = orderChaptersForDisplay(Array.from(merged.values()));

                    return {
                      ...b,
                      chapters: deduped,
                      chapterCount:
                        typeof b.chapterCount === "number"
                          ? Math.max(b.chapterCount, deduped.length)
                          : deduped.length,
                    };
                  }),
                }));

                markDirty();
              }}
              uploadQueueCount={uploadQueueCount}
              onToggleUploadQueue={handleToggleUploadQueue}
              onUploadAllChapters={handleUploadAllChapters}
              onQueueChapterUpload={handleQueueChapterUpload}
              uploadedChapterCount={uploadedChapterCount}
              isUploadingAll={isUploadingAll}
              />
            </Suspense>
          )}

          {activeTab === 'rules' && (
            <Suspense fallback={<div className="p-6 text-xs font-black uppercase tracking-widest opacity-60 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Loading rules...</div>}>
              <LazyRuleManager 
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
            </Suspense>
          )}

          {activeTab === 'settings' && (
            <Suspense fallback={<div className="p-6 text-xs font-black uppercase tracking-widest opacity-60 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Loading settings...</div>}>
              <LazySettings 
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
                onUpdateGoogleClientId={id => { setState(p => ({ ...p, googleClientId: id })); authManager.init(id); }}
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
                jobs={jobs}
                onRefreshJobs={refreshJobs}
                onCancelJob={handleCancelJob}
                onRetryJob={handleRetryJob}
                onDeleteJob={handleDeleteJob}
                onClearJobs={handleClearJobs}
                logJobs={logJobs}
                onToggleLogJobs={setLogJobs}
                notificationStatus={notificationStatus}
                jobRunnerAvailable={jobRunnerAvailable}
                onRequestNotifications={handleRequestNotifications}
                onOpenNotificationSettings={handleOpenNotificationSettings}
                onSendTestNotification={handleSendTestNotification}
                onRefreshNotificationStatus={refreshNotificationStatus}
                onRefreshJob={handleRefreshSingleJob}
                onForceStartJob={handleForceStartJob}
                onShowWorkInfo={handleShowWorkInfo}
                diagnosticsReport={diagnosticsReport}
                onRefreshDiagnostics={refreshDiagnostics}
                onSaveDiagnostics={handleSaveDiagnostics}
                backupOptions={backupOptions}
                onUpdateBackupOptions={(patch) => setBackupOptions((prev) => ({ ...prev, ...patch }))}
                backupInProgress={state.backupInProgress === true}
                backupProgress={backupProgress}
                onBackupToDrive={handleBackupToDriveZip}
                onBackupToDevice={handleBackupToDeviceZip}
                onRestoreFromFile={handleRestoreFromFileZip}
                onLoadDriveBackups={handleLoadDriveBackupCandidates}
                onRestoreFromDriveBackup={handleRestoreFromDriveBackup}
                driveBackupCandidates={driveBackupCandidates}
                backupSettings={state.backupSettings}
                onUpdateBackupSettings={(patch) =>
                  setState((p) => ({
                    ...p,
                    backupSettings: { ...(p.backupSettings || DEFAULT_BACKUP_SETTINGS), ...patch },
                  }))
                }
              />
            </Suspense>
          )}
        </div>
        )}
      {showUploadQueue && (
      <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/60 p-4">
        <div className="w-full max-w-3xl bg-slate-950 text-white rounded-3xl p-6 space-y-4 shadow-2xl">
          <div className="flex items-center justify-between">
            <div className="text-lg font-black uppercase tracking-widest">Offline uploads</div>
            <button onClick={() => setShowUploadQueue(false)} className="text-sm font-bold uppercase tracking-widest text-indigo-300 px-3 py-1 border border-indigo-300 rounded-full">Close</button>
          </div>
          <div className="space-y-4 max-h-[70vh] overflow-y-auto pr-2">
            <div className="space-y-2">
              <div className="flex items-center justify-between text-[10px] font-black uppercase tracking-widest">
                <span>Downloaded chapters</span>
                <span className="text-emerald-300">{uploadedChapterCount}</span>
              </div>
              {downloadedChapters.length === 0 ? (
                <div className="text-sm font-black opacity-60 text-emerald-300">No offline chapters</div>
              ) : (
                <div className="space-y-3">
                  {downloadedChapters.map((chapter) => (
                    <div key={chapter.id} className="border border-emerald-500/30 rounded-2xl p-4 bg-emerald-500/5 flex flex-col gap-1">
                      <div className="text-[11px] font-black uppercase tracking-widest text-emerald-400">Offline ready</div>
                      <div className="flex items-center justify-between text-sm font-semibold">
                        <span>Ch. {chapter.index}</span>
                        <span className="text-[10px] uppercase opacity-60">{chapter.hasDriveAudio ? 'Cloud copy present' : 'Offline only'}</span>
                      </div>
                      <div className="text-[12px] font-semibold">{chapter.title || "Untitled chapter"}</div>
                      <div className="text-[10px] opacity-60 break-words">{chapter.localPath}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between text-[10px] font-black uppercase tracking-widest">
                <span>Pending uploads</span>
                <span className="text-indigo-300">{uploadQueueCount}</span>
              </div>
              <div className="space-y-3 max-h-[40vh] overflow-y-auto">
                {uploadQueueItems.length === 0 ? (
                  <div className="text-sm font-black opacity-60 text-indigo-300">No pending uploads</div>
                ) : (
                  uploadQueueItems.map((item) => (
                    <div key={item.id} className="border border-white/10 rounded-2xl p-4 bg-slate-900/70 flex flex-col gap-2">
                      <div className="text-[11px] font-black uppercase tracking-widest text-indigo-400">{item.status}</div>
                      <div className="flex items-center justify-between text-sm font-semibold">{item.chapterId}</div>
                      <div className="text-[10px] opacity-60 flex flex-wrap gap-4">
                        <span>Attempts: {item.attempts}</span>
                        <span>Next try: {item.nextAttemptAt ? new Date(item.nextAttemptAt).toLocaleString() : 'now'}</span>
                      </div>
                      {item.lastError && <div className="text-[10px] text-red-400 font-mono break-words">{item.lastError}</div>}
                      <div className="flex gap-2 justify-end">
                        <button
                          onClick={() => handleDismissQueuedUpload(item.id)}
                          className="text-[10px] font-black uppercase tracking-widest text-red-300 px-3 py-1 border border-red-300/40 rounded-full hover:bg-red-300/10"
                        >
                          Remove
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
      )}
      {showAttachments && (
        <div className="fixed inset-0 z-[130] flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-3xl bg-slate-950 text-white rounded-3xl p-6 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between">
              <div className="text-lg font-black uppercase tracking-widest">Attachments</div>
              <button
                onClick={() => { setShowAttachments(false); setAttachmentViewer(null); }}
                className="text-sm font-bold uppercase tracking-widest text-indigo-300 px-3 py-1 border border-indigo-300 rounded-full"
              >
                Close
              </button>
            </div>
            {attachmentsList.length === 0 ? (
              <div className="text-sm font-black opacity-60 text-indigo-300">No attachments yet</div>
            ) : (
              <div className="space-y-3 max-h-[70vh] overflow-y-auto pr-2">
                {attachmentsList.map((att) => {
                  const localReady = attachmentsLocalStatus[att.id] ?? false;
                  const isDownloading = attachmentDownloads[att.id] ?? false;
                  return (
                    <div key={att.id} className="border border-white/10 rounded-2xl p-4 bg-slate-900/70 flex flex-col gap-2">
                      <div className="flex items-center justify-between text-sm font-semibold">
                        <span className="truncate">{att.filename}</span>
                        <span className="text-[10px] uppercase opacity-60">{formatBytes(att.sizeBytes)}</span>
                      </div>
                      <div className="text-[10px] uppercase opacity-60">{att.mimeType || "unknown"}</div>
                      {localReady ? (
                        <div className="text-[10px] text-emerald-300 uppercase font-black tracking-widest">Ready offline</div>
                      ) : (
                        <div className="text-[10px] text-amber-300 uppercase font-black tracking-widest">Not downloaded</div>
                      )}
                      <div className="flex gap-2 justify-end">
                        {localReady ? (
                          <button
                            onClick={() => handleOpenAttachment(att)}
                            className="text-[10px] font-black uppercase tracking-widest text-indigo-300 px-3 py-1 border border-indigo-300/40 rounded-full hover:bg-indigo-300/10"
                          >
                            Open
                          </button>
                        ) : (
                          <button
                            onClick={() => handleDownloadAttachment(att)}
                            disabled={isDownloading}
                            className={`text-[10px] font-black uppercase tracking-widest px-3 py-1 rounded-full border ${
                              isDownloading ? "text-slate-400 border-slate-600 cursor-not-allowed" : "text-indigo-300 border-indigo-300/40 hover:bg-indigo-300/10"
                            }`}
                          >
                            {isDownloading ? "Downloading..." : "Download"}
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
      {attachmentViewer && (
        <div className="fixed inset-0 z-[140] flex items-center justify-center bg-black/70 p-4">
          <div className="w-full max-w-4xl bg-slate-950 text-white rounded-3xl p-4 space-y-3 shadow-2xl">
            <div className="flex items-center justify-between">
              <div className="text-sm font-black uppercase tracking-widest truncate">{attachmentViewer.attachment.filename}</div>
              <button
                onClick={() => setAttachmentViewer(null)}
                className="text-sm font-bold uppercase tracking-widest text-indigo-300 px-3 py-1 border border-indigo-300 rounded-full"
              >
                Close
              </button>
            </div>
            <div className="w-full h-[70vh] bg-black rounded-2xl overflow-hidden">
              {attachmentViewer.attachment.mimeType?.startsWith("image/") ? (
                <img src={attachmentViewer.uri} alt={attachmentViewer.attachment.filename} className="w-full h-full object-contain" />
              ) : (
                <iframe title="Attachment" src={attachmentViewer.uri} className="w-full h-full" />
              )}
            </div>
          </div>
        </div>
      )}
    </AppShell>
  );
};

export { handleAndroidBackPriority };
export default App;
