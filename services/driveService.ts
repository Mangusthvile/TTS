
import { driveFetch, getValidDriveToken } from './driveAuth';

export const STATE_FILENAME = 'talevox_state.json';

export function buildMp3Name(chapterIndex: number, title: string) {
  const safe = (title || "untitled")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
  return `${chapterIndex.toString().padStart(3, '0')}_${safe}.mp3`;
}

export function buildTextName(chapterIndex: number, title: string) {
  const safe = (title || "untitled")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
  return `${chapterIndex.toString().padStart(3, '0')}_${safe}.txt`;
}

/**
 * Attempts to extract a chapter number from a filename using various common patterns.
 * e.g. "001_intro.txt" -> 1, "Chapter 5.mp3" -> 5, "ch-10.txt" -> 10
 */
export function inferChapterIndex(filename: string): number | null {
  const patterns = [
    /chapter[_ -]?(\d+)/i, // Chapter 1, Chapter_01
    /ch[_ -]?(\d+)/i,      // ch 1, ch-01
    /^(\d+)\s*[-_.]/i,     // 001 - Title, 001_Title
    /^(\d+)\.[a-z]+$/i,    // 001.txt
    /_(\d+)_/i,            // title_001_something
    /(\d+)$/i              // file123 (no extension check here, done by caller)
  ];

  for (const p of patterns) {
    const m = filename.match(p);
    if (m && m[1]) return parseInt(m[1], 10);
  }
  return null;
}

/**
 * Checks if a file looks like it belongs to a chapter based on extension and naming.
 * Used to prevent flagging valid files as 'stray'.
 */
export function isPlausibleChapterFile(filename: string): boolean {
    const ext = filename.split('.').pop()?.toLowerCase();
    if (!['txt', 'md', 'mp3', 'wav', 'm4a'].includes(ext || '')) return false;
    return inferChapterIndex(filename) !== null;
}

export async function moveFile(fileId: string, currentParentId: string, newParentId: string): Promise<void> {
  const url = `https://www.googleapis.com/drive/v3/files/${fileId}?addParents=${newParentId}&removeParents=${currentParentId}&supportsAllDrives=true`;
  const response = await driveFetch(url, { method: 'PATCH' });
  if (!response.ok) throw new Error("MOVE_FAILED");
}

export async function openFolderPicker(title = 'Select TaleVox Root Folder'): Promise<{id: string, name: string} | null> {
  const apiKey = (import.meta as any).env?.VITE_GOOGLE_API_KEY;
  if (!apiKey) throw new Error("Missing VITE_GOOGLE_API_KEY");

  const token = await getValidDriveToken();

  return new Promise((resolve, reject) => {
    const gapi = (window as any).gapi;
    if (!gapi) return reject(new Error("GAPI_NOT_LOADED"));

    gapi.load('picker', async () => {
      const google = (window as any).google;
      if (!google.picker) {
        let retries = 0;
        while (!google.picker && retries < 10) {
          await new Promise(r => setTimeout(r, 100));
          retries++;
        }
      }
      
      if (!google.picker || !google.picker.PickerBuilder) return reject(new Error("Picker API namespace missing."));
      
      const pickerCallback = (data: any) => {
        if (data.action === google.picker.Action.PICKED) {
          const doc = data.docs[0];
          resolve({ id: doc.id, name: doc.name });
        } else if (data.action === google.picker.Action.CANCEL) resolve(null);
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
          .build();
        picker.setVisible(true);
      } catch (err) { reject(err); }
    });
  });
}

export async function listFilesInFolder(folderId: string): Promise<{id: string, name: string, mimeType: string, modifiedTime: string}[]> {
  const q = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
  const url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id, name, mimeType, modifiedTime)&orderBy=name&pageSize=1000&includeItemsFromAllDrives=true&supportsAllDrives=true`;
  const response = await driveFetch(url);
  if (!response.ok) throw new Error("DRIVE_LIST_FILES_ERROR");
  const data = await response.json();
  return data.files || [];
}

export async function findFileSync(name: string, parentId?: string): Promise<string | null> {
  let qStr = `name = '${name.replace(/'/g, "\\'")}' and trashed = false`;
  if (parentId) qStr += ` and '${parentId}' in parents`;
  const q = encodeURIComponent(qStr);
  const response = await driveFetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id, name)&includeItemsFromAllDrives=true&supportsAllDrives=true`);
  if (!response.ok) throw new Error("DRIVE_FIND_ERROR");
  const data = await response.json();
  return data.files && data.files.length > 0 ? data.files[0].id : null;
}

export async function fetchDriveFile(fileId: string): Promise<string> {
  const response = await driveFetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`);
  if (!response.ok) throw new Error("FETCH_FAILED");
  return response.text();
}

export async function fetchDriveBinary(fileId: string): Promise<Blob> {
  const response = await driveFetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`);
  if (!response.ok) throw new Error("FETCH_FAILED");
  return response.blob();
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
    mediaBuffer = new Uint8Array(await content.arrayBuffer());
  }
  const bodyBuffer = new Uint8Array(metadataBuffer.byteLength + mediaHeaderBuffer.byteLength + mediaBuffer.byteLength + footerBuffer.byteLength);
  let offset = 0;
  bodyBuffer.set(metadataBuffer, offset); offset += metadataBuffer.byteLength;
  bodyBuffer.set(mediaHeaderBuffer, offset); offset += mediaHeaderBuffer.byteLength;
  bodyBuffer.set(mediaBuffer, offset); offset += mediaBuffer.byteLength;
  bodyBuffer.set(footerBuffer, offset);
  
  const url = existingFileId 
    ? `https://www.googleapis.com/upload/drive/v3/files/${existingFileId}?uploadType=multipart&supportsAllDrives=true`
    : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id&supportsAllDrives=true';
  
  const response = await driveFetch(url, {
    method: existingFileId ? 'PATCH' : 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body: bodyBuffer
  });
  
  if (!response.ok) throw new Error("UPLOAD_FAILED");
  const data = await response.json();
  return data.id || existingFileId || '';
}

export async function createDriveFolder(name: string, parentId?: string): Promise<string> {
  const metadata: any = { name, mimeType: 'application/vnd.google-apps.folder' };
  if (parentId) metadata.parents = [parentId];
  const response = await driveFetch('https://www.googleapis.com/drive/v3/files?supportsAllDrives=true', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(metadata)
  });
  if (!response.ok) throw new Error("FOLDER_CREATION_FAILED");
  const data = await response.json();
  return data.id;
}

/**
 * Robustly ensure root structure exists, supporting legacy folder names.
 */
export async function ensureRootStructure(rootId: string) {
  const q = encodeURIComponent(`'${rootId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`);
  const url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id, name)&pageSize=1000&supportsAllDrives=true`;
  const response = await driveFetch(url);
  if (!response.ok) throw new Error("ROOT_SCAN_FAILED");
  const data = await response.json();
  const folders = data.files || [];

  console.log(`[Drive] Root scan found ${folders.length} folders.`);

  const findId = (candidates: string[]) => {
    for (const c of candidates) {
        const exact = folders.find((f: any) => f.name === c);
        if (exact) return exact.id;
    }
    for (const c of candidates) {
        const loose = folders.find((f: any) => f.name.toLowerCase() === c.toLowerCase());
        if (loose) return loose.id;
    }
    return null;
  };

  let booksId = findId(['Books', 'books', 'book']);
  let trashId = findId(['Trash', 'trash', '_trash']);
  let savesId = findId(['Cloud Saves', 'cloud saves', 'Saves', 'saves']);

  if (!booksId) {
      console.log('[Drive] Creating canonical Books folder');
      booksId = await createDriveFolder('Books', rootId);
  } else {
      const match = folders.find((f:any) => f.id === booksId);
      console.log(`[Drive] Resolved Books folder: ${match?.name} (${booksId})`);
  }

  if (!trashId) trashId = await createDriveFolder('Trash', rootId);
  if (!savesId) savesId = await createDriveFolder('Cloud Saves', rootId);

  return { booksId, trashId, savesId };
}

export async function runLibraryMigration(rootId: string): Promise<{ message: string, movedCount: number }> {
  const structure = await ensureRootStructure(rootId);
  const canonicalBooksId = structure.booksId;
  
  const q = encodeURIComponent(`'${rootId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`);
  const url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id, name)&pageSize=1000&supportsAllDrives=true`;
  const response = await driveFetch(url);
  const folders = (await response.json()).files || [];

  let movedCount = 0;

  const canonicalFolder = folders.find((f: any) => f.id === canonicalBooksId);
  if (canonicalFolder && canonicalFolder.name !== 'Books') {
      await driveFetch(`https://www.googleapis.com/drive/v3/files/${canonicalBooksId}?supportsAllDrives=true`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Books' })
      });
  }

  const legacyContainers = folders.filter((f: any) => 
    f.id !== canonicalBooksId && 
    f.id !== structure.trashId && 
    f.id !== structure.savesId &&
    ['book', 'books'].includes(f.name.toLowerCase())
  );

  for (const legacy of legacyContainers) {
    const children = await listFilesInFolder(legacy.id);
    for (const child of children) {
      const exists = await findFileSync(child.name, canonicalBooksId);
      if (!exists) {
        await moveFile(child.id, legacy.id, canonicalBooksId);
        movedCount++;
      } else {
        console.log(`Skipping duplicate: ${child.name}`);
      }
    }
  }

  const strayFolders = folders.filter((f: any) => 
    f.id !== canonicalBooksId && 
    f.id !== structure.trashId && 
    f.id !== structure.savesId &&
    !['book', 'books'].includes(f.name.toLowerCase())
  );

  for (const stray of strayFolders) {
     const exists = await findFileSync(stray.name, canonicalBooksId);
     if (!exists) {
       await moveFile(stray.id, rootId, canonicalBooksId);
       movedCount++;
     }
  }

  return { message: `Migration Complete. Organized ${movedCount} items.`, movedCount };
}

export async function scanBooksInDrive(booksFolderId: string): Promise<{id: string, title: string}[]> {
  const folders = await listFilesInFolder(booksFolderId);
  return folders
    .filter(f => f.mimeType === 'application/vnd.google-apps.folder')
    .map(f => ({ id: f.id, title: f.name }));
}

export async function ensureBookFolder(booksId: string, bookTitle: string) {
  const safeName = bookTitle.trim() || 'Untitled Book';
  let id = await findFileSync(safeName, booksId);
  if (!id) id = await createDriveFolder(safeName, booksId);
  return id;
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
