package com.cmwil.talevox.jobrunner;

import android.content.Context;
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
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

public class DriveUploadWorker extends Worker {
    private static final int MAX_UPLOAD_RETRIES = 5;
    /** Number of uploads to run in parallel per batch. Keep at 1 for maximum stability. */
    private static final int CONCURRENT_UPLOADS = 1;
    /** Delay between uploads (ms) to pace job and reduce rate-limit risk. */
    private static final long UPLOAD_DELAY_MS = 300;
    private static final long TOKEN_EXPIRY_GRACE_MS = 5 * 60 * 1000; // 5 min grace past expiresAt
    private static final String CHANNEL_ID = JobNotificationChannels.CHANNEL_JOBS_ID;
    private static final String KEY_UPLOAD_QUEUE_PAUSED = "upload_queue_paused";

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
            progress.json.put("queuedTotal", JobRunnerPlugin.countPendingUploadsSync());
            progress.json.put("processedThisRun", 0);
            progress.json.put("succeededCount", progress.completed);
            progress.json.put("failedCount", progress.json.optInt("failedCount", 0));
            updateJob(jobId, "running", progress.json, null);
            if (JobRunnerPlugin.isUploadQueuePausedSync()) {
                finishJob(jobId, progress, "paused", "Uploads paused");
                return Result.success();
            }
            if (progress.total == 0) {
                progress.total = JobRunnerPlugin.countPendingUploadsSync();
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
                List<JobRunnerPlugin.DriveUploadItemResult> itemsResult = JobRunnerPlugin.getNextReadyUploadsSync(System.currentTimeMillis(), CONCURRENT_UPLOADS);
                if (itemsResult == null || itemsResult.isEmpty()) {
                    finishJob(jobId, progress, "completed", "Uploads complete");
                    return Result.success();
                }

                // Check paused BEFORE marking items as uploading to avoid leaving
                // items stuck in "uploading" state when the queue is paused.
                if (JobRunnerPlugin.isUploadQueuePausedSync()) {
                    finishJob(jobId, progress, "paused", "Uploads paused");
                    return Result.success();
                }

                long nextAttemptAt = System.currentTimeMillis() + 5000;
                for (JobRunnerPlugin.DriveUploadItemResult it : itemsResult) {
                    JobRunnerPlugin.markUploadUploadingSync(it.id, nextAttemptAt);
                }

                String accessToken = JobRunnerPlugin.getDriveAccessTokenSync();
                if (accessToken == null || accessToken.isEmpty()) {
                    for (JobRunnerPlugin.DriveUploadItemResult it : itemsResult) {
                        JobRunnerPlugin.markUploadFailedSync(it.id, "MISSING_DRIVE_TOKEN", System.currentTimeMillis() + 60000);
                    }
                    return Result.success();
                }

                List<UploadTask> tasks = new ArrayList<>();
                for (JobRunnerPlugin.DriveUploadItemResult item : itemsResult) {
                    try {
                        String resolvedPath = resolveExistingPath(item.localPath, item.chapterId);
                        if (resolvedPath != null && (item.localPath == null || !resolvedPath.equals(item.localPath))) {
                            JobRunnerPlugin.updateUploadLocalPathSync(item.id, resolvedPath);
                        }
                        byte[] bytes = readFileBytes(resolvedPath != null ? resolvedPath : item.localPath);
                        String folderId = JobRunnerPlugin.resolveBookDriveFolderIdSync(item.bookId);
                        if (folderId == null || folderId.isEmpty()) folderId = item.bookId;
                        String existingId = JobRunnerPlugin.loadChapterDriveIdSync(item.bookId, item.chapterId);
                        String filename = "c_" + item.chapterId + ".mp3";
                        tasks.add(new UploadTask(item, bytes, folderId, existingId, filename));
                    } catch (Exception e) {
                        long backoffMs = computeBackoff(item.attempts + 1);
                        JobRunnerPlugin.markUploadFailedSync(item.id, e.getMessage(), System.currentTimeMillis() + backoffMs);
                        progress.json.put("failedCount", progress.json.optInt("failedCount", 0) + 1);
                        progress.json.put("lastError", e.getMessage());
                    }
                }

                if (tasks.isEmpty()) {
                    updateJob(jobId, "running", progress.json, null);
                    emitProgress(jobId, progress);
                    continue;
                }

                if (CONCURRENT_UPLOADS == 1 && tasks.size() == 1) {
                    UploadTask task = tasks.get(0);
                    UploadResult r;
                    try {
                        String id = uploadToDriveWithRetry(accessToken, task.folderId, task.filename, "audio/mpeg", task.bytes, task.existingId);
                        r = new UploadResult(task.item, id, null);
                    } catch (Exception e) {
                        r = new UploadResult(task.item, null, e.getMessage());
                    }
                    if (isStopped()) {
                        finishJob(jobId, progress, "canceled", "Uploads canceled");
                        JobRunnerPlugin.noteForegroundHeartbeat();
                        return Result.success();
                    }
                    if (r.uploadedId != null) {
                        JobRunnerPlugin.updateChapterAfterUploadSync(r.item.bookId, r.item.chapterId, r.uploadedId);
                        JobRunnerPlugin.markUploadDoneSync(r.item.id);
                        progress.completed += 1;
                        progress.json.put("lastChapterId", r.item.chapterId);
                    } else {
                        long backoffMs = computeBackoff(r.item.attempts + 1);
                        JobRunnerPlugin.markUploadFailedSync(r.item.id, r.error != null ? r.error : "Upload failed", System.currentTimeMillis() + backoffMs);
                        progress.json.put("failedCount", progress.json.optInt("failedCount", 0) + 1);
                        progress.json.put("lastError", r.error);
                    }
                    processedThisRun += 1;
                } else {
                ExecutorService exec = Executors.newFixedThreadPool(Math.min(tasks.size(), CONCURRENT_UPLOADS));
                try {
                    List<Future<UploadResult>> futures = new ArrayList<>();
                    for (UploadTask task : tasks) {
                        final String token = accessToken;
                        futures.add(exec.submit(new Callable<UploadResult>() {
                            @Override
                            public UploadResult call() {
                                try {
                                    String id = uploadToDriveWithRetry(token, task.folderId, task.filename, "audio/mpeg", task.bytes, task.existingId);
                                    return new UploadResult(task.item, id, null);
                                } catch (Exception e) {
                                    return new UploadResult(task.item, null, e.getMessage());
                                }
                            }
                        }));
                    }
                    for (Future<UploadResult> f : futures) {
                        if (isStopped()) {
                            finishJob(jobId, progress, "canceled", "Uploads canceled");
                            JobRunnerPlugin.noteForegroundHeartbeat();
                            exec.shutdown();
                            return Result.success();
                        }
                        try {
                            UploadResult r = f.get();
                            if (r.uploadedId != null) {
                                JobRunnerPlugin.updateChapterAfterUploadSync(r.item.bookId, r.item.chapterId, r.uploadedId);
                                JobRunnerPlugin.markUploadDoneSync(r.item.id);
                                progress.completed += 1;
                                progress.json.put("lastChapterId", r.item.chapterId);
                            } else {
                                long backoffMs = computeBackoff(r.item.attempts + 1);
                                JobRunnerPlugin.markUploadFailedSync(r.item.id, r.error != null ? r.error : "Upload failed", System.currentTimeMillis() + backoffMs);
                                progress.json.put("failedCount", progress.json.optInt("failedCount", 0) + 1);
                                progress.json.put("lastError", r.error);
                            }
                            processedThisRun += 1;
                        } catch (Exception e) {
                            progress.json.put("lastError", e.getMessage());
                        }
                    }
                } finally {
                    exec.shutdown();
                }
                }

                progress.json.put("completed", progress.completed);
                progress.json.put("total", progress.total);
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
                try {
                    Thread.sleep(UPLOAD_DELAY_MS);
                } catch (InterruptedException ie) {
                    Thread.currentThread().interrupt();
                    finishJob(jobId, progress, "canceled", "Uploads interrupted");
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
                String errorToStore = ("completed".equals(status) || "paused".equals(status)) ? null : message;
                if ("completed".equals(status) && message != null) {
                    progress.json.put("lastMessage", message);
                }
                if ("paused".equals(status) && message != null) {
                    progress.json.put("lastMessage", message);
                }
                updateJob(jobId, status, progress.json, errorToStore);
                emitFinished(jobId, status, progress, errorToStore);
                NotificationManager nm = (NotificationManager) getApplicationContext().getSystemService(Context.NOTIFICATION_SERVICE);
                if (nm != null) {
                    JobNotificationChannels.ensureChannels(getApplicationContext());
                    String text = (message != null && !message.trim().isEmpty()) ? message.trim() : ("completed".equals(status) ? "All uploads complete" : "An error occurred");
                    Notification notification = JobNotificationHelper.buildFinished(
                        getApplicationContext(),
                        jobId,
                        "Uploads " + status,
                        text,
                        "completed".equals(status)
                    );
                    nm.notify(JobNotificationHelper.getNotificationId(jobId), notification);
                }
            }
        } catch (Exception ignored) {}
    }

    private ProgressState loadJobProgress(String jobId) {
        ProgressState state = new ProgressState();
        state.json = new JSONObject();
        if (jobId == null || jobId.isEmpty()) return state;
        state.json = JobRunnerPlugin.getJobProgressSync(jobId);
        state.total = state.json.optInt("total", JobRunnerPlugin.countPendingUploadsSync());
        state.completed = state.json.optInt("completed", 0);
        return state;
    }

    private void updateJob(String jobId, String status, JSONObject progress, String error) {
        if (jobId == null || jobId.isEmpty()) return;
        JobRunnerPlugin.updateJobProgressSync(jobId, status, progress != null ? progress : new JSONObject(), error);
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
            try (InputStream is = getApplicationContext().getContentResolver().openInputStream(uri)) {
                if (is == null) throw new Exception("Unable to open content URI");
                return readAllBytes(is);
            }
        }
        File file = new File(path);
        if (!file.exists()) throw new Exception("Local file missing");
        try (FileInputStream fis = new FileInputStream(file)) {
            return readAllBytes(fis);
        }
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
        try {
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
        } finally {
            conn.disconnect();
        }
    }

    private static class UploadTask {
        final JobRunnerPlugin.DriveUploadItemResult item;
        final byte[] bytes;
        final String folderId;
        final String existingId;
        final String filename;

        UploadTask(JobRunnerPlugin.DriveUploadItemResult item, byte[] bytes, String folderId, String existingId, String filename) {
            this.item = item;
            this.bytes = bytes;
            this.folderId = folderId;
            this.existingId = existingId;
            this.filename = filename;
        }
    }

    private static class UploadResult {
        final JobRunnerPlugin.DriveUploadItemResult item;
        final String uploadedId;
        final String error;

        UploadResult(JobRunnerPlugin.DriveUploadItemResult item, String uploadedId, String error) {
            this.item = item;
            this.uploadedId = uploadedId;
            this.error = error;
        }
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

    @Override
    public void onStopped() {
        super.onStopped();
    }
}
