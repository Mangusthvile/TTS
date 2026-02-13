import { describe, expect, it } from "vitest";
import {
  AppState,
  AudioStatus,
  FullSnapshotV1,
  HighlightMode,
  StorageBackend,
  Theme,
} from "../types";
import { applyFullSnapshot } from "../services/saveRestoreService";

function makeState(): AppState {
  return {
    books: [
      {
        id: "book-1",
        title: "Book",
        backend: StorageBackend.DRIVE,
        chapters: [
          {
            id: "ch-1",
            index: 1,
            title: "Old title",
            filename: "c_1.txt",
            wordCount: 10,
            progress: 0,
            progressChars: 0,
            audioStatus: AudioStatus.PENDING,
            updatedAt: 100,
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
  };
}

describe("saveRestoreService.applyFullSnapshot", () => {
  it("merges newer incoming chapter data and preserves local-only chapters", () => {
    const currentState = makeState();
    currentState.books[0].chapters.push({
      id: "ch-local",
      index: 2,
      title: "Local only",
      filename: "c_2.txt",
      wordCount: 10,
      progress: 0,
      progressChars: 0,
      audioStatus: AudioStatus.NONE,
      updatedAt: 200,
    });

    const snapshot: FullSnapshotV1 = {
      schemaVersion: 1,
      createdAt: 2000,
      appVersion: "test",
      preferences: { activeBookId: "book-1" },
      readerProgress: {},
      globalRules: [],
      books: [
        {
          ...currentState.books[0],
          updatedAt: 300,
          chapters: [
            {
              ...currentState.books[0].chapters[0],
              title: "New title",
              updatedAt: 300,
            },
          ],
        },
      ],
      chapters: [],
      attachments: [],
      jobs: [],
    };

    const merged = applyFullSnapshot({
      snapshot,
      currentState,
      currentAttachments: [],
      currentJobs: [],
    });

    const book = merged.state.books[0];
    expect(book.chapters).toHaveLength(2);
    expect(book.chapters.find((c) => c.id === "ch-1")?.title).toBe("New title");
    expect(book.chapters.find((c) => c.id === "ch-local")?.title).toBe("Local only");
    expect(book.settings.autoGenerateAudioOnAdd).toBe(true);
  });
});
