package com.cmwil.talevox.jobrunner;

import android.content.Context;
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
import androidx.work.Constraints;
import androidx.work.NetworkType;
import android.app.Notification;
import android.app.NotificationManager;

import com.getcapacitor.JSObject;
import com.cmwil.talevox.notifications.JobNotificationChannels;
import com.cmwil.talevox.notifications.JobNotificationHelper;
import com.cmwil.talevox.BuildConfig;

import org.json.JSONArray;
import org.json.JSONObject;
import org.json.JSONException;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Pattern;
import java.util.regex.Matcher;
import java.util.UUID;

public class GenerateAudioWorker extends Worker {
    private static final int DEFAULT_BATCH_SIZE = 5;
    private static final int MIN_BATCH_SIZE = 3;
    private static final int MAX_BATCH_SIZE = 7;
    private static final long TOKEN_EXPIRY_GRACE_MS = 5 * 60 * 1000; // 5 min grace past expiresAt
    private static final String DEFAULT_ENDPOINT = "https://talevox-tts-762195576430.us-south1.run.app";
    private static final int MAX_TTS_BYTES = 4500;
    private static final int MAX_OPENAI_BYTES = 3000;
    private static final String OPENAI_ENDPOINT = "https://api.openai.com/v1/audio/speech";
    private static final String OPENAI_MODEL = "gpt-4o-mini-tts-2025-12-15";
    private static final int MAX_UPLOAD_RETRIES = 5;
    private static final String CHANNEL_ID = JobNotificationChannels.CHANNEL_JOBS_ID;
    private static final int DRIVE_FOLDER_CACHE_MAX = 200;
    private final Map<String, String> driveFolderCache = new ConcurrentHashMap<>();
    /** Cache of compiled regex Pattern per (pattern, flags) to avoid recompiling in applyRules. */
    private final Map<String, Pattern> rulePatternCache = new ConcurrentHashMap<>();

    private static class VoiceConfig {
        String provider;
        String id;
        VoiceConfig(String provider, String id) {
            this.provider = provider;
            this.id = id;
        }
    }

    private VoiceConfig resolveVoice(JSONObject voice) {
        String provider = null;
        String voiceId = "en-US-Standard-C";
        if (voice != null) {
            String v = voice.optString("id", null);
            if (v != null && !v.isEmpty()) voiceId = v;
            String p = voice.optString("provider", null);
            if (p != null && !p.isEmpty()) provider = p;
        }
        if (provider == null || provider.isEmpty()) {
            if (voiceId.toLowerCase().startsWith("openai:")) {
                provider = "openai";
                voiceId = voiceId.substring("openai:".length());
            } else {
                provider = "google";
            }
        } else if ("openai".equalsIgnoreCase(provider) && voiceId.toLowerCase().startsWith("openai:")) {
            voiceId = voiceId.substring("openai:".length());
        }
        return new VoiceConfig(provider.toLowerCase(), voiceId);
    }

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
        rulePatternCache.clear();

        try {
            JobRunnerPlugin.JobPayloadResult jobResult = JobRunnerPlugin.getJobPayloadSync(jobId);
            if (jobResult == null) {
                return failJob(jobId, "Job not found", null);
            }

            JSONObject payload = jobResult.payloadJson;
            if (payload == null) {
                return failJob(jobId, "Missing payload", null);
            }

            String bookId = payload.optString("bookId", null);
            String driveFolderId = payload.optString("driveFolderId", null);
            String correlationId = payload.optString("correlationId", null);
            JSONArray chapterIds = payload.optJSONArray("chapterIds");
            if (bookId == null || chapterIds == null) {
                return failJob(jobId, "Invalid payload", null);
            }
            String resolvedBookId = JobRunnerPlugin.resolveBookIdSync(bookId);
            if ((resolvedBookId == null || resolvedBookId.isEmpty()) && driveFolderId != null && !driveFolderId.isEmpty()) {
                resolvedBookId = JobRunnerPlugin.resolveBookIdSync(driveFolderId);
            }
            String effectiveBookId = (resolvedBookId != null && !resolvedBookId.isEmpty()) ? resolvedBookId : bookId;

            VoiceConfig voiceConfig = resolveVoice(payload.optJSONObject("voice"));

            double speakingRate = 1.0;
            JSONObject settings = payload.optJSONObject("settings");
            if (settings != null && settings.has("playbackSpeed")) {
                speakingRate = settings.optDouble("playbackSpeed", 1.0);
            } else if (settings != null && settings.has("speakingRate")) {
                speakingRate = settings.optDouble("speakingRate", 1.0);
            }

            JSONObject progressJson = jobResult.progressJson != null ? jobResult.progressJson : new JSONObject();
            int completed = progressJson.optInt("completed", 0);
            int total = progressJson.optInt("total", chapterIds.length());
            if (total <= 0) total = chapterIds.length();
            if (!progressJson.has("startedAt")) {
                progressJson.put("startedAt", System.currentTimeMillis());
            }
            if (correlationId != null && !correlationId.isEmpty() && !progressJson.has("correlationId")) {
                progressJson.put("correlationId", correlationId);
            }

            progressJson.put("total", total);
            progressJson.put("completed", completed);
            updateJobProgress(jobId, "running", progressJson, null);
            Log.i("GenerateAudioWorker", "start jobId=" + jobId + " workId=" + getId() + " correlationId=" + (correlationId != null ? correlationId : "none") + " total=" + total);
            setForegroundAsync(JobNotificationHelper.buildForegroundInfo(getApplicationContext(), jobId, "Generating audio", "", total, completed, false, true));
            JobRunnerPlugin.noteForegroundHeartbeat();
            showProgressNotification(jobId, "Generating audio", progressJson);

            List<Rule> rules = resolvedBookId != null ? loadRulesForBook(resolvedBookId) : new ArrayList<>();
            int batchSize = payload.optInt("batchSize", DEFAULT_BATCH_SIZE);
            batchSize = Math.max(MIN_BATCH_SIZE, Math.min(MAX_BATCH_SIZE, batchSize));
            int batchEnd = Math.min(completed + batchSize, chapterIds.length());
            if (driveFolderId != null && !driveFolderId.isEmpty()) {
                String token = JobRunnerPlugin.getDriveAccessTokenSync();
                if (token == null) {
                    Log.w("GenerateAudioWorker", "Drive token expired or missing at batch start; uploads will be deferred to queue");
                }
            }

            for (int i = completed; i < batchEnd; i++) {
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

                String payloadPath = getPayloadTextPath(payload, chapterId);
                String content = payloadPath != null ? readTextFromPath(payloadPath) : null;
                if (content == null || content.isEmpty()) {
                    String fallbackPath = "talevox/chapter_text/" + chapterId + ".txt";
                    if (payloadPath == null || !payloadPath.equals(fallbackPath)) {
                        content = readTextFromPath(fallbackPath);
                    }
                }
                if (content != null && !content.isEmpty()) {
                    Log.d("GenerateAudioWorker", "chapter_text from file path len=" + content.length());
                } else {
                    content = JobRunnerPlugin.getChapterTextSync(effectiveBookId, chapterId);
                }
                if (content == null || content.isEmpty()) {
                    String expected = payloadPath != null ? payloadPath : ("talevox/chapter_text/" + chapterId + ".txt");
                    return failJob(jobId, "Missing chapter text. Ensure chapter text file exists or re-import text. chapterId=" + chapterId + " path=" + expected, progressJson);
                }

                boolean isMarkdown = isMarkdownChapter(effectiveBookId, chapterId, payloadPath);
                String speechInput = isMarkdown ? MarkdownSpeechSanitizer.sanitize(content) : content;
                if (isDebuggable() && isMarkdown) {
                    Log.d("GenerateAudioWorker", "markdown_sanitize chapterId=" + chapterId + " origLen=" + content.length() + " speechLen=" + speechInput.length());
                }
                String processed = applyRules(speechInput, rules);
                byte[] mp3 = synthesizeMp3WithProgress(processed, voiceConfig, speakingRate, jobId, progressJson);
                String filePath = saveMp3ToFile(chapterId, mp3);

                String uploadError = null;
                String uploadedId = null;
                String accessToken = JobRunnerPlugin.getDriveAccessTokenSync();
                if (accessToken != null && driveFolderId != null && !driveFolderId.isEmpty()) {
                    try {
                        String existingFileId = JobRunnerPlugin.loadChapterDriveIdSync(effectiveBookId, chapterId);
                        if (existingFileId != null && !existingFileId.isEmpty()) {
                            uploadToDriveUpdateWithRetry(accessToken, existingFileId, "audio/mpeg", mp3);
                            uploadedId = existingFileId;
                        } else {
                            String targetFolderId =
                                resolveChapterDriveFolder(accessToken, driveFolderId, effectiveBookId, chapterId);
                            String filename = "c_" + chapterId + ".mp3";
                            uploadedId = uploadToDriveWithRetry(
                                accessToken,
                                targetFolderId,
                                filename,
                                "audio/mpeg",
                                mp3
                            );
                        }
                    } catch (Exception e) {
                        uploadError = e.getMessage();
                    }
                } else {
                    uploadError = "UPLOAD_PENDING_MISSING_TOKEN_OR_FOLDER";
                }

                JobRunnerPlugin.updateChapterAudioStatusSync(effectiveBookId, chapterId, "ready", filePath, uploadedId);
                if (uploadError != null || uploadedId == null) {
                    JobRunnerPlugin.enqueueUploadQueueItemSync(effectiveBookId, chapterId, filePath);
                    JobRunnerPlugin.ensureUploadQueueJobSync();
                }

                completed = i + 1;
                progressJson.put("currentChunkIndex", 0);
                progressJson.put("currentChunkTotal", 0);
                progressJson.put("currentChapterProgress", 0);
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

            if (completed < total) {
                // More work to do, reschedule (expedited so next batch runs promptly)
                updateJobProgress(jobId, "running", progressJson, null);

                Constraints.Builder constraintsBuilder = new Constraints.Builder()
                    .setRequiredNetworkType(total >= 100 ? NetworkType.UNMETERED : NetworkType.CONNECTED);
                if (total >= 100) {
                    constraintsBuilder.setRequiresCharging(true);
                }

                OneTimeWorkRequest nextRequest = new OneTimeWorkRequest.Builder(GenerateAudioWorker.class)
                    .setInputData(getInputData())
                    .setConstraints(constraintsBuilder.build())
                    .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
                    .build();
                WorkManager.getInstance(getApplicationContext()).enqueue(nextRequest);
                return Result.success();
            } else {
                updateJobProgress(jobId, "completed", progressJson, null);
                emitFinished(jobId, "completed", progressJson, null);
                showFinishedNotification(jobId, "Audio generation complete", total);
                setForegroundAsync(JobNotificationHelper.buildForegroundInfo(getApplicationContext(), jobId, "Audio generation complete", total + " chapter" + (total == 1 ? "" : "s") + " completed", total, total, false, false));
                JobRunnerPlugin.noteForegroundHeartbeat();
                return Result.success();
            }
        } catch (Throwable t) {
            return failJob(jobId, t != null ? t.getMessage() : "Unknown error", null);
        }
    }

    private void updateJobProgress(String jobId, String status, JSONObject progressJson, String error) {
        JobRunnerPlugin.updateJobProgressSync(jobId, status, progressJson, error);
        try {
            if (progressJson != null) {
                Data data = new Data.Builder()
                    .putInt("total", progressJson.optInt("total", 0))
                    .putInt("completed", progressJson.optInt("completed", 0))
                    .putString("currentChapterId", progressJson.optString("currentChapterId", null))
                    .build();
                setProgressAsync(data);
            }
        } catch (Exception ignored) {}
    }

    private void addSkippedChapter(JSONObject progressJson, String chapterId) {
        try {
            JSONArray arr = progressJson.optJSONArray("skippedChapterIds");
            if (arr == null) arr = new JSONArray();
            if (arr.length() < 50) arr.put(chapterId);
            progressJson.put("skippedChapterIds", arr);
        } catch (JSONException ignored) {}
    }

    private String getPayloadTextPath(JSONObject payload, String chapterId) {
        if (payload == null || chapterId == null) return null;
        try {
            JSONObject map = payload.optJSONObject("chapterTextPaths");
            if (map == null) return null;
            String path = map.optString(chapterId, null);
            if (path != null && !path.isEmpty()) return path;
        } catch (Exception ignored) {}
        return null;
    }

    private boolean isMarkdownChapter(String bookId, String chapterId, String payloadPath) {
        if (payloadPath != null && payloadPath.toLowerCase().endsWith(".md")) return true;
        String filename = JobRunnerPlugin.getChapterFilenameSync(bookId, chapterId);
        return filename != null && filename.toLowerCase().endsWith(".md");
    }

    private boolean isDebuggable() {
        return (getApplicationContext().getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0;
    }

    private String normalizeVolumeName(String raw) {
        if (raw == null) return null;
        String trimmed = raw.trim();
        return trimmed.isEmpty() ? null : trimmed;
    }

    private String resolveChapterDriveFolder(String accessToken, String driveFolderId, String bookId, String chapterId) {
        if (driveFolderId == null || driveFolderId.isEmpty()) return driveFolderId;
        List<String> ids = new ArrayList<>();
        ids.add(chapterId);
        Map<String, String> map = JobRunnerPlugin.getChapterVolumeNamesSync(bookId, ids);
        String volumeName = map != null ? map.get(chapterId) : null;
        if (volumeName == null) return driveFolderId;
        try {
            return resolveOrCreateVolumeFolder(accessToken, driveFolderId, volumeName);
        } catch (Exception e) {
            Log.w("GenerateAudioWorker", "resolveChapterDriveFolder fallback to root: " + e.getMessage());
            return driveFolderId;
        }
    }

    private String resolveOrCreateVolumeFolder(String accessToken, String rootFolderId, String volumeName) throws Exception {
        if (volumeName == null || volumeName.isEmpty()) return rootFolderId;
        String cacheKey = rootFolderId + "::" + volumeName.toLowerCase();
        String cached = driveFolderCache.get(cacheKey);
        if (cached != null && !cached.isEmpty()) return cached;
        String existing = findSubfolderId(accessToken, rootFolderId, volumeName);
        String resolved = existing != null ? existing : createSubfolder(accessToken, rootFolderId, volumeName);
        if (resolved == null || resolved.isEmpty()) return rootFolderId;
        if (driveFolderCache.size() >= DRIVE_FOLDER_CACHE_MAX) driveFolderCache.clear();
        driveFolderCache.put(cacheKey, resolved);
        return resolved;
    }

    private String findSubfolderId(String accessToken, String rootFolderId, String folderName) throws Exception {
        String escaped = folderName.replace("'", "\\'");
        String query = "'" + rootFolderId + "' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false and name = '" + escaped + "'";
        String encodedQ = URLEncoder.encode(query, "UTF-8");
        URL url = new URL(
            "https://www.googleapis.com/drive/v3/files?q=" + encodedQ +
                "&fields=files(id,name)&pageSize=10&supportsAllDrives=true&includeItemsFromAllDrives=true"
        );
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        try {
            conn.setRequestMethod("GET");
            conn.setRequestProperty("Authorization", "Bearer " + accessToken);
            conn.setRequestProperty("Accept", "application/json");
            int code = conn.getResponseCode();
            if (code < 200 || code >= 300) {
                throw new Exception("Drive subfolder lookup failed: " + code);
            }
            byte[] bytes = readAllBytes(conn.getInputStream());
            JSONObject data = new JSONObject(new String(bytes, StandardCharsets.UTF_8));
            JSONArray files = data.optJSONArray("files");
            if (files == null) return null;
            for (int i = 0; i < files.length(); i++) {
                JSONObject file = files.optJSONObject(i);
                if (file == null) continue;
                String id = file.optString("id", null);
                String name = file.optString("name", "");
                if (id != null && !id.isEmpty() && name.equalsIgnoreCase(folderName)) {
                    return id;
                }
            }
            return null;
        } finally {
            conn.disconnect();
        }
    }

    private String createSubfolder(String accessToken, String rootFolderId, String folderName) throws Exception {
        JSONObject body = new JSONObject();
        body.put("name", folderName);
        body.put("mimeType", "application/vnd.google-apps.folder");
        JSONArray parents = new JSONArray();
        parents.put(rootFolderId);
        body.put("parents", parents);

        URL url = new URL("https://www.googleapis.com/drive/v3/files?supportsAllDrives=true&fields=id,name");
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        try {
            conn.setRequestMethod("POST");
            conn.setDoOutput(true);
            conn.setRequestProperty("Authorization", "Bearer " + accessToken);
            conn.setRequestProperty("Content-Type", "application/json; charset=UTF-8");
            byte[] payload = body.toString().getBytes(StandardCharsets.UTF_8);
            conn.setFixedLengthStreamingMode(payload.length);
            try (OutputStream os = conn.getOutputStream()) {
                os.write(payload);
            }

            int code = conn.getResponseCode();
            if (code < 200 || code >= 300) {
                throw new Exception("Drive subfolder create failed: " + code);
            }
            byte[] bytes = readAllBytes(conn.getInputStream());
            JSONObject data = new JSONObject(new String(bytes, StandardCharsets.UTF_8));
            String id = data.optString("id", null);
            if (id == null || id.isEmpty()) {
                throw new Exception("Drive subfolder create returned no id");
            }
            return id;
        } finally {
            conn.disconnect();
        }
    }

    private String readTextFromPath(String path) {
        if (path == null || path.isEmpty()) return null;
        try {
            if (path.startsWith("file://")) {
                path = path.replaceFirst("^file://", "");
            }
            if (path.startsWith("content://")) {
                try (InputStream is = getApplicationContext().getContentResolver().openInputStream(android.net.Uri.parse(path))) {
                    if (is == null) return null;
                    byte[] bytes = readAllBytes(is);
                    return new String(bytes, StandardCharsets.UTF_8);
                }
            }
            File file = path.startsWith(File.separator)
                ? new File(path)
                : new File(getApplicationContext().getFilesDir(), path);
            if (!file.exists()) return null;
            FileInputStream fis = new FileInputStream(file);
            byte[] bytes = readAllBytes(fis);
            fis.close();
            return new String(bytes, StandardCharsets.UTF_8);
        } catch (Exception e) {
            Log.d("GenerateAudioWorker", "readTextFromPath failed: " + e.getMessage());
            return null;
        }
    }

    private List<Rule> loadRulesForBook(String bookId) {
        String rulesJson = JobRunnerPlugin.getRulesForBookSync(bookId);
        return parseRulesArray(rulesJson);
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

            String cacheKey = pattern + "\0" + flags;
            Pattern regex = rulePatternCache.get(cacheKey);
            if (regex == null) {
                regex = Pattern.compile(pattern, flags);
                rulePatternCache.put(cacheKey, regex);
            }
            String replacement = "DELETE".equals(rule.ruleType) ? "" : (rule.speakAs != null ? rule.speakAs : "");
            processed = regex.matcher(processed).replaceAll(Matcher.quoteReplacement(replacement));
        }
        return processed;
    }

    private byte[] synthesizeMp3WithProgress(String text, VoiceConfig voiceConfig, double speakingRate, String jobId, JSONObject progressJson) throws Exception {
        int maxBytes = "openai".equals(voiceConfig.provider) ? MAX_OPENAI_BYTES : MAX_TTS_BYTES;
        List<String> chunks = chunkTextByUtf8Bytes(text, maxBytes);
        int chunkTotal = Math.max(1, chunks.size());
        progressJson.put("currentChunkTotal", chunkTotal);
        progressJson.put("currentChunkIndex", 0);
        progressJson.put("currentChapterProgress", 0);
        updateJobProgress(jobId, "running", progressJson, null);
        emitProgress(jobId, "running", progressJson);

        ByteArrayOutputStream out = new ByteArrayOutputStream();
        boolean first = true;
        for (int i = 0; i < chunks.size(); i++) {
            String chunk = chunks.get(i);
            byte[] bytes = "openai".equals(voiceConfig.provider)
                ? postOpenAiTts(chunk, voiceConfig.id, speakingRate)
                : postTts(chunk, voiceConfig.id, speakingRate);
            if (!first) bytes = stripId3(bytes);
            out.write(bytes);
            first = false;

            double chapterProgress = (i + 1) / (double) chunkTotal;
            progressJson.put("currentChunkIndex", i + 1);
            progressJson.put("currentChapterProgress", chapterProgress);
            updateJobProgress(jobId, "running", progressJson, null);
            emitProgress(jobId, "running", progressJson);
            JobRunnerPlugin.noteForegroundHeartbeat();
        }
        return out.toByteArray();
    }

    private byte[] postTts(String text, String voiceId, double speakingRate) throws Exception {
        URL url = new URL(DEFAULT_ENDPOINT);
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        try {
            conn.setRequestMethod("POST");
            conn.setConnectTimeout(20000);
            conn.setReadTimeout(60000);
            conn.setDoOutput(true);
            conn.setRequestProperty("Content-Type", "application/json");
            conn.setRequestProperty("x-api-key", BuildConfig.TTS_API_KEY);

            JSONObject payload = new JSONObject();
            payload.put("text", text);
            payload.put("voiceName", voiceId);
            payload.put("speakingRate", speakingRate);
            payload.put("languageCode", "en-US");

            byte[] body = payload.toString().getBytes(StandardCharsets.UTF_8);
            try (OutputStream os = conn.getOutputStream()) {
                os.write(body);
            }

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
        } finally {
            conn.disconnect();
        }
    }

    private byte[] postOpenAiTts(String text, String voiceId, double speakingRate) throws Exception {
        String apiKey = BuildConfig.OPENAI_API_KEY;
        if (apiKey == null || apiKey.isEmpty()) {
            throw new Exception("Missing OpenAI API key");
        }
        URL url = new URL(OPENAI_ENDPOINT);
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        try {
            conn.setRequestMethod("POST");
            conn.setConnectTimeout(20000);
            conn.setReadTimeout(60000);
            conn.setDoOutput(true);
            conn.setRequestProperty("Content-Type", "application/json");
            conn.setRequestProperty("Authorization", "Bearer " + apiKey);

            double speed = Math.max(0.5, Math.min(2.0, speakingRate));

            JSONObject payload = new JSONObject();
            payload.put("model", OPENAI_MODEL);
            payload.put("voice", voiceId);
            payload.put("input", text);
            payload.put("response_format", "mp3");
            payload.put("speed", speed);

            byte[] body = payload.toString().getBytes(StandardCharsets.UTF_8);
            try (OutputStream os = conn.getOutputStream()) {
                os.write(body);
            }

            int code = conn.getResponseCode();
            InputStream stream = code >= 200 && code < 300 ? conn.getInputStream() : conn.getErrorStream();
            byte[] bytes = readAllBytes(stream);
            if (code < 200 || code >= 300) {
                String errText = new String(bytes, StandardCharsets.UTF_8);
                throw new Exception("OpenAI TTS Failed: " + code + " " + errText);
            }
            return bytes;
        } finally {
            conn.disconnect();
        }
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
        File dir = new File(getApplicationContext().getFilesDir(), "talevox/audio");
        if (!dir.exists()) dir.mkdirs();
        File out = new File(dir, chapterId + ".mp3");
        if (out.exists()) {
            if (!out.delete()) {
                Log.w("GenerateAudioWorker", "Could not delete existing audio file for regen: " + out.getAbsolutePath());
            }
        }
        FileOutputStream fos = new FileOutputStream(out);
        fos.write(mp3);
        fos.flush();
        fos.close();
        JobRunnerPlugin.upsertChapterAudioPathSync(chapterId, out.getAbsolutePath(), mp3 != null ? mp3.length : 0);
        return out.getAbsolutePath();
    }

    private String extractAccessToken(JSONObject session) {
        String token = session.optString("accessToken", null);
        if (token == null || token.isEmpty()) token = session.optString("access_token", null);
        if (token == null || token.isEmpty()) {
            JSONObject auth = session.optJSONObject("authentication");
            if (auth != null) {
                token = auth.optString("accessToken", null);
                if (token == null || token.isEmpty()) token = auth.optString("access_token", null);
            }
        }
        Object tokenObj = session.opt("accessToken");
        if ((token == null || token.isEmpty()) && tokenObj instanceof JSONObject) {
            JSONObject accessTokenObj = (JSONObject) tokenObj;
            token = accessTokenObj.optString("token", null);
            if (token == null || token.isEmpty()) token = accessTokenObj.optString("accessToken", null);
            if (token == null || token.isEmpty()) token = accessTokenObj.optString("access_token", null);
        }
        return (token == null || token.isEmpty()) ? null : token;
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

    private void uploadToDriveUpdateWithRetry(String accessToken, String fileId, String mimeType, byte[] content) throws Exception {
        int attempt = 0;
        long delayMs = 1000;
        while (true) {
            try {
                uploadToDriveUpdate(accessToken, fileId, mimeType, content);
                return;
            } catch (RetryableUploadException e) {
                attempt++;
                if (attempt >= MAX_UPLOAD_RETRIES) throw e;
                long jitter = (long) (Math.random() * delayMs);
                Thread.sleep(delayMs + jitter);
                delayMs = Math.min(delayMs * 2, 20000);
            }
        }
    }

    private void uploadToDriveUpdate(String accessToken, String fileId, String mimeType, byte[] content) throws Exception {
        String encodedId = java.net.URLEncoder.encode(fileId, StandardCharsets.UTF_8.name());
        URL url = new URL("https://www.googleapis.com/upload/drive/v3/files/" + encodedId + "?uploadType=media");
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        try {
            conn.setRequestMethod("PATCH");
            conn.setConnectTimeout(20000);
            conn.setReadTimeout(60000);
            conn.setDoOutput(true);
            conn.setRequestProperty("Authorization", "Bearer " + accessToken);
            conn.setRequestProperty("Content-Type", mimeType);

            try (OutputStream os = conn.getOutputStream()) {
                os.write(content);
            }

            int code = conn.getResponseCode();
            if (code == 429 || code == 500 || code == 502 || code == 503 || code == 504) {
                throw new RetryableUploadException("Drive update retryable: " + code);
            }
            if (code < 200 || code >= 300) {
                byte[] errBytes = readAllBytes(code >= 200 && code < 300 ? conn.getInputStream() : conn.getErrorStream());
                throw new Exception("Drive update failed: " + code + " " + new String(errBytes, StandardCharsets.UTF_8));
            }
        } finally {
            conn.disconnect();
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
        try {
            conn.setRequestMethod("POST");
            conn.setConnectTimeout(20000);
            conn.setReadTimeout(60000);
            conn.setDoOutput(true);
            conn.setRequestProperty("Authorization", "Bearer " + accessToken);
            conn.setRequestProperty("Content-Type", "multipart/related; boundary=" + boundary);

            try (OutputStream os = conn.getOutputStream()) {
                os.write(body.toByteArray());
            }

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
        } finally {
            conn.disconnect();
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
        NotificationManager nm = (NotificationManager) getApplicationContext().getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        int total = progressJson != null ? progressJson.optInt("total", 0) : 0;
        int completed = progressJson != null ? progressJson.optInt("completed", 0) : 0;
        String currentChapterId = progressJson != null ? progressJson.optString("currentChapterId", "") : "";
        String text = total > 0 ? ("Chapter " + Math.min(completed + 1, total) + " of " + total) : "Preparing…";
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

    private void showFinishedNotification(String jobId, String title, int totalChapters) {
        showFinishedNotification(jobId, title, totalChapters > 0 ? (totalChapters + " chapter" + (totalChapters == 1 ? "" : "s") + " completed") : "Done", true);
    }

    private void showFinishedNotification(String jobId, String title, String text, boolean success) {
        NotificationManager nm = (NotificationManager) getApplicationContext().getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        Notification notification = JobNotificationHelper.buildFinished(getApplicationContext(), jobId, title, text, success);
        nm.notify(JobNotificationHelper.getNotificationId(jobId), notification);
    }

    private Result failJob(String jobId, String message, JSONObject progressJson) {
        JSONObject progress = progressJson != null ? progressJson : new JSONObject();
        try { progress.put("error", message); } catch (JSONException ignored) {}
        updateJobProgress(jobId, "failed", progress, message);
        try {
            emitFinished(jobId, "failed", progress, message);
        } catch (Exception ignored) {}
        try {
            String errText = (message != null && !message.trim().isEmpty()) ? message : "An error occurred";
            showFinishedNotification(jobId, "Audio generation failed", errText, false);
        } catch (Exception ignored) {}
        try {
            String errText = (message != null && !message.trim().isEmpty()) ? message : "An error occurred";
            setForegroundAsync(JobNotificationHelper.buildForegroundInfo(getApplicationContext(), jobId, "Audio generation failed", errText, 0, 0, true, false));
        } catch (Exception ignored) {}
        JobRunnerPlugin.noteForegroundHeartbeat();
        return Result.failure();
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

    @Override
    public void onStopped() {
        super.onStopped();
    }
}
