import { Capacitor } from "@capacitor/core";
import { Filesystem, Directory } from "@capacitor/filesystem";
import { appConfig } from "../src/config/appConfig";

const BASE_DIR = appConfig.paths.attachmentsDir;

function bytesToBase64(data: Uint8Array): string {
  const chunk = 0x8000;
  let binary = "";
  for (let i = 0; i < data.length; i += chunk) {
    const slice = data.subarray(i, i + chunk);
    binary += String.fromCharCode.apply(null, slice as any);
  }
  return btoa(binary);
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result === "string") {
        const parts = result.split(",");
        resolve(parts.length > 1 ? parts[1] : result);
      } else {
        reject(new Error("Invalid blob read result"));
      }
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function buildAttachmentPath(bookId: string, filename: string): string {
  return `${BASE_DIR}/${bookId}/${filename}`;
}

export async function ensureAttachmentsDir(bookId: string): Promise<string> {
  const path = `${BASE_DIR}/${bookId}`;
  await Filesystem.mkdir({ path, directory: Directory.Data, recursive: true });
  return path;
}

export async function saveAttachmentBytes(
  bookId: string,
  filename: string,
  bytes: Uint8Array
): Promise<{ localPath: string; sizeBytes: number }> {
  await ensureAttachmentsDir(bookId);
  const path = buildAttachmentPath(bookId, filename);
  const base64 = bytesToBase64(bytes);
  const res = await Filesystem.writeFile({
    path,
    directory: Directory.Data,
    data: base64,
    recursive: true,
  });
  return { localPath: res.uri ?? path, sizeBytes: bytes.length };
}

export async function saveAttachmentBlob(
  bookId: string,
  filename: string,
  blob: Blob
): Promise<{ localPath: string; sizeBytes: number }> {
  await ensureAttachmentsDir(bookId);
  const path = buildAttachmentPath(bookId, filename);
  const base64 = await blobToBase64(blob);
  const res = await Filesystem.writeFile({
    path,
    directory: Directory.Data,
    data: base64,
    recursive: true,
  });
  return { localPath: res.uri ?? path, sizeBytes: blob.size };
}

export async function attachmentExists(localPath?: string): Promise<boolean> {
  if (!localPath) return false;
  try {
    if (localPath.startsWith("file://") || localPath.startsWith("content://")) {
      await Filesystem.stat({ path: localPath });
      return true;
    }
    await Filesystem.stat({ path: localPath, directory: Directory.Data });
    return true;
  } catch {
    return false;
  }
}

export async function resolveAttachmentUri(localPath?: string): Promise<string | null> {
  if (!localPath) return null;
  try {
    if (localPath.startsWith("file://") || localPath.startsWith("content://")) {
      return Capacitor.convertFileSrc(localPath);
    }
    const res = await Filesystem.getUri({ path: localPath, directory: Directory.Data });
    if (!res?.uri) return null;
    return Capacitor.convertFileSrc(res.uri);
  } catch {
    return null;
  }
}

export function guessMimeType(filename: string, fallback = "application/pdf"): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  return fallback;
}
