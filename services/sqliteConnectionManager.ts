// services/sqliteConnectionManager.ts
/* eslint-disable @typescript-eslint/no-explicit-any */

import { CapacitorSQLite, SQLiteConnection, SQLiteDBConnection } from "@capacitor-community/sqlite";
import { getLogger } from "../utils/logger";
import { DbNotOpenError } from "../utils/errors";

type BoolResult = boolean | { result?: boolean };

const sqlite = new SQLiteConnection(CapacitorSQLite);
const dbCache = new Map<string, SQLiteDBConnection>();
const dbReady = new Map<string, Promise<SQLiteDBConnection>>();
const dbMeta = new Map<string, { version: number; mode: string }>();
const readyLogged = new Set<string>();
let consistencyChecked = false;
let consistencyCheckPromise: Promise<void> | null = null;
const log = getLogger("SQLite");

/** Callbacks to run when DB corruption is detected (e.g. storage driver can clear its cached connection). */
const onCorruptionListeners = new Set<(dbName: string) => void>();
export function addCorruptionListener(fn: (dbName: string) => void): () => void {
  onCorruptionListeners.add(fn);
  return () => onCorruptionListeners.delete(fn);
}

/** After corruption we delete the DB; next getSqliteDb returns a fresh connection. This set marks DBs that need schema run on that connection. */
const schemaNeededFor = new Set<string>();
/** Optional schema runners (e.g. runSchemaOnConnection) so a fresh DB gets tables before any caller uses it. */
const schemaRunners = new Map<string, (db: SQLiteDBConnection) => Promise<void>>();
export function registerSchemaRunner(name: string, fn: (db: SQLiteDBConnection) => Promise<void>): void {
  schemaRunners.set(name, fn);
}

/** Per-database queue so only one native operation runs at a time. Reduces Android SQLiteConnection leaks. */
const opQueue = new Map<string, Promise<void>>();
async function runSerialized<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const prev = opQueue.get(name) ?? Promise.resolve();
  const current = prev.then(
    () => fn(),
    () => fn()
  );
  opQueue.set(
    name,
    current.then(
      () => {},
      () => {}
    )
  );
  return current;
}

function toBool(value: any): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return value.toLowerCase() === "true";
  if (value && typeof value === "object" && "result" in value) {
    return toBool((value as any).result);
  }
  return false;
}

async function checkConsistency(): Promise<boolean> {
  try {
    const res = await sqlite.checkConnectionsConsistency();
    return toBool(res as BoolResult);
  } catch {
    // Best-effort only; assume ok to avoid killing active connections.
    return true;
  }
}

async function ensureConsistencyOnce(): Promise<void> {
  if (consistencyChecked) return;
  if (consistencyCheckPromise) return consistencyCheckPromise;
  consistencyCheckPromise = (async () => {
    const ok = await checkConsistency();
    if (!ok && dbCache.size === 0) {
      // Only reset when no active cached connections (avoid nuking in-flight work).
      try {
        const closeAll = (sqlite as any).closeAllConnections;
        if (typeof closeAll === "function") {
          await closeAll.call(sqlite);
        }
      } catch {
        // ignore
      }
    }
    consistencyChecked = true;
  })().finally(() => {
    consistencyCheckPromise = null;
  });
  return consistencyCheckPromise;
}

async function safeIsConnection(name: string): Promise<boolean> {
  try {
    const res = await sqlite.isConnection(name, false);
    return toBool(res as BoolResult);
  } catch {
    return false;
  }
}

async function safeIsDbOpen(db: SQLiteDBConnection): Promise<boolean> {
  try {
    const res = await (db as any).isDBOpen?.();
    return toBool(res as BoolResult);
  } catch {
    return false;
  }
}

async function safeOpenDb(db: SQLiteDBConnection): Promise<boolean> {
  try {
    await db.open();
  } catch (e: any) {
    const msg = String(e?.message ?? e).toLowerCase();
    if (msg.includes("already") && msg.includes("open")) {
      return true;
    }
    return false;
  }
  // If open succeeded without throwing, treat it as open.
  return true;
}

async function ensureDbOpen(db: SQLiteDBConnection): Promise<boolean> {
  // Always attempt open to avoid false positives from isDBOpen.
  const opened = await safeOpenDb(db);
  if (opened) return true;
  return await safeIsDbOpen(db);
}

async function safeRetrieveConnection(name: string): Promise<SQLiteDBConnection | null> {
  try {
    return await sqlite.retrieveConnection(name, false);
  } catch {
    return null;
  }
}

/**
 * Consistency-first init (Phase 1.1): only retrieve when both native/JS state
 * are consistent and the connection exists; otherwise create. Avoids zombie
 * connection and "Connection already exists" after hard refresh.
 */
async function createOrRetrieveConnection(
  name: string,
  version: number,
  mode = "no-encryption"
): Promise<{ conn: SQLiteDBConnection; source: "created" | "retrieved" }> {
  const consistency = await checkConsistency();
  const isConnected = await safeIsConnection(name);

  if (consistency && isConnected) {
    const existing = await safeRetrieveConnection(name);
    if (existing) return { conn: existing, source: "retrieved" };
  }

  try {
    const conn = await sqlite.createConnection(name, false, mode, version, false);
    return { conn, source: "created" };
  } catch (e: any) {
    const msg = String(e?.message ?? e).toLowerCase();
    if (msg.includes("already") || msg.includes("exist")) {
      const existing = await safeRetrieveConnection(name);
      if (existing) return { conn: existing, source: "retrieved" };
      try {
        await sqlite.closeConnection(name, false);
      } catch {
        // ignore
      }
      const conn = await sqlite.createConnection(name, false, mode, version, false);
      return { conn, source: "created" };
    }
    if (msg.includes("does not exist")) {
      const conn = await sqlite.createConnection(name, false, mode, version, false);
      return { conn, source: "created" };
    }
    throw e;
  }
}

async function refreshConnection(
  name: string,
  version: number,
  mode: string
): Promise<SQLiteDBConnection> {
  await closeSqliteDb(name);
  return getSqliteDb(name, version, mode);
}

function wrapConnection(db: SQLiteDBConnection, name: string, version: number, mode: string): void {
  if ((db as any).__talevoxWrapped) return;
  const wrap = (key: "query" | "run" | "execute") => {
    const original = (db as any)[key]?.bind(db);
    if (!original) return;
    (db as any)[key] = async (...args: any[]) => {
      // Optimistic path: skip pre-open check, let errors trigger recovery.
      try {
        return await original(...args);
      } catch (e: any) {
        const msg = String(e?.message ?? e).toLowerCase();
        if (msg.includes("not opened") || msg.includes("does not exist")) {
          const reopened = await ensureDbOpen(db);
          if (reopened) {
            try {
              return await original(...args);
            } catch {
              // continue to refresh fallback
            }
          }
          try {
            const fresh = await refreshConnection(name, version, mode);
            const fn = (fresh as any)[key]?.bind(fresh);
            if (fn) return await fn(...args);
          } catch {
            // fall through
          }
          throw e;
        }
        if (msg.includes("malformed") || msg.includes("disk image") || msg.includes("corruption")) {
          // Corrupt DB: evict cache, close connection, delete DB file so next getSqliteDb creates a fresh DB.
          // Caller (e.g. storage driver) should clear its cached connection so next use gets a new one and runs migrations.
          dbCache.delete(name);
          dbMeta.delete(name);
          dbReady.delete(name);
          consistencyChecked = false;
          onCorruptionListeners.forEach((fn) => {
            try {
              fn(name);
            } catch {
              // ignore
            }
          });
          log.error("corruption/malformed DB detected, evicting cache and deleting DB file", {
            dbName: name,
          });
          try {
            await forceCloseSqliteDb(name);
            const closeAll = (sqlite as any).closeAllConnections;
            if (typeof closeAll === "function") {
              await closeAll.call(sqlite);
            }
          } catch {
            // ignore close errors
          }
          await new Promise((resolve) => setTimeout(resolve, 400));
          let deleted = false;
          try {
            await CapacitorSQLite.deleteDatabase({ database: name });
            deleted = true;
          } catch (delErr: any) {
            log.warn("deleteDatabase first attempt failed, retrying after delay", {
              dbName: name,
              err: delErr?.message ?? delErr,
            });
            await new Promise((resolve) => setTimeout(resolve, 1000));
            try {
              await CapacitorSQLite.deleteDatabase({ database: name });
              deleted = true;
            } catch (retryErr: any) {
              log.error("recovery after corrupt DB failed", {
                dbName: name,
                err: retryErr?.message ?? retryErr,
              });
            }
          }
          if (deleted) {
            schemaNeededFor.add(name);
            log.info("corrupt DB file deleted; next open will create a fresh database", {
              dbName: name,
            });
          }
        }
        throw e;
      }
    };
  };
  wrap("query");
  wrap("run");
  wrap("execute");
  (db as any).__talevoxWrapped = true;
}

/**
 * Call once at app startup (e.g. in bootstrap) so the DB connection is opened early
 * and reused everywhere (singleton). Runs consistency check to recover zombie
 * connections from previous runs. Using a single cached connection (dbCache) and
 * serializing operations (runSerialized) reduces Android CloseGuard "close() not called"
 * leaks that can contribute to DB corruption.
 */
export async function ensureAppDatabaseOpen(
  name: string,
  version: number,
  mode = "no-encryption"
): Promise<SQLiteDBConnection> {
  return getSqliteDb(name, version, mode);
}

export async function getSqliteDb(
  name: string,
  version: number,
  mode = "no-encryption"
): Promise<SQLiteDBConnection> {
  const cached = dbCache.get(name);
  if (cached) {
    // Fast path: return cached connection without extra open() call.
    // The wrapped methods will recover on "not opened" errors if the connection drops.
    wrapConnection(cached, name, version, mode);
    return cached;
  }
  const pending = dbReady.get(name);
  if (pending) return pending;

  const ready = (async () => {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await ensureConsistencyOnce();

        let conn: SQLiteDBConnection;
        let source: "created" | "retrieved" = "created";

        try {
          const result = await createOrRetrieveConnection(name, version, mode);
          conn = result.conn;
          source = result.source;
        } catch (e: any) {
          const msg = String(e?.message ?? e).toLowerCase();
          if (msg.includes("does not exist") || msg.includes("not opened")) {
            try {
              const closeAll = (sqlite as any).closeAllConnections;
              if (typeof closeAll === "function") {
                await closeAll.call(sqlite);
              }
            } catch {
              // ignore
            }
            const result = await createOrRetrieveConnection(name, version, mode);
            conn = result.conn;
            source = result.source;
          } else {
            throw e;
          }
        }

        const opened = await ensureDbOpen(conn);
        if (!opened) {
          // Recreate the connection if open failed.
          dbCache.delete(name);
          try {
            await sqlite.closeConnection(name, false);
          } catch {
            // ignore
          }
          const result = await createOrRetrieveConnection(name, version, mode);
          conn = result.conn;
          source = result.source;
          const openedRetry = await ensureDbOpen(conn);
          if (!openedRetry) {
            throw new DbNotOpenError(name, "open");
          }
        }

        wrapConnection(conn, name, version, mode);
        dbCache.set(name, conn);
        dbMeta.set(name, { version, mode });

        if (schemaNeededFor.has(name)) {
          const runner = schemaRunners.get(name);
          if (runner) {
            try {
              await runner(conn);
              log.info("schema run on fresh DB after corruption", { dbName: name });
            } catch (schemaErr: any) {
              log.error("schema run after corruption failed", {
                dbName: name,
                err: schemaErr?.message ?? schemaErr,
              });
            }
          }
          schemaNeededFor.delete(name);
        }

        if (!readyLogged.has(name)) {
          console.log(`[TaleVox][SQLite] ${name} ready (${source})`);
          readyLogged.add(name);
        }

        return conn;
      } catch (err: any) {
        lastError = err;
        log.error("open failed", { dbName: name, attempt, err: String(err?.message ?? err) });
        const msg = String(err?.message ?? err).toLowerCase();
        if (attempt === 0 && (msg.includes("does not exist") || msg.includes("not opened"))) {
          dbCache.delete(name);
          try {
            await sqlite.closeConnection(name, false);
          } catch {
            // ignore
          }
          await new Promise((resolve) => setTimeout(resolve, 120));
          continue;
        }
        throw err;
      }
    }
    throw lastError instanceof Error ? lastError : new DbNotOpenError(name, "open");
  })().finally(() => {
    dbReady.delete(name);
  });

  dbReady.set(name, ready);
  return ready;
}

export async function closeSqliteDb(name: string): Promise<void> {
  // Intentionally do not close the connection to allow pooling/reuse.
  // The 'dbCache' map acts as our connection pool.
  // Only explicitly close if forcing a reset.
  const db = dbCache.get(name);
  if (db) {
    // Just verify it's still usable, if not remove from cache
    try {
      const isConnected = await safeIsConnection(name);
      if (!isConnected) {
        dbCache.delete(name);
        dbMeta.delete(name);
        dbReady.delete(name);
      }
    } catch {
      // ignore
    }
  }
}

export async function forceCloseSqliteDb(name: string): Promise<void> {
  const db = dbCache.get(name);
  if (db) {
    try {
      await db.close();
    } catch {
      // ignore
    }
  }
  try {
    await sqlite.closeConnection(name, false);
  } catch {
    // ignore
  }
  dbCache.delete(name);
  dbMeta.delete(name);
  dbReady.delete(name);
  opQueue.delete(name);
}

export async function dbQuery(
  name: string,
  version: number,
  statement: string,
  values?: any[]
): Promise<any> {
  const db = await getSqliteDb(name, version);
  const opened = await ensureDbOpen(db);
  if (!opened) throw new Error(`SQLite ${name} not opened`);
  const trimmed = String(statement ?? "").trim().toLowerCase();
  const readOnly =
    trimmed.startsWith("select") || trimmed.startsWith("pragma") || trimmed.startsWith("with");
  // IMPORTANT: On Android, using readonly=true for SELECTs reduces leaked SQLiteConnection warnings
  // under high concurrency (e.g. rapid audio-path checks).
  return runSerialized(name, () => (db as any).query(statement, values ?? [], readOnly));
}

/** Run a single statement. Use transaction: false to avoid Android connection leak when doing many separate runs. */
export async function dbRun(
  name: string,
  version: number,
  statement: string,
  values?: any[],
  options?: { transaction?: boolean }
): Promise<any> {
  const db = await getSqliteDb(name, version);
  const opened = await ensureDbOpen(db);
  if (!opened) throw new Error(`SQLite ${name} not opened`);
  const useTransaction = options?.transaction !== false;
  return runSerialized(name, () => db.run(statement, values ?? [], useTransaction, "no", true));
}

/** Run multiple statements. Use transaction: false on Android to avoid connection leak; batch is still atomic per statement. */
export async function dbExecuteSet(
  name: string,
  version: number,
  set: Array<{ statement: string; values?: any[] }>,
  options?: { transaction?: boolean }
): Promise<any> {
  if (set.length === 0) return { changes: { changes: 0 } };
  const db = await getSqliteDb(name, version);
  const opened = await ensureDbOpen(db);
  if (!opened) throw new Error(`SQLite ${name} not opened`);
  const useTransaction = options?.transaction !== false;
  return runSerialized(name, () => db.executeSet(set, useTransaction, "no", true));
}

export async function dbExecute(
  name: string,
  version: number,
  statement: string,
  options?: { transaction?: boolean }
): Promise<any> {
  const db = await getSqliteDb(name, version);
  const opened = await ensureDbOpen(db);
  if (!opened) throw new Error(`SQLite ${name} not opened`);
  const useTransaction = options?.transaction !== false;
  return runSerialized(name, () => db.execute(statement, useTransaction, true));
}

export async function getSqliteStatus(name: string): Promise<{
  cached: boolean;
  hasConnection: boolean;
  isOpen: boolean;
  pending: boolean;
}> {
  const cached = dbCache.get(name) ?? null;
  const hasConnection = await safeIsConnection(name);
  let isOpen = false;
  if (cached) {
    isOpen = await safeIsDbOpen(cached);
  } else if (hasConnection) {
    const conn = await safeRetrieveConnection(name);
    if (conn) {
      isOpen = await safeIsDbOpen(conn);
    }
  }
  return {
    cached: !!cached,
    hasConnection,
    isOpen,
    pending: dbReady.has(name),
  };
}

export async function exportSqliteJson(name: string, version: number): Promise<string> {
  const db = await getSqliteDb(name, version);
  const opened = await ensureDbOpen(db);
  if (!opened) {
    throw new DbNotOpenError(name, "export");
  }
  const exporter = (db as any).exportToJson;
  if (typeof exporter !== "function") {
    throw new Error("SQLite exportToJson is not available on this platform.");
  }
  const payload = await exporter.call(db, "full");
  return typeof payload === "string" ? payload : JSON.stringify(payload);
}

export async function isSqliteJsonValid(jsonString: string): Promise<boolean> {
  if (!jsonString || typeof jsonString !== "string") return false;

  const validator = (sqlite as any).isJsonValid;
  if (typeof validator !== "function") {
    throw new Error("SQLite isJsonValid is not available on this platform.");
  }

  try {
    const result = await validator.call(sqlite, jsonString);
    return toBool(result);
  } catch {
    const result = await validator.call(sqlite, { jsonstring: jsonString });
    return toBool(result);
  }
}

export async function importSqliteJson(
  jsonString: string,
  name: string,
  version: number
): Promise<void> {
  const valid = await isSqliteJsonValid(jsonString);
  if (!valid) {
    throw new Error("Invalid SQLite JSON payload.");
  }

  await closeSqliteDb(name);
  consistencyChecked = false;

  const importer = (sqlite as any).importFromJson;
  if (typeof importer !== "function") {
    throw new Error("SQLite importFromJson is not available on this platform.");
  }

  try {
    await importer.call(sqlite, jsonString);
  } catch {
    const parsed = JSON.parse(jsonString);
    await importer.call(sqlite, parsed);
  }

  await getSqliteDb(name, version);
}
