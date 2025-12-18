
export async function authenticateDrive(): Promise<string> {
  return new Promise((resolve, reject) => {
    // In a real environment, the Client ID would be managed via environment variables
    const client = (window as any).google.accounts.oauth2.initTokenClient({
      client_id: '437202353724-placeholder.apps.googleusercontent.com', 
      scope: 'https://www.googleapis.com/auth/drive.file',
      callback: (response: any) => {
        if (response.error) reject(response.error);
        resolve(response.access_token);
      },
    });
    client.requestAccessToken();
  });
}

export async function findFileSync(token: string, name: string): Promise<string | null> {
  const q = encodeURIComponent(`name = '${name}' and trashed = false`);
  const response = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id, name)`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const data = await response.json();
  return data.files && data.files.length > 0 ? data.files[0].id : null;
}

export async function fetchDriveFile(token: string, fileId: string): Promise<string> {
  const response = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (response.status === 401) throw new Error('UNAUTHORIZED');
  return response.text();
}

export async function uploadToDrive(token: string, folderId: string | null, filename: string, content: string, existingFileId?: string): Promise<string> {
  const metadata: any = {
    name: filename,
    mimeType: 'application/json'
  };
  if (folderId) metadata.parents = [folderId];

  const url = existingFileId 
    ? `https://www.googleapis.com/upload/drive/v3/files/${existingFileId}?uploadType=multipart`
    : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id';

  const method = existingFileId ? 'PATCH' : 'POST';
  
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.append('file', new Blob([content], { type: 'application/json' }));

  const response = await fetch(url, {
    method: method,
    headers: { Authorization: `Bearer ${token}` },
    body: form
  });

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
  const data = await response.json();
  return data.id;
}
