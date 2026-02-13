import React, { useMemo, useState, useEffect, useCallback, useRef } from 'react';
import { Book, Theme, StorageBackend, Chapter, AudioStatus, CLOUD_VOICES, ScanResult, StrayFile, Rule, UiMode, JobRecord } from '../types';
import { LayoutGrid, AlignJustify, Eye, Plus, Edit2, RefreshCw, Trash2, Headphones, Loader2, Cloud, CloudOff, AlertTriangle, X, RotateCcw, ChevronLeft, Image as ImageIcon, Search, FileX, AlertCircle, Wrench, Check, History, Trash, ChevronDown, ChevronUp, Settings as GearIcon, Sparkles, CheckSquare, Repeat2, MoreVertical, GripVertical, FolderSync } from 'lucide-react';
import { hasAudioInCache } from '../services/audioCache';
import { getChapterAudioPath } from '../services/chapterAudioStore';
import {
  uploadToDrive,
  listFilesInFolder,
  createDriveFolder,
  findFileSync,
  moveFile,
  moveFileToTrash,
  fetchDriveFile,
  copyDriveFile
} from "../services/driveService";
import { isTokenValid } from '../services/driveAuth';
import { reflowLineBreaks } from '../services/textFormat';
import { computeMobileMode } from '../utils/platform';
import { parseTtsVoiceId } from '../utils/ttsVoice';
import { yieldToUi } from '../utils/async';
import { enqueueGenerateAudio, enqueueFixIntegrity } from '../services/jobRunnerService';
import { generateAndPersistChapterAudio } from '../services/chapterAudioService';
import {
  loadChapterText as libraryLoadChapterText,
  bulkUpsertChapters as libraryBulkUpsertChapters,
  listChaptersPage as libraryListChaptersPage
} from "../services/libraryStore";
import { initBookFolderManifests } from "../services/bookFolderInit";
import { createDriveFolderAdapter } from "../services/driveFolderAdapter";
import type { InventoryManifest } from "../services/bookManifests";
import {
  fixChapterOrdering,
  getChapterSortOrder,
  normalizeChapterOrder,
} from "../services/chapterOrderingService";

type ViewMode = 'sections' | 'grid';
type ViewScrollState = { sections: number; grid: number };
const LONG_PRESS_MS = 450;
const LONG_PRESS_MOVE_THRESHOLD_PX = 10;

type LegacyGroup = {
  legacyIndex: number;
  slug: string;
  text?: StrayFile;
  audio?: StrayFile;
};

interface ChapterFolderViewProps {
  book: Book;
  theme: Theme;
  globalRules: Rule[];
  reflowLineBreaksEnabled: boolean;
  uiMode: UiMode;
  jobs: JobRecord[];
  onCancelJob: (jobId: string) => void;
  onRetryJob: (jobId: string) => void;
  onRefreshJobs: () => void;
  onUpdateBook: (book: Book) => void;
  onDeleteBook: (bookId: string) => void;
  onAddChapter: () => void;
  onOpenChapter: (chapterId: string) => void;
  onToggleFavorite: (chapterId: string) => void;
  uploadQueueCount: number;
  onToggleUploadQueue: () => void;
  onUploadAllChapters: () => void;
  onQueueChapterUpload: (chapterId: string) => void;
  uploadedChapterCount: number;
  isUploadingAll: boolean;
  onUpdateChapterTitle: (chapterId: string, newTitle: string) => void;
  onDeleteChapter: (chapterId: string) => void;
  onUpdateChapter: (chapter: Chapter) => void;
  onUpdateBookSettings?: (settings: any) => void;
  onBackToLibrary: () => void;
  onResetChapterProgress: (bookId: string, chapterId: string) => void;
  onAddAttachment?: () => void;
  playbackSnapshot?: { chapterId: string, percent: number } | null;
  isDirty?: boolean;
  lastSavedAt?: number;
  restoreScrollTop?: number | null;
  restoreChapterId?: string | null;
  restoreChapterIndex?: number | null;
  onScrollPositionChange?: (scrollTop: number) => void;

  // Phase One: paging support
  onLoadMoreChapters?: () => void;
  hasMoreChapters?: boolean;
  isLoadingMoreChapters?: boolean;
  
  // Optional UI refresh callback
  onAppendChapters?: (chapters: Chapter[]) => void;
  onQueueGenerateJob?: (chapterIds: string[], voiceId?: string) => Promise<boolean>;
  onBulkUpdateChapters?: (chapters: Chapter[], opts?: { syncInventory?: boolean }) => Promise<void>;
  onSyncNativeLibrary?: (opts?: { bookId?: string; chapterIds?: string[] }) => Promise<{
    books: number;
    chapters: number;
    texts: number;
    failures: number;
    chapterTextRows?: number;
    missingFiles?: number;
  }>;
  onReindexChapters?: () => Promise<{ updated: number; maxBefore: number; maxAfter: number }>;
  onRegisterBackHandler?: (handler: (() => boolean) | null) => void;
}

const ChapterFolderView: React.FC<ChapterFolderViewProps> = ({
  book,
  theme,
  globalRules,
  reflowLineBreaksEnabled,
  uiMode,
  jobs,
  onCancelJob,
  onRetryJob,
  onRefreshJobs,
  onUpdateBook,
  onDeleteBook,
  onAddChapter,
  onOpenChapter,
  onToggleFavorite,
  uploadQueueCount,
  onToggleUploadQueue,
  onUploadAllChapters,
  onQueueChapterUpload,
  uploadedChapterCount,
  isUploadingAll,
  onUpdateChapterTitle,
  onDeleteChapter,
  onUpdateChapter,
  onUpdateBookSettings,
  onBackToLibrary,
  onResetChapterProgress,
  onAddAttachment,
  playbackSnapshot,
  isDirty,
  lastSavedAt,
  restoreScrollTop,
  restoreChapterId,
  restoreChapterIndex,
  onScrollPositionChange,
  onLoadMoreChapters,
  hasMoreChapters,
  isLoadingMoreChapters,
  onAppendChapters,
  onQueueGenerateJob,
  onBulkUpdateChapters,
  onSyncNativeLibrary,
  onReindexChapters,
  onRegisterBackHandler,
}) => {
  const { driveFolderId } = book;
  const VIEW_MODE_KEY = `talevox:viewMode:${book.id}`;
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    const saved = localStorage.getItem(VIEW_MODE_KEY);
    if (saved === "grid") return "grid";
    return "sections";
  });

  useEffect(() => { localStorage.setItem(VIEW_MODE_KEY, viewMode); }, [viewMode, VIEW_MODE_KEY]);
  useEffect(() => {
    if (!onUpdateBookSettings) return;
    const current = book.settings?.chapterLayout === "grid" ? "grid" : "sections";
    if (current === viewMode) return;
    onUpdateBookSettings({ chapterLayout: viewMode });
  }, [viewMode, onUpdateBookSettings, book.settings?.chapterLayout]);
  useEffect(() => {
    return () => {
      scanRunRef.current += 1;
    };
  }, []);

  const [editingChapterId, setEditingChapterId] = useState<string | null>(null);
  const [tempTitle, setTempTitle] = useState('');
  const [synthesizingId, setSynthesizingId] = useState<string | null>(null);
  const [synthesisProgress, setSynthesisProgress] = useState<{ current: number, total: number, message: string } | null>(null);
  const [isCheckingDrive, setIsCheckingDrive] = useState(false);
  const [isInitManifests, setIsInitManifests] = useState(false);
  const [lastScan, setLastScan] = useState<ScanResult | null>(null);
  const [missingTextIds, setMissingTextIds] = useState<string[]>([]);
  const [missingAudioIds, setMissingAudioIds] = useState<string[]>([]);
  const [lastInventory, setLastInventory] = useState<InventoryManifest | null>(null);
  const [lastDriveFiles, setLastDriveFiles] = useState<StrayFile[]>([]);
  const [fixLog, setFixLog] = useState<string[]>([]);
  const [scanTitles, setScanTitles] = useState<Record<string, string>>({});

  const [legacyGroups, setLegacyGroups] = useState<LegacyGroup[]>([]);
  const [unlinkedNewFormatFiles, setUnlinkedNewFormatFiles] = useState<StrayFile[]>([]);

  const [notice, setNotice] = useState<{ message: string; kind: 'info' | 'success' | 'error' } | null>(null);
  const noticeTimerRef = useRef<number | null>(null);

  const pushNotice = useCallback((message: string, kind: 'info' | 'success' | 'error' = 'info', durationMs: number = 3000) => {
    setNotice({ message, kind });

    if (noticeTimerRef.current) {
      window.clearTimeout(noticeTimerRef.current);
      noticeTimerRef.current = null;
    }

    if (durationMs > 0) {
      noticeTimerRef.current = window.setTimeout(() => {
        setNotice(null);
        noticeTimerRef.current = null;
      }, durationMs);
    }
  }, []);

  const [showFixModal, setShowFixModal] = useState(false);
  const [isFixing, setIsFixing] = useState(false);
  const [fixProgress, setFixProgress] = useState({ current: 0, total: 0 });
  const [fixJobId, setFixJobId] = useState<string | null>(null);
  const abortFixRef = useRef(false);
  const scanRunRef = useRef(0);
  const [previewOnly, setPreviewOnly] = useState(true);
  const lastFixStatusRef = useRef<string | null>(null);

  const [showVoiceModal, setShowVoiceModal] = useState<{ chapterId?: string } | null>(null);
  const [rememberAsDefault, setRememberAsDefault] = useState(true);

  const [collapsedVolumes, setCollapsedVolumes] = useState<Record<string, boolean>>(() => {
    const raw = book.settings?.collapsedVolumes || {};
    const next: Record<string, boolean> = {};
    for (const [name, value] of Object.entries(raw)) {
      const trimmed = String(name || "").trim();
      if (trimmed && value === true) next[trimmed] = true;
    }
    return next;
  });
  const [searchQuery, setSearchQuery] = useState("");
  const [showSearchBar, setShowSearchBar] = useState(false);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [selectionAnchorId, setSelectionAnchorId] = useState<string | null>(null);
  const [isOrganizeMode, setIsOrganizeMode] = useState(false);
  const [bulkActionProgress, setBulkActionProgress] = useState<{ label: string; current: number; total: number } | null>(null);
  const [draggingChapterId, setDraggingChapterId] = useState<string | null>(null);
  const [draggingVolumeName, setDraggingVolumeName] = useState<string | null>(null);
  const longPressTimerRef = useRef<number | null>(null);
  const longPressPointerIdRef = useRef<number | null>(null);
  const longPressStartRef = useRef<{ x: number; y: number } | null>(null);
  const longPressChapterIdRef = useRef<string | null>(null);
  const longPressTriggeredRef = useRef(false);
  const [mobileMenuId, setMobileMenuId] = useState<string | null>(null);
  const [cachedAudioChapterIds, setCachedAudioChapterIds] = useState<Set<string>>(() => new Set());
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const viewScrollRef = useRef<ViewScrollState>({ sections: 0, grid: 0 });
  const lastViewModeRef = useRef<ViewMode>(viewMode);
  const restoreKeyRef = useRef<string | null>(null);
  const [bgGenProgress, setBgGenProgress] = useState<{ current: number; total: number } | null>(null);
  const [isRegeneratingAudio, setIsRegeneratingAudio] = useState(false);
  const [showBookSettings, setShowBookSettings] = useState(false);
  const [showBookMoreActions, setShowBookMoreActions] = useState(false);
  const coverInputRef = useRef<HTMLInputElement | null>(null);

  const [fixOptions, setFixOptions] = useState({
    genAudio: true,
    cleanupStrays: true,
    convertLegacy: true
  });
  const [isSyncingNative, setIsSyncingNative] = useState(false);
  const [syncSummary, setSyncSummary] = useState<{ books: number; chapters: number; texts: number; failures: number } | null>(null);

  useEffect(() => {
    const raw = book.settings?.collapsedVolumes || {};
    const next: Record<string, boolean> = {};
    for (const [name, value] of Object.entries(raw)) {
      const trimmed = String(name || "").trim();
      if (trimmed && value === true) next[trimmed] = true;
    }
    setCollapsedVolumes(next);
  }, [book.id, book.settings?.collapsedVolumes]);

  useEffect(() => {
    const preferred = book.settings?.chapterLayout === "grid" ? "grid" : "sections";
    setViewMode(preferred);
  }, [book.id, book.settings?.chapterLayout]);

  useEffect(() => {
    if (book.settings?.enableSelectionMode === false && selectionMode) {
      setSelectionMode(false);
      setSelectedIds(new Set());
      setSelectionAnchorId(null);
    }
    if (book.settings?.enableOrganizeMode === false && isOrganizeMode) {
      setIsOrganizeMode(false);
    }
  }, [book.settings?.enableSelectionMode, book.settings?.enableOrganizeMode, selectionMode, isOrganizeMode]);

  const isDark = theme === Theme.DARK;
  const isSepia = theme === Theme.SEPIA;
  const cardBg = isDark ? 'bg-slate-800 border-slate-700' : isSepia ? 'bg-[#f4ecd8] border-[#d8ccb6]' : 'bg-white border-black/10';
  const textSecondary = isDark ? 'text-slate-400' : isSepia ? 'text-[#3c2f25]/70' : 'text-slate-600';
  const subtleText = textSecondary;
  const stickyHeaderBg = isDark ? 'bg-slate-900/90' : isSepia ? 'bg-[#f4ecd8]/90' : 'bg-white/90';
  const accentButtonClass = `px-4 py-2 rounded-xl font-black uppercase tracking-widest text-[10px] transition-colors ${isDark ? 'bg-white/10 text-white border border-white/20 hover:bg-white/20' : 'bg-black/10 text-black border border-black/10 hover:bg-black/20'}`;
  const primaryActionClass = `px-4 py-2 rounded-xl font-black uppercase tracking-widest text-[10px] transition-colors ${isDark ? 'bg-indigo-500 text-white shadow-lg hover:bg-indigo-400' : 'bg-indigo-600 text-white shadow-lg hover:bg-indigo-500'}`;

  const chapters = useMemo(
    () => normalizeChapterOrder(book.chapters || []),
    [book.chapters]
  );
  const filteredChapters = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return chapters;
    return chapters.filter((chapter) => {
      const title = `${chapter.title || ""}`.toLowerCase();
      const filename = `${chapter.filename || ""}`.toLowerCase();
      const idx = `${chapter.index || getChapterSortOrder(chapter) || ""}`;
      return title.includes(q) || filename.includes(q) || idx.includes(q);
    });
  }, [chapters, searchQuery]);

  const volumeSections = useMemo(() => {
    const grouped = new Map<string, Chapter[]>();
    const ungrouped: Chapter[] = [];
    for (const ch of filteredChapters) {
      const volumeName =
        typeof (ch as any).volumeName === "string" ? String((ch as any).volumeName).trim() : "";
      if (!volumeName) {
        ungrouped.push(ch);
        continue;
      }
      const list = grouped.get(volumeName) || [];
      list.push(ch);
      grouped.set(volumeName, list);
    }

    const volumes = Array.from(grouped.entries()).map(([volumeName, items]) => {
      const m = volumeName.match(/^(book|volume)\s*(\d+)/i);
      const volumeNumber = m ? parseInt(m[2], 10) : null;
      const sorted = normalizeChapterOrder(items);
      return { volumeName, volumeNumber: Number.isFinite(volumeNumber) ? volumeNumber : null, chapters: sorted };
    });

    const explicitOrder = Array.isArray(book.settings?.volumeOrder)
      ? book.settings.volumeOrder
          .filter((name): name is string => typeof name === "string" && name.trim().length > 0)
          .map((name) => name.trim())
      : [];
    const explicitOrderMap = new Map<string, number>();
    explicitOrder.forEach((name, idx) => explicitOrderMap.set(name, idx));

    const NONE = 1_000_000_000;
    volumes.sort((a, b) => {
      const explicitA = explicitOrderMap.has(a.volumeName) ? explicitOrderMap.get(a.volumeName)! : NONE;
      const explicitB = explicitOrderMap.has(b.volumeName) ? explicitOrderMap.get(b.volumeName)! : NONE;
      if (explicitA !== explicitB) return explicitA - explicitB;
      const aN = a.volumeNumber ?? NONE;
      const bN = b.volumeNumber ?? NONE;
      if (aN !== bN) return aN - bN;
      return a.volumeName.localeCompare(b.volumeName, undefined, { numeric: true });
    });

    return {
      volumes,
      ungrouped: normalizeChapterOrder(ungrouped),
    };
  }, [filteredChapters, book.settings?.volumeOrder]);

  const visibleChapters = useMemo(() => {
    const rows: Chapter[] = [];
    for (const group of volumeSections.volumes) {
      if (collapsedVolumes[group.volumeName]) continue;
      rows.push(...group.chapters);
    }
    rows.push(...volumeSections.ungrouped);
    return rows;
  }, [volumeSections, collapsedVolumes]);

  const visibleChapterIds = useMemo(() => new Set(visibleChapters.map((chapter) => chapter.id)), [visibleChapters]);

  useEffect(() => {
    let cancelled = false;
    const chapterIds = visibleChapters.map((chapter) => chapter.id);
    if (!chapterIds.length) {
      setCachedAudioChapterIds((prev) => (prev.size ? new Set() : prev));
      return;
    }

    const chapterById = new Map(chapters.map((chapter) => [chapter.id, chapter]));

    const run = async () => {
      const detected = new Set<string>();
      const concurrency = 8;
      for (let i = 0; i < chapterIds.length; i += concurrency) {
        const batch = chapterIds.slice(i, i + concurrency);
        const checks = await Promise.allSettled(
          batch.map(async (chapterId) => {
            const chapter = chapterById.get(chapterId);
            if (!chapter) return false;
            if (chapter.audioSignature) {
              const inSignatureCache = await hasAudioInCache(chapter.audioSignature);
              if (inSignatureCache) return true;
            }
            const record = await getChapterAudioPath(chapterId);
            return !!record?.localPath;
          })
        );
        checks.forEach((result, idx) => {
          if (result.status === "fulfilled" && result.value) {
            detected.add(batch[idx]);
          }
        });
      }
      if (cancelled) return;
      setCachedAudioChapterIds((prev) => {
        const next = new Set(prev);
        chapterIds.forEach((id) => next.delete(id));
        detected.forEach((id) => next.add(id));
        return next;
      });
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [chapters, visibleChapters]);

  useEffect(() => {
    setSelectedIds((prev) => {
      const next = new Set<string>();
      for (const id of prev) {
        if (chapters.some((chapter) => chapter.id === id)) next.add(id);
      }
      return next;
    });
  }, [chapters]);

  useEffect(() => {
    if (selectionMode && selectedIds.size === 0) {
      setSelectionMode(false);
      setSelectionAnchorId(null);
    }
  }, [selectionMode, selectedIds]);

  const upsertBookSettings = useCallback(
    (patch: Partial<Book["settings"]>) => {
      onUpdateBookSettings?.({ ...(book.settings || {}), ...patch });
    },
    [onUpdateBookSettings, book.settings]
  );

  const persistChapters = useCallback(
    async (nextChapters: Chapter[]) => {
      if (!nextChapters.length) return;
      if (onBulkUpdateChapters) {
        await onBulkUpdateChapters(nextChapters, { syncInventory: true });
        return;
      }
      for (const chapter of nextChapters) {
        await onUpdateChapter(chapter);
      }
    },
    [onBulkUpdateChapters, onUpdateChapter]
  );

  const closeSelectionMode = useCallback(() => {
    setSelectionMode(false);
    setSelectedIds(new Set());
    setSelectionAnchorId(null);
  }, []);

  const handleBackRequest = useCallback(() => {
    if (showBookSettings) {
      setShowBookSettings(false);
      return true;
    }
    if (selectionMode) {
      closeSelectionMode();
      return true;
    }
    return false;
  }, [showBookSettings, selectionMode, closeSelectionMode]);

  useEffect(() => {
    if (!onRegisterBackHandler) return;
    onRegisterBackHandler(handleBackRequest);
    return () => {
      onRegisterBackHandler(null);
    };
  }, [onRegisterBackHandler, handleBackRequest]);

  useEffect(() => {
    if (!showBookSettings || typeof document === "undefined") return;
    const body = document.body;
    const html = document.documentElement;
    const prevBodyOverflow = body.style.overflow;
    const prevHtmlOverflow = html.style.overflow;
    body.style.overflow = "hidden";
    html.style.overflow = "hidden";
    return () => {
      body.style.overflow = prevBodyOverflow;
      html.style.overflow = prevHtmlOverflow;
    };
  }, [showBookSettings]);

  const selectRangeTo = useCallback(
    (targetId: string, additive = true) => {
      if (!selectionAnchorId) {
        setSelectedIds(new Set([targetId]));
        setSelectionAnchorId(targetId);
        return;
      }
      const order = visibleChapters.map((chapter) => chapter.id);
      const startIdx = order.indexOf(selectionAnchorId);
      const endIdx = order.indexOf(targetId);
      if (startIdx === -1 || endIdx === -1) {
        setSelectedIds((prev) => {
          const next = additive ? new Set(prev) : new Set<string>();
          next.add(targetId);
          return next;
        });
        setSelectionAnchorId(targetId);
        return;
      }
      const [lo, hi] = startIdx <= endIdx ? [startIdx, endIdx] : [endIdx, startIdx];
      const rangeIds = order.slice(lo, hi + 1);
      setSelectedIds((prev) => {
        const next = additive ? new Set(prev) : new Set<string>();
        rangeIds.forEach((id) => next.add(id));
        return next;
      });
      setSelectionAnchorId(targetId);
    },
    [selectionAnchorId, visibleChapters]
  );

  const toggleChapterSelection = useCallback(
    (chapterId: string, opts?: { range?: boolean; additive?: boolean }) => {
      if (book.settings?.enableSelectionMode === false) return;
      setSelectionMode(true);
      if (opts?.range) {
        selectRangeTo(chapterId, opts.additive !== false);
        return;
      }
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (next.has(chapterId)) next.delete(chapterId);
        else next.add(chapterId);
        return next;
      });
      setSelectionAnchorId((prev) => prev || chapterId);
    },
    [book.settings?.enableSelectionMode, selectRangeTo]
  );

  const handleSelectAllVisible = useCallback(() => {
    const allVisibleIds = visibleChapters.map((chapter) => chapter.id);
    setSelectionMode(true);
    setSelectedIds(new Set(allVisibleIds));
    setSelectionAnchorId(allVisibleIds[0] ?? null);
  }, [visibleChapters]);

  const handleInvertVisibleSelection = useCallback(() => {
    const nextIds: string[] = [];
    for (const chapter of visibleChapters) {
      if (!selectedIds.has(chapter.id)) nextIds.push(chapter.id);
    }
    setSelectionMode(true);
    setSelectedIds(new Set(nextIds));
    setSelectionAnchorId((prev) => {
      if (prev && nextIds.includes(prev)) return prev;
      return nextIds[0] ?? null;
    });
  }, [selectedIds, visibleChapters]);

  const selectedChapterList = useMemo(
    () => chapters.filter((chapter) => selectedIds.has(chapter.id)),
    [chapters, selectedIds]
  );
  const canBulkUpload = book.backend === StorageBackend.DRIVE;

  const runBulkAction = useCallback(
    async (
      label: string,
      action: (chapter: Chapter, index: number, total: number) => Promise<void> | void
    ) => {
      const total = selectedChapterList.length;
      if (!total) return;
      setBulkActionProgress({ label, current: 0, total });
      for (let i = 0; i < total; i += 1) {
        setBulkActionProgress({ label, current: i + 1, total });
        await action(selectedChapterList[i], i, total);
      }
      setBulkActionProgress(null);
    },
    [selectedChapterList]
  );

  const handleBulkUpload = useCallback(async () => {
    if (!canBulkUpload) {
      pushNotice("Upload is only available for Drive books.", "info");
      return;
    }
    await runBulkAction("Uploading", async (chapter) => {
      onQueueChapterUpload(chapter.id);
      await yieldToUi();
    });
  }, [canBulkUpload, onQueueChapterUpload, pushNotice, runBulkAction]);

  const handleBulkRegenerateAudio = useCallback(async () => {
    const chapterIds = selectedChapterList.map((chapter) => chapter.id);
    if (!chapterIds.length) return;
    if (onQueueGenerateJob) {
      setBulkActionProgress({ label: "Queueing audio jobs", current: 0, total: chapterIds.length });
      await onQueueGenerateJob(chapterIds, book.settings?.defaultVoiceId);
      setBulkActionProgress(null);
      closeSelectionMode();
      return;
    }
    await runBulkAction("Generating audio", async (chapter) => {
      await generateAudio(chapter, book.settings?.defaultVoiceId, { upload: false });
    });
    closeSelectionMode();
  }, [book.settings?.defaultVoiceId, closeSelectionMode, onQueueGenerateJob, runBulkAction, selectedChapterList]);

  const handleBulkMarkCompleted = useCallback(async () => {
    const now = Date.now();
    const updated = selectedChapterList.map((chapter) => {
      const textLen = chapter.textLength || chapter.progressTotalLength || chapter.wordCount || 0;
      return {
        ...chapter,
        isCompleted: true,
        progress: 1,
        progressChars: textLen,
        progressSec: typeof chapter.durationSec === "number" ? chapter.durationSec : chapter.progressSec,
        updatedAt: now,
      };
    });
    await persistChapters(updated);
    closeSelectionMode();
  }, [closeSelectionMode, persistChapters, selectedChapterList]);

  const handleBulkResetProgress = useCallback(async () => {
    if (!selectedChapterList.length) return;
    const ok = confirm(`Reset progress for ${selectedChapterList.length} chapter(s)?`);
    if (!ok) return;
    const now = Date.now();
    const updated = selectedChapterList.map((chapter) => ({
      ...chapter,
      isCompleted: false,
      progress: 0,
      progressChars: 0,
      progressSec: 0,
      updatedAt: now,
    }));
    await persistChapters(updated);
    closeSelectionMode();
  }, [closeSelectionMode, persistChapters, selectedChapterList]);

  const handleBulkDelete = useCallback(async () => {
    if (!selectedChapterList.length) return;
    const ok = confirm(`Delete ${selectedChapterList.length} chapter(s)?`);
    if (!ok) return;
    await runBulkAction("Deleting", async (chapter) => {
      await onDeleteChapter(chapter.id);
    });
    closeSelectionMode();
  }, [closeSelectionMode, onDeleteChapter, runBulkAction, selectedChapterList]);

  const moveChapterToVolume = useCallback(
    async (chapterId: string, nextVolumeName?: string) => {
      const chapter = chapters.find((item) => item.id === chapterId);
      if (!chapter) return;
      const normalizedVolumeName =
        typeof nextVolumeName === "string" && nextVolumeName.trim().length
          ? nextVolumeName.trim()
          : undefined;
      await onUpdateChapter({
        ...chapter,
        volumeName: normalizedVolumeName,
        volumeLocalChapter: undefined,
        updatedAt: Date.now(),
      });
    },
    [chapters, onUpdateChapter]
  );

  const renameVolume = useCallback(
    async (oldName: string) => {
      const nextNameRaw = prompt("Rename volume", oldName);
      if (nextNameRaw == null) return;
      const nextName = nextNameRaw.trim();
      if (!nextName || nextName === oldName) return;
      const now = Date.now();
      const updates = chapters
        .filter((chapter) => (chapter.volumeName || "").trim() === oldName)
        .map((chapter) => ({ ...chapter, volumeName: nextName, updatedAt: now }));
      await persistChapters(updates);
      const volumeOrder = Array.isArray(book.settings?.volumeOrder) ? [...book.settings.volumeOrder] : [];
      const replaced = volumeOrder.map((name) => (name === oldName ? nextName : name));
      upsertBookSettings({ volumeOrder: Array.from(new Set(replaced)) });
      setCollapsedVolumes((prev) => {
        if (!prev[oldName]) return prev;
        const copy = { ...prev };
        delete copy[oldName];
        copy[nextName] = true;
        upsertBookSettings({ collapsedVolumes: copy });
        return copy;
      });
    },
    [book.settings?.volumeOrder, chapters, persistChapters, upsertBookSettings]
  );

  const deleteVolumeToUngrouped = useCallback(
    async (volumeName: string) => {
      const ok = confirm(`Delete volume "${volumeName}" and move its chapters to ungrouped?`);
      if (!ok) return;
      const now = Date.now();
      const updates = chapters
        .filter((chapter) => (chapter.volumeName || "").trim() === volumeName)
        .map((chapter) => ({ ...chapter, volumeName: undefined, volumeLocalChapter: undefined, updatedAt: now }));
      await persistChapters(updates);
      const order = (book.settings?.volumeOrder || []).filter((name) => name !== volumeName);
      const nextCollapsed = { ...(book.settings?.collapsedVolumes || {}) };
      delete nextCollapsed[volumeName];
      upsertBookSettings({ volumeOrder: order, collapsedVolumes: nextCollapsed });
      setCollapsedVolumes(nextCollapsed);
    },
    [book.settings?.collapsedVolumes, book.settings?.volumeOrder, chapters, persistChapters, upsertBookSettings]
  );

  const reorderVolumes = useCallback(
    (sourceVolumeName: string, targetVolumeName: string) => {
      if (!sourceVolumeName || !targetVolumeName || sourceVolumeName === targetVolumeName) return;
      const existing = volumeSections.volumes.map((group) => group.volumeName);
      const order = Array.from(new Set([...(book.settings?.volumeOrder || []), ...existing]));
      const sourceIndex = order.indexOf(sourceVolumeName);
      const targetIndex = order.indexOf(targetVolumeName);
      if (sourceIndex === -1 || targetIndex === -1) return;
      const next = [...order];
      const [moved] = next.splice(sourceIndex, 1);
      next.splice(targetIndex, 0, moved);
      upsertBookSettings({ volumeOrder: next });
    },
    [book.settings?.volumeOrder, upsertBookSettings, volumeSections.volumes]
  );

  const reorderWithinVolume = useCallback(
    async (sourceChapterId: string, targetChapterId: string) => {
      if (sourceChapterId === targetChapterId) return;
      const ordered = normalizeChapterOrder(chapters);
      const sourceIdx = ordered.findIndex((chapter) => chapter.id === sourceChapterId);
      const targetIdx = ordered.findIndex((chapter) => chapter.id === targetChapterId);
      if (sourceIdx === -1 || targetIdx === -1) return;
      const next = [...ordered];
      const [moved] = next.splice(sourceIdx, 1);
      const insertAt = sourceIdx < targetIdx ? targetIdx - 1 : targetIdx;
      next.splice(insertAt, 0, moved);
      const now = Date.now();
      const reindexed = next.map((chapter, idx) => ({
        ...chapter,
        sortOrder: idx + 1,
        index: idx + 1,
        updatedAt: now,
      }));
      await persistChapters(reindexed);
    },
    [chapters, persistChapters]
  );

  const handleAddVolume = useCallback(async () => {
    const raw = prompt("New volume name");
    if (raw == null) return;
    const name = raw.trim();
    if (!name) return;
    const current = Array.isArray(book.settings?.volumeOrder) ? [...book.settings.volumeOrder] : [];
    if (current.includes(name)) return;
    upsertBookSettings({ volumeOrder: [...current, name] });
  }, [book.settings?.volumeOrder, upsertBookSettings]);

  const handleReindexChapters = useCallback(async () => {
    try {
      if (onReindexChapters) {
        const summary = await onReindexChapters();
        pushNotice(
          `Reindexed ${summary.updated} chapters (${summary.maxBefore} -> ${summary.maxAfter}).`,
          "success"
        );
        return;
      }
      const repaired = await fixChapterOrdering(book.id, chapters);
      if (!repaired.chapters.length) {
        pushNotice("No chapters to reindex.", "info");
        return;
      }
      await persistChapters(repaired.chapters);
      pushNotice(
        `Reindexed ${repaired.updated} chapters (${repaired.maxBefore} -> ${repaired.maxAfter}).`,
        "success"
      );
    } catch (e: any) {
      pushNotice(`Reindex failed: ${String(e?.message ?? e)}`, "error", 5000);
    }
  }, [book.id, chapters, onReindexChapters, persistChapters, pushNotice]);

  const isMobileInterface = computeMobileMode(uiMode);
  // Allow background-capable flows (WorkManager / native plugin) when we're in mobile mode.
  const enableBackgroundJobs = isMobileInterface;
  const bookJobs = useMemo(() => {
    return (jobs || []).filter((j) => {
      const bookId = (j as any)?.payloadJson?.bookId;
      return !bookId || bookId === book.id;
    });
  }, [jobs, book.id]);
  const hasInFlightBookJobs = useMemo(
    () =>
      (bookJobs || []).some((job) =>
        job.status === "queued" || job.status === "running"
      ),
    [bookJobs]
  );
  const hasPausedBookJobs = useMemo(
    () => (bookJobs || []).some((job) => job.status === "paused"),
    [bookJobs]
  );
  const syncBadge = useMemo(() => {
    if (book.backend !== StorageBackend.DRIVE) {
      return { backendLabel: "LOCAL", statusLabel: "LOCAL", tone: "slate" as const };
    }
    if (hasInFlightBookJobs || uploadQueueCount > 0 || isUploadingAll || isCheckingDrive || isFixing || isRegeneratingAudio) {
      return { backendLabel: "DRIVE", statusLabel: "SYNCING", tone: "indigo" as const };
    }
    if (hasPausedBookJobs) {
      return { backendLabel: "DRIVE", statusLabel: "PAUSED", tone: "amber" as const };
    }
    if (isDirty) {
      return { backendLabel: "DRIVE", statusLabel: "NOT SYNCED", tone: "amber" as const };
    }
    return { backendLabel: "DRIVE", statusLabel: "SYNCED", tone: "emerald" as const };
  }, [
    book.backend,
    hasInFlightBookJobs,
    hasPausedBookJobs,
    uploadQueueCount,
    isUploadingAll,
    isCheckingDrive,
    isFixing,
    isRegeneratingAudio,
    isDirty,
  ]);
  const activeFixJob = useMemo(() => {
    if (fixJobId) {
      return (bookJobs || []).find((j) => j.jobId === fixJobId) || null;
    }
    return (bookJobs || []).find((j) => j.type === "fixIntegrity" && (j.status === "queued" || j.status === "running" || j.status === "paused")) || null;
  }, [bookJobs, fixJobId]);

  const loadMoreSentinelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!hasMoreChapters) return;
    if (!onLoadMoreChapters) return;
    const el = loadMoreSentinelRef.current;
    if (!el) return;

    const obs = new IntersectionObserver((entries) => {
      const first = entries[0];
      if (first?.isIntersecting && !isLoadingMoreChapters) {
        onLoadMoreChapters();
      }
    }, { rootMargin: '200px' });

    obs.observe(el);
    return () => obs.disconnect();
  }, [hasMoreChapters, onLoadMoreChapters, isLoadingMoreChapters]);

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const { scrollTop, scrollHeight, clientHeight } = e.currentTarget;
    viewScrollRef.current[viewMode] = scrollTop;
    onScrollPositionChange?.(scrollTop);
    if (scrollHeight - scrollTop - clientHeight < 200) {
      if (hasMoreChapters && !isLoadingMoreChapters && onLoadMoreChapters) {
        onLoadMoreChapters();
      }
    }
  }, [hasMoreChapters, isLoadingMoreChapters, onLoadMoreChapters, onScrollPositionChange, viewMode]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const previousMode = lastViewModeRef.current;
    if (previousMode === viewMode) return;

    viewScrollRef.current[previousMode] = container.scrollTop;
    lastViewModeRef.current = viewMode;

    window.requestAnimationFrame(() => {
      const nextScroll = viewScrollRef.current[viewMode] ?? 0;
      container.scrollTop = nextScroll;
    });
  }, [viewMode]);

  useEffect(() => {
    if (!chapters.length) return;
    if (restoreScrollTop == null && !restoreChapterId && restoreChapterIndex == null) return;
    const key = [
      book.id,
      viewMode,
      restoreScrollTop ?? "none",
      restoreChapterId ?? restoreChapterIndex ?? "none",
      visibleChapters.length,
    ].join("|");
    if (restoreKeyRef.current === key) return;
    restoreKeyRef.current = key;

    let targetChapterId: string | null = restoreChapterId ?? null;
    if (!targetChapterId && restoreChapterIndex != null) {
      targetChapterId =
        visibleChapters.find(
          (chapter) =>
            chapter.index === restoreChapterIndex ||
            getChapterSortOrder(chapter) === restoreChapterIndex
        )?.id ?? null;
    }

    const container = scrollContainerRef.current;
    if (!container) return;
    if (typeof restoreScrollTop === "number") {
      container.scrollTop = restoreScrollTop;
    }
    if (targetChapterId) {
      const target = container.querySelector(`[data-chapter-id="${targetChapterId}"]`);
      if (target instanceof HTMLElement) target.scrollIntoView({ block: "center" });
    }
  }, [
    book.id,
    chapters,
    visibleChapters,
    restoreChapterId,
    restoreChapterIndex,
    restoreScrollTop,
    viewMode,
  ]);

  useEffect(() => {
    if (!isMobileInterface || !activeFixJob) return;
    const progress = (activeFixJob as any).progressJson || {};
    const total = Number(progress.total ?? 0);
    const completed = Number(progress.completed ?? 0);
    if (total || completed) {
      setFixProgress({ current: completed, total });
    }
    const status = activeFixJob.status;
    if (status !== lastFixStatusRef.current) {
      lastFixStatusRef.current = status;
      if (status === "completed") {
        setIsFixing(false);
        setFixJobId(null);
        pushNotice("Fix complete. Run CHECK again to verify.", "success");
      } else if (status === "failed") {
        setIsFixing(false);
        setFixJobId(null);
        pushNotice("Fix failed. See Jobs for details.", "error", 6000);
      } else if (status === "canceled") {
        setIsFixing(false);
        setFixJobId(null);
        pushNotice("Fix canceled.", "info");
      } else if (status === "queued" || status === "running" || status === "paused") {
        setIsFixing(true);
      }
    }
  }, [activeFixJob, isMobileInterface, pushNotice]);

  const handleInitManifests = useCallback(async () => {
    if (!driveFolderId) {
      pushNotice("Drive folder not set for this book yet.", "error");
      return;
    }
    if (book.backend !== StorageBackend.DRIVE) {
      pushNotice("This tool is currently only wired for Drive books.", "error");
      return;
    }

    setIsInitManifests(true);
    try {
      const adapter = createDriveFolderAdapter();

      const res = await initBookFolderManifests({
        book,
        rootFolderId: driveFolderId,
        rootFolderName: (book as any).driveFolderName ?? book.title,
        adapter
      });

      const total = res.inventory.expectedTotal ?? res.inventory.chapters.length;
      pushNotice(`Manifests ready. Inventory has ${total} chapters.`, "success");
    } catch (e: any) {
      pushNotice(`Manifest init failed: ${String(e?.message ?? e)}`, "error");
    } finally {
      setIsInitManifests(false);
    }
  }, [book, driveFolderId, pushNotice]);

  const fetchAllChapters = useCallback(async () => {
    const all: Chapter[] = [];
    let afterIndex = -1;
    const LIMIT = 200;
    while (true) {
      const page = await libraryListChaptersPage(book.id, afterIndex, LIMIT);

      if (!page || page.chapters.length === 0) break;

      all.push(...page.chapters);

      if (page.nextAfterIndex == null) break;

      afterIndex = page.nextAfterIndex;
    }
    return normalizeChapterOrder(all);
  }, [book.id]);

  const scanHasIssues = (scan: ScanResult | null | undefined) =>
    !!scan &&
    (scan.missingTextIds.length > 0 ||
      scan.missingAudioIds.length > 0 ||
      scan.strayFiles.length > 0 ||
      (scan as any).legacyCount > 0 ||
      (scan as any).unlinkedNewFormatCount > 0);

  const handleCheckDriveIntegrity = useCallback(async (): Promise<ScanResult | null> => {
    if (!driveFolderId) {
      pushNotice("Drive folder not set for this book yet.", "error");
      return null;
    }
    if (!isTokenValid()) {
      alert("Google Drive session expired. Please sign in again in Settings.");
      return null;
    }
    const runId = ++scanRunRef.current;
    const isCancelled = () => scanRunRef.current !== runId;
    setIsCheckingDrive(true);
    try {
      // 1. List root files
      const rootFiles = await listFilesInFolder(driveFolderId);

      // 2. Identify subfolders (meta, text, audio, trash)
      const subfolders = rootFiles.filter(f => f.mimeType === "application/vnd.google-apps.folder");
      const targetSubfolders = ["meta", "text", "audio", "trash"];

      let allFiles = [...rootFiles];
      let metaFiles: StrayFile[] = [];

      // 3. Scan subfolders and combine files
      let folderCounter = 0;
      for (const folder of subfolders) {
        if (isCancelled()) return null;
        if (folderCounter % 4 === 0) {
          await yieldToUi();
        }
        folderCounter += 1;
        if (targetSubfolders.includes(folder.name)) {
          try {
            const subFiles = await listFilesInFolder(folder.id);
            if (folder.name === "meta") metaFiles = subFiles;
            allFiles = [...allFiles, ...subFiles];
          } catch (e) {
            console.warn(`Failed to list subfolder ${folder.name}`, e);
          }
        }
      }

      const metaFolder = subfolders.find(f => f.name === "meta");
      if (!metaFolder) {
        throw new Error("meta folder not found in this Drive book.");
      }

      if (metaFiles.length === 0) {
        metaFiles = await listFilesInFolder(metaFolder.id);
      }

      const inventoryFile = metaFiles.find(f => f.name === "inventory.json");
      if (!inventoryFile) {
        throw new Error("inventory.json not found in meta folder.");
      }
      let inventory: InventoryManifest;
      try {
        const rawInventory = await fetchDriveFile(inventoryFile.id);
        inventory = JSON.parse(rawInventory) as InventoryManifest;
      } catch (e) {
        throw new Error(`Failed to parse inventory.json: ${String((e as Error)?.message ?? e)}`);
      }

      if (!Array.isArray(inventory?.chapters)) {
        throw new Error("inventory.json is missing chapters.");
      }

      setLastInventory(inventory);
      if (isCancelled()) return null;

      // 4. Deduplicate by name, keeping newest. Collect extras as strays.
      // Invariant: duplicates (same name, different id) are ALWAYS stray — they never go through
      // classification and are excluded from driveFiles, so they cannot be legacy or unlinked.
      const filesByName = new Map<string, StrayFile[]>();
      let fileCounter = 0;
      for (const f of allFiles) {
        if (isCancelled()) return null;
        if (fileCounter % 50 === 0) {
          await yieldToUi();
        }
        fileCounter += 1;
        if (!f?.name) continue;
        const arr = filesByName.get(f.name) || [];
        arr.push(f);
        filesByName.set(f.name, arr);
      }

      const driveFiles: StrayFile[] = []; // Unique files (newest)
      const duplicateStrays: StrayFile[] = [];

      let dedupeCounter = 0;
      for (const [name, files] of filesByName) {
          if (isCancelled()) return null;
          if (dedupeCounter % 60 === 0) {
            await yieldToUi();
          }
          dedupeCounter += 1;
          if (files.length === 1) {
              driveFiles.push(files[0]);
          } else {
              // Sort newest first
              files.sort((a, b) => {
                  const tA = Date.parse(a.modifiedTime || '') || 0;
                  const tB = Date.parse(b.modifiedTime || '') || 0;
                  return tB - tA;
              });
              driveFiles.push(files[0]); // Keep newest
              for (let i = 1; i < files.length; i++) {
                  duplicateStrays.push(files[i]);
              }
          }
      }

      const hasName = (name: string) => (filesByName.get(name)?.length || 0) > 0;

      // Update title cache for UI from inventory
      const titleMap: Record<string, string> = {};
      let titleCounter = 0;
      for (const c of inventory.chapters) {
        if (isCancelled()) return null;
        if (titleCounter % 60 === 0) {
          await yieldToUi();
        }
        titleCounter += 1;
        if (c?.chapterId) titleMap[c.chapterId] = c.title ?? c.chapterId;
      }
      setScanTitles(titleMap);

      // Expected file names from inventory
      const expectedNames = new Set<string>();
      const missingTextIds: string[] = [];
      const missingAudioIds: string[] = [];
      let accountedChaptersCount = 0;

      let inventoryCounter = 0;
      for (const ch of inventory.chapters) {
        if (isCancelled()) return null;
        if (inventoryCounter % 60 === 0) {
          await yieldToUi();
        }
        inventoryCounter += 1;
        const chapterId = ch.chapterId;
        if (!chapterId) continue;
        const txtName = `c_${chapterId}.txt`;
        const mdName = `c_${chapterId}.md`;
        const mp3Name = `c_${chapterId}.mp3`;

        expectedNames.add(txtName);
        expectedNames.add(mdName);
        expectedNames.add(mp3Name);

        const hasTextExpected = hasName(txtName) || hasName(mdName);
        const hasAudioExpected = hasName(mp3Name);

        if (!hasTextExpected) missingTextIds.push(chapterId);
        if (!hasAudioExpected) missingAudioIds.push(chapterId);
        if (hasTextExpected && hasAudioExpected) accountedChaptersCount += 1;
      }

      const toSlug = (value: string) =>
        value
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "_")
          .replace(/^_+|_+$/g, "");

      const newestFile = (files: StrayFile[]) => {
        if (!files.length) return null;
        return files.reduce((latest, current) => {
          const latestTime = Date.parse(latest.modifiedTime || "") || 0;
          const currentTime = Date.parse(current.modifiedTime || "") || 0;
          return currentTime > latestTime ? current : latest;
        });
      };

      // Classification logic
      const legacyMatches: LegacyGroup[] = [];
      const unlinkedMatches: StrayFile[] = [];
      const trueStrays: StrayFile[] = [...duplicateStrays];

      const legacyRegex = /^(\d+)_(.+)\.(txt|md|mp3)$/;
      const newFormatRegex = /^c_.+\.(txt|md|mp3)$/;

      // Group legacy by prefix
      const legacyMap = new Map<string, LegacyGroup>();
      const legacyFiles: Array<{ file: StrayFile; idx: number; slug: string; type: "text" | "audio" }> = [];

      let driveFileCounter = 0;
      for (const f of driveFiles) {
        if (isCancelled()) return null;
        if (driveFileCounter % 60 === 0) {
          await yieldToUi();
        }
        driveFileCounter += 1;
        // Ignore folders
        if (f.mimeType === "application/vnd.google-apps.folder") continue;

        if (!f?.name) continue;
        if (expectedNames.has(f.name)) continue;

        // ignore common stuff
        if (
          f.name === ".keep" ||
          f.name === "cover.jpg" ||
          f.name === "manifest.json" ||
          f.name === "book.json" ||
          f.name === "inventory.json" ||
          f.name.startsWith('_')
        ) continue;

        const leg = f.name.match(legacyRegex);
        if (leg) {
          const idx = parseInt(leg[1], 10);
          const slug = leg[2]; // includes title part
          const ext = leg[3];
          const key = `${idx}_${slug}`;
          const type = ext === "txt" ? "text" : "audio";
          legacyFiles.push({ file: f, idx, slug, type });
          
          let group = legacyMap.get(key);
          if (!group) {
            group = { legacyIndex: idx, slug, text: undefined, audio: undefined };
            legacyMap.set(key, group);
          }
          if (ext === 'txt') group.text = f;
          if (ext === 'mp3') group.audio = f;
          continue;
        }

        if (newFormatRegex.test(f.name)) {
          unlinkedMatches.push(f);
          continue;
        }

        trueStrays.push(f);
      }
      
      const legacyGroupsList = Array.from(legacyMap.values()).sort((a,b) => a.legacyIndex - b.legacyIndex);

      setLegacyGroups(legacyGroupsList);
      setUnlinkedNewFormatFiles(unlinkedMatches);

      const duplicates: ScanResult["duplicates"] = [];

      const inventoryById = new Map(inventory.chapters.map((c) => [c.chapterId, c]));
      const legacyByIdx = new Map<number, { text: StrayFile[]; audio: StrayFile[] }>();
      const legacyBySlug = new Map<string, { text: StrayFile[]; audio: StrayFile[] }>();

      let legacyEntryCounter = 0;
      for (const entry of legacyFiles) {
        if (isCancelled()) return null;
        if (legacyEntryCounter % 60 === 0) {
          await yieldToUi();
        }
        legacyEntryCounter += 1;
        const byIdx = legacyByIdx.get(entry.idx) ?? { text: [], audio: [] };
        byIdx[entry.type].push(entry.file);
        legacyByIdx.set(entry.idx, byIdx);

        const slugKey = toSlug(entry.slug);
        const bySlug = legacyBySlug.get(slugKey) ?? { text: [], audio: [] };
        bySlug[entry.type].push(entry.file);
        legacyBySlug.set(slugKey, bySlug);
      }

      const missingChapterIds = new Set<string>([...missingTextIds, ...missingAudioIds]);
      const legacyRecoveryCandidates: ScanResult["legacyRecoveryCandidates"] = {};

      let missingCounter = 0;
      for (const chapterId of missingChapterIds) {
        if (isCancelled()) return null;
        if (missingCounter % 60 === 0) {
          await yieldToUi();
        }
        missingCounter += 1;
        const inv = inventoryById.get(chapterId);
        const idx = inv?.idx;
        const titleSlug = inv?.title ? toSlug(inv.title) : "";

        let legacyTextCandidate: { id: string; name: string } | null = null;
        let legacyAudioCandidate: { id: string; name: string } | null = null;
        let reasonChosen: "index match" | "title match" | "newest" | null = null;

        if (typeof idx === "number" && legacyByIdx.has(idx)) {
          const byIdx = legacyByIdx.get(idx)!;
          const textNewest = newestFile(byIdx.text);
          const audioNewest = newestFile(byIdx.audio);
          if (textNewest) legacyTextCandidate = { id: textNewest.id, name: textNewest.name };
          if (audioNewest) legacyAudioCandidate = { id: audioNewest.id, name: audioNewest.name };
          if (textNewest || audioNewest) {
            const multiText = byIdx.text.length > 1;
            const multiAudio = byIdx.audio.length > 1;
            reasonChosen = multiText || multiAudio ? "newest" : "index match";
          }
        }

        if ((!legacyTextCandidate || !legacyAudioCandidate) && titleSlug && legacyBySlug.has(titleSlug)) {
          const bySlug = legacyBySlug.get(titleSlug)!;
          if (!legacyTextCandidate) {
            const textNewest = newestFile(bySlug.text);
            if (textNewest) legacyTextCandidate = { id: textNewest.id, name: textNewest.name };
          }
          if (!legacyAudioCandidate) {
            const audioNewest = newestFile(bySlug.audio);
            if (audioNewest) legacyAudioCandidate = { id: audioNewest.id, name: audioNewest.name };
          }
          if ((legacyTextCandidate || legacyAudioCandidate) && !reasonChosen) {
            const multiText = bySlug.text.length > 1;
            const multiAudio = bySlug.audio.length > 1;
            reasonChosen = multiText || multiAudio ? "newest" : "title match";
          }
        }

        legacyRecoveryCandidates[chapterId] = {
          legacyTextCandidate,
          legacyAudioCandidate,
          reasonChosen,
        };
      }

      let safeToCleanup = true;
      let cleanupCounter = 0;
      for (const ch of inventory.chapters) {
        if (isCancelled()) return null;
        if (cleanupCounter % 60 === 0) {
          await yieldToUi();
        }
        cleanupCounter += 1;
        const chapterId = ch.chapterId;
        if (!chapterId) {
          safeToCleanup = false;
          break;
        }

        const txtName = `c_${chapterId}.txt`;
        const mdName = `c_${chapterId}.md`;
        const mp3Name = `c_${chapterId}.mp3`;
        const hasTextExpected = hasName(txtName) || hasName(mdName);
        const hasAudioExpected = hasName(mp3Name);
        const legacyCandidate = legacyRecoveryCandidates[chapterId];
        const hasLegacyText = !!legacyCandidate?.legacyTextCandidate;
        const hasLegacyAudio = !!legacyCandidate?.legacyAudioCandidate;

        if ((!hasTextExpected && !hasLegacyText) || (!hasAudioExpected && !hasLegacyAudio)) {
          safeToCleanup = false;
          break;
        }
      }

      const scan: ScanResult = {
        missingTextIds,
        missingAudioIds,
        strayFiles: trueStrays,
        duplicates,
        totalChecked: inventory.chapters.length,
        expectedChapters: inventory.chapters.length,
        missingTextCount: missingTextIds.length,
        missingAudioCount: missingAudioIds.length,
        accountedChaptersCount,
        legacyRecoveryCandidates,
        safeToCleanup,
      };

      // Attach extra counts for UI
      (scan as any).legacyCount = legacyGroupsList.length;
      (scan as any).unlinkedNewFormatCount = unlinkedMatches.length;

      if (isCancelled()) return null;
      setLastScan(scan);
      setMissingTextIds(scan.missingTextIds);
      setMissingAudioIds(scan.missingAudioIds);
      setLastDriveFiles(allFiles);
      if (!safeToCleanup) {
        pushNotice("Not safe to cleanup. Some inventory chapters cannot be recovered yet.", "error", 6000);
      }
      return scan;
    } catch (e: any) {
      pushNotice("Integrity check failed: " + (e?.message || String(e)), 'error', 6000);
      return null;
    } finally {
      setIsCheckingDrive(false);
    }
  }, [driveFolderId, pushNotice]);

  const handleCheckLocalIntegrity = useCallback(async (): Promise<ScanResult | null> => {
    setIsCheckingDrive(true);
    const runId = ++scanRunRef.current;
    const isCancelled = () => scanRunRef.current !== runId;
    try {
      const allChapters = await fetchAllChapters();
      if (isCancelled()) return null;
      
      // Update title cache
      const titleMap: Record<string, string> = {};
      allChapters.forEach(c => titleMap[c.id] = c.title);
      setScanTitles(titleMap);

      const scan: ScanResult = {
        missingTextIds: [],
        missingAudioIds: [],
        strayFiles: [],
        duplicates: [],
        totalChecked: allChapters.length
      };

      let chapterCounter = 0;
      for (const chapter of allChapters) {
        if (isCancelled()) return null;
        if (chapterCounter % 40 === 0) {
          await yieldToUi();
        }
        chapterCounter += 1;
        const text =
          (chapter.content && chapter.content.trim() ? chapter.content : null) ??
          (await libraryLoadChapterText(book.id, chapter.id)) ??
          "";

        if (!text.trim()) {
          scan.missingTextIds.push(chapter.id);
        }

        const signature = (chapter as any).audioSignature as string | undefined;
        const audioOk = signature ? await hasAudioInCache(signature) : false;

        if (!audioOk) {
          scan.missingAudioIds.push(chapter.id);
        }

        onUpdateChapter({
          ...chapter,
          audioStatus: audioOk ? AudioStatus.READY : AudioStatus.PENDING
        });
      }

      if (isCancelled()) return null;
      setLastScan(scan);
      setMissingTextIds(scan.missingTextIds);
      setMissingAudioIds(scan.missingAudioIds);

      return scan;
    } catch (e: any) {
      pushNotice("Integrity check failed: " + (e?.message || String(e)), "error", 6000);
      return null;
    } finally {
      setIsCheckingDrive(false);
    }
  }, [book.id, onUpdateChapter, pushNotice, fetchAllChapters]);

  const handleCheckIntegrity = useCallback(async () => {
    if (lastScan && !scanHasIssues(lastScan)) {
      pushNotice("Already clean - skipping re-check.", "info", 2500);
      return;
    }
    const scan =
      book.backend === StorageBackend.DRIVE
        ? await handleCheckDriveIntegrity()
        : await handleCheckLocalIntegrity();

    if (!scan) return;

    const missingText = scan.missingTextIds.length;
    const missingAudio = scan.missingAudioIds.length;
    const strays = scan.strayFiles.length;
    const legacyCount = Number((scan as any).legacyCount || 0);
    const unlinkedCount = Number((scan as any).unlinkedNewFormatCount || 0);

    if (missingText || missingAudio || strays || legacyCount || unlinkedCount) {
      pushNotice(
        `Found issues: ${missingText} missing text, ${missingAudio} missing audio, ${strays} stray, ${legacyCount} legacy, ${unlinkedCount} unlinked.`,
        "info",
        6000
      );
    } else {
      pushNotice("All good - nothing to fix.", "success", 2500);
    }
  }, [book.backend, handleCheckDriveIntegrity, handleCheckLocalIntegrity, pushNotice, lastScan]);

  const generateAudio = async (
    chapter: Chapter,
    voiceIdOverride?: string,
    options?: { upload?: boolean }
  ): Promise<boolean> => {
    if (synthesizingId) return false;

    setSynthesizingId(chapter.id);
    setSynthesisProgress({ current: 0, total: 1, message: "Preparing audio..." });

    try {
      const selectedVoiceId =
        voiceIdOverride ||
        book.settings.defaultVoiceId ||
        book.settings.selectedVoiceName ||
        "en-US-Standard-C";
      onUpdateChapter({
        ...chapter,
        audioStatus: AudioStatus.GENERATING,
        updatedAt: Date.now(),
      });

      const shouldUpload =
        options?.upload ?? (book.backend === StorageBackend.DRIVE && !!book.driveFolderId);

      setSynthesisProgress({ current: 0, total: 1, message: "Synthesizing audio..." });
      await generateAndPersistChapterAudio({
        book,
        chapter,
        voiceId: selectedVoiceId,
        playbackSpeed: book.settings?.useBookSettings
          ? book.settings?.playbackSpeed ?? 1.0
          : 1.0,
        rules: [...(globalRules || []), ...(book.rules || [])],
        reflowLineBreaksEnabled,
        uiMode,
        isAuthorized: isTokenValid(),
        uploadToCloud: shouldUpload,
        loadChapterText: async () => chapter.content || (await libraryLoadChapterText(book.id, chapter.id)) || "",
        onChapterUpdated: async (updatedChapter) => {
          onUpdateChapter(updatedChapter);
        },
      });
      return true;
    } catch (err: any) {
      console.error("[TaleVox] generateAudio failed", err);

      onUpdateChapter({
        ...chapter,
        audioStatus: AudioStatus.FAILED,
        updatedAt: Date.now(),
      });

      alert(err?.message || "Audio generation failed");
      return false;
    } finally {
      setSynthesizingId(null);
      setSynthesisProgress(null);
    }
  };

  const handleRegenerateAudio = async () => {
    if (!chapters.length) {
      pushNotice("No chapters to regenerate.", "info");
      return;
    }

    if (isMobileInterface && enableBackgroundJobs && onQueueGenerateJob) {
      const ok = await onQueueGenerateJob(chapters.map((c) => c.id));
      if (ok) return;
      pushNotice("Failed to queue background generation. Check Jobs/Notifications.", "error", 5000);
      return;
    }

    setIsRegeneratingAudio(true);
    setBgGenProgress({ current: 0, total: chapters.length });
    try {
      for (const chapter of chapters) {
        await generateAudio(chapter, undefined, { upload: false });
        setBgGenProgress((p) =>
          p ? { ...p, current: Math.min(p.total, p.current + 1) } : null
        );
      }
      pushNotice("Audio generation complete.", "success");
    } catch (e: any) {
      pushNotice(`Audio regeneration failed: ${String(e?.message ?? e)}`, "error");
    } finally {
      setBgGenProgress(null);
      setIsRegeneratingAudio(false);
    }
  };
  const buildFixPlan = useCallback((options?: { includeConversions?: boolean; includeGeneration?: boolean; includeCleanup?: boolean }) => {
    const scan = lastScan;
    const inventory = lastInventory;
    if (!scan || !inventory) {
      return {
        conversions: [] as Array<{ chapterId: string; type: "text" | "audio"; source: StrayFile; targetName: string }>,
        generationIds: [] as string[],
        cleanup: [] as StrayFile[],
        safeToCleanup: false
      };
    }

    const includeConversions = options?.includeConversions ?? true;
    const includeGeneration = options?.includeGeneration ?? true;
    const includeCleanup = options?.includeCleanup ?? true;

    const nameSet = new Set(lastDriveFiles.map((f) => f.name).filter(Boolean));
    const hasName = (name: string) => nameSet.has(name);
    const legacyCandidates = scan.legacyRecoveryCandidates ?? {};

    const expectedNames = new Set<string>();
    for (const ch of inventory.chapters) {
      if (!ch.chapterId) continue;
      expectedNames.add(`c_${ch.chapterId}.txt`);
      expectedNames.add(`c_${ch.chapterId}.md`);
      expectedNames.add(`c_${ch.chapterId}.mp3`);
    }

    const conversions: Array<{ chapterId: string; type: "text" | "audio"; source: StrayFile; targetName: string }> = [];

    if (includeConversions) {
      for (const chapterId of scan.missingTextIds) {
        const legacyText = legacyCandidates[chapterId]?.legacyTextCandidate;
        if (legacyText) {
          conversions.push({
            chapterId,
            type: "text",
            source: { ...legacyText, mimeType: "text/plain", modifiedTime: "" } as StrayFile,
            targetName: `c_${chapterId}.txt`
          });
        }
      }

      for (const chapterId of scan.missingAudioIds) {
        const legacyAudio = legacyCandidates[chapterId]?.legacyAudioCandidate;
        if (legacyAudio) {
          conversions.push({
            chapterId,
            type: "audio",
            source: { ...legacyAudio, mimeType: "audio/mpeg", modifiedTime: "" } as StrayFile,
            targetName: `c_${chapterId}.mp3`
          });
        }
      }
    }

    const generationIds: string[] = [];
    if (includeGeneration) {
      for (const chapterId of scan.missingAudioIds) {
        const legacyAudio = legacyCandidates[chapterId]?.legacyAudioCandidate;
        if (legacyAudio) continue;
        const textName = `c_${chapterId}.txt`;
        const hasTextExpected = hasName(textName) || hasName(`c_${chapterId}.md`);
        const hasLegacyText = !!legacyCandidates[chapterId]?.legacyTextCandidate;
        if (hasTextExpected || hasLegacyText) {
          generationIds.push(chapterId);
        }
      }
    }

    const cleanup: StrayFile[] = [];
    const safeToCleanup = !!scan.safeToCleanup;

    if (includeCleanup && safeToCleanup) {
      const allowedNames = new Set<string>(["book.json", "inventory.json", ...expectedNames]);
      for (const f of lastDriveFiles) {
        if (f.mimeType === "application/vnd.google-apps.folder") continue;
        if (!f.name) continue;
        if (!allowedNames.has(f.name)) cleanup.push(f);
      }
    }

    return { conversions, generationIds, cleanup, safeToCleanup };
  }, [lastDriveFiles, lastInventory, lastScan]);

  const handleRunFix = async () => {
    setIsFixing(true);
    abortFixRef.current = false;
    setFixLog([]);
    let errorCount = 0;

    const plan = buildFixPlan({
      includeConversions: fixOptions.convertLegacy,
      includeGeneration: fixOptions.genAudio,
      includeCleanup: fixOptions.cleanupStrays
    });

    const totalSteps =
      plan.conversions.length +
      plan.generationIds.length +
      (plan.safeToCleanup ? plan.cleanup.length : 0);

    setFixProgress({ current: 0, total: totalSteps });

    const bump = () => setFixProgress(p => ({ ...p, current: p.current + 1 }));

    try {
      // Fetch all chapters to ensure we can fix items not currently in UI
      const allChapters = await fetchAllChapters();

      // Local backend: only generate missing audio
      if (book.backend !== StorageBackend.DRIVE) {
        const targets = new Set<string>([...missingAudioIds]);

        if (fixOptions.genAudio && targets.size) {
          let localCounter = 0;
          for (const chapterId of targets) {
            if (abortFixRef.current) break;
            if (localCounter % 10 === 0) {
              await yieldToUi();
            }
            localCounter += 1;
            const ch = allChapters.find(c => c.id === chapterId);
            if (!ch) continue;

            setFixLog(prev => [...prev, `Generate audio: ${ch.title}`]);
            await generateAudio(ch);
            bump();
          }
        }

        pushNotice("Fix complete.", "success", 3500);
        setLastScan(null);
        return;
      }

      // Drive backend
      if (!driveFolderId) {
        pushNotice("Drive folder not set.", "error");
        return;
      }

      if (isMobileInterface && enableBackgroundJobs) {
        setFixLog(prev => [...prev, `Queued background fix job`]);
        try {
          const voiceId =
            book.settings?.defaultVoiceId ||
            book.settings?.selectedVoiceName ||
            "en-US-Standard-C";
          const parsedVoice = parseTtsVoiceId(voiceId);
          const res = await enqueueFixIntegrity(
            {
              bookId: book.id,
              driveFolderId: book.driveFolderId,
              options: {
                genAudio: fixOptions.genAudio,
                cleanupStrays: fixOptions.cleanupStrays,
                convertLegacy: fixOptions.convertLegacy
              },
              voice: { id: parsedVoice.id, provider: parsedVoice.provider },
              settings: {
                playbackSpeed: book.settings?.useBookSettings
                  ? book.settings?.playbackSpeed ?? 1.0
                  : 1.0,
              },
            },
            uiMode
          );
          setFixProgress({ current: 0, total: totalSteps });
          setFixJobId(res.jobId);
          setIsFixing(true);
          onRefreshJobs();
          pushNotice("Fix started in background. Progress is shown here.", "success", 3000);
        } catch (e: any) {
          errorCount++;
          setFixLog(prev => [...prev, `Failed to queue background fix job: ${String(e?.message ?? e)}`]);
          pushNotice("Failed to queue background fix job.", "error", 5000);
        }
        return;
      }

      const chaptersById = new Map(allChapters.map((c) => [c.id, c]));

      // 1) Convert legacy candidates into expected files
      let conversionCounter = 0;
      for (const conversion of plan.conversions) {
        if (abortFixRef.current) break;
        if (conversionCounter % 10 === 0) {
          await yieldToUi();
        }
        conversionCounter += 1;
        setFixLog(prev => [...prev, `Copy legacy ${conversion.type}: ${conversion.targetName}`]);
        try {
          const newId = await copyDriveFile(conversion.source.id, driveFolderId, conversion.targetName);
          const ch = chaptersById.get(conversion.chapterId);
          if (ch) {
            if (conversion.type === "text") {
              onUpdateChapter({ ...ch, cloudTextFileId: newId, hasTextOnDrive: true, updatedAt: Date.now() } as any);
            } else {
              onUpdateChapter({ ...ch, cloudAudioFileId: newId, audioStatus: AudioStatus.READY, updatedAt: Date.now() } as any);
            }
          }
        } catch {
          errorCount++;
          setFixLog(p => [...p, `Failed to copy legacy ${conversion.targetName}`]);
        }
        bump();
      }
      // 2) Generate missing audio (when no legacy audio candidate)
      let genCounter = 0;
      for (const chapterId of plan.generationIds) {
        if (abortFixRef.current) break;
        if (genCounter % 10 === 0) {
          await yieldToUi();
        }
        genCounter += 1;
        const ch = chaptersById.get(chapterId);
        if (!ch) { bump(); continue; }
        setFixLog(prev => [...prev, `Generating missing audio: ${ch.title}`]);
        const success = await generateAudio(ch, undefined, { upload: true });
        if (!success) errorCount++;
        bump();
      }

      // 3) Cleanup (only when safeToCleanup)
      if (fixOptions.cleanupStrays && plan.safeToCleanup) {
        if (abortFixRef.current) {
          setFixLog(p => [...p, "Cleanup aborted by user."]);
        } else if (errorCount > 0) {
          setFixLog(p => [...p, "SKIPPING CLEANUP: Errors occurred during restoration."]);
          pushNotice("Cleanup skipped for safety due to errors.", "error");
        } else {
          let cleanupCounter = 0;
          for (const stray of plan.cleanup) {
            if (abortFixRef.current) break;
            if (cleanupCounter % 10 === 0) {
              await yieldToUi();
            }
            cleanupCounter += 1;
            setFixLog(prev => [...prev, `Trashing stray file: ${stray.name}`]);
            try {
              await moveFileToTrash(stray.id);
            } catch {
              setFixLog(p => [...p, `Failed to trash ${stray.name}`]);
            }
            bump();
          }
        }
      }

      if (abortFixRef.current) {
        pushNotice("Fix operation stopped.", "info");
      } else if (errorCount === 0) {
        pushNotice("Fix complete. Run CHECK again to verify.", "success");
        setLastScan(null);
        setMissingTextIds([]);
        setMissingAudioIds([]);
        setLegacyGroups([]);
        setUnlinkedNewFormatFiles([]);
      }
    } catch (e: any) {
      pushNotice(`Fix failed: ${e?.message || e}`, "error", 6000);
    } finally {
      setIsFixing(false);
      abortFixRef.current = false;
    }
  };

  const handleVoiceSelect = (voiceId: string) => {
    const chId = showVoiceModal?.chapterId;
    if (onUpdateBookSettings && rememberAsDefault) onUpdateBookSettings({ ...book.settings, defaultVoiceId: voiceId });
    setShowVoiceModal(null);
    if (chId) {
      const chapter = chapters.find(c => c.id === chId);
      if (!chapter) return;

      // Mobile: queue background job instead of inline synthesis
      if (enableBackgroundJobs && onQueueGenerateJob) {
        void onQueueGenerateJob([chapter.id], voiceId);
        return;
      }

      generateAudio(chapter, voiceId, { upload: false });
    }
  };

  const handleCoverSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const reader = new FileReader();
      reader.onload = () => {
        const url = String(reader.result ?? "");
        onUpdateBook({ ...book, coverImage: url, updatedAt: Date.now() });
        if (coverInputRef.current) coverInputRef.current.value = "";
        void (async () => {
          if (book.backend !== StorageBackend.DRIVE || !driveFolderId) return;
          if (!isTokenValid()) return;
          try {
            const existingCoverId = await findFileSync("cover.jpg", driveFolderId);
            await uploadToDrive(
              driveFolderId,
              "cover.jpg",
              file,
              existingCoverId || undefined,
              file.type || "image/jpeg"
            );
          } catch (err: any) {
            pushNotice(`Cover sync failed: ${String(err?.message ?? err)}`, "error");
          }
        })();
      };
      reader.readAsDataURL(file);
    } catch (err: any) {
      pushNotice(`Cover upload failed: ${String(err?.message ?? err)}`, "error");
    }
  };

  const handleRemoveCover = useCallback(async () => {
    onUpdateBook({ ...book, coverImage: undefined, updatedAt: Date.now() });
    if (book.backend !== StorageBackend.DRIVE || !driveFolderId) return;
    if (!isTokenValid()) return;
    try {
      const existingCoverId = await findFileSync("cover.jpg", driveFolderId);
      if (existingCoverId) {
        await moveFileToTrash(existingCoverId);
      }
    } catch (err: any) {
      pushNotice(`Cover removal failed: ${String(err?.message ?? err)}`, "error");
    }
  }, [book, driveFolderId, onUpdateBook, pushNotice]);

  const renderAudioStatusIcon = (c: Chapter) => {
    const hasDriveAudio = !!(c.cloudAudioFileId || (c as any).audioDriveId);
    const hasLocalAudio = !!(c.hasCachedAudio || cachedAudioChapterIds.has(c.id));

    if (c.audioStatus === AudioStatus.FAILED) {
      return (
        <span title="Audio generation failed" className="inline-flex items-center">
          <AlertCircle className="w-4 h-4 text-red-500" />
        </span>
      );
    }
    if (synthesizingId === c.id || c.audioStatus === AudioStatus.GENERATING) {
      return (
        <span title="Generating audio..." className="inline-flex items-center">
          <Loader2 className="w-4 h-4 text-indigo-400 animate-spin" />
        </span>
      );
    }
    if (hasDriveAudio) {
      return (
        <span title="Audio ready on Google Drive" className="inline-flex items-center">
          <Cloud className="w-4 h-4 text-emerald-500" />
        </span>
      );
    }
    if (hasLocalAudio || c.audioStatus === AudioStatus.READY) {
      return (
        <span title="Audio ready locally" className="inline-flex items-center">
          <Headphones className="w-4 h-4 text-emerald-500" />
        </span>
      );
    }
    return (
      <span title="Audio missing" className="inline-flex items-center">
        <AlertTriangle className="w-4 h-4 text-amber-500" />
      </span>
    );
  };

  const renderTextStatusIcon = (c: Chapter) => {
    if (book.backend !== StorageBackend.DRIVE) return null;
    if (c.hasTextOnDrive === false) {
      return (
        <span title="Source text missing from Drive" className="inline-flex items-center ml-2">
          <FileX className="w-4 h-4 text-red-500" />
        </span>
      );
    }
    if (!c.cloudTextFileId) {
      return (
        <span title="Not synced to Drive" className="inline-flex items-center ml-2">
          <CloudOff className="w-4 h-4 text-amber-500" />
        </span>
      );
    }
    return null;
  };

  const getDisplayIndex = (c: Chapter, fallback: number) => {
    const idx = Number(c.index);
    if (Number.isFinite(idx) && idx > 0) return idx;
    const sortOrder = getChapterSortOrder(c);
    if (Number.isFinite(sortOrder) && sortOrder > 0) return sortOrder;
    return fallback > 0 ? fallback : 1;
  };

  const getDisplayTitle = (c: Chapter, idx: number) => {
    const raw = typeof c.title === "string" ? c.title.trim().replace(/^[\uFEFF\u200B]+/, "") : "";
    if (!raw || raw.toLowerCase().startsWith("imported")) {
      return `Chapter ${idx}`;
    }
    return raw;
  };

  const clearLongPressTimer = useCallback(() => {
    if (longPressTimerRef.current) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    longPressPointerIdRef.current = null;
    longPressStartRef.current = null;
    longPressChapterIdRef.current = null;
  }, []);

  const startLongPressSelection = useCallback(
    (event: React.PointerEvent, chapterId: string) => {
      if (book.settings?.enableSelectionMode === false || isOrganizeMode) return;
      if (event.pointerType === "mouse") return;
      if (typeof event.isPrimary === "boolean" && !event.isPrimary) return;
      clearLongPressTimer();
      longPressTriggeredRef.current = false;
      longPressPointerIdRef.current = event.pointerId;
      longPressStartRef.current = { x: event.clientX, y: event.clientY };
      longPressChapterIdRef.current = chapterId;
      longPressTimerRef.current = window.setTimeout(() => {
        if (longPressChapterIdRef.current !== chapterId) return;
        longPressTriggeredRef.current = true;
        if (!selectionMode) {
          setSelectionMode(true);
          setSelectedIds(new Set([chapterId]));
          setSelectionAnchorId(chapterId);
        } else {
          selectRangeTo(chapterId, true);
        }
        clearLongPressTimer();
      }, LONG_PRESS_MS);
    },
    [
      book.settings?.enableSelectionMode,
      clearLongPressTimer,
      isOrganizeMode,
      selectRangeTo,
      selectionMode,
    ]
  );

  const handleLongPressPointerMove = useCallback(
    (event: React.PointerEvent) => {
      if (!longPressTimerRef.current) return;
      if (typeof event.isPrimary === "boolean" && !event.isPrimary) return;
      if (event.pointerId !== longPressPointerIdRef.current) return;
      const start = longPressStartRef.current;
      if (!start) return;
      const dx = event.clientX - start.x;
      const dy = event.clientY - start.y;
      if ((dx * dx) + (dy * dy) > (LONG_PRESS_MOVE_THRESHOLD_PX * LONG_PRESS_MOVE_THRESHOLD_PX)) {
        clearLongPressTimer();
      }
    },
    [clearLongPressTimer]
  );

  const finishLongPressSelection = useCallback((event?: React.PointerEvent) => {
    if (event && longPressPointerIdRef.current != null && event.pointerId !== longPressPointerIdRef.current) {
      return;
    }
    clearLongPressTimer();
  }, [clearLongPressTimer]);

  const handleChapterActivate = useCallback(
    (chapter: Chapter, event?: React.MouseEvent) => {
      if (isOrganizeMode) return;
      if (selectionMode) {
        if (event?.shiftKey) {
          toggleChapterSelection(chapter.id, { range: true, additive: true });
        } else {
          toggleChapterSelection(chapter.id);
        }
        return;
      }

      const ctrlLike = !!(event?.ctrlKey || event?.metaKey);
      const wantsRange = !!event?.shiftKey && book.settings?.enableSelectionMode !== false;
      if (wantsRange && selectionAnchorId) {
        setSelectionMode(true);
        toggleChapterSelection(chapter.id, { range: true, additive: true });
        return;
      }
      if (ctrlLike && book.settings?.enableSelectionMode !== false) {
        toggleChapterSelection(chapter.id);
        return;
      }

      onOpenChapter(chapter.id);
    },
    [book.settings?.enableSelectionMode, isOrganizeMode, onOpenChapter, selectionAnchorId, selectionMode, toggleChapterSelection]
  );

  const handleChapterContextMenu = useCallback(
    (chapter: Chapter, event: React.MouseEvent) => {
      event.preventDefault();
      if (longPressTriggeredRef.current) {
        longPressTriggeredRef.current = false;
        return;
      }
      if (book.settings?.enableSelectionMode === false || isOrganizeMode) return;
      const nativeMouse = event.nativeEvent as MouseEvent;
      if (nativeMouse.button !== 2) return;
      toggleChapterSelection(chapter.id);
    },
    [book.settings?.enableSelectionMode, isOrganizeMode, toggleChapterSelection]
  );

  const renderDetailChapterRow = useCallback(
    (c: Chapter, fallbackLocalIndex: number, style?: React.CSSProperties) => {
      const displayIndex = getDisplayIndex(
        c,
        Number.isFinite(Number(c.index)) && Number(c.index) > 0 ? Number(c.index) : fallbackLocalIndex
      );
      const displayTitle = getDisplayTitle(c, displayIndex);
      const isCompleted = c.isCompleted || false;
      let percent = c.progress !== undefined ? Math.floor(c.progress * 100) : 0;
      if (playbackSnapshot && playbackSnapshot.chapterId === c.id) {
        percent = Math.floor(playbackSnapshot.percent * 100);
      }
      if (isCompleted) {
        percent = 100;
      }
      const isEditing = editingChapterId === c.id;
      const isSelected = selectedIds.has(c.id);
      const showCheckbox = selectionMode;
      const canDragRows = isOrganizeMode && book.settings?.allowDragReorderChapters !== false;

      return (
        <div
          style={style ? { ...style, width: "100%" } : undefined}
          data-chapter-id={c.id}
          onClick={(event) => {
            if (longPressTriggeredRef.current) {
              longPressTriggeredRef.current = false;
              return;
            }
            if (!isEditing) handleChapterActivate(c, event);
          }}
          onContextMenu={(event) => handleChapterContextMenu(c, event)}
          onPointerDown={(event) => {
            startLongPressSelection(event, c.id);
          }}
          onPointerMove={handleLongPressPointerMove}
          onPointerUp={finishLongPressSelection}
          onPointerCancel={finishLongPressSelection}
          draggable={canDragRows}
          onDragStart={() => {
            if (!canDragRows) return;
            setDraggingChapterId(c.id);
          }}
          onDragEnd={() => {
            setDraggingChapterId(null);
            setDraggingVolumeName(null);
          }}
          onDragOver={(event) => {
            if (!canDragRows || !draggingChapterId || draggingChapterId === c.id) return;
            event.preventDefault();
          }}
          onDrop={async (event) => {
            if (!canDragRows || !draggingChapterId || draggingChapterId === c.id) return;
            event.preventDefault();
            await reorderWithinVolume(draggingChapterId, c.id);
            setDraggingChapterId(null);
          }}
          className={`px-4 py-3 sm:px-6 sm:py-4 cursor-pointer border-b last:border-0 transition-colors ${
            isDark ? "hover:bg-white/5 border-slate-800" : "hover:bg-black/5 border-black/5"
          } ${isCompleted ? "opacity-50" : ""} ${isSelected ? (isDark ? "bg-indigo-500/20" : "bg-indigo-100") : ""}`}
        >
          <div className="flex items-start gap-3">
            <div className={`shrink-0 flex items-center gap-2 pt-0.5 ${textSecondary}`}>
              {showCheckbox ? (
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => toggleChapterSelection(c.id)}
                  onClick={(event) => event.stopPropagation()}
                  className="accent-indigo-600"
                />
              ) : null}
              {canDragRows ? <GripVertical className="w-3 h-3 opacity-40" /> : null}
              <span
                className={`font-mono text-xs font-black px-2 py-1 rounded-full ${
                  isDark ? "bg-slate-900 text-indigo-300" : "bg-indigo-50 text-indigo-700"
                }`}
              >
                {String(displayIndex).padStart(3, "0")}
              </span>
            </div>

            <div className="flex-1 min-w-0">
              {isEditing ? (
                <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                  <input
                    autoFocus
                    type="text"
                    value={tempTitle}
                    onChange={(e) => setTempTitle(e.target.value)}
                    onBlur={() => {
                      onUpdateChapterTitle(c.id, tempTitle);
                      setEditingChapterId(null);
                    }}
                    className="px-2 py-1 rounded border text-sm font-bold w-full bg-inherit"
                  />
                </div>
              ) : (
                <div className="font-black text-sm leading-tight line-clamp-2 flex items-center">
                  <span className="truncate">{displayTitle}</span>
                  {renderTextStatusIcon(c)}
                </div>
              )}
              <div className={`mt-2 h-1 w-full rounded-full overflow-hidden ${isDark ? "bg-slate-700" : "bg-black/5"}`}>
                <div
                  className={`h-full transition-all duration-300 ${isCompleted ? "bg-emerald-500" : "bg-indigo-500"}`}
                  style={{ width: `${percent}%` }}
                />
              </div>
            </div>

            <div className="shrink-0 flex flex-col items-end gap-2 pl-1">
              <span
                className={`text-[10px] font-black px-2 py-0.5 rounded-full ${
                  isCompleted ? "bg-emerald-500/20 text-emerald-600" : "bg-indigo-500/15 text-indigo-500"
                }`}
              >
                {isCompleted ? "Done" : `${percent}%`}
              </span>
              <div className="flex items-center gap-1.5">
                <span className="inline-flex">{renderAudioStatusIcon(c)}</span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setMobileMenuId(c.id);
                  }}
                  title="Chapter menu"
                  className="p-1.5 opacity-40 hover:opacity-100"
                >
                  <MoreVertical className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>
        </div>
      );
    },
            [
      editingChapterId,
      handleChapterActivate,
      handleChapterContextMenu,
      handleLongPressPointerMove,
      isOrganizeMode,
      isDark,
      onUpdateChapterTitle,
      playbackSnapshot,
      reorderWithinVolume,
      renderAudioStatusIcon,
      renderTextStatusIcon,
      selectedIds,
      selectionMode,
      startLongPressSelection,
      finishLongPressSelection,
      tempTitle,
      toggleChapterSelection,
      textSecondary,
      book.settings?.allowDragReorderChapters,
      draggingChapterId,
    ]
  );

  const MobileChapterMenu = ({ chapterId }: { chapterId: string }) => {
    const ch = chapters.find(c => c.id === chapterId);
    if (!ch) return null;
    return (
      <div className="fixed inset-0 z-[110] flex items-end sm:items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={() => setMobileMenuId(null)}>
        <div className={`w-full max-w-sm rounded-[2rem] shadow-2xl p-6 overflow-hidden animate-in slide-in-from-bottom-4 duration-200 ${isDark ? 'bg-slate-900 border border-white/10' : 'bg-white'}`} onClick={e => e.stopPropagation()}>
           <div className="flex justify-between items-center mb-6">
              <h3 className="text-sm font-black uppercase tracking-widest opacity-60">Chapter Options</h3>
              <button onClick={() => setMobileMenuId(null)} className="p-2 opacity-40"><X className="w-5 h-5" /></button>
           </div>
           <div className="space-y-2">
              <button
                onClick={() => { setMobileMenuId(null); setEditingChapterId(ch.id); setTempTitle(ch.title); }}
                title="Edit title"
                className={`w-full flex items-center gap-4 p-4 rounded-2xl font-black text-sm transition-all ${isDark ? 'hover:bg-white/5' : 'hover:bg-black/5'}`}
              >
                <div className="p-2 bg-indigo-600/10 text-indigo-600 rounded-lg"><Edit2 className="w-4 h-4" /></div>
                Edit Title
              </button>
           </div>
        </div>
      </div>
    );
  };

  const renderDetailsView = () => {
    const renderTableHeader = () => {
      if (isMobileInterface) return null;
      return (
        <div
          className={`grid grid-cols-[40px_1fr_80px_100px] md:grid-cols-[40px_1fr_100px_180px] px-6 py-3 text-[10px] font-black uppercase tracking-widest border-b ${
            isDark ? "border-slate-800 bg-slate-950/40 text-indigo-400" : "border-black/5 bg-black/5 text-indigo-600"
          }`}
        >
          <div>Idx</div>
          <div>Title</div>
          <div className="text-right px-4">Progress</div>
          <div className="text-right">Actions</div>
        </div>
      );
    };

    return (
      <div className="space-y-4">
        {volumeSections.volumes.map((group) => {
          const isCollapsed = !!collapsedVolumes[group.volumeName];
          const canReorderVolumes = isOrganizeMode && book.settings?.allowDragReorderVolumes !== false;
          const canMoveToVolume = isOrganizeMode && book.settings?.allowDragMoveToVolume !== false;
          return (
            <div key={group.volumeName} className={`rounded-3xl border shadow-sm overflow-hidden ${cardBg}`}>
              <div
                className={`w-full px-6 py-3 flex items-center justify-between border-b ${
                  isDark ? "border-slate-800 bg-slate-950/30" : "border-black/5 bg-black/5"
                }`}
                draggable={canReorderVolumes}
                onDragStart={() => {
                  if (!canReorderVolumes) return;
                  setDraggingVolumeName(group.volumeName);
                }}
                onDragEnd={() => setDraggingVolumeName(null)}
                onDragOver={(event) => {
                  if ((canReorderVolumes && draggingVolumeName && draggingVolumeName !== group.volumeName) || (canMoveToVolume && draggingChapterId)) {
                    event.preventDefault();
                  }
                }}
                onDrop={async (event) => {
                  if (canReorderVolumes && draggingVolumeName && draggingVolumeName !== group.volumeName) {
                    event.preventDefault();
                    reorderVolumes(draggingVolumeName, group.volumeName);
                    setDraggingVolumeName(null);
                    return;
                  }
                  if (canMoveToVolume && draggingChapterId) {
                    event.preventDefault();
                    await moveChapterToVolume(draggingChapterId, group.volumeName);
                    setDraggingChapterId(null);
                  }
                }}
              >
                <div className="text-left flex items-center gap-2 min-w-0">
                  {canReorderVolumes ? <GripVertical className="w-4 h-4 opacity-40" /> : null}
                  <button
                    onClick={() =>
                      setCollapsedVolumes((p) => {
                        const next = { ...p, [group.volumeName]: !p[group.volumeName] };
                        upsertBookSettings({ collapsedVolumes: next });
                        return next;
                      })
                    }
                    className="text-xs opacity-70 hover:opacity-100"
                    title={isCollapsed ? "Expand" : "Collapse"}
                  >
                    {isCollapsed ? <ChevronDown className="w-4 h-4" /> : <ChevronUp className="w-4 h-4" />}
                  </button>
                  <div className="min-w-0">
                    <div className="text-[10px] font-black uppercase tracking-widest opacity-70 truncate">{group.volumeName}</div>
                    <div className="text-[10px] font-bold opacity-50">
                      {group.chapters.length} chapters{isCollapsed ? " (collapsed)" : ""}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => void renameVolume(group.volumeName)}
                    className="p-2 opacity-40 hover:opacity-100"
                    title="Rename volume"
                  >
                    <Edit2 className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => void deleteVolumeToUngrouped(group.volumeName)}
                    className="p-2 opacity-40 hover:opacity-100 text-red-500"
                    title="Delete volume"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
              {isCollapsed ? null : (
                <>
                  {renderTableHeader()}
                  <div className="divide-y divide-black/5">
                    {group.chapters.map((chapter, idx) => (
                      <React.Fragment key={chapter.id}>
                        {renderDetailChapterRow(chapter, idx + 1)}
                      </React.Fragment>
                    ))}
                  </div>
                </>
              )}
            </div>
          );
        })}

        {volumeSections.ungrouped.length > 0 && (
          <div className="space-y-2">
            <div className="px-2 text-[10px] font-black uppercase tracking-widest opacity-60">Chapters</div>
            <div className={`rounded-3xl border shadow-sm overflow-hidden ${cardBg}`}>
              {renderTableHeader()}
              <div className="divide-y divide-black/5">
                {volumeSections.ungrouped.map((chapter, idx) => (
                  <React.Fragment key={chapter.id}>
                    {renderDetailChapterRow(chapter, idx + 1)}
                  </React.Fragment>
                ))}
              </div>
            </div>
          </div>
        )}

        {isOrganizeMode && book.settings?.allowDragMoveToVolume !== false && (
          <div
            className={`rounded-2xl border border-dashed px-4 py-6 text-center text-[10px] font-black uppercase tracking-widest ${
              isDark ? "border-slate-700 text-slate-300" : "border-black/20 text-slate-600"
            }`}
            onDragOver={(event) => {
              if (!draggingChapterId) return;
              event.preventDefault();
            }}
            onDrop={async (event) => {
              if (!draggingChapterId) return;
              event.preventDefault();
              await moveChapterToVolume(draggingChapterId, undefined);
              setDraggingChapterId(null);
            }}
          >
            Drop Here To Ungroup
          </div>
        )}

        {!volumeSections.volumes.length && !volumeSections.ungrouped.length && (
          <div className={`rounded-3xl border shadow-sm overflow-hidden ${cardBg} p-6 text-sm font-bold ${subtleText}`}>
            No chapters yet.
          </div>
        )}

        {hasMoreChapters && (
          <div ref={loadMoreSentinelRef} className={`py-4 text-center text-xs ${subtleText}`}>
            {isLoadingMoreChapters ? "Loading more..." : "Scroll to load more"}
          </div>
        )}
      </div>
    );
  };

  const renderGridView = () => (
    <div className="space-y-6">
      {volumeSections.volumes.map((group) => {
        const isCollapsed = !!collapsedVolumes[group.volumeName];
        const canReorderVolumes = isOrganizeMode && book.settings?.allowDragReorderVolumes !== false;
        const canMoveToVolume = isOrganizeMode && book.settings?.allowDragMoveToVolume !== false;
        return (
          <div key={group.volumeName} className="space-y-3">
            <div
              className={`px-3 py-2 rounded-2xl cursor-pointer flex items-center justify-between ${
                isDark ? "bg-white/5 hover:bg-white/10" : "bg-black/5 hover:bg-black/10"
              }`}
              draggable={canReorderVolumes}
              onDragStart={() => {
                if (!canReorderVolumes) return;
                setDraggingVolumeName(group.volumeName);
              }}
              onDragEnd={() => setDraggingVolumeName(null)}
              onDragOver={(event) => {
                if ((canReorderVolumes && draggingVolumeName && draggingVolumeName !== group.volumeName) || (canMoveToVolume && draggingChapterId)) {
                  event.preventDefault();
                }
              }}
              onDrop={async (event) => {
                if (canReorderVolumes && draggingVolumeName && draggingVolumeName !== group.volumeName) {
                  event.preventDefault();
                  reorderVolumes(draggingVolumeName, group.volumeName);
                  setDraggingVolumeName(null);
                  return;
                }
                if (canMoveToVolume && draggingChapterId) {
                  event.preventDefault();
                  await moveChapterToVolume(draggingChapterId, group.volumeName);
                  setDraggingChapterId(null);
                }
              }}
            >
              <div className="min-w-0 flex items-center gap-2">
                {canReorderVolumes ? <GripVertical className="w-4 h-4 opacity-40" /> : null}
                <div className="text-xs font-black uppercase tracking-widest opacity-70 truncate">{group.volumeName}</div>
                <div className="text-[10px] font-bold opacity-40">
                  {group.chapters.length} chapters{isCollapsed ? " (collapsed)" : ""}
                </div>
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={(event) => {
                    event.stopPropagation();
                    setCollapsedVolumes((p) => {
                      const next = { ...p, [group.volumeName]: !p[group.volumeName] };
                      upsertBookSettings({ collapsedVolumes: next });
                      return next;
                    });
                  }}
                  className="p-1.5 opacity-60 hover:opacity-100"
                >
                  {isCollapsed ? <ChevronDown className="w-4 h-4" /> : <ChevronUp className="w-4 h-4" />}
                </button>
                <button
                  onClick={(event) => {
                    event.stopPropagation();
                    void renameVolume(group.volumeName);
                  }}
                  className="p-1.5 opacity-60 hover:opacity-100"
                >
                  <Edit2 className="w-4 h-4" />
                </button>
                <button
                  onClick={(event) => {
                    event.stopPropagation();
                    void deleteVolumeToUngrouped(group.volumeName);
                  }}
                  className="p-1.5 opacity-60 hover:opacity-100 text-red-500"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
            {isCollapsed ? null : (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
                {group.chapters.map((c, idx) => {
                  const displayIndex = getDisplayIndex(c, idx + 1);
                  const displayTitle = getDisplayTitle(c, displayIndex);
                  let percent = c.progress !== undefined ? Math.floor(c.progress * 100) : 0;
                  if (playbackSnapshot && playbackSnapshot.chapterId === c.id) {
                    percent = Math.floor(playbackSnapshot.percent * 100);
                  }
                  const isCompleted = c.isCompleted || false;
                  if (isCompleted) {
                    percent = 100;
                  }
                  return (
                    <div
                      key={c.id}
                      data-chapter-id={c.id}
                      onClick={(event) => {
                        if (longPressTriggeredRef.current) {
                          longPressTriggeredRef.current = false;
                          return;
                        }
                        handleChapterActivate(c, event as any);
                      }}
                      onContextMenu={(event) => handleChapterContextMenu(c, event as any)}
                      onPointerDown={(event) => {
                        startLongPressSelection(event, c.id);
                      }}
                      onPointerMove={handleLongPressPointerMove}
                      onPointerUp={finishLongPressSelection}
                      onPointerCancel={finishLongPressSelection}
                      draggable={isOrganizeMode && book.settings?.allowDragReorderChapters !== false}
                      onDragStart={() => {
                        if (!(isOrganizeMode && book.settings?.allowDragReorderChapters !== false)) return;
                        setDraggingChapterId(c.id);
                      }}
                      onDragEnd={() => setDraggingChapterId(null)}
                      onDragOver={(event) => {
                        if (!(isOrganizeMode && book.settings?.allowDragReorderChapters !== false)) return;
                        if (!draggingChapterId || draggingChapterId === c.id) return;
                        event.preventDefault();
                      }}
                      onDrop={async (event) => {
                        if (!(isOrganizeMode && book.settings?.allowDragReorderChapters !== false)) return;
                        if (!draggingChapterId || draggingChapterId === c.id) return;
                        event.preventDefault();
                        await reorderWithinVolume(draggingChapterId, c.id);
                        setDraggingChapterId(null);
                      }}
                      className={`aspect-square p-4 rounded-3xl border flex flex-col items-center justify-center text-center gap-2 cursor-pointer transition-all hover:scale-105 group relative ${cardBg}`}
                    >
                      {selectionMode ? (
                        <div className="absolute top-3 left-3">
                          <input
                            type="checkbox"
                            checked={selectedIds.has(c.id)}
                            onChange={() => toggleChapterSelection(c.id)}
                            onClick={(event) => event.stopPropagation()}
                            className="accent-indigo-600"
                          />
                        </div>
                      ) : null}
                      <div className="absolute top-3 right-3 flex gap-1">
                        {renderTextStatusIcon(c)}
                        {renderAudioStatusIcon(c)}
                      </div>
                      <div
                        className={`w-12 h-12 rounded-2xl flex items-center justify-center font-mono text-lg font-black mb-1 ${
                          isDark ? "bg-slate-950 text-indigo-400" : "bg-indigo-50 text-indigo-600"
                        }`}
                      >
                        {displayIndex}
                      </div>
                      <div className="font-black text-xs line-clamp-2 leading-tight px-1">{displayTitle}</div>
                      <div className="mt-2 w-full px-4">
                        <div className={`h-1 w-full rounded-full overflow-hidden ${isDark ? "bg-slate-700" : "bg-black/5"}`}>
                          <div className="h-full bg-indigo-500 transition-all duration-300" style={{ width: `${percent}%` }} />
                        </div>
                        <div className="text-[8px] font-black uppercase mt-1">{percent}%</div>
                      </div>
                      <div className="md:hidden absolute bottom-2 left-0 right-0 flex justify-center gap-2 px-2">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setMobileMenuId(c.id);
                          }}
                          title="Chapter menu"
                          className="p-2 bg-black/5 rounded-xl opacity-60"
                        >
                          <MoreVertical className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
      {volumeSections.ungrouped.length > 0 && (
        <div className="space-y-2">
          <div className="px-2 text-[10px] font-black uppercase tracking-widest opacity-60">Chapters</div>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
            {volumeSections.ungrouped.map((c, idx) => {
              const displayIndex = getDisplayIndex(c, idx + 1);
              const displayTitle = getDisplayTitle(c, displayIndex);
              let percent = c.progress !== undefined ? Math.floor(c.progress * 100) : 0;
              if (playbackSnapshot && playbackSnapshot.chapterId === c.id) {
                percent = Math.floor(playbackSnapshot.percent * 100);
              }
              const isCompleted = c.isCompleted || false;
              if (isCompleted) {
                percent = 100;
              }
              return (
                <div
                  key={c.id}
                  data-chapter-id={c.id}
                  onClick={(event) => {
                    if (longPressTriggeredRef.current) {
                      longPressTriggeredRef.current = false;
                      return;
                    }
                    handleChapterActivate(c, event as any);
                  }}
                  onContextMenu={(event) => handleChapterContextMenu(c, event as any)}
                  onPointerDown={(event) => {
                    startLongPressSelection(event, c.id);
                  }}
                  onPointerMove={handleLongPressPointerMove}
                  onPointerUp={finishLongPressSelection}
                  onPointerCancel={finishLongPressSelection}
                  draggable={isOrganizeMode && book.settings?.allowDragReorderChapters !== false}
                  onDragStart={() => {
                    if (!(isOrganizeMode && book.settings?.allowDragReorderChapters !== false)) return;
                    setDraggingChapterId(c.id);
                  }}
                  onDragEnd={() => setDraggingChapterId(null)}
                  onDragOver={(event) => {
                    if (!(isOrganizeMode && book.settings?.allowDragReorderChapters !== false)) return;
                    if (!draggingChapterId || draggingChapterId === c.id) return;
                    event.preventDefault();
                  }}
                  onDrop={async (event) => {
                    if (!(isOrganizeMode && book.settings?.allowDragReorderChapters !== false)) return;
                    if (!draggingChapterId || draggingChapterId === c.id) return;
                    event.preventDefault();
                    await reorderWithinVolume(draggingChapterId, c.id);
                    setDraggingChapterId(null);
                  }}
                  className={`aspect-square p-4 rounded-3xl border flex flex-col items-center justify-center text-center gap-2 cursor-pointer transition-all hover:scale-105 group relative ${cardBg}`}
                >
                  {selectionMode ? (
                    <div className="absolute top-3 left-3">
                      <input
                        type="checkbox"
                        checked={selectedIds.has(c.id)}
                        onChange={() => toggleChapterSelection(c.id)}
                        onClick={(event) => event.stopPropagation()}
                        className="accent-indigo-600"
                      />
                    </div>
                  ) : null}
                  <div className="absolute top-3 right-3 flex gap-1">
                    {renderTextStatusIcon(c)}
                    {renderAudioStatusIcon(c)}
                  </div>
                  <div
                    className={`w-12 h-12 rounded-2xl flex items-center justify-center font-mono text-lg font-black mb-1 ${
                      isDark ? "bg-slate-950 text-indigo-400" : "bg-indigo-50 text-indigo-600"
                    }`}
                  >
                    {displayIndex}
                  </div>
                  <div className="font-black text-xs line-clamp-2 leading-tight px-1">{displayTitle}</div>
                  <div className="mt-2 w-full px-4">
                    <div className={`h-1 w-full rounded-full overflow-hidden ${isDark ? "bg-slate-700" : "bg-black/5"}`}>
                      <div className="h-full bg-indigo-500 transition-all duration-300" style={{ width: `${percent}%` }} />
                    </div>
                    <div className="text-[8px] font-black uppercase mt-1">{percent}%</div>
                  </div>
                  <div className="md:hidden absolute bottom-2 left-0 right-0 flex justify-center gap-2 px-2">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setMobileMenuId(c.id);
                      }}
                      title="Chapter menu"
                      className="p-2 bg-black/5 rounded-xl opacity-60"
                    >
                      <MoreVertical className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
      {isOrganizeMode && book.settings?.allowDragMoveToVolume !== false && (
        <div
          className={`rounded-2xl border border-dashed px-4 py-6 text-center text-[10px] font-black uppercase tracking-widest ${
            isDark ? "border-slate-700 text-slate-300" : "border-black/20 text-slate-600"
          }`}
          onDragOver={(event) => {
            if (!draggingChapterId) return;
            event.preventDefault();
          }}
          onDrop={async (event) => {
            if (!draggingChapterId) return;
            event.preventDefault();
            await moveChapterToVolume(draggingChapterId, undefined);
            setDraggingChapterId(null);
          }}
        >
          Drop Here To Ungroup
        </div>
      )}
      {hasMoreChapters && (
        <div ref={loadMoreSentinelRef} className={`py-4 text-center text-xs ${subtleText}`}>
          {isLoadingMoreChapters ? "Loading more..." : "Scroll to load more"}
        </div>
      )}
    </div>
  );

  const hasIssues = scanHasIssues(lastScan);

  const planPreview = buildFixPlan({
    includeConversions: fixOptions.convertLegacy,
    includeGeneration: fixOptions.genAudio,
    includeCleanup: fixOptions.cleanupStrays
  });
  const legacyTextCount = planPreview.conversions.filter(c => c.type === "text").length;
  const legacyAudioCount = planPreview.conversions.filter(c => c.type === "audio").length;
  const generateCount = planPreview.generationIds.length;
  const cleanupCount = planPreview.safeToCleanup ? planPreview.cleanup.length : 0;

  return (
    <div className={`h-full min-h-0 flex flex-col ${isDark ? 'bg-slate-900 text-slate-100' : isSepia ? 'bg-[#f4ecd8] text-[#3c2f25]' : 'bg-white text-black'}`}>
      <input ref={coverInputRef} type="file" accept="image/*" className="hidden" onChange={handleCoverSelected} />

      {showVoiceModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className={`w-full max-w-md rounded-3xl shadow-2xl p-8 space-y-6 ${isDark ? 'bg-slate-900 border border-slate-800' : 'bg-white border border-black/5'}`}>
            <div className="flex justify-between items-center"><h3 className="text-xl font-black tracking-tight">Select Cloud Voice</h3><button onClick={() => setShowVoiceModal(null)} className="p-2 opacity-60 hover:opacity-100"><X className="w-5 h-5" /></button></div>
            <div className="space-y-4">
              <div className="flex items-center gap-3 p-3 bg-black/5 rounded-xl"><input type="checkbox" id="rememberDefault" checked={rememberAsDefault} onChange={e => setRememberAsDefault(e.target.checked)} className="w-4 h-4 accent-indigo-600" /><label htmlFor="rememberDefault" className="text-xs font-black uppercase tracking-tight opacity-70 cursor-pointer">Set as book default</label></div>
              <div className="space-y-2 max-h-[40vh] overflow-y-auto pr-1">
                {CLOUD_VOICES.map(v => (<button key={v.id} onClick={() => handleVoiceSelect(v.id)} className={`w-full p-4 rounded-xl border-2 text-left font-black text-sm transition-all flex justify-between items-center ${isDark ? 'border-slate-800 hover:border-indigo-600 bg-slate-950/40' : 'border-slate-100 hover:border-indigo-600 bg-slate-50'}`}>{v.name}<Headphones className="w-4 h-4 opacity-40" /></button>))}
              </div>
            </div>
          </div>
        </div>
      )}

      {showBookSettings && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-3 sm:p-4 bg-black/60 backdrop-blur-sm overflow-y-auto">
          <div
            data-testid="book-settings-modal"
            className={`w-full max-w-lg rounded-[2rem] shadow-2xl flex max-h-[calc(100dvh-1rem)] sm:max-h-[calc(100dvh-2rem)] flex-col overflow-hidden ${isDark ? 'bg-slate-900 border border-slate-800' : 'bg-white border border-black/5'}`}
          >
            <div className={`sticky top-0 z-10 px-5 sm:px-6 py-4 flex items-center justify-between border-b ${isDark ? "border-white/10 bg-slate-900/95" : "border-black/10 bg-white/95"}`}>
              <div>
                <div className="text-[10px] font-black uppercase tracking-widest opacity-60">Book Settings</div>
                <div className="text-xl font-black tracking-tight">{book.title}</div>
              </div>
              <button
                onClick={() => setShowBookSettings(false)}
                title="Close Book Settings"
                aria-label="Close Book Settings"
                className="p-2 opacity-60 hover:opacity-100"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div
              data-testid="book-settings-scroll"
              className="flex-1 overflow-y-auto overscroll-contain px-5 sm:px-6 py-5 space-y-6 pb-[calc(env(safe-area-inset-bottom)+1rem)]"
              style={{ WebkitOverflowScrolling: "touch" }}
            >
            <div className="space-y-3">
              <div className="text-[10px] font-black uppercase tracking-widest opacity-60">Cover</div>
              {book.coverImage ? (
                <button
                  onClick={() => coverInputRef.current?.click()}
                  title="Change cover"
                  className={`group flex items-center gap-4 p-2 rounded-2xl border transition-colors ${isDark ? 'border-white/10 hover:border-white/20' : 'border-black/10 hover:border-black/20'}`}
                >
                  <img src={book.coverImage} alt={`${book.title} cover`} className="w-16 h-20 object-cover rounded-xl shadow" />
                  <div className="text-left">
                    <div className="text-[10px] font-black uppercase tracking-widest opacity-60">Cover</div>
                    <div className="text-sm font-black">Tap to change</div>
                  </div>
                </button>
              ) : (
                <button
                  onClick={() => coverInputRef.current?.click()}
                  className={`${primaryActionClass}`}
                  title="Add cover image"
                >
                  Add Cover
                </button>
              )}
            </div>

            <div className="space-y-3">
              <div className="text-[10px] font-black uppercase tracking-widest opacity-60">Display</div>
              <div className={`p-4 rounded-2xl border ${isDark ? "border-white/10 bg-white/5" : "border-black/10 bg-black/5"}`}>
                <div className="text-xs font-black mb-2">Chapter Layout</div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => onUpdateBookSettings?.({ chapterLayout: "sections" })}
                    className={`px-3 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest ${viewMode === "sections" ? "bg-indigo-600 text-white" : "bg-black/5"}`}
                  >
                    Sections
                  </button>
                  <button
                    onClick={() => onUpdateBookSettings?.({ chapterLayout: "grid" })}
                    className={`px-3 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest ${viewMode === "grid" ? "bg-indigo-600 text-white" : "bg-black/5"}`}
                  >
                    Grid
                  </button>
                </div>
              </div>
            </div>

            <div className="space-y-3">
              <div className="text-[10px] font-black uppercase tracking-widest opacity-60">Organize</div>
              {[
                { key: "enableSelectionMode", label: "Enable Selection Mode", value: book.settings?.enableSelectionMode !== false },
                { key: "enableOrganizeMode", label: "Enable Organize Mode", value: book.settings?.enableOrganizeMode !== false },
                { key: "allowDragReorderChapters", label: "Drag Reorder Chapters", value: book.settings?.allowDragReorderChapters !== false },
                { key: "allowDragMoveToVolume", label: "Drag Move To Volume", value: book.settings?.allowDragMoveToVolume !== false },
                { key: "allowDragReorderVolumes", label: "Drag Reorder Volumes", value: book.settings?.allowDragReorderVolumes !== false },
              ].map((item) => (
                <label
                  key={item.key}
                  className={`flex items-center justify-between gap-4 p-4 rounded-2xl border ${
                    isDark ? "border-white/10 bg-white/5" : "border-black/10 bg-black/5"
                  }`}
                >
                  <div className="text-xs font-black">{item.label}</div>
                  <input
                    type="checkbox"
                    checked={item.value}
                    onChange={(e) => onUpdateBookSettings?.({ [item.key]: e.target.checked })}
                    className="w-5 h-5 accent-indigo-600"
                  />
                </label>
              ))}
            </div>

            <div className="space-y-3">
              <div className="text-[10px] font-black uppercase tracking-widest opacity-60">Audio and Upload</div>
              {[
                { key: "autoGenerateAudioOnAdd", label: "Auto-generate On Add", help: "Generate chapter audio automatically when new chapters are added.", value: book.settings?.autoGenerateAudioOnAdd !== false },
                { key: "autoUploadOnAdd", label: "Auto-upload On Add", help: "Queue chapter upload automatically after add.", value: book.settings?.autoUploadOnAdd === true },
              ].map((item) => (
                <label
                  key={item.key}
                  className={`flex items-center justify-between gap-4 p-4 rounded-2xl border ${
                    isDark ? "border-white/10 bg-white/5" : "border-black/10 bg-black/5"
                  }`}
                >
                  <div>
                    <div className="text-xs font-black">{item.label}</div>
                    <div className="text-[10px] opacity-60">{item.help}</div>
                  </div>
                  <input
                    type="checkbox"
                    checked={item.value}
                    onChange={(e) => onUpdateBookSettings?.({ [item.key]: e.target.checked })}
                    className="w-5 h-5 accent-indigo-600"
                  />
                </label>
              ))}
              <button
                onClick={() => {
                  setRememberAsDefault(true);
                  setShowVoiceModal({});
                }}
                className="w-full px-4 py-3 rounded-2xl border border-indigo-600/20 text-indigo-600 text-[10px] font-black uppercase tracking-widest hover:bg-indigo-50"
              >
                Default Voice: {book.settings?.defaultVoiceId || "Not set"}
              </button>
            </div>

            <div className="space-y-3">
              <div className="text-[10px] font-black uppercase tracking-widest opacity-60">Safety</div>
              <label
                className={`flex items-center justify-between gap-4 p-4 rounded-2xl border ${
                  isDark ? "border-white/10 bg-white/5" : "border-black/10 bg-black/5"
                }`}
              >
                <div>
                  <div className="text-xs font-black">Confirm Bulk Delete</div>
                  <div className="text-[10px] opacity-60">Ask for confirmation before deleting selected chapters.</div>
                </div>
                <input
                  type="checkbox"
                  checked={book.settings?.confirmBulkDelete !== false}
                  onChange={(e) => onUpdateBookSettings?.({ confirmBulkDelete: e.target.checked })}
                  className="w-5 h-5 accent-indigo-600"
                />
              </label>
            </div>

            <div className="space-y-3">
              <div className="text-[10px] font-black uppercase tracking-widest opacity-60">Primary Actions</div>
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() => { setShowBookSettings(false); onToggleUploadQueue(); }}
                  className={`${accentButtonClass} px-3 flex items-center gap-2`}
                  title="View offline uploads"
                >
                  <Eye className="w-3.5 h-3.5" />
                  View uploads
                </button>
              </div>
            </div>

            <div className="space-y-3">
              <button
                onClick={() => setShowBookMoreActions((v) => !v)}
                className={`w-full flex items-center justify-between px-4 py-3 rounded-2xl border text-[10px] font-black uppercase tracking-widest ${isDark ? 'border-white/10 hover:bg-white/5' : 'border-black/10 hover:bg-black/5'}`}
                title="Show more actions"
              >
                More Actions
                {showBookMoreActions ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
              </button>
              {showBookMoreActions && (
                <div className="space-y-4">
                  <div className="space-y-2">
                    <div className="text-[10px] font-black uppercase tracking-widest opacity-60">Background Tools</div>
                    <div className="flex flex-wrap gap-2">
                      <button
                        onClick={handleRegenerateAudio}
                        disabled={isRegeneratingAudio}
                        title="Regenerate audio for this book"
                        className={`px-4 py-2 rounded-xl bg-white text-indigo-600 border border-indigo-600/20 text-[10px] font-black uppercase tracking-widest flex items-center gap-2 transition-all ${isRegeneratingAudio ? 'cursor-not-allowed opacity-60' : 'hover:bg-indigo-50'}`}
                      >
                        {isRegeneratingAudio ? <Loader2 className="w-3.5 h-3.5 animate-spin text-indigo-600" /> : <RotateCcw className="w-4 h-4 text-indigo-600" />}
                        {isRegeneratingAudio ? 'Regenerating...' : 'Regenerate Audio'}
                      </button>
                      <button
                        onClick={handleInitManifests}
                        disabled={isInitManifests}
                        title="Initialize Drive manifests"
                        className={`px-4 py-2 rounded-xl bg-white text-indigo-600 border border-indigo-600/20 text-[10px] font-black uppercase tracking-widest flex items-center gap-2 transition-all ${isInitManifests ? 'cursor-not-allowed opacity-60' : 'hover:bg-indigo-50'}`}
                      >
                        {isInitManifests ? <Loader2 className="w-3.5 h-3.5 animate-spin text-indigo-600" /> : <Cloud className="w-4 h-4 text-indigo-600" />}
                        {isInitManifests ? 'Initializing...' : 'Init Manifests'}
                      </button>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] font-black uppercase tracking-widest opacity-60">Uploads</span>
                      <span className="text-[10px] font-black tracking-widest text-indigo-400">{uploadedChapterCount} uploaded - {uploadQueueCount} pending</span>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button
                        onClick={onUploadAllChapters}
                        disabled={isUploadingAll}
                        title="Upload all chapters to Drive"
                        className={`px-4 py-2 rounded-xl font-black uppercase tracking-widest text-[10px] transition-all flex items-center gap-2 ${isUploadingAll ? 'bg-indigo-500/60 text-white cursor-not-allowed shadow-none' : isDark ? 'bg-indigo-500 text-white hover:bg-indigo-400 shadow-lg' : 'bg-indigo-600 text-white hover:bg-indigo-500 shadow-lg'}`}
                      >
                        {isUploadingAll ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Cloud className="w-3.5 h-3.5" />}
                        {isUploadingAll ? 'Uploading...' : 'Upload all chapters'}
                      </button>
                    </div>
                  </div>

                  {book.coverImage && (
                    <button
                      onClick={handleRemoveCover}
                      className={`${accentButtonClass}`}
                      title="Remove cover image"
                    >
                      Remove Cover
                    </button>
                  )}
                </div>
              )}
            </div>

            <div className="space-y-3">
              <div className="text-[10px] font-black uppercase tracking-widest opacity-60">Danger Zone</div>
              <button
                onClick={() => {
                  if (confirm(`Delete '${book.title}' and all chapters?`)) {
                    onDeleteBook(book.id);
                  }
                }}
                className="px-4 py-2 rounded-xl bg-red-600/10 text-red-600 text-[10px] font-black uppercase tracking-widest"
              >
                Delete Book
              </button>
            </div>
            </div>
          </div>
        </div>
      )}

      {mobileMenuId && <MobileChapterMenu chapterId={mobileMenuId} />}

      {showFixModal && lastScan && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm overflow-y-auto">
          <div className={`w-full max-w-2xl rounded-[2.5rem] shadow-2xl p-8 lg:p-12 space-y-8 animate-in zoom-in-95 ${isDark ? 'bg-slate-900 border border-white/10' : 'bg-white'}`}>
             <div className="flex justify-between items-start"><div><h3 className="text-2xl font-black tracking-tight flex items-center gap-3"><Wrench className="w-7 h-7 text-indigo-600" /> Fix & Cleanup Cloud Folder</h3><p className="text-xs font-bold opacity-50 uppercase tracking-widest mt-2">Book: {book.title}</p></div>{!isFixing && <button onClick={() => setShowFixModal(false)} className="p-3 bg-black/5 rounded-full hover:bg-black/10"><X className="w-6 h-6" /></button>}</div>
             <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
               <div className="p-4 rounded-2xl bg-indigo-600/5 border border-indigo-600/10 flex flex-col gap-1"><span className="text-[10px] font-black uppercase text-indigo-600">Missing Text</span><span className="text-2xl font-black">{lastScan.missingTextIds.length}</span></div>
               <div className="p-4 rounded-2xl bg-amber-600/5 border border-amber-600/10 flex flex-col gap-1"><span className="text-[10px] font-black uppercase text-amber-600">Missing Audio</span><span className="text-2xl font-black">{lastScan.missingAudioIds.length}</span></div>
               <div className="p-4 rounded-2xl bg-red-600/5 border border-red-600/10 flex flex-col gap-1"><span className="text-[10px] font-black uppercase text-red-600">Stray Files</span><span className="text-2xl font-black">{lastScan.strayFiles.length}</span></div>
               <div className="p-4 rounded-2xl bg-purple-600/5 border border-purple-600/10 flex flex-col gap-1"><span className="text-[10px] font-black uppercase text-purple-600">Legacy</span><span className="text-2xl font-black">{(lastScan as any).legacyCount || 0}</span></div>
             </div>
             <div className="space-y-4"><label className="text-[10px] font-black uppercase tracking-widest opacity-60">Actions to Perform</label>
               <div className="space-y-3">
                 <label className="flex items-center gap-4 p-4 rounded-2xl border-2 border-black/5 cursor-pointer hover:bg-black/5 transition-colors"><input type="checkbox" className="w-5 h-5 accent-indigo-600" checked={fixOptions.convertLegacy} onChange={e => setFixOptions(o => ({...o, convertLegacy: e.target.checked}))} /><div><div className="text-sm font-black">Convert Legacy Files</div><p className="text-[10px] opacity-60 uppercase font-bold">Create expected files from legacy matches</p></div></label>
                 <label className="flex items-center gap-4 p-4 rounded-2xl border-2 border-black/5 cursor-pointer hover:bg-black/5 transition-colors"><input type="checkbox" className="w-5 h-5 accent-indigo-600" checked={fixOptions.genAudio} onChange={e => setFixOptions(o => ({...o, genAudio: e.target.checked}))} /><div><div className="text-sm font-black">Generate Missing Audio</div><p className="text-[10px] opacity-60 uppercase font-bold">Synthesize and upload MP3s</p></div></label>
                 <label className="flex items-center gap-4 p-4 rounded-2xl border-2 border-black/5 cursor-pointer hover:bg-black/5 transition-colors"><input type="checkbox" className="w-5 h-5 accent-indigo-600" checked={fixOptions.cleanupStrays} onChange={e => setFixOptions(o => ({...o, cleanupStrays: e.target.checked}))} /><div><div className="text-sm font-black">Cleanup Book Folder</div><p className="text-[10px] opacity-60 uppercase font-bold">Move unrecognized files to trash</p></div></label>
               </div>
             </div>
             {isMobileInterface && onSyncNativeLibrary && (
               <div className="border rounded-2xl p-4 bg-black/5 space-y-3">
                 <div className="text-[10px] font-black uppercase tracking-widest opacity-60">Native DB Sync</div>
                 <button
                   onClick={async () => {
                     setIsSyncingNative(true);
                     setSyncSummary(null);
                     try {
                       const res = await onSyncNativeLibrary({
                         bookId: book.id,
                         chapterIds: book.chapters.map((c) => c.id),
                       });
                       setSyncSummary(res);
                       pushNotice("Library synced to native DB.", "success");
                     } catch (e: any) {
                       pushNotice(`Native DB sync failed: ${String(e?.message ?? e)}`, "error", 6000);
                     } finally {
                       setIsSyncingNative(false);
                     }
                   }}
                   disabled={isSyncingNative}
                   className={`w-full py-3 rounded-xl font-black uppercase text-[10px] tracking-widest ${
                     isSyncingNative ? "bg-slate-400 cursor-not-allowed" : "bg-indigo-600 text-white hover:bg-indigo-500"
                   }`}
                 >
                   {isSyncingNative ? "Syncing..." : "Sync Library to Native DB"}
                 </button>
                 {syncSummary && (
                   <div className="text-[10px] font-black uppercase tracking-widest opacity-70">
                      {syncSummary.books} books - {syncSummary.chapters} chapters - {syncSummary.texts} texts - {syncSummary.failures} failures
                   </div>
                 )}
               </div>
             )}

             <div className="border rounded-2xl p-4 bg-black/5 space-y-2">
               <span className="text-[10px] font-black uppercase opacity-40">Preview</span>
               <div className="text-xs font-bold flex items-center gap-2 text-purple-600"><Sparkles className="w-3 h-3" /> Will create {legacyTextCount} text files from legacy</div>
               <div className="text-xs font-bold flex items-center gap-2 text-purple-600"><Sparkles className="w-3 h-3" /> Will create {legacyAudioCount} audio files from legacy</div>
               <div className="text-xs font-bold flex items-center gap-2 text-amber-600"><Headphones className="w-3 h-3" /> Will generate {generateCount} audios</div>
               <div className="text-xs font-bold flex items-center gap-2 text-red-600"><History className="w-3 h-3" /> Will move {cleanupCount} files to trash</div>
               {fixOptions.cleanupStrays && !planPreview.safeToCleanup && (
                 <div className="text-[10px] font-bold uppercase text-red-600">Cleanup disabled (not safe yet)</div>
               )}
             </div>
             {isFixing ? (
               <div className="space-y-4 pt-4">
                <div className="flex justify-between items-center">
                  <span className="text-sm font-black">Restoring Integrity...</span>
                  <span className="text-xs font-mono font-black">{fixProgress.current} / {fixProgress.total}</span>
                </div>
                <div className="h-3 w-full bg-black/5 rounded-full overflow-hidden">
                  <div className="h-full bg-indigo-600 transition-all duration-300" style={{ width: `${fixProgress.total ? (fixProgress.current / fixProgress.total) * 100 : 0}%` }} />
                </div>
                {isMobileInterface && activeFixJob && (
                  <div className="flex items-center justify-between text-[10px] font-black uppercase tracking-widest opacity-70">
                    <span>Status: {activeFixJob.status}</span>
                    <button onClick={onRefreshJobs} className="text-indigo-500">Refresh</button>
                  </div>
                )}
                <button
                  onClick={() => {
                    if (isMobileInterface && activeFixJob?.jobId) {
                      onCancelJob(activeFixJob.jobId);
                      pushNotice("Cancel requested.", "info");
                      return;
                    }
                    abortFixRef.current = true;
                  }}
                  className="w-full py-3 mt-2 bg-red-500/10 text-red-600 rounded-xl font-black uppercase text-[10px] tracking-widest hover:bg-red-500/20"
                >
                  Stop Fix
                </button>
               </div>
             ) : (
               <div className="grid grid-cols-2 gap-4">
                 <button onClick={() => setShowFixModal(false)} className="py-4 rounded-2xl font-black uppercase text-[10px] tracking-widest border-2 hover:bg-black/5">Cancel</button>
                 <div className="flex flex-col gap-2">
                   <button disabled={previewOnly} onClick={handleRunFix} className={`py-4 text-white rounded-2xl font-black uppercase text-[10px] tracking-widest shadow-xl transition-all ${previewOnly ? 'bg-slate-400 cursor-not-allowed' : 'bg-indigo-600 hover:scale-[1.02] active:scale-95'}`}>Start Fixing</button>
                   <label className="flex items-center justify-center gap-2 cursor-pointer opacity-60 hover:opacity-100 transition-opacity"><input type="checkbox" checked={previewOnly} onChange={e => setPreviewOnly(e.target.checked)} className="accent-indigo-600" /><span className="text-[10px] font-black uppercase">Preview Only (Safe Mode)</span></label>
                 </div>
               </div>
             )}
          </div>
        </div>
      )}

      <div className={`sticky top-0 z-50 border-b border-black/5 backdrop-blur-md transition-all duration-300 ${stickyHeaderBg}`}>
        {selectionMode ? (
          <div className="p-4 sm:p-5 flex items-center justify-between gap-3">
            <button
              onClick={closeSelectionMode}
              className="p-2 rounded-xl bg-black/5 hover:bg-black/10"
              title="Close selection"
            >
              <X className="w-4 h-4" />
            </button>
            <div className="font-black text-xs uppercase tracking-widest">
              {selectedIds.size} selected
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={handleSelectAllVisible}
                className="p-2 rounded-xl bg-black/5 hover:bg-black/10"
                title="Select all visible"
              >
                <CheckSquare className="w-4 h-4" />
              </button>
              <button
                onClick={handleInvertVisibleSelection}
                className="p-2 rounded-xl bg-black/5 hover:bg-black/10"
                title="Invert selection"
              >
                <Repeat2 className="w-4 h-4" />
              </button>
            </div>
          </div>
        ) : (
          <div className="p-3 sm:p-4 flex items-center justify-between gap-3">
            <button
              onClick={onBackToLibrary}
              className="p-2 rounded-xl bg-black/5 hover:bg-black/10"
              title="Back"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => setShowSearchBar((v) => !v)}
                className="p-2 rounded-xl bg-black/5 hover:bg-black/10"
                title="Search"
              >
                <Search className="w-4 h-4" />
              </button>
              <div className="flex items-center gap-1 p-1 rounded-xl bg-black/5">
                <button
                  onClick={() => setViewMode("sections")}
                  className={`p-1.5 rounded-lg transition-all ${
                    viewMode === "sections" ? "bg-white shadow-sm text-indigo-600" : "opacity-40"
                  }`}
                  title="Sections"
                >
                  <AlignJustify className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={() => setViewMode("grid")}
                  className={`p-1.5 rounded-lg transition-all ${
                    viewMode === "grid" ? "bg-white shadow-sm text-indigo-600" : "opacity-40"
                  }`}
                  title="Grid"
                >
                  <LayoutGrid className="w-3.5 h-3.5" />
                </button>
              </div>
              <button
                onClick={() => setShowBookSettings(true)}
                className="p-2 rounded-xl bg-black/5 hover:bg-black/10"
                title="Book settings"
              >
                <GearIcon className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}
        {!selectionMode && showSearchBar ? (
          <div className="px-4 sm:px-6 pb-3">
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search chapters..."
              className={`w-full px-3 py-2 rounded-xl border ${isDark ? "bg-slate-900 border-slate-700" : "bg-white border-black/10"}`}
            />
          </div>
        ) : null}
      </div>

      {!selectionMode ? (
        <div className="p-4 sm:p-6 lg:p-8 flex flex-col gap-4">
          <div className={`rounded-3xl border p-4 sm:p-5 ${cardBg}`}>
            <div className="flex items-start gap-4">
              <div className="w-16 sm:w-20 aspect-[2/3] rounded-2xl overflow-hidden shadow-lg flex-shrink-0 bg-indigo-600/10 flex items-center justify-center">
                {book.coverImage ? (
                  <img src={book.coverImage} className="w-full h-full object-cover" alt={book.title} />
                ) : (
                  <ImageIcon className="w-6 h-6 opacity-20" />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <h1 className="font-black tracking-tight text-lg sm:text-2xl truncate">{book.title}</h1>
                <div className="mt-1 flex items-center gap-2 text-[10px] font-black uppercase tracking-widest opacity-70">
                  <span>{syncBadge.backendLabel}</span>
                  <span
                    className={`inline-flex items-center gap-1 ${
                      syncBadge.tone === "emerald"
                        ? "text-emerald-500"
                        : syncBadge.tone === "amber"
                          ? "text-amber-500"
                          : syncBadge.tone === "indigo"
                            ? "text-indigo-500"
                            : "text-slate-500"
                    }`}
                  >
                    {syncBadge.statusLabel === "SYNCING" ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : syncBadge.statusLabel === "PAUSED" ? (
                      <AlertCircle className="w-3 h-3" />
                    ) : syncBadge.statusLabel === "NOT SYNCED" ? (
                      <CloudOff className="w-3 h-3" />
                    ) : syncBadge.statusLabel === "SYNCED" ? (
                      <Cloud className="w-3 h-3" />
                    ) : (
                      <FolderSync className="w-3 h-3" />
                    )}
                    {syncBadge.statusLabel === "NOT SYNCED"
                      ? "Not synced"
                      : syncBadge.statusLabel === "SYNCING"
                        ? "Syncing"
                        : syncBadge.statusLabel === "PAUSED"
                          ? "Paused"
                        : syncBadge.statusLabel === "SYNCED"
                          ? "Synced"
                          : "Local"}
                  </span>
                </div>
                <div className="mt-1 text-[10px] font-black uppercase tracking-widest opacity-50">
                  {(book.chapterCount ?? book.chapters.length)} chapters
                  {lastSavedAt ? ` • Last saved ${new Date(lastSavedAt).toLocaleTimeString()}` : ""}
                </div>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <button onClick={onAddChapter} className="flex-1 sm:flex-none px-4 py-2 sm:px-6 sm:py-3 bg-indigo-600 text-white rounded-xl sm:rounded-2xl font-black uppercase text-[9px] sm:text-[10px] tracking-widest shadow-xl hover:scale-105 active:scale-95 transition-all flex items-center justify-center gap-2"><Plus className="w-3.5 h-3.5" /> Add</button>
            <button
              onClick={() => {
                if (book.settings?.enableOrganizeMode === false) {
                  pushNotice("Organize mode disabled in Book Settings.", "info");
                  return;
                }
                setIsOrganizeMode((v) => !v);
                setSelectionMode(false);
                setSelectedIds(new Set());
              }}
              className={`flex-1 sm:flex-none px-4 py-2 sm:px-6 sm:py-3 rounded-xl sm:rounded-2xl font-black uppercase text-[9px] sm:text-[10px] tracking-widest transition-all flex items-center justify-center gap-2 ${
                isOrganizeMode
                  ? "bg-indigo-600 text-white shadow-xl hover:scale-105 active:scale-95"
                  : "bg-white text-indigo-600 border border-indigo-600/20 shadow-lg hover:bg-indigo-50 active:scale-95"
              }`}
              title={isOrganizeMode ? "Done organizing" : "Organize chapters"}
            >
              <Edit2 className="w-3.5 h-3.5" /> {isOrganizeMode ? "Done" : "Edit"}
            </button>
            <button onClick={handleCheckIntegrity} disabled={isCheckingDrive} className="flex-1 sm:flex-none px-4 py-2 sm:px-6 sm:py-3 bg-white text-indigo-600 border border-indigo-600/20 rounded-xl sm:rounded-2xl font-black uppercase text-[9px] sm:text-[10px] tracking-widest shadow-lg hover:bg-indigo-50 active:scale-95 transition-all flex items-center justify-center gap-2">{isCheckingDrive ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}{isCheckingDrive ? '...' : 'Check'}</button>
            <button
              onClick={() => void handleReindexChapters()}
              className="flex-1 sm:flex-none px-4 py-2 sm:px-6 sm:py-3 bg-white text-indigo-600 border border-indigo-600/20 rounded-xl sm:rounded-2xl font-black uppercase text-[9px] sm:text-[10px] tracking-widest shadow-lg hover:bg-indigo-50 active:scale-95 transition-all flex items-center justify-center gap-2"
            >
              <RefreshCw className="w-3.5 h-3.5" /> Reindex
            </button>
            <button
              disabled={!hasIssues}
              className={hasIssues ? "flex-1 sm:flex-none px-4 py-2 sm:px-6 sm:py-3 bg-orange-500 text-white rounded-xl sm:rounded-2xl font-black uppercase text-[9px] sm:text-[10px] tracking-widest shadow-xl hover:scale-105 active:scale-95 transition-all flex items-center justify-center gap-2" : "flex-1 sm:flex-none px-4 py-2 sm:px-6 sm:py-3 bg-orange-500/40 text-white/60 rounded-xl sm:rounded-2xl font-black uppercase text-[9px] sm:text-[10px] tracking-widest cursor-not-allowed flex items-center justify-center gap-2"}
              onClick={() => setShowFixModal(true)}
            >
              <Wrench className="w-3.5 h-3.5" /> Fix
            </button>
            {isOrganizeMode ? (
              <button onClick={handleAddVolume} className="flex-1 sm:flex-none px-4 py-2 sm:px-6 sm:py-3 bg-white text-indigo-600 border border-indigo-600/20 rounded-xl sm:rounded-2xl font-black uppercase text-[9px] sm:text-[10px] tracking-widest shadow-lg hover:bg-indigo-50 active:scale-95 transition-all flex items-center justify-center gap-2">
                <Plus className="w-3.5 h-3.5" /> Add Volume
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {notice && (
        <div className="px-4 sm:px-6">
          <div
            className={`mt-3 px-4 py-3 rounded-2xl text-xs font-black tracking-tight ${
              notice.kind === 'error'
                ? 'bg-red-600/10 text-red-700 border border-red-600/20'
                : notice.kind === 'success'
                ? 'bg-emerald-600/10 text-emerald-700 border border-emerald-600/20'
                : 'bg-indigo-600/10 text-indigo-700 border border-indigo-600/20'
            }`}
          >
            {notice.message}
          </div>
        </div>
      )}

      {bgGenProgress && (
        <div className="px-4 sm:px-6 mt-3">
          <div className={`p-4 rounded-2xl border ${isDark ? 'border-slate-800 bg-slate-900/60' : 'border-black/5 bg-white'}`}>
            <div className="flex items-center justify-between text-xs font-black uppercase tracking-widest">
              <span>Generating Audio</span>
              <span>{bgGenProgress.current} / {bgGenProgress.total}</span>
            </div>
            <div className={`mt-3 h-2 w-full rounded-full overflow-hidden ${isDark ? 'bg-slate-800' : 'bg-black/5'}`}>
              <div className="h-full bg-indigo-600 transition-all duration-300" style={{ width: `${bgGenProgress.total ? (bgGenProgress.current / bgGenProgress.total) * 100 : 0}%` }} />
            </div>
          </div>
        </div>
      )}

      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className="flex-1 px-4 sm:px-6 py-6 sm:py-8 overflow-y-auto"
      >
        {chapters.length === 0 ? (
          <div className="p-12 text-center text-xs font-black opacity-30 uppercase">No chapters found</div>
        ) : (
          viewMode === "sections" ? renderDetailsView() : renderGridView()
        )}
      </div>

      {selectionMode ? (
        <div className={`sticky bottom-0 z-50 border-t p-3 sm:p-4 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] ${isDark ? 'bg-slate-900/95 border-slate-700' : 'bg-white/95 border-black/10'}`}>
          <div className="grid grid-cols-5 gap-2">
            <button onClick={() => void handleBulkUpload()} disabled={!selectedIds.size || !canBulkUpload} className={`px-2 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest ${selectedIds.size && canBulkUpload ? 'bg-black/5 hover:bg-black/10' : 'opacity-40 bg-black/5 cursor-not-allowed'}`}><Cloud className="w-4 h-4 mx-auto mb-1" />Upload</button>
            <button onClick={() => void handleBulkRegenerateAudio()} disabled={!selectedIds.size} className={`px-2 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest ${selectedIds.size ? 'bg-black/5 hover:bg-black/10' : 'opacity-40 bg-black/5 cursor-not-allowed'}`}><Headphones className="w-4 h-4 mx-auto mb-1" />Regen Audio</button>
            <button onClick={() => void handleBulkMarkCompleted()} disabled={!selectedIds.size} className={`px-2 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest ${selectedIds.size ? 'bg-black/5 hover:bg-black/10' : 'opacity-40 bg-black/5 cursor-not-allowed'}`}><Check className="w-4 h-4 mx-auto mb-1" />Done</button>
            <button onClick={() => void handleBulkResetProgress()} disabled={!selectedIds.size} className={`px-2 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest ${selectedIds.size ? 'bg-black/5 hover:bg-black/10' : 'opacity-40 bg-black/5 cursor-not-allowed'}`}><RotateCcw className="w-4 h-4 mx-auto mb-1" />Reset</button>
            <button onClick={() => void handleBulkDelete()} disabled={!selectedIds.size} className={`px-2 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest ${selectedIds.size ? 'bg-red-500/10 text-red-600 hover:bg-red-500/20' : 'opacity-40 bg-black/5 cursor-not-allowed'}`}><Trash2 className="w-4 h-4 mx-auto mb-1" />Delete</button>
          </div>
          {bulkActionProgress ? (
            <div className="mt-2 text-[10px] font-black uppercase tracking-widest opacity-70 text-center">
              {bulkActionProgress.label} {bulkActionProgress.current} of {bulkActionProgress.total}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};

export default ChapterFolderView;
