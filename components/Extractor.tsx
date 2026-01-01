
import React, { useState, useRef, useEffect } from 'react';
import { Upload, Plus, AlertCircle, Trash2, Sparkles, FileText, Headphones, Check, X, Loader2, Files, RefreshCw } from 'lucide-react';
import { Theme, CLOUD_VOICES, Chapter } from '../types';

interface ImporterProps {
  onChapterExtracted: (data: { 
    title: string; 
    content: string; 
    url: string; 
    index: number;
    voiceId: string;
    setAsDefault: boolean;
    keepOpen?: boolean;
  }) => Promise<void>;
  suggestedIndex: number;
  theme: Theme;
  defaultVoiceId?: string;
  existingChapters: Chapter[];
  onClose: () => void;
}

interface SmartFile {
  id: string;
  file: File;
  parsedIndex: number | null;
  parsedTitle: string | null;
  status: 'pending' | 'ready' | 'duplicate' | 'error' | 'uploaded';
  content: string | null;
}

const Extractor: React.FC<ImporterProps> = ({ onChapterExtracted, suggestedIndex, theme, defaultVoiceId, existingChapters, onClose }) => {
  const [activeTab, setActiveTab] = useState<'manual' | 'smart'>('manual');
  
  // Manual Tab State
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [chapterNum, setChapterNum] = useState<number>(suggestedIndex);
  const [error, setError] = useState<string | null>(null);
  const [selectedVoiceId, setSelectedVoiceId] = useState(defaultVoiceId || 'en-US-Standard-C');
  const [setAsDefault, setSetAsDefault] = useState(false);
  const [options, setOptions] = useState({ removeBlankLines: true, normalizeSeparators: true });
  
  // Smart Bulk Tab State
  const [smartFiles, setSmartFiles] = useState<SmartFile[]>([]);
  const [isProcessingFiles, setIsProcessingFiles] = useState(false);
  const [isImporting, setIsImporting] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const bulkInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setChapterNum(suggestedIndex);
  }, [suggestedIndex]);

  useEffect(() => {
    if (defaultVoiceId) setSelectedVoiceId(defaultVoiceId);
  }, [defaultVoiceId]);

  // -- Manual Logic --
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

  const handleManualFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target?.result as string;
      setContent(text);
      const guessedTitle = file.name.replace(/\.txt$/i, '').replace(/^\d+\s*/, '');
      setTitle(prev => prev || guessedTitle);
      const match = file.name.match(/^(\d+)/);
      if (match) setChapterNum(parseInt(match[1]));
    };
    reader.readAsText(file);
    e.target.value = '';
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
          url: 'text-import',
          index: chapterNum,
          voiceId: selectedVoiceId,
          setAsDefault: setAsDefault,
          keepOpen: false
        });
        setTitle('');
        setContent('');
        setError(null);
    } catch(e) {
        setError("Import failed. See toast.");
    }
  };

  // -- Smart Bulk Logic --
  const parseFile = async (file: File): Promise<SmartFile> => {
    const text = await file.text();
    const lines = text.split(/\r?\n/);
    const firstLine = lines.find(l => l.trim().length > 0) || '';
    
    let index: number | null = null;
    let chTitle: string | null = null;
    let finalContent = text;

    // A) Try First Line Header Match
    const headerMatch = firstLine.match(/^Chapter\s+(\d+)\s*(.*)$/i);
    if (headerMatch) {
      index = parseInt(headerMatch[1]);
      chTitle = headerMatch[2].trim();
      // Content is text after the header line
      const headerIdx = text.indexOf(firstLine);
      if (headerIdx !== -1) {
        finalContent = text.substring(headerIdx + firstLine.length).trim();
      }
    } else {
      // B) Try Filename Match
      const fileMatch = file.name.match(/Chapter[_\s-]*(\d+)[_\s-]*(.*)\.txt/i);
      if (fileMatch) {
        index = parseInt(fileMatch[1]);
        chTitle = fileMatch[2].trim().replace(/_/g, ' ') || `Chapter ${index}`;
        finalContent = text;
      }
    }

    let status: SmartFile['status'] = (index !== null) ? 'ready' : 'error';
    
    // Duplicate Check
    if (status === 'ready' && index !== null) {
      if (existingChapters.some(c => c.index === index)) {
        status = 'duplicate';
      }
    }

    return {
      id: crypto.randomUUID(),
      file,
      parsedIndex: index,
      parsedTitle: chTitle,
      status,
      content: finalContent
    };
  };

  const handleBulkFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setIsProcessingFiles(true);
    const newSmartFiles: SmartFile[] = [];
    for (let i = 0; i < files.length; i++) {
      if (files[i].name.toLowerCase().endsWith('.txt')) {
        newSmartFiles.push(await parseFile(files[i]));
      }
    }
    setSmartFiles(prev => [...prev, ...newSmartFiles]);
    setIsProcessingFiles(false);
    if (bulkInputRef.current) bulkInputRef.current.value = '';
  };

  const handleBulkImport = async () => {
    const readyFiles = smartFiles.filter(f => f.status === 'ready' || f.status === 'error');
    if (readyFiles.length === 0) return;
    
    setIsImporting(true);
    let errorCount = 0;

    // Process sequentially to ensure order and avoid overwhelming
    for (const f of readyFiles) {
      if (f.parsedIndex !== null && f.parsedTitle !== null && f.content) {
        try {
            await onChapterExtracted({
              title: f.parsedTitle,
              content: f.content,
              url: 'bulk-import',
              index: f.parsedIndex,
              voiceId: selectedVoiceId,
              setAsDefault: false, // Don't override defaults during bulk
              keepOpen: true
            });
            // Mark locally as uploaded
            setSmartFiles(prev => prev.map(pf => pf.id === f.id ? { ...pf, status: 'uploaded' } : pf));
        } catch (e) {
            // Mark as error
            setSmartFiles(prev => prev.map(pf => pf.id === f.id ? { ...pf, status: 'error' } : pf));
            errorCount++;
        }
        // Small delay to let app state update slightly
        await new Promise(r => setTimeout(r, 100));
      }
    }
    setIsImporting(false);

    // Auto-close if everything succeeded
    if (errorCount === 0) {
        onClose();
    }
  };

  const removeSmartFile = (id: string) => {
    setSmartFiles(prev => prev.filter(f => f.id !== id));
  };

  const readyCount = smartFiles.filter(f => f.status === 'ready').length;
  const errorCount = smartFiles.filter(f => f.status === 'error').length;
  const isRetryMode = errorCount > 0;

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
                  <button onClick={() => fileInputRef.current?.click()} className={`flex items-center gap-1.5 px-4 py-2 rounded-xl text-[10px] font-black uppercase border transition-all ${isDark ? 'border-slate-700 hover:bg-white/5' : 'border-slate-200 hover:bg-black/5'}`}>
                    <Upload className="w-3.5 h-3.5" /> Upload .TXT
                  </button>
                  <input type="file" ref={fileInputRef} className="hidden" accept=".txt" onChange={handleManualFileUpload} />
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
              onDrop={e => { e.preventDefault(); handleBulkFiles(e.dataTransfer.files); }}
              onClick={() => bulkInputRef.current?.click()}
            >
              <input type="file" ref={bulkInputRef} className="hidden" accept=".txt" multiple onChange={e => handleBulkFiles(e.target.files)} />
              <div className="flex flex-col items-center gap-4">
                <div className={`p-4 rounded-full ${isDark ? 'bg-indigo-900/30 text-indigo-400' : 'bg-indigo-50 text-indigo-600'}`}>
                  <Files className="w-8 h-8" />
                </div>
                <div>
                  <h3 className="text-lg font-black tracking-tight">Drop .txt files here</h3>
                  <p className="text-xs font-bold opacity-50 mt-1 uppercase tracking-widest">or click to select multiple files</p>
                </div>
              </div>
            </div>

            {isProcessingFiles && (
              <div className="flex justify-center p-4">
                <Loader2 className="w-6 h-6 animate-spin text-indigo-600" />
              </div>
            )}

            <div className="flex-1 overflow-y-auto min-h-[200px] border rounded-2xl bg-black/5 p-1">
              <table className="w-full text-left border-collapse">
                <thead className="text-[10px] font-black uppercase tracking-widest opacity-50 border-b border-black/10">
                  <tr>
                    <th className="p-3">Status</th>
                    <th className="p-3">File</th>
                    <th className="p-3">Parsed As</th>
                    <th className="p-3 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="text-xs font-bold">
                  {smartFiles.map(f => (
                    <tr key={f.id} className={`border-b border-black/5 last:border-0 ${f.status === 'uploaded' ? 'opacity-40' : ''}`}>
                      <td className="p-3">
                        {f.status === 'ready' && <span className="inline-flex items-center gap-1 text-emerald-600 bg-emerald-100 px-2 py-1 rounded-lg text-[10px] font-black uppercase"><Check className="w-3 h-3" /> Ready</span>}
                        {f.status === 'duplicate' && <span className="inline-flex items-center gap-1 text-amber-600 bg-amber-100 px-2 py-1 rounded-lg text-[10px] font-black uppercase"><AlertCircle className="w-3 h-3" /> Duplicate</span>}
                        {f.status === 'error' && <span className="inline-flex items-center gap-1 text-red-600 bg-red-100 px-2 py-1 rounded-lg text-[10px] font-black uppercase"><X className="w-3 h-3" /> Error</span>}
                        {f.status === 'uploaded' && <span className="inline-flex items-center gap-1 text-indigo-600 bg-indigo-100 px-2 py-1 rounded-lg text-[10px] font-black uppercase"><Check className="w-3 h-3" /> Done</span>}
                      </td>
                      <td className="p-3 truncate max-w-[150px]" title={f.file.name}>{f.file.name}</td>
                      <td className="p-3">
                        {f.parsedIndex !== null ? (
                          <div className="flex flex-col">
                            <span className="text-indigo-600">CH {f.parsedIndex}</span>
                            <span className="opacity-60 truncate max-w-[200px]">{f.parsedTitle}</span>
                          </div>
                        ) : <span className="opacity-40 italic">Unknown</span>}
                      </td>
                      <td className="p-3 text-right">
                        <button onClick={() => removeSmartFile(f.id)} className="p-2 hover:bg-black/10 rounded-lg text-red-500"><Trash2 className="w-4 h-4" /></button>
                      </td>
                    </tr>
                  ))}
                  {smartFiles.length === 0 && !isProcessingFiles && (
                    <tr>
                      <td colSpan={4} className="p-8 text-center opacity-40 italic">No files selected</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="flex justify-between items-center pt-2">
              <button onClick={() => setSmartFiles([])} className="px-6 py-3 text-xs font-black uppercase tracking-widest opacity-60 hover:opacity-100">Clear List</button>
              <button 
                onClick={handleBulkImport}
                disabled={isImporting || (readyCount === 0 && errorCount === 0)}
                className={`px-8 py-4 text-white rounded-xl font-black uppercase tracking-widest shadow-xl flex items-center gap-2 transition-all disabled:opacity-50 ${isRetryMode ? 'bg-amber-600 hover:bg-amber-700' : 'bg-indigo-600 hover:bg-indigo-700'}`}
              >
                {isImporting ? <Loader2 className="w-4 h-4 animate-spin" /> : isRetryMode ? <RefreshCw className="w-4 h-4" /> : <Upload className="w-4 h-4" />}
                {isImporting ? 'Importing...' : isRetryMode ? `Retry ${errorCount} Failed` : `Import ${readyCount} Files`}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default Extractor;