/**
 * Talevox Google Drive Service
 * Handles authentication and file synchronization with official Google Picker integration.
 * Ensures strict scoping to user-selected folders.
 */

export async function authenticateDrive(explicitClientId?: string): Promise<string> {
  const CLIENT_ID = (explicitClientId?.trim()) || (process.env as any).GOOGLE_CLIENT_ID || 'YOUR_CLIENT_ID_HERE.apps.googleusercontent.com';

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
        // Request drive.file for read/write access to files the app creates/opens
        // Request metadata.readonly to allow listing folders for picking
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

/**
 * Opens the native Google Picker to select a folder.
 */
export async function openFolderPicker(token: string): Promise<{id: string, name: string} | null> {
  return new Promise((resolve, reject) => {
    const gapi = (window as any).gapi;
    if (!gapi) return reject(new Error("GAPI_NOT_LOADED"));

    gapi.load('picker', () => {
      const pickerCallback = (data: any) => {
        if (data.action === gapi.picker.Action.PICKED) {
          const doc = data.docs[0];
          // Use doc.id for the unique Drive ID
          console.debug(`[Picker] Explicit Folder Selected: ${doc.name} (${doc.id})`);
          resolve({ id: doc.id, name: doc.name });
        } else if (data.action === gapi.picker.Action.CANCEL) {
          resolve(null);
        }
      };

      try {
        const view = new gapi.picker.DocsView(gapi.picker.ViewId.FOLDERS);
        view.setSelectFolderEnabled(true);
        view.setMimeTypes('application/vnd.google-apps.folder');

        const picker = new gapi.picker.PickerBuilder()
          .addView(view)
          .setOAuthToken(token)
          .setDeveloperKey(process.env.API_KEY)
          .setCallback(pickerCallback)
          .setTitle('Select Book Collection Folder')
          .build();
        
        picker.setVisible(true);
      } catch (err) {
        reject(err);
      }
    });
  });
}

/**
 * Parses the response and returns a meaningful Error object if the status is not OK.
 */
async function getErrorFromResponse(response: Response, fallbackPrefix: string): Promise<Error> {
  let details = '';
  let reason = '';
  try {
    const resClone = response.clone();
    const errorJson = await resClone.json();
    details = errorJson.error?.message || '';
    reason = errorJson.error?.errors?.[0]?.reason || '';
  } catch (e) {
    try { details = await response.text(); } catch (e2) {}
  }

  if (response.status === 401) {
    return new Error('Authentication token expired (401). Please re-link your Google account.');
  }

  if (response.status === 403) {
    return new Error(`Access forbidden (403): ${details || 'Ensure the Drive API is enabled in your Google Cloud Console.'}`);
  }

  if (response.status === 404) {
    return new Error('Resource not found (404). The folder or file might have been moved or deleted.');
  }

  return new Error(`${details || fallbackPrefix} (HTTP ${response.status})`);
}

/**
 * Lists files strictly within a specific folder ID.
 */
export async function listFilesInFolder(token: string, folderId: string): Promise<{id: string, name: string}[]> {
  const q = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
  const url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id, name, mimeType)&orderBy=name&pageSize=1000&includeItemsFromAllDrives=true&supportsAllDrives=true`;
  
  console.debug(`[Drive] FETCH: Listing children of Folder: ${folderId}`);
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` }
  });
  
  if (!response.ok) {
    throw await getErrorFromResponse(response, 'DRIVE_LIST_FILES_ERROR');
  }
  
  const data = await response.json();
  return data.files || [];
}

export async function findFileSync(token: string, name: string): Promise<string | null> {
  const q = encodeURIComponent(`name = '${name}' and trashed = false`);
  const response = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id, name)&includeItemsFromAllDrives=true&supportsAllDrives=true`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  
  if (!response.ok) {
    throw await getErrorFromResponse(response, 'DRIVE_FIND_ERROR');
  }

  const data = await response.json();
  return data.files && data.files.length > 0 ? data.files[0].id : null;
}

// Fix: Implement findFolderSync to allow specific searching for directory types in Google Drive
export async function findFolderSync(token: string, name: string): Promise<string | null> {
  const q = encodeURIComponent(`name = '${name}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`);
  const response = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id, name)&includeItemsFromAllDrives=true&supportsAllDrives=true`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  
  if (!response.ok) {
    throw await getErrorFromResponse(response, 'DRIVE_FIND_FOLDER_ERROR');
  }

  const data = await response.json();
  return data.files && data.files.length > 0 ? data.files[0].id : null;
}

export async function fetchDriveFile(token: string, fileId: string): Promise<string> {
  const response = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  
  if (!response.ok) {
    throw await getErrorFromResponse(response, 'FETCH_FAILED');
  }
  return response.text();
}

/**
 * Uploads a file using multipart/related. Ensures the file is placed in the correct book-specific folder.
 */
export async function uploadToDrive(
  token: string, 
  folderId: string | null, 
  filename: string, 
  content: string, 
  existingFileId?: string,
  mimeType: string = 'text/plain'
): Promise<string> {
  const boundary = '-------talevox_sync_boundary';
  const delimiter = "\r\n--" + boundary + "\r\n";
  const close_delim = "\r\n--" + boundary + "--";

  const metadata: any = {
    name: filename,
    mimeType: mimeType
  };
  
  // Strict scoping: always assign the parent folder ID for new files
  if (folderId && !existingFileId) {
    metadata.parents = [folderId];
    console.debug(`[Drive] CREATE: File '${filename}' in Folder: ${folderId}`);
  } else if (existingFileId) {
    console.debug(`[Drive] UPDATE: File ID: ${existingFileId}`);
  }

  const multipartRequestBody =
    delimiter +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    JSON.stringify(metadata) +
    delimiter +
    `Content-Type: ${mimeType}\r\n\r\n` +
    content +
    close_delim;

  const url = existingFileId 
    ? `https://www.googleapis.com/upload/drive/v3/files/${existingFileId}?uploadType=multipart&supportsAllDrives=true`
    : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id&supportsAllDrives=true';

  const method = existingFileId ? 'PATCH' : 'POST';

  const response = await fetch(url, {
    method: method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/related; boundary=${boundary}`
    },
    body: multipartRequestBody
  });

  if (!response.ok) {
    throw await getErrorFromResponse(response, 'UPLOAD_FAILED');
  }

  const data = await response.json();
  return data.id || existingFileId;
}

export async function createDriveFolder(token: string, name: string): Promise<string> {
  console.debug(`[Drive] Creating managed folder: ${name}`);
  const response = await fetch('https://www.googleapis.com/drive/v3/files?supportsAllDrives=true', {
    method: 'POST',
    headers: { 
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      name,
      mimeType: 'application/vnd.google-apps.folder'
    })
  });
  
  if (!response.ok) {
    throw await getErrorFromResponse(response, 'FOLDER_CREATION_FAILED');
  }

  const data = await response.json();
  return data.id;
}