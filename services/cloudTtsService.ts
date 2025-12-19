export interface CloudTtsResult {
  audioUrl: string;
}

export async function synthesizeChunk(
  text: string,
  voiceName: string,
  speakingRate: number
): Promise<CloudTtsResult> {
  const endpoint = (import.meta as any).env?.VITE_TTS_ENDPOINT;
  if (!endpoint) throw new Error("VITE_TTS_ENDPOINT is not configured.");

  // Using a simplified request for better compatibility with standard Cloud Run TTS wrappers
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text,
      voiceName,
      speakingRate,
      languageCode: 'en-US'
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Cloud TTS Failed: ${response.status} - ${errText}`);
  }

  const data = await response.json();
  
  if (!data.audioBase64) {
    throw new Error("Invalid response: missing audio data.");
  }

  // Convert base64 to Blob URL
  const binaryString = atob(data.audioBase64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  
  const blob = new Blob([bytes], { type: 'audio/mpeg' });
  const audioUrl = URL.createObjectURL(blob);

  return { audioUrl };
}