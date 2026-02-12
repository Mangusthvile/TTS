// services/bookManifests.ts

export type FolderLayout = {
  meta: string;
  text: string;
  audio: string;
  trash: string;
};

export type BookManifest = {
  schemaVersion: "3.0";
  bookId: string;
  title: string;
  createdAt: number;
  backend: "drive" | "eternal";
  rootFolderId?: string;
  folders: FolderLayout;
};

export type InventoryChapter = {
  chapterId: string;
  idx: number;
  title: string;
  textName: string;
  audioName: string;
  volumeName?: string;
  volumeLocalChapter?: number;

  legacy?: {
    legacyIdx: number;
    legacyTextName?: string;
    legacyAudioName?: string;
  };
};

export type InventoryManifest = {
  schemaVersion: "3.0";
  bookId: string;
  expectedTotal?: number;
  chapters: InventoryChapter[];
};

export function safeParseJson<T>(raw: string, fallback: T): T {
  try {
    const v = JSON.parse(raw);
    return v as T;
  } catch {
    return fallback;
  }
}
