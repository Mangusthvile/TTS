package com.cmwil.talevox.jobrunner;

import android.content.ContentValues;
import android.content.Context;
import android.database.sqlite.SQLiteDatabase;
import android.database.Cursor;
import android.util.Base64;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.work.ForegroundInfo;
import androidx.work.Worker;
import androidx.work.WorkerParameters;
import androidx.work.ListenableWorker.Result;
import androidx.work.Data;
import androidx.work.OneTimeWorkRequest;
import androidx.work.WorkManager;
import androidx.work.OutOfQuotaPolicy;
import androidx.work.ExistingWorkPolicy;
import android.app.Notification;
import android.app.NotificationManager;

import com.getcapacitor.JSObject;
import com.cmwil.talevox.notifications.JobNotificationChannels;
import com.cmwil.talevox.notifications.JobNotificationHelper;

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
import java.util.List;
import java.util.regex.Pattern;
import java.util.regex.Matcher;
import java.util.UUID;

public class GenerateAudioWorker extends Worker {
    private static final String DB_NAME = "talevox_db";
    private static final String DEFAULT_ENDPOINT = "https://talevox-tts-762195576430.us-south1.run.app";
    private static final int MAX_TTS_BYTES = 4500;
    private static final int MAX_UPLOAD_RETRIES = 5;
    private static final String CHANNEL_ID = JobNotificationChannels.CHANNEL_JOBS_ID;

    public GenerateAudioWorker(@NonNull Context context, @NonNull WorkerParameters params) {
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
            JSONArray chapterIds = payload.optJSONArray("chapterIds");
            if (bookId == null || chapterIds == null) {
                return failJob(jobId, "Invalid payload", null);
            }
            String resolvedBookId = resolveBookId(bookId);
            if (resolvedBookId == null || resolvedBookId.isEmpty()) {
                return failJob(jobId, "Book not found for bookId/driveFolderId", null);
            }

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

            JSONObject progressJson = job.progressJson != null ? job.progressJson : new JSONObject();
            int completed = progressJson.optInt("completed", 0);
            int skipped = progressJson.optInt("skipped", 0);
            int total = progressJson.optInt("total", chapterIds.length());
            if (total <= 0) total = chapterIds.length();
            if (!progressJson.has("startedAt")) {
                progressJson.put("startedAt", System.currentTimeMillis());
            }

            progressJson.put("total", total);
            progressJson.put("completed", completed);
            progressJson.put("skipped", skipped);
            updateJobProgress(jobId, "running", progressJson, null);
            Log.d("GenerateAudioWorker", "Job " + jobId + " starting chapters; total=" + total);
            setForegroundAsync(JobNotificationHelper.buildForegroundInfo(getApplicationContext(), jobId, "Generating audio", "", total, completed, false, true));
            JobRunnerPlugin.noteForegroundHeartbeat();
            showProgressNotification(jobId, "Generating audio", progressJson);

            List<Rule> rules = loadRulesForBook(resolvedBookId);

            for (int i = completed; i < chapterIds.length(); i++) {
                if (isStopped()) {
                    progressJson.put("currentChapterId", JSONObject.NULL);
                    updateJobProgress(jobId, "canceled", progressJson, null);
                    emitFinished(jobId, "canceled", progressJson, null);
                    return Result.failure();
                }

                String chapterId = chapterIds.getString(i);
                progressJson.put("currentChapterId", chapterId);
                updateJobProgress(jobId, "running", progressJson, null);
                emitProgress(jobId, "running", progressJson);
                setForegroundAsync(JobNotificationHelper.buildForegroundInfo(getApplicationContext(), jobId, "Generating audio", "", total, completed, false, true));
                JobRunnerPlugin.noteForegroundHeartbeat();
                showProgressNotification(jobId, "Generating audio", progressJson);

                String content = loadChapterText(resolvedBookId, chapterId);
                if (content == null || content.isEmpty()) {
                    skipped++;
                    progressJson.put("skipped", skipped);
                    addSkippedChapter(progressJson, chapterId);
                    updateJobProgress(jobId, "running", progressJson, null);
                    emitProgress(jobId, "running", progressJson);
                    continue;
                }

                String processed = applyRules(content, rules);
                byte[] mp3 = synthesizeMp3(processed, voiceId, speakingRate);
                String filePath = saveMp3ToFile(chapterId, mp3);

                String uploadError = null;
                String uploadedId = null;
                String accessToken = loadDriveAccessToken();
                String booksFolderId = loadDriveBooksFolderId();
                if (accessToken != null && booksFolderId != null) {
                    try {
                        String filename = "c_" + chapterId + ".mp3";
                        uploadedId = uploadToDriveWithRetry(
                            accessToken,
                            booksFolderId,
                            filename,
                            "audio/mpeg",
                            mp3
                        );
                    } catch (Exception e) {
                        uploadError = e.getMessage();
                    }
                } else {
                    uploadError = "UPLOAD_PENDING_MISSING_TOKEN_OR_FOLDER";
                }

                updateChapterAudioStatus(resolvedBookId, chapterId, "ready", filePath, uploadedId);
                if (uploadError != null || uploadedId == null) {
                    enqueueUploadQueueItem(resolvedBookId, chapterId, filePath);
                    ensureUploadQueueJob();
                }

                completed = i + 1;
                progressJson.put("completed", completed);
                progressJson.put("total", total);
                if (uploadError != null) {
                    progressJson.put("lastUploadError", uploadError);
                    progressJson.put("lastUploadChapterId", chapterId);
                }
                updateJobProgress(jobId, "running", progressJson, null);
                emitProgress(jobId, "running", progressJson);
                showProgressNotification(jobId, "Generating audio", progressJson);
            }

            progressJson.put("currentChapterId", JSONObject.NULL);
            progressJson.put("finishedAt", System.currentTimeMillis());
            if (completed == 0 && skipped >= total) {
                return failJob(jobId, "Missing chapter text", progressJson);
            }
            updateJobProgress(jobId, "completed", progressJson, null);
            emitFinished(jobId, "completed", progressJson, null);
            showFinishedNotification(jobId, "Audio generation complete");
            setForegroundAsync(JobNotificationHelper.buildForegroundInfo(getApplicationContext(), jobId, "Audio generation complete", "", total, total, false, false));
            JobRunnerPlugin.noteForegroundHeartbeat();
            return Result.success();
        } catch (Throwable t) {
            return failJob(jobId, t != null ? t.getMessage() : "Unknown error", null);
        }
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
        db.execSQL(
            "CREATE TABLE IF NOT EXISTS kv (" +
            "key TEXT PRIMARY KEY," +
            "json TEXT NOT NULL," +
            "updatedAt INTEGER NOT NULL" +
            ")"
        );
        db.execSQL(
            "CREATE TABLE IF NOT EXISTS books (" +
            "id TEXT PRIMARY KEY," +
            "title TEXT," +
            "author TEXT," +
            "coverImage TEXT," +
            "backend TEXT," +
            "driveFolderId TEXT," +
            "driveFolderName TEXT," +
            "currentChapterId TEXT," +
            "settingsJson TEXT," +
            "rulesJson TEXT," +
            "updatedAt INTEGER" +
            ")"
        );
        db.execSQL(
            "CREATE TABLE IF NOT EXISTS chapters (" +
            "id TEXT PRIMARY KEY," +
            "bookId TEXT," +
            "idx INTEGER," +
            "title TEXT," +
            "filename TEXT," +
            "sourceUrl TEXT," +
            "cloudTextFileId TEXT," +
            "cloudAudioFileId TEXT," +
            "audioDriveId TEXT," +
            "audioStatus TEXT," +
            "audioSignature TEXT," +
            "durationSec REAL," +
            "textLength INTEGER," +
            "wordCount INTEGER," +
            "isFavorite INTEGER," +
            "updatedAt INTEGER" +
            ")"
        );
        db.execSQL(
            "CREATE TABLE IF NOT EXISTS chapter_text (" +
            "chapterId TEXT PRIMARY KEY," +
            "bookId TEXT NOT NULL," +
            "content TEXT NOT NULL," +
            "updatedAt INTEGER NOT NULL" +
            ")"
        );
        return db;
    }

    private void updateStatus(String jobId, String status, String error) {
        SQLiteDatabase db = getDb();
        ContentValues values = new ContentValues();
        values.put("status", status);
        values.put("error", error);
        values.put("updatedAt", System.currentTimeMillis());
        db.update("jobs", values, "jobId = ?", new String[]{jobId});
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

    private String loadChapterText(String bookId, String chapterId) {
        SQLiteDatabase db = getDb();
        Cursor cursor = db.query(
            "chapter_text",
            new String[]{"content"},
            "chapterId = ? AND bookId = ?",
            new String[]{chapterId, bookId},
            null,
            null,
            null
        );
        if (cursor.moveToFirst()) {
            String content = cursor.getString(cursor.getColumnIndexOrThrow("content"));
            cursor.close();
            return content;
        }
        cursor.close();

        Cursor cursor2 = db.query(
            "chapter_text",
            new String[]{"content"},
            "chapterId = ?",
            new String[]{chapterId},
            null,
            null,
            null
        );
        if (cursor2.moveToFirst()) {
            String content = cursor2.getString(cursor2.getColumnIndexOrThrow("content"));
            cursor2.close();
            return content;
        }
        cursor2.close();
        return null;
    }

    private String resolveBookId(String inputBookId) {
        SQLiteDatabase db = getDb();
        Cursor c = db.query(
            "books",
            new String[]{"id"},
            "id = ?",
            new String[]{inputBookId},
            null,
            null,
            null
        );
        if (c.moveToFirst()) {
            String id = c.getString(c.getColumnIndexOrThrow("id"));
            c.close();
            return id;
        }
        c.close();

        Cursor c2 = db.query(
            "books",
            new String[]{"id"},
            "driveFolderId = ?",
            new String[]{inputBookId},
            null,
            null,
            null
        );
        if (c2.moveToFirst()) {
            String id = c2.getString(c2.getColumnIndexOrThrow("id"));
            c2.close();
            return id;
        }
        c2.close();
        return null;
    }

    private void addSkippedChapter(JSONObject progressJson, String chapterId) {
        try {
            JSONArray arr = progressJson.optJSONArray("skippedChapterIds");
            if (arr == null) arr = new JSONArray();
            if (arr.length() < 50) arr.put(chapterId);
            progressJson.put("skippedChapterIds", arr);
        } catch (JSONException ignored) {}
    }

    private void updateChapterAudioStatus(String bookId, String chapterId, String status, String filePath) {
        SQLiteDatabase db = getDb();
        ContentValues values = new ContentValues();
        values.put("audioStatus", status);
        values.put("audioSignature", filePath);
        values.put("updatedAt", System.currentTimeMillis());
        db.update("chapters", values, "id = ? AND bookId = ?", new String[]{chapterId, bookId});
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

    private List<Rule> loadRulesForBook(String bookId) {
        List<Rule> rules = new ArrayList<>();
        SQLiteDatabase db = getDb();

        // Book rules
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

        // Global rules stored in app_state if available
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

        // Assume JSON with base64
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

    private String loadDriveBooksFolderId() {
        SQLiteDatabase db = getDb();
        Cursor c = db.query(
            "kv",
            new String[]{"json"},
            "key = ?",
            new String[]{"app_state"},
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
            JSONObject state = new JSONObject(raw);
            JSONObject sub = state.optJSONObject("driveSubfolders");
            if (sub == null) return null;
            String booksId = sub.optString("booksId", null);
            if (booksId == null || booksId.isEmpty()) return null;
            return booksId;
        } catch (JSONException e) {
            return null;
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

    private void enqueueUploadQueueItem(String bookId, String chapterId, String localPath) {
        try {
            SQLiteDatabase db = getDb();
            String id = "q_" + chapterId;
            long now = System.currentTimeMillis();
            ContentValues values = new ContentValues();
            values.put("id", id);
            values.put("chapterId", chapterId);
            values.put("bookId", bookId);
            values.put("localPath", localPath);
            values.put("status", "queued");
            values.put("attempts", 0);
            values.put("nextAttemptAt", now);
            values.put("lastError", (String) null);
            values.put("createdAt", now);
            values.put("updatedAt", now);
            db.insertWithOnConflict("drive_upload_queue", null, values, SQLiteDatabase.CONFLICT_REPLACE);
        } catch (Exception ignored) {}
    }

    private void ensureUploadQueueJob() {
        try {
            SQLiteDatabase db = getDb();
            Cursor c2 = db.query("jobs", new String[]{"jobId"}, "type = ? AND status IN ('queued','running')", new String[]{"drive_upload_queue"}, null, null, null, "1");
            if (c2.moveToFirst()) {
                c2.close();
                return;
            }
            c2.close();
            String jobId = UUID.randomUUID().toString();
            long now = System.currentTimeMillis();
            int total = countPendingUploads();
            JSONObject progress = new JSONObject();
            progress.put("total", total);
            progress.put("completed", 0);

            ContentValues values = new ContentValues();
            values.put("jobId", jobId);
            values.put("type", "drive_upload_queue");
            values.put("status", "queued");
            values.put("payloadJson", (String) null);
            values.put("progressJson", progress.toString());
            values.put("error", (String) null);
            values.put("createdAt", now);
            values.put("updatedAt", now);
            db.insertWithOnConflict("jobs", null, values, SQLiteDatabase.CONFLICT_REPLACE);

            OneTimeWorkRequest request =
                new OneTimeWorkRequest.Builder(DriveUploadWorker.class)
                    .setInputData(new Data.Builder().putString("jobId", jobId).build())
                    .build();
            WorkManager.getInstance(getApplicationContext()).enqueue(request);

            progress.put("workRequestId", request.getId().toString());
            ContentValues update = new ContentValues();
            update.put("progressJson", progress.toString());
            update.put("updatedAt", System.currentTimeMillis());
            db.update("jobs", update, "jobId = ?", new String[]{jobId});
        } catch (Exception ignored) {}
    }

    private void showProgressNotification(String jobId, String title, JSONObject progressJson) {
        NotificationManager nm = (NotificationManager) getApplicationContext().getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        int total = progressJson != null ? progressJson.optInt("total", 0) : 0;
        int completed = progressJson != null ? progressJson.optInt("completed", 0) : 0;
        String currentChapterId = progressJson != null ? progressJson.optString("currentChapterId", "") : "";
        String text = total > 0 ? ("Chapter " + Math.min(completed + 1, total) + " of " + total) : "";
        if (currentChapterId != null && !currentChapterId.isEmpty()) text = text.isEmpty() ? currentChapterId : (text + " · " + currentChapterId);
        Notification notification = JobNotificationHelper.buildProgress(
            getApplicationContext(),
            jobId,
            title,
            text,
            total > 0 ? total : 100,
            completed,
            total == 0,
            true
        );
        nm.notify(JobNotificationHelper.getNotificationId(jobId), notification);
    }

    private void showFinishedNotification(String jobId, String title) {
        NotificationManager nm = (NotificationManager) getApplicationContext().getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;

        Notification notification = JobNotificationHelper.buildFinished(getApplicationContext(), jobId, title, "", true);
        nm.notify(JobNotificationHelper.getNotificationId(jobId), notification);
    }

    private Result failJob(String jobId, String message, JSONObject progressJson) {
        try {
            updateStatus(jobId, "failed", message);
        } catch (Exception ignored) {}
        JSONObject progress = progressJson != null ? progressJson : new JSONObject();
        try { progress.put("error", message); } catch (JSONException ignored) {}
        try {
            emitFinished(jobId, "failed", progress, message);
        } catch (Exception ignored) {}
        try {
            showFinishedNotification(jobId, "Audio generation failed");
        } catch (Exception ignored) {}
        try {
            setForegroundAsync(JobNotificationHelper.buildForegroundInfo(getApplicationContext(), jobId, "Audio generation failed", "", 0, 0, true, false));
        } catch (Exception ignored) {}
        JobRunnerPlugin.noteForegroundHeartbeat();
        return Result.failure();
    }

    private int countPendingUploads() {
        SQLiteDatabase db = getDb();
        Cursor cursor = db.rawQuery("SELECT COUNT(*) FROM drive_upload_queue WHERE status IN ('queued','failed','uploading')", null);
        int total = 0;
        if (cursor.moveToFirst()) total = cursor.getInt(0);
        cursor.close();
        return total;
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
}
