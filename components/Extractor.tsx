
import React, { useState, useRef, useEffect } from 'react';
import { FileText, Upload, Plus, AlertCircle, FilePlus, ClipboardText } from 'lucide-react';

interface ImporterProps {
  onChapterExtracted: (data: { title: string; content: string; url: string; index: number }) => void;
  suggestedIndex: number;
}

const Extractor: React.FC<ImporterProps> = ({ onChapterExtracted, suggestedIndex }) => {
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [chapterNum, setChapterNum] = useState<number>(suggestedIndex);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Sync suggested index when it changes (e.g., after adding a chapter)
  useEffect(() => {
    setChapterNum(suggestedIndex);
  }, [suggestedIndex]);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.name.endsWith('.txt')) {
      setError("Only .txt files are supported.");
      return;
    }

    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target?.result as string;
      setContent(text);
      // Try to guess title from filename
      const guessedTitle = file.name.replace(/\.txt$/i, '').replace(/^\d+\s*/, '');
      setTitle(prev => prev || guessedTitle);
      
      // Try to guess chapter number from filename
      const match = file.name.match(/^(\d+)/);
      if (match) {
        setChapterNum(parseInt(match[1]));
      }
      
      setError(null);
    };
    reader.onerror = () => setError("Failed to read file.");
    reader.readAsText(file);
  };

  const handleAddManual = () => {
    if (!content.trim()) {
      setError("Please paste some text or upload a file.");
      return;
    }

    setLoading(true);
    try {
      const finalTitle = title.trim() || `Chapter ${chapterNum}`;
      onChapterExtracted({
        title: finalTitle,
        content: content.trim(),
        url: 'manual-entry',
        index: chapterNum
      });
      
      // Reset form
      setTitle('');
      setContent('');
      setError(null);
    } catch (err) {
      setError("Failed to add chapter.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bg-white border border-slate-200 rounded-3xl shadow-sm mb-8 overflow-hidden">
      <div className="bg-indigo-600 p-6 text-white flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-white/20 rounded-xl">
            <FilePlus className="w-6 h-6" />
          </div>
          <div>
            <h2 className="text-xl font-bold">Add New Chapter</h2>
            <p className="text-indigo-100 text-xs opacity-80">Paste text or upload a .txt file</p>
          </div>
        </div>
        <button 
          onClick={() => fileInputRef.current?.click()}
          className="flex items-center gap-2 px-4 py-2 bg-white/10 hover:bg-white/20 rounded-xl text-sm font-bold transition-all"
        >
          <Upload className="w-4 h-4" />
          Import .txt
        </button>
        <input 
          type="file" 
          ref={fileInputRef} 
          className="hidden" 
          accept=".txt" 
          onChange={handleFileUpload} 
        />
      </div>

      <div className="p-6 space-y-4">
        <div className="flex flex-col md:flex-row gap-4">
          <div className="flex-1 space-y-1.5">
            <label className="text-xs font-bold text-slate-400 uppercase ml-1">Chapter Title</label>
            <input 
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={`e.g. The Beginning...`}
              className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500 outline-none font-bold text-black transition-all"
            />
          </div>
          <div className="md:w-32 space-y-1.5">
            <label className="text-xs font-bold text-slate-400 uppercase ml-1">Chapter #</label>
            <input 
              type="number"
              value={chapterNum}
              onChange={(e) => setChapterNum(parseInt(e.target.value) || 0)}
              min="0"
              className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500 outline-none font-mono text-black font-bold transition-all"
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-bold text-slate-400 uppercase ml-1">Content</label>
          <textarea 
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="Paste your chapter text here..."
            className="w-full h-48 px-4 py-4 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500 outline-none font-medium text-black transition-all resize-none leading-relaxed"
          />
        </div>

        <div className="flex items-center justify-between pt-2">
          <div className="text-xs text-slate-400 font-medium">
            {content ? `${content.split(/\s+/).filter(Boolean).length} words detected` : 'Ready to import'}
          </div>
          <button 
            onClick={handleAddManual}
            disabled={loading || !content.trim()}
            className="px-8 py-3 bg-indigo-600 text-white rounded-xl font-bold shadow-lg shadow-indigo-100 hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center gap-2"
          >
            {loading ? <Plus className="w-5 h-5 animate-spin" /> : <Plus className="w-5 h-5" />}
            Add Chapter to Library
          </button>
        </div>

        {error && (
          <div className="flex items-center gap-2 p-3 bg-red-50 border border-red-100 rounded-xl text-red-600 text-sm font-medium animate-pulse">
            <AlertCircle className="w-4 h-4" />
            {error}
          </div>
        )}
      </div>
    </div>
  );
};

export default Extractor;
