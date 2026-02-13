import {
  AppState,
  Book,
  BookAttachment,
  BookSettings,
  Chapter,
  FullSnapshotV1,
  HighlightMode,
  JobRecord,
  Rule,
  SavedSnapshot,
} from "../types";
import {
  deriveDisplayIndices,
  getChapterSortOrder,
  normalizeChapterOrder,
} from "./chapterOrderingService";

const DEFAULT_BOOK_SETTINGS: BookSettings = {
  useBookSettings: false,
  highlightMode: HighlightMode.SENTENCE,
  chapterLayout: "sections",
  enableSelectionMode: true,
  enableOrganizeMode: true,
  allowDragReorderChapters: true,
  allowDragMoveToVolume: true,
  allowDragReorderVolumes: true,
  volumeOrder: [],
  collapsedVolumes: {},
  autoGenerateAudioOnAdd: true,
  autoUploadOnAdd: false,
  confirmBulkDelete: true,
};

const APP_VERSION_FALLBACK =
  typeof window !== "undefined" && typeof window.__APP_VERSION__ === "string"
    ? window.__APP_VERSION__
    : "unknown";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function asNumber(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeVolumeName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeVolumeLocalChapter(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

function normalizeBookSettings(value: unknown): BookSettings {
  const raw = isRecord(value) ? value : {};
  const rawVolumeOrder = Array.isArray(raw.volumeOrder) ? raw.volumeOrder : [];
  const volumeOrder = rawVolumeOrder
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((name) => name.trim());
  const collapsedVolumesRaw = isRecord(raw.collapsedVolumes) ? raw.collapsedVolumes : {};
  const collapsedVolumes: Record<string, boolean> = {};
  for (const [key, val] of Object.entries(collapsedVolumesRaw)) {
    const trimmed = key.trim();
    if (!trimmed) continue;
    if (val === true) collapsedVolumes[trimmed] = true;
  }
  return {
    ...DEFAULT_BOOK_SETTINGS,
    ...raw,
    chapterLayout: raw.chapterLayout === "grid" ? "grid" : "sections",
    enableSelectionMode:
      typeof raw.enableSelectionMode === "boolean" ? raw.enableSelectionMode : true,
    enableOrganizeMode:
      typeof raw.enableOrganizeMode === "boolean" ? raw.enableOrganizeMode : true,
    allowDragReorderChapters:
      typeof raw.allowDragReorderChapters === "boolean" ? raw.allowDragReorderChapters : true,
    allowDragMoveToVolume:
      typeof raw.allowDragMoveToVolume === "boolean" ? raw.allowDragMoveToVolume : true,
    allowDragReorderVolumes:
      typeof raw.allowDragReorderVolumes === "boolean" ? raw.allowDragReorderVolumes : true,
    volumeOrder,
    collapsedVolumes,
    autoGenerateAudioOnAdd:
      typeof raw.autoGenerateAudioOnAdd === "boolean" ? raw.autoGenerateAudioOnAdd : true,
    autoUploadOnAdd: typeof raw.autoUploadOnAdd === "boolean" ? raw.autoUploadOnAdd : false,
    confirmBulkDelete: typeof raw.confirmBulkDelete === "boolean" ? raw.confirmBulkDelete : true,
  };
}

function normalizeChapter(chapter: Chapter): Chapter {
  const sortOrder = getChapterSortOrder(chapter);
  return {
    ...chapter,
    sortOrder,
    volumeName: normalizeVolumeName((chapter as any).volumeName),
    volumeLocalChapter: normalizeVolumeLocalChapter((chapter as any).volumeLocalChapter),
    contentFormat: chapter.contentFormat === "markdown" ? "markdown" : "text",
  };
}

function normalizeBook(book: Book): Book {
  const chapters = deriveDisplayIndices(
    normalizeChapterOrder(
      Array.isArray(book.chapters) ? book.chapters.map((c) => normalizeChapter(c)) : []
    )
  );
  return {
    ...book,
    settings: normalizeBookSettings(book.settings),
    chapters,
  };
}

function dedupeByKey<T>(items: T[], getKey: (item: T) => string): T[] {
  const byId = new Map<string, T>();
  for (const item of items) {
    const key = getKey(item);
    const existing = byId.get(key);
    if (!existing) {
      byId.set(key, item);
      continue;
    }
    const existingUpdated = asNumber((existing as any).updatedAt, 0);
    const incomingUpdated = asNumber((item as any).updatedAt, 0);
    if (incomingUpdated >= existingUpdated) {
      byId.set(key, item);
    }
  }
  return Array.from(byId.values());
}

function dedupeById<T extends { id: string }>(items: T[]): T[] {
  return dedupeByKey(items, (item) => item.id);
}

function normalizeSnapshot(snapshot: FullSnapshotV1): FullSnapshotV1 {
  const books = dedupeById((snapshot.books || []).map((book) => normalizeBook(book)));
  const inferredChapters = books.flatMap((book) => book.chapters || []);
  const topLevelChapters = Array.isArray(snapshot.chapters) ? snapshot.chapters : [];
  const chapters = dedupeById(
    (topLevelChapters.length ? topLevelChapters : inferredChapters).map((chapter) =>
      normalizeChapter(chapter)
    )
  );
  const orderedChapters = deriveDisplayIndices(normalizeChapterOrder(chapters));

  const attachments = dedupeById(
    Array.isArray(snapshot.attachments) ? snapshot.attachments : []
  ) as BookAttachment[];
  const jobs = dedupeByKey(
    Array.isArray(snapshot.jobs) ? snapshot.jobs : [],
    (job) => String(job.jobId)
  ) as JobRecord[];

  return {
    ...snapshot,
    schemaVersion: 1,
    appVersion: snapshot.appVersion || APP_VERSION_FALLBACK,
    createdAt: asNumber(snapshot.createdAt, Date.now()),
    books,
    chapters: orderedChapters,
    attachments,
    jobs,
    globalRules: Array.isArray(snapshot.globalRules) ? (snapshot.globalRules as Rule[]) : [],
    preferences: isRecord(snapshot.preferences) ? snapshot.preferences : {},
    readerProgress: isRecord(snapshot.readerProgress) ? snapshot.readerProgress : {},
    legacyProgressStore: isRecord(snapshot.legacyProgressStore)
      ? snapshot.legacyProgressStore
      : undefined,
  };
}

function fromLegacySavedSnapshot(legacy: SavedSnapshot): FullSnapshotV1 {
  const books = Array.isArray(legacy.state?.books) ? legacy.state.books.map(normalizeBook) : [];
  const chapters = books.flatMap((book) => book.chapters || []);

  const preferences: Record<string, unknown> = {
    activeBookId: legacy.state?.activeBookId,
    playbackSpeed: legacy.state?.playbackSpeed,
    selectedVoiceName: legacy.state?.selectedVoiceName,
    theme: legacy.state?.theme,
    readerSettings: legacy.state?.readerSettings,
    driveRootFolderId: legacy.state?.driveRootFolderId,
    driveRootFolderName: legacy.state?.driveRootFolderName,
    driveSubfolders: legacy.state?.driveSubfolders,
    autoSaveInterval: legacy.state?.autoSaveInterval,
    showDiagnostics: legacy.state?.showDiagnostics,
  };

  return normalizeSnapshot({
    schemaVersion: 1,
    createdAt: asNumber((legacy as any).savedAt, Date.now()),
    appVersion: APP_VERSION_FALLBACK,
    preferences,
    readerProgress: {},
    legacyProgressStore: isRecord(legacy.state?.progressStore)
      ? (legacy.state?.progressStore as Record<string, unknown>)
      : {},
    globalRules: Array.isArray(legacy.state?.globalRules) ? legacy.state.globalRules : [],
    books,
    chapters,
    attachments: [],
    jobs: [],
    uiState: {
      activeBookId: legacy.state?.activeBookId,
      activeTab: "library",
    },
  });
}

function fromUnknownLegacy(input: Record<string, unknown>): FullSnapshotV1 | null {
  const stateCandidate = isRecord(input.state) ? input.state : input;
  const booksRaw = (stateCandidate.books ?? input.books) as unknown;
  if (!Array.isArray(booksRaw)) return null;

  const books = booksRaw
    .filter((item): item is Book => isRecord(item) && typeof item.id === "string")
    .map((book) => normalizeBook(book));
  const chapters = books.flatMap((book) => book.chapters || []);
  const globalRules = Array.isArray(stateCandidate.globalRules)
    ? (stateCandidate.globalRules as Rule[])
    : [];

  const createdAt = asNumber(
    input.createdAt ?? stateCandidate.lastSavedAt ?? stateCandidate.savedAt,
    Date.now()
  );

  return normalizeSnapshot({
    schemaVersion: 1,
    createdAt,
    appVersion: APP_VERSION_FALLBACK,
    preferences: {
      ...stateCandidate,
    },
    readerProgress: {},
    legacyProgressStore: {},
    globalRules,
    books,
    chapters,
    attachments: [],
    jobs: [],
    uiState: {
      activeBookId:
        typeof stateCandidate.activeBookId === "string" ? stateCandidate.activeBookId : undefined,
    },
  });
}

export function migrateSnapshot(input: unknown): FullSnapshotV1 | null {
  if (!isRecord(input)) return null;

  if (input.schemaVersion === 1 && Array.isArray(input.books)) {
    return normalizeSnapshot(input as unknown as FullSnapshotV1);
  }

  if (input.version === "v1" && isRecord(input.state)) {
    return fromLegacySavedSnapshot(input as unknown as SavedSnapshot);
  }

  return fromUnknownLegacy(input);
}

export type BuildFullSnapshotInput = {
  state: AppState;
  preferences: Record<string, unknown>;
  readerProgress: Record<string, unknown>;
  legacyProgressStore?: Record<string, unknown>;
  attachments?: BookAttachment[];
  jobs?: JobRecord[];
  activeChapterId?: string;
  activeTab?: "library" | "collection" | "reader" | "rules" | "settings";
};

export function buildFullSnapshotV1(input: BuildFullSnapshotInput): FullSnapshotV1 {
  const books = dedupeById((input.state.books || []).map((book) => normalizeBook(book)));
  const chapters = deriveDisplayIndices(
    normalizeChapterOrder(dedupeById(books.flatMap((book) => book.chapters || [])))
  );

  return normalizeSnapshot({
    schemaVersion: 1,
    createdAt: Date.now(),
    appVersion: APP_VERSION_FALLBACK,
    preferences: input.preferences || {},
    readerProgress: input.readerProgress || {},
    legacyProgressStore: input.legacyProgressStore || {},
    globalRules: Array.isArray(input.state.globalRules) ? input.state.globalRules : [],
    books,
    chapters,
    attachments: input.attachments || [],
    jobs: input.jobs || [],
    uiState: {
      activeBookId: input.state.activeBookId,
      activeChapterId: input.activeChapterId,
      activeTab: input.activeTab,
      lastOpenBookId: input.state.activeBookId,
      lastOpenChapterId: input.activeChapterId,
    },
  });
}
