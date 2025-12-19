export enum CaseMode {
  EXACT = 'EXACT',
  IGNORE = 'IGNORE',
  SMART = 'SMART'
}

export enum RuleType {
  REPLACE = 'REPLACE',
  DELETE = 'DELETE'
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
  matchCase: boolean;
  matchExpression: boolean;
  ruleType: RuleType;
  wholeWord: boolean;
  scope: Scope;
  priority: number;
  enabled: boolean;
  phoneticHint?: string;
  caseMode?: CaseMode;
}

export interface Chapter {
  id: string;
  index: number;
  title: string;
  sourceUrl?: string;
  filename: string;
  content: string;
  wordCount: number;
  progress: number; 
  progressTotalLength?: number;
  isFavorite?: boolean;
  isCompleted?: boolean;
  driveId?: string;
  hasCachedAudio?: boolean; // New: Tracks if Cloud TTS audio is generated and cached
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
  paragraphSpacing: number;
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
  driveFolderName?: string;
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
  googleClientId?: string;
  keepAwake: boolean;
  lastSession?: {
    bookId: string;
    chapterId: string;
    offset: number;
  };
}