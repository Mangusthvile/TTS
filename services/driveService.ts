
export async function authenticateDrive(): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = (window as any).google.accounts.oauth2.initTokenClient({
      client_id: 'YOUR_CLIENT_ID.apps.googleusercontent.com', // Note: In production this is injected
      scope: 'https://www.googleapis.com/auth/drive.file',
      callback: (response: any) => {
        if (response.error) reject(response.error);
        resolve(response.access_token);
      },
    });
    client.requestAccessToken();
  });
}

export async function fetchDriveFile(token: string, fileId: string): Promise<string> {
  const response = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (response.status === 401) throw new Error('UNAUTHORIZED');
  return response.text();
}

export async function uploadToDrive(token: string, folderId: string, filename: string, content: string): Promise<string> {
  const metadata = {
    name: filename,
    parents: [folderId],
    mimeType: 'text/plain'
  };

  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.append('file', new Blob([content], { type: 'text/plain' }));

  const response = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form
  });

  const data = await response.json();
  return data.id;
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
