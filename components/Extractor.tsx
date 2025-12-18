import React, { useState, useRef, useEffect } from 'react';
import { Upload, Plus, AlertCircle, Trash2, Sparkles, FileText, Type, Hash, Loader2, Wand2 } from 'lucide-react';
import { Theme } from '../types';
import { extractChapterWithAI } from '../services/geminiService';

interface ImporterProps {
  onChapterExtracted: (data: { title: string; content: string; url: string; index: number }) => void;
  suggestedIndex: number;
  theme: Theme;
}

const Extractor: React.FC<ImporterProps> = ({ onChapterExtracted, suggestedIndex, theme }) => {
  const [activeMode, setActiveMode] = useState<'manual' | 'ai'>('manual');
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

  const handleSmartExtract = async () => {
    if (!content.trim()) {
      setError("Paste the messy website text first.");
      return;
    }
    setIsExtracting(true);
    setError(null);
    try {
      const result = await extractChapterWithAI(content);
      setTitle(result.title);
      setContent(result.content);
      setChapterNum(result.index);
      setActiveMode('manual'); // Switch to manual to review
    } catch (err) {
      setError("AI Extraction failed. Please try cleaning manually.");
    } finally {
      setIsExtracting(false);
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
      url: 'text-import',
      index: chapterNum
    });
    setTitle('');
    setContent('');
    setError(null);
  };

  const isDark = theme === Theme.DARK;
  const isSepia = theme === Theme.SEPIA;
  const inputBg = isDark ? 'bg-slate-800 text-white' : isSepia ? 'bg-[#efe6d5] text-[#3c2f25]' : 'bg-slate-50 text-black';

  return (
    <div className={`border rounded-[2.5rem] shadow-2xl overflow-hidden transition-colors duration-500 max-w-4xl mx-auto ${isDark ? 'bg-slate-900 border-white/10' : isSepia ? 'bg-[#f4ecd8] border-[#d8ccb6]' : 'bg-white border-black/10'}`}>
      <div className="bg-indigo-600 p-8 text-white flex flex-col md:flex-row md:items-center justify-between gap-6">
        <div className="flex items-center gap-4">
          <div className="p-3 bg-white/20 rounded-2xl">
            {activeMode === 'ai' ? <Wand2 className="w-7 h-7" /> : <FileText className="w-7 h-7" />}
          </div>
          <div>
            <h2 className="text-2xl font-black tracking-tight">{activeMode === 'ai' ? 'Smart AI Import' : 'Text Import'}</h2>
            <p className="text-indigo-100 text-[10px] uppercase tracking-widest font-black opacity-80">
              {activeMode === 'ai' ? 'Clean messy website text with AI' : 'Manual Entry or Local .txt File'}
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <div className="flex p-1 bg-white/10 rounded-xl border border-white/20">
            <button 
              onClick={() => setActiveMode('manual')}
              className={`px-4 py-2 rounded-lg text-[10px] font-black uppercase transition-all ${activeMode === 'manual' ? 'bg-white text-indigo-600 shadow-md' : 'text-white/60 hover:text-white'}`}
            >
              Manual
            </button>
            <button 
              onClick={() => setActiveMode('ai')}
              className={`px-4 py-2 rounded-lg text-[10px] font-black uppercase transition-all ${activeMode === 'ai' ? 'bg-white text-indigo-600 shadow-md' : 'text-white/60 hover:text-white'}`}
            >
              AI Magic
            </button>
          </div>
          {activeMode === 'manual' && (
            <button onClick={() => fileInputRef.current?.click()} className="px-6 py-3 bg-white/10 hover:bg-white/20 rounded-xl text-xs font-black transition-all border border-white/20">UPLOAD</button>
          )}
        </div>
        <input type="file" ref={fileInputRef} className="hidden" accept=".txt" onChange={handleFileUpload} />
      </div>

      <div className="p-8 space-y-8">
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
              placeholder={activeMode === 'ai' ? "Will be detected automatically..." : "e.g. Chapter 1: The Beginning"} 
              className={`w-full px-4 py-4 rounded-xl border-none outline-none font-black text-sm ${inputBg}`} 
            />
          </div>
          <div className="space-y-2">
            <label className="text-[10px] font-black uppercase tracking-widest opacity-60">Index</label>
            <input type="number" value={chapterNum} onChange={(e) => setChapterNum(parseInt(e.target.value) || 0)} className={`w-full px-4 py-4 rounded-xl border-none outline-none font-black text-sm ${inputBg}`} />
          </div>
        </div>

        <div className="space-y-2">
          <div className="flex justify-between items-center pr-1 mb-1">
            <label className="text-[10px] font-black uppercase tracking-widest opacity-60">
              {activeMode === 'ai' ? 'Paste Scraped Website Text' : 'Text Content'}
            </label>
            <div className="flex gap-2">
              <button onClick={() => setContent('')} className={`p-2 rounded-xl transition-all ${isDark ? 'bg-white/5 hover:bg-red-500/20' : 'bg-black/5 hover:bg-red-500/10'}`}><Trash2 className="w-4 h-4" /></button>
              {activeMode === 'manual' && (
                <button onClick={() => setContent(cleanText(content))} disabled={!content.trim()} className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-[10px] font-black uppercase bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 transition-all"><Sparkles className="w-3.5 h-3.5" /> Simple Clean</button>
              )}
            </div>
          </div>
          <textarea 
            value={content} 
            onChange={(e) => setContent(e.target.value)} 
            placeholder={activeMode === 'ai' ? "Copy EVERYTHING (Ctrl+A) from the story website and paste it here. Gemini will find the story and clean it for you." : "Paste your text content here..."} 
            className={`w-full h-96 px-6 py-6 rounded-3xl focus:ring-2 focus:ring-indigo-500 outline-none font-bold transition-all resize-none leading-relaxed border-none ${inputBg}`} 
          />
        </div>

        {activeMode === 'ai' ? (
          <button 
            onClick={handleSmartExtract} 
            disabled={!content.trim() || isExtracting} 
            className="w-full py-6 bg-indigo-600 text-white rounded-[1.5rem] font-black uppercase tracking-[0.3em] shadow-2xl hover:bg-indigo-700 transition-all flex items-center justify-center gap-4 active:scale-[0.98] text-sm disabled:opacity-50"
          >
            {isExtracting ? <Loader2 className="w-6 h-6 animate-spin" /> : <Wand2 className="w-6 h-6" />}
            {isExtracting ? 'AI IS WORKING...' : 'SMART EXTRACT STORY'}
          </button>
        ) : (
          <button 
            onClick={handleAddManual} 
            disabled={!content.trim()} 
            className="w-full py-6 bg-indigo-600 text-white rounded-[1.5rem] font-black uppercase tracking-[0.3em] shadow-2xl hover:bg-indigo-700 transition-all flex items-center justify-center gap-4 active:scale-[0.98] text-sm"
          >
            <Plus className="w-6 h-6" /> SAVE TO COLLECTION
          </button>
        )}
      </div>
    </div>
  );
};

export default Extractor;