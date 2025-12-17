
export enum CaseMode {
  EXACT = 'EXACT',
  IGNORE = 'IGNORE',
  SMART = 'SMART'
}

export enum Scope {
  PHRASE = 'PHRASE',
  WORD = 'WORD'
}

export enum Theme {
  LIGHT = 'light',
  SEPIA = 'sepia',
  DARK = 'dark'
}

export enum HighlightMode {
  WORD = 'word',
  SENTENCE = 'sentence',
  KARAOKE = 'karaoke'
}

export enum StorageBackend {
  LOCAL = 'local',
  DRIVE = 'drive',
  MEMORY = 'memory'
}

export interface Rule {
  id: string;
  find: string;
  speakAs: string;
  caseMode: CaseMode;
  wholeWord: boolean;
  scope: Scope;
  priority: number;
  enabled: boolean;
  phoneticHint?: string;
}

export interface Chapter {
  id: string;
  index: number;
  title: string;
  sourceUrl?: string;
  filename: string;
  content: string;
  wordCount: number;
  progress: number; // character offset
  progressTotalLength?: number; // total text length at time of progress
  isFavorite?: boolean;
  isCompleted?: boolean;
  driveId?: string;
}

export interface BookSettings {
  playbackSpeed?: number;
  selectedVoiceName?: string;
  useBookSettings: boolean;
  highlightMode: HighlightMode;
}

export interface ReaderSettings {
  fontFamily: string;
  fontSizePx: number;
  lineHeight: number;
  paragraphSpacing: number; // 1 for compact, 2 for wide
}

export interface Book {
  id: string;
  title: string;
  author?: string;
  chapters: Chapter[];
  currentChapterId?: string;
  rules: Rule[];
  directoryHandle?: any;
  driveFolderId?: string;
  backend: StorageBackend;
  settings: BookSettings;
}

export interface AppState {
  books: Book[];
  activeBookId?: string;
  playbackSpeed: number;
  selectedVoiceName?: string;
  theme: Theme;
  currentOffset: number;
  debugMode: boolean;
  readerSettings: ReaderSettings;
  driveToken?: string;
  keepAwake: boolean;
  lastSession?: {
    bookId: string;
    chapterId: string;
    offset: number;
  };
}
