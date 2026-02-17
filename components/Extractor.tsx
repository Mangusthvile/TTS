
import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Upload, Plus, AlertCircle, Trash2, Sparkles, Headphones, Check, Loader2, Files } from 'lucide-react';
import JSZip from "jszip";
import { Theme, CLOUD_VOICES, Chapter, UiMode } from '../types';
import { getImportAdapter, PickedFile } from '../services/importAdapter';
import { computeMobileMode } from '../utils/platform';
import { detectVolumeMeta } from '../utils/volumeDetection';
import { JobRunner } from '../src/plugins/jobRunner';

interface ImporterProps {
  onChapterExtracted: (data: { 
    title: string; 
    content: string; 
    contentFormat?: "text" | "markdown";
    url: string; 
    sourceUrl?: string;
    index: number;
    volumeName?: string;
    volumeLocalChapter?: number;
    voiceId: string;
    setAsDefault: boolean;
    keepOpen?: boolean;
  }) => void | Promise<void>;
  suggestedIndex: number;
  theme: Theme;
  uiMode: UiMode;
  defaultVoiceId?: string;
  existingChapters: Chapter[];
  existingVolumeNames?: string[];
}

interface SmartFile {
  id: string;
  fileName: string;
  title: string;
  sourceUrl?: string;
  status: 'ready' | 'error' | 'uploaded';
  content: string;
  contentFormat: "text" | "markdown";
  volumeId: string;
  detectedVolumeName: string | null;
  volumeNumber: number | null; // detected for ordering
  volumeLocalChapter: number | null;
  manifestChapterIndex: number | null;
}

type SmartVolume = {
  id: string;
  name: string;
  number: number | null;
};

type ZipManifestChapter = {
  chapterIndex?: number | string | null;
  title?: string | null;
  filename?: string | null;
  sourceUrl?: string | null;
  volumeName?: string | null;
  volumeLocalChapter?: number | string | null;
};

type ManifestLookup = {
  chapters: ZipManifestChapter[];
  byFileName: Map<string, ZipManifestChapter>;
  byChapterIndex: Map<number, ZipManifestChapter>;
  orderByFileName: Map<string, number>;
};

function parsePositiveInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value !== "string") return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function getBaseName(path: string): string {
  const cleaned = String(path || "").replace(/\\/g, "/");
  const parts = cleaned.split("/");
  return parts[parts.length - 1] || cleaned;
}

function detectChapterIndexFromFileName(fileName: string): number | null {
  const base = getBaseName(fileName);
  const fromDoubleUnderscore = base.match(/__(\d{1,6})__/);
  if (fromDoubleUnderscore) return parsePositiveInt(fromDoubleUnderscore[1]);
  const fromChapterToken = base.match(/(?:^|[_\s-])chapter[_\s-]*(\d{1,6})(?:[_\s.-]|$)/i);
  if (fromChapterToken) return parsePositiveInt(fromChapterToken[1]);
  const fromLeading = base.match(/^(\d{1,6})(?:[_\s.-]|$)/);
  if (fromLeading) return parsePositiveInt(fromLeading[1]);
  return null;
}

function buildManifestLookup(chapters: ZipManifestChapter[]): ManifestLookup {
  const byFileName = new Map<string, ZipManifestChapter>();
  const byChapterIndex = new Map<number, ZipManifestChapter>();
  const orderByFileName = new Map<string, number>();

  chapters.forEach((chapter, idx) => {
    const fileName = typeof chapter.filename === "string" ? getBaseName(chapter.filename).toLowerCase() : "";
    if (fileName) {
      if (!byFileName.has(fileName)) byFileName.set(fileName, chapter);
      if (!orderByFileName.has(fileName)) orderByFileName.set(fileName, idx);
    }
    const chapterIndex = parsePositiveInt(chapter.chapterIndex);
    if (chapterIndex && !byChapterIndex.has(chapterIndex)) {
      byChapterIndex.set(chapterIndex, chapter);
    }
  });

  return { chapters, byFileName, byChapterIndex, orderByFileName };
}

function resolveManifestChapter(fileName: string, lookup: ManifestLookup | null): ZipManifestChapter | null {
  if (!lookup) return null;
  const base = getBaseName(fileName).toLowerCase();
  const byName = lookup.byFileName.get(base);
  if (byName) return byName;

  const chapterIndex = detectChapterIndexFromFileName(base);
  if (chapterIndex) return lookup.byChapterIndex.get(chapterIndex) ?? null;
  return null;
}

const Extractor: React.FC<ImporterProps> = ({
  onChapterExtracted,
  suggestedIndex,
  theme,
  defaultVoiceId,
  existingChapters,
  existingVolumeNames = [],
  uiMode,
}) => {
  const [activeTab, setActiveTab] = useState<'manual' | 'smart'>('manual');
  
  // Manual Tab State
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [manualContentFormat, setManualContentFormat] = useState<"text" | "markdown">("text");
  const [chapterNum, setChapterNum] = useState<number>(suggestedIndex);
  const [error, setError] = useState<string | null>(null);
  const [selectedVoiceId, setSelectedVoiceId] = useState(defaultVoiceId || 'en-US-Standard-C');
  const [setAsDefault, setSetAsDefault] = useState(false);
  const [options, setOptions] = useState({ removeBlankLines: true, normalizeSeparators: true });
  
  // Smart Bulk Tab State
  const [smartFiles, setSmartFiles] = useState<SmartFile[]>([]);
  const [isProcessingFiles, setIsProcessingFiles] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [importProgress, setImportProgress] = useState<{
    total: number;
    completed: number;
    failed: number;
    currentTitle: string;
  } | null>(null);
  const [smartStep, setSmartStep] = useState<"pick" | "preview">("pick");
  const [bulkAssignVolumeId, setBulkAssignVolumeId] = useState<string>("ungrouped");

  const importAdapter = useMemo(() => getImportAdapter(uiMode), [uiMode]);
  const isMobile = computeMobileMode(uiMode);

  useEffect(() => {
    setChapterNum(suggestedIndex);
  }, [suggestedIndex]);

  useEffect(() => {
    if (defaultVoiceId) setSelectedVoiceId(defaultVoiceId);
  }, [defaultVoiceId]);

  // -- Manual Logic --
  const detectFormatFromName = (name: string | undefined): "text" | "markdown" => {
    const lower = (name || "").toLowerCase();
    if (lower.endsWith(".md")) return "markdown";
    return "text";
  };

  const cleanText = (text: string) => {
    let result = text;
    result = result.replace(/<[^>]*>?/gm, '');
    if (options.removeBlankLines) {
      result = result.replace(/^\s*[\r\n]/gm, '\n').replace(/\n{3,}/g, '\n\n');
    }
    if (options.normalizeSeparators) {
      result = result.replace(/_{3,}/g, '---').replace(/\*{3,}/g, '***');
    }
    return result.trim();
  };

  const handleManualPick = async () => {
    try {
      const picks = await importAdapter.pickTextFiles();
      if (!picks.length) return;
      const picked = picks[0];
      const text = await importAdapter.readText(picked);
      setContent(text);
      setManualContentFormat(detectFormatFromName(picked.name));
      const guessedTitle = picked.name.replace(/\.(txt|md)$/i, '').replace(/^\d+\s*/, '');
      setTitle(prev => prev || guessedTitle);
      const match = picked.name.match(/^(\d+)/);
      if (match) setChapterNum(parseInt(match[1]));
    } catch (err: any) {
      setError(err?.message || 'Import failed');
    }
  };

  const handleAddManual = async () => {
    if (!content.trim()) {
      setError("Please paste text or upload a file first.");
      return;
    }
    const finalTitle = title.trim() || `Chapter ${chapterNum}`;
    try {
      await onChapterExtracted({
        title: finalTitle,
        content: content,
        contentFormat: manualContentFormat,
        url: 'text-import',
        index: chapterNum,
        voiceId: selectedVoiceId,
        setAsDefault: setAsDefault,
        keepOpen: false
      });
      setTitle('');
      setContent('');
      setManualContentFormat("text");
      setError(null);
    } catch (err: any) {
      setError(err?.message || "Failed to add chapter");
    }
  };

  // -- Smart Bulk Logic --
  const smartVolumes = useMemo<SmartVolume[]>(() => {
    const byKey = new Map<string, SmartVolume>();
    const explicitOrder = new Map<string, number>();
    let explicitIndex = 0;
    const registerVolume = (rawValue: unknown) => {
      if (typeof rawValue !== "string") return;
      const rawName = rawValue.trim();
      if (!rawName) return;
      const key = rawName.toLowerCase();
      if (!explicitOrder.has(key)) {
        explicitOrder.set(key, explicitIndex);
        explicitIndex += 1;
      }
      if (byKey.has(key)) return;
      const m = rawName.match(/^(book|volume)\s*(\d+)/i);
      byKey.set(key, {
        id: `existing:${key}`,
        name: rawName,
        number: m ? Number.parseInt(m[2], 10) : null,
      });
    };
    for (const name of existingVolumeNames || []) {
      registerVolume(name);
    }
    for (const chapter of existingChapters || []) {
      registerVolume((chapter as any)?.volumeName);
    }
    const NONE = 1_000_000_000;
    const sorted = Array.from(byKey.values()).sort((a, b) => {
      const explicitA = explicitOrder.has(a.name.toLowerCase())
        ? explicitOrder.get(a.name.toLowerCase())!
        : NONE;
      const explicitB = explicitOrder.has(b.name.toLowerCase())
        ? explicitOrder.get(b.name.toLowerCase())!
        : NONE;
      if (explicitA !== explicitB) return explicitA - explicitB;
      const aN = Number.isFinite(a.number) ? Number(a.number) : NONE;
      const bN = Number.isFinite(b.number) ? Number(b.number) : NONE;
      if (aN !== bN) return aN - bN;
      return a.name.localeCompare(b.name, undefined, { numeric: true });
    });
    return [{ id: "ungrouped", name: "Unassigned", number: null }, ...sorted];
  }, [existingChapters, existingVolumeNames]);

  const smartVolumeLookupById = useMemo(() => new Map(smartVolumes.map((v) => [v.id, v] as const)), [smartVolumes]);
  const smartVolumeLookupByName = useMemo(() => {
    const map = new Map<string, SmartVolume>();
    for (const vol of smartVolumes) {
      map.set(vol.name.trim().toLowerCase(), vol);
    }
    return map;
  }, [smartVolumes]);

  useEffect(() => {
    if (!smartVolumes.some((v) => v.id === bulkAssignVolumeId)) {
      setBulkAssignVolumeId("ungrouped");
    }
  }, [bulkAssignVolumeId, smartVolumes]);

  const readManifestLookupFromPicks = useCallback(
    async (picks: PickedFile[]): Promise<ManifestLookup | null> => {
      const manifestPick =
        picks.find((p) => (p.name || "").trim().toLowerCase() === "talevox_manifest.json") ||
        picks.find((p) => /manifest.*\.json$/i.test((p.name || "").trim())) ||
        null;
      if (!manifestPick) return null;

      try {
        const raw = await importAdapter.readText(manifestPick);
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed?.chapters)) return null;
        return buildManifestLookup(parsed.chapters as ZipManifestChapter[]);
      } catch (err: any) {
        console.warn("Smart Upload manifest parse failed", err);
        return null;
      }
    },
    [importAdapter]
  );

  const parseSmartFile = async (picked: PickedFile, manifestLookup?: ManifestLookup | null): Promise<SmartFile> => {
    const text = await importAdapter.readText(picked);
    const fileName = picked.name || "Untitled.txt";
    const lines = text.split(/\r?\n/);
    const firstLine = lines.find((l) => l.trim().length > 0) || "";

    const contentFormat = detectFormatFromName(fileName);
    const meta = detectVolumeMeta(fileName, firstLine);
    const manifestMeta = resolveManifestChapter(fileName, manifestLookup ?? null);

    const manifestVolumeName =
      typeof manifestMeta?.volumeName === "string" && manifestMeta.volumeName.trim().length
        ? manifestMeta.volumeName.trim()
        : null;
    const detectedVolumeName = manifestVolumeName || meta.volumeName;
    const detectedKey = (detectedVolumeName || "").trim().toLowerCase();
    const matchedVolume = detectedKey ? smartVolumeLookupByName.get(detectedKey) : null;
    const volumeId = matchedVolume?.id || "ungrouped";
    const fallbackTitle = fileName
      .replace(/\.(txt|md)$/i, "")
      .replace(/^\d+\s*/, "")
      .replace(/_/g, " ")
      .trim();
    const manifestTitle =
      typeof manifestMeta?.title === "string" && manifestMeta.title.trim().length
        ? manifestMeta.title.trim()
        : null;

    const title = (manifestTitle || meta.title || fallbackTitle || "Imported Chapter").trim();

    return {
      id: crypto.randomUUID(),
      fileName,
      title,
      sourceUrl:
        typeof manifestMeta?.sourceUrl === "string" && manifestMeta.sourceUrl.trim().length
          ? manifestMeta.sourceUrl.trim()
          : undefined,
      status: text && text.trim().length ? "ready" : "error",
      content: text,
      contentFormat,
      volumeId,
      detectedVolumeName,
      volumeNumber: meta.volumeNumber,
      volumeLocalChapter:
        parsePositiveInt(manifestMeta?.volumeLocalChapter) ?? meta.volumeLocalChapter,
      manifestChapterIndex:
        parsePositiveInt(manifestMeta?.chapterIndex) ?? detectChapterIndexFromFileName(fileName),
    };
  };

  const parseSmartZip = async (picked: PickedFile): Promise<SmartFile[]> => {
    const bytes = await importAdapter.readBytes(picked);
    const zip = await JSZip.loadAsync(bytes);
    const entries = Object.values(zip.files).filter(
      (entry) => !entry.dir && /\.(txt|md)$/i.test(entry.name)
    );

    if (!entries.length) return [];

    let manifestChapters: ZipManifestChapter[] = [];
    const manifestEntry =
      zip.file("talevox_manifest.json") ||
      Object.values(zip.files).find(
        (entry) => !entry.dir && /manifest/i.test(entry.name) && /\.json$/i.test(entry.name)
      ) ||
      null;

    if (manifestEntry) {
      try {
        const parsed = JSON.parse(await manifestEntry.async("text"));
        if (Array.isArray(parsed?.chapters)) {
          manifestChapters = parsed.chapters as ZipManifestChapter[];
        }
      } catch {
        // Ignore malformed manifest and continue with filename-derived metadata.
      }
    }

    const manifestLookup = buildManifestLookup(manifestChapters);

    const parsedFiles: SmartFile[] = [];
    for (const entry of entries) {
      const fileName = getBaseName(entry.name);
      const text = await entry.async("text");
      const lines = text.split(/\r?\n/);
      const firstLine = lines.find((line) => line.trim().length > 0) || "";
      const contentFormat = detectFormatFromName(fileName);
      const meta = detectVolumeMeta(fileName, firstLine);
      const manifestMeta = resolveManifestChapter(fileName, manifestLookup);

      const fallbackTitle = fileName
        .replace(/\.(txt|md)$/i, "")
        .replace(/^\d+\s*/, "")
        .replace(/_/g, " ")
        .trim();
      const manifestTitle =
        typeof manifestMeta?.title === "string" && manifestMeta.title.trim().length
          ? manifestMeta.title.trim()
          : null;
      const title = (manifestTitle || meta.title || fallbackTitle || "Imported Chapter").trim();

      const manifestVolumeName =
        typeof manifestMeta?.volumeName === "string" && manifestMeta.volumeName.trim().length
          ? manifestMeta.volumeName.trim()
          : null;
      const detectedVolumeName = manifestVolumeName || meta.volumeName;
      const detectedKey = (detectedVolumeName || "").trim().toLowerCase();
      const matchedVolume = detectedKey ? smartVolumeLookupByName.get(detectedKey) : null;
      const volumeId = matchedVolume?.id || "ungrouped";

      parsedFiles.push({
        id: crypto.randomUUID(),
        fileName,
        title,
        sourceUrl:
          typeof manifestMeta?.sourceUrl === "string" && manifestMeta.sourceUrl.trim().length
            ? manifestMeta.sourceUrl.trim()
            : undefined,
        status: text && text.trim().length ? "ready" : "error",
        content: text,
        contentFormat,
        volumeId,
        detectedVolumeName,
        volumeNumber: meta.volumeNumber,
        volumeLocalChapter:
          parsePositiveInt(manifestMeta?.volumeLocalChapter) ?? meta.volumeLocalChapter,
        manifestChapterIndex:
          parsePositiveInt(manifestMeta?.chapterIndex) ?? detectChapterIndexFromFileName(fileName),
      });
    }
    parsedFiles.sort((a, b) => {
      const aOrder = manifestLookup.orderByFileName.get(a.fileName.toLowerCase());
      const bOrder = manifestLookup.orderByFileName.get(b.fileName.toLowerCase());
      if (typeof aOrder === "number" && typeof bOrder === "number" && aOrder !== bOrder) {
        return aOrder - bOrder;
      }
      if (typeof aOrder === "number") return -1;
      if (typeof bOrder === "number") return 1;
      return a.fileName.localeCompare(b.fileName, undefined, { numeric: true });
    });

    return parsedFiles;
  };

  const handleBulkPick = async () => {
    try {
      setIsProcessingFiles(true);
      setImportProgress(null);
      const picks = await importAdapter.pickTextFiles();
      if (!picks.length) {
        setIsProcessingFiles(false);
        return;
      }
      const manifestLookup = await readManifestLookupFromPicks(picks);
      const filtered = picks.filter((p) => (p.name || "").toLowerCase().match(/\.(txt|md|zip|json)$/));
      const newSmartFiles: SmartFile[] = [];
      for (const p of filtered) {
        const lowerName = (p.name || "").toLowerCase();
        if (lowerName.endsWith(".json")) continue;
        if ((p.name || "").toLowerCase().endsWith(".zip")) {
          newSmartFiles.push(...(await parseSmartZip(p)));
        } else {
          newSmartFiles.push(await parseSmartFile(p, manifestLookup));
        }
      }
      setSmartFiles((prev) => [...prev, ...newSmartFiles]);
      setSmartStep("preview");
    } catch (err: any) {
      setError(err?.message || 'Import failed');
    } finally {
      setIsProcessingFiles(false);
    }
  };

  const handleDroppedFiles = async (files: FileList | null) => {
    if (!files || !files.length) return;
    if (isMobile) return; // skip on mobile
    setIsProcessingFiles(true);
    setImportProgress(null);
    try {
      const picked: PickedFile[] = Array.from(files).map((f) => ({
        name: f.name,
        mimeType: f.type,
        size: f.size,
        file: f,
      }));
      const manifestLookup = await readManifestLookupFromPicks(picked);
      const filtered = picked.filter((p) => (p.name || "").toLowerCase().match(/\.(txt|md|zip|json)$/));
      const newSmartFiles: SmartFile[] = [];
      for (const p of filtered) {
        const lowerName = (p.name || "").toLowerCase();
        if (lowerName.endsWith(".json")) continue;
        if ((p.name || "").toLowerCase().endsWith(".zip")) {
          newSmartFiles.push(...(await parseSmartZip(p)));
        } else {
          newSmartFiles.push(await parseSmartFile(p, manifestLookup));
        }
      }
      setSmartFiles(prev => [...prev, ...newSmartFiles]);
      setSmartStep("preview");
    } catch (err: any) {
      setError(err?.message || 'Import failed');
    } finally {
      setIsProcessingFiles(false);
    }
  };

  const orderedSmartFiles = useMemo<Array<SmartFile & { proposedIndex: number }>>(() => {
    const volumesById = new Map(smartVolumes.map((v) => [v.id, v] as const));
    const NONE = 1_000_000_000;

    const sorted = [...smartFiles].sort((a, b) => {
      const aManifest = a.manifestChapterIndex ?? NONE;
      const bManifest = b.manifestChapterIndex ?? NONE;
      if (aManifest !== bManifest) return aManifest - bManifest;

      const aVol = volumesById.get(a.volumeId)?.number ?? a.volumeNumber ?? NONE;
      const bVol = volumesById.get(b.volumeId)?.number ?? b.volumeNumber ?? NONE;
      if (aVol !== bVol) return aVol - bVol;

      const aCh = a.volumeLocalChapter ?? NONE;
      const bCh = b.volumeLocalChapter ?? NONE;
      if (aCh !== bCh) return aCh - bCh;

      return a.fileName.localeCompare(b.fileName, undefined, { numeric: true });
    });

    const used = new Set<number>();
    let cursor = suggestedIndex;
    return sorted.map((file) => {
      let proposedIndex = file.manifestChapterIndex ?? 0;
      if (!Number.isFinite(proposedIndex) || proposedIndex <= 0 || used.has(proposedIndex)) {
        while (used.has(cursor)) cursor += 1;
        proposedIndex = cursor;
      }
      used.add(proposedIndex);
      if (cursor <= proposedIndex) cursor = proposedIndex + 1;
      return { ...file, proposedIndex };
    });
  }, [smartFiles, smartVolumes, suggestedIndex]);

  const notifyBulkUploadOutsideApp = useCallback(async () => {
    try {
      const status = await JobRunner.checkNotificationPermission();
      if (status?.supported && status.granted && status.enabled) {
        await JobRunner.sendTestNotification();
        return;
      }
    } catch {
      // Fall back to browser notifications below when plugin is unavailable.
    }

    if (typeof window === "undefined" || !("Notification" in window)) return;
    try {
      if (window.Notification.permission === "default") {
        await window.Notification.requestPermission();
      }
      if (window.Notification.permission === "granted") {
        void new window.Notification("TaleVox", {
          body: "Chapter upload progress updated.",
        });
      }
    } catch {
      // Best-effort only.
    }
  }, []);

  const handleBulkImport = async () => {
    const readyFiles = orderedSmartFiles.filter((f) => f.status === "ready");
    if (readyFiles.length === 0) return;

    setIsImporting(true);
    setImportProgress({
      total: readyFiles.length,
      completed: 0,
      failed: 0,
      currentTitle: "",
    });
    await notifyBulkUploadOutsideApp();
    let completed = 0;
    let failed = 0;
    for (const f of readyFiles) {
      const vol = smartVolumeLookupById.get(f.volumeId);
      const volumeName =
        vol?.id !== "ungrouped" && vol?.name && vol.name.trim().length
          ? vol.name.trim()
          : undefined;

      setImportProgress((prev) =>
        prev
          ? {
              ...prev,
              currentTitle: f.title.trim() || f.fileName,
            }
          : prev
      );
      try {
        await onChapterExtracted({
          title: f.title.trim() || `Chapter ${f.proposedIndex}`,
          content: f.content,
          contentFormat: f.contentFormat,
          url: "bulk-import",
          sourceUrl: f.sourceUrl,
          index: f.proposedIndex,
          volumeName,
          volumeLocalChapter: f.volumeLocalChapter ?? undefined,
          voiceId: selectedVoiceId,
          setAsDefault: false,
          keepOpen: true,
        });
        completed += 1;
        setSmartFiles((prev) => prev.map((pf) => (pf.id === f.id ? { ...pf, status: "uploaded" } : pf)));
      } catch {
        failed += 1;
        setSmartFiles((prev) => prev.map((pf) => (pf.id === f.id ? { ...pf, status: "error" } : pf)));
      }
      setImportProgress((prev) =>
        prev
          ? {
              ...prev,
              completed,
              failed,
            }
          : prev
      );
      await new Promise((r) => setTimeout(r, 75));
    }

    setIsImporting(false);
    await notifyBulkUploadOutsideApp();
  };

  const setSmartFileTitle = (fileId: string, nextTitle: string) => {
    setSmartFiles((prev) => prev.map((f) => (f.id === fileId ? { ...f, title: nextTitle } : f)));
  };

  const moveSmartFileToVolume = (fileId: string, nextVolumeId: string) => {
    setSmartFiles((prev) => prev.map((f) => (f.id === fileId ? { ...f, volumeId: nextVolumeId } : f)));
  };

  const applyVolumeToAllSmartFiles = (volumeId: string) => {
    setSmartFiles((prev) => prev.map((f) => ({ ...f, volumeId })));
  };

  const removeSmartFile = (id: string) => {
    setSmartFiles(prev => prev.filter(f => f.id !== id));
  };

  const clearSmart = () => {
    setSmartFiles([]);
    setSmartStep("pick");
    setBulkAssignVolumeId("ungrouped");
    setImportProgress(null);
  };

  // -- Theme helpers --
  const isDark = theme === Theme.DARK;
  const isSepia = theme === Theme.SEPIA;
  const inputBg = isDark ? 'bg-slate-800 text-white border-slate-700' : isSepia ? 'bg-[#efe6d5] text-[#3c2f25] border-[#d8ccb6]' : 'bg-slate-50 text-black border-slate-200';
  const voiceItemBg = isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-black/10';
  const tabInactive = isDark ? 'text-slate-500 hover:text-slate-300' : 'text-slate-400 hover:text-slate-600';
  const tabActive = 'text-indigo-600 border-b-2 border-indigo-600';
  const importPercent = importProgress
    ? Math.max(0, Math.min(100, Math.round((importProgress.completed / Math.max(1, importProgress.total)) * 100)))
    : 0;

  return (
    <div className={`border rounded-[2.5rem] shadow-2xl overflow-hidden transition-colors duration-500 max-w-4xl mx-auto flex flex-col max-h-[85vh] ${isDark ? 'bg-slate-900 border-white/10' : isSepia ? 'bg-[#f4ecd8] border-[#d8ccb6]' : 'bg-white border-black/10'}`}>
      {/* Header & Tabs */}
      <div className={`flex-shrink-0 p-6 sm:p-8 pb-0 ${isDark ? 'bg-slate-900' : 'bg-white/50'}`}>
        <h2 className={`text-2xl font-black tracking-tight mb-6 ${isDark ? 'text-white' : 'text-black'}`}>Add New Chapter</h2>
        <div className="flex gap-8 border-b border-black/10">
          <button 
            onClick={() => setActiveTab('manual')} 
            className={`pb-4 text-xs font-black uppercase tracking-widest transition-all ${activeTab === 'manual' ? tabActive : tabInactive}`}
          >
            Manual Input
          </button>
          <button 
            onClick={() => setActiveTab('smart')} 
            className={`pb-4 text-xs font-black uppercase tracking-widest transition-all ${activeTab === 'smart' ? tabActive : tabInactive}`}
          >
            Smart Upload
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6 sm:p-8">
        {activeTab === 'manual' && (
          <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-300">
            {error && (
              <div className="flex items-center gap-3 p-4 bg-red-500/10 border border-red-500/20 text-red-500 rounded-2xl text-xs font-bold">
                <AlertCircle className="w-4 h-4" /> {error}
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
              <div className="md:col-span-3 space-y-2">
                <label className="text-[10px] font-black uppercase tracking-widest opacity-60">Chapter Title</label>
                <input 
                  type="text" 
                  value={title} 
                  onChange={(e) => setTitle(e.target.value)} 
                  placeholder="e.g. Chapter 1: The Beginning" 
                  className={`w-full px-4 py-4 rounded-xl border outline-none font-black text-sm transition-all focus:ring-2 focus:ring-indigo-500 ${inputBg}`} 
                />
              </div>
              <div className="space-y-2">
                <label className="text-[10px] font-black uppercase tracking-widest opacity-60">Chapter #</label>
                <input 
                  type="number" 
                  value={chapterNum} 
                  onChange={(e) => setChapterNum(parseInt(e.target.value) || 0)} 
                  className={`w-full px-4 py-4 rounded-xl border outline-none font-black text-sm focus:ring-2 focus:ring-indigo-500 ${inputBg}`} 
                />
              </div>
            </div>

            <div className="space-y-4">
              <div className="flex flex-col gap-2">
                 <label className="text-[10px] font-black uppercase tracking-widest opacity-60 flex items-center gap-2">
                   <Headphones className="w-3.5 h-3.5" /> Audio Synthesis Voice
                 </label>
                 <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                    {CLOUD_VOICES.map(v => (
                      <button 
                        key={v.id} 
                        onClick={() => setSelectedVoiceId(v.id)}
                        className={`flex items-center justify-between px-4 py-3 rounded-xl border-2 text-left transition-all ${selectedVoiceId === v.id ? 'border-indigo-600 bg-indigo-600/5' : 'border-transparent ' + voiceItemBg}`}
                      >
                        <span className="text-xs font-black truncate mr-2">{v.name}</span>
                        {selectedVoiceId === v.id && <Check className="w-4 h-4 text-indigo-600 flex-shrink-0" />}
                      </button>
                    ))}
                 </div>
                 <label className="mt-2 flex items-center gap-2 cursor-pointer group">
                   <div className={`w-5 h-5 rounded-md border-2 flex items-center justify-center transition-all ${setAsDefault ? 'bg-indigo-600 border-indigo-600' : 'border-black/10'}`}>
                     <input type="checkbox" className="hidden" checked={setAsDefault} onChange={e => setSetAsDefault(e.target.checked)} />
                     {setAsDefault && <Check className="w-3.5 h-3.5 text-white" />}
                   </div>
                   <span className="text-[10px] font-black uppercase tracking-widest opacity-60 group-hover:opacity-100">Set as book default</span>
                 </label>
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex justify-between items-center pr-1 mb-1">
                <label className="text-[10px] font-black uppercase tracking-widest opacity-60">
                  Text Content
                </label>
                <div className="flex gap-2">
                  <button 
                    onClick={() => { setContent(''); }} 
                    className={`p-2 rounded-xl transition-all ${isDark ? 'bg-white/5 hover:bg-red-500/20' : 'bg-black/5 hover:bg-red-500/10'}`}
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                  <button onClick={handleManualPick} className={`flex items-center gap-1.5 px-4 py-2 rounded-xl text-[10px] font-black uppercase border transition-all ${isDark ? 'border-slate-700 hover:bg-white/5' : 'border-slate-200 hover:bg-black/5'}`}>
                    <Upload className="w-3.5 h-3.5" /> Upload .TXT/.MD
                  </button>
                  <button onClick={() => setContent(cleanText(content))} disabled={!content.trim()} className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-[10px] font-black uppercase bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 transition-all shadow-md">
                    <Sparkles className="w-3.5 h-3.5" /> Quick Clean
                  </button>
                </div>
              </div>
              <textarea 
                value={content} 
                onChange={(e) => setContent(e.target.value)} 
                placeholder="Paste your text content here..." 
                className={`w-full h-80 px-6 py-6 rounded-3xl focus:ring-2 focus:ring-indigo-500 outline-none font-bold transition-all resize-none leading-relaxed border ${inputBg}`} 
              />
            </div>

            <button 
              onClick={handleAddManual} 
              disabled={!content.trim() || !selectedVoiceId} 
              className="w-full py-6 bg-indigo-600 text-white rounded-[1.5rem] font-black uppercase tracking-[0.3em] shadow-2xl hover:bg-indigo-700 transition-all flex items-center justify-center gap-4 active:scale-[0.98] text-sm disabled:opacity-50"
            >
              <Plus className="w-6 h-6" /> SAVE TO COLLECTION
            </button>
          </div>
        )}

        {activeTab === 'smart' && (
          <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-300 h-full flex flex-col">
            <div 
              className={`border-2 border-dashed rounded-3xl p-8 text-center transition-all cursor-pointer ${isDark ? 'border-slate-700 hover:bg-slate-800' : 'border-slate-300 hover:bg-slate-50'}`}
              onDragOver={e => e.preventDefault()}
              onDrop={e => { e.preventDefault(); if (!isMobile && e.dataTransfer?.files?.length) { void handleDroppedFiles(e.dataTransfer.files); } }}
              onClick={handleBulkPick}
            >
              <div className="flex flex-col items-center gap-4">
                <div className={`p-4 rounded-full ${isDark ? 'bg-indigo-900/30 text-indigo-400' : 'bg-indigo-50 text-indigo-600'}`}>
                  <Files className="w-8 h-8" />
                </div>
                <div>
                  <h3 className="text-lg font-black tracking-tight">Drop .txt/.md/.zip files here</h3>
                  <p className="text-xs font-bold opacity-50 mt-1 uppercase tracking-widest">or click to select multiple files</p>
                </div>
              </div>
            </div>

            {isProcessingFiles && (
              <div className="flex justify-center p-4">
                <Loader2 className="w-6 h-6 animate-spin text-indigo-600" />
              </div>
            )}

            <div className="flex-1 overflow-y-auto overflow-x-hidden min-h-[200px] border rounded-2xl bg-black/5 p-4">
              {smartStep === "pick" && smartFiles.length === 0 && !isProcessingFiles && (
                <div className="p-8 text-center opacity-50 text-xs font-bold italic">
                  No files selected yet.
                </div>
              )}

              {smartStep === "preview" && smartFiles.length > 0 && (
                <div className="space-y-4">
                  <div className="text-[10px] font-black uppercase tracking-widest opacity-60">
                    Preview & Edit (manifest chapter indices are used when available)
                  </div>
                  {importProgress ? (
                    <div className={`rounded-2xl border p-3 space-y-2 ${isDark ? "border-slate-700 bg-slate-900/40" : "border-black/10 bg-white/60"}`}>
                      <div className="flex items-center justify-between text-[10px] font-black uppercase tracking-widest">
                        <span>Uploading chapters</span>
                        <span>{importProgress.completed}/{importProgress.total}</span>
                      </div>
                      <div className={`h-2 rounded-full overflow-hidden ${isDark ? "bg-slate-800" : "bg-black/10"}`}>
                        <div
                          className="h-full bg-indigo-500 transition-all duration-300"
                          style={{ width: `${importPercent}%` }}
                        />
                      </div>
                      <div className="text-[10px] font-bold opacity-70 truncate">
                        {importProgress.currentTitle
                          ? `Current: ${importProgress.currentTitle}`
                          : "Preparing uploads..."}
                        {importProgress.failed > 0 ? ` · Failed: ${importProgress.failed}` : ""}
                      </div>
                    </div>
                  ) : null}

                  <div className={`rounded-2xl border p-3 text-[10px] font-bold ${isDark ? "border-slate-700 bg-slate-900/30" : "border-black/10 bg-white/40"}`}>
                    Smart Upload will only assign chapters to existing volumes or Unassigned.
                  </div>
                  <div className={`rounded-2xl border p-3 space-y-2 ${isDark ? "border-slate-700 bg-slate-900/30" : "border-black/10 bg-white/40"}`}>
                    <div className="text-[10px] font-black uppercase tracking-widest opacity-60">
                      Assign one volume to all
                    </div>
                    <div className="flex flex-col gap-2 sm:flex-row">
                      <select
                        value={bulkAssignVolumeId}
                        onChange={(e) => setBulkAssignVolumeId(e.target.value)}
                        className={`w-full min-w-0 px-3 py-2 rounded-xl border text-[11px] font-black uppercase tracking-widest ${inputBg}`}
                        title="Choose volume for all files"
                      >
                        {smartVolumes.map((v) => (
                          <option key={v.id} value={v.id}>
                            {v.name}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        onClick={() => applyVolumeToAllSmartFiles(bulkAssignVolumeId)}
                        className="w-full sm:w-auto px-4 py-2 rounded-xl bg-indigo-600 text-white text-[10px] font-black uppercase tracking-widest hover:bg-indigo-700"
                      >
                        Assign all
                      </button>
                    </div>
                    <div className="text-[10px] font-bold opacity-60">
                      You can still change any chapter volume individually below.
                    </div>
                  </div>
                  {orderedSmartFiles.map((f) => {
                    const assignedVolume = smartVolumeLookupById.get(f.volumeId);
                    const detectedName = (f.detectedVolumeName || "").trim();
                    const detectedMissing =
                      detectedName.length > 0 && !smartVolumeLookupByName.has(detectedName.toLowerCase());
                    return (
                      <div
                        key={f.id}
                        className={`p-3 rounded-xl border ${isDark ? "border-slate-800 bg-slate-950/40" : "border-black/10 bg-white/60"} ${f.status === "uploaded" ? "opacity-40" : ""}`}
                      >
                        <div className="flex items-start gap-2">
                          <div className="w-16 shrink-0 pt-2 font-mono text-[10px] font-black opacity-60">
                            #{String(f.proposedIndex).padStart(3, "0")}
                          </div>
                          <div className="flex-1 min-w-0">
                            <input
                              value={f.title}
                              onChange={(e) => setSmartFileTitle(f.id, e.target.value)}
                              className={`w-full px-2 py-1.5 rounded-lg border text-xs font-black outline-none ${inputBg}`}
                            />
                            <div className="mt-1 text-[10px] font-bold opacity-50 truncate">
                              {assignedVolume?.name || "Unassigned"}
                              {f.volumeLocalChapter ? ` - Ch ${f.volumeLocalChapter}` : ""}
                              {f.manifestChapterIndex ? ` - Manifest ${f.manifestChapterIndex}` : ""}
                              {" - "}
                              {f.fileName}
                            </div>
                            {detectedMissing ? (
                              <div className="mt-1 text-[10px] font-bold text-amber-500">
                                Detected "{detectedName}" is not an existing volume. Choose an existing volume or Unassigned.
                              </div>
                            ) : null}
                          </div>

                          <button
                            onClick={() => removeSmartFile(f.id)}
                            className="p-2 hover:bg-black/10 rounded-lg text-red-500 shrink-0"
                            title="Remove"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                        <div className="mt-3">
                          <select
                            value={f.volumeId}
                            onChange={(e) => moveSmartFileToVolume(f.id, e.target.value)}
                            className={`w-full min-w-0 px-3 py-2 rounded-xl border text-[11px] font-black uppercase tracking-widest ${inputBg}`}
                            title="Assign volume"
                          >
                            {smartVolumes.map((v) => (
                              <option key={v.id} value={v.id}>
                                {v.name}
                              </option>
                            ))}
                          </select>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="flex justify-between items-center pt-2">
              <button onClick={clearSmart} className="px-6 py-3 text-xs font-black uppercase tracking-widest opacity-60 hover:opacity-100">Clear List</button>
              <button 
                onClick={handleBulkImport}
                disabled={isImporting || orderedSmartFiles.filter(f => f.status === 'ready').length === 0}
                className="px-8 py-4 bg-indigo-600 text-white rounded-xl font-black uppercase tracking-widest shadow-xl hover:bg-indigo-700 disabled:opacity-50 flex items-center gap-2"
              >
                {isImporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                Import {orderedSmartFiles.filter(f => f.status === 'ready').length} Files
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default Extractor;
