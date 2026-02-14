import React, { useMemo, useState, useEffect, useCallback, useRef, useTransition } from 'react';
import { VariableSizeList, type ListChildComponentProps } from "react-window";
import { Book, Theme, StorageBackend, Chapter, AudioStatus, CLOUD_VOICES, ScanResult, StrayFile, Rule, UiMode, JobRecord } from '../types';
import { Eye, Plus, Edit2, RefreshCw, Trash2, Headphones, Loader2, Cloud, CloudOff, AlertTriangle, X, RotateCcw, FileX, AlertCircle, Wrench, Check, History, Trash, ChevronDown, ChevronUp, Sparkles, MoreVertical, GripVertical, FolderSync } from 'lucide-react';
import BookTopBar from "./book/BookTopBar";
import SelectionBar from "./book/SelectionBar";
import BookHero from "./book/BookHero";
import BulkActionDock from "./book/BulkActionDock";
import ChapterList from "./book/ChapterList";
import ChapterGrid from "./book/ChapterGrid";
import { hasAudioInCache } from '../services/audioCache';
import { useNotifySimple } from "../hooks/useNotify";
import { useBookState } from "../src/features/library/BookState";
import { useSelectionGesture } from "../hooks/useSelectionGesture";
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
const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
const lerp = (start: number, end: number, t: number) => start + (end - start) * t;

type GroupPos = "single" | "first" | "middle" | "last";
type SectionListItem =
  | { type: "volume-header"; id: string; volumeName: string; chapterCount: number; isCollapsed: boolean; groupPos: GroupPos }
  | { type: "chapter-row"; id: string; chapter: Chapter; fallbackIndex: number; groupPos: GroupPos }
  | { type: "ungrouped-label"; id: string }
  | { type: "spacer"; id: string; size: number }
  | { type: "load-more"; id: string };
type GroupedSectionItem = Extract<SectionListItem, { groupPos: GroupPos }>;

type GridListItem =
  | { type: "volume-header"; id: string; volumeName: string; chapterCount: number; isCollapsed: boolean }
  | { type: "grid-row"; id: string; chapters: Array<{ chapter: Chapter; localIndex: number }> }
  | { type: "ungrouped-label"; id: string }
  | { type: "spacer"; id: string; size: number }
  | { type: "load-more"; id: string };

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
  const [, startViewModeTransition] = useTransition();
  const listWrapperRef = useRef<HTMLDivElement>(null);
  const [listViewport, setListViewport] = useState({ width: 0, height: 0 });
  const coverCardRef = useRef<HTMLDivElement | null>(null);
  const coverRowRef = useRef<HTMLDivElement | null>(null);
  const coverImageRef = useRef<HTMLDivElement | null>(null);
  const coverMetaRef = useRef<HTMLDivElement | null>(null);
  const coverCollapseRef = useRef(-1);
  const coverRafRef = useRef<number | null>(null);

  useEffect(() => { localStorage.setItem(VIEW_MODE_KEY, viewMode); }, [viewMode, VIEW_MODE_KEY]);
  useEffect(() => {
    const el = listWrapperRef.current;
    if (!el) return;
    const update = () => {
      const nextWidth = el.clientWidth;
      const nextHeight = el.clientHeight;
      setListViewport((prev) =>
        prev.width === nextWidth && prev.height === nextHeight
          ? prev
          : { width: nextWidth, height: nextHeight }
      );
    };
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => update());
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!onUpdateBookSettings) return;
    const current = book.settings?.chapterLayout === "grid" ? "grid" : "sections";
    if (current === viewMode) return;
    let cancelled = false;
    let timeoutId: number | null = null;
    const requestIdle = (window as any).requestIdleCallback as undefined | ((cb: () => void, opts?: { timeout?: number }) => number);
    const cancelIdle = (window as any).cancelIdleCallback as undefined | ((id: number) => void);
    const persist = () => {
      if (cancelled) return;
      onUpdateBookSettings({ chapterLayout: viewMode });
    };
    if (requestIdle) {
      const idleId = requestIdle(() => persist(), { timeout: 500 });
      return () => {
        cancelled = true;
        if (cancelIdle) cancelIdle(idleId);
      };
    }
    timeoutId = window.setTimeout(persist, 250);
    return () => {
      cancelled = true;
      if (timeoutId) window.clearTimeout(timeoutId);
    };
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

  const pushNotice = useNotifySimple();

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
  const [isOrganizeMode, setIsOrganizeMode] = useState(false);
  const [bulkActionProgress, setBulkActionProgress] = useState<{ label: string; current: number; total: number } | null>(null);
  const [draggingChapterId, setDraggingChapterId] = useState<string | null>(null);
  const [draggingVolumeName, setDraggingVolumeName] = useState<string | null>(null);
  const [mobileMenuId, setMobileMenuId] = useState<string | null>(null);
  const [cachedAudioChapterIds, setCachedAudioChapterIds] = useState<Set<string>>(() => new Set());
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const sectionsListRef = useRef<VariableSizeList>(null);
  const gridListRef = useRef<VariableSizeList>(null);
  const viewScrollRef = useRef<ViewScrollState>({ sections: 0, grid: 0 });
  const lastViewModeRef = useRef<ViewMode>(viewMode);
  const restoreKeyRef = useRef<string | null>(null);
  const [bgGenProgress, setBgGenProgress] = useState<{ current: number; total: number } | null>(null);
  const [isRegeneratingAudio, setIsRegeneratingAudio] = useState(false);
  const [showBookSettings, setShowBookSettings] = useState(false);
  const [showBookMoreActions, setShowBookMoreActions] = useState(false);
  const [showBookOverflow, setShowBookOverflow] = useState(false);
  const [showSelectionOverflow, setShowSelectionOverflow] = useState(false);
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
    startViewModeTransition(() => setViewMode(preferred));
  }, [book.id, book.settings?.chapterLayout]);

  useEffect(() => {
    return () => {
      if (coverRafRef.current !== null) {
        cancelAnimationFrame(coverRafRef.current);
        coverRafRef.current = null;
      }
    };
  }, []);

  const isDark = theme === Theme.DARK;
  const isSepia = theme === Theme.SEPIA;
  const cardSurface = isDark ? 'bg-slate-800' : isSepia ? 'bg-[#f4ecd8]' : 'bg-white';
  const cardBorder = isDark ? 'border-slate-700' : isSepia ? 'border-[#d8ccb6]' : 'border-black/10';
  const textSecondary = isDark ? 'text-slate-400' : isSepia ? 'text-[#3c2f25]/70' : 'text-slate-600';
  const subtleText = textSecondary;
  const stickyHeaderBg = 'glass-header';
  const accentButtonClass = `btn-secondary`;
  const primaryActionClass = `btn-primary`;
  const selectionRowClass = isDark ? "bg-indigo-500/30 ring-1 ring-indigo-400/50" : "bg-indigo-500/20 ring-1 ring-indigo-500/40";
  const isMobileInterface = computeMobileMode(uiMode);
  // Allow background-capable flows (WorkManager / native plugin) when we're in mobile mode.
  const enableBackgroundJobs = isMobileInterface;
  const listPaddingX = listViewport.width >= 640 ? 24 : 16;
  const listContentWidth = Math.max(0, listViewport.width - listPaddingX * 2);
  const useVirtualization = !isOrganizeMode && listViewport.width > 0 && listViewport.height > 0;
  const coverCollapseRange = 160;
  const coverIsWide = listViewport.width >= 640;
  const coverExpandedSize = coverIsWide ? 72 : 64;
  const coverCollapsedSize = coverIsWide ? 56 : 44;
  const coverExpandedPadding = coverIsWide ? 20 : 16;
  const coverCollapsedPadding = coverIsWide ? 12 : 10;
  const coverExpandedGap = coverIsWide ? 20 : 16;
  const coverCollapsedGap = coverIsWide ? 12 : 10;

  const screenPad = "px-4";
  const sectionGap = "gap-3";
  const cardRadius = "rounded-2xl";
  const cardPad = "p-4";
  const rowPad = "px-4 py-4";
  const tapTarget = "min-h-[44px] min-w-[44px]";
  const ListOuterElement = useMemo(() => {
    return React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(function ListOuterElement(
      { style, className, ...rest },
      ref
    ) {
      return <div ref={ref} className={className} style={{ ...style, boxSizing: "border-box" }} {...rest} />;
    });
  }, []);
  const { derived, selection } = useBookState({
    book,
    searchQuery,
    collapsedVolumes,
    selectionEnabled: book.settings?.enableSelectionMode !== false,
  });
  const { chapters, volumeSections, visibleChapters } = derived;
  const {
    selectionMode,
    selectedIds,
    anchorId: selectionAnchorId,
    replace: replaceSelection,
    enterSelection,
    toggle: toggleChapterSelection,
    rangeSelect: selectRangeTo,
    selectAll: handleSelectAllVisible,
    invert: handleInvertVisibleSelection,
    clear: clearSelection,
  } = selection;

  const closeSelectionMode = useCallback(() => {
    clearSelection();
    setShowSelectionOverflow(false);
  }, [clearSelection]);

  const applyCoverCollapse = useCallback(
    (scrollTop: number, force = false) => {
      if (selectionMode && !force) return;
      const card = coverCardRef.current;
      const row = coverRowRef.current;
      const image = coverImageRef.current;
      if (!card || !row || !image) return;
      const progress = clamp01(scrollTop / coverCollapseRange);
      if (!force && Math.abs(progress - coverCollapseRef.current) < 0.01) return;
      coverCollapseRef.current = progress;
      if (coverRafRef.current !== null) {
        cancelAnimationFrame(coverRafRef.current);
      }
      coverRafRef.current = requestAnimationFrame(() => {
        const padding = lerp(coverExpandedPadding, coverCollapsedPadding, progress);
        const gap = lerp(coverExpandedGap, coverCollapsedGap, progress);
        const size = lerp(coverExpandedSize, coverCollapsedSize, progress);
        card.style.padding = `${padding}px`;
        row.style.gap = `${gap}px`;
        image.style.width = `${size}px`;
        image.style.height = "auto";
        if (coverMetaRef.current) {
          coverMetaRef.current.style.opacity = String(1 - 0.4 * progress);
        }
        coverRafRef.current = null;
      });
    },
    [
      coverCollapseRange,
      coverCollapsedGap,
      coverCollapsedPadding,
      coverCollapsedSize,
      coverExpandedGap,
      coverExpandedPadding,
      coverExpandedSize,
      selectionMode,
    ]
  );

  useEffect(() => {
    if (book.settings?.enableSelectionMode === false && selectionMode) {
      clearSelection();
    }
    if (book.settings?.enableOrganizeMode === false && isOrganizeMode) {
      setIsOrganizeMode(false);
    }
  }, [book.settings?.enableSelectionMode, book.settings?.enableOrganizeMode, selectionMode, isOrganizeMode, clearSelection]);

  useEffect(() => {
    if (selectionMode) {
      setShowBookOverflow(false);
    }
  }, [selectionMode]);

  useEffect(() => {
    if (!selectionMode) {
      setShowSelectionOverflow(false);
    }
  }, [selectionMode]);

  const sectionRowHeight = isMobileInterface ? 76 : 84;
  const volumeHeaderHeight = isMobileInterface ? 56 : 64;
  const ungroupedLabelHeight = 24;
  const spacerHeight = isMobileInterface ? 12 : 16;
  const labelSpacerHeight = 8;
  const loadMoreHeight = 36;
  const gridVolumeHeaderHeight = isMobileInterface ? 44 : 48;

  const gridGap = isMobileInterface ? 16 : 18;
  const gridColumns = listViewport.width >= 1280 ? 6 : listViewport.width >= 1024 ? 5 : listViewport.width >= 768 ? 4 : listViewport.width >= 640 ? 3 : 2;
  const gridCardHeight = isMobileInterface ? 210 : 220;
  const gridRowHeight = gridCardHeight + gridGap;

  const sectionItems = useMemo<SectionListItem[]>(() => {
    const items: SectionListItem[] = [];
    const addGroup = (groupItems: GroupedSectionItem[]) => {
      if (!groupItems.length) return;
      groupItems.forEach((item, idx) => {
        const pos: GroupPos =
          groupItems.length === 1 ? "single" : idx === 0 ? "first" : idx === groupItems.length - 1 ? "last" : "middle";
        item.groupPos = pos;
      });
      items.push(...groupItems);
    };

    volumeSections.volumes.forEach((group, groupIdx) => {
      const isCollapsed = !!collapsedVolumes[group.volumeName];
      const groupItems: GroupedSectionItem[] = [];
      groupItems.push({
        type: "volume-header",
        id: `vol:${group.volumeName}`,
        volumeName: group.volumeName,
        chapterCount: group.chapters.length,
        isCollapsed,
        groupPos: "single",
      });
      if (!isCollapsed) {
        group.chapters.forEach((chapter, idx) => {
          groupItems.push({
            type: "chapter-row",
            id: `vol:${group.volumeName}:ch:${chapter.id}`,
            chapter,
            fallbackIndex: idx + 1,
            groupPos: "single",
          });
        });
      }
      addGroup(groupItems);
      const hasNextGroup = groupIdx < volumeSections.volumes.length - 1 || volumeSections.ungrouped.length > 0;
      if (hasNextGroup) {
        items.push({ type: "spacer", id: `spacer:vol:${group.volumeName}`, size: spacerHeight });
      }
    });

    if (volumeSections.ungrouped.length > 0) {
      items.push({ type: "ungrouped-label", id: "ungrouped-label" });
      items.push({ type: "spacer", id: "spacer:ungrouped-label", size: labelSpacerHeight });
      const groupItems: GroupedSectionItem[] = [];
      volumeSections.ungrouped.forEach((chapter, idx) => {
        groupItems.push({
          type: "chapter-row",
          id: `ungrouped:ch:${chapter.id}`,
          chapter,
          fallbackIndex: idx + 1,
          groupPos: "single",
        });
      });
      addGroup(groupItems);
    }

    if (hasMoreChapters) {
      items.push({ type: "load-more", id: "load-more" });
    }

    return items;
  }, [volumeSections, collapsedVolumes, isMobileInterface, hasMoreChapters, spacerHeight, labelSpacerHeight]);

  const sectionIndexByChapterId = useMemo(() => {
    const map = new Map<string, number>();
    sectionItems.forEach((item, idx) => {
      if (item.type === "chapter-row") map.set(item.chapter.id, idx);
    });
    return map;
  }, [sectionItems]);

  const gridItems = useMemo<GridListItem[]>(() => {
    const items: GridListItem[] = [];
    const addSpacer = (id: string, size: number) => items.push({ type: "spacer", id, size });
    const addGridRows = (prefix: string, chapters: Chapter[]) => {
      let row: Array<{ chapter: Chapter; localIndex: number }> = [];
      chapters.forEach((chapter, idx) => {
        row.push({ chapter, localIndex: idx + 1 });
        if (row.length >= gridColumns) {
          items.push({ type: "grid-row", id: `${prefix}:row:${items.length}`, chapters: row });
          row = [];
        }
      });
      if (row.length) {
        items.push({ type: "grid-row", id: `${prefix}:row:${items.length}`, chapters: row });
      }
    };

    volumeSections.volumes.forEach((group, idx) => {
      const isCollapsed = !!collapsedVolumes[group.volumeName];
      items.push({
        type: "volume-header",
        id: `vol:${group.volumeName}`,
        volumeName: group.volumeName,
        chapterCount: group.chapters.length,
        isCollapsed,
      });
      if (!isCollapsed) {
        addGridRows(`vol:${group.volumeName}`, group.chapters);
      }
      const hasNextGroup = idx < volumeSections.volumes.length - 1 || volumeSections.ungrouped.length > 0;
      if (hasNextGroup) addSpacer(`spacer:vol:${group.volumeName}`, spacerHeight);
    });

    if (volumeSections.ungrouped.length > 0) {
      items.push({ type: "ungrouped-label", id: "ungrouped-label" });
      addSpacer("spacer:ungrouped-label", labelSpacerHeight);
      addGridRows("ungrouped", volumeSections.ungrouped);
    }

    if (hasMoreChapters) {
      items.push({ type: "load-more", id: "load-more" });
    }

    return items;
  }, [volumeSections, collapsedVolumes, gridColumns, hasMoreChapters, spacerHeight, labelSpacerHeight]);

  const gridIndexByChapterId = useMemo(() => {
    const map = new Map<string, number>();
    gridItems.forEach((item, idx) => {
      if (item.type !== "grid-row") return;
      item.chapters.forEach(({ chapter }) => {
        map.set(chapter.id, idx);
      });
    });
    return map;
  }, [gridItems]);

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
    if (selectedIds.size === 0) return;
    const nextIds = new Set(
      Array.from(selectedIds).filter((id) => chapters.some((chapter) => chapter.id === id))
    );
    if (nextIds.size === selectedIds.size) return;
    replaceSelection(nextIds);
  }, [chapters, replaceSelection, selectedIds]);

  useEffect(() => {
    if (selectionMode && selectedIds.size === 0) {
      clearSelection();
    }
  }, [selectionMode, selectedIds, clearSelection]);

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

  const handleBackRequest = useCallback(() => {
    if (showBookSettings) {
      setShowBookSettings(false);
      return true;
    }
    if (showSelectionOverflow) {
      setShowSelectionOverflow(false);
      return true;
    }
    if (showBookOverflow) {
      setShowBookOverflow(false);
      return true;
    }
    if (selectionMode) {
      closeSelectionMode();
      return true;
    }
    return false;
  }, [showBookSettings, showSelectionOverflow, showBookOverflow, selectionMode, closeSelectionMode]);

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

  const handleBulkAssignVolume = useCallback(async () => {
    if (!selectedChapterList.length) return;
    const promptLabel =
      selectedChapterList.length === 1
        ? "Volume name for 1 chapter"
        : `Volume name for ${selectedChapterList.length} chapters`;
    const raw = prompt(promptLabel);
    if (raw == null) return;
    const name = raw.trim();
    if (!name) return;
    const now = Date.now();
    const updated = selectedChapterList.map((chapter) => ({
      ...chapter,
      volumeName: name,
      volumeLocalChapter: undefined,
      updatedAt: now,
    }));
    await persistChapters(updated);
    const current = Array.isArray(book.settings?.volumeOrder) ? [...book.settings.volumeOrder] : [];
    if (!current.includes(name)) {
      upsertBookSettings({ volumeOrder: [...current, name] });
    }
    closeSelectionMode();
  }, [book.settings?.volumeOrder, closeSelectionMode, persistChapters, selectedChapterList, upsertBookSettings]);

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
      return { backendLabel: "LOCAL", statusLabel: "LOCAL", tone: "slate" } as const;
    }
    if (hasInFlightBookJobs || uploadQueueCount > 0 || isUploadingAll || isCheckingDrive || isFixing || isRegeneratingAudio) {
      return { backendLabel: "DRIVE", statusLabel: "SYNCING", tone: "indigo" } as const;
    }
    if (hasPausedBookJobs) {
      return { backendLabel: "DRIVE", statusLabel: "PAUSED", tone: "amber" } as const;
    }
    if (isDirty) {
      return { backendLabel: "DRIVE", statusLabel: "NOT SYNCED", tone: "amber" } as const;
    }
    return { backendLabel: "DRIVE", statusLabel: "SYNCED", tone: "emerald" } as const;
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
    if (useVirtualization) return;
    if (!hasMoreChapters) return;
    if (!onLoadMoreChapters) return;
    if (typeof IntersectionObserver === "undefined") return;
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
  }, [useVirtualization, hasMoreChapters, onLoadMoreChapters, isLoadingMoreChapters]);

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    if (useVirtualization) return;
    const { scrollTop, scrollHeight, clientHeight } = e.currentTarget;
    viewScrollRef.current[viewMode] = scrollTop;
    onScrollPositionChange?.(scrollTop);
    applyCoverCollapse(scrollTop);
    if (scrollHeight - scrollTop - clientHeight < 200) {
      if (hasMoreChapters && !isLoadingMoreChapters && onLoadMoreChapters) {
        onLoadMoreChapters();
      }
    }
  }, [useVirtualization, hasMoreChapters, isLoadingMoreChapters, onLoadMoreChapters, onScrollPositionChange, viewMode, applyCoverCollapse]);

  useEffect(() => {
    lastViewModeRef.current = viewMode;

    window.requestAnimationFrame(() => {
      const nextScroll = viewScrollRef.current[viewMode] ?? 0;
      if (useVirtualization) {
        const listRef = viewMode === "sections" ? sectionsListRef.current : gridListRef.current;
        listRef?.scrollTo(nextScroll);
        applyCoverCollapse(nextScroll, true);
        return;
      }
      const container = scrollContainerRef.current;
      if (!container) return;
      container.scrollTop = nextScroll;
      applyCoverCollapse(nextScroll, true);
    });
  }, [viewMode, useVirtualization, applyCoverCollapse]);

  useEffect(() => {
    if (selectionMode) {
      applyCoverCollapse(0, true);
      return;
    }
    const nextScroll = viewScrollRef.current[viewMode] ?? 0;
    applyCoverCollapse(nextScroll, true);
  }, [selectionMode, viewMode, applyCoverCollapse]);

  useEffect(() => {
    if (!chapters.length) return;
    if (restoreScrollTop == null && !restoreChapterId && restoreChapterIndex == null) return;
    const key = [
      book.id,
      viewMode,
      restoreScrollTop ?? "none",
      restoreChapterId ?? restoreChapterIndex ?? "none",
      visibleChapters.length,
      useVirtualization ? "virtual" : "dom",
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

    if (useVirtualization) {
      const listRef = viewMode === "sections" ? sectionsListRef.current : gridListRef.current;
      if (!listRef) return;
      window.requestAnimationFrame(() => {
        if (targetChapterId) {
          const indexMap = viewMode === "sections" ? sectionIndexByChapterId : gridIndexByChapterId;
          const targetIndex = indexMap.get(targetChapterId);
          if (typeof targetIndex === "number") {
            listRef.scrollToItem(targetIndex, "center");
            return;
          }
        }
        if (typeof restoreScrollTop === "number") {
          listRef.scrollTo(restoreScrollTop);
        }
      });
      return;
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
    sectionIndexByChapterId,
    gridIndexByChapterId,
    useVirtualization,
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

  const handleToggleOrganize = useCallback(() => {
    if (book.settings?.enableOrganizeMode === false) {
      pushNotice("Organize mode disabled in Book Settings.", "info");
      return;
    }
    setIsOrganizeMode((v) => !v);
    clearSelection();
  }, [book.settings?.enableOrganizeMode, clearSelection, pushNotice]);

  const handleOpenSettingsFromMenu = useCallback(() => {
    setShowBookOverflow(false);
    setShowBookSettings(true);
  }, []);

  const handleMenuToggleOrganize = useCallback(() => {
    setShowBookOverflow(false);
    handleToggleOrganize();
  }, [handleToggleOrganize]);

  const handleMenuCheck = useCallback(() => {
    setShowBookOverflow(false);
    void handleCheckIntegrity();
  }, [handleCheckIntegrity]);

  const handleMenuReindex = useCallback(() => {
    setShowBookOverflow(false);
    void handleReindexChapters();
  }, [handleReindexChapters]);

  const handleMenuFix = useCallback(() => {
    setShowBookOverflow(false);
    setShowFixModal(true);
  }, []);

  const handleMenuAddVolume = useCallback(() => {
    setShowBookOverflow(false);
    void handleAddVolume();
  }, [handleAddVolume]);

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
    const hasAnyAudio = hasDriveAudio || hasLocalAudio || c.audioStatus === AudioStatus.READY;

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
    if (hasAnyAudio) {
      return (
        <span title="Audio ready" className="inline-flex items-center">
          <Cloud className="w-4 h-4 text-emerald-500" />
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

  const handleChapterActivate = useCallback(
    (chapter: Chapter, event?: React.MouseEvent) => {
      if (isOrganizeMode) return;
      if (selectionMode) {
        event?.preventDefault?.();
        event?.stopPropagation?.();
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
      if (book.settings?.enableSelectionMode === false || isOrganizeMode) return;
      const nativeMouse = event.nativeEvent as MouseEvent;
      if (nativeMouse.button !== 2) return;
      toggleChapterSelection(chapter.id);
    },
    [book.settings?.enableSelectionMode, isOrganizeMode, toggleChapterSelection]
  );

  const handleLongPressRangeSelect = useCallback(
    (chapterId: string) => {
      if (isOrganizeMode) return;
      if (!selectionMode && selectedIds.size === 0) {
        enterSelection(chapterId);
        return;
      }
      const order = visibleChapters.map((chapter) => chapter.id);
      const anchor = selectionAnchorId ?? Array.from(selectedIds)[0] ?? null;
      if (!anchor) {
        enterSelection(chapterId);
        return;
      }
      const next = new Set(selectedIds);
      next.add(chapterId);
      const startIdx = order.indexOf(anchor);
      const endIdx = order.indexOf(chapterId);
      if (startIdx === -1 || endIdx === -1) {
        replaceSelection(next);
        return;
      }
      const [lo, hi] = startIdx <= endIdx ? [startIdx, endIdx] : [endIdx, startIdx];
      order.slice(lo, hi + 1).forEach((id) => next.add(id));
      replaceSelection(next);
    },
    [
      isOrganizeMode,
      selectionMode,
      selectedIds,
      enterSelection,
      visibleChapters,
      selectionAnchorId,
      toggleChapterSelection,
      replaceSelection,
    ]
  );

  const ChapterRow: React.FC<{ chapter: Chapter; fallbackIndex: number; style?: React.CSSProperties }> = ({
    chapter,
    fallbackIndex,
    style,
  }) => {
    const displayIndex = getDisplayIndex(
      chapter,
      Number.isFinite(Number(chapter.index)) && Number(chapter.index) > 0 ? Number(chapter.index) : fallbackIndex
    );
    const displayTitle = getDisplayTitle(chapter, displayIndex);
    const isCompleted = chapter.isCompleted || false;
    let percent = chapter.progress !== undefined ? Math.floor(chapter.progress * 100) : 0;
    if (playbackSnapshot && playbackSnapshot.chapterId === chapter.id) {
      percent = Math.floor(playbackSnapshot.percent * 100);
    }
    if (isCompleted) {
      percent = 100;
    }
    const isEditing = editingChapterId === chapter.id;
    const isSelected = selectedIds.has(chapter.id);
    const showCheckbox = selectionMode;
    const canDragRows = isOrganizeMode && book.settings?.allowDragReorderChapters !== false;

    const gesture = useSelectionGesture({
      enabled: book.settings?.enableSelectionMode !== false,
      onTap: (event) => {
        if (!isEditing) handleChapterActivate(chapter, event);
      },
      onLongPress: () => {
        handleLongPressRangeSelect(chapter.id);
      },
    });

    return (
      <div
        style={style ? { ...style, width: "100%" } : undefined}
        data-chapter-id={chapter.id}
        onClick={gesture.onClick}
        onContextMenu={(event) => handleChapterContextMenu(chapter, event)}
        onPointerDown={gesture.onPointerDown}
        onPointerMove={gesture.onPointerMove}
        onPointerUp={gesture.onPointerUp}
        onPointerCancel={gesture.onPointerCancel}
        draggable={canDragRows}
        onDragStart={() => {
          if (!canDragRows) return;
          setDraggingChapterId(chapter.id);
        }}
        onDragEnd={() => {
          setDraggingChapterId(null);
          setDraggingVolumeName(null);
        }}
        onDragOver={(event) => {
          if (!canDragRows || !draggingChapterId || draggingChapterId === chapter.id) return;
          event.preventDefault();
        }}
        onDrop={async (event) => {
          if (!canDragRows || !draggingChapterId || draggingChapterId === chapter.id) return;
          event.preventDefault();
          await reorderWithinVolume(draggingChapterId, chapter.id);
          setDraggingChapterId(null);
        }}
        className={`${cardRadius} ${cardSurface} ${rowPad} cursor-pointer border-b last:border-0 transition-colors ${
          isDark ? "hover:bg-white/5" : "hover:bg-black/5"
        } ${cardBorder} ${isCompleted && !(selectionMode && isSelected) ? "opacity-50" : ""} ${selectionMode && isSelected ? selectionRowClass : ""}`}
      >
        <div className="flex items-center gap-3">
          <div className={`shrink-0 flex items-center gap-2 ${textSecondary}`}>
            {showCheckbox ? (
              <input
                type="checkbox"
                checked={isSelected}
                onChange={() => toggleChapterSelection(chapter.id)}
                onClick={(event) => event.stopPropagation()}
                className="accent-indigo-600"
              />
            ) : null}
            {canDragRows ? <GripVertical className="w-4 h-4 opacity-40" /> : null}
            <span
              className={`font-mono text-[10px] font-black px-2 py-1 rounded-full ${
                isDark ? "bg-slate-950 text-indigo-300" : "bg-indigo-50 text-indigo-700"
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
                    onUpdateChapterTitle(chapter.id, tempTitle);
                    setEditingChapterId(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      onUpdateChapterTitle(chapter.id, tempTitle);
                      setEditingChapterId(null);
                    } else if (e.key === "Escape") {
                      setEditingChapterId(null);
                    }
                  }}
                  className={`flex-1 px-3 py-2 rounded-xl border ${
                    isDark ? "bg-slate-900 border-slate-700" : "bg-white border-black/10"
                  }`}
                />
                <button
                  onClick={() => {
                    onUpdateChapterTitle(chapter.id, tempTitle);
                    setEditingChapterId(null);
                  }}
                  className="p-2 rounded-xl bg-black/5 hover:bg-black/10"
                >
                  <Check className="w-4 h-4" />
                </button>
              </div>
            ) : (
              <div className="font-black text-[13px] line-clamp-1 sm:text-sm sm:line-clamp-2 leading-tight">
                <span className="truncate">{displayTitle}</span>
              </div>
            )}
            <div className="mt-1">
              <div className={`h-0.5 w-full rounded-full overflow-hidden ${isDark ? "bg-slate-700" : "bg-black/5"}`}>
                <div className="h-full bg-indigo-500 transition-all duration-300" style={{ width: `${percent}%` }} />
              </div>
            </div>
          </div>

          <div className="shrink-0 flex items-center gap-1.5">
            <span
              className={`text-[9px] font-black px-2 py-1 rounded-full ${
                isDark ? "bg-slate-950 text-indigo-300" : "bg-indigo-50 text-indigo-700"
              }`}
            >
              {percent}%
            </span>
            {renderTextStatusIcon(chapter)}
            {renderAudioStatusIcon(chapter)}
            <button
              onClick={(e) => {
                e.stopPropagation();
                setMobileMenuId(chapter.id);
              }}
              className={`${tapTarget} flex items-center justify-center rounded-xl opacity-70 hover:opacity-100`}
              title="Chapter menu"
            >
              <MoreVertical className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    );
  };

  const MobileChapterMenu = ({ chapterId }: { chapterId: string }) => {
    const ch = chapters.find(c => c.id === chapterId);
    const [editTitle, setEditTitle] = useState(false);
    const [editValue, setEditValue] = useState("");
    if (!ch) return null;
    const handleStartEdit = () => {
      setEditValue(String(ch.title ?? "").trim() || "");
      setEditTitle(true);
    };
    const handleSaveEdit = () => {
      if (editValue.trim() !== String(ch.title ?? "").trim()) {
        onUpdateChapterTitle(ch.id, editValue.trim());
      }
      setEditTitle(false);
      setMobileMenuId(null);
    };
    return (
      <div className="fixed inset-0 z-[110] flex items-end sm:items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={() => { setMobileMenuId(null); setEditTitle(false); }}>
        <div className={`w-full max-w-sm rounded-[2rem] shadow-2xl p-6 overflow-hidden animate-in slide-in-from-bottom-4 duration-200 ${isDark ? 'bg-slate-900 border border-white/10' : 'bg-white'}`} onClick={e => e.stopPropagation()}>
           <div className="flex justify-between items-center mb-6">
              <h3 className="text-sm font-black uppercase tracking-widest opacity-60">Chapter Options</h3>
              <button onClick={() => { setMobileMenuId(null); setEditTitle(false); }} className="p-2 opacity-40"><X className="w-5 h-5" /></button>
           </div>
           <div className="space-y-2">
              {editTitle ? (
                <div className="space-y-3" onClick={e => e.stopPropagation()}>
                  <input
                    autoFocus
                    type="text"
                    value={editValue}
                    onChange={e => setEditValue(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter") handleSaveEdit(); if (e.key === "Escape") { setEditTitle(false); setMobileMenuId(null); } }}
                    className={`w-full px-4 py-3 rounded-xl border text-sm font-bold ${isDark ? "bg-slate-800 border-slate-600 text-white" : "bg-white border-black/10 text-black"}`}
                  />
                  <div className="flex gap-2">
                    <button onClick={handleSaveEdit} className="flex-1 py-3 rounded-xl bg-indigo-600 text-white font-black uppercase text-[10px] tracking-widest">Save</button>
                    <button onClick={() => { setEditTitle(false); setMobileMenuId(null); }} className="flex-1 py-3 rounded-xl border border-black/10 font-black uppercase text-[10px] tracking-widest opacity-60">Cancel</button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={handleStartEdit}
                  title="Edit title"
                  className={`w-full flex items-center gap-4 p-4 rounded-2xl font-black text-sm transition-all ${isDark ? 'hover:bg-white/5' : 'hover:bg-black/5'}`}
                >
                  <div className="p-2 bg-indigo-600/10 text-indigo-600 rounded-lg"><Edit2 className="w-4 h-4" /></div>
                  Edit Title
                </button>
              )}
           </div>
        </div>
      </div>
    );
  };

  const getGroupWrapperClass = useCallback(
    (pos: GroupPos) => {
      const isTop = pos === "first" || pos === "single";
      const isBottom = pos === "last" || pos === "single";
      return [
        cardSurface,
        "border-l border-r",
        cardBorder,
        isTop ? "border-t rounded-t-3xl overflow-hidden" : "",
        isBottom ? "rounded-b-3xl overflow-hidden" : "",
      ]
        .filter(Boolean)
        .join(" ");
    },
    [cardBorder, cardSurface]
  );

  const renderSectionRow = useCallback(
    ({ index, style, data }: ListChildComponentProps<SectionListItem[]>) => {
      const item = data[index];
      if (item.type === "spacer") return <div style={style} />;
      if (item.type === "ungrouped-label") {
        return <ChaptersSectionHeader style={style} />;
      }
      if (item.type === "load-more") {
        return (
          <div style={style} className={`py-4 text-center text-xs ${subtleText}`}>
            {isLoadingMoreChapters ? "Loading more..." : "Scroll to load more"}
          </div>
        );
      }

      const wrapperClass = getGroupWrapperClass(item.groupPos);
      if (item.type === "volume-header") {
        const canReorderVolumes = isOrganizeMode && book.settings?.allowDragReorderVolumes !== false;
        const canMoveToVolume = isOrganizeMode && book.settings?.allowDragMoveToVolume !== false;
        return (
          <div style={style} className={wrapperClass}>
            <div
              className="w-full px-6 py-3 flex items-center justify-between border-b border-theme bg-surface-2/60"
              draggable={canReorderVolumes}
              onDragStart={() => {
                if (!canReorderVolumes) return;
                setDraggingVolumeName(item.volumeName);
              }}
              onDragEnd={() => setDraggingVolumeName(null)}
              onDragOver={(event) => {
                if ((canReorderVolumes && draggingVolumeName && draggingVolumeName !== item.volumeName) || (canMoveToVolume && draggingChapterId)) {
                  event.preventDefault();
                }
              }}
              onDrop={async (event) => {
                if (canReorderVolumes && draggingVolumeName && draggingVolumeName !== item.volumeName) {
                  event.preventDefault();
                  reorderVolumes(draggingVolumeName, item.volumeName);
                  setDraggingVolumeName(null);
                  return;
                }
                if (canMoveToVolume && draggingChapterId) {
                  event.preventDefault();
                  await moveChapterToVolume(draggingChapterId, item.volumeName);
                  setDraggingChapterId(null);
                }
              }}
            >
              <div className="text-left flex items-center gap-2 min-w-0">
                {canReorderVolumes ? <GripVertical className="w-4 h-4 opacity-40" /> : null}
                <button
                  onClick={() =>
                    setCollapsedVolumes((p) => {
                      const next = { ...p, [item.volumeName]: !p[item.volumeName] };
                      upsertBookSettings({ collapsedVolumes: next });
                      return next;
                    })
                  }
                  className="text-xs opacity-70 hover:opacity-100"
                  title={item.isCollapsed ? "Expand" : "Collapse"}
                >
                  {item.isCollapsed ? <ChevronDown className="w-4 h-4" /> : <ChevronUp className="w-4 h-4" />}
                </button>
                <div className="min-w-0">
                  <div className="text-[10px] font-black uppercase tracking-widest opacity-70 truncate">{item.volumeName}</div>
                  <div className="text-[10px] font-bold opacity-50">
                    {item.chapterCount} chapters{item.isCollapsed ? " (collapsed)" : ""}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => void renameVolume(item.volumeName)}
                  className="p-2 opacity-40 hover:opacity-100"
                  title="Rename volume"
                >
                  <Edit2 className="w-4 h-4" />
                </button>
                <button
                  onClick={() => void deleteVolumeToUngrouped(item.volumeName)}
                  className="p-2 opacity-40 hover:opacity-100 text-red-500"
                  title="Delete volume"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>
        );
      }

      if (item.type === "chapter-row") {
        return (
          <div style={style} className={wrapperClass}>
            <ChapterRow chapter={item.chapter} fallbackIndex={item.fallbackIndex} />
          </div>
        );
      }

      return <div style={style} />;
    },
    [
      book.settings?.allowDragMoveToVolume,
      book.settings?.allowDragReorderVolumes,
      deleteVolumeToUngrouped,
      draggingChapterId,
      draggingVolumeName,
      getGroupWrapperClass,
      isDark,
      isLoadingMoreChapters,
      isOrganizeMode,
      moveChapterToVolume,
      reorderVolumes,
      renameVolume,
      setCollapsedVolumes,
      subtleText,
      upsertBookSettings,
    ]
  );

  const ChapterCard: React.FC<{ chapter: Chapter; localIndex: number }> = ({ chapter, localIndex }) => {
    const displayIndex = getDisplayIndex(chapter, localIndex);
    const displayTitle = getDisplayTitle(chapter, displayIndex);
    let percent = chapter.progress !== undefined ? Math.floor(chapter.progress * 100) : 0;
    if (playbackSnapshot && playbackSnapshot.chapterId === chapter.id) {
      percent = Math.floor(playbackSnapshot.percent * 100);
    }
    const isCompleted = chapter.isCompleted || false;
    if (isCompleted) {
      percent = 100;
    }
    const isSelected = selectedIds.has(chapter.id);
    const canDragCard = isOrganizeMode && book.settings?.allowDragReorderChapters !== false;

    const gesture = useSelectionGesture({
      enabled: book.settings?.enableSelectionMode !== false,
      onTap: (event) => {
        handleChapterActivate(chapter, event);
      },
      onLongPress: () => {
        handleLongPressRangeSelect(chapter.id);
      },
    });

    return (
      <div
        key={chapter.id}
        data-chapter-id={chapter.id}
        onClick={gesture.onClick}
        onContextMenu={(event) => handleChapterContextMenu(chapter, event as any)}
        onPointerDown={gesture.onPointerDown}
        onPointerMove={gesture.onPointerMove}
        onPointerUp={gesture.onPointerUp}
        onPointerCancel={gesture.onPointerCancel}
        draggable={canDragCard}
        onDragStart={() => {
          if (!canDragCard) return;
          setDraggingChapterId(chapter.id);
        }}
        onDragEnd={() => setDraggingChapterId(null)}
        onDragOver={(event) => {
          if (!canDragCard) return;
          if (!draggingChapterId || draggingChapterId === chapter.id) return;
          event.preventDefault();
        }}
        onDrop={async (event) => {
          if (!canDragCard) return;
          if (!draggingChapterId || draggingChapterId === chapter.id) return;
          event.preventDefault();
          await reorderWithinVolume(draggingChapterId, chapter.id);
          setDraggingChapterId(null);
        }}
        className={`${cardRadius} ${cardSurface} ${cardPad} min-h-[190px] flex flex-col gap-2 cursor-pointer transition-all ${
          isDark ? "hover:bg-white/5" : "hover:bg-black/5"
        } relative ${
          selectionMode && isSelected ? selectionRowClass : ""
        }`}
      >
        {selectionMode ? (
          <div className="absolute top-3 left-3">
            <input
              type="checkbox"
              checked={isSelected}
              onChange={() => toggleChapterSelection(chapter.id)}
              onClick={(event) => event.stopPropagation()}
              className="accent-indigo-600"
            />
          </div>
        ) : null}
        <div className="absolute top-3 right-3 flex gap-1">
          {renderTextStatusIcon(chapter)}
          {renderAudioStatusIcon(chapter)}
        </div>
        <div
          className={`w-10 h-10 rounded-2xl flex items-center justify-center font-mono text-sm font-black ${
            isDark ? "bg-slate-950 text-indigo-400" : "bg-indigo-50 text-indigo-600"
          }`}
        >
          {displayIndex}
        </div>
        <div className="font-black text-xs line-clamp-2 leading-tight">{displayTitle}</div>
        <div className="mt-auto pt-2">
          <div className={`h-0.5 w-full rounded-full overflow-hidden ${isDark ? "bg-slate-700" : "bg-black/5"}`}>
            <div className="h-full bg-indigo-500 transition-all duration-300" style={{ width: `${percent}%` }} />
          </div>
          <div className="text-[8px] font-black uppercase mt-1">{percent}%</div>
        </div>
        <div className="absolute top-3 right-3">
          <button
            onClick={(e) => {
              e.stopPropagation();
              setMobileMenuId(chapter.id);
            }}
            title="Chapter menu"
            className="min-h-[36px] min-w-[36px] flex items-center justify-center rounded-xl opacity-70 hover:opacity-100"
          >
            <MoreVertical className="w-4 h-4" />
          </button>
        </div>
      </div>
    );
  };

  const renderGridRow = useCallback(
    ({ index, style, data }: ListChildComponentProps<GridListItem[]>) => {
      const item = data[index];
      if (item.type === "spacer") return <div style={style} />;
      if (item.type === "ungrouped-label") {
        return <ChaptersSectionHeader style={style} />;
      }
      if (item.type === "load-more") {
        return (
          <div style={style} className={`py-4 text-center text-xs ${subtleText}`}>
            {isLoadingMoreChapters ? "Loading more..." : "Scroll to load more"}
          </div>
        );
      }
      if (item.type === "volume-header") {
        const canReorderVolumes = isOrganizeMode && book.settings?.allowDragReorderVolumes !== false;
        const canMoveToVolume = isOrganizeMode && book.settings?.allowDragMoveToVolume !== false;
        return (
          <div style={style}>
            <div
              className={`px-3 py-2 rounded-2xl cursor-pointer flex items-center justify-between ${
                isDark ? "bg-white/5 hover:bg-white/10" : "bg-black/5 hover:bg-black/10"
              }`}
              draggable={canReorderVolumes}
              onDragStart={() => {
                if (!canReorderVolumes) return;
                setDraggingVolumeName(item.volumeName);
              }}
              onDragEnd={() => setDraggingVolumeName(null)}
              onDragOver={(event) => {
                if ((canReorderVolumes && draggingVolumeName && draggingVolumeName !== item.volumeName) || (canMoveToVolume && draggingChapterId)) {
                  event.preventDefault();
                }
              }}
              onDrop={async (event) => {
                if (canReorderVolumes && draggingVolumeName && draggingVolumeName !== item.volumeName) {
                  event.preventDefault();
                  reorderVolumes(draggingVolumeName, item.volumeName);
                  setDraggingVolumeName(null);
                  return;
                }
                if (canMoveToVolume && draggingChapterId) {
                  event.preventDefault();
                  await moveChapterToVolume(draggingChapterId, item.volumeName);
                  setDraggingChapterId(null);
                }
              }}
            >
              <div className="min-w-0 flex items-center gap-2">
                {canReorderVolumes ? <GripVertical className="w-4 h-4 opacity-40" /> : null}
                <div className="text-xs font-black uppercase tracking-widest opacity-70 truncate">{item.volumeName}</div>
                <div className="text-[10px] font-bold opacity-40">
                  {item.chapterCount} chapters{item.isCollapsed ? " (collapsed)" : ""}
                </div>
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={(event) => {
                    event.stopPropagation();
                    setCollapsedVolumes((p) => {
                      const next = { ...p, [item.volumeName]: !p[item.volumeName] };
                      upsertBookSettings({ collapsedVolumes: next });
                      return next;
                    });
                  }}
                  className="p-1.5 opacity-60 hover:opacity-100"
                >
                  {item.isCollapsed ? <ChevronDown className="w-4 h-4" /> : <ChevronUp className="w-4 h-4" />}
                </button>
                <button
                  onClick={(event) => {
                    event.stopPropagation();
                    void renameVolume(item.volumeName);
                  }}
                  className="p-1.5 opacity-60 hover:opacity-100"
                >
                  <Edit2 className="w-4 h-4" />
                </button>
                <button
                  onClick={(event) => {
                    event.stopPropagation();
                    void deleteVolumeToUngrouped(item.volumeName);
                  }}
                  className="p-1.5 opacity-60 hover:opacity-100 text-red-500"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>
        );
      }
      if (item.type === "grid-row") {
        return (
          <div style={{ ...style, paddingBottom: gridGap, boxSizing: "border-box" }}>
            <div
              className="grid"
              style={{ gridTemplateColumns: `repeat(${gridColumns}, minmax(0, 1fr))`, gap: gridGap }}
            >
              {item.chapters.map(({ chapter, localIndex }) => (
                <ChapterCard key={chapter.id} chapter={chapter} localIndex={localIndex} />
              ))}
            </div>
          </div>
        );
      }
      return <div style={style} />;
    },
    [
      book.settings?.allowDragMoveToVolume,
      book.settings?.allowDragReorderVolumes,
      deleteVolumeToUngrouped,
      draggingChapterId,
      draggingVolumeName,
      gridColumns,
      gridGap,
      isDark,
      isLoadingMoreChapters,
      isOrganizeMode,
      moveChapterToVolume,
      renameVolume,
      reorderVolumes,
      setCollapsedVolumes,
      subtleText,
      upsertBookSettings,
    ]
  );

  const getSectionItemSize = useCallback(
    (index: number) => {
      const item = sectionItems[index];
      switch (item.type) {
        case "volume-header":
          return volumeHeaderHeight;
        case "chapter-row":
          return sectionRowHeight;
        case "ungrouped-label":
          return ungroupedLabelHeight;
        case "spacer":
          return item.size;
        case "load-more":
          return loadMoreHeight;
        default:
          return sectionRowHeight;
      }
    },
    [loadMoreHeight, sectionItems, sectionRowHeight, ungroupedLabelHeight, volumeHeaderHeight]
  );

  const getGridItemSize = useCallback(
    (index: number) => {
      const item = gridItems[index];
      switch (item.type) {
        case "volume-header":
          return gridVolumeHeaderHeight;
        case "grid-row":
          return gridRowHeight;
        case "ungrouped-label":
          return ungroupedLabelHeight;
        case "spacer":
          return item.size;
        case "load-more":
          return loadMoreHeight;
        default:
          return gridRowHeight;
      }
    },
    [gridItems, gridRowHeight, gridVolumeHeaderHeight, loadMoreHeight, ungroupedLabelHeight]
  );

  useEffect(() => {
    if (!useVirtualization) return;
    sectionsListRef.current?.resetAfterIndex(0, true);
  }, [
    useVirtualization,
    sectionItems.length,
    sectionRowHeight,
    volumeHeaderHeight,
    spacerHeight,
    labelSpacerHeight,
    loadMoreHeight,
  ]);

  useEffect(() => {
    if (!useVirtualization) return;
    gridListRef.current?.resetAfterIndex(0, true);
  }, [
    useVirtualization,
    gridItems.length,
    gridRowHeight,
    gridVolumeHeaderHeight,
    spacerHeight,
    labelSpacerHeight,
    loadMoreHeight,
  ]);

  const handleSectionItemsRendered = useCallback(
    ({ visibleStopIndex }: { visibleStopIndex: number }) => {
      if (!hasMoreChapters || isLoadingMoreChapters || !onLoadMoreChapters) return;
      if (visibleStopIndex >= sectionItems.length - 3) {
        onLoadMoreChapters();
      }
    },
    [hasMoreChapters, isLoadingMoreChapters, onLoadMoreChapters, sectionItems.length]
  );

  const handleGridItemsRendered = useCallback(
    ({ visibleStopIndex }: { visibleStopIndex: number }) => {
      if (!hasMoreChapters || isLoadingMoreChapters || !onLoadMoreChapters) return;
      if (visibleStopIndex >= gridItems.length - 3) {
        onLoadMoreChapters();
      }
    },
    [hasMoreChapters, isLoadingMoreChapters, onLoadMoreChapters, gridItems.length]
  );

  const renderDetailsViewVirtualized = () => (
    <VariableSizeList
      ref={sectionsListRef}
      outerRef={scrollContainerRef}
      outerElementType={ListOuterElement}
      className="overflow-y-auto px-4 sm:px-6 py-6 sm:py-8"
      height={listViewport.height}
      width={listViewport.width}
      itemCount={sectionItems.length}
      itemSize={getSectionItemSize}
      itemData={sectionItems}
      itemKey={(index, data) => data[index].id}
      onItemsRendered={handleSectionItemsRendered}
      onScroll={({ scrollOffset }) => {
        viewScrollRef.current[viewMode] = scrollOffset;
        onScrollPositionChange?.(scrollOffset);
        applyCoverCollapse(scrollOffset);
      }}
    >
      {renderSectionRow}
    </VariableSizeList>
  );

  const renderGridViewVirtualized = () => (
    <VariableSizeList
      ref={gridListRef}
      outerRef={scrollContainerRef}
      outerElementType={ListOuterElement}
      className="overflow-y-auto px-4 sm:px-6 py-6 sm:py-8"
      height={listViewport.height}
      width={listViewport.width}
      itemCount={gridItems.length}
      itemSize={getGridItemSize}
      itemData={gridItems}
      itemKey={(index, data) => data[index].id}
      onItemsRendered={handleGridItemsRendered}
      onScroll={({ scrollOffset }) => {
        viewScrollRef.current[viewMode] = scrollOffset;
        onScrollPositionChange?.(scrollOffset);
        applyCoverCollapse(scrollOffset);
      }}
    >
      {renderGridRow}
    </VariableSizeList>
  );

  const renderDetailsView = () => {
    return (
      <div className={`flex flex-col ${sectionGap}`}>
        {volumeSections.volumes.map((group) => {
          const isCollapsed = !!collapsedVolumes[group.volumeName];
          const canReorderVolumes = isOrganizeMode && book.settings?.allowDragReorderVolumes !== false;
          const canMoveToVolume = isOrganizeMode && book.settings?.allowDragMoveToVolume !== false;
          return (
            <div key={group.volumeName} className="rounded-[2rem] overflow-hidden card-cinematic">
              <div
                className="w-full px-6 py-3 flex items-center justify-between border-b border-theme bg-surface-2/60"
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
                  <div className="divide-y divide-black/5">
                    {group.chapters.map((chapter, idx) => (
                      <React.Fragment key={chapter.id}>
                        <ChapterRow chapter={chapter} fallbackIndex={idx + 1} />
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
            <ChaptersSectionHeader />
            <div className="rounded-[2rem] overflow-hidden card-cinematic">
              <div className="divide-y divide-black/5">
                {volumeSections.ungrouped.map((chapter, idx) => (
                  <React.Fragment key={chapter.id}>
                    <ChapterRow chapter={chapter} fallbackIndex={idx + 1} />
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
          <div className={`rounded-[2rem] overflow-hidden card-cinematic p-6 text-sm font-bold ${subtleText}`}>
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
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
                {group.chapters.map((chapter, idx) => (
                  <ChapterCard key={chapter.id} chapter={chapter} localIndex={idx + 1} />
                ))}
              </div>
            )}
          </div>
        );
      })}
      {volumeSections.ungrouped.length > 0 && (
        <div className="space-y-2">
          <ChaptersSectionHeader />
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
            {volumeSections.ungrouped.map((chapter, idx) => (
              <ChapterCard key={chapter.id} chapter={chapter} localIndex={idx + 1} />
            ))}
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

  const ChaptersSectionHeader = ({ style }: { style?: React.CSSProperties }) => (
    <div style={style} className="px-2 text-[10px] font-black uppercase tracking-widest opacity-60">
      Chapters
    </div>
  );

  return (
    <div className="h-full min-h-0 flex flex-col bg-surface text-theme ui-font">
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
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-3 sm:p-4 bg-black/60 backdrop-blur-sm">
          <div
            data-testid="book-settings-modal"
            className={`w-full max-w-lg rounded-[2rem] shadow-2xl flex max-h-[90dvh] flex-col overflow-hidden ${isDark ? 'bg-slate-900 border border-slate-800' : 'bg-white border border-black/5'}`}
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
              className="flex-1 overflow-y-auto overscroll-contain px-5 sm:px-6 py-5 space-y-6 pb-[calc(env(safe-area-inset-bottom)+12px)]"
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
              <div className="text-[10px] font-black uppercase tracking-widest opacity-60">Selection & Organize</div>
              {[
                { key: "enableSelectionMode", label: "Enable Selection Mode", value: book.settings?.enableSelectionMode !== false },
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

      <div className={`sticky top-0 z-50 transition-all duration-300 ${stickyHeaderBg}`}>
        {selectionMode ? (
          <SelectionBar
            tapTarget={tapTarget}
            selectedCount={selectedIds.size}
            onClose={closeSelectionMode}
            onSelectAll={() => handleSelectAllVisible(visibleChapters.map((chapter) => chapter.id))}
            onInvert={() => handleInvertVisibleSelection(visibleChapters.map((chapter) => chapter.id))}
            showOverflow={showSelectionOverflow}
            onToggleOverflow={() => setShowSelectionOverflow((v) => !v)}
            onAssignVolume={() => {
              setShowSelectionOverflow(false);
              void handleBulkAssignVolume();
            }}
            canAssign={!!selectedIds.size}
            isDark={isDark}
          />
        ) : (
          <BookTopBar
            title={book.title}
            tapTarget={tapTarget}
            viewMode={viewMode}
            onBack={onBackToLibrary}
            onToggleSearch={() => setShowSearchBar((v) => !v)}
            onOpenSettings={() => setShowBookSettings(true)}
            onSetViewMode={(mode) => startViewModeTransition(() => setViewMode(mode))}
            showOverflow={showBookOverflow}
            onToggleOverflow={() => setShowBookOverflow((v) => !v)}
            onOpenSettingsFromMenu={handleOpenSettingsFromMenu}
            onToggleOrganize={handleMenuToggleOrganize}
            isOrganizeMode={isOrganizeMode}
            onCheck={handleMenuCheck}
            onReindex={handleMenuReindex}
            onFix={handleMenuFix}
            onAddVolume={handleMenuAddVolume}
            showAddVolume={isOrganizeMode}
            hasIssues={hasIssues}
            isDark={isDark}
          />
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
        <div className={`${screenPad} pt-4 pb-2`}>
          <BookHero
            book={book}
            syncBadge={syncBadge}
            lastSavedAt={lastSavedAt}
            coverCardRef={coverCardRef}
            coverRowRef={coverRowRef}
            coverImageRef={coverImageRef}
            coverMetaRef={coverMetaRef}
          />
        </div>
      ) : null}

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

      <div ref={listWrapperRef} className="flex-1 min-h-0">
        {useVirtualization ? (
          chapters.length === 0 ? (
            <div className="p-12 text-center text-xs font-black opacity-30 uppercase">No chapters found</div>
          ) : (
            viewMode === "sections" ? (
              <ChapterList>{renderDetailsViewVirtualized()}</ChapterList>
            ) : (
              <ChapterGrid>{renderGridViewVirtualized()}</ChapterGrid>
            )
          )
        ) : (
          <div
            ref={scrollContainerRef}
            onScroll={handleScroll}
            className="h-full px-4 sm:px-6 py-6 sm:py-8 overflow-y-auto"
          >
            {chapters.length === 0 ? (
              <div className="p-12 text-center text-xs font-black opacity-30 uppercase">No chapters found</div>
            ) : (
              viewMode === "sections" ? (
                <ChapterList>{renderDetailsView()}</ChapterList>
              ) : (
                <ChapterGrid>{renderGridView()}</ChapterGrid>
              )
            )}
          </div>
        )}
      </div>

      {!selectionMode ? (
        <button
          onClick={onAddChapter}
          className="fixed right-4 bottom-[calc(env(safe-area-inset-bottom)+16px)] w-14 h-14 rounded-full bg-indigo-600 text-white shadow-2xl flex items-center justify-center active:scale-95 transition-transform"
          title="Add chapter"
        >
          <Plus className="w-6 h-6" />
        </button>
      ) : null}

      {selectionMode ? (
        <BulkActionDock
          isDark={isDark}
          canBulkUpload={canBulkUpload}
          selectedCount={selectedIds.size}
          onUpload={() => void handleBulkUpload()}
          onRegen={() => void handleBulkRegenerateAudio()}
          onDone={() => void handleBulkMarkCompleted()}
          onReset={() => void handleBulkResetProgress()}
          onDelete={() => void handleBulkDelete()}
        />
      ) : null}
    </div>
  );
};

export default ChapterFolderView;
