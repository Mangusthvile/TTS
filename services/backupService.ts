import JSZip from "jszip";
import { Capacitor } from "@capacitor/core";
import { Directory, Filesystem } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";
import {
  AppState,
  BACKUP_SCHEMA_VERSION,
  BackupMetaV1,
  BackupOptions,
  BackupProgress,
  BackupProgressStep,
  BackupSchedulerSettings,
  BackupTarget,
  BookAttachment,
  FullSnapshotV1,
  JobRecord,
} from "../types";
import { appConfig } from "../src/config/appConfig";
import { buildFullSnapshot } from "./saveRestoreService";
import {
  deleteDriveFile,
  ensureRootStructure,
  fetchDriveBinary,
  findFileSync,
  listFilesInFolder,
  uploadToDrive,
} from "./driveService";
import {
  exportSqliteJson,
  importSqliteJson,
  isSqliteJsonValid,
} from "./sqliteConnectionManager";
import { migrateBackupToLatest } from "./backupMigrations";
import {
  bulkUpsertBookAttachments as libraryBulkUpsertBookAttachments,
  bulkUpsertChapters as libraryBulkUpsertChapters,
  upsertBook as libraryUpsertBook,
} from "./libraryStore";
import { getStorage, initStorage } from "./storageSingleton";

const BACKUP_POINTER_FILE = "talevox-latest-backup.json";
const BACKUP_FOLDER = "talevox/backups";
const SAFE_PREF_KEYS = [
  "talevox_prefs_v3",
  "talevox_reader_progress",
  "talevox_progress_store",
  "talevox_nav_context_v1",
  "talevox_ui_mode",
  "talevox_sync_diag",
  "talevox_launch_sync_v1",
  "talevox_last_fatal_error",
  "talevox_full_snapshot_meta_v1",
  "talevox_saved_snapshot_v1",
  "talevox_backup_settings_v1",
];
const OAUTH_PREF_KEYS = ["talevox_drive_token_v2", "talevox_drive_session_v3"];

type BackupFileManifestItem = {
  path: string;
  bytes: number;
  skippedReason?: string;
};

type StorageDriverBackupState = {
  jobs: JobRecord[];
  queuedUploads: unknown[];
  chapterAudioPaths: Array<{ chapterId: string; localPath: string; sizeBytes: number; updatedAt: number }>;
};

type BackupContext = {
  state: AppState;
  attachments?: BookAttachment[];
  jobs?: JobRecord[];
  activeChapterId?: string;
  activeTab?: "library" | "collection" | "reader" | "rules" | "settings";
  preferences?: Record<string, unknown>;
  readerProgress?: Record<string, unknown>;
  legacyProgressStore?: Record<string, unknown>;
};

type SaveBackupConfig = {
  rootFolderId?: string;
  keepDriveBackups?: number;
  keepLocalBackups?: number;
  nativeMode?: "prompt" | "internalOnly";
};

export type DriveBackupCandidate = {
  id: string;
  name: string;
  modifiedTime: string;
  size?: number;
};

export const DEFAULT_BACKUP_OPTIONS: BackupOptions = {
  includeAudio: true,
  includeDiagnostics: true,
  includeAttachments: true,
  includeChapterText: true,
  includeOAuthTokens: false,
};

export const DEFAULT_BACKUP_SETTINGS: BackupSchedulerSettings = {
  autoBackupToDrive: false,
  autoBackupToDevice: false,
  backupIntervalMin: 30,
  keepDriveBackups: 10,
  keepLocalBackups: 10,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function asNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function isNative(): boolean {
  return Capacitor.isNativePlatform();
}

function normalizeOptions(options: BackupOptions): BackupOptions {
  return {
    includeAudio: options.includeAudio !== false,
    includeDiagnostics: options.includeDiagnostics !== false,
    includeAttachments: options.includeAttachments !== false,
    includeChapterText: options.includeChapterText !== false,
    includeOAuthTokens: options.includeOAuthTokens === true,
  };
}

function getPlatform(): "web" | "android" | "ios" {
  const platform = Capacitor.getPlatform?.() || "web";
  if (platform === "android" || platform === "ios") return platform;
  return "web";
}

function emitProgress(
  onProgress: ((progress: BackupProgress) => void) | undefined,
  step: BackupProgressStep,
  message: string,
  current?: number,
  total?: number
): void {
  if (!onProgress) return;
  onProgress({ step, message, current, total });
}

function formatBackupFileName(createdAt: number): string {
  const date = new Date(createdAt);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `talevox-backup-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate()
  )}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}.zip`;
}

function toSafeJsonString(input: unknown): string {
  try {
    return JSON.stringify(input ?? {}, null, 2);
  } catch {
    return "{}";
  }
}

async function blobToUint8Array(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

async function blobToBase64(blob: Blob): Promise<string> {
  return uint8ToBase64(await blobToUint8Array(blob));
}

function readStoredPrefs(includeOAuthTokens: boolean): Record<string, string> {
  if (typeof window === "undefined") return {};
  const out: Record<string, string> = {};
  const safeSet = new Set(SAFE_PREF_KEYS);
  const includeSet = includeOAuthTokens ? new Set(OAUTH_PREF_KEYS) : new Set<string>();

  for (const key of safeSet) {
    const value = localStorage.getItem(key);
    if (value != null) out[key] = value;
  }

  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (!key) continue;
    if (key.startsWith("talevox:viewMode:")) {
      const value = localStorage.getItem(key);
      if (value != null) out[key] = value;
    }
  }

  for (const key of includeSet) {
    const value = localStorage.getItem(key);
    if (value != null) out[key] = value;
  }

  return out;
}

async function collectStorageDriverState(
  state: AppState,
  warnings: string[]
): Promise<StorageDriverBackupState> {
  try {
    await initStorage();
    const storage = getStorage();
    const jobsRes = await storage.listJobs();
    const queuedRes = await storage.listQueuedUploads(10000);
    const chapterAudioPaths: StorageDriverBackupState["chapterAudioPaths"] = [];
    for (const book of state.books || []) {
      for (const chapter of book.chapters || []) {
        const audioRes = await storage.getChapterAudioPath(chapter.id);
        if (audioRes.ok && audioRes.value) {
          chapterAudioPaths.push({
            chapterId: chapter.id,
            localPath: audioRes.value.localPath,
            sizeBytes: audioRes.value.sizeBytes,
            updatedAt: audioRes.value.updatedAt,
          });
        }
      }
    }
    return {
      jobs: jobsRes.ok && Array.isArray(jobsRes.value) ? jobsRes.value : [],
      queuedUploads: queuedRes.ok && Array.isArray(queuedRes.value) ? queuedRes.value : [],
      chapterAudioPaths,
    };
  } catch (error: any) {
    warnings.push(`storage-driver-export-failed:${String(error?.message ?? error)}`);
    return { jobs: [], queuedUploads: [], chapterAudioPaths: [] };
  }
}

async function getReadDirEntries(path: string): Promise<Array<{ name: string; isDirectory: boolean }>> {
  const out: Array<{ name: string; isDirectory: boolean }> = [];
  const res = await Filesystem.readdir({ path, directory: Directory.Data });
  const files = Array.isArray((res as any).files) ? (res as any).files : [];
  for (const entry of files) {
    if (typeof entry === "string") {
      const fullPath = `${path}/${entry}`;
      try {
        const stat = await Filesystem.stat({ path: fullPath, directory: Directory.Data });
        const type = String((stat as any).type || "");
        out.push({ name: entry, isDirectory: type === "directory" });
      } catch {
        out.push({ name: entry, isDirectory: false });
      }
      continue;
    }
    const name = String(entry?.name || "");
    const type = String(entry?.type || "");
    if (!name) continue;
    out.push({ name, isDirectory: type === "directory" });
  }
  return out;
}

async function addFolderToZip(
  zip: JSZip,
  sourceDir: string,
  zipBasePath: string,
  manifest: BackupFileManifestItem[],
  warnings: string[],
  onProgress: ((progress: BackupProgress) => void) | undefined,
  step: BackupProgressStep
): Promise<void> {
  const pending: Array<{ sourcePath: string; relativePath: string }> = [{ sourcePath: sourceDir, relativePath: "" }];
  let processed = 0;

  while (pending.length > 0) {
    const next = pending.shift();
    if (!next) break;
    let entries: Array<{ name: string; isDirectory: boolean }> = [];
    try {
      entries = await getReadDirEntries(next.sourcePath);
    } catch (error: any) {
      warnings.push(`missing-folder:${next.sourcePath}:${String(error?.message ?? error)}`);
      manifest.push({
        path: `${zipBasePath}/${next.relativePath}`.replace(/\/+$/g, ""),
        bytes: 0,
        skippedReason: "missing-folder",
      });
      continue;
    }

    for (const entry of entries) {
      const sourcePath = `${next.sourcePath}/${entry.name}`;
      const relativePath = next.relativePath ? `${next.relativePath}/${entry.name}` : entry.name;
      if (entry.isDirectory) {
        pending.push({ sourcePath, relativePath });
        continue;
      }
      try {
        const read = await Filesystem.readFile({ path: sourcePath, directory: Directory.Data });
        let bytes: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
        if (read.data instanceof Blob) {
          bytes = await blobToUint8Array(read.data);
        } else if (typeof read.data === "string") {
          const b64 = read.data.includes(",") ? read.data.split(",")[1] : read.data;
          const bin = atob(b64);
          bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
        }
        const zipPath = `${zipBasePath}/${relativePath}`.replace(/\\/g, "/");
        zip.file(zipPath, bytes);
        manifest.push({ path: zipPath, bytes: bytes.byteLength });
        if (bytes.byteLength > 50 * 1024 * 1024) {
          warnings.push(`large-file:${zipPath}:${bytes.byteLength}`);
        }
      } catch (error: any) {
        manifest.push({
          path: `${zipBasePath}/${relativePath}`.replace(/\\/g, "/"),
          bytes: 0,
          skippedReason: String(error?.message ?? error),
        });
        warnings.push(`file-read-failed:${sourcePath}:${String(error?.message ?? error)}`);
      }
      processed += 1;
      emitProgress(onProgress, step, `Collecting ${zipBasePath} files`, processed);
    }
  }
}

function writePrefsToStorage(
  prefs: Record<string, string>,
  includeOAuthTokens: boolean
): void {
  if (typeof window === "undefined") return;
  const allowedOauth = includeOAuthTokens ? new Set(OAUTH_PREF_KEYS) : new Set<string>();
  for (const [key, value] of Object.entries(prefs)) {
    if (!includeOAuthTokens && OAUTH_PREF_KEYS.includes(key) && !allowedOauth.has(key)) continue;
    localStorage.setItem(key, value);
  }
}

async function restoreFilesFromZip(
  zip: JSZip,
  warnings: string[],
  onProgress?: (progress: BackupProgress) => void
): Promise<void> {
  if (!isNative()) {
    warnings.push("native-files-restore-skipped-on-web");
    return;
  }
  const entries = Object.values(zip.files).filter((entry) => !entry.dir && entry.name.startsWith("files/"));
  let done = 0;
  for (const entry of entries) {
    const relative = entry.name.replace(/^files\//, "");
    if (!relative) continue;
    const bytes = new Uint8Array(await entry.async("uint8array"));
    const path = `talevox/${relative}`;
    const parent = path.split("/").slice(0, -1).join("/");
    if (parent) {
      await Filesystem.mkdir({ path: parent, directory: Directory.Data, recursive: true }).catch(() => undefined);
    }
    await Filesystem.writeFile({
      path,
      directory: Directory.Data,
      data: uint8ToBase64(bytes),
      recursive: true,
    });
    done += 1;
    emitProgress(onProgress, "restoring_files", "Restoring files", done, entries.length);
  }
}

async function applySnapshotFallback(snapshot: FullSnapshotV1): Promise<void> {
  for (const restoredBook of snapshot.books || []) {
    await libraryUpsertBook({ ...restoredBook, chapters: [], directoryHandle: undefined });
    if ((restoredBook.chapters || []).length > 0) {
      await libraryBulkUpsertChapters(
        restoredBook.id,
        restoredBook.chapters.map((chapter) => ({
          chapter: { ...chapter, content: undefined },
          content: typeof chapter.content === "string" ? chapter.content : null,
        }))
      );
    }
  }

  if (Array.isArray(snapshot.attachments) && snapshot.attachments.length > 0) {
    const byBook = new Map<string, BookAttachment[]>();
    for (const attachment of snapshot.attachments) {
      const list = byBook.get(attachment.bookId) || [];
      list.push(attachment);
      byBook.set(attachment.bookId, list);
    }
    for (const [bookId, list] of byBook.entries()) {
      await libraryBulkUpsertBookAttachments(bookId, list);
    }
  }
}

async function applyStorageDriverState(payload: StorageDriverBackupState): Promise<void> {
  await initStorage();
  const storage = getStorage();
  for (const job of payload.jobs || []) {
    await storage.createJob(job);
  }
  for (const item of payload.chapterAudioPaths || []) {
    await storage.setChapterAudioPath(item.chapterId, item.localPath, item.sizeBytes);
  }
  for (const queued of payload.queuedUploads || []) {
    if (!isRecord(queued)) continue;
    await storage.enqueueUpload(queued as any);
  }
}

export async function createFullBackupZip(
  options: BackupOptions,
  onProgress?: (progress: BackupProgress) => void,
  context?: BackupContext
): Promise<Blob> {
  const normalizedOptions = normalizeOptions(options);
  const warnings: string[] = [];
  const createdAt = Date.now();
  const zip = new JSZip();
  const manifest: BackupFileManifestItem[] = [];

  emitProgress(onProgress, "collecting_state", "Collecting app state");

  const ctx = context;
  if (!ctx) {
    throw new Error("Backup context is required.");
  }

  const snapshot = buildFullSnapshot({
    state: ctx.state,
    preferences: ctx.preferences || {},
    readerProgress: ctx.readerProgress || {},
    legacyProgressStore: ctx.legacyProgressStore || {},
    attachments: ctx.attachments || [],
    jobs: ctx.jobs || [],
    activeChapterId: ctx.activeChapterId,
    activeTab: ctx.activeTab,
  });

  const prefs = readStoredPrefs(normalizedOptions.includeOAuthTokens === true);
  const storageDriver = await collectStorageDriverState(ctx.state, warnings);

  emitProgress(onProgress, "exporting_sqlite", "Exporting SQLite database");
  let sqlitePayload: unknown = null;
  if (isNative()) {
    try {
      const raw = await exportSqliteJson(appConfig.db.name, appConfig.db.version);
      sqlitePayload = JSON.parse(raw);
    } catch (error: any) {
      warnings.push(`sqlite-export-failed:${String(error?.message ?? error)}`);
      sqlitePayload = { mode: "native-export-failed" };
    }
  } else {
    sqlitePayload = { mode: "web-fallback", reason: "sqlite-native-export-unavailable" };
    warnings.push("sqlite-native-export-unavailable-on-web");
  }

  emitProgress(onProgress, "collecting_files", "Collecting file assets");
  if (isNative()) {
    if (normalizedOptions.includeChapterText) {
      await addFolderToZip(
        zip,
        appConfig.paths.textDir,
        "files/chapter_text",
        manifest,
        warnings,
        onProgress,
        "collecting_files"
      );
    }
    if (normalizedOptions.includeAudio) {
      await addFolderToZip(
        zip,
        appConfig.paths.audioDir,
        "files/audio",
        manifest,
        warnings,
        onProgress,
        "collecting_files"
      );
    }
    if (normalizedOptions.includeAttachments) {
      await addFolderToZip(
        zip,
        appConfig.paths.attachmentsDir,
        "files/attachments",
        manifest,
        warnings,
        onProgress,
        "collecting_files"
      );
    }
    if (normalizedOptions.includeDiagnostics) {
      await addFolderToZip(
        zip,
        appConfig.paths.diagnosticsDir,
        "files/diagnostics",
        manifest,
        warnings,
        onProgress,
        "collecting_files"
      );
    }
  } else {
    warnings.push("native-file-folders-unavailable-on-web");
  }

  const meta: BackupMetaV1 = {
    backupSchemaVersion: BACKUP_SCHEMA_VERSION,
    appVersion:
      (typeof window !== "undefined" && typeof window.__APP_VERSION__ === "string"
        ? window.__APP_VERSION__
        : "unknown") || "unknown",
    createdAt,
    platform: getPlatform(),
    notes: "Full backup",
    warnings,
    options: normalizedOptions,
  };

  zip.file("meta.json", toSafeJsonString(meta));
  zip.file("prefs.json", toSafeJsonString(prefs));
  zip.file("sqlite.json", toSafeJsonString(sqlitePayload));
  zip.file("state/fullSnapshot.json", toSafeJsonString(snapshot));
  zip.file("state/storageDriver.json", toSafeJsonString(storageDriver));
  zip.file("manifests/files.json", toSafeJsonString(manifest));

  emitProgress(onProgress, "zipping", "Creating ZIP archive");
  const blob = await zip.generateAsync(
    { type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } },
    (metadata) => {
      emitProgress(onProgress, "zipping", "Compressing backup", Math.round(metadata.percent), 100);
    }
  );
  return blob;
}

async function cleanupLocalBackups(keep: number): Promise<void> {
  if (!isNative()) return;
  const keepCount = Math.max(1, keep);
  const dir = await Filesystem.readdir({ path: BACKUP_FOLDER, directory: Directory.Data }).catch(() => null);
  if (!dir || !Array.isArray((dir as any).files)) return;

  const files: Array<{ name: string; mtime: number }> = [];
  for (const entry of (dir as any).files as any[]) {
    const name = typeof entry === "string" ? entry : String(entry?.name || "");
    if (!name.endsWith(".zip")) continue;
    const fullPath = `${BACKUP_FOLDER}/${name}`;
    const stat = await Filesystem.stat({ path: fullPath, directory: Directory.Data }).catch(() => null);
    files.push({ name, mtime: asNumber((stat as any)?.mtime, 0) });
  }
  files.sort((a, b) => b.mtime - a.mtime);
  const remove = files.slice(keepCount);
  for (const item of remove) {
    await Filesystem.deleteFile({ path: `${BACKUP_FOLDER}/${item.name}`, directory: Directory.Data }).catch(() => undefined);
  }
}

async function cleanupDriveBackups(savesFolderId: string, keep: number): Promise<void> {
  const keepCount = Math.max(1, keep);
  const files = await listFilesInFolder(savesFolderId);
  const backupFiles = files
    .filter((f) => f.name.startsWith("talevox-backup-") && f.name.endsWith(".zip"))
    .sort((a, b) => new Date(b.modifiedTime).getTime() - new Date(a.modifiedTime).getTime());
  const stale = backupFiles.slice(keepCount);
  for (const file of stale) {
    await deleteDriveFile(file.id).catch(() => undefined);
  }
}

export async function saveBackup(
  target: BackupTarget,
  zipBlob: Blob,
  suggestedName?: string,
  onProgress?: (progress: BackupProgress) => void,
  config?: SaveBackupConfig
): Promise<{ locationLabel: string; fileName: string; fileId?: string; localPath?: string }> {
  const fileName = suggestedName || formatBackupFileName(Date.now());

  if (target === "drive") {
    emitProgress(onProgress, "saving_drive", "Uploading backup to Drive");
    if (!config?.rootFolderId) {
      throw new Error("Drive backup requires a root folder.");
    }
    const subfolders = await ensureRootStructure(config.rootFolderId);
    const fileId = await uploadToDrive(
      subfolders.savesId,
      fileName,
      zipBlob,
      undefined,
      "application/zip"
    );
    const pointerFileId = await findFileSync(BACKUP_POINTER_FILE, subfolders.savesId);
    const pointer = {
      schemaVersion: 1,
      latestFileName: fileName,
      latestCreatedAt: Date.now(),
      latestFileId: fileId,
      backupSchemaVersion: BACKUP_SCHEMA_VERSION,
    };
    await uploadToDrive(
      subfolders.savesId,
      BACKUP_POINTER_FILE,
      JSON.stringify(pointer),
      pointerFileId || undefined,
      "application/json"
    );
    await cleanupDriveBackups(subfolders.savesId, config?.keepDriveBackups ?? 10);
    return {
      locationLabel: "Saved to Google Drive",
      fileName,
      fileId,
    };
  }

  if (target === "download" || !isNative()) {
    emitProgress(onProgress, "downloading", "Downloading backup file");
    const url = URL.createObjectURL(zipBlob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
    return { locationLabel: "Downloaded backup ZIP", fileName };
  }

  emitProgress(onProgress, "saving_local", "Saving backup to device");
  await Filesystem.mkdir({ path: BACKUP_FOLDER, directory: Directory.Data, recursive: true }).catch(() => undefined);
  const localPath = `${BACKUP_FOLDER}/${fileName}`;
  await Filesystem.writeFile({
    path: localPath,
    directory: Directory.Data,
    data: await blobToBase64(zipBlob),
    recursive: true,
  });
  await cleanupLocalBackups(config?.keepLocalBackups ?? 10);

  if (config?.nativeMode === "internalOnly") {
    return { locationLabel: `Saved to app storage (${localPath})`, fileName, localPath };
  }

  const picker = (Capacitor as any)?.Plugins?.CapacitorFilePicker || (Capacitor as any)?.Plugins?.FilePicker;
  try {
    if (picker?.pickDirectory && picker?.copyFile) {
      const picked = await picker.pickDirectory();
      const targetDir = picked?.path || picked?.uri;
      if (targetDir) {
        const localUri = await Filesystem.getUri({ path: localPath, directory: Directory.Data });
        try {
          await picker.copyFile({
            source: localUri.uri,
            target: `${targetDir}/${fileName}`,
          });
        } catch {
          await picker.copyFile({
            from: localUri.uri,
            to: `${targetDir}/${fileName}`,
          });
        }
        return { locationLabel: `Saved to: ${targetDir}`, fileName, localPath };
      }
    }
  } catch {
    // Share fallback below.
  }

  const uri = await Filesystem.getUri({ path: localPath, directory: Directory.Data });
  await Share.share({
    title: "TaleVox backup",
    text: "TaleVox backup ZIP",
    url: uri.uri,
    dialogTitle: "Export TaleVox backup",
  });
  return { locationLabel: "Saved to app storage and shared", fileName, localPath };
}

export async function listDriveBackupCandidates(rootFolderId: string): Promise<DriveBackupCandidate[]> {
  const subfolders = await ensureRootStructure(rootFolderId);
  const files = await listFilesInFolder(subfolders.savesId);
  return files
    .filter((file) => file.name.endsWith(".zip") && file.name.startsWith("talevox-backup-"))
    .sort((a, b) => new Date(b.modifiedTime).getTime() - new Date(a.modifiedTime).getTime())
    .map((file) => ({
      id: file.id,
      name: file.name,
      modifiedTime: file.modifiedTime,
    }));
}

export async function restoreFromBackupZip(
  fileOrBlob: Blob,
  onProgress?: (progress: BackupProgress) => void
): Promise<void> {
  emitProgress(onProgress, "collecting_state", "Reading backup ZIP");
  const zip = await JSZip.loadAsync(await fileOrBlob.arrayBuffer());
  const metaEntry = zip.file("meta.json");
  if (!metaEntry) {
    throw new Error("Invalid backup ZIP: missing meta.json");
  }

  const rawMeta = JSON.parse(await metaEntry.async("text"));
  if (!isRecord(rawMeta) || typeof rawMeta.backupSchemaVersion !== "number") {
    throw new Error("Invalid backup metadata.");
  }
  const prefsEntry = zip.file("prefs.json");
  const sqliteEntry = zip.file("sqlite.json");
  const fullSnapshotEntry = zip.file("state/fullSnapshot.json");
  const storageEntry = zip.file("state/storageDriver.json");

  if (!fullSnapshotEntry) {
    throw new Error("Invalid backup ZIP: missing state/fullSnapshot.json");
  }

  const rawOptions = isRecord(rawMeta.options) ? rawMeta.options : {};
  const parsedMeta: BackupMetaV1 = {
    backupSchemaVersion: BACKUP_SCHEMA_VERSION,
    appVersion: String(rawMeta.appVersion || "unknown"),
    createdAt: asNumber(rawMeta.createdAt, Date.now()),
    platform:
      rawMeta.platform === "android" || rawMeta.platform === "ios" ? rawMeta.platform : "web",
    notes: String(rawMeta.notes || "Full backup"),
    warnings: Array.isArray(rawMeta.warnings)
      ? rawMeta.warnings.map((w) => String(w))
      : [],
    options: {
      includeAudio: rawOptions.includeAudio !== false,
      includeDiagnostics: rawOptions.includeDiagnostics !== false,
      includeAttachments: rawOptions.includeAttachments !== false,
      includeChapterText: rawOptions.includeChapterText !== false,
      includeOAuthTokens: rawOptions.includeOAuthTokens === true,
    },
  };

  const parsedBundle = {
    meta: parsedMeta,
    prefs: prefsEntry ? (JSON.parse(await prefsEntry.async("text")) as Record<string, string>) : {},
    sqliteJson: sqliteEntry ? JSON.parse(await sqliteEntry.async("text")) : null,
    fullSnapshot: JSON.parse(await fullSnapshotEntry.async("text")),
    storageDriver: storageEntry ? JSON.parse(await storageEntry.async("text")) : {},
    fileManifest: zip.file("manifests/files.json")
      ? (JSON.parse(await zip.file("manifests/files.json")!.async("text")) as BackupFileManifestItem[])
      : [],
  };
  const migrated = migrateBackupToLatest(parsedBundle);
  const warnings = [...(migrated.meta.warnings || [])];

  emitProgress(onProgress, "restoring_db", "Restoring database");
  if (isNative() && migrated.sqliteJson && !String((migrated.sqliteJson as any)?.mode || "").startsWith("web-")) {
    const sqliteJsonString = JSON.stringify(migrated.sqliteJson);
    const valid = await isSqliteJsonValid(sqliteJsonString);
    if (valid) {
      await importSqliteJson(sqliteJsonString, appConfig.db.name, appConfig.db.version);
    } else {
      warnings.push("sqlite-json-invalid-falling-back-to-snapshot");
      await applySnapshotFallback(migrated.fullSnapshot as FullSnapshotV1);
    }
  } else {
    await applySnapshotFallback(migrated.fullSnapshot as FullSnapshotV1);
  }

  emitProgress(onProgress, "restoring_prefs", "Restoring preferences");
  writePrefsToStorage(migrated.prefs || {}, migrated.meta?.options?.includeOAuthTokens === true);
  if (typeof window !== "undefined") {
    localStorage.setItem("talevox_restore_warnings_v1", JSON.stringify(warnings));
  }

  emitProgress(onProgress, "restoring_files", "Restoring files");
  await restoreFilesFromZip(zip, warnings, onProgress);

  emitProgress(onProgress, "finalizing", "Restoring storage metadata");
  if (migrated.storageDriver && isRecord(migrated.storageDriver)) {
    await applyStorageDriverState(migrated.storageDriver as StorageDriverBackupState);
  }

  emitProgress(onProgress, "finalizing", "Reloading app");
  if (typeof window !== "undefined") {
    window.location.reload();
  }
}

export async function restoreFromDriveSave(
  fileId: string,
  onProgress?: (progress: BackupProgress) => void
): Promise<void> {
  const blob = await fetchDriveBinary(fileId);
  await restoreFromBackupZip(blob, onProgress);
}
