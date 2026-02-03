import { describe, it, expect, beforeEach, vi } from "vitest";

let isConnectionResult = false;
const createConnection = vi.fn();
const retrieveConnection = vi.fn();
const closeConnection = vi.fn();
const checkConnectionsConsistency = vi.fn();
const fakeDb = {
  open: vi.fn(async () => {}),
  isDBOpen: vi.fn(async () => ({ result: true })),
  query: vi.fn(),
  run: vi.fn(),
  execute: vi.fn(),
};

vi.mock("@capacitor-community/sqlite", () => {
  class SQLiteConnection {
    checkConnectionsConsistency = checkConnectionsConsistency;
    isConnection = vi.fn(async () => ({ result: isConnectionResult }));
    retrieveConnection = retrieveConnection;
    createConnection = createConnection;
    closeConnection = closeConnection;
  }

  return {
    CapacitorSQLite: {},
    SQLiteConnection,
  };
});

describe("sqliteConnectionManager", () => {
  beforeEach(() => {
    isConnectionResult = false;
    createConnection.mockReset().mockResolvedValue(fakeDb);
    retrieveConnection.mockReset().mockResolvedValue(fakeDb);
    closeConnection.mockReset().mockResolvedValue(undefined);
    checkConnectionsConsistency.mockReset().mockResolvedValue({ result: true });
    fakeDb.open.mockClear();
    fakeDb.isDBOpen.mockClear();
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
});
