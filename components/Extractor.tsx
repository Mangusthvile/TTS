
import React, { useState, useRef, useEffect } from 'react';
import { Upload, Plus, AlertCircle, FilePlus, Trash2, Sparkles, Wand2, Loader2 } from 'lucide-react';
import { Theme } from '../types';
import { smartExtractChapter } from '../services/geminiService';

interface ImporterProps {
  onChapterExtracted: (data: { title: string; content: string; url: string; index: number }) => void;
  suggestedIndex: number;
  theme: Theme;
}

const Extractor: React.FC<ImporterProps> = ({ onChapterExtracted, suggestedIndex, theme }) => {
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [chapterNum, setChapterNum] = useState<number>(suggestedIndex);
  const [error, setError] = useState<string | null>(null);
  const [isExtracting, setIsExtracting] = useState(false);
  const [options, setOptions] = useState({
    removeBlankLines: true,
    normalizeSeparators: true
  });
  
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setChapterNum(suggestedIndex);
  }, [suggestedIndex]);

  const cleanText = (text: string) => {
    let result = text;
    if (options.removeBlankLines) {
      result = result.replace(/^\s*[\r\n]/gm, '\n').replace(/\n{3,}/g, '\n\n');
    }
    if (options.normalizeSeparators) {
      result = result.replace(/_{3,}/g, '---').replace(/\*{3,}/g, '***');
    }
    return result.trim();
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
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
  };

  const handleSmartExtract = async () => {
    if (!content.trim()) {
      setError("Please paste some content first to use Smart Extract.");
      return;
    }
    setError(null);
    setIsExtracting(true);
    try {
      const result = await smartExtractChapter(content);
      setTitle(result.title);
      setContent(result.content);
    } catch (err) {
      setError("Extraction failed. Gemini could not clean the text. Please check your input.");
    } finally {
      setIsExtracting(false);
    }
  };

  const handleAddManual = () => {
    if (!content.trim()) {
      setError("Please paste some text or upload a file.");
      return;
    }

    const finalTitle = title.trim() || `Chapter ${chapterNum}`;
    onChapterExtracted({
      title: finalTitle,
      content: cleanText(content),
      url: 'manual-entry',
      index: chapterNum
    });
    setTitle('');
    setContent('');
    setError(null);
  };

  const isDark = theme === Theme.DARK;
  const isSepia = theme === Theme.SEPIA;

  const cardBg = isDark ? 'bg-black border-white/20' : isSepia ? 'bg-[#f4ecd8] border-[#d8ccb6]' : 'bg-white border-black/10';
  const inputBg = isDark ? 'bg-slate-900 border-white/20 text-white' : isSepia ? 'bg-[#efe6d5] border-[#d8ccb6] text-[#3c2f25]' : 'bg-slate-50 border-slate-200 text-black';
  const labelColor = isDark ? 'text-white' : 'text-black';

  return (
    <div className={`border rounded-[2rem] shadow-2xl overflow-hidden transition-colors duration-500 ${cardBg}`}>
      <div className="bg-indigo-600 p-6 text-white flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-white/20 rounded-xl">
            <FilePlus className="w-6 h-6" />
          </div>
          <div>
            <h2 className="text-xl font-black">Chapter Importer</h2>
            <p className="text-indigo-100 text-[10px] uppercase tracking-widest font-black">Clean Web Content with AI</p>
          </div>
        </div>
        <div className="flex gap-2">
          <button 
            onClick={() => fileInputRef.current?.click()}
            className="flex items-center gap-2 px-4 py-2 bg-white/10 hover:bg-white/20 rounded-xl text-sm font-black transition-all border border-white/20"
          >
            <Upload className="w-4 h-4" />
            Upload TXT
          </button>
          <button 
            onClick={() => { setContent(''); setTitle(''); setError(null); }}
            className="p-2 bg-white/10 hover:bg-red-500 rounded-xl transition-all border border-white/20"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
        <input type="file" ref={fileInputRef} className="hidden" accept=".txt" onChange={handleFileUpload} />
      </div>

      <div className="p-8 space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div className="md:col-span-3 space-y-1.5">
            <label className={`text-[11px] font-black uppercase ml-1 tracking-widest ${labelColor}`}>Chapter Title</label>
            <input 
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. The Path to Immortality"
              className={`w-full px-4 py-3.5 rounded-xl focus:ring-2 focus:ring-indigo-500 outline-none font-black transition-all border ${inputBg}`}
            />
          </div>
          <div className="space-y-1.5">
            <label className={`text-[11px] font-black uppercase ml-1 tracking-widest ${labelColor}`}>Chapter #</label>
            <input 
              type="number"
              value={chapterNum}
              onChange={(e) => setChapterNum(parseInt(e.target.value) || 0)}
              className={`w-full px-4 py-3.5 rounded-xl focus:ring-2 focus:ring-indigo-500 outline-none font-black ${inputBg}`}
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <div className="flex justify-between items-center pr-1 mb-1">
            <label className={`text-[11px] font-black uppercase ml-1 tracking-widest ${labelColor}`}>Chapter Content</label>
            <button 
              onClick={handleSmartExtract}
              disabled={isExtracting || !content.trim()}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-tight transition-all shadow-md active:scale-95 disabled:opacity-50 ${isExtracting ? 'bg-indigo-700 text-white animate-pulse' : 'bg-indigo-600 text-white hover:bg-indigo-700'}`}
            >
              {isExtracting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Wand2 className="w-3.5 h-3.5" />}
              {isExtracting ? 'AI Cleaning...' : 'Smart Extract'}
            </button>
          </div>
          <textarea 
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="Paste raw text or copy-pasted website content here. Use Smart Extract to clean it up."
            className={`w-full h-80 px-4 py-4 rounded-xl focus:ring-2 focus:ring-indigo-500 outline-none font-bold transition-all resize-none leading-relaxed border ${inputBg}`}
          />
        </div>

        <div className="flex flex-wrap gap-6">
           <label className="flex items-center gap-2.5 cursor-pointer group">
              <input 
                type="checkbox" 
                checked={options.removeBlankLines} 
                onChange={e => setOptions({...options, removeBlankLines: e.target.checked})}
                className="w-5 h-5 rounded border-slate-400 text-indigo-600 focus:ring-indigo-500 cursor-pointer"
              />
              <span className={`text-xs font-black uppercase tracking-tight transition-colors ${isDark ? 'text-white/80 group-hover:text-white' : 'text-slate-700 group-hover:text-black'}`}>Cleanup spacing</span>
           </label>
           <label className="flex items-center gap-2.5 cursor-pointer group">
              <input 
                type="checkbox" 
                checked={options.normalizeSeparators} 
                onChange={e => setOptions({...options, normalizeSeparators: e.target.checked})}
                className="w-5 h-5 rounded border-slate-400 text-indigo-600 focus:ring-indigo-500 cursor-pointer"
              />
              <span className={`text-xs font-black uppercase tracking-tight transition-colors ${isDark ? 'text-white/80 group-hover:text-white' : 'text-slate-700 group-hover:text-black'}`}>Normalize dividers</span>
           </label>
        </div>

        {error && (
          <div className="flex items-center gap-3 p-4 bg-red-600 text-white rounded-2xl text-[13px] font-black shadow-lg">
            <AlertCircle className="w-5 h-5" />
            {error}
          </div>
        )}

        <button 
          onClick={handleAddManual}
          disabled={!content.trim() || isExtracting}
          className="w-full py-4.5 bg-indigo-600 text-white rounded-2xl font-black uppercase tracking-[0.2em] shadow-2xl shadow-indigo-600/30 hover:bg-indigo-700 disabled:opacity-50 transition-all flex items-center justify-center gap-3 active:scale-[0.98]"
        >
          <Plus className="w-6 h-6" />
          Save to Library
        </button>
      </div>
    </div>
  );
};

export default Extractor;
