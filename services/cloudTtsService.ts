
export interface CloudTtsResult {
  audioUrl: string;
  byteSize: number;
}

const DEFAULT_ENDPOINT = "https://talevox-tts-762195576430.us-south1.run.app";

/**
 * Google TTS enforces a 5000 BYTES limit (UTF-8).
 * 4500 is a safe threshold to account for JSON encapsulation and metadata overhead.
 */
const MAX_TTS_BYTES = 4500;
const MIN_TTS_BYTES = 600; // smallest chunk we will try before giving up

const encoder = new TextEncoder();
const byteLen = (s: string): number => encoder.encode(s).length;

// --- Type helpers to keep TS + DOM Blob types happy ---
type U8 = Uint8Array;

function makeU8(len: number): U8 {
  // Force a real ArrayBuffer backing store
  return new Uint8Array(new ArrayBuffer(len));
}

function toU8(u8: Uint8Array): U8 {
  // Ensure the returned typed array is definitely ArrayBuffer-backed
  if (u8.buffer instanceof ArrayBuffer) return u8;
  const out = makeU8(u8.byteLength);
  out.set(u8);
  return out;
}

/**
 * Ensures the voice name is in a format the Cloud TTS service understands.
 */
export function sanitizeVoiceForCloud(voiceName: string | undefined): string {
  if (!voiceName) return "en-US-Standard-C";
  if (/^[a-z]{2}-[A-Z]{2}-[a-zA-Z0-9]+-[A-Z]$/.test(voiceName)) return voiceName;
  const lowName = voiceName.toLowerCase();
  if (lowName.includes("google") || lowName.includes("wavenet")) {
    if (lowName.includes("uk") || lowName.includes("gb")) return "en-GB-Wavenet-B";
    if (lowName.includes("au")) return "en-AU-Wavenet-B";
    return "en-US-Wavenet-D";
  }
  return "en-US-Standard-C";
}

/**
 * Byte-aware chunking.
 */
export function chunkTextByUtf8Bytes(text: string, limitBytes = MAX_TTS_BYTES): string[] {
  const cleaned = (text ?? "").replace(/\r\n/g, "\n").trim();
  if (!cleaned) return [];
  if (byteLen(cleaned) <= limitBytes) return [cleaned];

  const chunks: string[] = [];
  let cur = "";

  const push = () => {
    const t = cur.trim();
    if (t) chunks.push(t);
    cur = "";
  };

  const paras = cleaned.split(/\n{2,}/);

  for (const p0 of paras) {
    const p = p0.trim();
    if (!p) continue;

    if (byteLen(p) > limitBytes) {
      const sentences = p.split(/(?<=[.!?。！？])\s+/);
      for (const s0 of sentences) {
        const s = s0.trim();
        if (!s) continue;

        if (byteLen(s) > limitBytes) {
          push();
          let start = 0;
          for (let i = 1; i <= s.length; i++) {
            const slice = s.substring(start, i);
            if (byteLen(slice) > limitBytes) {
              chunks.push(s.substring(start, i - 1).trim());
              start = i - 1;
            }
          }
          cur = s.substring(start);
          continue;
        }

        const next = cur ? `${cur} ${s}` : s;
        if (byteLen(next) > limitBytes) push();
        cur = cur ? (byteLen(cur) === 0 ? s : `${cur} ${s}`) : s;
      }
      push();
      continue;
    }

    const next = cur ? `${cur}\n\n${p}` : p;
    if (byteLen(next) > limitBytes) push();
    cur = cur ? (byteLen(cur) === 0 ? p : `${cur}\n\n${p}`) : p;
  }

  push();
  return chunks;
}

function b64ToU8(b64: string): U8 {
  const bin = atob(b64);
  const out = makeU8(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function concatU8(parts: Uint8Array[]): U8 {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = makeU8(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function u8ToArrayBuffer(u8: Uint8Array): ArrayBuffer {
  const ab = new ArrayBuffer(u8.byteLength);
  new Uint8Array(ab).set(u8);
  return ab;
}

function stripId3(u8in: Uint8Array): Uint8Array {
  const u8 = u8in;
  if (u8.length < 10) return u8;
  if (u8[0] === 0x49 && u8[1] === 0x44 && u8[2] === 0x33) {
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

function splitForRetry(text: string): [string, string] {
  const t = text.trim();
  if (t.length < 2) return [t, ""];
  const mid = Math.floor(t.length / 2);
  const candidates = [
    t.lastIndexOf("\n\n", mid),
    t.lastIndexOf("\n", mid),
    t.lastIndexOf(". ", mid),
    t.lastIndexOf("! ", mid),
    t.lastIndexOf("? ", mid),
    t.lastIndexOf("。", mid),
    t.lastIndexOf("！", mid),
    t.lastIndexOf("？", mid),
    t.lastIndexOf(" ", mid),
  ].filter((i) => i > 0);
  const cut = candidates.length ? Math.max(...candidates) : mid;
  return [t.slice(0, cut).trim(), t.slice(cut).trim()];
}

async function postTts(
  endpoint: string,
  chunkText: string,
  cloudVoice: string,
  speakingRate: number
): Promise<U8> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: chunkText,
      voiceName: cloudVoice,
      speakingRate,
      languageCode: "en-US",
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    const isOversize = response.status === 413 || 
      (response.status === 500 && errText.includes("longer than the limit of 5000 bytes"));
    if (isOversize) {
      throw Object.assign(new Error("TOO_LARGE"), { status: 413, tooLarge: true });
    }
    throw new Error(`Cloud TTS Failed: ${response.status}`);
  }
  const data = await response.json();
  if (!data.audioBase64) throw new Error("No audio data.");
  return b64ToU8(data.audioBase64);
}

async function synthesizeWithAdaptiveSplit(
  endpoint: string,
  text: string,
  cloudVoice: string,
  speakingRate: number,
  depth = 0
): Promise<U8[]> {
  const t = text.trim();
  if (!t) return [];
  if (depth > 12) throw new Error("Max recursion depth.");

  try {
    const bytes = await postTts(endpoint, t, cloudVoice, speakingRate);
    return [bytes];
  } catch (e: any) {
    if (e?.status === 413 || e?.tooLarge === true) {
      if (byteLen(t) <= MIN_TTS_BYTES) throw new Error("Small chunk still too large.");
      const [a, b] = splitForRetry(t);
      if (!a || !b) {
        const mid = Math.floor(t.length / 2);
        return [
          ...(await synthesizeWithAdaptiveSplit(endpoint, t.slice(0, mid).trim(), cloudVoice, speakingRate, depth + 1)),
          ...(await synthesizeWithAdaptiveSplit(endpoint, t.slice(mid).trim(), cloudVoice, speakingRate, depth + 1)),
        ];
      }
      return [
        ...(await synthesizeWithAdaptiveSplit(endpoint, a, cloudVoice, speakingRate, depth + 1)),
        ...(await synthesizeWithAdaptiveSplit(endpoint, b, cloudVoice, speakingRate, depth + 1)),
      ];
    }
    throw e;
  }
}

export async function synthesizeChunk(
  text: string,
  voiceName: string,
  speakingRate: number
): Promise<CloudTtsResult> {
  const endpoint = (import.meta as any).env?.VITE_TTS_ENDPOINT || DEFAULT_ENDPOINT;
  const cloudVoice = sanitizeVoiceForCloud(voiceName);
  const chunks = chunkTextByUtf8Bytes(text, MAX_TTS_BYTES);
  const audioParts: Uint8Array[] = [];

  try {
    let segmentIndex = 0;
    for (let i = 0; i < chunks.length; i++) {
      const baseChunk = chunks[i];
      const segments = await synthesizeWithAdaptiveSplit(endpoint, baseChunk, cloudVoice, speakingRate);
      for (const seg of segments) {
        let bytes: Uint8Array = seg;
        if (segmentIndex > 0) bytes = stripId3(bytes);
        audioParts.push(bytes);
        segmentIndex++;
      }
    }
    const mergedBytes = concatU8(audioParts);
    const mp3Buffer = u8ToArrayBuffer(mergedBytes);
    const blob = new Blob([mp3Buffer], { type: "audio/mpeg" });
    return { audioUrl: URL.createObjectURL(blob), byteSize: mergedBytes.length };
  } catch (err) {
    throw err;
  }
}
