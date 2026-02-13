import { describe, expect, it } from "vitest";
import { AudioStatus, HighlightMode, SavedSnapshot, StorageBackend, Theme } from "../types";
import { buildFullSnapshotV1, migrateSnapshot } from "../services/fullSnapshot";

describe("fullSnapshot", () => {
  it("migrates legacy SavedSnapshot v1 into FullSnapshotV1", () => {
    const legacy: SavedSnapshot = {
      version: "v1",
      savedAt: 1700000000000,
      state: {
        books: [
          {
            id: "book-1",
            title: "Book",
            backend: StorageBackend.DRIVE,
            chapters: [
              {
                id: "ch-1",
                index: 1,
                title: "Chapter 1",
                filename: "c_1.md",
                contentFormat: "markdown",
                wordCount: 10,
                progress: 0,
                progressChars: 0,
                audioStatus: AudioStatus.PENDING,
                volumeName: "",
              },
            ],
            rules: [],
            settings: { useBookSettings: false, highlightMode: HighlightMode.SENTENCE },
          },
        ],
        readerSettings: {
          fontFamily: "serif",
          fontSizePx: 20,
          lineHeight: 1.5,
          paragraphSpacing: 1,
          reflowLineBreaks: true,
          highlightColor: "#4f46e5",
          followHighlight: true,
          uiMode: "mobile",
        },
        playbackSpeed: 1,
        theme: Theme.DARK,
        progressStore: {},
      },
    };

    const migrated = migrateSnapshot(legacy);
    expect(migrated).not.toBeNull();
    expect(migrated?.schemaVersion).toBe(1);
    expect(migrated?.books).toHaveLength(1);
    expect(migrated?.books[0].settings.autoGenerateAudioOnAdd).toBe(true);
    expect(migrated?.books[0].chapters[0].volumeName).toBeUndefined();
  });

  it("builds normalized full snapshot from app state input", () => {
    const snapshot = buildFullSnapshotV1({
      state: {
        books: [
          {
            id: "book-1",
            title: "Book",
            backend: StorageBackend.DRIVE,
            chapters: [
              {
                id: "ch-1",
                index: 1,
                title: "Chapter 1",
                filename: "c_1.txt",
                wordCount: 10,
                progress: 0,
                progressChars: 0,
                audioStatus: AudioStatus.NONE,
                volumeName: "  Book 1  ",
              },
            ],
            rules: [],
            settings: {
              useBookSettings: false,
              highlightMode: HighlightMode.SENTENCE,
            },
            updatedAt: 100,
          },
        ],
        playbackSpeed: 1,
        theme: Theme.DARK,
        currentOffsetChars: 0,
        debugMode: false,
        readerSettings: {
          fontFamily: "serif",
          fontSizePx: 20,
          lineHeight: 1.5,
          paragraphSpacing: 1,
          reflowLineBreaks: true,
          highlightColor: "#4f46e5",
          followHighlight: true,
          uiMode: "mobile",
        },
        keepAwake: false,
        autoSaveInterval: 30,
        globalRules: [],
        showDiagnostics: false,
        backupSettings: {
          autoBackupToDrive: false,
          autoBackupToDevice: false,
          backupIntervalMin: 30,
          keepDriveBackups: 10,
          keepLocalBackups: 10,
        },
      },
      preferences: {},
      readerProgress: {},
      jobs: [],
      attachments: [],
    });

    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot.books[0].settings.autoGenerateAudioOnAdd).toBe(true);
    expect(snapshot.chapters[0].volumeName).toBe("Book 1");
  });
});
