
export enum CaseMode {
  EXACT = 'EXACT',
  IGNORE = 'IGNORE',
  SMART = 'SMART'
}

export enum Scope {
  PHRASE = 'PHRASE',
  WORD = 'WORD'
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
}

export interface Book {
  id: string;
  title: string;
  author?: string;
  chapters: Chapter[];
  currentChapterId?: string;
  rules: Rule[];
  directoryHandle?: any; // FileSystemDirectoryHandle (if supported)
}

export interface AppState {
  books: Book[];
  activeBookId?: string;
  playbackSpeed: number;
  selectedVoiceName?: string;
}
