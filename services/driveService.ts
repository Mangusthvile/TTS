/**
 * Talevox Google Drive Service
 * Handles authentication and file synchronization with official Google Picker integration.
 * Ensures strict scoping to user-selected folders.
 */

export async function authenticateDrive(explicitClientId?: string): Promise<string> {
  const CLIENT_ID = (explicitClientId?.trim()) || ((import.meta as any).env?.VITE_GOOGLE_CLIENT_ID) || 'YOUR_CLIENT_ID_HERE.apps.googleusercontent.com';

  if (!CLIENT_ID || CLIENT_ID.includes('YOUR_CLIENT_ID_HERE')) {
    throw new Error('MISSING_CLIENT_ID');
  }

  return new Promise((resolve, reject) => {
    try {
      if (!(window as any).google || !(window as any).google.accounts) {
        throw new Error('GSI_NOT_LOADED');
      }

      const client = (window as any).google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID,
        scope: 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.metadata.readonly https://www.googleapis.com/auth/drive.readonly',
        callback: (response: any) => {
          if (response.error) {
            console.error("GSI Error:", response);
            reject(new Error(response.error_description || response.error));
            return;
          }
          resolve(response.access_token);
        },
      });
      client.requestAccessToken();
    } catch (err) {
      reject(err);
    }
  });
}

export async function openFolderPicker(token: string): Promise<{id: string, name: string} | null> {
  const apiKey = (import.meta as any).env?.VITE_GOOGLE_API_KEY;
  if (!apiKey) throw new Error("Missing VITE_GOOGLE_API_KEY");

  return new Promise((resolve, reject) => {
    const gapi = (window as any).gapi;
    if (!gapi) return reject(new Error("GAPI_NOT_LOADED"));

    gapi.load('picker', async () => {
      const google = (window as any).google;
      if (!google.picker) await new Promise(r => setTimeout(r, 100));
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

  if (response.status === 401) return new Error('Authentication token expired (401).');
  if (response.status === 403) return new Error(`Access forbidden (403): ${details}`);
  if (response.status === 404) return new Error('Resource not found (404).');
  return new Error(`${details || fallbackPrefix} (HTTP ${response.status})`);
}

export async function listFilesInFolder(token: string, folderId: string): Promise<{id: string, name: string}[]> {
  const q = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
  const url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id, name, mimeType)&orderBy=name&pageSize=1000&includeItemsFromAllDrives=true&supportsAllDrives=true`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw await getErrorFromResponse(response, 'DRIVE_LIST_FILES_ERROR');
  const data = await response.json();
  return data.files || [];
}

export async function findFileSync(token: string, name: string): Promise<string | null> {
  const q = encodeURIComponent(`name = '${name}' and trashed = false`);
  const response = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id, name)&includeItemsFromAllDrives=true&supportsAllDrives=true`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!response.ok) throw await getErrorFromResponse(response, 'DRIVE_FIND_ERROR');
  const data = await response.json();
  return data.files && data.files.length > 0 ? data.files[0].id : null;
}

export async function fetchDriveFile(token: string, fileId: string): Promise<string> {
  const response = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!response.ok) throw await getErrorFromResponse(response, 'FETCH_FAILED');
  return response.text();
}

export async function fetchDriveBinary(token: string, fileId: string): Promise<Blob> {
  const response = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!response.ok) throw await getErrorFromResponse(response, 'FETCH_FAILED');
  return response.blob();
}

export async function deleteDriveFile(token: string, fileId: string): Promise<void> {
  const response = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!response.ok && response.status !== 404) throw await getErrorFromResponse(response, 'DELETE_FAILED');
}

/**
 * Uploads a file (text or binary Blob) using multipart/related for safe metadata + data packaging.
 */
export async function uploadToDrive(
  token: string, 
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

  // Construct binary payload safely
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

  const response = await fetch(url, {
    method: existingFileId ? 'PATCH' : 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/related; boundary=${boundary}`
    },
    body: bodyBuffer
  });

  if (!response.ok) throw await getErrorFromResponse(response, 'UPLOAD_FAILED');
  const data = await response.json();
  return data.id || existingFileId;
}

export async function createDriveFolder(token: string, name: string): Promise<string> {
  const response = await fetch('https://www.googleapis.com/drive/v3/files?supportsAllDrives=true', {
    method: 'POST',
    headers: { 
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder' })
  });
  if (!response.ok) throw await getErrorFromResponse(response, 'FOLDER_CREATION_FAILED');
  const data = await response.json();
  return data.id;
}