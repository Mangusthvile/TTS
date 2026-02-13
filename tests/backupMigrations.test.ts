import { describe, expect, it } from "vitest";
import { BACKUP_SCHEMA_VERSION } from "../types";
import { migrateBackupToLatest } from "../services/backupMigrations";

describe("backupMigrations", () => {
  it("passes through current schema backups", () => {
    const input = {
      meta: {
        backupSchemaVersion: BACKUP_SCHEMA_VERSION,
        appVersion: "2.10.25",
        createdAt: Date.now(),
        platform: "web" as const,
        notes: "test",
        warnings: [],
        options: {
          includeAudio: true,
          includeDiagnostics: true,
          includeAttachments: true,
          includeChapterText: true,
          includeOAuthTokens: false,
        },
      },
      prefs: {},
      sqliteJson: {},
      fullSnapshot: {},
      storageDriver: {},
      fileManifest: [],
    };

    const migrated = migrateBackupToLatest(input);
    expect(migrated.meta.backupSchemaVersion).toBe(BACKUP_SCHEMA_VERSION);
  });
});

