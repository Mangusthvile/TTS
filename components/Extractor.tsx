
import React, { useState, useRef, useEffect } from 'react';
import { Upload, Plus, AlertCircle, Trash2, Sparkles, FileText, Type, Hash } from 'lucide-react';
import { Theme } from '../types';

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
    // Strip HTML tags if any were pasted
    result = result.replace(/<[^>]*>?/gm, '');
    
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
    e.target.value = '';
  };

  const handleManualClean = () => {
    if (!content.trim()) return;
    setContent(cleanText(content));
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
      url: 'text-import',
      index: chapterNum
    });
    setTitle('');
    setContent('');
    setError(null);
  };

  const isDark = theme === Theme.DARK;
  const isSepia = theme === Theme.SEPIA;

  const cardBg = isDark ? 'bg-slate-900 border-white/10' : isSepia ? 'bg-[#f4ecd8] border-[#d8ccb6]' : 'bg-white border-black/10';
  const inputBg = isDark ? 'bg-slate-800 border-white/5 text-white' : isSepia ? 'bg-[#efe6d5] border-[#d8ccb6] text-[#3c2f25]' : 'bg-slate-50 border-slate-200 text-black';
  const labelColor = isDark ? 'text-slate-400' : 'text-slate-600';

  return (
    <div className={`border rounded-[2.5rem] shadow-2xl overflow-hidden transition-colors duration-500 max-w-4xl mx-auto ${cardBg}`}>
      <div className="bg-indigo-600 p-8 text-white flex flex-col md:flex-row md:items-center justify-between gap-6">
        <div className="flex items-center gap-4">
          <div className="p-3 bg-white/20 rounded-2xl shadow-inner">
            <FileText className="w-7 h-7" />
          </div>
          <div>
            <h2 className="text-2xl font-black tracking-tight">Text Import</h2>
            <p className="text-indigo-100 text-[10px] uppercase tracking-widest font-black opacity-80">Manual Entry or Local .txt File</p>
          </div>
        </div>
        <div className="flex gap-2">
          <button 
            onClick={() => fileInputRef.current?.click()}
            className="flex items-center gap-2 px-6 py-3 bg-white/10 hover:bg-white/20 rounded-xl text-xs font-black transition-all border border-white/20 active:scale-95"
          >
            <Upload className="w-4 h-4" />
            UPLOAD FILE
          </button>
          <button 
            onClick={() => { setContent(''); setTitle(''); setError(null); }}
            className="p-3 bg-white/10 hover:bg-red-500 rounded-xl transition-all border border-white/20 active:scale-95"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
        <input type="file" ref={fileInputRef} className="hidden" accept=".txt" onChange={handleFileUpload} />
      </div>

      <div className="p-8 space-y-8">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
          <div className="md:col-span-3 space-y-2">
            <label className={`text-[10px] font-black uppercase ml-1 tracking-widest ${labelColor}`}>Chapter Title</label>
            <div className={`flex items-center px-4 rounded-xl border transition-all ${inputBg} focus-within:ring-2 focus-within:ring-indigo-500`}>
              <Type className="w-4 h-4 opacity-40 mr-3" />
              <input 
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Chapter 1: The Gathering Storm"
                className="flex-1 py-4 bg-transparent outline-none font-black text-sm"
              />
            </div>
          </div>
          <div className="space-y-2">
            <label className={`text-[10px] font-black uppercase ml-1 tracking-widest ${labelColor}`}>Index</label>
            <div className={`flex items-center px-4 rounded-xl border transition-all ${inputBg} focus-within:ring-2 focus-within:ring-indigo-500`}>
              <Hash className="w-4 h-4 opacity-40 mr-3" />
              <input 
                type="number"
                value={chapterNum}
                onChange={(e) => setChapterNum(parseInt(e.target.value) || 0)}
                className="w-full py-4 bg-transparent outline-none font-black text-sm"
              />
            </div>
          </div>
        </div>

        <div className="space-y-2">
          <div className="flex justify-between items-center pr-1 mb-1">
            <label className={`text-[10px] font-black uppercase ml-1 tracking-widest ${labelColor}`}>Text Content</label>
            <button 
              onClick={handleManualClean}
              disabled={!content.trim()}
              className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-[10px] font-black uppercase tracking-tight transition-all shadow-md bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              <Sparkles className="w-3.5 h-3.5" />
              Format Text
            </button>
          </div>
          <textarea 
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="Paste your text content here..."
            className={`w-full h-96 px-6 py-6 rounded-3xl focus:ring-2 focus:ring-indigo-500 outline-none font-bold transition-all resize-none leading-relaxed border ${inputBg}`}
          />
        </div>

        {error && (
          <div className="flex items-center gap-4 p-5 bg-red-600/10 border border-red-600/20 text-red-500 rounded-2xl text-sm font-black">
            <AlertCircle className="w-5 h-5 flex-shrink-0" />
            {error}
          </div>
        )}

        <button 
          onClick={handleAddManual}
          disabled={!content.trim()}
          className="w-full py-6 bg-indigo-600 text-white rounded-[1.5rem] font-black uppercase tracking-[0.3em] shadow-2xl hover:bg-indigo-700 disabled:opacity-50 transition-all flex items-center justify-center gap-4 active:scale-[0.98] text-sm"
        >
          <Plus className="w-6 h-6" />
          SAVE TO COLLECTION
        </button>
      </div>
    </div>
  );
};

export default Extractor;
