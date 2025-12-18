/**
 * Talevox Google Drive Service
 * Handles authentication and file synchronization with enhanced error reporting.
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
        // Using requested scopes for specific app access + metadata reading for folder picking
        scope: 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.metadata.readonly',
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
 * Parses the response and returns a meaningful Error object if the status is not OK.
 */
async function getErrorFromResponse(response: Response, fallbackPrefix: string): Promise<Error> {
  let details = '';
  let reason = '';
  try {
    // Clone response so we can read it twice if needed
    const resClone = response.clone();
    const errorJson = await resClone.json();
    details = errorJson.error?.message || '';
    reason = errorJson.error?.errors?.[0]?.reason || '';
  } catch (e) {
    try { details = await response.text(); } catch (e2) {}
  }

  // 401: Token expired or invalid
  if (response.status === 401) {
    return new Error('Authentication token expired or invalid (401). Please re-link your Google account.');
  }

  // 403: Forbidden - often configuration or scope issues
  if (response.status === 403) {
    if (reason === 'accessNotConfigured') {
      return new Error('Google Drive API is not enabled for this project (403). You must enable "Google Drive API" in the Google Cloud Console.');
    }
    if (reason === 'insufficientPermissions') {
      return new Error('Insufficient permissions (403). The app does not have the required scopes. Try unlinking and re-linking your account to reset permissions.');
    }
    return new Error(`Access forbidden (403): ${details || 'Check your OAuth and GCP project settings.'}`);
  }

  // 404: Resource not found
  if (response.status === 404) {
    return new Error('Requested resource not found (404). The folder or file ID might be incorrect or has been deleted from Drive.');
  }

  // 429: Rate limit
  if (response.status === 429) {
    return new Error('Too many requests (429). Google Drive API rate limit reached. Please wait a moment before trying again.');
  }

  // General error with as much info as possible
  return new Error(`${details || fallbackPrefix} (HTTP ${response.status})`);
}

export async function listFolders(token: string): Promise<{id: string, name: string}[]> {
  const q = encodeURIComponent("mimeType = 'application/vnd.google-apps.folder' and trashed = false");
  const url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id, name)&orderBy=name&pageSize=100`;
  
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` }
  });
  
  if (!response.ok) {
    throw await getErrorFromResponse(response, 'DRIVE_LIST_ERROR');
  }
  
  const data = await response.json();
  return data.files || [];
}

export async function findFileSync(token: string, name: string): Promise<string | null> {
  const q = encodeURIComponent(`name = '${name}' and trashed = false`);
  const response = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id, name)`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  
  if (!response.ok) {
    throw await getErrorFromResponse(response, 'DRIVE_FIND_ERROR');
  }

  const data = await response.json();
  return data.files && data.files.length > 0 ? data.files[0].id : null;
}

export async function findFolderSync(token: string, name: string): Promise<string | null> {
  const q = encodeURIComponent(`name = '${name}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`);
  const response = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id, name)`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  
  if (!response.ok) return null; // Silently fail for discovery
  const data = await response.json();
  return data.files && data.files.length > 0 ? data.files[0].id : null;
}

export async function fetchDriveFile(token: string, fileId: string): Promise<string> {
  const response = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  
  if (!response.ok) {
    throw await getErrorFromResponse(response, 'FETCH_FAILED');
  }
  return response.text();
}

/**
 * Uploads a file using multipart/related to ensure metadata and content are updated safely.
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
  if (folderId && !existingFileId) metadata.parents = [folderId];

  const multipartRequestBody =
    delimiter +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    JSON.stringify(metadata) +
    delimiter +
    `Content-Type: ${mimeType}\r\n\r\n` +
    content +
    close_delim;

  const url = existingFileId 
    ? `https://www.googleapis.com/upload/drive/v3/files/${existingFileId}?uploadType=multipart`
    : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id';

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
  const response = await fetch('https://www.googleapis.com/drive/v3/files', {
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