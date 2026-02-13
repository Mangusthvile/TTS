

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

export type JobType = "generateAudio" | "fixIntegrity" | "uploadQueue" | "drive_upload_queue";

export type JobStatus =
  | "queued"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "canceled";

export type JobProgress = {
  total: number;
  completed: number;
  currentChapterId?: string;
  currentChunkIndex?: number;
  currentChunkTotal?: number;
  currentChapterProgress?: number;
  startedAt?: number;
  finishedAt?: number;
  workRequestId?: string;
  lastError?: string;
  lastMessage?: string;
};

export type JobRecord = {
  jobId: string;
  type: JobType;
  status: JobStatus;
  payloadJson: any;
  progressJson?: JobProgress;
  error?: string;
  createdAt: number;
  updatedAt: number;
};

export type UiMode = 'auto' | 'desktop' | 'mobile';

export const CLOUD_VOICES = [
  { id: 'en-US-Standard-C', name: 'Standard Female (US)' },
  { id: 'en-US-Standard-D', name: 'Standard Male (US)' },
  { id: 'en-US-Wavenet-D', name: 'Premium Male (US)' },
  { id: 'en-US-Wavenet-C', name: 'Premium Female (US)' },
  { id: 'en-GB-Wavenet-B', name: 'Premium Male (UK)' },
  { id: 'en-GB-Wavenet-A', name: 'Premium Female (UK)' },
  { id: 'openai:cedar', name: 'OpenAI Cedar' },
  { id: 'openai:marin', name: 'OpenAI Marin' },
  { id: 'openai:alloy', name: 'OpenAI Alloy' },
  { id: 'openai:echo', name: 'OpenAI Echo' },
  { id: 'openai:fable', name: 'OpenAI Fable' },
  { id: 'openai:nova', name: 'OpenAI Nova' },
  { id: 'openai:onyx', name: 'OpenAI Onyx' },
  { id: 'openai:shimmer', name: 'OpenAI Shimmer' },
  { id: 'openai:ash', name: 'OpenAI Ash' },
  { id: 'openai:coral', name: 'OpenAI Coral' },
  { id: 'openai:sage', name: 'OpenAI Sage' },
  { id: 'openai:ballad', name: 'OpenAI Ballad' },
];

export interface PlaybackMetadata {
  currentTime: number;
  duration: number;
  charOffset: number;
  // Added field to support robust text tracking
  textLength?: number;
  chapterId?: string | null;
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

export type Cue = { tMs: number; startChar: number; endChar: number };

export type CueMap = {
  chapterId: string;
  cues: Cue[];
  version: number;
  generatedAt: number;
  method: "chunkmap" | "timepoints" | "fallback";
  introOffsetMs?: number;
  durationMs?: number;
};

export type ParagraphRange = { pIndex: number; startChar: number; endChar: number };

export type ParagraphMap = {
  chapterId: string;
  version: number;
  generatedAt: number;
  paragraphs: ParagraphRange[];
};

export interface Chapter {
  id: string;
  index: number;
  sortOrder?: number;
  title: string;
  sourceUrl?: string;
  filename: string;
  content?: string;
  contentFormat?: "text" | "markdown";
  // Optional grouping inside a book (e.g. "Book 1", "Book 2"). `index` stays globally increasing.
  volumeName?: string;
  volumeLocalChapter?: number;
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
  chapterLayout?: "sections" | "grid";
  enableSelectionMode?: boolean;
  enableOrganizeMode?: boolean;
  allowDragReorderChapters?: boolean;
  allowDragMoveToVolume?: boolean;
  allowDragReorderVolumes?: boolean;
  volumeOrder?: string[];
  collapsedVolumes?: Record<string, boolean>;
  autoGenerateAudioOnAdd?: boolean;
  autoUploadOnAdd?: boolean;
  confirmBulkDelete?: boolean;
}

export type BookAttachment = {
  id: string;
  bookId: string;
  driveFileId?: string;
  filename: string;
  mimeType?: string;
  sizeBytes?: number;
  localPath?: string;
  sha256?: string;
  createdAt: number;
  updatedAt: number;
};

export type ChapterTombstone = {
  bookId: string;
  chapterId: string;
  deletedAt: number;
};

export interface ReaderSettings {
  fontFamily: string;
  fontSizePx: number;
  lineHeight: number;
  paragraphSpacing: number;
  reflowLineBreaks: boolean;
  highlightColor: string;
  followHighlight: boolean;
  highlightEnabled?: boolean;
  highlightMode?: HighlightMode;
  highlightUpdateRateMs?: number;
  highlightDebugOverlay?: boolean;
  speakChapterIntro?: boolean;
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

export interface SnapshotPointerV1 {
  schemaVersion: 1;
  latestFileName: string;
  latestCreatedAt: number;
}

export const BACKUP_SCHEMA_VERSION = 1 as const;

export type BackupTarget = "drive" | "localFolder" | "download";

export type BackupOptions = {
  includeAudio: boolean;
  includeDiagnostics: boolean;
  includeAttachments: boolean;
  includeChapterText: boolean;
  includeOAuthTokens?: boolean;
};

export type BackupProgressStep =
  | "collecting_state"
  | "exporting_sqlite"
  | "collecting_files"
  | "zipping"
  | "saving_drive"
  | "saving_local"
  | "downloading"
  | "restoring_db"
  | "restoring_prefs"
  | "restoring_files"
  | "finalizing";

export type BackupProgress = {
  step: BackupProgressStep;
  message: string;
  current?: number;
  total?: number;
};

export interface BackupMetaV1 {
  backupSchemaVersion: typeof BACKUP_SCHEMA_VERSION;
  appVersion: string;
  createdAt: number;
  platform: "web" | "android" | "ios";
  notes: string;
  warnings: string[];
  options: BackupOptions;
}

export interface BackupSchedulerSettings {
  autoBackupToDrive: boolean;
  autoBackupToDevice: boolean;
  backupIntervalMin: 5 | 15 | 30 | 60;
  keepDriveBackups: number;
  keepLocalBackups: number;
}

export interface FullSnapshotV1 {
  schemaVersion: 1;
  createdAt: number;
  appVersion: string;
  preferences: Record<string, unknown>;
  readerProgress: Record<string, unknown>;
  legacyProgressStore?: Record<string, unknown>;
  globalRules: Rule[];
  books: Book[];
  chapters: Chapter[];
  attachments: BookAttachment[];
  jobs: JobRecord[];
  uiState?: {
    activeBookId?: string;
    activeChapterId?: string;
    activeTab?: "library" | "collection" | "reader" | "rules" | "settings";
    lastOpenBookId?: string;
    lastOpenChapterId?: string;
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
  backupSettings: BackupSchedulerSettings;
  backupInProgress?: boolean;
  lastBackupAt?: number;
  lastBackupLocation?: string;
  lastBackupError?: string;
}
