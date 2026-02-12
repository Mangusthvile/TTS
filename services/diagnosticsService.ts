import { Capacitor } from "@capacitor/core";
import { Filesystem, Directory } from "@capacitor/filesystem";
import { JobRunner } from "../src/plugins/jobRunner";
import { getSqliteDb, getSqliteStatus } from "./sqliteConnectionManager";
import { appConfig, getConfigDump } from "../src/config/appConfig";

const DB_NAME = appConfig.db.name;
const DB_VERSION = appConfig.db.version;
const TEXT_DIR = appConfig.paths.textDir;
const AUDIO_DIR = appConfig.paths.audioDir;

export type DiagnosticsReport = {
  generatedAt: number;
  platform: string;
  config?: ReturnType<typeof getConfigDump>;
  sqlite: {
    cached: boolean;
    hasConnection: boolean;
    isOpen: boolean;
    pending: boolean;
    error?: string;
  };
  tables: Record<string, boolean>;
  counts: Record<string, number | null>;
  fileCache: {
    textFiles: number;
    audioFiles: number;
    missingTextFiles: string[];
    missingAudioFiles: string[];
    checkedTextRows: number;
    checkedAudioRows: number;
  };
  workManager?: any;
  notes?: string[];
};

async function safeCount(db: any, table: string): Promise<number | null> {
  try {
    const res = await db.query(`SELECT COUNT(*) AS cnt FROM ${table}`);
    const row = res.values?.[0] ?? null;
    return row ? Number((row as any).cnt ?? 0) : 0;
  } catch {
    return null;
  }
}

async function countFiles(path: string): Promise<number> {
  try {
    const res = await Filesystem.readdir({ path, directory: Directory.Data });
    return Array.isArray(res.files) ? res.files.length : 0;
  } catch {
    return 0;
  }
}

async function statExists(path: string): Promise<boolean> {
  try {
    await Filesystem.stat({ path, directory: Directory.Data });
    return true;
  } catch {
    return false;
  }
}

export async function collectDiagnostics(): Promise<DiagnosticsReport> {
  const platform = Capacitor.getPlatform?.() ?? "web";
  const isNative = Capacitor.isNativePlatform?.() ?? false;
  const report: DiagnosticsReport = {
    generatedAt: Date.now(),
    platform,
    config: getConfigDump(),
    sqlite: {
      cached: false,
      hasConnection: false,
      isOpen: false,
      pending: false,
    },
    tables: {},
    counts: {},
    fileCache: {
      textFiles: 0,
      audioFiles: 0,
      missingTextFiles: [],
      missingAudioFiles: [],
      checkedTextRows: 0,
      checkedAudioRows: 0,
    },
  };

  if (isNative) {
    try {
      report.sqlite = await getSqliteStatus(DB_NAME);
    } catch (e: any) {
      report.sqlite.error = String(e?.message ?? e);
    }

    try {
      const db = await getSqliteDb(DB_NAME, DB_VERSION);
      const tableRes = await db.query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('books','chapters','chapter_text','chapter_tombstones','jobs','chapter_audio_files','drive_upload_queue','book_attachments')"
      );
      const names = new Set<string>((tableRes.values ?? []).map((row: any) => String(row.name)));
      const known = [
        "books",
        "chapters",
        "chapter_text",
        "chapter_tombstones",
        "jobs",
        "chapter_audio_files",
        "drive_upload_queue",
        "book_attachments",
      ];
      known.forEach((name) => {
        report.tables[name] = names.has(name);
      });
      for (const name of known) {
        report.counts[name] = await safeCount(db, name);
      }

      const maxCheck = 200;
      if (report.tables.chapter_text) {
        const rows = await db.query("SELECT chapterId, localPath FROM chapter_text");
        const entries = rows.values ?? [];
        report.fileCache.checkedTextRows = Math.min(maxCheck, entries.length);
        for (let i = 0; i < entries.length && i < maxCheck; i++) {
          const row = entries[i] as any;
          const chapterId = String(row.chapterId ?? "");
          const path = row.localPath ? String(row.localPath) : `${TEXT_DIR}/${chapterId}.txt`;
          if (!path) continue;
          const exists = await statExists(path);
          if (!exists) report.fileCache.missingTextFiles.push(chapterId);
        }
      }

      if (report.tables.chapter_audio_files) {
        const rows = await db.query("SELECT chapterId, localPath FROM chapter_audio_files");
        const entries = rows.values ?? [];
        report.fileCache.checkedAudioRows = Math.min(maxCheck, entries.length);
        for (let i = 0; i < entries.length && i < maxCheck; i++) {
          const row = entries[i] as any;
          const chapterId = String(row.chapterId ?? "");
          const path = row.localPath ? String(row.localPath) : `${AUDIO_DIR}/${chapterId}.mp3`;
          if (!path) continue;
          const exists = await statExists(path);
          if (!exists) report.fileCache.missingAudioFiles.push(chapterId);
        }
      }
    } catch (e: any) {
      report.notes = report.notes ?? [];
      report.notes.push(`sqlite: ${String(e?.message ?? e)}`);
    }
  } else {
    report.notes = report.notes ?? [];
    report.notes.push("native sqlite unavailable");
  }

  report.fileCache.textFiles = await countFiles(TEXT_DIR);
  report.fileCache.audioFiles = await countFiles(AUDIO_DIR);

  if (isNative) {
    try {
      report.workManager = await JobRunner.getDiagnostics();
    } catch (e: any) {
      report.workManager = { error: String(e?.message ?? e) };
    }
  } else {
    report.workManager = { supported: false };
  }

  return report;
}

export async function saveDiagnosticsToFile(report: DiagnosticsReport): Promise<string | null> {
  if (!Capacitor.isNativePlatform?.()) return null;
  const name = `diag_${new Date(report.generatedAt).toISOString().replace(/[:.]/g, "-")}.json`;
  const path = `${appConfig.paths.diagnosticsDir}/${name}`;
  try {
    await Filesystem.mkdir({ path: appConfig.paths.diagnosticsDir, directory: Directory.Data, recursive: true });
  } catch {
    // ignore
  }
  await Filesystem.writeFile({
    path,
    directory: Directory.Data,
    data: JSON.stringify(report, null, 2),
  });
  return path;
}
