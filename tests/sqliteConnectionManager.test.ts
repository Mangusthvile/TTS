import { describe, it, expect, beforeEach, vi } from "vitest";

let isConnectionResult = false;
const createConnection = vi.fn();
const retrieveConnection = vi.fn();
const closeConnection = vi.fn();
const checkConnectionsConsistency = vi.fn();
const importFromJson = vi.fn();
const isJsonValid = vi.fn();
const fakeDb = {
  open: vi.fn(async () => {}),
  isDBOpen: vi.fn(async () => ({ result: true })),
  query: vi.fn(),
  run: vi.fn(),
  execute: vi.fn(),
  exportToJson: vi.fn(async () => ({ database: "talevox_db", mode: "full", tables: [] })),
};

vi.mock("@capacitor-community/sqlite", () => {
  class SQLiteConnection {
    checkConnectionsConsistency = checkConnectionsConsistency;
    isConnection = vi.fn(async () => ({ result: isConnectionResult }));
    retrieveConnection = retrieveConnection;
    createConnection = createConnection;
    closeConnection = closeConnection;
    importFromJson = importFromJson;
    isJsonValid = isJsonValid;
  }

  return {
    CapacitorSQLite: {},
    SQLiteConnection,
  };
});

describe("sqliteConnectionManager", () => {
  beforeEach(async () => {
    await vi.resetModules();
    isConnectionResult = false;
    createConnection.mockReset().mockResolvedValue(fakeDb);
    retrieveConnection.mockReset().mockResolvedValue(fakeDb);
    closeConnection.mockReset().mockResolvedValue(undefined);
    checkConnectionsConsistency.mockReset().mockResolvedValue({ result: true });
    importFromJson.mockReset().mockResolvedValue({ changes: { changes: 1 } });
    isJsonValid.mockReset().mockResolvedValue({ result: true });
    fakeDb.open.mockClear();
    fakeDb.isDBOpen.mockClear();
    fakeDb.exportToJson.mockClear();
  });

  it("creates only one connection for concurrent calls", async () => {
    const { getSqliteDb } = await import("../services/sqliteConnectionManager");
    const p1 = getSqliteDb("talevox_db", 1);
    const p2 = getSqliteDb("talevox_db", 1);
    const [db1, db2] = await Promise.all([p1, p2]);
    expect(db1).toBe(db2);
    expect(createConnection).toHaveBeenCalledTimes(1);
  });

  it("retrieves existing connection when available", async () => {
    isConnectionResult = true;
    const { getSqliteDb } = await import("../services/sqliteConnectionManager");
    const db = await getSqliteDb("talevox_db", 1);
    expect(db).toBe(fakeDb);
    expect(retrieveConnection).toHaveBeenCalledTimes(1);
    expect(createConnection).toHaveBeenCalledTimes(0);
  });

  it("exports sqlite json payload", async () => {
    const { exportSqliteJson } = await import("../services/sqliteConnectionManager");
    const payload = await exportSqliteJson("talevox_db", 1);
    expect(typeof payload).toBe("string");
    expect(fakeDb.exportToJson).toHaveBeenCalledWith("full");
  });

  it("validates and imports sqlite json payload", async () => {
    const { importSqliteJson, isSqliteJsonValid } = await import("../services/sqliteConnectionManager");
    const input = JSON.stringify({ database: "talevox_db", version: 1 });
    await expect(isSqliteJsonValid(input)).resolves.toBe(true);
    await expect(importSqliteJson(input, "talevox_db", 1)).resolves.toBeUndefined();
    expect(importFromJson).toHaveBeenCalled();
  });
});
