export interface CloudTtsResult {
  audioUrl: string;
  byteSize: number;
}

const DEFAULT_ENDPOINT = "https://talevox-tts-762195576430.us-south1.run.app";

/**
 * Your server is throwing 413, so 4000 chars is too aggressive in practice once JSON + punctuation + encoding is involved.
 * This is a safer default. The adaptive retry below will still split further if needed.
 */
const MAX_TTS_CHARS = 1800;
const MIN_TTS_CHARS = 250; // smallest chunk we will try before giving up

// --- Type helpers to keep TS + DOM Blob types happy ---
type U8 = Uint8Array<ArrayBuffer>;

function makeU8(len: number): U8 {
  // Force a real ArrayBuffer backing store
  return new Uint8Array(new ArrayBuffer(len)) as U8;
}

function toU8(u8: Uint8Array): U8 {
  // Ensure the returned typed array is definitely ArrayBuffer-backed
  if (u8.buffer instanceof ArrayBuffer) return u8 as unknown as U8;
  const out = makeU8(u8.byteLength);
  out.set(u8);
  return out;
}

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
  if (lowName.includes("google") || lowName.includes("wavenet")) {
    if (lowName.includes("uk") || lowName.includes("gb")) return "en-GB-Wavenet-B";
    if (lowName.includes("au")) return "en-AU-Wavenet-B";
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

  for (const p0 of paras) {
    const p = p0.trim();
    if (!p) continue;

    // if paragraph itself is too big, split by sentences
    if (p.length > limit) {
      // NOTE: lookbehind is fine in modern Chrome/Edge; if you ever need Safari support, we can rewrite this.
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
    cur = next;
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

/**
 * Convert Uint8Array -> ArrayBuffer (real ArrayBuffer, exact range)
 * Works even if input is a view with byteOffset/byteLength.
 */
function u8ToArrayBuffer(u8: Uint8Array): ArrayBuffer {
  // Always return a clean ArrayBuffer slice of the exact bytes
  if (u8.buffer instanceof ArrayBuffer) {
    return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
  }
  // SharedArrayBuffer (or other): copy into a fresh ArrayBuffer
  const copy = makeU8(u8.byteLength);
  copy.set(u8);
  return copy.buffer;
}

/**
 * Remove ID3 tag if present at the start of an MP3 segment.
 * This ensures cleaner concatenation.
 */
function stripId3(u8in: Uint8Array): Uint8Array {
  const u8 = u8in;
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

/**
 * Split a chunk roughly in half, preferring a clean boundary.
 * This is used when the server returns 413.
 */
function splitForRetry(text: string): [string, string] {
  const t = text.trim();
  if (t.length < 2) return [t, ""];
  const mid = Math.floor(t.length / 2);

  // Prefer splitting at a paragraph break, then newline, then sentence-ish punctuation, then space.
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

  const a = t.slice(0, cut).trim();
  const b = t.slice(cut).trim();
  return [a, b];
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
    console.error("[TTS] Service responded with error:", response.status, errText);

    // Surface 413 cleanly so we can retry-split.
    if (response.status === 413) {
      throw Object.assign(new Error("Cloud TTS Failed: 413"), { status: 413 });
    }

    throw Object.assign(new Error(`Cloud TTS Failed: ${response.status}`), {
      status: response.status,
      body: errText,
    });
  }

  const data = await response.json();

  if (!data.audioBase64 || typeof data.audioBase64 !== "string") {
    console.error("[TTS] Invalid Response: No audioBase64 found in JSON.");
    throw new Error("Invalid response: Service returned no audio data.");
  }

  return b64ToU8(data.audioBase64);
}

/**
 * Fetch a chunk, but if the server says 413, split and retry recursively.
 * Returns one-or-more MP3 segments (as Uint8Array) that should be concatenated.
 */
async function synthesizeWithAdaptiveSplit(
  endpoint: string,
  text: string,
  cloudVoice: string,
  speakingRate: number,
  depth = 0
): Promise<U8[]> {
  const t = text.trim();
  if (!t) return [];

  // Hard stop to avoid infinite recursion
  if (depth > 12) {
    throw new Error("Cloud TTS: chunk splitting exceeded max recursion depth.");
  }

  try {
    const bytes = await postTts(endpoint, t, cloudVoice, speakingRate);
    return [bytes];
  } catch (e: any) {
    if (e?.status === 413) {
      // If we're already very small, give up with a clear error
      if (t.length <= MIN_TTS_CHARS) {
        throw new Error(
          `Cloud TTS: server still returned 413 even after splitting (chunk length=${t.length}).`
        );
      }

      const [a, b] = splitForRetry(t);
      if (!a || !b) {
        // fallback: brute slice
        const mid = Math.floor(t.length / 2);
        const a2 = t.slice(0, mid).trim();
        const b2 = t.slice(mid).trim();
        return [
          ...(await synthesizeWithAdaptiveSplit(endpoint, a2, cloudVoice, speakingRate, depth + 1)),
          ...(await synthesizeWithAdaptiveSplit(endpoint, b2, cloudVoice, speakingRate, depth + 1)),
        ];
      }

      console.info(
        `[TTS] 413 received. Splitting chunk (${t.length} chars) -> (${a.length} + ${b.length}) and retrying.`
      );

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

  // initial chunking pass (safe default)
  const chunks = chunkTextForTTS(text, MAX_TTS_CHARS);

  if (chunks.length > 1) {
    console.info(`[TTS] Text split into ${chunks.length} base chunks (limit=${MAX_TTS_CHARS}).`);
  }

  const audioParts: Uint8Array[] = [];

  try {
    let segmentIndex = 0;

    for (let i = 0; i < chunks.length; i++) {
      const baseChunk = chunks[i];

      console.info(`[TTS] Requesting Synthesis base chunk ${i + 1}/${chunks.length}:`, {
        voice: cloudVoice,
        rate: speakingRate,
        length: baseChunk.length,
      });

      // adaptive split handles 413 automatically
      const segments = await synthesizeWithAdaptiveSplit(
        endpoint,
        baseChunk,
        cloudVoice,
        speakingRate
      );

      for (const seg of segments) {
        let bytes: Uint8Array = seg;

        // Strip ID3 from any segment after the very first MP3 segment overall
        if (segmentIndex > 0) bytes = stripId3(bytes);

        audioParts.push(bytes);
        segmentIndex++;
      }
    }

    const mergedBytes = concatU8(audioParts);

    // ✅ FIX: create Blob from a real ArrayBuffer slice (avoids TS BlobPart mismatch)
    const mp3Buffer = u8ToArrayBuffer(mergedBytes);
    const blob = new Blob([mp3Buffer], { type: "audio/mpeg" });

    const audioUrl = URL.createObjectURL(blob);

    console.info(
      `[TTS] Synthesis Success! Total ${mergedBytes.length} bytes from ${audioParts.length} segment(s).`
    );

    return {
      audioUrl,
      byteSize: mergedBytes.length,
    };
  } catch (err) {
    console.error("[TTS] Critical error in synthesis pipe:", err);
    throw err;
  }
}
