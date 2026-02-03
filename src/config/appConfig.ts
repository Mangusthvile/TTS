type Env = Record<string, string | boolean | undefined>;

function getEnv(): Env {
  try {
    return (import.meta as any)?.env ?? {};
  } catch {
    return {};
  }
}

function toBool(value: any, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const v = value.toLowerCase().trim();
    if (["1", "true", "yes", "on"].includes(v)) return true;
    if (["0", "false", "no", "off"].includes(v)) return false;
  }
  return fallback;
}

function toNumber(value: any, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

const env = getEnv();

const DB_NAME = String(env.VITE_TALEVOX_DB_NAME ?? "talevox_db");
const DB_VERSION = toNumber(env.VITE_TALEVOX_DB_VERSION, 1);
const NATIVE_DB_FILE = String(env.VITE_TALEVOX_DB_FILE ?? `${DB_NAME}SQLite.db`);

const TEXT_DIR = String(env.VITE_TALEVOX_TEXT_DIR ?? "talevox/chapter_text");
const AUDIO_DIR = String(env.VITE_TALEVOX_AUDIO_DIR ?? "talevox/audio");
const DIAG_DIR = String(env.VITE_TALEVOX_DIAG_DIR ?? "talevox/diagnostics");

const CHAPTER_TEXT_CACHE_TTL_MS = toNumber(env.VITE_TALEVOX_TEXT_CACHE_TTL_MS, 5 * 60 * 1000);
const CHAPTER_TEXT_NEGATIVE_TTL_MS = toNumber(env.VITE_TALEVOX_TEXT_NEG_TTL_MS, 45 * 1000);
const CHAPTER_AUDIO_PATH_TTL_MS = toNumber(env.VITE_TALEVOX_AUDIO_PATH_TTL_MS, 60 * 1000);
const FILE_STAT_TTL_MS = toNumber(env.VITE_TALEVOX_FILE_STAT_TTL_MS, 20 * 1000);

const DEBUG_LOG_JOBS = toBool(env.VITE_TALEVOX_DEBUG_LOG_JOBS, false);
const DEBUG_LOG_SQLITE = toBool(env.VITE_TALEVOX_DEBUG_LOG_SQLITE, false);

const BACKEND_MODE = String(env.VITE_TALEVOX_BACKEND_MODE ?? "drive");
const JOB_CONCURRENCY = toNumber(env.VITE_TALEVOX_JOB_CONCURRENCY, 1);
const JOB_RETRY_MAX = toNumber(env.VITE_TALEVOX_JOB_RETRY_MAX, 5);
const JOB_RETRY_BASE_MS = toNumber(env.VITE_TALEVOX_JOB_RETRY_BASE_MS, 1000);
const JOB_RETRY_MAX_MS = toNumber(env.VITE_TALEVOX_JOB_RETRY_MAX_MS, 20000);

const SYNC_INTERVAL_MS = toNumber(env.VITE_TALEVOX_SYNC_INTERVAL_MS, 5 * 60 * 1000);

export const appConfig = {
  db: {
    name: DB_NAME,
    version: DB_VERSION,
    nativeFile: NATIVE_DB_FILE,
  },
  paths: {
    textDir: TEXT_DIR,
    audioDir: AUDIO_DIR,
    diagnosticsDir: DIAG_DIR,
  },
  cache: {
    chapterTextTtlMs: CHAPTER_TEXT_CACHE_TTL_MS,
    chapterTextNegativeTtlMs: CHAPTER_TEXT_NEGATIVE_TTL_MS,
    chapterAudioPathTtlMs: CHAPTER_AUDIO_PATH_TTL_MS,
    fileStatTtlMs: FILE_STAT_TTL_MS,
  },
  jobs: {
    concurrency: JOB_CONCURRENCY,
    retry: {
      maxAttempts: JOB_RETRY_MAX,
      baseDelayMs: JOB_RETRY_BASE_MS,
      maxDelayMs: JOB_RETRY_MAX_MS,
    },
  },
  sync: {
    intervalMs: SYNC_INTERVAL_MS,
  },
  debug: {
    logJobs: DEBUG_LOG_JOBS,
    logSqlite: DEBUG_LOG_SQLITE,
  },
  backend: {
    mode: BACKEND_MODE,
  },
};

export function getConfigDump(): Record<string, any> {
  return {
    db: appConfig.db,
    paths: appConfig.paths,
    cache: appConfig.cache,
    jobs: appConfig.jobs,
    sync: appConfig.sync,
    debug: appConfig.debug,
    backend: appConfig.backend,
  };
}
