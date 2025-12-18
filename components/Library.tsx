import React, { useState } from 'react';
import { Book, Theme, StorageBackend } from '../types';
import { BookOpen, Plus, Trash2, History, Cloud, Monitor, X, FileText, Database, Loader2, ChevronRight, CheckCircle2 } from 'lucide-react';
import { openFolderPicker, authenticateDrive } from '../services/driveService';

interface LibraryProps {
  books: Book[];
  activeBookId?: string;
  lastSession?: { bookId: string; chapterId: string; offset: number };
  onSelectBook: (id: string) => void;
  onAddBook: (title: string, backend: StorageBackend, directoryHandle?: any, driveFolderId?: string, driveFolderName?: string) => Promise<void>;
  onDeleteBook: (id: string) => void;
  onSelectChapter: (bookId: string, chapterId: string, offset?: number) => void;
  theme: Theme;
  onClose?: () => void;
  isOpen?: boolean;
  googleClientId?: string;
}

const Library: React.FC<LibraryProps> = ({ 
  books, activeBookId, lastSession, onSelectBook, onAddBook, onDeleteBook, onSelectChapter, theme, onClose, isOpen, googleClientId 
}) => {
  const [isAdding, setIsAdding] = useState(false);
  const [isProcessingAdd, setIsProcessingAdd] = useState(false);
  const [newTitle, setNewTitle] = useState('');

  const isPickerSupported = !!(window as any).showDirectoryPicker;

  const isDark = theme === Theme.DARK;
  const isSepia = theme === Theme.SEPIA;
  const textClass = isDark ? 'text-slate-100' : isSepia ? 'text-[#3c2f25]' : 'text-black';
  const itemBgClass = isDark ? 'bg-slate-900 hover:bg-slate-800 border-slate-800' : isSepia ? 'bg-[#f4ecd8] hover:bg-[#e6d8b5] border-[#d8ccb6]' : 'bg-slate-100 hover:bg-slate-200 border-black/5';

  const lastBook = lastSession ? books.find(b => b.id === lastSession.bookId) : null;
  const lastChapter = lastBook?.chapters.find(c => c.id === lastSession?.chapterId);

  const sidebarClass = `
    fixed inset-y-0 left-0 z-50 w-[280px] sm:w-80 transform transition-transform duration-300 ease-in-out lg:relative lg:translate-x-0
    flex flex-col border-r overflow-hidden
    ${isOpen ? 'translate-x-0' : '-translate-x-full'}
    ${isDark ? 'bg-slate-950 border-slate-900' : isSepia ? 'bg-[#efe6d5] border-[#d8ccb6]' : 'bg-white border-black/5'}
  `;

  const handleAdd = async (backend: StorageBackend, handle?: any, driveFolderId?: string, driveFolderName?: string) => {
    if (!newTitle.trim()) return;
    setIsProcessingAdd(true);
    try {
      await onAddBook(newTitle, backend, handle, driveFolderId, driveFolderName);
      setIsAdding(false);
      setNewTitle('');
    } catch (e: any) {
      alert("Error adding book: " + e.message);
    } finally {
      setIsProcessingAdd(false);
    }
  };

  const handleStartDrivePick = async () => {
    if (!newTitle.trim()) return;
    setIsProcessingAdd(true);
    try {
      const token = await authenticateDrive(googleClientId);
      const selected = await openFolderPicker(token);
      if (selected) {
        handleAdd(StorageBackend.DRIVE, null, selected.id, selected.name);
      }
    } catch (e: any) {
      alert("Drive Access Failed: " + e.message);
    } finally {
      setIsProcessingAdd(false);
    }
  };

  return (
    <>
      {isOpen && (
        <div className="fixed inset-0 bg-black/60 z-40 lg:hidden backdrop-blur-sm" onClick={onClose} />
      )}

      <div className={sidebarClass}>
        <div className="p-6 flex items-center justify-between flex-shrink-0">
          <h2 className={`text-xl font-black tracking-tight flex items-center gap-3 ${textClass}`}>
            <BookOpen className="w-6 h-6 text-indigo-600" /> Talevox
          </h2>
          <div className="flex items-center gap-1">
            <button 
              disabled={isProcessingAdd}
              onClick={() => { setIsAdding(true); }} 
              className="p-2 bg-indigo-600 text-white rounded-xl shadow-lg hover:scale-110 active:scale-95 transition-transform disabled:opacity-50"
            >
              <Plus className="w-5 h-5" />
            </button>
            {onClose && <button onClick={onClose} className={`p-2 lg:hidden ${textClass}`}><X className="w-5 h-5" /></button>}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-4 pb-6 space-y-3">
          {lastChapter && lastBook && (
            <div 
              onClick={() => { onSelectChapter(lastBook.id, lastChapter.id, lastSession!.offset); onClose?.(); }}
              className="p-5 rounded-3xl bg-indigo-600 text-white shadow-xl cursor-pointer hover:scale-[1.02] transition-all group overflow-hidden relative mb-4"
            >
              <History className="absolute -right-4 -bottom-4 w-24 h-24 opacity-10 group-hover:scale-110 transition-transform" />
              <p className="text-[10px] font-black uppercase tracking-widest opacity-80 mb-2">Resume Reading</p>
              <h4 className="font-bold truncate text-sm leading-tight">{lastChapter.index} {lastChapter.title}</h4>
              <p className="text-[11px] font-medium opacity-70 mt-1">{lastBook.title}</p>
            </div>
          )}

          {isAdding && (
            <div className={`p-5 rounded-3xl border space-y-4 mb-4 ${isDark ? 'bg-slate-900 border-slate-800' : 'bg-indigo-50 border-indigo-100'}`}>
              <div className="space-y-1">
                <label className="text-[10px] font-black uppercase tracking-widest text-indigo-600 ml-1">New Book</label>
                <input 
                  autoFocus 
                  disabled={isProcessingAdd}
                  type="text" 
                  value={newTitle} 
                  onChange={e => setNewTitle(e.target.value)} 
                  placeholder="Book Title..." 
                  className={`w-full px-4 py-2.5 rounded-xl outline-none text-sm font-bold border ${isDark ? 'bg-slate-800 border-slate-700 text-slate-100' : 'bg-white border-slate-200 text-black'}`} 
                />
              </div>
              <div className="grid grid-cols-1 gap-2">
                <button 
                  disabled={isProcessingAdd}
                  onClick={() => handleAdd(StorageBackend.MEMORY)}
                  className={`flex items-center gap-3 p-3 rounded-xl text-xs font-black border transition-all ${isDark ? 'bg-slate-800 border-slate-700 text-slate-100' : 'bg-white border-slate-200 text-black hover:border-indigo-600'}`}
                >
                  <Database className="w-4 h-4 text-emerald-500" /> App Memory
                </button>
                <button 
                  disabled={isProcessingAdd}
                  onClick={handleStartDrivePick}
                  className={`flex items-center justify-between p-3 rounded-xl text-xs font-black border transition-all ${isDark ? 'bg-slate-800 border-slate-700 text-slate-100' : 'bg-white border-slate-200 text-black hover:border-indigo-600'}`}
                >
                  <div className="flex items-center gap-3">
                    <Cloud className="w-4 h-4 text-indigo-500" /> Google Drive
                  </div>
                  {isProcessingAdd && <Loader2 className="w-3.5 h-3.5 animate-spin opacity-60" />}
                </button>
                {isPickerSupported && (
                  <button 
                    disabled={isProcessingAdd}
                    onClick={async () => {
                      try {
                        const handle = await (window as any).showDirectoryPicker({ mode: "readwrite" });
                        handleAdd(StorageBackend.LOCAL, handle);
                      } catch (e) {}
                    }}
                    className={`flex items-center gap-3 p-3 rounded-xl text-xs font-black border transition-all ${isDark ? 'bg-slate-800 border-slate-700 text-slate-100' : 'bg-white border-slate-200 text-black hover:border-indigo-600'}`}
                  >
                    <Monitor className="w-4 h-4 text-slate-400" /> Local Folder
                  </button>
                )}
              </div>
              <button onClick={() => setIsAdding(false)} disabled={isProcessingAdd} className={`w-full py-2 text-xs font-black ${isDark ? 'text-slate-400 hover:text-white' : 'text-slate-500 hover:text-black'}`}>Cancel</button>
            </div>
          )}

          <div className="space-y-1">
            <p className={`text-[11px] font-black uppercase tracking-widest ml-2 mb-2 ${isDark ? 'text-slate-500' : 'text-slate-500'}`}>My Library</p>
            {books.map(book => {
              const isActive = activeBookId === book.id;
              return (
                <div key={book.id} className="mb-2">
                  <div 
                    onClick={() => { onSelectBook(book.id); }} 
                    className={`flex items-center justify-between p-4 rounded-2xl cursor-pointer transition-all border group ${isActive ? 'bg-indigo-600 text-white shadow-indigo-600/20 border-indigo-600' : itemBgClass}`}
                  >
                    <div className="flex items-center gap-3 overflow-hidden">
                      <div className={`p-2 rounded-lg ${isActive ? 'bg-white/20' : isDark ? 'bg-slate-950/40' : 'bg-black/5'}`}>
                        {book.backend === StorageBackend.DRIVE ? <Cloud className="w-4 h-4" /> : 
                         book.backend === StorageBackend.LOCAL ? <Monitor className="w-4 h-4" /> : 
                         <Database className="w-4 h-4" />}
                      </div>
                      <div className="min-w-0">
                        <span className="font-bold truncate text-sm block leading-none mb-1">{book.title}</span>
                        <div className="flex items-center gap-2">
                          <span className={`text-[10px] font-black uppercase tracking-tighter ${isActive ? 'text-white/80' : 'opacity-70'}`}>{book.chapters.length} chapters</span>
                        </div>
                      </div>
                    </div>
                    <button 
                      onClick={e => { e.stopPropagation(); onDeleteBook(book.id); }} 
                      className={`p-1.5 hover:bg-red-500/20 rounded-lg transition-all ${isActive ? 'text-white' : 'text-slate-500 opacity-60 group-hover:opacity-100'}`}
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                  
                  {/* Nested Chapters List for Active Book - Refined styling for visibility */}
                  {isActive && book.chapters.length > 0 && (
                    <div className={`mt-2 ml-4 border-l-2 pl-3 space-y-1 max-h-80 overflow-y-auto scrollbar-hide ${isDark ? 'border-slate-800' : 'border-black/5'}`}>
                      {book.chapters.map(chapter => {
                        const isCurrent = book.currentChapterId === chapter.id;
                        return (
                          <div 
                            key={chapter.id}
                            onClick={() => { onSelectChapter(book.id, chapter.id); onClose?.(); }}
                            className={`flex items-center gap-3 px-3 py-2.5 rounded-xl cursor-pointer transition-all text-[11px] font-black uppercase tracking-tight ${isCurrent ? 'bg-indigo-600 text-white shadow-md' : 'opacity-60 hover:opacity-100 hover:bg-black/5'}`}
                          >
                            {chapter.isCompleted ? <CheckCircle2 className={`w-3 h-3 ${isCurrent ? 'text-white' : 'text-emerald-500'}`} /> : <ChevronRight className="w-3 h-3" />}
                            <span className="truncate">CH {chapter.index}. {chapter.title}</span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </>
  );
};

export default Library;