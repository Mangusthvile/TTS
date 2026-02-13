import { describe, expect, it, vi } from "vitest";
import JSZip from "jszip";
import { AudioStatus, HighlightMode, StorageBackend, Theme, type AppState } from "../types";

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => false,
    getPlatform: () => "web",
    Plugins: {},
  },
}));

vi.mock("../services/storageSingleton", () => ({
  initStorage: vi.fn(async () => undefined),
  getStorage: vi.fn(() => ({
    listJobs: vi.fn(async () => ({ ok: true, value: [] })),
    listQueuedUploads: vi.fn(async () => ({ ok: true, value: [] })),
    getChapterAudioPath: vi.fn(async () => ({ ok: true, value: null })),
  })),
}));

const baseState: AppState = {
  books: [
    {
      id: "book-1",
      title: "Book One",
      chapters: [
        {
          id: "ch-1",
          index: 1,
          title: "Chapter One",
          filename: "ch-1.md",
          content: "Hello world",
          contentFormat: "markdown",
          wordCount: 2,
          progress: 0.5,
          progressChars: 10,
          audioStatus: AudioStatus.PENDING,
          updatedAt: Date.now(),
        },
      ],
      chapterCount: 1,
      backend: StorageBackend.DRIVE,
      rules: [],
      settings: {
        useBookSettings: false,
        highlightMode: HighlightMode.SENTENCE,
        autoGenerateAudioOnAdd: true,
      },
      updatedAt: Date.now(),
    },
  ],
  activeBookId: "book-1",
  playbackSpeed: 1,
  selectedVoiceName: "en-US-Standard-C",
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
    highlightEnabled: true,
    highlightMode: HighlightMode.SENTENCE,
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

describe("backupService", () => {
  it("creates a backup zip with expected core files", async () => {
    localStorage.setItem("talevox_prefs_v3", JSON.stringify({ theme: "dark" }));
    localStorage.setItem("talevox_drive_token_v2", "secret");

    const { createFullBackupZip } = await import("../services/backupService");
    const blob = await createFullBackupZip(
      {
        includeAudio: true,
        includeAttachments: true,
        includeChapterText: true,
        includeDiagnostics: true,
        includeOAuthTokens: false,
      },
      undefined,
      {
        state: baseState,
        preferences: { theme: "dark" },
        readerProgress: { "ch-1": { index: 10 } },
        legacyProgressStore: { books: {} },
      }
    );

    const zip = await JSZip.loadAsync(blob as any);
    expect(zip.file("meta.json")).toBeTruthy();
    expect(zip.file("prefs.json")).toBeTruthy();
    expect(zip.file("sqlite.json")).toBeTruthy();
    expect(zip.file("state/fullSnapshot.json")).toBeTruthy();
    expect(zip.file("state/storageDriver.json")).toBeTruthy();
    expect(zip.file("manifests/files.json")).toBeTruthy();

    const prefsRaw = await zip.file("prefs.json")!.async("text");
    const prefs = JSON.parse(prefsRaw) as Record<string, string>;
    expect(prefs["talevox_prefs_v3"]).toBeTruthy();
    expect(prefs["talevox_drive_token_v2"]).toBeUndefined();
  });

  it("includes oauth keys only when explicitly enabled", async () => {
    localStorage.setItem("talevox_drive_token_v2", "secret-token");
    const { createFullBackupZip } = await import("../services/backupService");
    const blob = await createFullBackupZip(
      {
        includeAudio: true,
        includeAttachments: true,
        includeChapterText: true,
        includeDiagnostics: true,
        includeOAuthTokens: true,
      },
      undefined,
      {
        state: baseState,
        preferences: {},
        readerProgress: {},
        legacyProgressStore: {},
      }
    );
    const zip = await JSZip.loadAsync(blob as any);
    const prefs = JSON.parse(await zip.file("prefs.json")!.async("text")) as Record<string, string>;
    expect(prefs["talevox_drive_token_v2"]).toBe("secret-token");
  });
});
