import React, { useMemo, useState, useEffect, useCallback, useRef } from 'react';
import { Book, Theme, StorageBackend, Chapter, AudioStatus, CLOUD_VOICES, ScanResult, StrayFile, Rule, HighlightMode, UiMode, JobRecord } from '../types';
import { LayoutGrid, List, AlignJustify, Plus, Edit2, RefreshCw, Trash2, Headphones, Loader2, Cloud, AlertTriangle, X, RotateCcw, ChevronLeft, Image as ImageIcon, Search, FileX, AlertCircle, Wrench, Check, History, Trash, ChevronDown, ChevronUp, Settings as GearIcon, Sparkles } from 'lucide-react';
import { applyRules } from '../services/speechService';
import { synthesizeChunk } from '../services/cloudTtsService';
import { saveAudioToCache, generateAudioKey, getAudioFromCache, hasAudioInCache } from '../services/audioCache';
import {
  uploadToDrive,
  listFilesInFolder,
  buildMp3Name,
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
import { enqueueGenerateAudio, enqueueFixIntegrity } from '../services/jobRunnerService';
import {
  loadChapterText as libraryLoadChapterText,
  bulkUpsertChapters as libraryBulkUpsertChapters,
  listChaptersPage as libraryListChaptersPage
} from "../services/libraryStore";
import { initBookFolderManifests } from "../services/bookFolderInit";
import { createDriveFolderAdapter } from "../services/driveFolderAdapter";
import type { InventoryManifest } from "../services/bookManifests";

type ViewMode = 'details' | 'list' | 'grid';

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
  onUpdateChapterTitle: (chapterId: string, newTitle: string) => void;
  onDeleteChapter: (chapterId: string) => void;
  onUpdateChapter: (chapter: Chapter) => void;
  onUpdateBookSettings?: (settings: any) => void;
  onBackToLibrary: () => void;
  onResetChapterProgress: (bookId: string, chapterId: string) => void;
  playbackSnapshot?: { chapterId: string, percent: number } | null;

  // Phase One: paging support
  onLoadMoreChapters?: () => void;
  hasMoreChapters?: boolean;
  isLoadingMoreChapters?: boolean;
  
  // Optional UI refresh callback
  onAppendChapters?: (chapters: Chapter[]) => void;
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
  onUpdateChapterTitle,
  onDeleteChapter,
  onUpdateChapter,
  onUpdateBookSettings,
  onBackToLibrary,
  onResetChapterProgress,
  playbackSnapshot,
  onLoadMoreChapters,
  hasMoreChapters,
  isLoadingMoreChapters,
  onAppendChapters
}) => {
  const { driveFolderId } = book;
  const VIEW_MODE_KEY = `talevox:viewMode:${book.id}`;
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    const saved = localStorage.getItem(VIEW_MODE_KEY);
    return (saved === 'details' || saved === 'list' || saved === 'grid') ? (saved as ViewMode) : 'details';
  });

  useEffect(() => { localStorage.setItem(VIEW_MODE_KEY, viewMode); }, [viewMode, VIEW_MODE_KEY]);

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
  const [previewOnly, setPreviewOnly] = useState(true);
  const lastFixStatusRef = useRef<string | null>(null);

  const [showVoiceModal, setShowVoiceModal] = useState<{ chapterId?: string } | null>(null);
  const [rememberAsDefault, setRememberAsDefault] = useState(true);

  const [isHeaderExpanded, setIsHeaderExpanded] = useState(false);
  const [mobileMenuId, setMobileMenuId] = useState<string | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [bgGenProgress, setBgGenProgress] = useState<{ current: number; total: number } | null>(null);
  const [showBookSettings, setShowBookSettings] = useState(false);
  const coverInputRef = useRef<HTMLInputElement | null>(null);

  const [fixOptions, setFixOptions] = useState({
    genAudio: true,
    cleanupStrays: true,
    convertLegacy: true
  });

  const isDark = theme === Theme.DARK;
  const isSepia = theme === Theme.SEPIA;
  const cardBg = isDark ? 'bg-slate-800 border-slate-700' : isSepia ? 'bg-[#f4ecd8] border-[#d8ccb6]' : 'bg-white border-black/10';
  const textSecondary = isDark ? 'text-slate-400' : isSepia ? 'text-[#3c2f25]/70' : 'text-slate-600';
  const subtleText = textSecondary;
  const stickyHeaderBg = isDark ? 'bg-slate-900/90' : isSepia ? 'bg-[#f4ecd8]/90' : 'bg-white/90';

  const chapters = useMemo(() => [...(book.chapters || [])].sort((a, b) => a.index - b.index), [book.chapters]);
  const isMobileInterface = computeMobileMode(uiMode);
  const enableBackgroundJobs = false;
  const missingAudioIdsForBook = useMemo(() => {
    return chapters
      .filter((c) => !(c.cloudAudioFileId || (c as any).audioDriveId || c.audioStatus === AudioStatus.READY))
      .map((c) => c.id);
  }, [chapters]);
  const bookJobs = useMemo(() => {
    return (jobs || []).filter((j) => {
      const bookId = (j as any)?.payloadJson?.bookId;
      return !bookId || bookId === book.id;
    });
  }, [jobs, book.id]);
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
    if (scrollHeight - scrollTop - clientHeight < 200) {
      if (hasMoreChapters && !isLoadingMoreChapters && onLoadMoreChapters) {
        onLoadMoreChapters();
      }
    }
  }, [hasMoreChapters, isLoadingMoreChapters, onLoadMoreChapters]);

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
    let afterIndex = 0;
    const LIMIT = 200;
    while (true) {
      const page = await libraryListChaptersPage(book.id, afterIndex, LIMIT);

      if (!page || page.chapters.length === 0) break;

      all.push(...page.chapters);

      if (page.nextAfterIndex == null) break;

      afterIndex = page.nextAfterIndex;
    }
    return all.sort((a, b) => a.index - b.index);
  }, [book.id]);

  const handleCheckDriveIntegrity = useCallback(async (): Promise<ScanResult | null> => {
    if (!driveFolderId) {
      pushNotice("Drive folder not set for this book yet.", "error");
      return null;
    }
    if (!isTokenValid()) {
      alert("Google Drive session expired. Please sign in again in Settings.");
      return null;
    }
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
      for (const folder of subfolders) {
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

      // 4. Deduplicate by name, keeping newest. Collect extras as strays.
      // Invariant: duplicates (same name, different id) are ALWAYS stray — they never go through
      // classification and are excluded from driveFiles, so they cannot be legacy or unlinked.
      const filesByName = new Map<string, StrayFile[]>();
      for (const f of allFiles) {
        if (!f?.name) continue;
        const arr = filesByName.get(f.name) || [];
        arr.push(f);
        filesByName.set(f.name, arr);
      }

      const driveFiles: StrayFile[] = []; // Unique files (newest)
      const duplicateStrays: StrayFile[] = [];

      for (const [name, files] of filesByName) {
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
      inventory.chapters.forEach((c) => {
        if (c?.chapterId) titleMap[c.chapterId] = c.title ?? c.chapterId;
      });
      setScanTitles(titleMap);

      // Expected file names from inventory
      const expectedNames = new Set<string>();
      const missingTextIds: string[] = [];
      const missingAudioIds: string[] = [];
      let accountedChaptersCount = 0;

      for (const ch of inventory.chapters) {
        const chapterId = ch.chapterId;
        if (!chapterId) continue;
        const txtName = `c_${chapterId}.txt`;
        const mp3Name = `c_${chapterId}.mp3`;

        expectedNames.add(txtName);
        expectedNames.add(mp3Name);

        const hasTextExpected = hasName(txtName);
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

      const legacyRegex = /^(\d+)_(.+)\.(txt|mp3)$/;
      const newFormatRegex = /^c_.+\.(txt|mp3)$/;

      // Group legacy by prefix
      const legacyMap = new Map<string, LegacyGroup>();
      const legacyFiles: Array<{ file: StrayFile; idx: number; slug: string; type: "text" | "audio" }> = [];

      for (const f of driveFiles) {
        // Ignore folders, especially meta/text/audio/trash
        if (f.mimeType === "application/vnd.google-apps.folder") continue;

        if (!f?.name) continue;
        if (expectedNames.has(f.name)) continue;

        // ignore common stuff
        if (f.name === ".keep" || f.name === "cover.jpg" || f.name === "manifest.json" || f.name.startsWith('_')) continue;

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

      for (const entry of legacyFiles) {
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

      for (const chapterId of missingChapterIds) {
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

      const expectedInventoryCount = 848;
      const hasExpectedCount = inventory.chapters.length === expectedInventoryCount;
      let safeToCleanup = hasExpectedCount;

      if (safeToCleanup) {
        for (const ch of inventory.chapters) {
          const chapterId = ch.chapterId;
          if (!chapterId) {
            safeToCleanup = false;
            break;
          }

          const txtName = `c_${chapterId}.txt`;
          const mp3Name = `c_${chapterId}.mp3`;
          const hasTextExpected = hasName(txtName);
          const hasAudioExpected = hasName(mp3Name);
          const legacyCandidate = legacyRecoveryCandidates[chapterId];
          const hasLegacyText = !!legacyCandidate?.legacyTextCandidate;
          const hasLegacyAudio = !!legacyCandidate?.legacyAudioCandidate;

          if ((!hasTextExpected && !hasLegacyText) || (!hasAudioExpected && !hasLegacyAudio)) {
            safeToCleanup = false;
            break;
          }
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
    try {
      const allChapters = await fetchAllChapters();
      
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

      for (const chapter of allChapters) {
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
      pushNotice("All good — nothing to fix.", "success", 2500);
    }
  }, [book.backend, handleCheckDriveIntegrity, handleCheckLocalIntegrity, pushNotice]);

  const generateAudio = async (chapter: Chapter, voiceIdOverride?: string): Promise<boolean> => {
    if (synthesizingId) return false;

    setSynthesizingId(chapter.id);
    setSynthesisProgress({ current: 0, total: 1, message: "Preparing text..." });

    try {
      const selectedVoiceId =
        voiceIdOverride ||
        book.settings.defaultVoiceId ||
        book.settings.selectedVoiceName ||
        "en-US-Standard-C";

      const rawContent =
        chapter.content ||
        (await libraryLoadChapterText(book.id, chapter.id)) ||
        "";

      if (!rawContent.trim()) {
        throw new Error("No chapter text found. Create or import text first.");
      }

      const allRules = [...(globalRules || []), ...(book.rules || [])];

      let textToSpeak = applyRules(rawContent, allRules);
      if (reflowLineBreaksEnabled) textToSpeak = reflowLineBreaks(textToSpeak);

      const rawIntro = `Chapter ${chapter.index}. ${chapter.title}. `;
      const introText = applyRules(rawIntro, allRules);

      const fullText = introText + textToSpeak;
      const cacheKey = generateAudioKey(fullText, selectedVoiceId, 1.0);

      let audioBlob = await getAudioFromCache(cacheKey);

      if (!audioBlob) {
        setSynthesisProgress({ current: 0, total: 1, message: "Synthesizing audio..." });

        const res = await synthesizeChunk(fullText, selectedVoiceId, 1.0);
        
        // Replace the Blob construction with an ArrayBuffer-backed copy for TS compatibility.
        const mp3Bytes = res.mp3Bytes instanceof Uint8Array ? res.mp3Bytes : new Uint8Array(res.mp3Bytes as any);

        // Copy into a fresh Uint8Array so its buffer is a real ArrayBuffer (not ArrayBufferLike / SharedArrayBuffer)
        const mp3Copy = new Uint8Array(mp3Bytes);

        audioBlob = new Blob([mp3Copy], { type: "audio/mpeg" });

        await saveAudioToCache(cacheKey, audioBlob);
      }

      onUpdateChapter({
        ...chapter,
        audioStatus: AudioStatus.READY,
        audioSignature: cacheKey,
        audioPrefixLen: introText.length,
        hasCachedAudio: true,
        updatedAt: Date.now(),
      });

      if (book.backend === StorageBackend.DRIVE && driveFolderId) {
        setSynthesisProgress({ current: 0, total: 1, message: "Uploading to Drive..." });

        const filename = buildMp3Name(book.id, chapter.id);

        const cloudAudioFileId = await uploadToDrive(
          driveFolderId,
          filename,
          audioBlob,
          chapter.cloudAudioFileId,
          "audio/mpeg"
        );

        onUpdateChapter({
          ...chapter,
          cloudAudioFileId,
          audioStatus: AudioStatus.READY,
          audioSignature: cacheKey,
          audioPrefixLen: introText.length,
          hasCachedAudio: true,
          updatedAt: Date.now(),
        });
      }
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

  const handleGenerateMissingAudioBackground = async () => {
    if (!missingAudioIdsForBook.length) {
      pushNotice("No missing audio found.", "info");
      return;
    }

    if (isMobileInterface && enableBackgroundJobs) {
      const voiceId =
        book.settings.defaultVoiceId ||
        book.settings.selectedVoiceName ||
        "en-US-Standard-C";

      const payload = {
        bookId: book.id,
        chapterIds: missingAudioIdsForBook,
        voice: { id: voiceId },
        settings: {
          playbackSpeed: book.settings.useBookSettings ? (book.settings.playbackSpeed ?? 1.0) : 1.0
        }
      };

      try {
        await enqueueGenerateAudio(payload, uiMode);
        pushNotice("Background job queued.", "success");
        onRefreshJobs();
      } catch (e: any) {
        pushNotice(`Failed to queue job: ${String(e?.message ?? e)}`, "error");
      }
      return;
    }

    // Desktop: keep in-process generation behavior.
    setBgGenProgress({ current: 0, total: missingAudioIdsForBook.length });
    for (const id of missingAudioIdsForBook) {
      const ch = chapters.find((c) => c.id === id);
      if (!ch) continue;
      await generateAudio(ch);
      setBgGenProgress((p) => (p ? { ...p, current: p.current + 1 } : p));
    }
    setBgGenProgress(null);
    pushNotice("Audio generation complete.", "success");
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
        const hasTextExpected = hasName(textName);
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
          for (const chapterId of targets) {
            if (abortFixRef.current) break;
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
          const res = await enqueueFixIntegrity(
            {
              bookId: book.id,
              driveFolderId: book.driveFolderId,
              options: {
                genAudio: fixOptions.genAudio,
                cleanupStrays: fixOptions.cleanupStrays,
                convertLegacy: fixOptions.convertLegacy
              }
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
      for (const conversion of plan.conversions) {
        if (abortFixRef.current) break;
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
      for (const chapterId of plan.generationIds) {
        if (abortFixRef.current) break;
        const ch = chaptersById.get(chapterId);
        if (!ch) { bump(); continue; }
        setFixLog(prev => [...prev, `Generating missing audio: ${ch.title}`]);
        const success = await generateAudio(ch);
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
          for (const stray of plan.cleanup) {
            if (abortFixRef.current) break;
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
      if (chapter) generateAudio(chapter, voiceId);
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
      };
      reader.readAsDataURL(file);
    } catch (err: any) {
      pushNotice(`Cover upload failed: ${String(err?.message ?? err)}`, "error");
    }
  };

  const renderAudioStatusIcon = (c: Chapter) => {
    if (c.cloudAudioFileId || (c as any).audioDriveId || c.audioStatus === AudioStatus.READY) {
      return (
        <span title="Audio ready on Google Drive" className="inline-flex items-center">
          <Cloud className="w-4 h-4 text-emerald-500" />
        </span>
      );
    }
    if (synthesizingId === c.id || c.audioStatus === AudioStatus.GENERATING) {
      return (
        <span title="Generating and Uploading..." className="inline-flex items-center">
          <Loader2 className="w-4 h-4 text-indigo-400 animate-spin" />
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
    return null;
  };

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
                disabled={synthesizingId === ch.id}
                onClick={() => {
                  setMobileMenuId(null);
                  setRememberAsDefault(true);
                  setShowVoiceModal({ chapterId: ch.id });
                }}
                className={`w-full flex items-center gap-4 p-4 rounded-2xl font-black text-sm transition-all ${
                  isDark ? 'hover:bg-white/5' : 'hover:bg-black/5'
                } ${synthesizingId === ch.id ? 'opacity-60' : ''}`}
              >
                <div className="p-2 bg-indigo-600/10 text-indigo-600 rounded-lg">
                  {synthesizingId === ch.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Headphones className="w-4 h-4" />}
                </div>
                {ch.cloudAudioFileId || ch.hasCachedAudio ? 'Regenerate Audio' : 'Generate Audio'}
              </button>

              <button onClick={() => { setMobileMenuId(null); onResetChapterProgress(book.id, ch.id); }} className={`w-full flex items-center gap-4 p-4 rounded-2xl font-black text-sm transition-all ${isDark ? 'hover:bg-white/5' : 'hover:bg-black/5'}`}>
                 <div className="p-2 bg-emerald-600/10 text-emerald-600 rounded-lg"><RefreshCw className="w-4 h-4" /></div>
                 Reset Progress
              </button>
              <button onClick={() => { setMobileMenuId(null); setEditingChapterId(ch.id); setTempTitle(ch.title); }} className={`w-full flex items-center gap-4 p-4 rounded-2xl font-black text-sm transition-all ${isDark ? 'hover:bg-white/5' : 'hover:bg-black/5'}`}>
                 <div className="p-2 bg-indigo-600/10 text-indigo-600 rounded-lg"><Edit2 className="w-4 h-4" /></div>
                 Edit Title
              </button>
              <button onClick={() => { if (confirm('Delete?')) { onDeleteChapter(ch.id); setMobileMenuId(null); } }} className={`w-full flex items-center gap-4 p-4 rounded-2xl font-black text-sm text-red-500 transition-all ${isDark ? 'hover:bg-red-500/10' : 'hover:bg-red-500/5'}`}>
                 <div className="p-2 bg-red-500/10 text-red-500 rounded-lg"><Trash2 className="w-4 h-4" /></div>
                 Delete Chapter
              </button>
           </div>
        </div>
      </div>
    );
  };

  const renderDetailsView = () => (
    <div className={`rounded-3xl border shadow-sm overflow-hidden ${cardBg}`}>
      <div className={`grid grid-cols-[40px_1fr_80px_100px] md:grid-cols-[40px_1fr_100px_180px] px-6 py-3 text-[10px] font-black uppercase tracking-widest border-b ${isDark ? 'border-slate-800 bg-slate-950/40 text-indigo-400' : 'border-black/5 bg-black/5 text-indigo-600'}`}>
        <div>Idx</div><div>Title</div><div className="text-right px-4">Progress</div><div className="text-right">Actions</div>
      </div>
      <div className="divide-y divide-black/5">
        {chapters.map(c => {
          const isCompleted = c.isCompleted || false;
          // Live progress logic: use snapshot if active chapter, else stored
          let percent = c.progress !== undefined ? Math.floor(c.progress * 100) : 0;
          if (playbackSnapshot && playbackSnapshot.chapterId === c.id) {
             percent = Math.floor(playbackSnapshot.percent * 100);
          }
          
          const isEditing = editingChapterId === c.id;

          return (
            <div key={c.id} onClick={() => !isEditing && onOpenChapter(c.id)} className={`grid grid-cols-[40px_1fr_80px_60px] md:grid-cols-[40px_1fr_100px_180px] items-center px-6 py-4 cursor-pointer border-b last:border-0 transition-colors ${isDark ? 'hover:bg-white/5 border-slate-800' : 'hover:bg-black/5 border-black/5'} ${isCompleted ? 'opacity-50' : ''}`}>
              <div className={`font-mono text-xs font-black ${textSecondary}`}>{String(c.index).padStart(3, '0')}</div>
              <div className="flex flex-col gap-1 min-w-0 mr-4">
                <div className="flex items-center gap-3">
                  {isEditing ? (
                    <div className="flex-1 flex items-center gap-2" onClick={e => e.stopPropagation()}>
                      <input autoFocus type="text" value={tempTitle} onChange={e => setTempTitle(e.target.value)} onBlur={() => { onUpdateChapterTitle(c.id, tempTitle); setEditingChapterId(null); }} className="px-2 py-1 rounded border text-sm font-bold w-full bg-inherit" />
                    </div>
                  ) : (
                    <div className="font-black text-sm truncate flex items-center">{c.title}{renderTextStatusIcon(c)}</div>
                  )}
                  <span className="inline">{renderAudioStatusIcon(c)}</span>
                </div>
                <div className={`h-1 w-full rounded-full overflow-hidden ${isDark ? 'bg-slate-700' : 'bg-black/5'}`}>
                   <div className={`h-full transition-all duration-300 ${isCompleted ? 'bg-emerald-500' : 'bg-indigo-500'}`} style={{ width: `${percent}%` }} />
                </div>
              </div>
              <div className="text-right px-4">
                <span className={`text-[10px] font-black px-2 py-0.5 rounded-full ${isCompleted ? 'bg-emerald-500/20 text-emerald-600' : 'bg-indigo-500/15 text-indigo-500'}`}>{isCompleted ? 'Done' : `${percent}%`}</span>
              </div>
              <div className="flex justify-end items-center gap-2">
                <div className="hidden md:flex items-center gap-2">
                  <button onClick={(e) => { e.stopPropagation(); onResetChapterProgress(book.id, c.id); }} className="p-2 opacity-40 hover:opacity-100 hover:text-indigo-500" title="Reset Progress">
                      <RotateCcw className="w-4 h-4" />
                  </button>
                  <button onClick={(e) => { e.stopPropagation(); setRememberAsDefault(true); setShowVoiceModal({ chapterId: c.id }); }} className="p-2 opacity-40 hover:opacity-100" title="Regenerate Audio"><Headphones className="w-4 h-4" /></button>
                  <button onClick={(e) => { e.stopPropagation(); setEditingChapterId(c.id); setTempTitle(c.title); }} className="p-2 opacity-40 hover:opacity-100" title="Edit Title"><Edit2 className="w-4 h-4" /></button>
                  <button onClick={(e) => { e.stopPropagation(); if (confirm('Delete?')) onDeleteChapter(c.id); }} className="p-2 opacity-40 hover:opacity-100 hover:text-red-500" title="Delete"><Trash2 className="w-4 h-4" /></button>
                </div>
                <div className="md:hidden flex items-center gap-2">
                  <button onClick={(e) => { e.stopPropagation(); setMobileMenuId(c.id); }} className="p-1.5 opacity-40">
                    <GearIcon className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );

  const renderListView = () => (
    <div className="space-y-2">
      {chapters.map(c => {
        let percent = c.progress !== undefined ? Math.floor(c.progress * 100) : 0;
        if (playbackSnapshot && playbackSnapshot.chapterId === c.id) {
             percent = Math.floor(playbackSnapshot.percent * 100);
        }
        const isCompleted = c.isCompleted || false;
        return (
          <div key={c.id} onClick={() => onOpenChapter(c.id)} className={`flex flex-col gap-2 p-4 rounded-2xl border cursor-pointer transition-all hover:translate-x-1 ${cardBg}`}>
            <div className="flex items-center gap-4">
              <div className={`w-8 h-8 rounded-lg flex items-center justify-center font-mono text-[10px] font-black ${isDark ? 'bg-slate-950 text-indigo-400' : 'bg-indigo-50 text-indigo-600'}`}>{c.index}</div>
              <div className="flex-1 min-w-0 font-black text-sm truncate flex items-center">{c.title}{renderTextStatusIcon(c)}</div>
              <div className="flex items-center gap-3">
                <span className="text-[9px] font-black opacity-40 uppercase">{percent}%</span>
                {renderAudioStatusIcon(c)}
                <div className="flex md:hidden gap-1 items-center">
                  <button onClick={(e) => { e.stopPropagation(); setMobileMenuId(c.id); }} className="p-1.5 opacity-40">
                    <GearIcon className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            </div>
            <div className={`h-0.5 w-full rounded-full overflow-hidden ${isDark ? 'bg-slate-700' : 'bg-black/5'}`}>
               <div className="h-full bg-indigo-500 transition-all duration-300" style={{ width: `${percent}%` }} />
            </div>
          </div>
        );
      })}
      {hasMoreChapters && (
        <div ref={loadMoreSentinelRef} className={`py-4 text-center text-xs ${subtleText}`}>
          {isLoadingMoreChapters ? 'Loading more…' : 'Scroll to load more'}
        </div>
      )}
    </div>
  );

  const renderGridView = () => (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
      {chapters.map(c => {
        let percent = c.progress !== undefined ? Math.floor(c.progress * 100) : 0;
        if (playbackSnapshot && playbackSnapshot.chapterId === c.id) {
             percent = Math.floor(playbackSnapshot.percent * 100);
        }
        const isCompleted = c.isCompleted || false;
        return (
          <div key={c.id} onClick={() => onOpenChapter(c.id)} className={`aspect-square p-4 rounded-3xl border flex flex-col items-center justify-center text-center gap-2 cursor-pointer transition-all hover:scale-105 group relative ${cardBg}`}>
            <div className="absolute top-3 right-3 flex gap-1">{renderTextStatusIcon(c)}{renderAudioStatusIcon(c)}</div>
            <div className={`w-12 h-12 rounded-2xl flex items-center justify-center font-mono text-lg font-black mb-1 ${isDark ? 'bg-slate-950 text-indigo-400' : 'bg-indigo-50 text-indigo-600'}`}>{c.index}</div>
            <div className="font-black text-xs line-clamp-2 leading-tight px-1">{c.title}</div>
            <div className="mt-2 w-full px-4">
               <div className={`h-1 w-full rounded-full overflow-hidden ${isDark ? 'bg-slate-700' : 'bg-black/5'}`}><div className="h-full bg-indigo-500 transition-all duration-300" style={{ width: `${percent}%` }} /></div>
               <div className="text-[8px] font-black uppercase mt-1">{percent}%</div>
            </div>
            <button onClick={(e) => { e.stopPropagation(); if (confirm('Delete?')) onDeleteChapter(c.id); }} className="hidden md:block absolute bottom-2 right-2 p-2 opacity-0 group-hover:opacity-100 text-red-500 transition-opacity"><Trash2 className="w-3.5 h-3.5" /></button>
            <div className="md:hidden absolute bottom-2 left-0 right-0 flex justify-center gap-2 px-2">
               <button onClick={(e) => { e.stopPropagation(); setMobileMenuId(c.id); }} className="p-2 bg-black/5 rounded-xl opacity-60">
                 <GearIcon className="w-3.5 h-3.5" />
               </button>
            </div>
          </div>
        );
      })}
      {hasMoreChapters && (
        <div ref={loadMoreSentinelRef} className={`py-4 text-center text-xs ${subtleText}`}>
          {isLoadingMoreChapters ? 'Loading more…' : 'Scroll to load more'}
        </div>
      )}
    </div>
  );

  const hasIssues =
    !!lastScan &&
    (lastScan.missingTextIds.length > 0 ||
      lastScan.missingAudioIds.length > 0 ||
      lastScan.strayFiles.length > 0 ||
      (lastScan as any).legacyCount > 0 ||
      (lastScan as any).unlinkedNewFormatCount > 0);

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
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className={`w-full max-w-lg rounded-[2rem] shadow-2xl p-8 space-y-6 ${isDark ? 'bg-slate-900 border border-slate-800' : 'bg-white border border-black/5'}`}>
            <div className="flex items-center justify-between">
              <div>
                <div className="text-[10px] font-black uppercase tracking-widest opacity-60">Book Settings</div>
                <div className="text-xl font-black tracking-tight">{book.title}</div>
              </div>
              <button onClick={() => setShowBookSettings(false)} className="p-2 opacity-60 hover:opacity-100">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-3">
              <div className="text-[10px] font-black uppercase tracking-widest opacity-60">Cover</div>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => coverInputRef.current?.click()}
                  className="px-4 py-2 rounded-xl bg-indigo-600 text-white text-[10px] font-black uppercase tracking-widest"
                >
                  {book.coverImage ? "Change Cover" : "Add Cover"}
                </button>
                {book.coverImage && (
                  <button
                    onClick={() => onUpdateBook({ ...book, coverImage: undefined, updatedAt: Date.now() })}
                    className="px-4 py-2 rounded-xl bg-black/5 text-black text-[10px] font-black uppercase tracking-widest"
                  >
                    Remove Cover
                  </button>
                )}
              </div>
            </div>

            <div className="space-y-3">
              <div className="text-[10px] font-black uppercase tracking-widest opacity-60">Background Tools</div>
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={handleGenerateMissingAudioBackground}
                  className="px-4 py-2 rounded-xl bg-white text-indigo-600 border border-indigo-600/20 text-[10px] font-black uppercase tracking-widest"
                >
                  {isMobileInterface && enableBackgroundJobs ? "Generate Missing Audio (BG)" : "Generate Missing Audio"}
                </button>
                <button
                  onClick={handleInitManifests}
                  className="px-4 py-2 rounded-xl bg-white text-indigo-600 border border-indigo-600/20 text-[10px] font-black uppercase tracking-widest"
                >
                  Init Manifests
                </button>
                {isMobileInterface && (
                  <button
                    onClick={() => {
                      setShowBookSettings(false);
                      setShowFixModal(true);
                    }}
                    className="px-4 py-2 rounded-xl bg-orange-500 text-white text-[10px] font-black uppercase tracking-widest"
                  >
                    {isMobileInterface && enableBackgroundJobs ? "Fix Integrity (BG)" : "Fix Integrity"}
                  </button>
                )}
              </div>
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
        <div className={`p-4 sm:p-6 lg:p-8 flex flex-col gap-4 ${!isHeaderExpanded ? 'md:block' : ''}`}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <button onClick={onBackToLibrary} className="flex items-center gap-1 text-[10px] font-black uppercase tracking-widest text-indigo-500 hover:translate-x-[-2px] transition-transform"><ChevronLeft className="w-3 h-3" /> Library</button>
            </div>
            <div className="flex items-center gap-1 p-1 rounded-xl bg-black/5">
              <button onClick={() => setViewMode('grid')} className={`p-1.5 rounded-lg transition-all ${viewMode === 'grid' ? 'bg-white shadow-sm text-indigo-600' : 'opacity-40'}`}><LayoutGrid className="w-3.5 h-3.5" /></button>
              <button onClick={() => setViewMode('list')} className={`p-1.5 rounded-lg transition-all ${viewMode === 'list' ? 'bg-white shadow-sm text-indigo-600' : 'opacity-40'}`}><AlignJustify className="w-3.5 h-3.5" /></button>
              <button onClick={() => setViewMode('details')} className={`p-1.5 rounded-lg transition-all ${viewMode === 'details' ? 'bg-white shadow-sm text-indigo-600' : 'opacity-40'}`}><List className="w-3.5 h-3.5" /></button>
            </div>
          </div>
          
          <div className="flex items-center justify-between gap-3">
            <div className={`flex items-center gap-3 sm:gap-8 cursor-pointer md:cursor-default flex-1 min-w-0`} onClick={() => window.innerWidth < 768 && setIsHeaderExpanded(!isHeaderExpanded)}>
              <div className={`rounded-xl sm:rounded-2xl overflow-hidden shadow-xl flex-shrink-0 bg-indigo-600/10 flex items-center justify-center transition-all duration-300 ${isHeaderExpanded ? 'w-24 sm:w-32 aspect-[2/3]' : 'w-12 sm:w-32 aspect-[1/1] sm:aspect-[2/3]'}`}>{book.coverImage ? <img src={book.coverImage} className="w-full h-full object-cover" alt={book.title} /> : <ImageIcon className="w-5 h-5 sm:w-10 sm:h-10 opacity-20" />}</div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <h1 className={`font-black tracking-tight truncate transition-all duration-300 ${isHeaderExpanded ? 'text-xl sm:text-3xl' : 'text-sm sm:text-3xl'}`}>{book.title}</h1>
                  <div className="md:hidden">{isHeaderExpanded ? <ChevronUp className="w-4 h-4 opacity-40" /> : <ChevronDown className="w-4 h-4 opacity-40" />}</div>
                </div>
                <p className={`font-bold opacity-60 uppercase tracking-widest transition-all duration-300 ${isHeaderExpanded ? 'text-[10px] sm:text-xs mt-1' : 'text-[8px] sm:text-xs'}`}>{book.chapterCount ?? book.chapters.length} Chapters {isHeaderExpanded && `• ${book.backend} backend`}</p>
              </div>
            </div>
            <button onClick={() => setShowBookSettings(true)} className="p-2 rounded-lg bg-black/5 hover:bg-black/10">
              <GearIcon className="w-5 h-5" />
            </button>
          </div>

          <div className={`flex flex-wrap gap-2 transition-all duration-300 ${isHeaderExpanded || window.innerWidth >= 768 ? 'opacity-100 max-h-40 pointer-events-auto' : 'opacity-0 max-h-0 pointer-events-none overflow-hidden sm:opacity-100 sm:max-h-40 sm:pointer-events-auto'}`}>
            <button onClick={onAddChapter} className="flex-1 sm:flex-none px-4 py-2 sm:px-6 sm:py-3 bg-indigo-600 text-white rounded-xl sm:rounded-2xl font-black uppercase text-[9px] sm:text-[10px] tracking-widest shadow-xl hover:scale-105 active:scale-95 transition-all flex items-center justify-center gap-2"><Plus className="w-3.5 h-3.5" /> Add Chapter</button>
            <button onClick={handleCheckIntegrity} disabled={isCheckingDrive} className="flex-1 sm:flex-none px-4 py-2 sm:px-6 sm:py-3 bg-white text-indigo-600 border border-indigo-600/20 rounded-xl sm:rounded-2xl font-black uppercase text-[9px] sm:text-[10px] tracking-widest shadow-lg hover:bg-indigo-50 active:scale-95 transition-all flex items-center justify-center gap-2">{isCheckingDrive ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}{isCheckingDrive ? '...' : 'Check'}</button>
            <button
              disabled={!hasIssues}
              className={hasIssues ? "flex-1 sm:flex-none px-4 py-2 sm:px-6 sm:py-3 bg-orange-500 text-white rounded-xl sm:rounded-2xl font-black uppercase text-[9px] sm:text-[10px] tracking-widest shadow-xl hover:scale-105 active:scale-95 transition-all flex items-center justify-center gap-2" : "flex-1 sm:flex-none px-4 py-2 sm:px-6 sm:py-3 bg-orange-500/40 text-white/60 rounded-xl sm:rounded-2xl font-black uppercase text-[9px] sm:text-[10px] tracking-widest cursor-not-allowed flex items-center justify-center gap-2"}
              onClick={() => setShowFixModal(true)}
            >
              <Wrench className="w-3.5 h-3.5" /> FIX
            </button>
          </div>
        </div>
      </div>

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

      <div ref={scrollContainerRef} onScroll={handleScroll} className="flex-1 overflow-y-auto px-4 sm:px-6 py-6 sm:py-8">{chapters.length === 0 ? (<div className="p-12 text-center text-xs font-black opacity-30 uppercase">No chapters found</div>) : (<>{viewMode === 'details' && renderDetailsView()}{viewMode === 'list' && renderListView()}{viewMode === 'grid' && renderGridView()}</>)}</div>
    </div>
  );
};

export default ChapterFolderView;
