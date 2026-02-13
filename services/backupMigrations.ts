import { BACKUP_SCHEMA_VERSION, BackupMetaV1 } from "../types";

export type BackupBundleV1 = {
  meta: BackupMetaV1;
  prefs: Record<string, string>;
  sqliteJson: unknown;
  fullSnapshot: unknown;
  storageDriver: unknown;
  fileManifest: Array<{ path: string; bytes: number; skippedReason?: string }>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseSchemaVersion(input: unknown): number {
  if (!isRecord(input)) return 0;
  if (typeof input.backupSchemaVersion === "number") return input.backupSchemaVersion;
  return 0;
}

export function migrateBackupToLatest(input: BackupBundleV1): BackupBundleV1 {
  const schemaVersion = parseSchemaVersion(input.meta);

  if (schemaVersion === BACKUP_SCHEMA_VERSION) {
    return input;
  }

  // Placeholder for future schema upgrades.
  if (schemaVersion < BACKUP_SCHEMA_VERSION) {
    return {
      ...input,
      meta: {
        ...input.meta,
        backupSchemaVersion: BACKUP_SCHEMA_VERSION,
        warnings: [
          ...(input.meta.warnings || []),
          `Backup migrated from schema ${schemaVersion} to ${BACKUP_SCHEMA_VERSION}`,
        ],
      },
    };
  }

  throw new Error(
    `Unsupported backup schema ${schemaVersion}. App supports up to ${BACKUP_SCHEMA_VERSION}.`
  );
}

