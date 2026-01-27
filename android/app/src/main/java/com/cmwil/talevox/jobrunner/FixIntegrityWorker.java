
package com.cmwil.talevox.jobrunner;

import android.content.ContentValues;
import android.content.Context;
import android.database.sqlite.SQLiteDatabase;
import android.database.Cursor;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Notification;
import android.os.Build;
import android.util.Base64;

import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.work.ForegroundInfo;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import com.getcapacitor.JSObject;

import org.json.JSONArray;
import org.json.JSONObject;
import org.json.JSONException;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;
import java.util.regex.Matcher;

public class FixIntegrityWorker extends Worker {
    private static final String DB_NAME = "talevox_db";
    private static final String DEFAULT_ENDPOINT = "https://talevox-tts-762195576430.us-south1.run.app";
    private static final int MAX_TTS_BYTES = 4500;
    private static final int MAX_UPLOAD_RETRIES = 5;
    private static final String CHANNEL_ID = "talevox_jobs";

    public FixIntegrityWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        String jobId = getInputData().getString("jobId");
        if (jobId == null || jobId.isEmpty()) {
            return Result.failure();
        }

        try {
            JobRow job = loadJob(jobId);
            if (job == null) {
                return failJob(jobId, "Job not found", null);
            }

            JSONObject payload = job.payloadJson;
            if (payload == null) {
                return failJob(jobId, "Missing payload", null);
            }

            String bookId = payload.optString("bookId", null);
            String driveFolderId = payload.optString("driveFolderId", null);
            JSONObject options = payload.optJSONObject("options");
            boolean optGenAudio = options == null || options.optBoolean("genAudio", true);
            boolean optCleanup = options != null && options.optBoolean("cleanupStrays", true);
            boolean optConvert = options != null && options.optBoolean("convertLegacy", true);

            if (bookId == null || driveFolderId == null) {
                return failJob(jobId, "Missing bookId or driveFolderId", null);
            }

            String accessToken = loadDriveAccessToken();
            if (accessToken == null) {
                return failJob(jobId, "Missing Drive access token", null);
            }

            JSONObject progressJson = job.progressJson != null ? job.progressJson : new JSONObject();
            progressJson.put("startedAt", System.currentTimeMillis());
            updateJobProgress(jobId, "running", progressJson, null);
            showProgressNotification(jobId, "Fixing integrity", progressJson);

            DriveFolder metaFolder = findSubfolder(accessToken, driveFolderId, "meta");
            if (metaFolder == null) {
                return failJob(jobId, "Meta folder not found", progressJson);
            }

            DriveFile inventoryFile = findFileInFolder(accessToken, metaFolder.id, "inventory.json");
            if (inventoryFile == null) {
                return failJob(jobId, "inventory.json not found", progressJson);
            }

            String inventoryRaw = downloadDriveFile(accessToken, inventoryFile.id);
            JSONObject inventory = new JSONObject(inventoryRaw);
            JSONArray chapters = inventory.optJSONArray("chapters");
            if (chapters == null) {
                return failJob(jobId, "inventory.json missing chapters", progressJson);
            }

            List<DriveFile> rootFiles = listFilesInFolder(accessToken, driveFolderId);
            List<DriveFile> allFiles = new ArrayList<>(rootFiles);

            for (DriveFile f : rootFiles) {
                if (f.isFolder) {
                    if ("meta".equals(f.name) || "text".equals(f.name) || "audio".equals(f.name) || "trash".equals(f.name)) {
                        allFiles.addAll(listFilesInFolder(accessToken, f.id));
                    }
                }
            }

            Map<String, List<DriveFile>> filesByName = new HashMap<>();
            for (DriveFile f : allFiles) {
                if (f.name == null) continue;
                filesByName.computeIfAbsent(f.name, k -> new ArrayList<>()).add(f);
            }

            Set<String> expectedNames = new HashSet<>();
            List<InventoryChapter> invChapters = new ArrayList<>();
            for (int i = 0; i < chapters.length(); i++) {
                JSONObject ch = chapters.getJSONObject(i);
                InventoryChapter c = new InventoryChapter();
                c.chapterId = ch.optString("chapterId", null);
                c.idx = ch.optInt("idx", 0);
                c.title = ch.optString("title", "");
                c.textName = ch.optString("textName", "c_" + c.chapterId + ".txt");
                c.audioName = ch.optString("audioName", "c_" + c.chapterId + ".mp3");
                JSONObject legacy = ch.optJSONObject("legacy");
                if (legacy != null) {
                    c.legacyTextName = legacy.optString("legacyTextName", null);
                    c.legacyAudioName = legacy.optString("legacyAudioName", null);
                }
                if (c.chapterId != null) {
                    invChapters.add(c);
                    expectedNames.add(c.textName);
                    expectedNames.add(c.audioName);
                }
            }

            List<Conversion> conversions = new ArrayList<>();
            List<String> generationIds = new ArrayList<>();
            List<DriveFile> cleanupFiles = new ArrayList<>();

            if (optConvert) {
                for (InventoryChapter c : invChapters) {
                    if (!filesByName.containsKey(c.textName) && c.legacyTextName != null && filesByName.containsKey(c.legacyTextName)) {
                        conversions.add(new Conversion(c.chapterId, "text", c.legacyTextName, c.textName));
                    }
                    if (!filesByName.containsKey(c.audioName) && c.legacyAudioName != null && filesByName.containsKey(c.legacyAudioName)) {
                        conversions.add(new Conversion(c.chapterId, "audio", c.legacyAudioName, c.audioName));
                    }
                }
            }

            if (optGenAudio) {
                for (InventoryChapter c : invChapters) {
                    boolean hasAudio = filesByName.containsKey(c.audioName);
                    boolean hasText = filesByName.containsKey(c.textName);
                    if (!hasAudio && hasText) {
                        generationIds.add(c.chapterId);
                    }
                }
            }

            boolean safeToCleanup = false;
            int expectedTotal = inventory.optInt("expectedTotal", 0);
            if (expectedTotal > 0 && expectedTotal == invChapters.size()) {
                safeToCleanup = true;
            }

            if (optCleanup && safeToCleanup) {
                Set<String> allowed = new HashSet<>(expectedNames);
                allowed.add("book.json");
                allowed.add("inventory.json");
                allowed.add(".keep");
                allowed.add("cover.jpg");
                for (DriveFile f : allFiles) {
                    if (f.isFolder) continue;
                    if (f.name == null) continue;
                    if (!allowed.contains(f.name)) {
                        cleanupFiles.add(f);
                    }
                }
            }

            int totalSteps = conversions.size() + generationIds.size() + cleanupFiles.size();
            progressJson.put("total", totalSteps);
            progressJson.put("completed", 0);
            updateJobProgress(jobId, "running", progressJson, null);
            showProgressNotification(jobId, "Fixing integrity", progressJson);

            List<Rule> rules = loadRulesForBook(bookId);

            int completed = 0;

            for (Conversion conv : conversions) {
                if (isStopped()) return handleCanceled(jobId, progressJson);
                DriveFile legacy = pickNewest(filesByName.get(conv.sourceName));
                if (legacy != null) {
                    copyDriveFile(accessToken, legacy.id, driveFolderId, conv.targetName);
                }
                completed++;
                progressJson.put("completed", completed);
                progressJson.put("currentChapterId", conv.chapterId);
                updateJobProgress(jobId, "running", progressJson, null);
                emitProgress(jobId, "running", progressJson);
                showProgressNotification(jobId, "Fixing integrity", progressJson);
            }

            for (String chapterId : generationIds) {
                if (isStopped()) return handleCanceled(jobId, progressJson);
                progressJson.put("currentChapterId", chapterId);
                updateJobProgress(jobId, "running", progressJson, null);
                emitProgress(jobId, "running", progressJson);
                showProgressNotification(jobId, "Fixing integrity", progressJson);

                InventoryChapter inv = findInv(invChapters, chapterId);
                if (inv == null) continue;

                DriveFile textFile = pickNewest(filesByName.get(inv.textName));
                if (textFile == null) continue;

                String content = downloadDriveFile(accessToken, textFile.id);
                String processed = applyRules(content, rules);
                String voiceId = "en-US-Standard-C";
                JSONObject voice = payload.optJSONObject("voice");
                if (voice != null) {
                    String v = voice.optString("id", null);
                    if (v != null && !v.isEmpty()) voiceId = v;
                }

                double speakingRate = 1.0;
                JSONObject settings = payload.optJSONObject("settings");
                if (settings != null && settings.has("playbackSpeed")) {
                    speakingRate = settings.optDouble("playbackSpeed", 1.0);
                } else if (settings != null && settings.has("speakingRate")) {
                    speakingRate = settings.optDouble("speakingRate", 1.0);
                }

                byte[] mp3 = synthesizeMp3(processed, voiceId, speakingRate);
                String filePath = saveMp3ToFile(chapterId, mp3);

                String uploadedId = uploadToDriveWithRetry(accessToken, driveFolderId, inv.audioName, "audio/mpeg", mp3);
                updateChapterAudioStatus(bookId, chapterId, "ready", filePath, uploadedId);

                completed++;
                progressJson.put("completed", completed);
                updateJobProgress(jobId, "running", progressJson, null);
                emitProgress(jobId, "running", progressJson);
                showProgressNotification(jobId, "Fixing integrity", progressJson);
            }

            for (DriveFile stray : cleanupFiles) {
                if (isStopped()) return handleCanceled(jobId, progressJson);
                moveFileToTrash(accessToken, stray.id);
                completed++;
                progressJson.put("completed", completed);
                updateJobProgress(jobId, "running", progressJson, null);
                emitProgress(jobId, "running", progressJson);
                showProgressNotification(jobId, "Fixing integrity", progressJson);
            }

            progressJson.put("finishedAt", System.currentTimeMillis());
            progressJson.put("currentChapterId", JSONObject.NULL);
            updateJobProgress(jobId, "completed", progressJson, null);
            emitFinished(jobId, "completed", progressJson, null);
            showFinishedNotification(jobId, "Integrity fix complete");
            return Result.success();
        } catch (Exception e) {
            return failJob(jobId, e.getMessage(), null);
        }
    }
    private Result handleCanceled(String jobId, JSONObject progressJson) throws JSONException {
        progressJson.put("currentChapterId", JSONObject.NULL);
        updateJobProgress(jobId, "canceled", progressJson, null);
        emitFinished(jobId, "canceled", progressJson, null);
        showFinishedNotification(jobId, "Integrity fix canceled");
        return Result.failure();
    }

    private SQLiteDatabase getDb() {
        Context ctx = getApplicationContext();
        SQLiteDatabase db = ctx.openOrCreateDatabase(DB_NAME, Context.MODE_PRIVATE, null);
        db.execSQL(
            "CREATE TABLE IF NOT EXISTS jobs (" +
            "jobId TEXT PRIMARY KEY," +
            "type TEXT," +
            "status TEXT," +
            "payloadJson TEXT," +
            "progressJson TEXT," +
            "error TEXT," +
            "createdAt INTEGER," +
            "updatedAt INTEGER" +
            ")"
        );
        return db;
    }

    private JobRow loadJob(String jobId) {
        SQLiteDatabase db = getDb();
        Cursor cursor = db.query(
            "jobs",
            new String[]{"jobId", "payloadJson", "progressJson"},
            "jobId = ?",
            new String[]{jobId},
            null,
            null,
            null
        );
        if (!cursor.moveToFirst()) {
            cursor.close();
            return null;
        }
        String payloadStr = cursor.getString(cursor.getColumnIndexOrThrow("payloadJson"));
        String progressStr = cursor.getString(cursor.getColumnIndexOrThrow("progressJson"));
        cursor.close();

        try {
            JSONObject payload = payloadStr != null ? new JSONObject(payloadStr) : null;
            JSONObject progress = progressStr != null ? new JSONObject(progressStr) : null;
            return new JobRow(jobId, payload, progress);
        } catch (JSONException e) {
            return null;
        }
    }

    private void updateJobProgress(String jobId, String status, JSONObject progressJson, String error) {
        SQLiteDatabase db = getDb();
        ContentValues values = new ContentValues();
        values.put("status", status);
        values.put("error", error);
        values.put("updatedAt", System.currentTimeMillis());
        if (progressJson != null) {
            values.put("progressJson", progressJson.toString());
        }
        db.update("jobs", values, "jobId = ?", new String[]{jobId});
    }

    private void updateStatus(String jobId, String status, String error) {
        SQLiteDatabase db = getDb();
        ContentValues values = new ContentValues();
        values.put("status", status);
        values.put("error", error);
        values.put("updatedAt", System.currentTimeMillis());
        db.update("jobs", values, "jobId = ?", new String[]{jobId});
    }

    private String loadDriveAccessToken() {
        SQLiteDatabase db = getDb();
        Cursor c = db.query(
            "kv",
            new String[]{"json"},
            "key = ?",
            new String[]{"auth_session"},
            null,
            null,
            null
        );
        if (!c.moveToFirst()) {
            c.close();
            return null;
        }
        String raw = c.getString(c.getColumnIndexOrThrow("json"));
        c.close();
        try {
            JSONObject session = new JSONObject(raw);
            String token = session.optString("accessToken", null);
            if (token == null || token.isEmpty()) return null;
            long expiresAt = session.optLong("expiresAt", 0);
            if (expiresAt > 0 && System.currentTimeMillis() > expiresAt) return null;
            return token;
        } catch (JSONException e) {
            return null;
        }
    }

    private DriveFolder findSubfolder(String accessToken, String rootId, String name) throws Exception {
        String q = "'" + rootId + "' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false and name = '" + name.replace("'", "\\'") + "'";
        List<DriveFile> files = listFiles(accessToken, q);
        for (DriveFile f : files) {
            if (name.equals(f.name)) return new DriveFolder(f.id, f.name);
        }
        return null;
    }

    private DriveFile findFileInFolder(String accessToken, String folderId, String filename) throws Exception {
        String q = "'" + folderId + "' in parents and trashed = false and name = '" + filename.replace("'", "\\'") + "'";
        List<DriveFile> files = listFiles(accessToken, q);
        return files.isEmpty() ? null : files.get(0);
    }

    private List<DriveFile> listFilesInFolder(String accessToken, String folderId) throws Exception {
        String q = "'" + folderId + "' in parents and trashed = false";
        return listFiles(accessToken, q);
    }

    private List<DriveFile> listFiles(String accessToken, String q) throws Exception {
        List<DriveFile> out = new ArrayList<>();
        String pageToken = null;
        do {
            String url = "https://www.googleapis.com/drive/v3/files?q=" + encode(q)
                + "&fields=nextPageToken,files(id,name,mimeType,modifiedTime)"
                + "&pageSize=1000&supportsAllDrives=true&includeItemsFromAllDrives=true";
            if (pageToken != null) url += "&pageToken=" + encode(pageToken);

            HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setRequestProperty("Authorization", "Bearer " + accessToken);
            conn.setRequestProperty("Accept", "application/json");
            int code = conn.getResponseCode();
            String body = new String(readAllBytes(code >= 200 && code < 300 ? conn.getInputStream() : conn.getErrorStream()), StandardCharsets.UTF_8);
            if (code < 200 || code >= 300) throw new Exception("Drive list failed: " + code);

            JSONObject json = new JSONObject(body);
            JSONArray files = json.optJSONArray("files");
            if (files != null) {
                for (int i = 0; i < files.length(); i++) {
                    JSONObject f = files.getJSONObject(i);
                    String id = f.optString("id", null);
                    String name = f.optString("name", null);
                    String mime = f.optString("mimeType", "");
                    String modified = f.optString("modifiedTime", "");
                    boolean isFolder = "application/vnd.google-apps.folder".equals(mime);
                    out.add(new DriveFile(id, name, mime, modified, isFolder));
                }
            }
            pageToken = json.optString("nextPageToken", null);
        } while (pageToken != null && !pageToken.isEmpty());

        return out;
    }

    private String downloadDriveFile(String accessToken, String fileId) throws Exception {
        String url = "https://www.googleapis.com/drive/v3/files/" + fileId + "?alt=media&supportsAllDrives=true";
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setRequestProperty("Authorization", "Bearer " + accessToken);
        int code = conn.getResponseCode();
        byte[] bytes = readAllBytes(code >= 200 && code < 300 ? conn.getInputStream() : conn.getErrorStream());
        if (code < 200 || code >= 300) throw new Exception("Drive download failed: " + code);
        return new String(bytes, StandardCharsets.UTF_8);
    }

    private void moveFileToTrash(String accessToken, String fileId) throws Exception {
        String url = "https://www.googleapis.com/drive/v3/files/" + fileId + "?supportsAllDrives=true";
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setRequestMethod("PATCH");
        conn.setRequestProperty("Authorization", "Bearer " + accessToken);
        conn.setRequestProperty("Content-Type", "application/json");
        conn.setDoOutput(true);
        byte[] body = "{\"trashed\":true}".getBytes(StandardCharsets.UTF_8);
        OutputStream os = conn.getOutputStream();
        os.write(body);
        os.flush();
        os.close();
        int code = conn.getResponseCode();
        if (code < 200 || code >= 300) throw new Exception("Trash failed: " + code);
    }

    private void copyDriveFile(String accessToken, String sourceFileId, String destFolderId, String newName) throws Exception {
        String url = "https://www.googleapis.com/drive/v3/files/" + sourceFileId + "/copy?supportsAllDrives=true";
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setRequestMethod("POST");
        conn.setRequestProperty("Authorization", "Bearer " + accessToken);
        conn.setRequestProperty("Content-Type", "application/json");
        conn.setDoOutput(true);
        JSONObject body = new JSONObject();
        body.put("name", newName);
        JSONArray parents = new JSONArray();
        parents.put(destFolderId);
        body.put("parents", parents);
        OutputStream os = conn.getOutputStream();
        os.write(body.toString().getBytes(StandardCharsets.UTF_8));
        os.flush();
        os.close();
        int code = conn.getResponseCode();
        if (code < 200 || code >= 300) {
            throw new Exception("Drive copy failed: " + code);
        }
    }

    private String uploadToDriveWithRetry(
        String accessToken,
        String folderId,
        String filename,
        String mimeType,
        byte[] content
    ) throws Exception {
        int attempt = 0;
        long delayMs = 1000;
        while (true) {
            try {
                return uploadToDrive(accessToken, folderId, filename, mimeType, content);
            } catch (RetryableUploadException e) {
                attempt++;
                if (attempt >= MAX_UPLOAD_RETRIES) throw e;
                long jitter = (long) (Math.random() * delayMs);
                Thread.sleep(delayMs + jitter);
                delayMs = Math.min(delayMs * 2, 20000);
            }
        }
    }

    private String uploadToDrive(
        String accessToken,
        String folderId,
        String filename,
        String mimeType,
        byte[] content
    ) throws Exception {
        String boundary = "-------talevox_sync_boundary";
        JSONObject metadata = new JSONObject();
        metadata.put("name", filename);
        metadata.put("mimeType", mimeType);
        if (folderId != null) {
            JSONArray parents = new JSONArray();
            parents.put(folderId);
            metadata.put("parents", parents);
        }

        String metadataPart = "--" + boundary + "\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n" +
            metadata.toString() + "\r\n";
        String mediaHeader = "--" + boundary + "\r\nContent-Type: " + mimeType + "\r\n\r\n";
        String footer = "\r\n--" + boundary + "--";

        byte[] metaBytes = metadataPart.getBytes(StandardCharsets.UTF_8);
        byte[] headerBytes = mediaHeader.getBytes(StandardCharsets.UTF_8);
        byte[] footerBytes = footer.getBytes(StandardCharsets.UTF_8);

        ByteArrayOutputStream body = new ByteArrayOutputStream();
        body.write(metaBytes);
        body.write(headerBytes);
        body.write(content);
        body.write(footerBytes);

        URL url = new URL("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id&supportsAllDrives=true");
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        conn.setRequestMethod("POST");
        conn.setConnectTimeout(20000);
        conn.setReadTimeout(60000);
        conn.setDoOutput(true);
        conn.setRequestProperty("Authorization", "Bearer " + accessToken);
        conn.setRequestProperty("Content-Type", "multipart/related; boundary=" + boundary);

        OutputStream os = conn.getOutputStream();
        os.write(body.toByteArray());
        os.flush();
        os.close();

        int code = conn.getResponseCode();
        byte[] bytes = readAllBytes(code >= 200 && code < 300 ? conn.getInputStream() : conn.getErrorStream());
        if (code == 429 || code == 500 || code == 502 || code == 503 || code == 504) {
            throw new RetryableUploadException("Drive upload retryable: " + code);
        }
        if (code < 200 || code >= 300) {
            throw new Exception("Drive upload failed: " + code);
        }
        JSONObject json = new JSONObject(new String(bytes, StandardCharsets.UTF_8));
        return json.optString("id", null);
    }
    private byte[] synthesizeMp3(String text, String voiceId, double speakingRate) throws Exception {
        List<String> chunks = chunkTextByUtf8Bytes(text, MAX_TTS_BYTES);
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        boolean first = true;
        for (String chunk : chunks) {
            byte[] bytes = postTts(chunk, voiceId, speakingRate);
            if (!first) bytes = stripId3(bytes);
            out.write(bytes);
            first = false;
        }
        return out.toByteArray();
    }

    private byte[] postTts(String text, String voiceId, double speakingRate) throws Exception {
        URL url = new URL(DEFAULT_ENDPOINT);
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        conn.setRequestMethod("POST");
        conn.setConnectTimeout(20000);
        conn.setReadTimeout(60000);
        conn.setDoOutput(true);
        conn.setRequestProperty("Content-Type", "application/json");

        JSONObject payload = new JSONObject();
        payload.put("text", text);
        payload.put("voiceName", voiceId);
        payload.put("speakingRate", speakingRate);
        payload.put("languageCode", "en-US");

        byte[] body = payload.toString().getBytes(StandardCharsets.UTF_8);
        OutputStream os = conn.getOutputStream();
        os.write(body);
        os.flush();
        os.close();

        int code = conn.getResponseCode();
        InputStream stream = code >= 200 && code < 300 ? conn.getInputStream() : conn.getErrorStream();
        byte[] bytes = readAllBytes(stream);
        String contentType = conn.getHeaderField("Content-Type");

        if (code < 200 || code >= 300) {
            throw new Exception("Cloud TTS Failed: " + code);
        }

        if (contentType != null && contentType.startsWith("audio/")) {
            return bytes;
        }

        JSONObject json = new JSONObject(new String(bytes, StandardCharsets.UTF_8));
        String b64 = json.optString("mp3Base64", null);
        if (b64 == null || b64.isEmpty()) b64 = json.optString("audioBase64", null);
        if (b64 == null || b64.isEmpty()) b64 = json.optString("audioContent", null);
        if (b64 == null || b64.isEmpty()) {
            throw new Exception("TTS response missing base64 audio");
        }
        return Base64.decode(b64, Base64.DEFAULT);
    }

    private byte[] stripId3(byte[] bytes) {
        if (bytes.length < 10) return bytes;
        if (bytes[0] == 0x49 && bytes[1] == 0x44 && bytes[2] == 0x33) {
            int size = ((bytes[6] & 0x7f) << 21)
                | ((bytes[7] & 0x7f) << 14)
                | ((bytes[8] & 0x7f) << 7)
                | (bytes[9] & 0x7f);
            int end = 10 + size;
            if (end < bytes.length) {
                byte[] out = new byte[bytes.length - end];
                System.arraycopy(bytes, end, out, 0, out.length);
                return out;
            }
        }
        return bytes;
    }

    private List<String> chunkTextByUtf8Bytes(String text, int limitBytes) {
        List<String> chunks = new ArrayList<>();
        if (text == null) return chunks;
        String cleaned = text.replace("\r\n", "\n").trim();
        if (cleaned.isEmpty()) return chunks;
        if (utf8Len(cleaned) <= limitBytes) {
            chunks.add(cleaned);
            return chunks;
        }

        String[] paras = cleaned.split("\\n\\n+");
        StringBuilder cur = new StringBuilder();

        for (String p0 : paras) {
            String p = p0.trim();
            if (p.isEmpty()) continue;

            if (utf8Len(p) > limitBytes) {
                String[] sentences = p.split("(?<=[.!?])\\s+");
                for (String s0 : sentences) {
                    String s = s0.trim();
                    if (s.isEmpty()) continue;

                    if (utf8Len(s) > limitBytes) {
                        flushChunk(cur, chunks);
                        int start = 0;
                        for (int i = 1; i <= s.length(); i++) {
                            String slice = s.substring(start, i);
                            if (utf8Len(slice) > limitBytes) {
                                chunks.add(s.substring(start, i - 1).trim());
                                start = i - 1;
                            }
                        }
                        cur.setLength(0);
                        cur.append(s.substring(start));
                        continue;
                    }

                    String next = cur.length() > 0 ? cur + " " + s : s;
                    if (utf8Len(next) > limitBytes) {
                        flushChunk(cur, chunks);
                    }
                    if (cur.length() > 0) cur.append(" ");
                    cur.append(s);
                }
                flushChunk(cur, chunks);
                continue;
            }

            String next = cur.length() > 0 ? cur + "\n\n" + p : p;
            if (utf8Len(next) > limitBytes) {
                flushChunk(cur, chunks);
            }
            if (cur.length() > 0) cur.append("\n\n");
            cur.append(p);
        }

        flushChunk(cur, chunks);
        return chunks;
    }

    private void flushChunk(StringBuilder cur, List<String> chunks) {
        String t = cur.toString().trim();
        if (!t.isEmpty()) chunks.add(t);
        cur.setLength(0);
    }

    private int utf8Len(String s) {
        return s.getBytes(StandardCharsets.UTF_8).length;
    }

    private byte[] readAllBytes(InputStream stream) throws Exception {
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        byte[] tmp = new byte[8192];
        int read;
        while ((read = stream.read(tmp)) != -1) {
            buffer.write(tmp, 0, read);
        }
        return buffer.toByteArray();
    }

    private String saveMp3ToFile(String chapterId, byte[] mp3) throws Exception {
        File dir = new File(getApplicationContext().getFilesDir(), "audio");
        if (!dir.exists()) dir.mkdirs();
        File out = new File(dir, chapterId + ".mp3");
        FileOutputStream fos = new FileOutputStream(out);
        fos.write(mp3);
        fos.flush();
        fos.close();
        return out.getAbsolutePath();
    }

    private List<Rule> loadRulesForBook(String bookId) {
        List<Rule> rules = new ArrayList<>();
        SQLiteDatabase db = getDb();

        Cursor cursor = db.query(
            "books",
            new String[]{"rulesJson"},
            "id = ?",
            new String[]{bookId},
            null,
            null,
            null
        );
        if (cursor.moveToFirst()) {
            String rulesStr = cursor.getString(cursor.getColumnIndexOrThrow("rulesJson"));
            rules.addAll(parseRulesArray(rulesStr));
        }
        cursor.close();

        Cursor c2 = db.query(
            "kv",
            new String[]{"json"},
            "key = ?",
            new String[]{"app_state"},
            null,
            null,
            null
        );
        if (c2.moveToFirst()) {
            String appStateStr = c2.getString(c2.getColumnIndexOrThrow("json"));
            try {
                JSONObject appState = new JSONObject(appStateStr);
                JSONArray globalRules = appState.optJSONArray("globalRules");
                if (globalRules != null) {
                    rules.addAll(parseRulesArray(globalRules.toString()));
                }
            } catch (JSONException ignored) {}
        }
        c2.close();

        Collections.sort(rules, new Comparator<Rule>() {
            @Override
            public int compare(Rule a, Rule b) {
                return Integer.compare(b.priority, a.priority);
            }
        });
        return rules;
    }

    private List<Rule> parseRulesArray(String rawJson) {
        List<Rule> rules = new ArrayList<>();
        if (rawJson == null || rawJson.isEmpty()) return rules;
        try {
            JSONArray arr = new JSONArray(rawJson);
            for (int i = 0; i < arr.length(); i++) {
                JSONObject r = arr.getJSONObject(i);
                Rule rule = new Rule();
                rule.find = r.optString("find", "");
                rule.speakAs = r.optString("speakAs", "");
                rule.matchCase = r.optBoolean("matchCase", false);
                rule.matchExpression = r.optBoolean("matchExpression", false);
                rule.ruleType = r.optString("ruleType", "REPLACE");
                rule.wholeWord = r.optBoolean("wholeWord", false);
                rule.priority = r.optInt("priority", 0);
                rule.enabled = r.optBoolean("enabled", true);
                if (!rule.find.isEmpty() && rule.enabled) {
                    rules.add(rule);
                }
            }
        } catch (JSONException ignored) {}
        return rules;
    }

    private String applyRules(String text, List<Rule> rules) {
        String processed = text;
        for (Rule rule : rules) {
            if (!rule.enabled) continue;
            if (rule.find == null || rule.find.isEmpty()) continue;

            String pattern = rule.matchExpression ? rule.find : Pattern.quote(rule.find);
            if (rule.wholeWord && !rule.matchExpression) {
                pattern = "\\b" + pattern + "\\b";
            }

            int flags = 0;
            if (!rule.matchCase) flags |= Pattern.CASE_INSENSITIVE;

            Pattern regex = Pattern.compile(pattern, flags);
            String replacement = "DELETE".equals(rule.ruleType) ? "" : (rule.speakAs != null ? rule.speakAs : "");
            processed = regex.matcher(processed).replaceAll(Matcher.quoteReplacement(replacement));
        }
        return processed;
    }

    private void updateChapterAudioStatus(String bookId, String chapterId, String status, String filePath, String cloudAudioFileId) {
        SQLiteDatabase db = getDb();
        ContentValues values = new ContentValues();
        values.put("audioStatus", status);
        values.put("audioSignature", filePath);
        if (cloudAudioFileId != null) {
            values.put("cloudAudioFileId", cloudAudioFileId);
            values.put("audioDriveId", cloudAudioFileId);
        }
        values.put("updatedAt", System.currentTimeMillis());
        db.update("chapters", values, "id = ? AND bookId = ?", new String[]{chapterId, bookId});
    }

    private DriveFile pickNewest(List<DriveFile> files) {
        if (files == null || files.isEmpty()) return null;
        Collections.sort(files, new Comparator<DriveFile>() {
            @Override
            public int compare(DriveFile a, DriveFile b) {
                return b.modifiedTime.compareTo(a.modifiedTime);
            }
        });
        return files.get(0);
    }

    private InventoryChapter findInv(List<InventoryChapter> list, String chapterId) {
        for (InventoryChapter c : list) {
            if (chapterId.equals(c.chapterId)) return c;
        }
        return null;
    }

    private String encode(String s) {
        try {
            return java.net.URLEncoder.encode(s, "UTF-8");
        } catch (Exception e) {
            return s;
        }
    }

    private void emitProgress(String jobId, String status, JSONObject progressJson) {
        JSObject payload = new JSObject();
        payload.put("jobId", jobId);
        payload.put("status", status);
        payload.put("progress", progressJson);
        JobRunnerPlugin.emitJobProgress(payload);
    }

    private void emitFinished(String jobId, String status, JSONObject progressJson, String error) {
        JSObject payload = new JSObject();
        payload.put("jobId", jobId);
        payload.put("status", status);
        payload.put("progress", progressJson);
        if (error != null) payload.put("error", error);
        JobRunnerPlugin.emitJobFinished(payload);
    }

    private void showProgressNotification(String jobId, String title, JSONObject progressJson) {
        Notification notification = buildProgressNotification(jobId, title, progressJson);
        NotificationManager nm = (NotificationManager) getApplicationContext().getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "TaleVox Jobs",
                NotificationManager.IMPORTANCE_DEFAULT
            );
            nm.createNotificationChannel(channel);
        }

        nm.notify(notificationId(jobId), notification);
        setForegroundAsync(new ForegroundInfo(notificationId(jobId), notification));
    }

    private void showFinishedNotification(String jobId, String title) {
        NotificationManager nm = (NotificationManager) getApplicationContext().getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "TaleVox Jobs",
                NotificationManager.IMPORTANCE_LOW
            );
            nm.createNotificationChannel(channel);
        }

        Notification notification = new NotificationCompat.Builder(getApplicationContext(), CHANNEL_ID)
            .setContentTitle(title)
            .setSmallIcon(android.R.drawable.stat_sys_download_done)
            .setOngoing(false)
            .build();

        nm.notify(notificationId(jobId), notification);
    }

    private int notificationId(String jobId) {
        return Math.abs(jobId.hashCode());
    }

    private Notification buildProgressNotification(String jobId, String title, JSONObject progressJson) {
        int total = progressJson != null ? progressJson.optInt("total", 0) : 0;
        int completed = progressJson != null ? progressJson.optInt("completed", 0) : 0;
        int percent = total > 0 ? Math.min(100, Math.round((completed * 100f) / total)) : 0;

        return new NotificationCompat.Builder(getApplicationContext(), CHANNEL_ID)
            .setContentTitle(title)
            .setContentText(percent + "% (" + completed + "/" + total + ")")
            .setSmallIcon(android.R.drawable.stat_sys_upload)
            .setProgress(total > 0 ? total : 100, total > 0 ? completed : percent, total == 0)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .build();
    }

    private Result failJob(String jobId, String message, JSONObject progressJson) {
        updateStatus(jobId, "failed", message);
        JSONObject progress = progressJson != null ? progressJson : new JSONObject();
        try { progress.put("error", message); } catch (JSONException ignored) {}
        emitFinished(jobId, "failed", progress, message);
        showFinishedNotification(jobId, "Integrity fix failed");
        return Result.failure();
    }

    private static class InventoryChapter {
        String chapterId;
        int idx;
        String title;
        String textName;
        String audioName;
        String legacyTextName;
        String legacyAudioName;
    }

    private static class Conversion {
        String chapterId;
        String type;
        String sourceName;
        String targetName;
        Conversion(String chapterId, String type, String sourceName, String targetName) {
            this.chapterId = chapterId;
            this.type = type;
            this.sourceName = sourceName;
            this.targetName = targetName;
        }
    }

    private static class DriveFile {
        String id;
        String name;
        String mimeType;
        String modifiedTime;
        boolean isFolder;
        DriveFile(String id, String name, String mimeType, String modifiedTime, boolean isFolder) {
            this.id = id;
            this.name = name;
            this.mimeType = mimeType;
            this.modifiedTime = modifiedTime;
            this.isFolder = isFolder;
        }
    }

    private static class DriveFolder {
        String id;
        String name;
        DriveFolder(String id, String name) {
            this.id = id;
            this.name = name;
        }
    }

    private static class Rule {
        String find;
        String speakAs;
        boolean matchCase;
        boolean matchExpression;
        String ruleType;
        boolean wholeWord;
        int priority;
        boolean enabled;
    }

    private static class RetryableUploadException extends Exception {
        RetryableUploadException(String message) {
            super(message);
        }
    }

    private static class JobRow {
        String jobId;
        JSONObject payloadJson;
        JSONObject progressJson;
        JobRow(String jobId, JSONObject payloadJson, JSONObject progressJson) {
            this.jobId = jobId;
            this.payloadJson = payloadJson;
            this.progressJson = progressJson;
        }
    }
}
