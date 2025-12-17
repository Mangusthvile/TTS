
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Book, Chapter, Rule, AppState } from './types';
import Library from './components/Library';
import Reader from './components/Reader';
import Player from './components/Player';
import RuleManager from './components/RuleManager';
import Extractor from './components/Extractor';
import { speechController, applyRules } from './services/speechService';
import { saveChapterToFile } from './services/fileService';
import { Settings2, BookText, Zap, Keyboard, FolderPlus, Info } from 'lucide-react';

const App: React.FC = () => {
  const [state, setState] = useState<AppState>(() => {
    const saved = localStorage.getItem('voxlib_state');
    return saved ? JSON.parse(saved) : {
      books: [],
      activeBookId: undefined,
      playbackSpeed: 1.0,
      selectedVoiceName: undefined
    };
  });

  const [activeTab, setActiveTab] = useState<'reader' | 'rules'>('reader');
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentOffset, setCurrentOffset] = useState(0);
  
  // Ref to break circular dependency between handlePlay and playNext
  const playNextRef = useRef<() => void>(() => {});

  // Persistence
  useEffect(() => {
    localStorage.setItem('voxlib_state', JSON.stringify(state));
  }, [state]);

  const activeBook = state.books.find(b => b.id === state.activeBookId);
  const activeChapter = activeBook?.chapters.find(c => c.id === activeBook.currentChapterId);

  // Core Actions
  const handleAddBook = async () => {
    let directoryHandle = null;
    try {
      if ((window as any).showDirectoryPicker) {
        directoryHandle = await (window as any).showDirectoryPicker();
      }
    } catch (e) {
      console.warn("Folder selection cancelled or not supported");
    }

    const defaultTitle = directoryHandle ? directoryHandle.name : 'New Book';
    const chosenTitle = window.prompt("Enter a name for this book/folder:", defaultTitle);
    
    if (chosenTitle === null) return; // User cancelled

    const newBook: Book = {
      id: crypto.randomUUID(),
      title: chosenTitle || defaultTitle,
      chapters: [],
      rules: [],
      directoryHandle
    };
    setState(prev => ({ ...prev, books: [...prev.books, newBook], activeBookId: newBook.id }));
  };

  const handleDeleteBook = (id: string) => {
    if (!window.confirm("Are you sure you want to remove this book from your library?")) return;
    setState(prev => ({
      ...prev,
      books: prev.books.filter(b => b.id !== id),
      activeBookId: prev.activeBookId === id ? undefined : prev.activeBookId
    }));
  };

  const handleSelectBook = (id: string) => {
    setState(prev => ({ ...prev, activeBookId: id }));
  };

  const handleSelectChapter = (bookId: string, chapterId: string) => {
    setState(prev => ({
      ...prev,
      books: prev.books.map(b => b.id === bookId ? { ...b, currentChapterId: chapterId } : b)
    }));
    speechController.stop();
    setIsPlaying(false);
    setCurrentOffset(0);
  };

  const handleChapterExtracted = async (data: { title: string; content: string; url: string; index: number }) => {
    let currentBook = activeBook;
    
    if (!currentBook) {
      const bookId = crypto.randomUUID();
      currentBook = {
        id: bookId,
        title: 'Imported Library',
        chapters: [],
        rules: []
      };
      setState(prev => ({ ...prev, books: [...prev.books, currentBook!], activeBookId: bookId }));
    }

    const sanitizedTitle = data.title.replace(/[/\\?%*:|"<>]/g, '-');
    const filename = `${data.index.toString().padStart(3, '0')} ${sanitizedTitle}.txt`;
    
    const newChapter: Chapter = {
      id: crypto.randomUUID(),
      index: data.index,
      title: data.title,
      content: data.content,
      sourceUrl: data.url,
      filename,
      wordCount: data.content.split(/\s+/).filter(Boolean).length,
      progress: 0
    };

    if (currentBook.directoryHandle) {
      await saveChapterToFile(currentBook.directoryHandle, newChapter);
    }

    setState(prev => ({
      ...prev,
      books: prev.books.map(b => {
        if (b.id === currentBook!.id) {
          // Check if a chapter with this index already exists to warn or replace?
          // For now, just append and sort later
          const updatedChapters = [...b.chapters, newChapter].sort((a, b) => a.index - b.index);
          return {
            ...b,
            chapters: updatedChapters,
            currentChapterId: newChapter.id
          };
        }
        return b;
      })
    }));
  };

  // Rule Actions
  const handleAddRule = (rule: Rule) => {
    setState(prev => ({
      ...prev,
      books: prev.books.map(b => b.id === prev.activeBookId ? { ...b, rules: [...b.rules, rule] } : b)
    }));
  };

  const handleUpdateRule = (rule: Rule) => {
    setState(prev => ({
      ...prev,
      books: prev.books.map(b => b.id === prev.activeBookId ? { ...b, rules: b.rules.map(r => r.id === rule.id ? rule : r) } : b)
    }));
  };

  const handleDeleteRule = (id: string) => {
    setState(prev => ({
      ...prev,
      books: prev.books.map(b => b.id === prev.activeBookId ? { ...b, rules: b.rules.filter(r => r.id !== id) } : b)
    }));
  };

  const handlePlay = useCallback(() => {
    const book = state.books.find(b => b.id === state.activeBookId);
    const chapter = book?.chapters.find(c => c.id === book.currentChapterId);
    
    if (!chapter || !book) return;
    
    const textToRead = chapter.content.substring(currentOffset);
    const processedText = applyRules(textToRead, book.rules);
    
    setIsPlaying(true);
    speechController.speak(
      processedText,
      state.selectedVoiceName || '',
      state.playbackSpeed,
      () => playNextRef.current(), // Call via Ref to avoid circular dependency
      (offset) => setCurrentOffset(prev => prev + offset)
    );
  }, [state.books, state.activeBookId, state.selectedVoiceName, state.playbackSpeed, currentOffset]);

  const playNext = useCallback(() => {
    if (!activeBook || !activeChapter) return;
    const currentIndex = activeBook.chapters.findIndex(c => c.id === activeChapter.id);
    if (currentIndex < activeBook.chapters.length - 1) {
      const nextId = activeBook.chapters[currentIndex + 1].id;
      handleSelectChapter(activeBook.id, nextId);
      // Wait for state to settle before playing next chapter
      setTimeout(() => handlePlay(), 150);
    } else {
      setIsPlaying(false);
      speechController.stop();
    }
  }, [activeBook, activeChapter, handlePlay]);

  // Keep playNextRef in sync with latest playNext function
  useEffect(() => {
    playNextRef.current = playNext;
  }, [playNext]);

  const handlePause = () => {
    speechController.pause();
    setIsPlaying(false);
  };

  const handleResume = () => {
    speechController.resume();
    setIsPlaying(true);
  };

  const handleStop = () => {
    speechController.stop();
    setIsPlaying(false);
    setCurrentOffset(0);
  };

  // Keyboard Shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      
      if (e.code === 'Space') {
        e.preventDefault();
        isPlaying ? handlePause() : (speechController.isPaused ? handleResume() : handlePlay());
      } else if (e.key === 'n' || e.key === 'N') {
        playNext();
      } else if (e.key === 'b' || e.key === 'B') {
        const currentIndex = activeBook?.chapters.findIndex(c => c.id === activeChapter?.id) ?? -1;
        if (activeBook && currentIndex > 0) {
          handleSelectChapter(activeBook.id, activeBook.chapters[currentIndex - 1].id);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isPlaying, handlePlay, playNext, activeBook, activeChapter]);

  const getNextSuggestedIndex = () => {
    if (!activeBook || activeBook.chapters.length === 0) return 1;
    const maxIndex = Math.max(...activeBook.chapters.map(c => c.index));
    return maxIndex + 1;
  };

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-slate-50">
      <div className="flex flex-1 overflow-hidden">
        <Library 
          books={state.books}
          activeBookId={state.activeBookId}
          onSelectBook={handleSelectBook}
          onAddBook={handleAddBook}
          onDeleteBook={handleDeleteBook}
          onSelectChapter={handleSelectChapter}
        />
        
        <main className="flex-1 flex flex-col min-w-0 bg-white shadow-2xl relative">
          <header className="h-16 border-b border-slate-100 flex items-center justify-between px-8 bg-white/80 backdrop-blur-md sticky top-0 z-10">
            <div className="flex items-center gap-8">
              <button 
                onClick={() => setActiveTab('reader')}
                className={`flex items-center gap-2 h-16 border-b-2 transition-all font-semibold ${
                  activeTab === 'reader' ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-slate-400 hover:text-slate-600'
                }`}
              >
                <BookText className="w-4 h-4" />
                Reader
              </button>
              <button 
                onClick={() => setActiveTab('rules')}
                className={`flex items-center gap-2 h-16 border-b-2 transition-all font-semibold ${
                  activeTab === 'rules' ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-slate-400 hover:text-slate-600'
                }`}
              >
                <Zap className="w-4 h-4" />
                Pronunciation
              </button>
            </div>
            
            <div className="flex items-center gap-4">
              {!activeBook?.directoryHandle && state.activeBookId && (
                <div className="flex items-center gap-2 text-amber-500 text-[10px] font-bold bg-amber-50 px-3 py-1.5 rounded-full border border-amber-100 uppercase tracking-tighter">
                  <Info className="w-3 h-3" />
                  No Folder Link
                </div>
              )}
              {activeBook?.directoryHandle && (
                <div className="flex items-center gap-2 text-emerald-500 text-[10px] font-bold bg-emerald-50 px-3 py-1.5 rounded-full border border-emerald-100 uppercase tracking-tighter">
                  <div className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-pulse"></div>
                  Auto-Saving
                </div>
              )}
              <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-lg">
                <span className="px-2 py-1 text-[10px] font-bold text-slate-400 uppercase tracking-tighter flex items-center gap-1">
                  <Keyboard className="w-3 h-3" />
                </span>
                <kbd className="bg-white px-1.5 py-0.5 rounded text-[10px] font-mono shadow-sm text-slate-500 border border-slate-200">Space</kbd>
                <kbd className="bg-white px-1.5 py-0.5 rounded text-[10px] font-mono shadow-sm text-slate-500 border border-slate-200">N</kbd>
                <kbd className="bg-white px-1.5 py-0.5 rounded text-[10px] font-mono shadow-sm text-slate-500 border border-slate-200">B</kbd>
              </div>
            </div>
          </header>

          <div className="flex-1 overflow-y-auto">
            {activeTab === 'reader' ? (
              <div className="p-4 lg:p-12">
                <Extractor 
                  onChapterExtracted={handleChapterExtracted} 
                  suggestedIndex={getNextSuggestedIndex()}
                />
                <Reader 
                  chapter={activeChapter || null} 
                  rules={activeBook?.rules || []}
                  currentOffset={currentOffset}
                />
              </div>
            ) : (
              <RuleManager 
                rules={activeBook?.rules || []}
                onAddRule={handleAddRule}
                onUpdateRule={handleUpdateRule}
                onDeleteRule={handleDeleteRule}
              />
            )}
          </div>

          {activeChapter && (
            <Player 
              isPlaying={isPlaying}
              onPlay={speechController.isPaused ? handleResume : handlePlay}
              onPause={handlePause}
              onStop={handleStop}
              onNext={playNext}
              onPrev={() => {
                 const currentIndex = activeBook?.chapters.findIndex(c => c.id === activeChapter.id) ?? 0;
                 if (currentIndex > 0) handleSelectChapter(activeBook!.id, activeBook!.chapters[currentIndex-1].id);
              }}
              onSeek={(delta) => setCurrentOffset(prev => Math.max(0, prev + (delta * 10)))}
              speed={state.playbackSpeed}
              onSpeedChange={(v) => setState(prev => ({...prev, playbackSpeed: v}))}
              selectedVoice={state.selectedVoiceName || ''}
              onVoiceChange={(v) => setState(prev => ({...prev, selectedVoiceName: v}))}
            />
          )}
        </main>
      </div>
    </div>
  );
};

export default App;
