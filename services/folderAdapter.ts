// services/folderAdapter.ts

export type BackendKind = "drive" | "eternal";

export type FolderRef = {
  backend: BackendKind;
  id: string;
  name?: string;
};

export type FileRef = {
  backend: BackendKind;
  id: string;
  name: string;
  mimeType?: string;
  modifiedTime?: string;
};

export interface FolderAdapter {
  backend: BackendKind;

  ensureFolder(parent: FolderRef, name: string): Promise<FolderRef>;

  list(folder: FolderRef): Promise<FileRef[]>;

  findByName(folder: FolderRef, name: string): Promise<FileRef | null>;

  readText(file: FileRef): Promise<string>;

  writeText(folder: FolderRef, name: string, content: string, existing?: FileRef | null): Promise<FileRef>;
}
