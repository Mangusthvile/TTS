export interface CloudTtsResult {
  audioUrl: string;
  byteSize: number;
}

const DEFAULT_ENDPOINT = 'https://talevox-tts-762195576430.us-south1.run.app';

/**
 * Ensures the voice name is in a format the Cloud TTS service understands.
 * Cloud TTS expects strings like 'en-US-Standard-A' or 'en-GB-Wavenet-B'.
 */
export function sanitizeVoiceForCloud(voiceName: string | undefined): string {
  if (!voiceName) return "en-US-Standard-C";
  
  // If it's already a cloud-style identifier, return it
  if (/^[a-z]{2}-[A-Z]{2}-[a-zA-Z0-9]+-[A-Z]$/.test(voiceName)) return voiceName;

  // Fallback mappings for common system voices to cloud equivalents
  const lowName = voiceName.toLowerCase();
  if (lowName.includes('google') || lowName.includes('wavenet')) {
    if (lowName.includes('uk') || lowName.includes('gb')) return "en-GB-Wavenet-B";
    if (lowName.includes('au')) return "en-AU-Wavenet-B";
    return "en-US-Wavenet-D";
  }

  // Default to a high-quality standard voice
  return "en-US-Standard-C";
}

export async function synthesizeChunk(
  text: string,
  voiceName: string,
  speakingRate: number
): Promise<CloudTtsResult> {
  const endpoint = (import.meta as any).env?.VITE_TTS_ENDPOINT || DEFAULT_ENDPOINT;
  const cloudVoice = sanitizeVoiceForCloud(voiceName);

  console.info(`[TTS] Requesting Synthesis:`, { 
    voice: cloudVoice, 
    rate: speakingRate, 
    length: text.length 
  });

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        voiceName: cloudVoice,
        speakingRate,
        languageCode: 'en-US'
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error(`[TTS] Service responded with error:`, response.status, errText);
      throw new Error(`Cloud TTS Failed: ${response.status}`);
    }

    const data = await response.json();
    
    if (!data.audioBase64 || typeof data.audioBase64 !== 'string') {
      console.error(`[TTS] Invalid Response: No audioBase64 found in JSON.`);
      throw new Error("Invalid response: Service returned no audio data.");
    }

    // Convert base64 to Blob
    const binaryString = atob(data.audioBase64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    
    const blob = new Blob([bytes], { type: 'audio/mpeg' });
    const audioUrl = URL.createObjectURL(blob);

    console.info(`[TTS] Synthesis Success! Received ${bytes.length} bytes.`);

    return { 
      audioUrl,
      byteSize: bytes.length
    };
  } catch (err) {
    console.error(`[TTS] Critical error in synthesis pipe:`, err);
    throw err;
  }
}