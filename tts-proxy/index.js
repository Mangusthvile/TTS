import express from "express";
import { TextToSpeechClient } from "@google-cloud/text-to-speech";

const client = new TextToSpeechClient();

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 500;

async function synthesizeWithRetry(text, voiceName, speakingRate, languageCode) {
  const request = {
    input: { text: text || "" },
    voice: {
      languageCode: languageCode || "en-US",
      name: voiceName || undefined,
    },
    audioConfig: {
      audioEncoding: "MP3",
      speakingRate: typeof speakingRate === "number" ? speakingRate : 1.0,
    },
  };

  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const [response] = await client.synthesizeSpeech(request);
      return response;
    } catch (err) {
      lastError = err;
      if (attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      }
    }
  }
  throw lastError;
}

const app = express();

// Parse JSON body first (no path = runs for every request)
app.use(express.json({ limit: "64kb" }));

app.use((req, res, next) => {
  if (req.method === 'GET') return next();
  const expectedKey = process.env.TTS_API_KEY;
  if (!expectedKey) {
    return res.status(500).json({ error: 'Server misconfiguration: TTS_API_KEY not set' });
  }
  const providedKey = req.headers['x-api-key'];
  if (!providedKey || providedKey !== expectedKey) {
    return res.status(401).json({ error: 'Missing or invalid x-api-key' });
  }
  next();
});

async function handleSynthesize(req, res) {
  try {
    const { text, voiceName, speakingRate, languageCode } = req.body || {};
    const response = await synthesizeWithRetry(text, voiceName, speakingRate, languageCode);
    // Client expects JSON with base64 audioContent (Google TTS format)
    const audioContent = response.audioContent
      ? Buffer.from(response.audioContent).toString("base64")
      : null;
    res.status(200).json({ audioContent });
  } catch (err) {
    console.error("TTS proxy error:", err);
    res.status(500).json({ error: err.message || "TTS synthesis failed" });
  }
}

// Routes registered AFTER middleware so both go through apiKeyMiddleware
app.post("/", handleSynthesize);
app.post("/v1/text:synthesize", handleSynthesize);

const port = Number(process.env.PORT) || 8080;
app.listen(port, () => {
  console.log(`TTS proxy listening on port ${port}`);
});
