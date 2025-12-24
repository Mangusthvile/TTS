
import { driveFetch, getValidDriveToken } from './driveAuth';

/**
 * Talevox Google Drive Service
 * Handles file synchronization using centralized driveFetch.
 */

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
 * Guarantees a real ArrayBuffer, preventing TS SharedArrayBuffer errors.
 */
export function u8ToArrayBuffer(u8: Uint8Array): ArrayBuffer {
  const ab = new ArrayBuffer(u8.byteLength);
  new Uint8Array(ab).set(u8);
  return ab;
}

export async function checkFileExists(fileId: string): Promise<boolean> {
  if (!fileId) return false;
  try {
    const url = `https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,trashed&supportsAllDrives=true`;
    const response = await driveFetch(url);
    if (!response.ok) return false;
    const data = await response.json();
    return data && !data.trashed;
  } catch (e) {
    return false;
  }
}

export async function openFolderPicker(): Promise<{id: string, name: string} | null> {
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
          .setTitle('Select Book Collection Folder')
          .build();
        picker.setVisible(true);
      } catch (err) { reject(err); }
    });
  });
}

async function getErrorFromResponse(response: Response, fallbackPrefix: string): Promise<Error> {
  let details = '';
  try {
    const resClone = response.clone();
    const errorJson = await resClone.json();
    details = errorJson.error?.message || '';
  } catch (e) { try { details = await response.text(); } catch (e2) {} }

  if (response.status === 401) return new Error('Reconnect Google Drive');
  if (response.status === 403) return new Error(`Access forbidden (403): ${details}`);
  if (response.status === 404) return new Error('Resource not found (404).');
  return new Error(`${details || fallbackPrefix} (HTTP ${response.status})`);
}

export async function listFilesInFolder(folderId: string): Promise<{id: string, name: string, mimeType: string}[]> {
  const q = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
  const url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id, name, mimeType)&orderBy=name&pageSize=1000&includeItemsFromAllDrives=true&supportsAllDrives=true`;
  const response = await driveFetch(url);
  if (!response.ok) throw await getErrorFromResponse(response, 'DRIVE_LIST_FILES_ERROR');
  const data = await response.json();
  return data.files || [];
}

export async function findFileSync(name: string, parentId?: string): Promise<string | null> {
  let qStr = `name = '${name.replace(/'/g, "\\'")}' and trashed = false`;
  if (parentId) qStr += ` and '${parentId}' in parents`;
  const q = encodeURIComponent(qStr);
  const response = await driveFetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id, name)&includeItemsFromAllDrives=true&supportsAllDrives=true`);
  if (!response.ok) throw await getErrorFromResponse(response, 'DRIVE_FIND_ERROR');
  const data = await response.json();
  return data.files && data.files.length > 0 ? data.files[0].id : null;
}

export async function fetchDriveFile(fileId: string): Promise<string> {
  const response = await driveFetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`);
  if (!response.ok) throw await getErrorFromResponse(response, 'FETCH_FAILED');
  return response.text();
}

export async function fetchDriveBinary(fileId: string): Promise<Blob> {
  const response = await driveFetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`);
  if (!response.ok) throw await getErrorFromResponse(response, 'FETCH_FAILED');
  return response.blob();
}

export async function deleteDriveFile(fileId: string): Promise<void> {
  const response = await driveFetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
    method: 'DELETE'
  });
  if (!response.ok && response.status !== 404) throw await getErrorFromResponse(response, 'DELETE_FAILED');
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

  const metadataPart = '--' + boundary + '\r\n' +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    JSON.stringify(metadata) + '\r\n';

  const mediaHeader = '--' + boundary + '\r\n' +
    'Content-Type: ' + mimeType + '\r\n\r\n';
    
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

  const bodyBuffer = new Uint8Array(
    metadataBuffer.byteLength + mediaHeaderBuffer.byteLength + mediaBuffer.byteLength + footerBuffer.byteLength
  );
  
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
    headers: {
      'Content-Type': `multipart/related; boundary=${boundary}`
    },
    body: bodyBuffer
  });

  if (!response.ok) throw await getErrorFromResponse(response, 'UPLOAD_FAILED');
  const data = await response.json();
  return data.id || existingFileId || '';
}

export async function createDriveFolder(name: string, parentId?: string): Promise<string> {
  const metadata: any = { name, mimeType: 'application/vnd.google-apps.folder' };
  if (parentId) metadata.parents = [parentId];

  const response = await driveFetch('https://www.googleapis.com/drive/v3/files?supportsAllDrives=true', {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(metadata)
  });
  if (!response.ok) throw await getErrorFromResponse(response, 'FOLDER_CREATION_FAILED');
  const data = await response.json();
  return data.id;
}

export function revokeObjectUrl(url: string | null | undefined) {
  if (!url) return;
  try { URL.revokeObjectURL(url); } catch {}
}

export async function getDriveAudioObjectUrl(
  fileId: string
): Promise<{ url: string; blob: Blob }> {
  if (!fileId || !fileId.trim()) throw new Error("MISSING_FILE_ID");
  const blob = await fetchDriveBinary(fileId);
  if (!blob || blob.size === 0) throw new Error("EMPTY_AUDIO_BLOB");
  const url = URL.createObjectURL(blob);
  if (!url) throw new Error("FAILED_CREATE_OBJECT_URL");
  return { url, blob };
}
