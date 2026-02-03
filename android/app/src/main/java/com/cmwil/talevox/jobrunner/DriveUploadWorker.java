package com.cmwil.talevox.jobrunner;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.net.Uri;

import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;
import androidx.work.ForegroundInfo;
import androidx.work.ListenableWorker.Result;
import android.app.Notification;
import android.app.NotificationManager;
import com.getcapacitor.JSObject;
import com.cmwil.talevox.notifications.JobNotificationHelper;
import com.cmwil.talevox.notifications.JobNotificationChannels;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

public class DriveUploadWorker extends Worker {
    private static final String DB_NAME = "talevox_db";
    private static final String DB_FILE = DB_NAME + "SQLite.db";
    private static final int MAX_UPLOAD_RETRIES = 5;
    private static final String CHANNEL_ID = JobNotificationChannels.CHANNEL_JOBS_ID;

    public DriveUploadWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        String jobId = getInputData().getString("jobId");
        try {
            ProgressState progress = loadJobProgress(jobId);
            progress.json.put("jobType", "drive_upload_queue");
            progress.json.put("queuedTotal", countPendingUploads());
            progress.json.put("processedThisRun", 0);
            progress.json.put("succeededCount", progress.completed);
            progress.json.put("failedCount", progress.json.optInt("failedCount", 0));
            updateJob(jobId, "running", progress.json, null);
            if (progress.total == 0) {
                progress.total = countPendingUploads();
                progress.json.put("total", progress.total);
            }
            setForegroundAsync(JobNotificationHelper.buildForegroundInfo(
                getApplicationContext(),
                jobId,
                "Uploading audio",
                "",
                progress.total,
                progress.completed,
                false,
                true
            ));
            showProgressNotification(jobId, progress);
            JobRunnerPlugin.noteForegroundHeartbeat();

            int processedThisRun = 0;
            while (processedThisRun < 20) {
                DriveUploadItem item = getNextReadyUpload(System.currentTimeMillis());
                if (item == null) {
                    finishJob(jobId, progress, "completed", "Uploads complete");
                    return Result.success();
                }

                long nextAttemptAt = System.currentTimeMillis() + 5000;
                markUploadUploading(item.id, nextAttemptAt);

                try {
                    String resolvedPath = resolveExistingPath(item.localPath, item.chapterId);
                    if (resolvedPath != null && (item.localPath == null || !resolvedPath.equals(item.localPath))) {
                        updateUploadLocalPath(item.id, resolvedPath);
                        item.localPath = resolvedPath;
                    }
                    byte[] bytes = readFileBytes(resolvedPath);
                    String accessToken = loadDriveAccessToken();
                    if (accessToken == null || accessToken.isEmpty()) {
                        markUploadFailed(item.id, "MISSING_DRIVE_TOKEN", System.currentTimeMillis() + 60000);
                        return Result.success();
                    }

                    String folderId = resolveBookDriveFolderId(item.bookId);
                    if (folderId == null || folderId.isEmpty()) folderId = item.bookId;

                    String existingId = loadChapterDriveId(item.bookId, item.chapterId);
                    String filename = "c_" + item.chapterId + ".mp3";

                    String uploadedId = uploadToDriveWithRetry(accessToken, folderId, filename, "audio/mpeg", bytes, existingId);
                    updateChapterAfterUpload(item.bookId, item.chapterId, uploadedId);
                    markUploadDone(item.id);

                    progress.completed += 1;
                    processedThisRun += 1;
                    progress.json.put("completed", progress.completed);
                    progress.json.put("total", progress.total);
                    progress.json.put("lastChapterId", item.chapterId);
                    progress.json.put("processedThisRun", processedThisRun);
                    progress.json.put("succeededCount", progress.completed);
                    updateJob(jobId, "running", progress.json, null);
                    emitProgress(jobId, progress);
                    setForegroundAsync(JobNotificationHelper.buildForegroundInfo(
                        getApplicationContext(),
                        jobId,
                        "Uploading audio",
                        "",
                        progress.total,
                        progress.completed,
                        false,
                        true
                    ));
                    showProgressNotification(jobId, progress);
                    JobRunnerPlugin.noteForegroundHeartbeat();
                } catch (RetryableUploadException e) {
                    long backoffMs = computeBackoff(item.attempts + 1);
                    markUploadFailed(item.id, e.getMessage(), System.currentTimeMillis() + backoffMs);
                    progress.json.put("failedCount", progress.json.optInt("failedCount", 0) + 1);
                    updateJob(jobId, "running", progress.json, null);
                    emitProgress(jobId, progress);
                    progress.json.put("lastError", e.getMessage());
                    JobRunnerPlugin.noteForegroundHeartbeat();
                    return Result.success();
                } catch (Exception e) {
                    long backoffMs = computeBackoff(item.attempts + 1);
                    markUploadFailed(item.id, e.getMessage(), System.currentTimeMillis() + backoffMs);
                    progress.json.put("failedCount", progress.json.optInt("failedCount", 0) + 1);
                    updateJob(jobId, "running", progress.json, null);
                    emitProgress(jobId, progress);
                    progress.json.put("lastError", e.getMessage());
                    JobRunnerPlugin.noteForegroundHeartbeat();
                    return Result.success();
                }

                if (isStopped()) {
                    finishJob(jobId, progress, "canceled", "Uploads canceled");
                    JobRunnerPlugin.noteForegroundHeartbeat();
                    return Result.success();
                }
            }
            // More work remains; keep job running and let WorkManager reschedule.
            updateJob(jobId, "running", progress.json, null);
            emitProgress(jobId, progress);
            showProgressNotification(jobId, progress);
            return Result.retry();
        } catch (Exception e) {
            ProgressState progress = loadJobProgress(jobId);
            finishJob(jobId, progress, "failed", e.getMessage());
            return Result.failure();
        }
    }

    private void finishJob(String jobId, ProgressState progress, String status, String message) {
        try {
            if (progress != null) {
                String errorToStore = "completed".equals(status) ? null : message;
                if ("completed".equals(status) && message != null) {
                    progress.json.put("lastMessage", message);
                }
                updateJob(jobId, status, progress.json, errorToStore);
                emitFinished(jobId, status, progress, errorToStore);
                NotificationManager nm = (NotificationManager) getApplicationContext().getSystemService(Context.NOTIFICATION_SERVICE);
                if (nm != null) {
                    JobNotificationChannels.ensureChannels(getApplicationContext());
                    Notification notification = JobNotificationHelper.buildFinished(
                        getApplicationContext(),
                        jobId,
                        "Upload complete",
                        message != null ? message : "",
                        "completed".equals(status)
                    );
                    nm.notify(JobNotificationHelper.getNotificationId(jobId), notification);
                }
            }
        } catch (Exception ignored) {}
    }

    private SQLiteDatabase getDb() {
        Context ctx = getApplicationContext();
        SQLiteDatabase db = ctx.openOrCreateDatabase(DB_FILE, Context.MODE_PRIVATE, null);
        db.execSQL(
            "CREATE TABLE IF NOT EXISTS kv (" +
            "key TEXT PRIMARY KEY," +
            "json TEXT NOT NULL," +
            "updatedAt INTEGER NOT NULL" +
            ")"
        );
        db.execSQL(
            "CREATE TABLE IF NOT EXISTS drive_upload_queue (" +
            "id TEXT PRIMARY KEY," +
            "chapterId TEXT," +
            "bookId TEXT," +
            "localPath TEXT," +
            "status TEXT," +
            "attempts INTEGER," +
            "nextAttemptAt INTEGER," +
            "lastError TEXT," +
            "createdAt INTEGER," +
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

    private ProgressState loadJobProgress(String jobId) {
        ProgressState state = new ProgressState();
        state.json = new JSONObject();
        if (jobId == null || jobId.isEmpty()) return state;
        try {
            SQLiteDatabase db = getDb();
            Cursor cursor = db.query("jobs", new String[]{"progressJson", "status"}, "jobId = ?", new String[]{jobId}, null, null, null);
            if (cursor.moveToFirst()) {
                String progressStr = cursor.getString(cursor.getColumnIndexOrThrow("progressJson"));
                if (progressStr != null) state.json = new JSONObject(progressStr);
            }
            cursor.close();
        } catch (Exception ignored) {}
        state.total = state.json.optInt("total", countPendingUploads());
        state.completed = state.json.optInt("completed", 0);
        return state;
    }

    private int countPendingUploads() {
        int count = 0;
        try {
            SQLiteDatabase db = getDb();
            Cursor cursor = db.rawQuery("SELECT COUNT(*) as c FROM drive_upload_queue WHERE status IN ('queued','failed','uploading')", null);
            if (cursor.moveToFirst()) {
                count = cursor.getInt(cursor.getColumnIndexOrThrow("c"));
            }
            cursor.close();
        } catch (Exception ignored) {}
        return count;
    }

    private void updateJob(String jobId, String status, JSONObject progress, String error) {
        if (jobId == null || jobId.isEmpty()) return;
        try {
            SQLiteDatabase db = getDb();
            ContentValues values = new ContentValues();
            values.put("status", status);
            values.put("updatedAt", System.currentTimeMillis());
            if (progress != null) values.put("progressJson", progress.toString());
            if (error != null) values.put("error", error);
            db.update("jobs", values, "jobId = ?", new String[]{jobId});
        } catch (Exception ignored) {}
    }

    private void emitProgress(String jobId, ProgressState progress) {
        if (jobId == null) return;
        JSObject payload = new JSObject();
        payload.put("jobId", jobId);
        payload.put("status", "running");
        payload.put("progress", progress.json);
        JobRunnerPlugin.emitJobProgress(payload);
    }

    private void emitFinished(String jobId, String status, ProgressState progress, String error) {
        if (jobId == null) return;
        JSObject payload = new JSObject();
        payload.put("jobId", jobId);
        payload.put("status", status);
        payload.put("progress", progress != null ? progress.json : new JSONObject());
        if (error != null) payload.put("error", error);
        JobRunnerPlugin.emitJobFinished(payload);
    }

    private void showProgressNotification(String jobId, ProgressState progress) {
        NotificationManager nm = (NotificationManager) getApplicationContext().getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        String text = progress.total > 0 ? ("Uploaded " + progress.completed + " of " + progress.total) : "Uploading audio";
        Notification n = JobNotificationHelper.buildProgress(
            getApplicationContext(),
            jobId,
            "Uploading audio",
            text,
            progress.total > 0 ? progress.total : 100,
            progress.completed,
            progress.total == 0,
            true
        );
        nm.notify(JobNotificationHelper.getNotificationId(jobId), n);
    }

    private DriveUploadItem getNextReadyUpload(long now) {
        SQLiteDatabase db = getDb();
        Cursor cursor = db.query(
            "drive_upload_queue",
            null,
            "(status = ? OR status = ?) AND nextAttemptAt <= ?",
            new String[]{"queued", "failed", String.valueOf(now)},
            null,
            null,
            "nextAttemptAt ASC, createdAt ASC",
            "1"
        );
        if (!cursor.moveToFirst()) {
            cursor.close();
            return null;
        }

        DriveUploadItem item = new DriveUploadItem();
        item.id = cursor.getString(cursor.getColumnIndexOrThrow("id"));
        item.chapterId = cursor.getString(cursor.getColumnIndexOrThrow("chapterId"));
        item.bookId = cursor.getString(cursor.getColumnIndexOrThrow("bookId"));
        item.localPath = cursor.getString(cursor.getColumnIndexOrThrow("localPath"));
        item.attempts = cursor.getInt(cursor.getColumnIndexOrThrow("attempts"));
        cursor.close();
        return item;
    }

    private void markUploadUploading(String id, long nextAttemptAt) {
        SQLiteDatabase db = getDb();
        db.execSQL(
            "UPDATE drive_upload_queue SET status = 'uploading', attempts = attempts + 1, nextAttemptAt = ?, updatedAt = ? WHERE id = ?",
            new Object[]{nextAttemptAt, System.currentTimeMillis(), id}
        );
    }

    private void markUploadDone(String id) {
        SQLiteDatabase db = getDb();
        db.delete("drive_upload_queue", "id = ?", new String[]{id});
    }

    private void markUploadFailed(String id, String error, long nextAttemptAt) {
        SQLiteDatabase db = getDb();
        db.execSQL(
            "UPDATE drive_upload_queue SET status = 'failed', lastError = ?, nextAttemptAt = ?, attempts = attempts + 1, updatedAt = ? WHERE id = ?",
            new Object[]{error, nextAttemptAt, System.currentTimeMillis(), id}
        );
    }

    private void updateUploadLocalPath(String id, String localPath) {
        try {
            SQLiteDatabase db = getDb();
            db.execSQL(
                "UPDATE drive_upload_queue SET localPath = ?, updatedAt = ? WHERE id = ?",
                new Object[]{localPath, System.currentTimeMillis(), id}
            );
        } catch (Exception ignored) {}
    }

    private String resolveExistingPath(String localPath, String chapterId) {
        if (isPathReadable(localPath)) return localPath;
        if (chapterId != null && !chapterId.isEmpty()) {
            File primary = new File(getApplicationContext().getFilesDir(), "talevox/audio/" + chapterId + ".mp3");
            if (isPathReadable(primary.getAbsolutePath())) return primary.getAbsolutePath();
            File legacy = new File(getApplicationContext().getFilesDir(), "audio/" + chapterId + ".mp3");
            if (isPathReadable(legacy.getAbsolutePath())) return legacy.getAbsolutePath();
        }
        return localPath;
    }

    private boolean isPathReadable(String localPath) {
        if (localPath == null || localPath.isEmpty()) return false;
        if (localPath.startsWith("content://")) return true;
        String path = localPath.startsWith("file://") ? localPath.replace("file://", "") : localPath;
        File file = new File(path);
        return file.exists();
    }

    private long computeBackoff(int attempts) {
        long base = 1000L;
        long max = 60000L;
        long delay = (long) (base * Math.pow(2, Math.max(0, attempts - 1)));
        if (delay > max) delay = max;
        long jitter = (long) (Math.random() * 500L);
        return delay + jitter;
    }

    private byte[] readFileBytes(String localPath) throws Exception {
        if (localPath == null) throw new Exception("Missing localPath");
        String path = localPath.startsWith("file://") ? localPath.replace("file://", "") : localPath;
        if (path.startsWith("content://")) {
            Uri uri = Uri.parse(path);
            InputStream is = getApplicationContext().getContentResolver().openInputStream(uri);
            if (is == null) throw new Exception("Unable to open content URI");
            return readAllBytes(is);
        }
        File file = new File(path);
        if (!file.exists()) throw new Exception("Local file missing");
        FileInputStream fis = new FileInputStream(file);
        return readAllBytes(fis);
    }

    private byte[] readAllBytes(InputStream stream) throws Exception {
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        byte[] tmp = new byte[8192];
        int read;
        while ((read = stream.read(tmp)) != -1) {
            buffer.write(tmp, 0, read);
        }
        stream.close();
        return buffer.toByteArray();
    }

    private String resolveBookDriveFolderId(String bookId) {
        SQLiteDatabase db = getDb();
        Cursor cursor = db.query(
            "books",
            new String[]{"driveFolderId"},
            "id = ?",
            new String[]{bookId},
            null,
            null,
            null
        );
        if (!cursor.moveToFirst()) {
            cursor.close();
            return null;
        }
        String folderId = cursor.getString(cursor.getColumnIndexOrThrow("driveFolderId"));
        cursor.close();
        return folderId;
    }

    private String loadChapterDriveId(String bookId, String chapterId) {
        SQLiteDatabase db = getDb();
        Cursor cursor = db.query(
            "chapters",
            new String[]{"cloudAudioFileId"},
            "id = ? AND bookId = ?",
            new String[]{chapterId, bookId},
            null,
            null,
            null
        );
        if (!cursor.moveToFirst()) {
            cursor.close();
            return null;
        }
        String id = cursor.getString(cursor.getColumnIndexOrThrow("cloudAudioFileId"));
        cursor.close();
        return id;
    }

    private void updateChapterAfterUpload(String bookId, String chapterId, String uploadedId) {
        SQLiteDatabase db = getDb();
        ContentValues values = new ContentValues();
        values.put("cloudAudioFileId", uploadedId);
        values.put("audioDriveId", uploadedId);
        values.put("audioStatus", "ready");
        values.put("updatedAt", System.currentTimeMillis());
        db.update("chapters", values, "id = ? AND bookId = ?", new String[]{chapterId, bookId});
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

    private String uploadToDriveWithRetry(
        String accessToken,
        String folderId,
        String filename,
        String mimeType,
        byte[] content,
        String existingFileId
    ) throws Exception {
        int attempt = 0;
        long delayMs = 1000;
        while (true) {
            try {
                return uploadToDrive(accessToken, folderId, filename, mimeType, content, existingFileId);
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
        byte[] content,
        String existingFileId
    ) throws Exception {
        String boundary = "-------talevox_sync_boundary";
        JSONObject metadata = new JSONObject();
        metadata.put("name", filename);
        metadata.put("mimeType", mimeType);
        if (folderId != null && (existingFileId == null || existingFileId.isEmpty())) {
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

        String url = existingFileId != null && !existingFileId.isEmpty()
            ? "https://www.googleapis.com/upload/drive/v3/files/" + existingFileId + "?uploadType=multipart&supportsAllDrives=true"
            : "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id&supportsAllDrives=true";

        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setRequestMethod(existingFileId != null && !existingFileId.isEmpty() ? "PATCH" : "POST");
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
        String id = json.optString("id", null);
        return id != null ? id : existingFileId;
    }

    private static class DriveUploadItem {
        String id;
        String chapterId;
        String bookId;
        String localPath;
        int attempts;
    }

    private static class ProgressState {
        int total;
        int completed;
        JSONObject json;
    }

    private static class RetryableUploadException extends Exception {
        RetryableUploadException(String message) {
            super(message);
        }
    }
}
