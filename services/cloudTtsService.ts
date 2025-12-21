export interface CloudTtsResult {
  audioUrl: string;
  byteSize: number;
}

const DEFAULT_ENDPOINT = 'https://talevox-tts-762195576430.us-south1.run.app';
const MAX_TTS_CHARS = 4000;

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

/**
 * Helper to split long text into safe-sized chunks for TTS service.
 */
export function chunkTextForTTS(text: string, limit = MAX_TTS_CHARS): string[] {
  const cleaned = (text ?? "").replace(/\r\n/g, "\n").trim();
  if (!cleaned) return [];
  if (cleaned.length <= limit) return [cleaned];

  const chunks: string[] = [];
  let cur = "";

  const push = () => {
    const t = cur.trim();
    if (t) chunks.push(t);
    cur = "";
  };

  // split by paragraphs first
  const paras = cleaned.split(/\n{2,}/);

  for (const p of paras) {
    if (!p.trim()) continue;

    // if paragraph itself is too big, split by sentences
    if (p.length > limit) {
      const sentences = p.split(/(?<=[.!?。！？])\s+/);

      for (const s0 of sentences) {
        const s = s0.trim();
        if (!s) continue;

        // if sentence still too big, hard slice
        if (s.length > limit) {
          push();
          for (let i = 0; i < s.length; i += limit) {
            chunks.push(s.slice(i, i + limit));
          }
          continue;
        }

        const next = cur ? `${cur} ${s}` : s;
        if (next.length > limit) push();
        cur = cur ? `${cur} ${s}` : s;
      }

      push();
      continue;
    }

    const next = cur ? `${cur}\n\n${p}` : p;
    if (next.length > limit) push();
    cur = cur ? `${cur}\n\n${p}` : p;
  }

  push();
  return chunks;
}

function b64ToU8(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function concatU8(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/**
 * Remove ID3 tag if present at the start of an MP3 segment.
 * This ensures cleaner concatenation.
 */
function stripId3(u8: Uint8Array): Uint8Array {
  if (u8.length < 10) return u8;
  if (u8[0] === 0x49 && u8[1] === 0x44 && u8[2] === 0x33) {
    // ID3 size is "synchsafe" in bytes 6-9
    const size =
      ((u8[6] & 0x7f) << 21) |
      ((u8[7] & 0x7f) << 14) |
      ((u8[8] & 0x7f) << 7) |
      (u8[9] & 0x7f);
    const end = 10 + size;
    if (end < u8.length) return u8.slice(end);
  }
  return u8;
}

export async function synthesizeChunk(
  text: string,
  voiceName: string,
  speakingRate: number
): Promise<CloudTtsResult> {
  const endpoint = (import.meta as any).env?.VITE_TTS_ENDPOINT || DEFAULT_ENDPOINT;
  const cloudVoice = sanitizeVoiceForCloud(voiceName);

  const chunks = chunkTextForTTS(text);
  
  if (chunks.length > 1) {
    console.info(`[TTS] Text exceeds limit, split into ${chunks.length} chunks.`);
  }

  const audioParts: Uint8Array[] = [];

  try {
    for (let i = 0; i < chunks.length; i++) {
      const chunkText = chunks[i];
      
      console.info(`[TTS] Requesting Synthesis for chunk ${i + 1}/${chunks.length}:`, { 
        voice: cloudVoice, 
        rate: speakingRate, 
        length: chunkText.length 
      });

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: chunkText,
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

      let bytes = b64ToU8(data.audioBase64);
      
      // Strip ID3 tags from subsequent chunks to avoid player hiccups
      if (i > 0) {
        bytes = stripId3(bytes);
      }

      audioParts.push(bytes);
    }

    const mergedBytes = concatU8(audioParts);
    const blob = new Blob([mergedBytes], { type: 'audio/mpeg' });
    const audioUrl = URL.createObjectURL(blob);

    console.info(`[TTS] Synthesis Success! Total ${mergedBytes.length} bytes from ${chunks.length} chunks.`);

    return { 
      audioUrl,
      byteSize: mergedBytes.length
    };
  } catch (err) {
    console.error(`[TTS] Critical error in synthesis pipe:`, err);
    throw err;
  }
}