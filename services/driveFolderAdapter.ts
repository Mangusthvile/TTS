// services/driveFolderAdapter.ts

import type { FolderAdapter, FolderRef, FileRef } from "./folderAdapter";
import { createDriveFolder, listFilesInFolder, uploadToDrive, fetchDriveFile } from "./driveService";

const DRIVE_FOLDER_MIME = "application/vnd.google-apps.folder";

function pickNewest(files: { modifiedTime?: string }[]): number {
  let bestIdx = 0;
  let bestTime = 0;

  for (let i = 0; i < files.length; i++) {
    const t = Date.parse(files[i].modifiedTime ?? "");
    if (!Number.isNaN(t) && t >= bestTime) {
      bestTime = t;
      bestIdx = i;
    }
  }

  return bestIdx;
}

export function createDriveFolderAdapter(): FolderAdapter {
  return {
    backend: "drive",

    async ensureFolder(parent: FolderRef, name: string): Promise<FolderRef> {
      const items = await listFilesInFolder(parent.id);
      const matches = items.filter((f) => f.name === name && f.mimeType === DRIVE_FOLDER_MIME);

      if (matches.length > 0) {
        const chosen = matches[pickNewest(matches)];
        return { backend: "drive", id: chosen.id, name: chosen.name };
      }

      const id = await createDriveFolder(name, parent.id);
      return { backend: "drive", id, name };
    },

    async list(folder: FolderRef): Promise<FileRef[]> {
      const items = await listFilesInFolder(folder.id);
      return items.map((f) => ({
        backend: "drive",
        id: f.id,
        name: f.name,
        mimeType: f.mimeType,
        modifiedTime: f.modifiedTime
      }));
    },

    async findByName(folder: FolderRef, name: string): Promise<FileRef | null> {
      const items = await listFilesInFolder(folder.id);
      const matches = items.filter((f) => f.name === name);

      if (matches.length === 0) return null;

      const chosen = matches[pickNewest(matches)];
      return {
        backend: "drive",
        id: chosen.id,
        name: chosen.name,
        mimeType: chosen.mimeType,
        modifiedTime: chosen.modifiedTime
      };
    },

    async readText(file: FileRef): Promise<string> {
      return fetchDriveFile(file.id);
    },

    async writeText(folder: FolderRef, name: string, content: string, existing?: FileRef | null): Promise<FileRef> {
      const id = await uploadToDrive(folder.id, name, content, existing?.id, "application/json");
      return { backend: "drive", id, name, mimeType: "application/json" };
    }
  };
}
