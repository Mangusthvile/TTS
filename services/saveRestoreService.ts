import { Directory, Encoding, Filesystem } from "@capacitor/filesystem";
import { Capacitor } from "@capacitor/core";
import {
  AppState,
  Book,
  BookAttachment,
  BookSettings,
  Chapter,
  ChapterTombstone,
  FullSnapshotV1,
  HighlightMode,
  JobRecord,
  SnapshotPointerV1,
} from "../types";
import { buildFullSnapshotV1, migrateSnapshot } from "./fullSnapshot";
import { applyExternalProgress, bestChapterProgress } from "./progressStore";
import {
  ensureRootStructure,
  fetchDriveFile,
  findFileSync,
  listSaveFileCandidates,
  uploadToDrive,
} from "./driveService";
import {
  deriveDisplayIndices,
  getChapterSortOrder,
  normalizeChapterOrder,
} from "./chapterOrderingService";

const POINTER_FILE_NAME = "talevox-latest.json";
const SNAPSHOT_FILE_PREFIX = "talevox_full_";
const PROGRESS_FILE_NAME = "talevox_progress.json";
const LOCAL_META_KEY = "talevox_full_snapshot_meta_v1";

export type ProgressFilePayload = {
  readerProgress: Record<string, unknown>;
  legacyProgressStore: Record<string, unknown>;
  progressStore?: Record<string, unknown>;
  savedAt: number;
};

/** Normalise progress from file – prefer progressStore, fall back to legacyProgressStore. */
function normaliseProgressFile(parsed: Record<string, unknown>): Record<string, unknown> {
  const ps = isRecord(parsed.progressStore) ? parsed.progressStore : null;
  const leg = isRecord(parsed.legacyProgressStore) ? parsed.legacyProgressStore : null;
  return ps ?? leg ?? {};
}

export async function loadProgressFileFromDrive(
  savesFolderId: string
): Promise<ProgressFilePayload | null> {
  try {
    const fileId = await findFileSync(PROGRESS_FILE_NAME, savesFolderId);
    if (!fileId) return null;
    const raw = await fetchDriveFile(fileId);
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const readerProgress = isRecord(parsed.readerProgress) ? parsed.readerProgress : {};
    const progress = normaliseProgressFile(parsed);
    const legacyProgressStore = progress; // same value for backward compatibility
    const savedAt = asNumber(parsed.savedAt, 0);
    return { readerProgress, legacyProgressStore, progressStore: progress, savedAt };
  } catch {
    return null;
  }
}

export async function saveProgressFileToDrive(
  savesFolderId: string,
  readerProgress: Record<string, unknown>,
  legacyProgressStore: Record<string, unknown>
): Promise<void> {
  // Write both keys so readers expecting either format get data
  const payload: ProgressFilePayload & Record<string, unknown> = {
    readerProgress,
    legacyProgressStore,
    progressStore: legacyProgressStore,
    savedAt: Date.now(),
  };
  const content = JSON.stringify(payload);
  const fileId = await findFileSync(PROGRESS_FILE_NAME, savesFolderId);
  await uploadToDrive(
    savesFolderId,
    PROGRESS_FILE_NAME,
    content,
    fileId || undefined,
    "application/json"
  );
}

type SortableEntity = { id: string; updatedAt?: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function asNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeBookSettings(settings: BookSettings | undefined): BookSettings {
  const volumeOrder = Array.isArray(settings?.volumeOrder)
    ? settings.volumeOrder
        .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        .map((name) => name.trim())
    : [];
  const collapsedVolumes: Record<string, boolean> = {};
  if (settings?.collapsedVolumes && typeof settings.collapsedVolumes === "object") {
    for (const [name, value] of Object.entries(settings.collapsedVolumes)) {
      const trimmed = name.trim();
      if (trimmed && value === true) collapsedVolumes[trimmed] = true;
    }
  }
  return {
    useBookSettings: settings?.useBookSettings ?? false,
    highlightMode: settings?.highlightMode ?? HighlightMode.SENTENCE,
    playbackSpeed: settings?.playbackSpeed,
    selectedVoiceName: settings?.selectedVoiceName,
    defaultVoiceId: settings?.defaultVoiceId,
    chapterLayout: settings?.chapterLayout === "grid" ? "grid" : "sections",
    enableSelectionMode:
      typeof settings?.enableSelectionMode === "boolean" ? settings.enableSelectionMode : true,
    enableOrganizeMode:
      typeof settings?.enableOrganizeMode === "boolean" ? settings.enableOrganizeMode : true,
    allowDragReorderChapters:
      typeof settings?.allowDragReorderChapters === "boolean"
        ? settings.allowDragReorderChapters
        : true,
    allowDragMoveToVolume:
      typeof settings?.allowDragMoveToVolume === "boolean" ? settings.allowDragMoveToVolume : true,
    allowDragReorderVolumes:
      typeof settings?.allowDragReorderVolumes === "boolean"
        ? settings.allowDragReorderVolumes
        : true,
    volumeOrder,
    collapsedVolumes,
    autoGenerateAudioOnAdd:
      typeof settings?.autoGenerateAudioOnAdd === "boolean"
        ? settings.autoGenerateAudioOnAdd
        : true,
    autoUploadOnAdd:
      typeof settings?.autoUploadOnAdd === "boolean" ? settings.autoUploadOnAdd : false,
    confirmBulkDelete:
      typeof settings?.confirmBulkDelete === "boolean" ? settings.confirmBulkDelete : true,
  };
}

function normalizeChapter(chapter: Chapter): Chapter {
  const sortOrder = getChapterSortOrder(chapter);
  return {
    ...chapter,
    sortOrder,
    volumeName:
      typeof chapter.volumeName === "string" && chapter.volumeName.trim().length
        ? chapter.volumeName.trim()
        : undefined,
    volumeLocalChapter:
      typeof chapter.volumeLocalChapter === "number" && chapter.volumeLocalChapter > 0
        ? Math.floor(chapter.volumeLocalChapter)
        : undefined,
    contentFormat: chapter.contentFormat === "markdown" ? "markdown" : "text",
  };
}

function pickNewer<T extends SortableEntity>(localItem: T, incomingItem: T): T {
  const localUpdated = asNumber(localItem.updatedAt, 0);
  const incomingUpdated = asNumber(incomingItem.updatedAt, 0);
  return incomingUpdated >= localUpdated ? incomingItem : localItem;
}

/** Prefer the chapter with completion/progress when merging during restore. Uses bestChapterProgress
 * for canonical rules: completed beats incomplete, newer updatedAt wins, higher percent wins. */
function mergeChapterForRestore(localChapter: Chapter, incomingChapter: Chapter): Chapter {
  const localEntry = toProgressEntry(localChapter);
  const incomingEntry = toProgressEntry(incomingChapter);
  const best = bestChapterProgress(localEntry, incomingEntry);
  if (best === incomingEntry) return incomingChapter;
  if (best === localEntry) return localChapter;
  return pickNewer(localChapter, incomingChapter);
}

function toProgressEntry(ch: Chapter): {
  completed?: boolean;
  updatedAt?: number;
  percent?: number;
} {
  return {
    completed: (ch as any).isCompleted === true,
    updatedAt: typeof (ch as any).updatedAt === "number" ? (ch as any).updatedAt : 0,
    percent: typeof (ch as any).progress === "number" ? (ch as any).progress : 0,
  };
}

function mergeById<T extends SortableEntity>(
  localItems: T[],
  incomingItems: T[],
  mergeMatched?: (localItem: T, incomingItem: T) => T
): T[] {
  const byId = new Map<string, T>();
  for (const item of localItems) byId.set(item.id, item);
  for (const incoming of incomingItems) {
    const existing = byId.get(incoming.id);
    if (!existing) {
      byId.set(incoming.id, incoming);
      continue;
    }
    byId.set(
      incoming.id,
      mergeMatched ? mergeMatched(existing, incoming) : pickNewer(existing, incoming)
    );
  }
  return Array.from(byId.values());
}

function mergeJobs(localJobs: JobRecord[], incomingJobs: JobRecord[]): JobRecord[] {
  const byId = new Map<string, JobRecord>();
  for (const job of localJobs) byId.set(job.jobId, job);
  for (const job of incomingJobs) {
    const existing = byId.get(job.jobId);
    if (!existing) {
      byId.set(job.jobId, job);
      continue;
    }
    const existingUpdated = asNumber(existing.updatedAt, 0);
    const incomingUpdated = asNumber(job.updatedAt, 0);
    if (incomingUpdated >= existingUpdated) {
      byId.set(job.jobId, job);
    }
  }
  return Array.from(byId.values());
}

function mergeBook(localBook: Book, incomingBook: Book): Book {
  const mergedBase = pickNewer(localBook, incomingBook);
  const mergedChapters = deriveDisplayIndices(
    normalizeChapterOrder(
      mergeById(
        (localBook.chapters || []).map((chapter) => normalizeChapter(chapter)),
        (incomingBook.chapters || []).map((chapter) => normalizeChapter(chapter)),
        mergeChapterForRestore
      )
    )
  );

  return {
    ...mergedBase,
    settings: normalizeBookSettings({
      ...localBook.settings,
      ...incomingBook.settings,
    }),
    rules: Array.isArray(mergedBase.rules) ? mergedBase.rules : [],
    chapters: mergedChapters,
    chapterCount: mergedChapters.length,
    currentChapterId:
      incomingBook.currentChapterId || localBook.currentChapterId || mergedBase.currentChapterId,
    updatedAt: Math.max(
      asNumber(localBook.updatedAt, 0),
      asNumber(incomingBook.updatedAt, 0),
      Date.now()
    ),
  };
}

function flattenChapters(books: Book[]): Chapter[] {
  return books.flatMap((book) => (book.chapters || []).map((chapter) => normalizeChapter(chapter)));
}

export type BuildFullSnapshotArgs = {
  state: AppState;
  preferences: Record<string, unknown>;
  readerProgress: Record<string, unknown>;
  legacyProgressStore?: Record<string, unknown>;
  chapterTombstones?: ChapterTombstone[];
  attachments?: BookAttachment[];
  jobs?: JobRecord[];
  activeChapterId?: string;
  activeTab?: "library" | "collection" | "reader" | "rules" | "settings";
};

export function buildFullSnapshot(input: BuildFullSnapshotArgs): FullSnapshotV1 {
  return buildFullSnapshotV1(input);
}

export type ApplySnapshotInput = {
  snapshot: FullSnapshotV1;
  currentState: AppState;
  currentAttachments?: BookAttachment[];
  currentJobs?: JobRecord[];
};

export type ApplySnapshotResult = {
  state: AppState;
  attachments: BookAttachment[];
  jobs: JobRecord[];
};

export function applyFullSnapshot(input: ApplySnapshotInput): ApplySnapshotResult {
  const { snapshot, currentState, currentAttachments = [], currentJobs = [] } = input;
  const incoming = migrateSnapshot(snapshot) ?? snapshot;

  const mergedBooks = mergeById(
    (currentState.books || []).map((book) => ({
      ...book,
      settings: normalizeBookSettings(book.settings),
      chapters: (book.chapters || []).map((chapter) => normalizeChapter(chapter)),
    })),
    (incoming.books || []).map((book) => ({
      ...book,
      settings: normalizeBookSettings(book.settings),
      chapters: (book.chapters || []).map((chapter) => normalizeChapter(chapter)),
    })),
    mergeBook
  ).sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0));

  const incomingAttachments = (Array.isArray(incoming.attachments) ? incoming.attachments : [])
    .filter(
      (a): a is BookAttachment =>
        isRecord(a) && typeof a.id === "string" && typeof a.bookId === "string"
    )
    .map((a) => {
      const { chapterId: _c, ...rest } = a as BookAttachment & { chapterId?: unknown };
      return { ...rest, bookId: a.bookId } as BookAttachment;
    });
  const mergedAttachments = mergeById(currentAttachments, incomingAttachments);
  const mergedJobs = mergeJobs(currentJobs, Array.isArray(incoming.jobs) ? incoming.jobs : []);

  const pref = isRecord(incoming.preferences) ? incoming.preferences : {};
  const mergedState: AppState = {
    ...currentState,
    books: mergedBooks,
    activeBookId:
      typeof pref.activeBookId === "string" && pref.activeBookId.length
        ? pref.activeBookId
        : currentState.activeBookId,
    playbackSpeed:
      typeof pref.playbackSpeed === "number" ? pref.playbackSpeed : currentState.playbackSpeed,
    selectedVoiceName:
      typeof pref.selectedVoiceName === "string"
        ? pref.selectedVoiceName
        : currentState.selectedVoiceName,
    theme: (pref.theme as any) || currentState.theme,
    readerSettings: {
      ...currentState.readerSettings,
      ...(isRecord(pref.readerSettings) ? pref.readerSettings : {}),
    },
    driveRootFolderId:
      typeof pref.driveRootFolderId === "string"
        ? pref.driveRootFolderId
        : currentState.driveRootFolderId,
    driveRootFolderName:
      typeof pref.driveRootFolderName === "string"
        ? pref.driveRootFolderName
        : currentState.driveRootFolderName,
    driveSubfolders:
      isRecord(pref.driveSubfolders) && typeof pref.driveSubfolders.booksId === "string"
        ? (pref.driveSubfolders as any)
        : currentState.driveSubfolders,
    autoSaveInterval:
      typeof pref.autoSaveInterval === "number"
        ? pref.autoSaveInterval
        : currentState.autoSaveInterval,
    globalRules:
      Array.isArray(incoming.globalRules) && incoming.globalRules.length
        ? incoming.globalRules
        : currentState.globalRules,
    showDiagnostics:
      typeof pref.showDiagnostics === "boolean"
        ? pref.showDiagnostics
        : currentState.showDiagnostics,
    lastSavedAt: Date.now(),
  };

  for (const book of mergedState.books) {
    book.settings = normalizeBookSettings(book.settings);
    book.chapters = deriveDisplayIndices(
      normalizeChapterOrder((book.chapters || []).map((chapter) => normalizeChapter(chapter)))
    );
    book.chapterCount = book.chapters.length;
  }

  // Write snapshot progress into progressStore (SQLite + localStorage) so it survives restart
  const progressPayload = normaliseSnapshotProgress(incoming);
  if (progressPayload) applyExternalProgress(progressPayload);

  return { state: mergedState, attachments: mergedAttachments, jobs: mergedJobs };
}

/** Normalise progress from snapshot – prefer progressStore, fall back to legacyProgressStore. */
function normaliseSnapshotProgress(
  snapshot: FullSnapshotV1 & { progressStore?: unknown }
): Record<string, unknown> | null {
  const ps = isRecord(snapshot.progressStore) ? snapshot.progressStore : null;
  const leg = isRecord((snapshot as any).legacyProgressStore)
    ? (snapshot as any).legacyProgressStore
    : null;
  return ps ?? leg ?? null;
}

export async function saveToLocalFile(
  snapshot: FullSnapshotV1
): Promise<{ fileName: string; path?: string }> {
  const fileName = `${SNAPSHOT_FILE_PREFIX}${snapshot.createdAt}.json`;
  const content = JSON.stringify(snapshot, null, 2);
  if (Capacitor.isNativePlatform()) {
    const folder = "snapshots";
    try {
      await Filesystem.mkdir({ path: folder, directory: Directory.Data, recursive: true });
    } catch {}
    const path = `${folder}/${fileName}`;
    await Filesystem.writeFile({
      path,
      directory: Directory.Data,
      data: content,
      encoding: Encoding.UTF8,
      recursive: true,
    });
    return { fileName, path };
  }

  const blob = new Blob([content], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
  return { fileName };
}

export type SaveToDriveArgs = {
  rootFolderId: string;
  snapshot: FullSnapshotV1;
  savesFolderId?: string;
};

export async function saveToDrive(input: SaveToDriveArgs): Promise<{
  savesFolderId: string;
  fileName: string;
  pointer: SnapshotPointerV1;
  driveSubfolders?: { booksId: string; trashId: string; savesId: string };
}> {
  const { rootFolderId, snapshot } = input;
  const resolvedSubfolders = input.savesFolderId ? null : await ensureRootStructure(rootFolderId);
  const savesId = input.savesFolderId || resolvedSubfolders?.savesId;
  if (!savesId) {
    throw new Error("No Drive saves folder available.");
  }
  const fileName = `${SNAPSHOT_FILE_PREFIX}${snapshot.createdAt}.json`;
  const content = JSON.stringify(snapshot);

  await uploadToDrive(savesId, fileName, content, undefined, "application/json");

  const pointer: SnapshotPointerV1 = {
    schemaVersion: 1,
    latestFileName: fileName,
    latestCreatedAt: snapshot.createdAt,
  };
  const pointerContent = JSON.stringify(pointer);
  const pointerFileId = await findFileSync(POINTER_FILE_NAME, savesId);
  await uploadToDrive(
    savesId,
    POINTER_FILE_NAME,
    pointerContent,
    pointerFileId || undefined,
    "application/json"
  );

  writeLocalSnapshotMeta(snapshot.createdAt);
  return {
    savesFolderId: savesId,
    fileName,
    pointer,
    driveSubfolders: resolvedSubfolders ?? undefined,
  };
}

function parsePointer(raw: string): SnapshotPointerV1 | null {
  try {
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      parsed.schemaVersion === 1 &&
      typeof parsed.latestFileName === "string" &&
      typeof parsed.latestCreatedAt === "number"
    ) {
      return parsed as SnapshotPointerV1;
    }
  } catch {}
  return null;
}

async function loadLatestSnapshotFromDrive(savesFolderId: string): Promise<FullSnapshotV1 | null> {
  const pointerFileId = await findFileSync(POINTER_FILE_NAME, savesFolderId);
  if (pointerFileId) {
    const pointerRaw = await fetchDriveFile(pointerFileId);
    const pointer = parsePointer(pointerRaw);
    if (pointer) {
      const latestId = await findFileSync(pointer.latestFileName, savesFolderId);
      if (latestId) {
        const raw = await fetchDriveFile(latestId);
        const migrated = migrateSnapshot(JSON.parse(raw));
        if (migrated) return migrated;
      }
    } else {
      // Legacy pointer may contain the snapshot directly.
      try {
        const parsed = JSON.parse(pointerRaw);
        const migrated = migrateSnapshot(parsed);
        if (migrated) return migrated;
      } catch {}
    }
  }

  const candidates = await listSaveFileCandidates(savesFolderId);
  for (const candidate of candidates) {
    const name = String(candidate.name || "");
    if (!name.endsWith(".json")) continue;
    const id = await findFileSync(name, savesFolderId);
    if (!id) continue;
    try {
      const raw = await fetchDriveFile(id);
      const parsed = JSON.parse(raw);
      const migrated = migrateSnapshot(parsed);
      if (migrated) return migrated;
    } catch {
      // continue to older candidate
    }
  }
  return null;
}

export type RestoreFromDriveArgs = {
  rootFolderId: string;
  lastSnapshotCreatedAt?: number;
};

export type RestoreFromDriveResult =
  | { restored: false; reason: "missing" | "not_newer" | "invalid" }
  | { restored: true; snapshot: FullSnapshotV1; savesFolderId: string };

export async function restoreFromDriveIfAvailable(
  input: RestoreFromDriveArgs
): Promise<RestoreFromDriveResult> {
  const { rootFolderId, lastSnapshotCreatedAt = 0 } = input;
  const subfolders = await ensureRootStructure(rootFolderId);
  const snapshot = await loadLatestSnapshotFromDrive(subfolders.savesId);
  if (!snapshot) return { restored: false, reason: "missing" };

  const createdAt = asNumber(snapshot.createdAt, 0);
  if (!createdAt) return { restored: false, reason: "invalid" };
  if (createdAt <= lastSnapshotCreatedAt) return { restored: false, reason: "not_newer" };

  writeLocalSnapshotMeta(createdAt);
  return { restored: true, snapshot, savesFolderId: subfolders.savesId };
}

export function readLocalSnapshotMeta(): { lastSnapshotCreatedAt: number } {
  if (typeof window === "undefined") return { lastSnapshotCreatedAt: 0 };
  try {
    const raw = localStorage.getItem(LOCAL_META_KEY);
    if (!raw) return { lastSnapshotCreatedAt: 0 };
    const parsed = JSON.parse(raw);
    const lastSnapshotCreatedAt = asNumber(parsed?.lastSnapshotCreatedAt, 0);
    return { lastSnapshotCreatedAt };
  } catch {
    return { lastSnapshotCreatedAt: 0 };
  }
}

export function writeLocalSnapshotMeta(lastSnapshotCreatedAt: number): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(
      LOCAL_META_KEY,
      JSON.stringify({ lastSnapshotCreatedAt: asNumber(lastSnapshotCreatedAt, 0) })
    );
  } catch {}
}

export function getSnapshotPointerFileName(): string {
  return POINTER_FILE_NAME;
}

export function flattenSnapshotChapters(books: Book[]): Chapter[] {
  return flattenChapters(books);
}
