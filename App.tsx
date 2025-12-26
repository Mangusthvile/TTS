import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Book, Chapter, AppState, Theme, HighlightMode, StorageBackend, RuleType, SavedSnapshot, AudioStatus, CLOUD_VOICES } from './types';
import Library from './components/Library';
import Reader from './components/Reader';
import Player from './components/Player';
import RuleManager from './components/RuleManager';
import Settings from './components/Settings';
import Extractor from './components/Extractor';
import ChapterFolderView from './components/ChapterFolderView';
import ChapterSidebar from './components/ChapterSidebar';
import { speechController, applyRules, PROGRESS_STORE_V4 } from './services/speechService';
import { fetchDriveFile, fetchDriveBinary, uploadToDrive, buildMp3Name, listFilesInFolder, findFileSync, buildTextName, ensureRootStructure, ensureBookFolder, moveFile, openFolderPicker, listFilesSortedByModified } from './services/driveService';
import { initDriveAuth, getValidDriveToken, clearStoredToken, isTokenValid } from './services/driveAuth';
import { saveChapterToFile } from './services/fileService';
import { synthesizeChunk } from './services/cloudTtsService';
import { extractChapterWithAI } from './services/geminiService';
import { saveAudioToCache, getAudioFromCache, generateAudioKey } from './services/audioCache';
import { Sun, Coffee, Moon, X, Settings as SettingsIcon, Loader2, Save, Library as LibraryIcon, Zap, Menu, LogIn, RefreshCw, AlertCircle, Cloud } from 'lucide-react';

const STATE_FILENAME = 'talevox_state_v2710.json';
const STABLE_POINTER_NAME = 'talevox-latest.json';
const SNAPSHOT_KEY = "talevox_saved_snapshot_v1";
const BACKUP_KEY = "talevox_sync_backup";

const App: React.FC = () => {
  const [state, setState] = useState<AppState>(() => {
    const saved = localStorage.getItem('talevox_pro_v2');
    const parsed = saved ? JSON.parse(saved) : {};
    
    const snapshotStr = localStorage.getItem(SNAPSHOT_KEY);
    const snapshot = snapshotStr ? JSON.parse(snapshotStr) as SavedSnapshot : null;

    return {
      books: (parsed.books || []).map((b: any) => ({
        ...b,
        directoryHandle: undefined,
        settings: b.settings || { useBookSettings: false, highlightMode: HighlightMode.WORD },
        rules: (b.rules || []).map((r: any) => ({
          ...r,
          matchCase: r.matchCase ?? (r.caseMode === 'EXACT'),
          matchExpression: r.matchExpression ?? false,
          ruleType: r.ruleType ?? RuleType.REPLACE
        }))
      })),
      activeBookId: parsed.activeBookId,
      playbackSpeed: parsed.playbackSpeed || 1.0,
      selectedVoiceName: parsed.selectedVoiceName,
      theme: parsed.theme || Theme.LIGHT,
      currentOffsetChars: 0,
      debugMode: parsed.debugMode || false,
      keepAwake: parsed.keepAwake ?? false,
      readerSettings: parsed.readerSettings || {
        fontFamily: "'Source Serif 4', serif",
        fontSizePx: 20,
        lineHeight: 1.8,
        paragraphSpacing: 1,
        highlightColor: '#4f46e5',
        followHighlight: true
      },
      googleClientId: parsed.googleClientId || (import.meta as any).env?.VITE_GOOGLE_CLIENT_ID || '',
      lastSession: parsed.lastSession,
      lastSavedAt: snapshot?.savedAt,
      driveRootFolderId: parsed.driveRootFolderId,
      driveRootFolderName: parsed.driveRootFolderName,
      driveSubfolders: parsed.driveSubfolders
    };
  });

  const [activeTab, setActiveTab] = useState<'library' | 'collection' | 'reader' | 'rules' | 'settings'>('library');
  const [isAddChapterOpen, setIsAddChapterOpen] = useState(false);
  const [isChapterSidebarOpen, setIsChapterSidebarOpen] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [autoplayBlocked, setAutoplayBlocked] = useState(false);
  const [isLoadingChapter, setIsLoadingChapter] = useState(false);
  const [transitionToast, setTransitionToast] = useState<{ number: number; title: string; type?: 'info' | 'success' | 'error' | 'reconnect' } | null>(null);
  const [sleepTimerSeconds, setSleepTimerSeconds] = useState<number | null>(null);
  const [stopAfterChapter, setStopAfterChapter] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [audioDuration, setAudioDuration] = useState(0);
  const [audioCurrentTime, setAudioCurrentTime] = useState(0);
  const [isAuthorized, setIsAuthorized] = useState(isTokenValid());

  const stateRef = useRef(state);
  useEffect(() => { stateRef.current = state; }, [state]);

  const activeBook = useMemo(() => state.books.find(b => b.id === state.activeBookId), [state.books, state.activeBookId]);
  const activeChapterMetadata = useMemo(() => activeBook?.chapters.find(c => c.id === activeBook.currentChapterId), [activeBook]);

  useEffect(() => {
    document.documentElement.style.setProperty('--highlight-color', state.readerSettings.highlightColor);
  }, [state.readerSettings.highlightColor]);

  useEffect(() => {
    if (state.googleClientId) initDriveAuth(state.googleClientId);
    const handleAuthEvent = () => setIsAuthorized(isTokenValid());
    window.addEventListener('talevox_auth_changed', handleAuthEvent);
    window.addEventListener('talevox_auth_invalid', handleAuthEvent);
    return () => {
      window.removeEventListener('talevox_auth_changed', handleAuthEvent);
      window.removeEventListener('talevox_auth_invalid', handleAuthEvent);
    };
  }, [state.googleClientId]);

  const showToast = (title: string, number = 0, type: 'info' | 'success' | 'error' | 'reconnect' = 'info') => {
    setTransitionToast({ number, title, type });
    if (type !== 'reconnect') setTimeout(() => setTransitionToast(null), 3500);
  };

  const handleSaveState = useCallback(async (isCloudSave = true) => {
    const s = stateRef.current;
    const progressStore = JSON.parse(localStorage.getItem(PROGRESS_STORE_V4) || '{}');
    const snapshot: SavedSnapshot = {
      version: "v1", savedAt: Date.now(),
      state: { 
        books: s.books.map(({ directoryHandle, ...b }) => ({ ...b, directoryHandle: undefined })), 
        readerSettings: s.readerSettings, 
        activeBookId: s.activeBookId, 
        playbackSpeed: s.playbackSpeed, 
        selectedVoiceName: s.selectedVoiceName, 
        theme: s.theme, 
        progressStore,
        driveRootFolderId: s.driveRootFolderId,
        driveRootFolderName: s.driveRootFolderName,
        driveSubfolders: s.driveSubfolders
      }
    };
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snapshot));
    setState(prev => ({ ...prev, lastSavedAt: snapshot.savedAt }));
    
    if (isCloudSave && isAuthorized && s.driveSubfolders?.savesId) {
      setIsSyncing(true);
      try {
        const timestampedName = `talevox_state_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
        // Upload both timestamped and stable pointer
        await uploadToDrive(s.driveSubfolders.savesId, timestampedName, JSON.stringify(snapshot), undefined, 'application/json');
        const latestId = await findFileSync(STABLE_POINTER_NAME, s.driveSubfolders.savesId);
        await uploadToDrive(s.driveSubfolders.savesId, STABLE_POINTER_NAME, JSON.stringify(snapshot), latestId || undefined, 'application/json');
        showToast("Cloud State Saved", 0, 'success');
      } catch (e: any) {
        showToast("Cloud Save Failed", 0, 'error');
      } finally { setIsSyncing(false); }
    }
  }, [isAuthorized]);

  const applySnapshot = useCallback((snapshot: SavedSnapshot) => {
    const s = stateRef.current;
    // Non-destructive merge logic
    const { books: cloudBooks, readerSettings: cloudRS, activeBookId, playbackSpeed, selectedVoiceName, theme, progressStore: cloudProgress, driveRootFolderId, driveRootFolderName, driveSubfolders } = snapshot.state;
    
    // Backup local state first
    localStorage.setItem(BACKUP_KEY, JSON.stringify({ state: s, progress: JSON.parse(localStorage.getItem(PROGRESS_STORE_V4) || '{}') }));

    const mergedBooks = [...s.books];
    cloudBooks.forEach(cb => {
      const idx = mergedBooks.findIndex(b => b.id === cb.id || b.title === cb.title);
      if (idx === -1) {
        mergedBooks.push(cb);
      } else {
        const lb = mergedBooks[idx];
        // Compare book level timestamps if they exist, otherwise trust cloud if newer
        const trustCloud = !lb.updatedAt || (cb.updatedAt && cb.updatedAt > lb.updatedAt);
        if (trustCloud) {
           // Merge chapters additively
           const mergedChapters = [...lb.chapters];
           cb.chapters.forEach(cc => {
              const cIdx = mergedChapters.findIndex(lc => lc.id === cc.id || lc.index === cc.index);
              if (cIdx === -1) {
                 mergedChapters.push(cc);
              } else {
                 const lc = mergedChapters[cIdx];
                 if (!lc.updatedAt || (cc.updatedAt && cc.updatedAt > lc.updatedAt)) {
                    mergedChapters[cIdx] = cc;
                 }
              }
           });
           mergedBooks[idx] = { ...lb, ...cb, chapters: mergedChapters.sort((a,b) => a.index-b.index) };
        }
      }
    });

    const localProgress = JSON.parse(localStorage.getItem(PROGRESS_STORE_V4) || '{}');
    const finalProgress = { ...cloudProgress };
    // Additive progress merge
    Object.keys(localProgress).forEach(bookId => {
       if (!finalProgress[bookId]) finalProgress[bookId] = localProgress[bookId];
       else {
          Object.keys(localProgress[bookId]).forEach(chId => {
             const lp = localProgress[bookId][chId];
             const cp = finalProgress[bookId][chId];
             if (!cp || (lp.updatedAt && lp.updatedAt > (cp.updatedAt || 0))) {
                finalProgress[bookId][chId] = lp;
             }
          });
       }
    });

    setState(prev => ({ 
      ...prev, 
      books: mergedBooks, 
      readerSettings: cloudRS || prev.readerSettings, 
      activeBookId: activeBookId || prev.activeBookId, 
      playbackSpeed: playbackSpeed || prev.playbackSpeed, 
      selectedVoiceName: selectedVoiceName || prev.selectedVoiceName, 
      theme: theme || prev.theme, 
      lastSavedAt: snapshot.savedAt, 
      driveRootFolderId: driveRootFolderId || prev.driveRootFolderId, 
      driveRootFolderName: driveRootFolderName || prev.driveRootFolderName, 
      driveSubfolders: driveSubfolders || prev.driveSubfolders 
    }));
    
    localStorage.setItem(PROGRESS_STORE_V4, JSON.stringify(finalProgress));
    window.dispatchEvent(new CustomEvent('talevox_progress_updated', { detail: { bookId: activeBookId || stateRef.current.activeBookId } }));
  }, []);

  const handleSync = useCallback(async (manual = false) => {
    const s = stateRef.current;
    if (!isAuthorized || !s.driveSubfolders?.savesId) {
      if (manual) showToast("Cloud setup required", 0, 'error');
      return;
    }
    setIsSyncing(true);
    if (manual) showToast("Syncing with Drive...", 0, 'info');
    try {
      // 1. Get Newest Save
      const saves = await listFilesSortedByModified(s.driveSubfolders.savesId);
      const newestSaveFile = saves.find(f => f.name === STABLE_POINTER_NAME) || saves[0];
      
      if (!newestSaveFile) {
        if (manual) showToast("No backup found", 0, 'info');
      } else {
        const remoteContent = await fetchDriveFile(newestSaveFile.id);
        const remoteSnapshot = JSON.parse(remoteContent) as SavedSnapshot;
        const localSnapshotStr = localStorage.getItem(SNAPSHOT_KEY);
        const localSnapshot = localSnapshotStr ? JSON.parse(localSnapshotStr) as SavedSnapshot : null;

        if (!localSnapshot || remoteSnapshot.savedAt > localSnapshot.savedAt || manual) {
          applySnapshot(remoteSnapshot);
          if (manual) showToast("Cloud Save Applied", 0, 'success');
        }
      }

      // 2. Additive Drive File Discovery (Scan Books)
      if (s.driveSubfolders.booksId) {
         let foundCount = 0;
         const updatedBooks = [...stateRef.current.books];
         for (let i = 0; i < updatedBooks.length; i++) {
           const book = updatedBooks[i];
           if (book.driveFolderId) {
             const driveFiles = await listFilesInFolder(book.driveFolderId);
             const mergedChapters = [...book.chapters];
             driveFiles.forEach(f => {
               if (f.name.endsWith('.txt')) {
                  const match = f.name.match(/^(\d+)_/);
                  if (match) {
                     const index = parseInt(match[1]);
                     const exists = mergedChapters.some(c => c.index === index);
                     if (!exists) {
                        const title = f.name.replace(/^\d+_/, '').replace(/\.txt$/, '').replace(/_/g, ' ');
                        mergedChapters.push({
                           id: crypto.randomUUID(),
                           index,
                           title,
                           filename: f.name,
                           content: '', // lazy load
                           wordCount: 0,
                           progress: 0,
                           progressChars: 0,
                           cloudTextFileId: f.id,
                           hasTextOnDrive: true,
                           audioStatus: AudioStatus.PENDING,
                           updatedAt: Date.now()
                        });
                        foundCount++;
                     }
                  }
               }
             });
             updatedBooks[i] = { ...book, chapters: mergedChapters.sort((a,b) => a.index-b.index) };
           }
         }
         if (foundCount > 0) {
            setState(p => ({ ...p, books: updatedBooks }));
            if (manual) showToast(`Discovered ${foundCount} new chapters`, 0, 'success');
         }
      }
    } catch (err: any) { 
      showToast("Sync Error", 0, 'error');
    } finally { setIsSyncing(false); }
  }, [applySnapshot, isAuthorized]);

  // Initial Sync on Load
  useEffect(() => {
    if (isAuthorized && state.driveSubfolders?.savesId) {
       handleSync(false);
    }
  }, [isAuthorized, !!state.driveSubfolders?.savesId]);

  const updateChapterAudio = useCallback((bookId: string, chapterId: string, updates: Partial<Chapter>) => {
    setState(prev => ({
      ...prev, books: prev.books.map(b => b.id === bookId ? { ...b, chapters: b.chapters.map(c => c.id === chapterId ? { ...c, ...updates } : c) } : b)
    }));
  }, []);

  const queueBackgroundTTS = useCallback(async (bookId: string, chapterId: string, customVoiceId?: string, forceChapter?: Chapter) => {
    const s = stateRef.current;
    const book = s.books.find(b => b.id === bookId);
    const chapter = forceChapter || book?.chapters.find(c => c.id === chapterId);
    if (!book || !chapter || chapter.audioStatus === AudioStatus.READY) return;

    const voice = customVoiceId || book.settings.defaultVoiceId || 'en-US-Standard-C';
    const rawIntro = `Chapter ${chapter.index}. ${chapter.title}. `;
    const fullText = applyRules(rawIntro + chapter.content, book.rules);
    const cacheKey = generateAudioKey(fullText, voice, 1.0);
    
    if (book.backend === StorageBackend.DRIVE && book.driveFolderId && isAuthorized) {
       const audioName = buildMp3Name(chapter.index, chapter.title);
       const driveId = await findFileSync(audioName, book.driveFolderId);
       if (driveId) {
          updateChapterAudio(bookId, chapterId, { audioStatus: AudioStatus.READY, cloudAudioFileId: driveId });
          return;
       }
    }

    const cached = await getAudioFromCache(cacheKey);
    if (cached) {
      if (book.backend === StorageBackend.DRIVE && book.driveFolderId && isAuthorized) {
         updateChapterAudio(bookId, chapterId, { audioStatus: AudioStatus.GENERATING });
         try {
           const audioName = buildMp3Name(chapter.index, chapter.title);
           const driveFileId = await uploadToDrive(book.driveFolderId, audioName, cached, undefined, 'audio/mpeg');
           updateChapterAudio(bookId, chapterId, { audioStatus: AudioStatus.READY, cloudAudioFileId: driveFileId, hasCachedAudio: true });
         } catch(e) { updateChapterAudio(bookId, chapterId, { audioStatus: AudioStatus.FAILED }); }
      } else { updateChapterAudio(bookId, chapterId, { audioStatus: AudioStatus.READY, hasCachedAudio: true }); }
      return;
    }

    updateChapterAudio(bookId, chapterId, { audioStatus: AudioStatus.GENERATING });
    showToast(`Generating audio: ${chapter.title.substring(0, 15)}...`, 0, 'info');
    try {
      const res = await synthesizeChunk(fullText, voice, 1.0);
      const fetchRes = await fetch(res.audioUrl);
      if (!fetchRes.ok) throw new Error("Synthesis output error");
      const audioBlob = await fetchRes.blob();
      if (!audioBlob || audioBlob.size === 0) throw new Error("Empty audio output");
      
      await saveAudioToCache(cacheKey, audioBlob);
      let cloudId = undefined;
      if (book.backend === StorageBackend.DRIVE && book.driveFolderId && isAuthorized) {
         const audioName = buildMp3Name(chapter.index, chapter.title);
         cloudId = await uploadToDrive(book.driveFolderId, audioName, audioBlob, undefined, 'audio/mpeg');
      }
      updateChapterAudio(bookId, chapterId, { audioStatus: AudioStatus.READY, hasCachedAudio: true, cloudAudioFileId: cloudId });
      showToast(`Audio ready: ${chapter.title.substring(0, 15)}`, 0, 'success');
      handleSaveState(true);
    } catch (e) { 
      updateChapterAudio(bookId, chapterId, { audioStatus: AudioStatus.FAILED }); 
      showToast(`Audio failed: ${chapter.title}`, 0, 'error');
    }
  }, [handleSaveState, isAuthorized, updateChapterAudio]);

  const handleSmartExtractChapter = useCallback(async (bookId: string, chapterId: string) => {
    const s = stateRef.current;
    const book = s.books.find(b => b.id === bookId);
    const chapter = book?.chapters.find(c => c.id === chapterId);
    if (!book || !chapter) return;

    showToast("Starting Smart Extraction...", 0, 'info');
    setIsLoadingChapter(true);

    try {
      let sourceText = chapter.content;
      if (book.backend === StorageBackend.DRIVE && isAuthorized) {
        let fileId = chapter.cloudTextFileId;
        if (!fileId && book.driveFolderId) {
          const expectedName = buildTextName(chapter.index, chapter.title);
          fileId = await findFileSync(expectedName, book.driveFolderId) || undefined;
        }
        if (fileId) {
          try { sourceText = await fetchDriveFile(fileId); } catch (e) { console.warn("Could not fetch drive file for smart extraction"); }
        }
      }

      const extracted = await extractChapterWithAI(sourceText);
      const updatedChapter: Chapter = {
        ...chapter,
        title: extracted.title,
        content: extracted.content,
        index: extracted.index,
        wordCount: extracted.content.split(/\s+/).filter(Boolean).length,
        audioStatus: AudioStatus.PENDING,
        updatedAt: Date.now()
      };

      if (book.backend === StorageBackend.DRIVE && book.driveFolderId && isAuthorized) {
        const filename = buildTextName(extracted.index, extracted.title);
        const newFileId = await uploadToDrive(book.driveFolderId, filename, extracted.content, chapter.cloudTextFileId, 'text/plain');
        updatedChapter.cloudTextFileId = newFileId;
        updatedChapter.hasTextOnDrive = true;
      }

      setState(prev => ({
        ...prev,
        books: prev.books.map(b => b.id === bookId ? { ...b, chapters: b.chapters.map(c => c.id === chapterId ? updatedChapter : c).sort((x, y) => x.index - y.index) } : b)
      }));

      showToast("Smart Extraction Successful", 0, 'success');
      queueBackgroundTTS(bookId, chapterId, book.settings.defaultVoiceId, updatedChapter);

    } catch (err: any) {
      showToast("Extraction Failed", 0, 'error');
    } finally {
      setIsLoadingChapter(false);
    }
  }, [isAuthorized, queueBackgroundTTS]);

  const handleChapterExtracted = useCallback(async (data: { 
    title: string; content: string; url: string; index: number; voiceId: string; setAsDefault: boolean;
  }) => {
    const s = stateRef.current;
    if (!s.activeBookId) return;
    const book = s.books.find(b => b.id === s.activeBookId);
    if (!book) return;

    if (data.setAsDefault) {
      setState(prev => ({ ...prev, books: prev.books.map(b => b.id === prev.activeBookId ? { ...b, settings: { ...b.settings, defaultVoiceId: data.voiceId } } : b) }));
    }

    const filename = buildTextName(data.index, data.title);
    let cloudTextId = undefined;
    if (book.backend === StorageBackend.DRIVE && book.driveFolderId && isAuthorized) {
      showToast("Saving source text...", 0, 'info');
      try { cloudTextId = await uploadToDrive(book.driveFolderId, filename, data.content, undefined, 'text/plain'); } catch (e) { showToast("Drive save failed", 0, 'error'); }
    }

    if (book.backend === StorageBackend.LOCAL && book.directoryHandle) {
      try { await saveChapterToFile(book.directoryHandle, { id: 'tmp', index: data.index, title: data.title, content: data.content, filename, wordCount: 0, progress: 0, progressChars: 0 }); } catch (e) {}
    }

    const newChapter: Chapter = { id: crypto.randomUUID(), index: data.index, title: data.title, content: data.content, filename, wordCount: data.content.split(/\s+/).filter(Boolean).length, progress: 0, progressChars: 0, audioStatus: AudioStatus.PENDING, cloudTextFileId: cloudTextId, hasTextOnDrive: !!cloudTextId, updatedAt: Date.now() };
    
    setState(prev => ({ ...prev, books: prev.books.map(b => b.id === prev.activeBookId ? { ...b, chapters: [...b.chapters, newChapter].sort((a,b) => a.index-b.index), currentChapterId: b.currentChapterId || newChapter.id } : b) }));
    setIsAddChapterOpen(false);
    showToast("Chapter Saved", 0, 'success');
    
    queueBackgroundTTS(s.activeBookId, newChapter.id, data.voiceId, newChapter);
    handleSaveState(true);
  }, [queueBackgroundTTS, isAuthorized, handleSaveState]);

  const handleSelectRoot = useCallback(async () => {
    try {
      const selected = await openFolderPicker();
      if (!selected) return;
      setIsSyncing(true);
      const sub = await ensureRootStructure(selected.id);
      setState(p => ({ ...p, driveRootFolderId: selected.id, driveRootFolderName: selected.name, driveSubfolders: sub }));
      showToast("TaleVox Root Linked", 0, 'success');
    } catch (e: any) {
      showToast(e.message, 0, 'error');
    } finally { setIsSyncing(false); }
  }, []);

  const handleRunMigration = useCallback(async () => {
    const s = stateRef.current;
    if (!isAuthorized || !s.driveRootFolderId || !s.driveSubfolders) {
      showToast("Link Root Drive First", 0, 'error');
      return;
    }
    setIsSyncing(true);
    showToast("Starting Migration...", 0, 'info');
    try {
      const updatedBooks = [...s.books];
      for (let i = 0; i < updatedBooks.length; i++) {
        const book = updatedBooks[i];
        if (book.backend === StorageBackend.DRIVE && book.driveFolderId) {
          const currentParentId = s.driveSubfolders.booksId;
          const bookFolderInBooksId = await findFileSync(book.title, currentParentId);
          
          if (!bookFolderInBooksId || book.driveFolderId !== bookFolderInBooksId) {
             const newBookFolderId = await ensureBookFolder(currentParentId, book.title);
             const files = await listFilesInFolder(book.driveFolderId);
             for (const file of files) {
               if (file.mimeType !== 'application/vnd.google-apps.folder') {
                  await moveFile(file.id, book.driveFolderId, newBookFolderId);
               }
             }
             updatedBooks[i] = { ...book, driveFolderId: newBookFolderId };
          }
        }
      }
      setState(p => ({ ...p, books: updatedBooks }));
      showToast("Migration Complete", 0, 'success');
    } catch (e: any) {
      showToast("Migration failed", 0, 'error');
    } finally { setIsSyncing(false); }
  }, [isAuthorized]);

  const handleNextChapter = useCallback(() => {
    const s = stateRef.current;
    const book = s.books.find(b => b.id === s.activeBookId);
    if (!book || !book.currentChapterId) return;

    const sorted = [...book.chapters].sort((a, b) => a.index - b.index);
    const idx = sorted.findIndex(c => c.id === book.currentChapterId);

    if (idx >= 0 && idx < sorted.length - 1) {
      const next = sorted[idx + 1];
      setState(p => ({
        ...p,
        books: p.books.map(b => b.id === book.id ? { ...b, currentChapterId: next.id } : b),
        currentOffsetChars: 0
      }));
    } else {
      setIsPlaying(false);
      showToast("End of book reached", 0, 'success');
    }
  }, []);

  const handlePlay = useCallback(async () => {
    const s = stateRef.current;
    const book = s.books.find(b => b.id === s.activeBookId);
    if (!book || !book.currentChapterId) return;
    const chapter = book.chapters.find(c => c.id === book.currentChapterId);
    if (!chapter) return;

    setIsPlaying(true);
    setAutoplayBlocked(false);
    const voice = book.settings.defaultVoiceId || 'en-US-Standard-C';
    const text = applyRules(chapter.content, book.rules);
    const speed = (book.settings.useBookSettings && book.settings.playbackSpeed) ? book.settings.playbackSpeed : s.playbackSpeed;

    const rawIntro = `Chapter ${chapter.index}. ${chapter.title}. `;
    const introText = applyRules(rawIntro, book.rules);
    const estimatedIntroDurSec = (introText.length / (18 * speed)); 

    try {
      const cacheKey = generateAudioKey(introText + text, voice, 1.0);
      let audioBlob = await getAudioFromCache(cacheKey);

      if (!audioBlob && chapter.cloudAudioFileId && isAuthorized) {
        showToast("Fetching cloud audio...", 0, 'info');
        try { audioBlob = await fetchDriveBinary(chapter.cloudAudioFileId); if (audioBlob) await saveAudioToCache(cacheKey, audioBlob); } catch(e) {}
      }

      if (audioBlob && audioBlob.size > 0) {
        const url = URL.createObjectURL(audioBlob);
        speechController.setContext({ bookId: book.id, chapterId: chapter.id });
        try {
          await speechController.loadAndPlayDriveFile('', 'LOCAL_ID', text.length, estimatedIntroDurSec, undefined, 0, speed, 
            () => { if (stopAfterChapter) setIsPlaying(false); else handleNextChapter(); },
            (meta) => { setAudioCurrentTime(meta.currentTime); setAudioDuration(meta.duration); setState(p => ({ ...p, currentOffsetChars: meta.charOffset })); },
            url
          );
          setAutoplayBlocked(false);
        } catch (playErr: any) {
          if (playErr.name === 'NotAllowedError') {
             setAutoplayBlocked(true);
             setIsPlaying(false);
          } else { throw playErr; }
        }
      } else {
        if (chapter.cloudTextFileId && chapter.content === '') {
           showToast("Loading text from cloud...", 0, 'info');
           const content = await fetchDriveFile(chapter.cloudTextFileId);
           setState(p => ({ ...p, books: p.books.map(b => b.id === book.id ? { ...b, chapters: b.chapters.map(c => c.id === chapter.id ? { ...c, content, wordCount: content.split(/\s+/).filter(Boolean).length } : c) } : b) }));
           setTimeout(() => handlePlay(), 100);
           return;
        }
        showToast("Audio generating...", 0, 'info');
        await queueBackgroundTTS(s.activeBookId!, chapter.id);
        setTimeout(() => handlePlay(), 1000);
      }
    } catch (e) { setIsPlaying(false); showToast("Playback error", 0, 'error'); }
  }, [queueBackgroundTTS, stopAfterChapter, handleNextChapter, isAuthorized]);

  useEffect(() => {
    if (isPlaying && activeBook?.currentChapterId) {
      handlePlay();
    }
  }, [activeBook?.currentChapterId, isPlaying, handlePlay]);

  const handlePause = () => { speechController.pause(); setIsPlaying(false); };
  const handleSeekToTime = (t: number) => speechController.seekToTime(t);
  const handleJumpToOffset = (o: number) => speechController.seekToOffset(o);

  const handleAddBook = async (title: string, backend: StorageBackend, directoryHandle?: any) => {
    const s = stateRef.current;
    let driveId = undefined;
    let driveName = undefined;
    if (backend === StorageBackend.DRIVE) {
      if (!s.driveSubfolders?.booksId) { showToast("Setup Drive Root in Settings", 0, 'error'); setActiveTab('settings'); return; }
      showToast("Provisioning folder...", 0, 'info');
      try {
        driveId = await ensureBookFolder(s.driveSubfolders.booksId, title);
        driveName = title;
      } catch (e) { showToast("Folder creation failed", 0, 'error'); return; }
    }
    const bk: Book = { id: crypto.randomUUID(), title, chapters: [], rules: [], backend, directoryHandle, driveFolderId: driveId, driveFolderName: driveName, settings: { useBookSettings: false, highlightMode: HighlightMode.WORD }, updatedAt: Date.now() };
    setState(p => ({ ...p, books: [...p.books, bk], activeBookId: bk.id }));
    setActiveTab('collection');
    showToast("Book added", 0, 'success');
  };

  const handleResetChapterProgress = useCallback(async (bookId: string, chapterId: string) => {
    const storeRaw = localStorage.getItem(PROGRESS_STORE_V4);
    const store = storeRaw ? JSON.parse(storeRaw) : {};
    if (store[bookId] && store[bookId][chapterId]) {
      store[bookId][chapterId] = { timeSec: 0, durationSec: store[bookId][chapterId].durationSec || 0, percent: 0, completed: false, updatedAt: Date.now() };
      localStorage.setItem(PROGRESS_STORE_V4, JSON.stringify(store));
    }
    if (state.activeBookId === bookId && activeBook?.currentChapterId === chapterId) {
      setState(p => ({ ...p, currentOffsetChars: 0 }));
    }
    window.dispatchEvent(new CustomEvent('talevox_progress_updated', { detail: { bookId, chapterId } }));
    handleSaveState(true);
    showToast("Progress reset", 0, 'success');
  }, [activeBook, state.activeBookId, handleSaveState]);

  useEffect(() => {
    localStorage.setItem('talevox_pro_v2', JSON.stringify({ ...state, books: state.books.map(({ directoryHandle, ...b }) => ({ ...b, directoryHandle: undefined })) }));
  }, [state]);

  return (
    <div className={`flex flex-col h-screen overflow-hidden font-sans transition-colors duration-500 ${state.theme === Theme.DARK ? 'bg-slate-950 text-slate-100' : state.theme === Theme.SEPIA ? 'bg-[#f4ecd8] text-[#3c2f25]' : 'bg-white text-black'}`}>
      <header className={`h-16 border-b flex items-center justify-between px-4 lg:px-8 z-10 sticky top-0 transition-colors ${state.theme === Theme.DARK ? 'border-slate-800 bg-slate-900/80 backdrop-blur-md' : state.theme === Theme.SEPIA ? 'border-[#d8ccb6] bg-[#efe6d5]/90 backdrop-blur-md' : 'border-black/5 bg-white/90 backdrop-blur-md'}`}>
        <div className="flex items-center gap-4">
          {activeTab === 'reader' && (
            <button onClick={() => setIsChapterSidebarOpen(true)} className="p-2 lg:hidden rounded-lg hover:bg-black/5"><Menu className="w-5 h-5" /></button>
          )}
          <nav className="flex items-center gap-4 sm:gap-6">
            <button onClick={() => setActiveTab('library')} className={`flex items-center gap-2 h-16 border-b-2 font-black uppercase text-[10px] tracking-widest ${activeTab === 'library' || activeTab === 'collection' ? 'border-indigo-600 text-indigo-600' : 'border-transparent opacity-60'}`}><LibraryIcon className="w-4 h-4" /> <span className="hidden sm:inline">Library</span></button>
            <button onClick={() => setActiveTab('rules')} className={`flex items-center gap-2 h-16 border-b-2 font-black uppercase text-[10px] tracking-widest ${activeTab === 'rules' ? 'border-indigo-600 text-indigo-600' : 'border-transparent opacity-60'}`}><Zap className="w-4 h-4" /> <span className="hidden sm:inline">Rules</span></button>
            <button onClick={() => setActiveTab('settings')} className={`flex items-center gap-2 h-16 border-b-2 font-black uppercase text-[10px] tracking-widest ${activeTab === 'settings' ? 'border-indigo-600 text-indigo-600' : 'border-transparent opacity-60'}`}><SettingsIcon className="w-4 h-4" /> <span className="hidden sm:inline">Settings</span></button>
          </nav>
        </div>
        <div className="flex items-center gap-2 sm:gap-4">
          {!isAuthorized ? (
            <button onClick={() => getValidDriveToken({ interactive: true })} className="flex items-center gap-2 px-3 py-2 bg-indigo-600 text-white rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-indigo-700 transition-all shadow-md"><LogIn className="w-3.5 h-3.5" /> <span className="hidden xs:inline">Sign In</span></button>
          ) : (
            <button onClick={() => handleSync(true)} disabled={isSyncing} className={`flex items-center gap-2 px-3 py-2 bg-indigo-600/10 text-indigo-600 rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-indigo-600/20 transition-all ${isSyncing ? 'animate-pulse' : ''}`}><RefreshCw className="w-3.5 h-3.5" /> <span className="hidden xs:inline">Sync</span></button>
          )}
          <button onClick={() => handleSaveState(true)} className={`p-2.5 rounded-xl bg-indigo-600/10 text-indigo-600 hover:bg-indigo-600/20 transition-all ${isSyncing ? 'animate-pulse' : ''}`} title="Save State"><Save className="w-4 h-4" /></button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto relative flex">
        {isLoadingChapter && <div className="absolute inset-0 flex items-center justify-center bg-inherit z-[70]"><Loader2 className="w-10 h-10 text-indigo-600 animate-spin" /></div>}
        {isSyncing && !transitionToast && (
          <div className="fixed top-20 right-4 z-[80] animate-in slide-in-from-right duration-300">
             <div className="bg-indigo-600 text-white px-4 py-2 rounded-xl shadow-2xl flex items-center gap-3 font-black text-[10px] uppercase tracking-widest">
               <Loader2 className="w-3.5 h-3.5 animate-spin" /> Syncing with Drive...
             </div>
          </div>
        )}
        {isAddChapterOpen && (
          <div className="absolute inset-0 z-[60] overflow-y-auto p-4 lg:p-12 backdrop-blur-md bg-black/10">
            <div className="max-w-4xl mx-auto relative">
              <button onClick={() => setIsAddChapterOpen(false)} className="absolute -top-4 -right-4 p-3 bg-white text-black shadow-2xl rounded-full hover:scale-110 active:scale-95 transition-transform z-10"><X className="w-6 h-6" /></button>
              <Extractor 
                onChapterExtracted={handleChapterExtracted} 
                suggestedIndex={activeBook?.chapters.length ? Math.max(...activeBook.chapters.map(c => c.index)) + 1 : 1} 
                theme={state.theme} 
                defaultVoiceId={activeBook?.settings.defaultVoiceId} 
              />
            </div>
          </div>
        )}
        
        {activeTab === 'reader' && activeBook && (
          <aside className="hidden lg:block w-72 border-r border-black/5 bg-black/5 overflow-y-auto">
             <ChapterSidebar 
               book={activeBook} theme={state.theme} onSelectChapter={(cid) => { setState(p => ({ ...p, books: p.books.map(b => b.id === activeBook.id ? { ...b, currentChapterId: cid } : b), currentOffsetChars: 0 })); }} 
               onClose={() => {}} isDrawer={false}
             />
          </aside>
        )}

        {isChapterSidebarOpen && activeBook && (
          <div className="fixed inset-0 z-[60] flex">
            <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setIsChapterSidebarOpen(false)} />
            <div className={`relative w-[85%] max-sm max-w-sm h-full shadow-2xl animate-in slide-in-from-left duration-300 ${state.theme === Theme.DARK ? 'bg-slate-900' : state.theme === Theme.SEPIA ? 'bg-[#efe6d5]' : 'bg-white'}`}>
              <ChapterSidebar 
                book={activeBook} theme={state.theme} onSelectChapter={(cid) => { setState(p => ({ ...p, books: p.books.map(b => b.id === activeBook.id ? { ...b, currentChapterId: cid } : b), currentOffsetChars: 0 })); setIsChapterSidebarOpen(false); }} 
                onClose={() => setIsChapterSidebarOpen(false)} isDrawer={true}
              />
            </div>
          </div>
        )}

        <div className="flex-1 min-w-0 h-full overflow-y-auto">
          {activeTab === 'library' && (
            <Library 
              books={state.books} activeBookId={state.activeBookId} lastSession={state.lastSession} 
              onSelectBook={id => { setState(p => ({ ...p, activeBookId: id })); setActiveTab('collection'); }} 
              onAddBook={handleAddBook}
              onDeleteBook={id => setState(p => ({ ...p, books: p.books.filter(b => b.id !== id) }))}
              onUpdateBook={book => setState(p => ({ ...p, books: p.books.map(b => b.id === book.id ? book : b) }))}
              onSelectChapter={(bid, cid) => { setState(p => ({ ...p, activeBookId: bid, books: p.books.map(b => b.id === bid ? { ...b, currentChapterId: cid } : b) })); setActiveTab('reader'); }}
              theme={state.theme}
            />
          )}
          
          {activeTab === 'collection' && activeBook && (
            <ChapterFolderView 
              book={activeBook} theme={state.theme} onAddChapter={() => setIsAddChapterOpen(true)}
              onOpenChapter={id => { setState(p => ({ ...p, books: p.books.map(b => b.id === activeBook.id ? { ...b, currentChapterId: id } : b) })); setActiveTab('reader'); }}
              onToggleFavorite={() => {}} onUpdateChapterTitle={(id, t) => setState(p => ({ ...p, books: p.books.map(b => b.id === activeBook.id ? { ...b, chapters: b.chapters.map(c => c.id === id ? { ...c, title: t } : c) } : b) }))}
              onDeleteChapter={id => setState(p => ({ ...p, books: p.books.map(b => b.id === activeBook.id ? { ...b, chapters: b.chapters.filter(c => c.id !== id) } : b) }))}
              onUpdateChapter={c => setState(prev => ({ ...prev, books: prev.books.map(b => b.id === activeBook.id ? { ...b, chapters: b.chapters.map(ch => ch.id === c.id ? c : ch) } : b) }))}
              onUpdateBookSettings={s => setState(p => ({ ...p, books: p.books.map(b => b.id === activeBook.id ? { ...b, settings: { ...b.settings, ...s } } : b) }))}
              onBackToLibrary={() => setActiveTab('library')}
              onResetChapterProgress={handleResetChapterProgress}
              onSmartExtractChapter={(cid) => handleSmartExtractChapter(activeBook.id, cid)}
            />
          )}

          {activeTab === 'reader' && activeBook && activeChapterMetadata && (
            <Reader 
              chapter={activeChapterMetadata} rules={activeBook.rules} currentOffsetChars={state.currentOffsetChars} theme={state.theme}
              debugMode={state.debugMode} onToggleDebug={() => setState(p => ({ ...p, debugMode: !p.debugMode }))} onJumpToOffset={handleJumpToOffset}
              onBackToCollection={() => setActiveTab('collection')} onAddChapter={() => setIsAddChapterOpen(true)}
              highlightMode={activeBook.settings.highlightMode} readerSettings={state.readerSettings}
            />
          )}

          {activeTab === 'rules' && (
            <RuleManager 
              rules={activeBook?.rules || []} theme={state.theme} onAddRule={r => setState(p => ({ ...p, books: p.books.map(b => b.id === p.activeBookId ? { ...b, rules: [...b.rules, r] } : b) }))}
              onUpdateRule={r => setState(p => ({ ...p, books: p.books.map(b => b.id === p.activeBookId ? { ...b, rules: b.rules.map(o => o.id === r.id ? r : o) } : b) }))}
              onDeleteRule={id => setState(p => ({ ...p, books: p.activeBookId ? { ...p.books.map(b => b.id === p.activeBookId ? { ...b, rules: b.rules.filter(ru => ru.id !== id) } : b) } : [] }))}
              onImportRules={nr => setState(p => ({ ...p, books: p.books.map(b => b.id === p.activeBookId ? { ...b, rules: nr } : b) }))}
              selectedVoice={state.selectedVoiceName || ''} playbackSpeed={state.playbackSpeed}
            />
          )}

          {activeTab === 'settings' && (
            <Settings 
              settings={state.readerSettings} onUpdate={s => setState(p => ({ ...p, readerSettings: { ...p.readerSettings, ...s } }))} theme={state.theme} 
              onSetTheme={t => setState(p => ({ ...p, theme: t }))}
              keepAwake={state.keepAwake} onSetKeepAwake={v => setState(p => ({ ...p, keepAwake: v }))} onCheckForUpdates={() => window.location.reload()}
              onLinkCloud={() => getValidDriveToken({ interactive: true })} onSyncNow={() => handleSync(true)}
              googleClientId={state.googleClientId} onUpdateGoogleClientId={id => setState(p => ({ ...p, googleClientId: id }))}
              onClearAuth={() => clearStoredToken()} onSaveState={() => handleSaveState(true)} lastSavedAt={state.lastSavedAt}
              driveRootName={state.driveRootFolderName} onSelectRoot={handleSelectRoot} onRunMigration={handleRunMigration}
            />
          )}
        </div>
      </div>

      {activeChapterMetadata && activeTab === 'reader' && (
        <Player 
          isPlaying={isPlaying} onPlay={handlePlay} onPause={handlePause} onStop={() => setIsPlaying(false)} onNext={handleNextChapter} onPrev={() => {}} onSeek={d => handleJumpToOffset(state.currentOffsetChars + d)}
          speed={state.playbackSpeed} onSpeedChange={s => setState(p => ({ ...p, playbackSpeed: s }))} selectedVoice={''} onVoiceChange={() => {}} theme={state.theme} onThemeChange={() => {}}
          progressChars={state.currentOffsetChars} totalLengthChars={activeChapterMetadata.content.length} wordCount={activeChapterMetadata.wordCount} onSeekToOffset={handleJumpToOffset}
          sleepTimer={sleepTimerSeconds} onSetSleepTimer={setSleepTimerSeconds} stopAfterChapter={stopAfterChapter} onSetStopAfterChapter={setStopAfterChapter}
          useBookSettings={false} onSetUseBookSettings={() => {}} highlightMode={activeBook?.settings.highlightMode || HighlightMode.WORD} onSetHighlightMode={m => setState(p => ({ ...p, books: p.books.map(b => b.id === activeBook?.id ? { ...b, settings: { ...b.settings, highlightMode: m } } : b) }))}
          playbackCurrentTime={audioCurrentTime} playbackDuration={audioDuration} onSeekToTime={handleSeekToTime}
          autoplayBlocked={autoplayBlocked}
        />
      )}
      
      {transitionToast && (
        <div className={`fixed bottom-24 sm:bottom-32 left-1/2 -translate-x-1/2 z-[100] toast-animate`}>
          <div className={`${transitionToast.type === 'success' ? 'bg-emerald-600' : transitionToast.type === 'error' ? 'bg-red-600' : transitionToast.type === 'reconnect' ? 'bg-amber-600' : 'bg-indigo-600'} text-white px-8 py-4 rounded-2xl shadow-2xl font-black text-sm flex items-center gap-4`}>
            <span className="leading-tight">{transitionToast.number > 0 ? `Chapter ${transitionToast.number}: ${transitionToast.title}` : transitionToast.title}</span>
          </div>
        </div>
      )}
    </div>
  );
};

export default App;