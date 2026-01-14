import React, { useState, useRef } from 'react';
import { Book, Theme, StorageBackend } from '../types';
import { BookOpen, Plus, Trash2, Cloud, Monitor, Database, Image as ImageIcon, FolderSync } from 'lucide-react';
import { openFolderPicker } from '../services/driveService';
import { getValidDriveToken } from '../services/driveAuth';

interface LibraryProps {
  books: Book[];
  activeBookId?: string;
  onSelectBook: (id: string) => void;
  onAddBook: (title: string, backend: StorageBackend, directoryHandle?: any, driveFolderId?: string, driveFolderName?: string) => Promise<void>;
  onDeleteBook: (id: string) => void;
  onUpdateBook: (book: Book) => void;
  theme: Theme;
  onClose?: () => void;
  isOpen?: boolean;
  isCloudLinked?: boolean;
  onLinkCloud?: () => void;
}

const Library: React.FC<LibraryProps> = ({ 
  books, activeBookId, onSelectBook, onAddBook, onDeleteBook, onUpdateBook, theme, onClose, isOpen, isCloudLinked, onLinkCloud
}) => {
  const [isAdding, setIsAdding] = useState(false);
  const [isProcessingAdd, setIsProcessingAdd] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const coverInputRef = useRef<HTMLInputElement>(null);
  const [uploadingCoverFor, setUploadingCoverFor] = useState<string | null>(null);

  const isDark = theme === Theme.DARK;
  const isSepia = theme === Theme.SEPIA;
  const textClass = isDark ? 'text-slate-100' : isSepia ? 'text-[#3c2f25]' : 'text-black';

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
    if (!isCloudLinked && onLinkCloud) {
      onLinkCloud();
      return;
    }
    setIsProcessingAdd(true);
    try {
      await getValidDriveToken();
      const selected = await openFolderPicker();
      if (selected) handleAdd(StorageBackend.DRIVE, null, selected.id, selected.name);
    } catch (e: any) {
      alert("Drive Access Failed: " + (e.message.includes('Reconnect') ? 'Please reconnect Google Drive in Settings' : e.message));
    } finally {
      setIsProcessingAdd(false);
    }
  };

  const handleCoverUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !uploadingCoverFor) return;
    const reader = new FileReader();
    reader.onload = () => {
      const book = books.find(b => b.id === uploadingCoverFor);
      if (book) {
        onUpdateBook({ ...book, coverImage: reader.result as string });
      }
      setUploadingCoverFor(null);
    };
    reader.readAsDataURL(file);
  };

  return (
    <div className={`h-full flex flex-col min-w-0 ${isDark ? 'bg-slate-900' : isSepia ? 'bg-[#efe6d5]' : 'bg-white'}`}>
      <input type="file" ref={coverInputRef} className="hidden" accept="image/*" onChange={handleCoverUpload} />
      
      <div className="p-6 flex items-center justify-between flex-shrink-0">
        <h2 className={`text-2xl font-black tracking-tight flex items-center gap-3 ${textClass}`}>
          <BookOpen className="w-8 h-8 text-indigo-600" /> Library
        </h2>
        <button 
          onClick={() => setIsAdding(true)} 
          className="p-3 bg-indigo-600 text-white rounded-2xl shadow-xl hover:scale-105 active:scale-95 transition-transform"
          aria-label="Add new book"
        >
          <Plus className="w-6 h-6" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-6 pb-12">
        {isAdding && (
          <div className={`p-6 rounded-[2rem] border shadow-2xl space-y-6 mb-8 animate-in zoom-in-95 ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-indigo-50 border-indigo-100'}`}>
            <div className="space-y-1">
              <label className="text-[10px] font-black uppercase tracking-widest text-indigo-600 ml-1">New Book Title</label>
              <input 
                autoFocus 
                disabled={isProcessingAdd}
                type="text" 
                value={newTitle} 
                onChange={e => setNewTitle(e.target.value)} 
                placeholder="e.g. The Hobbit" 
                className={`w-full px-4 py-4 rounded-xl outline-none text-sm font-bold border ${isDark ? 'bg-slate-900 border-slate-700 text-slate-100' : 'bg-white border-slate-200 text-black'}`} 
              />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <button onClick={() => handleAdd(StorageBackend.MEMORY)} className={`flex flex-col items-center gap-2 p-4 rounded-2xl text-[10px] font-black uppercase border transition-all ${isDark ? 'bg-slate-900 border-slate-700' : 'bg-white'}`}><Database className="w-5 h-5 text-emerald-500" /> Memory</button>
              <button onClick={handleStartDrivePick} className={`flex flex-col items-center gap-2 p-4 rounded-2xl text-[10px] font-black uppercase border transition-all ${isDark ? 'bg-slate-900 border-slate-700' : 'bg-white'}`}><Cloud className="w-5 h-5 text-indigo-500" /> {isProcessingAdd ? 'Loading...' : isCloudLinked ? 'Drive' : 'Link Drive'}</button>
              <button onClick={async () => { const h = await (window as any).showDirectoryPicker({ mode: "readwrite" }); handleAdd(StorageBackend.LOCAL, h); }} className={`flex flex-col items-center gap-2 p-4 rounded-2xl text-[10px] font-black uppercase border transition-all ${isDark ? 'bg-slate-900 border-slate-700' : 'bg-white'}`}><Monitor className="w-5 h-5 text-slate-400" /> Local</button>
            </div>
            <button onClick={() => setIsAdding(false)} className={`w-full py-2 text-[10px] font-black uppercase tracking-widest opacity-60`}>Cancel</button>
          </div>
        )}

        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-6">
          {books.map(book => {
            const unreadCount = book.chapters.filter(c => !c.isCompleted).length;
            return (
              <div key={book.id} className="flex flex-col gap-2 group relative">
                <div 
                  onClick={() => onSelectBook(book.id)}
                  className={`aspect-[2/3] rounded-2xl overflow-hidden relative shadow-lg cursor-pointer transition-all hover:scale-[1.03] active:scale-[0.98] border-2 ${activeBookId === book.id ? 'border-indigo-500 shadow-indigo-500/20' : 'border-transparent'}`}
                >
                  {book.coverImage ? (
                    <img src={book.coverImage} className="w-full h-full object-cover" alt={book.title} />
                  ) : (
                    <div className={`w-full h-full flex flex-col items-center justify-center p-4 text-center gap-2 ${isDark ? 'bg-slate-800' : 'bg-slate-100'}`}>
                      <BookOpen className="w-10 h-10 opacity-10" />
                      <span className="text-[10px] font-black uppercase tracking-widest opacity-40 leading-tight">{book.title}</span>
                    </div>
                  )}
                  
                  {unreadCount > 0 && (
                    <div className="absolute top-2 right-2 px-2 py-1 bg-indigo-600 text-white text-[10px] font-black rounded-lg shadow-lg">
                      {unreadCount}
                    </div>
                  )}

                  <div className="absolute inset-0 bg-black/0 group-hover:bg-black/40 transition-colors flex items-center justify-center opacity-0 group-hover:opacity-100 gap-2">
                    <button 
                      onClick={(e) => { e.stopPropagation(); setUploadingCoverFor(book.id); coverInputRef.current?.click(); }}
                      className="p-3 bg-white/20 backdrop-blur-md text-white rounded-xl hover:bg-white/40 transition-all"
                      aria-label="Change Cover"
                    >
                      <ImageIcon className="w-5 h-5" />
                    </button>
                    <button 
                      onClick={(e) => { e.stopPropagation(); if (confirm(`Delete '${book.title}'?`)) onDeleteBook(book.id); }}
                      className="p-3 bg-red-500/40 backdrop-blur-md text-white rounded-xl hover:bg-red-500/60 transition-all"
                      aria-label="Delete Book"
                    >
                      <Trash2 className="w-5 h-5" />
                    </button>
                  </div>
                </div>
                <div onClick={() => onSelectBook(book.id)} className="cursor-pointer">
                  <h3 className={`font-black text-xs sm:text-sm line-clamp-1 mt-1 ${textClass}`}>{book.title}</h3>
                  <p className="text-[9px] font-bold uppercase tracking-tighter opacity-50">{book.chapters.length} chapters</p>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export default Library;