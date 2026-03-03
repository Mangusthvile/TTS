import express from "express";
import { Firestore } from "@google-cloud/firestore";

const app = express();
app.use(express.json());

const db = new Firestore({
  databaseId: process.env.FIRESTORE_DATABASE_ID || "talevox-stores",
  ignoreUndefinedProperties: true,
});
const BATCH_JOBS_COLLECTION = "batchJobs";

function getNow() {
  return new Date();
}

app.post("/v1/batch-jobs", async (req, res) => {
  try {
    const {
      userId,
      bookId,
      chapterIds,
      voice,
      settings,
      driveRootFolderId,
      driveBookFolderId,
    } = req.body || {};

    if (!userId || !bookId || !Array.isArray(chapterIds) || chapterIds.length === 0) {
      return res.status(400).json({
        error: "Missing or invalid required fields: userId, bookId, chapterIds",
      });
    }

    const totalChapters = chapterIds.length;
    const payload = {
      userId,
      bookId,
      chapterIds,
      voice,
      settings,
      driveRootFolderId,
      driveBookFolderId,
    };

    const now = getNow();
    const docRef = db.collection(BATCH_JOBS_COLLECTION).doc();
    const jobId = docRef.id;

    const jobDoc = {
      jobId,
      status: "queued",
      totalChapters,
      completedChapters: 0,
      failedChapters: 0,
      lastChapterId: null,
      errorSummary: null,
      payload,
      createdAt: now,
      updatedAt: now,
    };

    await docRef.set(jobDoc);

    return res.status(201).json({
      jobId,
      status: jobDoc.status,
      totalChapters: jobDoc.totalChapters,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(err);
    // eslint-disable-next-line no-console
    console.error("Error creating batch job", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/v1/batch-jobs/:jobId", async (req, res) => {
  try {
    const { jobId } = req.params;
    const docRef = db.collection(BATCH_JOBS_COLLECTION).doc(jobId);
    const snapshot = await docRef.get();

    if (!snapshot.exists) {
      return res.status(404).json({ error: "Job not found" });
    }

    const data = snapshot.data();

    return res.json({
      jobId,
      ...data,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(err);
    // eslint-disable-next-line no-console
    console.error("Error fetching batch job", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/v1/batch-jobs/:jobId/cancel", async (req, res) => {
  try {
    const { jobId } = req.params;
    const docRef = db.collection(BATCH_JOBS_COLLECTION).doc(jobId);
    const snapshot = await docRef.get();

    if (!snapshot.exists) {
      return res.status(404).json({ error: "Job not found" });
    }

    const data = snapshot.data();
    if (data.status === "completed" || data.status === "failed" || data.status === "canceled") {
      return res.json({ jobId, status: data.status });
    }

    await docRef.update({
      status: "canceled",
      updatedAt: getNow(),
    });

    return res.json({ jobId, status: "canceled" });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

const TTS_DEFAULT_ENDPOINT =
  process.env.TTS_ENDPOINT || "https://talevox-tts-762195576430.us-south1.run.app";
const OPENAI_TTS_ENDPOINT = "https://api.openai.com/v1/audio/speech";
const OPENAI_TTS_MODEL =
  process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts-2025-12-15";

const MAX_TTS_BYTES = 4500;
const MAX_OPENAI_BYTES = 3000;

const textEncoder = new TextEncoder();
const utf8Len = (s) => textEncoder.encode(s || "").length;

function chunkTextByUtf8Bytes(text, limitBytes = MAX_TTS_BYTES) {
  const cleaned = (text || "").replace(/\r\n/g, "\n").trim();
  if (!cleaned) return [];
  if (utf8Len(cleaned) <= limitBytes) return [cleaned];

  const chunks = [];
  const paras = cleaned.split(/\n{2,}/);
  let cur = "";

  const push = () => {
    const t = cur.trim();
    if (t) chunks.push(t);
    cur = "";
  };

  for (const p0 of paras) {
    const p = p0.trim();
    if (!p) continue;

    if (utf8Len(p) > limitBytes) {
      const sentences = p.split(/(?<=[.!?。！？])\s+/);
      for (const s0 of sentences) {
        const s = s0.trim();
        if (!s) continue;

        if (utf8Len(s) > limitBytes) {
          push();
          let start = 0;
          for (let i = 1; i <= s.length; i += 1) {
            const slice = s.slice(start, i);
            if (utf8Len(slice) > limitBytes) {
              chunks.push(s.slice(start, i - 1).trim());
              start = i - 1;
            }
          }
          cur = s.slice(start);
          continue;
        }

        const next = cur ? `${cur} ${s}` : s;
        if (utf8Len(next) > limitBytes) push();
        cur = cur ? `${cur} ${s}` : s;
      }
      push();
      continue;
    }

    const next = cur ? `${cur}\n\n${p}` : p;
    if (utf8Len(next) > limitBytes) push();
    cur = cur ? `${cur}\n\n${p}` : p;
  }

  push();
  return chunks;
}

function resolveVoice(voice) {
  let provider = voice?.provider || null;
  let voiceId = voice?.id || "en-US-Standard-C";

  if (!provider || provider.length === 0) {
    if (voiceId.toLowerCase().startsWith("openai:")) {
      provider = "openai";
      voiceId = voiceId.slice("openai:".length);
    } else {
      provider = "google";
    }
  } else if (provider.toLowerCase() === "openai" && voiceId.toLowerCase().startsWith("openai:")) {
    voiceId = voiceId.slice("openai:".length);
  }

  return { provider: provider.toLowerCase(), id: voiceId };
}

function getSpeakingRate(settings) {
  if (!settings || typeof settings !== "object") return 1.0;
  if (typeof settings.playbackSpeed === "number") return settings.playbackSpeed || 1.0;
  if (typeof settings.speakingRate === "number") return settings.speakingRate || 1.0;
  return 1.0;
}

async function getServiceAccountAccessToken() {
  const url =
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
  const res = await fetch(url, {
    headers: { "Metadata-Flavor": "Google" },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch service account token: ${res.status}`);
  }
  const json = await res.json();
  if (!json.access_token) throw new Error("Metadata server response missing access_token");
  return json.access_token;
}

async function driveListFiles(accessToken, query) {
  const files = [];
  let pageToken = null;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const params = new URLSearchParams({
      q: query,
      fields: "nextPageToken,files(id,name,mimeType,modifiedTime)",
      pageSize: "1000",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
    });
    if (pageToken) params.set("pageToken", pageToken);

    const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params.toString()}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Drive list failed: ${res.status} ${text}`);
    }

    const json = await res.json();
    if (Array.isArray(json.files)) {
      for (const f of json.files) {
        files.push({
          id: f.id,
          name: f.name,
          mimeType: f.mimeType,
          modifiedTime: f.modifiedTime,
          isFolder: f.mimeType === "application/vnd.google-apps.folder",
        });
      }
    }
    pageToken = json.nextPageToken;
    if (!pageToken) break;
  }

  return files;
}

async function driveDownloadFile(accessToken, fileId) {
  const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
    fileId
  )}?alt=media&supportsAllDrives=true`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });
  const buf = await res.arrayBuffer();
  if (!res.ok) {
    const text = Buffer.from(buf).toString("utf8");
    throw new Error(`Drive download failed: ${res.status} ${text}`);
  }
  return Buffer.from(buf).toString("utf8");
}

async function findSubfolder(accessToken, rootId, name) {
  const escaped = name.replace(/'/g, "\\'");
  const q = `'${rootId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false and name = '${escaped}'`;
  const files = await driveListFiles(accessToken, q);
  const found = files.find((f) => f.name && f.name.toLowerCase() === name.toLowerCase());
  return found || null;
}

async function findFileInFolder(accessToken, folderId, filename) {
  const escaped = filename.replace(/'/g, "\\'");
  const q = `'${folderId}' in parents and trashed = false and name = '${escaped}'`;
  const files = await driveListFiles(accessToken, q);
  return files[0] || null;
}

async function createSubfolder(accessToken, rootId, name) {
  const body = {
    name,
    mimeType: "application/vnd.google-apps.folder",
    parents: [rootId],
  };

  const res = await fetch(
    "https://www.googleapis.com/drive/v3/files?supportsAllDrives=true&fields=id,name",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
      },
      body: JSON.stringify(body),
    }
  );

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Drive folder create failed: ${res.status} ${JSON.stringify(json)}`);
  }
  if (!json.id) {
    throw new Error("Drive folder create returned no id");
  }
  return json.id;
}

const driveFolderCache = new Map();

async function resolveChapterDriveFolder(accessToken, rootFolderId, volumeName) {
  const trimmed = typeof volumeName === "string" ? volumeName.trim() : "";
  if (!rootFolderId || !trimmed) return rootFolderId;
  const cacheKey = `${rootFolderId}::${trimmed.toLowerCase()}`;
  const cached = driveFolderCache.get(cacheKey);
  if (cached) return cached;

  let folder = await findSubfolder(accessToken, rootFolderId, trimmed);
  if (!folder) {
    folder = { id: await createSubfolder(accessToken, rootFolderId, trimmed) };
  }
  driveFolderCache.set(cacheKey, folder.id);
  return folder.id;
}

async function uploadMp3ToDrive(accessToken, folderId, filename, mp3Bytes) {
  const boundary = "-------talevox_sync_boundary";
  const metadata = {
    name: filename,
    mimeType: "audio/mpeg",
    parents: folderId ? [folderId] : undefined,
  };

  const metaPart = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(
    metadata
  )}\r\n`;
  const mediaHeader = `--${boundary}\r\nContent-Type: audio/mpeg\r\n\r\n`;
  const footer = `\r\n--${boundary}--`;

  const metaBytes = Buffer.from(metaPart, "utf8");
  const headerBytes = Buffer.from(mediaHeader, "utf8");
  const footerBytes = Buffer.from(footer, "utf8");

  const bodyBuffer = Buffer.concat([metaBytes, headerBytes, mp3Bytes, footerBytes]);

  const res = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id&supportsAllDrives=true",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body: bodyBuffer,
    }
  );

  const buf = await res.arrayBuffer();
  const text = Buffer.from(buf).toString("utf8");
  if (!res.ok) {
    throw new Error(`Drive upload failed: ${res.status} ${text}`);
  }
  const json = JSON.parse(text || "{}");
  return json.id || null;
}

async function synthesizeMp3(text, voiceConfig, speakingRate) {
  const isOpenAi = voiceConfig.provider === "openai";
  const maxBytes = isOpenAi ? MAX_OPENAI_BYTES : MAX_TTS_BYTES;
  const chunks = chunkTextByUtf8Bytes(text, maxBytes);
  const parts = [];

  if (isOpenAi) {
    const apiKey = (process.env.OPENAI_API_KEY || "").trim();
    if (!apiKey) {
      throw new Error("Missing OPENAI_API_KEY for OpenAI TTS.");
    }
    const speed = Math.max(0.5, Math.min(2.0, speakingRate || 1.0));
    // eslint-disable-next-line no-restricted-syntax
    for (const chunk of chunks) {
      const res = await fetch(OPENAI_TTS_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: OPENAI_TTS_MODEL,
          voice: voiceConfig.id,
          input: chunk,
          response_format: "mp3",
          speed,
        }),
      });
      const buf = await res.arrayBuffer();
      if (!res.ok) {
        const errText = Buffer.from(buf).toString("utf8");
        throw new Error(`OpenAI TTS Failed: ${res.status} ${errText}`);
      }
      let bytes = Buffer.from(buf);
      if (parts.length > 0) {
        bytes = stripId3(bytes);
      }
      parts.push(bytes);
    }
  } else {
    // eslint-disable-next-line no-restricted-syntax
    for (const chunk of chunks) {
      const res = await fetch(TTS_DEFAULT_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: chunk,
          voiceName: voiceConfig.id,
          speakingRate: speakingRate || 1.0,
          languageCode: "en-US",
        }),
      });
      const buf = await res.arrayBuffer();
      const bytes = Buffer.from(buf);
      if (!res.ok) {
        const errText = bytes.toString("utf8");
        throw new Error(`Cloud TTS Failed: ${res.status} ${errText}`);
      }
      const ct = res.headers.get("content-type") || "";
      let audioBytes = bytes;
      if (!ct.startsWith("audio/")) {
        const json = JSON.parse(bytes.toString("utf8") || "{}");
        const b64 = json.mp3Base64 || json.audioBase64 || json.audioContent;
        if (!b64 || typeof b64 !== "string") {
          throw new Error("TTS response missing base64 audio");
        }
        audioBytes = Buffer.from(b64, "base64");
      }
      parts.push(parts.length === 0 ? audioBytes : stripId3(audioBytes));
    }
  }

  return Buffer.concat(parts);
}

function stripId3(bytes) {
  if (!bytes || bytes.length < 10) return bytes;
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    const size =
      ((bytes[6] & 0x7f) << 21) |
      ((bytes[7] & 0x7f) << 14) |
      ((bytes[8] & 0x7f) << 7) |
      (bytes[9] & 0x7f);
    const end = 10 + size;
    if (end < bytes.length) {
      return bytes.subarray(end);
    }
  }
  return bytes;
}

const inventoryCache = new Map();

async function loadInventory(accessToken, driveBookFolderId) {
  if (!driveBookFolderId) {
    throw new Error("driveBookFolderId is required for Drive-based generation");
  }

  const cached = inventoryCache.get(driveBookFolderId);
  if (cached) return cached;

  const metaFolder = await findSubfolder(accessToken, driveBookFolderId, "meta");
  if (!metaFolder) {
    throw new Error("Meta folder not found under Drive book folder");
  }
  const inventoryFile = await findFileInFolder(accessToken, metaFolder.id, "inventory.json");
  if (!inventoryFile) {
    throw new Error("inventory.json not found in meta folder");
  }

  const raw = await driveDownloadFile(accessToken, inventoryFile.id);
  const inventory = JSON.parse(raw || "{}");
  const chapters = Array.isArray(inventory.chapters) ? inventory.chapters : [];
  const chaptersById = new Map();
  for (const ch of chapters) {
    if (ch && typeof ch.chapterId === "string") {
      chaptersById.set(ch.chapterId, ch);
    }
  }
  const value = { inventory, chapters, chaptersById };
  inventoryCache.set(driveBookFolderId, value);
  return value;
}

async function processJob(doc) {
  const docRef = doc.ref;
  const data = doc.data();

  const payload = data.payload || {};
  const chapterIds = Array.isArray(payload.chapterIds) ? payload.chapterIds : [];
  const totalChapters = data.totalChapters ?? chapterIds.length;
  let completedChapters = data.completedChapters ?? 0;
  let failedChapters = data.failedChapters ?? 0;

  if (!chapterIds.length || completedChapters >= totalChapters) {
    await docRef.update({
      status: "completed",
      updatedAt: getNow(),
    });
    return;
  }

  const driveBookFolderId = payload.driveBookFolderId;

  let accessToken = null;
  let inventory = null;

  if (driveBookFolderId) {
    try {
      accessToken = await getServiceAccountAccessToken();
      inventory = await loadInventory(accessToken, driveBookFolderId);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("Failed to initialize Drive/inventory for job", data.jobId, err);
      // If Drive init fails we still mark chapters as failed below.
    }
  }

  const startIndex = completedChapters;
  const endIndex = Math.min(startIndex + 5, totalChapters);

  let lastChapterId = data.lastChapterId ?? null;

  for (let index = startIndex; index < endIndex; index += 1) {
    const chapterId = chapterIds[index];

    try {
      if (!inventory || !accessToken) {
        throw new Error("Drive inventory or access token not initialized");
      }

      const invChapter = inventory.chaptersById.get(chapterId);
      if (!invChapter) {
        throw new Error(`Chapter ${chapterId} not found in inventory.json`);
      }

      const textName = invChapter.textName || `c_${chapterId}.txt`;
      const audioName = invChapter.audioName || `c_${chapterId}.mp3`;

      const textFile = await findFileInFolder(accessToken, driveBookFolderId, textName);
      if (!textFile) {
        throw new Error(`Text file ${textName} not found in Drive for chapter ${chapterId}`);
      }

      const content = await driveDownloadFile(accessToken, textFile.id);
      if (!content || !content.trim()) {
        throw new Error(`Empty chapter text for ${chapterId}`);
      }

      const voiceConfig = resolveVoice(payload.voice || {});
      const speakingRate = getSpeakingRate(payload.settings);
      const mp3Bytes = await synthesizeMp3(content, voiceConfig, speakingRate);

      const targetFolderId = await resolveChapterDriveFolder(
        accessToken,
        driveBookFolderId,
        invChapter.volumeName
      );

      await uploadMp3ToDrive(accessToken, targetFolderId, audioName, mp3Bytes);

      completedChapters += 1;
      lastChapterId = chapterId;
    } catch (err) {
      failedChapters += 1;
      // eslint-disable-next-line no-console
      console.error(`Error processing chapter ${chapterId} for job ${data.jobId}`, err);
      // For now we only log the error; errorSummary aggregation can be added later.
    }
  }

  const newStatus = completedChapters >= totalChapters ? "completed" : "running";

  await docRef.update({
    status: newStatus,
    completedChapters,
    failedChapters,
    lastChapterId,
    updatedAt: getNow(),
  });
}

app.post("/internal/process", async (req, res) => {
  try {
    const snapshot = await db
      .collection(BATCH_JOBS_COLLECTION)
      .where("status", "in", ["queued", "running"])
      .limit(3)
      .get();

    if (snapshot.empty) {
      return res.json({ processedJobs: 0 });
    }

    const jobs = snapshot.docs;

    // Process jobs sequentially to keep behavior simple and predictable
    // (can be parallelized later if needed).
    // eslint-disable-next-line no-restricted-syntax
    for (const jobDoc of jobs) {
      // eslint-disable-next-line no-await-in-loop
      await processJob(jobDoc);
    }

    return res.json({ processedJobs: jobs.length });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(err);
    // eslint-disable-next-line no-console
    console.error("Error processing batch jobs", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

const PORT = process.env.PORT || 8080;

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Cloud batch service listening on port ${PORT}`);
});

