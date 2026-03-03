import { Capacitor } from "@capacitor/core";
import { Filesystem, Directory } from "@capacitor/filesystem";

/** Attachments live under each book's folder: talevox/{bookId}/attachments/{filename}. */
const NEW_ATTACHMENTS_PREFIX = "talevox";
/** Legacy path was talevox/attachments/{bookId}/{filename}. */
const LEGACY_ATTACHMENTS_DIR = "talevox/attachments";

/** Build path for book-level attachment (new layout: book folder contains attachments subfolder). */
function buildAttachmentPath(bookId: string, filename: string): string {
  return `${NEW_ATTACHMENTS_PREFIX}/${bookId}/attachments/${filename}`;
}

function getNewAttachmentsDir(bookId: string): string {
  return `${NEW_ATTACHMENTS_PREFIX}/${bookId}/attachments`;
}

function getLegacyAttachmentsDir(bookId: string): string {
  return `${LEGACY_ATTACHMENTS_DIR}/${bookId}`;
}

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

export async function ensureAttachmentsDir(bookId: string): Promise<string> {
  const path = getNewAttachmentsDir(bookId);
  try {
    await Filesystem.mkdir({ path, directory: Directory.Data, recursive: true });
  } catch (e: any) {
    const msg = String(e?.message ?? e).toLowerCase();
    if (!msg.includes("already exists") && !msg.includes("exist") && !msg.includes("file exists")) {
      throw e;
    }
  }
  const legacyDir = getLegacyAttachmentsDir(bookId);
  try {
    const legacyList = await Filesystem.readdir({ path: legacyDir, directory: Directory.Data });
    const rawFiles = legacyList.files ?? [];
    const files = rawFiles.map((f) => (typeof f === "string" ? f : (f as { name: string }).name));
    if (files.length > 0) {
      for (const name of files) {
        if (name === "." || name === "..") continue;
        const legacyPath = `${legacyDir}/${name}`;
        const newPath = buildAttachmentPath(bookId, name);
        try {
          await Filesystem.readFile({ path: legacyPath, directory: Directory.Data }).then((r) =>
            Filesystem.writeFile({
              path: newPath,
              directory: Directory.Data,
              data: r.data,
              recursive: true,
            })
          );
        } catch {
          // skip failed copy
        }
      }
    }
  } catch {
    // legacy dir may not exist
  }
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
    const legacyPrefix = LEGACY_ATTACHMENTS_DIR + "/";
    if (localPath.startsWith(legacyPrefix)) {
      const after = localPath.slice(legacyPrefix.length);
      const slash = after.indexOf("/");
      if (slash > 0) {
        const bookId = after.slice(0, slash);
        const filename = after.slice(slash + 1);
        const newPath = buildAttachmentPath(bookId, filename);
        try {
          await Filesystem.stat({ path: newPath, directory: Directory.Data });
          return true;
        } catch {
          // ignore
        }
      }
    }
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
    const legacyPrefix = LEGACY_ATTACHMENTS_DIR + "/";
    if (localPath.startsWith(legacyPrefix)) {
      const after = localPath.slice(legacyPrefix.length);
      const slash = after.indexOf("/");
      if (slash > 0) {
        const bookId = after.slice(0, slash);
        const filename = after.slice(slash + 1);
        const newPath = buildAttachmentPath(bookId, filename);
        try {
          const res = await Filesystem.getUri({ path: newPath, directory: Directory.Data });
          if (res?.uri) return Capacitor.convertFileSrc(res.uri);
        } catch {
          // ignore
        }
      }
    }
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
