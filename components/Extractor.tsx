
import React, { useState, useEffect, useMemo } from 'react';
import { Upload, Plus, AlertCircle, Trash2, Sparkles, FileText, Headphones, Check, X, Loader2, Files } from 'lucide-react';
import { Theme, CLOUD_VOICES, Chapter, UiMode } from '../types';
import { getImportAdapter, PickedFile } from '../services/importAdapter';
import { computeMobileMode } from '../utils/platform';
import { detectVolumeMeta } from '../utils/volumeDetection';

interface ImporterProps {
  onChapterExtracted: (data: { 
    title: string; 
    content: string; 
    contentFormat?: "text" | "markdown";
    url: string; 
    index: number;
    volumeName?: string;
    volumeLocalChapter?: number;
    voiceId: string;
    setAsDefault: boolean;
    keepOpen?: boolean;
  }) => void;
  suggestedIndex: number;
  theme: Theme;
  uiMode: UiMode;
  defaultVoiceId?: string;
  existingChapters: Chapter[];
}

interface SmartFile {
  id: string;
  fileName: string;
  title: string;
  status: 'ready' | 'error' | 'uploaded';
  content: string;
  contentFormat: "text" | "markdown";
  volumeId: string;
  detectedVolumeName: string | null;
  volumeNumber: number | null; // detected for ordering
  volumeLocalChapter: number | null;
}

type SmartVolume = {
  id: string;
  name: string;
  number: number | null;
};

const Extractor: React.FC<ImporterProps> = ({ onChapterExtracted, suggestedIndex, theme, defaultVoiceId, existingChapters, uiMode }) => {
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
  const [smartStep, setSmartStep] = useState<"pick" | "preview">("pick");
  const [smartVolumes, setSmartVolumes] = useState<SmartVolume[]>([]);

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

  const handleAddManual = () => {
    if (!content.trim()) {
      setError("Please paste text or upload a file first.");
      return;
    }
    const finalTitle = title.trim() || `Chapter ${chapterNum}`;
    onChapterExtracted({
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
  };

  // -- Smart Bulk Logic --
  const buildVolumeId = (volumeNumber: number | null): string => {
    return volumeNumber ? `book-${volumeNumber}` : "ungrouped";
  };

  const upsertVolumesForFiles = (files: SmartFile[]) => {
    setSmartVolumes((prev) => {
      const map = new Map(prev.map((v) => [v.id, v] as const));
      for (const f of files) {
        if (map.has(f.volumeId)) continue;
        map.set(f.volumeId, {
          id: f.volumeId,
          name: f.detectedVolumeName ?? "Ungrouped",
          number: f.volumeNumber,
        });
      }
      if (!map.has("ungrouped")) {
        map.set("ungrouped", { id: "ungrouped", name: "Ungrouped", number: null });
      }

      const NONE = 1_000_000_000;
      return Array.from(map.values()).sort((a, b) => {
        const aN = a.number ?? NONE;
        const bN = b.number ?? NONE;
        if (aN !== bN) return aN - bN;
        return a.name.localeCompare(b.name, undefined, { numeric: true });
      });
    });
  };

  const parseSmartFile = async (picked: PickedFile): Promise<SmartFile> => {
    const text = await importAdapter.readText(picked);
    const fileName = picked.name || "Untitled.txt";
    const lines = text.split(/\r?\n/);
    const firstLine = lines.find((l) => l.trim().length > 0) || "";

    const contentFormat = detectFormatFromName(fileName);
    const meta = detectVolumeMeta(fileName, firstLine);

    const volumeId = buildVolumeId(meta.volumeNumber);
    const fallbackTitle = fileName
      .replace(/\.(txt|md)$/i, "")
      .replace(/^\d+\s*/, "")
      .replace(/_/g, " ")
      .trim();

    const title = (meta.title || fallbackTitle || "Imported Chapter").trim();

    return {
      id: crypto.randomUUID(),
      fileName,
      title,
      status: text && text.trim().length ? "ready" : "error",
      content: text,
      contentFormat,
      volumeId,
      detectedVolumeName: meta.volumeName,
      volumeNumber: meta.volumeNumber,
      volumeLocalChapter: meta.volumeLocalChapter,
    };
  };

  const handleBulkPick = async () => {
    try {
      setIsProcessingFiles(true);
      const picks = await importAdapter.pickTextFiles();
      if (!picks.length) {
        setIsProcessingFiles(false);
        return;
      }
      const filtered = picks.filter(p => (p.name || '').toLowerCase().match(/\.(txt|md)$/));
      const newSmartFiles: SmartFile[] = [];
      for (const p of filtered) {
        newSmartFiles.push(await parseSmartFile(p));
      }
      setSmartFiles((prev) => [...prev, ...newSmartFiles]);
      upsertVolumesForFiles(newSmartFiles);
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
    try {
      const picked: PickedFile[] = Array.from(files).map((f) => ({
        name: f.name,
        mimeType: f.type,
        size: f.size,
        file: f,
      }));
      const filtered = picked.filter(p => (p.name || '').toLowerCase().match(/\.(txt|md)$/));
      const newSmartFiles: SmartFile[] = [];
      for (const p of filtered) {
        newSmartFiles.push(await parseSmartFile(p));
      }
      setSmartFiles(prev => [...prev, ...newSmartFiles]);
      upsertVolumesForFiles(newSmartFiles);
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
      const aVol = volumesById.get(a.volumeId)?.number ?? a.volumeNumber ?? NONE;
      const bVol = volumesById.get(b.volumeId)?.number ?? b.volumeNumber ?? NONE;
      if (aVol !== bVol) return aVol - bVol;

      const aCh = a.volumeLocalChapter ?? NONE;
      const bCh = b.volumeLocalChapter ?? NONE;
      if (aCh !== bCh) return aCh - bCh;

      return a.fileName.localeCompare(b.fileName, undefined, { numeric: true });
    });

    return sorted.map((f, i) => ({ ...f, proposedIndex: suggestedIndex + i }));
  }, [smartFiles, smartVolumes, suggestedIndex]);

  const handleBulkImport = async () => {
    const readyFiles = orderedSmartFiles.filter((f) => f.status === "ready");
    if (readyFiles.length === 0) return;

    setIsImporting(true);
    const volumesById = new Map(smartVolumes.map((v) => [v.id, v] as const));

    for (const f of readyFiles) {
      const vol = volumesById.get(f.volumeId);
      const volumeName =
        vol?.name && vol.name.trim().length && vol.name.trim().toLowerCase() !== "ungrouped"
          ? vol.name.trim()
          : undefined;

      onChapterExtracted({
        title: f.title.trim() || `Chapter ${f.proposedIndex}`,
        content: f.content,
        contentFormat: f.contentFormat,
        url: "bulk-import",
        index: f.proposedIndex,
        volumeName,
        volumeLocalChapter: f.volumeLocalChapter ?? undefined,
        voiceId: selectedVoiceId,
        setAsDefault: false,
        keepOpen: true,
      });

      setSmartFiles((prev) => prev.map((pf) => (pf.id === f.id ? { ...pf, status: "uploaded" } : pf)));
      await new Promise((r) => setTimeout(r, 75));
    }

    setIsImporting(false);
  };

  const volumesById = useMemo(() => new Map(smartVolumes.map((v) => [v.id, v] as const)), [smartVolumes]);

  const setSmartFileTitle = (fileId: string, nextTitle: string) => {
    setSmartFiles((prev) => prev.map((f) => (f.id === fileId ? { ...f, title: nextTitle } : f)));
  };

  const moveSmartFileToVolume = (fileId: string, nextVolumeId: string) => {
    setSmartFiles((prev) => prev.map((f) => (f.id === fileId ? { ...f, volumeId: nextVolumeId } : f)));
  };

  const updateSmartVolumeName = (volumeId: string, nextName: string) => {
    setSmartVolumes((prev) =>
      prev.map((v) => {
        if (v.id !== volumeId) return v;
        const m = nextName.match(/^(book|volume)\s*(\d+)/i);
        const nextNumber = m ? parseInt(m[2], 10) : v.number;
        return { ...v, name: nextName, number: Number.isFinite(nextNumber) ? nextNumber : v.number };
      })
    );
  };

  const removeSmartFile = (id: string) => {
    setSmartFiles(prev => prev.filter(f => f.id !== id));
  };

  const clearSmart = () => {
    setSmartFiles([]);
    setSmartVolumes([]);
    setSmartStep("pick");
  };

  // -- Theme helpers --
  const isDark = theme === Theme.DARK;
  const isSepia = theme === Theme.SEPIA;
  const inputBg = isDark ? 'bg-slate-800 text-white border-slate-700' : isSepia ? 'bg-[#efe6d5] text-[#3c2f25] border-[#d8ccb6]' : 'bg-slate-50 text-black border-slate-200';
  const voiceItemBg = isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-black/10';
  const tabInactive = isDark ? 'text-slate-500 hover:text-slate-300' : 'text-slate-400 hover:text-slate-600';
  const tabActive = 'text-indigo-600 border-b-2 border-indigo-600';

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
                  <h3 className="text-lg font-black tracking-tight">Drop .txt/.md files here</h3>
                  <p className="text-xs font-bold opacity-50 mt-1 uppercase tracking-widest">or click to select multiple files</p>
                </div>
              </div>
            </div>

            {isProcessingFiles && (
              <div className="flex justify-center p-4">
                <Loader2 className="w-6 h-6 animate-spin text-indigo-600" />
              </div>
            )}

            <div className="flex-1 overflow-y-auto min-h-[200px] border rounded-2xl bg-black/5 p-4">
              {smartStep === "pick" && smartFiles.length === 0 && !isProcessingFiles && (
                <div className="p-8 text-center opacity-50 text-xs font-bold italic">
                  No files selected yet.
                </div>
              )}

              {smartStep === "preview" && smartFiles.length > 0 && (
                <div className="space-y-4">
                  <div className="text-[10px] font-black uppercase tracking-widest opacity-60">
                    Preview & Edit (global indices will be assigned sequentially starting at {suggestedIndex})
                  </div>

                  {smartVolumes.map((vol) => {
                    const filesInVol = orderedSmartFiles.filter((f) => f.volumeId === vol.id);
                    const readyCount = filesInVol.filter((f) => f.status === "ready").length;

                    return (
                      <div
                        key={vol.id}
                        className={`rounded-2xl border p-4 ${isDark ? "border-slate-700 bg-slate-900/30" : "border-black/10 bg-white/40"}`}
                        onDragOver={(e) => {
                          if (!isMobile) e.preventDefault();
                        }}
                        onDrop={(e) => {
                          e.preventDefault();
                          if (isMobile) return;
                          const fileId = e.dataTransfer.getData("text/talevox-file-id");
                          if (fileId) moveSmartFileToVolume(fileId, vol.id);
                        }}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <input
                            value={vol.name}
                            onChange={(e) => updateSmartVolumeName(vol.id, e.target.value)}
                            className={`flex-1 px-3 py-2 rounded-xl border text-sm font-black outline-none ${inputBg}`}
                          />
                          <div className="text-[10px] font-black uppercase tracking-widest opacity-60 whitespace-nowrap">
                            {readyCount}/{filesInVol.length} ready
                          </div>
                        </div>

                        <div className="mt-3 space-y-2">
                          {filesInVol.map((f) => (
                            <div
                              key={f.id}
                              draggable={!isMobile}
                              onDragStart={(e) => {
                                if (isMobile) return;
                                e.dataTransfer.setData("text/talevox-file-id", f.id);
                                e.dataTransfer.effectAllowed = "move";
                              }}
                              className={`flex items-center gap-3 p-3 rounded-xl border ${isDark ? "border-slate-800 bg-slate-950/40" : "border-black/10 bg-white/60"} ${f.status === "uploaded" ? "opacity-40" : ""}`}
                            >
                              <div className="w-20 shrink-0 font-mono text-[10px] font-black opacity-60">
                                #{String(f.proposedIndex).padStart(3, "0")}
                              </div>

                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2">
                                  <input
                                    value={f.title}
                                    onChange={(e) => setSmartFileTitle(f.id, e.target.value)}
                                    className={`w-full px-2 py-1 rounded-lg border text-xs font-black outline-none ${inputBg}`}
                                  />
                                </div>
                                <div className="mt-1 text-[10px] font-bold opacity-50 truncate">
                                  {vol.name}
                                  {f.volumeLocalChapter ? ` · Ch ${f.volumeLocalChapter}` : ""}
                                  {" · "}
                                  {f.fileName}
                                </div>
                              </div>

                              <div className="flex items-center gap-2">
                                <select
                                  value={f.volumeId}
                                  onChange={(e) => moveSmartFileToVolume(f.id, e.target.value)}
                                  className={`px-2 py-2 rounded-xl border text-[10px] font-black uppercase tracking-widest ${inputBg}`}
                                  title="Move to volume"
                                >
                                  {smartVolumes.map((v) => (
                                    <option key={v.id} value={v.id}>
                                      {v.name}
                                    </option>
                                  ))}
                                </select>
                                <button
                                  onClick={() => removeSmartFile(f.id)}
                                  className="p-2 hover:bg-black/10 rounded-lg text-red-500"
                                  title="Remove"
                                >
                                  <Trash2 className="w-4 h-4" />
                                </button>
                              </div>
                            </div>
                          ))}

                          {filesInVol.length === 0 && (
                            <div className="text-xs opacity-40 italic px-3 py-2">Drop chapters here</div>
                          )}
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
