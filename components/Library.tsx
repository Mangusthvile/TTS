
import React from 'react';
import { Book, Chapter } from '../types';
import { BookOpen, Plus, Trash2, ChevronRight, FileText } from 'lucide-react';

interface LibraryProps {
  books: Book[];
  activeBookId?: string;
  onSelectBook: (id: string) => void;
  onAddBook: () => void;
  onDeleteBook: (id: string) => void;
  onSelectChapter: (bookId: string, chapterId: string) => void;
}

const Library: React.FC<LibraryProps> = ({ 
  books, 
  activeBookId, 
  onSelectBook, 
  onAddBook, 
  onDeleteBook,
  onSelectChapter 
}) => {
  return (
    <div className="flex flex-col h-full bg-white border-r border-slate-200 w-80 shrink-0 overflow-hidden">
      <div className="p-4 border-b border-slate-100 flex items-center justify-between">
        <h2 className="text-xl font-bold text-black flex items-center gap-2">
          <BookOpen className="w-5 h-5 text-indigo-600" />
          My Library
        </h2>
        <button 
          onClick={onAddBook}
          className="p-1.5 bg-indigo-50 text-indigo-600 rounded-full hover:bg-indigo-100 transition-colors"
        >
          <Plus className="w-5 h-5" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-2">
        {books.length === 0 ? (
          <div className="text-center py-10 px-4">
            <p className="text-slate-400 text-sm italic">Your library is empty. Create a book to get started.</p>
          </div>
        ) : (
          books.map(book => (
            <div key={book.id} className="group">
              <div 
                onClick={() => onSelectBook(book.id)}
                className={`flex items-center justify-between p-3 rounded-xl cursor-pointer transition-all ${
                  activeBookId === book.id 
                    ? 'bg-indigo-600 text-white shadow-md' 
                    : 'bg-slate-50 text-black hover:bg-slate-100'
                }`}
              >
                <div className="flex items-center gap-3 overflow-hidden">
                  <div className={`p-2 rounded-lg ${activeBookId === book.id ? 'bg-indigo-500' : 'bg-indigo-100'}`}>
                    <BookOpen className={`w-4 h-4 ${activeBookId === book.id ? 'text-white' : 'text-indigo-600'}`} />
                  </div>
                  <span className="font-bold truncate">{book.title}</span>
                </div>
                <button 
                  onClick={(e) => {
                    e.stopPropagation();
                    onDeleteBook(book.id);
                  }}
                  className={`opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-red-500 hover:text-white transition-all ${
                    activeBookId === book.id ? 'text-indigo-200' : 'text-slate-400'
                  }`}
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>

              {activeBookId === book.id && (
                <div className="mt-2 ml-4 pl-4 border-l-2 border-indigo-100 space-y-1">
                  {book.chapters.map((chapter) => (
                    <div 
                      key={chapter.id}
                      onClick={() => onSelectChapter(book.id, chapter.id)}
                      className="flex items-center gap-2 p-2 text-sm text-black font-medium hover:text-indigo-600 hover:bg-indigo-50 rounded-lg cursor-pointer transition-colors"
                    >
                      <FileText className="w-3.5 h-3.5 shrink-0 text-slate-400" />
                      <span className="truncate">{chapter.index.toString().padStart(3, '0')} {chapter.title}</span>
                    </div>
                  ))}
                  {book.chapters.length === 0 && (
                    <p className="text-xs text-slate-400 italic p-2">No chapters yet.</p>
                  )}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
};

export default Library;
