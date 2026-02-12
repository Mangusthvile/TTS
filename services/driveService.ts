import { Capacitor } from '@capacitor/core';
import { driveFetch, getValidDriveToken } from './driveAuth';
import { driveRetry, DriveRetryOptions } from './driveRetry';

export function buildMp3Name(bookId: string, chapterIdOrIndex: string | number): string {
  // New format: stable IDs (works even if chapter title changes)
  return `c_${String(chapterIdOrIndex)}.mp3`;
}

export function buildTextName(
  bookId: string,
  chapterIdOrIndex: string | number,
  format: "text" | "markdown" = "text"
): string {
  // New format: stable IDs (works even if chapter title changes)
  const ext = format === "markdown" ? "md" : "txt";
  return `c_${String(chapterIdOrIndex)}.${ext}`;
}

export function u8ToArrayBuffer(u8: Uint8Array): ArrayBuffer {
  const ab = new ArrayBuffer(u8.byteLength);
  new Uint8Array(ab).set(u8);
  return ab;
}

export async function driveFetchWithRetry(
  label: string,
  input: RequestInfo,
  init: RequestInit = {},
  opts?: DriveRetryOptions
): Promise<Response> {
  return driveRetry(() => driveFetch(input, init), label, opts);
}

export async function checkFileExists(fileId: string): Promise<boolean> {
  if (!fileId) return false;
  try {
    const url = `https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,trashed&supportsAllDrives=true`;
    const response = await driveFetchWithRetry("checkFileExists", url);
    if (!response.ok) return false;
    const data = await response.json();
    return data && !data.trashed;
  } catch (e) {
    return false;
  }
}

export async function moveFile(fileId: string, currentParentId: string, newParentId: string): Promise<void> {
  const url = `https://www.googleapis.com/drive/v3/files/${fileId}?addParents=${newParentId}&removeParents=${currentParentId}&supportsAllDrives=true`;
  const response = await driveFetchWithRetry("moveFile", url, { method: 'PATCH' });
  if (!response.ok) throw new Error("MOVE_FAILED");
}

// Send a Drive file to the user's trash (true trash), NOT your app "_trash" folder.
export async function moveFileToTrash(fileId: string): Promise<void> {
  if (!fileId) return;

  const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?supportsAllDrives=true`;

  const response = await driveFetchWithRetry("moveFileToTrash", url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ trashed: true })
  });

  if (!response.ok && response.status !== 404) {
    throw new Error(`TRASH_FAILED: ${response.status}`);
  }
}

export async function copyDriveFile(
  sourceFileId: string,
  destFolderId: string,
  newName: string
): Promise<string> {
  const res = await driveFetchWithRetry(
    "copyDriveFile",
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(sourceFileId)}/copy?supportsAllDrives=true`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: newName,
        parents: [destFolderId],
      }),
    }
  );

  const json = await res.json().catch(() => ({} as any));
  if (!json?.id) throw new Error("Drive copy failed");
  return json.id as string;
}

/**
 * Native-safe Drive "picker":
 * - On Android/iOS (Capacitor), Google Picker is not reliable.
 * - We auto-create (or reuse) a root folder named "TaleVox" in Drive root.
 * - On web/desktop, we keep using Google Picker.
 */
export async function openFolderPicker(title = 'Select TaleVox Root Folder'): Promise<{ id: string, name: string } | null> {
  if (Capacitor.isNativePlatform()) {
    // Native path: create or reuse a stable root folder.
    return ensureNativeRootFolder();
  }

  const apiKey = (import.meta as any).env?.VITE_GOOGLE_API_KEY;
  if (!apiKey) throw new Error("Missing VITE_GOOGLE_API_KEY");

  const token = await getValidDriveToken();

  return new Promise((resolve, reject) => {
    const gapi = (window as any).gapi;
    if (!gapi) return reject(new Error("GAPI_NOT_LOADED"));

    gapi.load('picker', async () => {
      const google = (window as any).google;
      if (!google?.picker) {
        let retries = 0;
        while (!google?.picker && retries < 15) {
          await new Promise(r => setTimeout(r, 100));
          retries++;
        }
      }

      if (!google?.picker?.PickerBuilder) return reject(new Error("PICKER_NAMESPACE_MISSING"));

      const pickerCallback = (data: any) => {
        try {
          if (data.action === google.picker.Action.PICKED) {
            const doc = data.docs[0];
            resolve({ id: doc.id, name: doc.name });
          } else if (data.action === google.picker.Action.CANCEL) {
            resolve(null);
          }
        } catch (e) {
          reject(e);
        }
      };

      try {
        const view = new google.picker.DocsView(google.picker.ViewId.FOLDERS);
        view.setSelectFolderEnabled(true);
        view.setMimeTypes('application/vnd.google-apps.folder');

        const picker = new google.picker.PickerBuilder()
          .addView(view)
          .setOAuthToken(token)
          .setDeveloperKey(apiKey)
          .setCallback(pickerCallback)
          .setTitle(title)
          // Helps on some hosts
          .setOrigin(window.location.origin)
          .build();

        picker.setVisible(true);
      } catch (err) {
        reject(err);
      }
    });
  });
}

/**
 * Creates or reuses Drive root folder "TaleVox".
 * Works on native because it uses Drive API, not Google Picker.
 */
async function ensureNativeRootFolder(): Promise<{ id: string, name: string }> {
  // Ensure we have a token first (also forces sign-in if needed)
  await getValidDriveToken({ interactive: true });

  // Try to find an existing folder named "TaleVox" in Drive root
  const name = "TaleVox";
  const qStr =
    `'root' in parents and ` +
    `name = '${name.replace(/'/g, "\\'")}' and ` +
    `mimeType = 'application/vnd.google-apps.folder' and trashed = false`;

  const q = encodeURIComponent(qStr);
  const url =
    `https://www.googleapis.com/drive/v3/files` +
    `?q=${q}` +
    `&fields=files(id,name,modifiedTime)` +
    `&orderBy=modifiedTime desc` +
    `&pageSize=5` +
    `&supportsAllDrives=true` +
    `&includeItemsFromAllDrives=true`;

  const res = await driveFetchWithRetry("ensureNativeRootFolder", url);
  if (!res.ok) {
    throw new Error(`NATIVE_ROOT_LOOKUP_FAILED:${res.status}`);
  }

  const data = await res.json();
  const existing = data?.files?.[0];
  if (existing?.id) {
    return { id: existing.id, name: existing.name || name };
  }

  // Create if not found
  const id = await createDriveFolder(name);
  return { id, name };
}

/**
 * Helper to fetch all pages of a Drive API list request.
 * Required for libraries > 1000 files.
 */
async function fetchAllPages(url: string, label: string): Promise<any[]> {
  let files: any[] = [];
  let pageToken: string | null = null;

  do {
    const pageUrl: string = pageToken
      ? (url.includes('?') ? `${url}&pageToken=${pageToken}` : `${url}?pageToken=${pageToken}`)
      : url;

    const response = await driveFetchWithRetry(label, pageUrl);
    if (!response.ok) throw new Error(`DRIVE_LIST_ERROR: ${response.status}`);

    const data = await response.json();
    if (data.files) files = files.concat(data.files);
    pageToken = data.nextPageToken;
  } while (pageToken);

  return files;
}

export async function listFilesInFolder(folderId: string): Promise<{ id: string, name: string, mimeType: string, modifiedTime: string }[]> {
  const q = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
  const url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=nextPageToken,files(id, name, mimeType, modifiedTime)&orderBy=name&pageSize=1000&includeItemsFromAllDrives=true&supportsAllDrives=true`;
  return fetchAllPages(url, "listFilesInFolder");
}

export async function listFoldersInFolder(folderId: string): Promise<{ id: string, name: string, modifiedTime: string }[]> {
  const q = encodeURIComponent(`'${folderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`);
  const url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=nextPageToken,files(id, name, modifiedTime)&orderBy=name&pageSize=1000&includeItemsFromAllDrives=true&supportsAllDrives=true`;
  return fetchAllPages(url, "listFoldersInFolder");
}

export async function listFilesSortedByModified(folderId: string): Promise<{ id: string, name: string, mimeType: string, modifiedTime: string }[]> {
  const q = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
  const url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=nextPageToken,files(id, name, mimeType, modifiedTime)&orderBy=modifiedTime desc&pageSize=1000&includeItemsFromAllDrives=true&supportsAllDrives=true`;
  return fetchAllPages(url, "listFilesSortedByModified");
}

export async function listSaveFileCandidates(folderId: string): Promise<{ id: string, name: string, modifiedTime: string }[]> {
  const qStr = `'${folderId}' in parents and trashed = false and (name contains '.json' or name contains 'talevox')`;
  const q = encodeURIComponent(qStr);
  const url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id, name, modifiedTime)&orderBy=modifiedTime desc&pageSize=50&includeItemsFromAllDrives=true&supportsAllDrives=true`;
  const response = await driveFetchWithRetry("listSaveFileCandidates", url);
  if (!response.ok) throw new Error("DRIVE_LIST_CANDIDATES_ERROR");
  const data = await response.json();
  return data.files || [];
}

export async function findTaleVoxRoots(): Promise<{ id: string, name: string, hasState: boolean }[]> {
  const qStr = `mimeType = 'application/vnd.google-apps.folder' and trashed = false and (name contains 'TaleVox' or name contains 'talevox')`;
  const q = encodeURIComponent(qStr);
  const url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id, name, modifiedTime)&orderBy=modifiedTime desc&pageSize=20&includeItemsFromAllDrives=true&supportsAllDrives=true`;
  const response = await driveFetchWithRetry("findTaleVoxRoots", url);
  if (!response.ok) throw new Error("DRIVE_ROOT_SEARCH_ERROR");
  const data = await response.json();
  const folders = data.files || [];

  const results = [];
  for (const f of folders) {
    const saves = await listSaveFileCandidates(f.id).catch(() => []);
    results.push({ id: f.id, name: f.name, hasState: saves.length > 0 });
  }
  return results;
}

export async function findFileSync(name: string, parentId?: string): Promise<string | null> {
  let qStr = `name = '${name.replace(/'/g, "\\'")}' and trashed = false`;
  if (parentId) qStr += ` and '${parentId}' in parents`;
  const q = encodeURIComponent(qStr);

  const url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id, name, modifiedTime)&orderBy=modifiedTime desc&includeItemsFromAllDrives=true&supportsAllDrives=true`;
  const response = await driveFetchWithRetry("findFileSync", url);
  if (!response.ok) throw new Error("DRIVE_FIND_ERROR");
  const data = await response.json();
  return data.files && data.files.length > 0 ? data.files[0].id : null;
}

export async function resolveFolderIdByName(rootId: string, name: string): Promise<{ id: string; method: string }> {
  const qStr = `'${rootId}' in parents and name = '${name.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const q = encodeURIComponent(qStr);
  const url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id, name, modifiedTime)&includeItemsFromAllDrives=true&supportsAllDrives=true`;
  const response = await driveFetchWithRetry("resolveFolderIdByName", url);
  if (!response.ok) throw new Error(`RESOLVE_FOLDER_ERROR: ${response.status}`);
  const data = await response.json();
  const folders = data.files || [];

  if (folders.length === 0) {
    const newId = await createDriveFolder(name, rootId);
    return { id: newId, method: 'created' };
  }

  if (folders.length === 1) {
    return { id: folders[0].id, method: 'single_match' };
  }

  let bestId = folders[0].id;
  let newestSaveTime = 0;

  for (const folder of folders) {
    try {
      const candidates = await listSaveFileCandidates(folder.id);
      if (candidates.length > 0) {
        const time = new Date(candidates[0].modifiedTime).getTime();
        if (time > newestSaveTime) {
          newestSaveTime = time;
          bestId = folder.id;
        }
      }
    } catch (e) {
      console.warn("Failed checking duplicate folder content:", folder.id);
    }
  }

  return { id: bestId, method: `duplicate_resolved_newest_save_${bestId}` };
}

export async function fetchDriveFile(fileId: string): Promise<string> {
  const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`;
  const response = await driveFetchWithRetry("fetchDriveFile", url);
  if (!response.ok) throw new Error(`FETCH_FAILED: ${response.status}`);
  return response.text();
}

export async function fetchDriveBinary(fileId: string): Promise<Blob> {
  const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`;
  const response = await driveFetchWithRetry("fetchDriveBinary", url);
  if (!response.ok) throw new Error(`FETCH_BINARY_FAILED: ${response.status}`);
  return response.blob();
}

export async function deleteDriveFile(fileId: string): Promise<void> {
  const url = `https://www.googleapis.com/drive/v3/files/${fileId}?supportsAllDrives=true`;
  const response = await driveFetchWithRetry("deleteDriveFile", url, { method: 'DELETE' });
  if (!response.ok && response.status !== 404) throw new Error(`DELETE_FAILED: ${response.status}`);
}

export async function uploadToDrive(
  folderId: string | null,
  filename: string,
  content: string | Blob,
  existingFileId?: string,
  mimeType: string = 'text/plain'
): Promise<string> {
  const boundary = '-------talevox_sync_boundary';
  const metadata = {
    name: filename,
    mimeType: mimeType,
    parents: (folderId && !existingFileId) ? [folderId] : undefined
  };
  const metadataPart = '--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(metadata) + '\r\n';
  const mediaHeader = '--' + boundary + '\r\nContent-Type: ' + mimeType + '\r\n\r\n';
  const footer = '\r\n--' + boundary + '--';
  const encoder = new TextEncoder();
  const metadataBuffer = encoder.encode(metadataPart);
  const mediaHeaderBuffer = encoder.encode(mediaHeader);
  const footerBuffer = encoder.encode(footer);

  let mediaBuffer: Uint8Array;
  if (typeof content === 'string') {
    mediaBuffer = encoder.encode(content);
  } else {
    const ab = await content.arrayBuffer();
    mediaBuffer = new Uint8Array(ab);
  }

  const bodyBuffer = new Uint8Array(metadataBuffer.byteLength + mediaHeaderBuffer.byteLength + mediaBuffer.byteLength + footerBuffer.byteLength);
  let offset = 0;
  bodyBuffer.set(metadataBuffer, offset); offset += metadataBuffer.byteLength;
  bodyBuffer.set(mediaHeaderBuffer, offset); offset += mediaHeaderBuffer.byteLength;
  bodyBuffer.set(mediaBuffer, offset); offset += mediaBuffer.byteLength;
  bodyBuffer.set(footerBuffer, offset);

  const url = existingFileId
    ? `https://www.googleapis.com/upload/drive/v3/files/${existingFileId}?uploadType=multipart&supportsAllDrives=true`
    : `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id&supportsAllDrives=true`;

  const label = existingFileId ? "uploadDriveEdit" : "uploadDriveCreate";
  const response = await driveFetchWithRetry(label, url, {
    method: existingFileId ? 'PATCH' : 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body: bodyBuffer
  });

  if (!response.ok) throw new Error(`UPLOAD_FAILED: ${response.status}`);
  const data = await response.json();
  return data.id || existingFileId || '';
}

export async function createDriveFolder(name: string, parentId?: string): Promise<string> {
  const metadata: any = { name, mimeType: 'application/vnd.google-apps.folder' };
  if (parentId) metadata.parents = [parentId];

  const response = await driveFetchWithRetry("createDriveFolder", 'https://www.googleapis.com/drive/v3/files?supportsAllDrives=true', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(metadata)
  });

  if (!response.ok) throw new Error(`FOLDER_CREATION_FAILED: ${response.status}`);
  const data = await response.json();
  return data.id;
}

export async function ensureRootStructure(rootFolderId?: string) {
  if (!rootFolderId) {
    const root = await ensureNativeRootFolder();
    rootFolderId = root.id;
  }

  const subfolders = { booksId: '', trashId: '', savesId: '' };
  const mapping = [
    { name: 'books', key: 'booksId' },
    { name: 'trash', key: 'trashId' },
    { name: 'saves', key: 'savesId' }
  ];

  for (const item of mapping) {
    const res = await resolveFolderIdByName(rootFolderId, item.name);
    (subfolders as any)[item.key] = res.id;
  }
  return subfolders;
}

export async function ensureBookFolder(booksId: string, bookTitle: string) {
  const safeName = bookTitle.trim() || 'Untitled Book';
  const res = await resolveFolderIdByName(booksId, safeName);
  return res.id;
}

export function revokeObjectUrl(url: string | null | undefined) {
  if (!url) return;
  try { URL.revokeObjectURL(url); } catch {}
}

export async function getDriveAudioObjectUrl(fileId: string): Promise<{ url: string; blob: Blob }> {
  if (!fileId || !fileId.trim()) throw new Error("MISSING_FILE_ID");
  const blob = await fetchDriveBinary(fileId);
  if (!blob || blob.size === 0) throw new Error("EMPTY_AUDIO_BLOB");
  const url = URL.createObjectURL(blob);
  return { url, blob };
}
