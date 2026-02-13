// services/sqliteConnectionManager.ts
/* eslint-disable @typescript-eslint/no-explicit-any */

import {
  CapacitorSQLite,
  SQLiteConnection,
  SQLiteDBConnection,
} from "@capacitor-community/sqlite";
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

async function createOrRetrieveConnection(
  name: string,
  version: number,
  mode = "no-encryption"
): Promise<{ conn: SQLiteDBConnection; source: "created" | "retrieved" }> {
  const hasConnection = await safeIsConnection(name);
  if (hasConnection) {
    const existing = await safeRetrieveConnection(name);
    if (existing) return { conn: existing, source: "retrieved" };
    // Stale connection entry; try closing then recreate.
    try {
      await sqlite.closeConnection(name, false);
    } catch {
      // ignore
    }
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

function wrapConnection(
  db: SQLiteDBConnection,
  name: string,
  version: number,
  mode: string
): void {
  if ((db as any).__talevoxWrapped) return;
  const wrap = (key: "query" | "run" | "execute") => {
    const original = (db as any)[key]?.bind(db);
    if (!original) return;
    (db as any)[key] = async (...args: any[]) => {
      const opened = await ensureDbOpen(db);
      if (!opened) throw new Error("SQLite connection not opened");
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
        throw e;
      }
    };
  };
  wrap("query");
  wrap("run");
  wrap("execute");
  (db as any).__talevoxWrapped = true;
}

export async function getSqliteDb(
  name: string,
  version: number,
  mode = "no-encryption"
): Promise<SQLiteDBConnection> {
  const cached = dbCache.get(name);
  if (cached) {
    const reopened = await safeOpenDb(cached);
    if (reopened) {
      wrapConnection(cached, name, version, mode);
      return cached;
    }
    dbCache.delete(name);
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
    throw lastError instanceof Error
      ? lastError
      : new DbNotOpenError(name, "open");
  })().finally(() => {
    dbReady.delete(name);
  });

  dbReady.set(name, ready);
  return ready;
}

export async function closeSqliteDb(name: string): Promise<void> {
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
  return db.query(statement, values ?? []);
}

export async function dbRun(
  name: string,
  version: number,
  statement: string,
  values?: any[]
): Promise<any> {
  const db = await getSqliteDb(name, version);
  const opened = await ensureDbOpen(db);
  if (!opened) throw new Error(`SQLite ${name} not opened`);
  return db.run(statement, values ?? []);
}

export async function dbExecute(
  name: string,
  version: number,
  statement: string
): Promise<any> {
  const db = await getSqliteDb(name, version);
  const opened = await ensureDbOpen(db);
  if (!opened) throw new Error(`SQLite ${name} not opened`);
  return db.execute(statement);
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
