

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

export enum AudioStatus {
  NONE = 'none',
  PENDING = 'pending',
  GENERATING = 'generating',
  READY = 'ready',
  FAILED = 'failed'
}

export type UiMode = 'auto' | 'desktop' | 'mobile';

export const CLOUD_VOICES = [
  { id: 'en-US-Standard-C', name: 'Standard Female (US)' },
  { id: 'en-US-Standard-D', name: 'Standard Male (US)' },
  { id: 'en-US-Wavenet-D', name: 'Premium Male (US)' },
  { id: 'en-US-Wavenet-C', name: 'Premium Female (US)' },
  { id: 'en-GB-Wavenet-B', name: 'Premium Male (UK)' },
  { id: 'en-GB-Wavenet-A', name: 'Premium Female (UK)' },
];

export interface PlaybackMetadata {
  currentTime: number;
  duration: number;
  charOffset: number;
  // Added field to support robust text tracking
  textLength?: number;
}

export type PlaybackPhase =
  | 'IDLE'
  | 'LOADING_TEXT'
  | 'READY'
  | 'LOADING_AUDIO'
  | 'SEEKING'
  | 'SCRUBBING'
  | 'PLAYING_INTRO'
  | 'PLAYING_BODY'
  | 'ENDING_SETTLE'
  | 'TRANSITIONING'
  | 'ERROR';

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
  global?: boolean; // If true, applies to all books
  bookIds?: string[]; // If global is false, applies to these books
}

export interface AudioChunkMetadata {
  startChar: number;
  endChar: number;
  durSec: number;
}

export interface Chapter {
  id: string;
  index: number;
  title: string;
  sourceUrl?: string;
  filename: string;
  content?: string;
  wordCount: number;
  progress: number; // progress as ratio 0..1
  progressChars: number; // actual character offset
  progressTotalLength?: number;
  // Canonical progress fields
  progressSec?: number; 
  durationSec?: number;
  textLength?: number;
  
  isFavorite?: boolean;
  isCompleted?: boolean;
  driveId?: string; // Legacy field
  cloudTextFileId?: string; // Google Drive ID for .txt
  cloudAudioFileId?: string; // Google Drive ID for .mp3
  audioDriveId?: string; 
  audioStatus?: AudioStatus;
  audioSignature?: string; 
  audioPrefixLen?: number; 
  audioIntroDurSec?: number; 
  audioChunkMap?: AudioChunkMetadata[]; 
  hasCachedAudio?: boolean;
  hasTextOnDrive?: boolean;
  updatedAt?: number;
}

export interface BookSettings {
  playbackSpeed?: number;
  selectedVoiceName?: string;
  defaultVoiceId?: string; 
  useBookSettings: boolean;
  highlightMode: HighlightMode;
}

export interface ReaderSettings {
  fontFamily: string;
  fontSizePx: number;
  lineHeight: number;
  paragraphSpacing: number;
  reflowLineBreaks: boolean;
  highlightColor: string;
  followHighlight: boolean;
  uiMode: UiMode;
}

export interface Book {
  id: string;
  title: string;
  author?: string;
  coverImage?: string; // Data URL
  chapters: Chapter[];
  chapterCount?: number;
  currentChapterId?: string;
  rules: Rule[];
  directoryHandle?: any;
  driveFolderId?: string;
  driveFolderName?: string;
  backend: StorageBackend;
  settings: BookSettings;
  updatedAt?: number;
}

export interface StrayFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
}

export interface ScanResult {
  missingTextIds: string[];
  missingAudioIds: string[];
  strayFiles: StrayFile[];
  duplicates: { chapterId: string, type: 'audio' | 'text', keepId: string, removeIds: string[] }[];
  totalChecked: number;
  expectedChapters?: number;
  missingTextCount?: number;
  missingAudioCount?: number;
  accountedChaptersCount?: number;
  legacyRecoveryCandidates?: Record<
    string,
    {
      legacyTextCandidate: { id: string; name: string } | null;
      legacyAudioCandidate: { id: string; name: string } | null;
      reasonChosen: "index match" | "title match" | "newest" | null;
    }
  >;
  safeToCleanup?: boolean;
}

export interface SyncDiagnostics {
  lastSyncAttemptAt?: number;
  lastSyncSuccessAt?: number;
  lastSyncError?: string;
  driveRootFolderId?: string;
  resolvedCloudSavesFolderId?: string;
  folderChoiceMethod?: string;
  lastCloudSaveFileName?: string;
  lastCloudSaveModifiedTime?: string;
  lastAutoSaveAttemptAt?: number;
  lastAutoSaveSuccessAt?: number;
  lastAutoSaveError?: string;
  isDirty?: boolean;
  intervalMinutes?: number;
  cloudDirty?: boolean;
  dirtySince?: number;
  lastCloudSaveTrigger?: 'manual' | 'auto';
  lastCloudSaveAt?: number;
}

export interface SavedSnapshot {
  version: "v1";
  savedAt: number;
  state: {
    books: Book[];
    readerSettings: ReaderSettings;
    activeBookId?: string;
    playbackSpeed: number;
    selectedVoiceName?: string;
    theme: Theme;
    progressStore: any;
    driveRootFolderId?: string;
    driveRootFolderName?: string;
    driveSubfolders?: { booksId: string; trashId: string; savesId: string };
    autoSaveInterval?: number;
    globalRules?: Rule[];
    showDiagnostics?: boolean;
  };
}

export interface AppState {
  books: Book[];
  activeBookId?: string;
  playbackSpeed: number;
  selectedVoiceName?: string;
  theme: Theme;
  currentOffsetChars: number;
  debugMode: boolean;
  readerSettings: ReaderSettings;
  driveToken?: string;
  googleClientId?: string;
  keepAwake: boolean;
  lastSavedAt?: number;
  driveRootFolderId?: string;
  driveRootFolderName?: string;
  driveSubfolders?: { booksId: string; trashId: string; savesId: string };
  syncDiagnostics?: SyncDiagnostics;
  autoSaveInterval: number;
  globalRules: Rule[];
  showDiagnostics: boolean;
}
