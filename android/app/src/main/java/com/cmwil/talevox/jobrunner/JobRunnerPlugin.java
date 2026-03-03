package com.cmwil.talevox.jobrunner;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;

import androidx.annotation.Nullable;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.PermissionState;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import androidx.work.Data;
import androidx.work.Constraints;
import androidx.work.NetworkType;
import androidx.work.BackoffPolicy;
import androidx.work.OneTimeWorkRequest;
import androidx.work.PeriodicWorkRequest;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.ExistingWorkPolicy;
import androidx.work.OutOfQuotaPolicy;
import androidx.work.WorkManager;
import androidx.work.WorkInfo;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.pm.PackageManager;
import android.util.Log;
import androidx.core.content.ContextCompat;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import android.os.Handler;
import android.os.Looper;
import java.io.File;
import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.provider.Settings;
import androidx.core.content.ContextCompat;
import androidx.core.app.NotificationManagerCompat;
import com.cmwil.talevox.notifications.JobNotificationChannels;
import com.cmwil.talevox.notifications.JobNotificationHelper;

@CapacitorPlugin(
    name = "JobRunner",
    permissions = {
        @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS })
    }
)
public class JobRunnerPlugin extends Plugin {
    private static final String DB_NAME = "talevox_db";
    private static final String DB_FILE = DB_NAME + "SQLite.db";
    private static JobRunnerPlugin instance;
    private static volatile long lastForegroundAt = 0;
    private SQLiteDatabase cachedDb = null;

    @Override
    public void load() {
        super.load();
        instance = this;
        try { JobNotificationChannels.ensureChannels(getContext()); } catch (Exception ignored) {}
        schedulePeriodicUploadQueue();
    }

    @Override
    protected void handleOnDestroy() {
        closeDbQuietly();
        super.handleOnDestroy();
    }

    public static void emitJobProgress(JSObject payload) {
        JobRunnerPlugin inst = instance;
        if (inst == null) return;
        inst.notifyListeners("jobProgress", payload);
    }

    public static void emitJobFinished(JSObject payload) {
        JobRunnerPlugin inst = instance;
        if (inst == null) return;
        inst.notifyListeners("jobFinished", payload);
    }

    public static void noteForegroundHeartbeat() {
        lastForegroundAt = System.currentTimeMillis();
    }

    private void setUploadQueuePausedFlag(boolean paused) {
        SQLiteDatabase db = getDb();
        JSONObject obj = new JSONObject();
        try { obj.put("paused", paused); } catch (JSONException ignored) {}
        ContentValues values = new ContentValues();
        values.put("key", "upload_queue_paused");
        values.put("json", obj.toString());
        values.put("updatedAt", System.currentTimeMillis());
        db.insertWithOnConflict("kv", null, values, SQLiteDatabase.CONFLICT_REPLACE);
    }

    private boolean isUploadQueuePaused() {
        SQLiteDatabase db = getDb();
        Cursor cursor = db.query("kv", new String[]{"json"}, "key = ?", new String[]{"upload_queue_paused"}, null, null, null, "1");
        try {
            if (!cursor.moveToFirst()) return false;
            String raw = cursor.getString(cursor.getColumnIndexOrThrow("json"));
            if (raw == null || raw.isEmpty()) return false;
            JSONObject obj = new JSONObject(raw);
            return obj.optBoolean("paused", false);
        } catch (Exception e) {
            return false;
        } finally {
            cursor.close();
        }
    }

    private Constraints buildUploadConstraints(PluginCall call) {
        JSObject constraints = call.getObject("constraints");
        boolean wifiOnly = constraints != null && constraints.optBoolean("wifiOnly", false);
        boolean requiresCharging = constraints != null && constraints.optBoolean("requiresCharging", false);
        Constraints.Builder builder = new Constraints.Builder();
        builder.setRequiredNetworkType(wifiOnly ? NetworkType.UNMETERED : NetworkType.CONNECTED);
        if (requiresCharging) builder.setRequiresCharging(true);
        return builder.build();
    }

    private SQLiteDatabase getDb() {
        if (cachedDb != null && cachedDb.isOpen()) return cachedDb;
        Context ctx = getContext();
        cachedDb = ctx.openOrCreateDatabase(DB_FILE, Context.MODE_PRIVATE, null);
        SQLiteDatabase db = cachedDb;
        db.execSQL(
            "CREATE TABLE IF NOT EXISTS kv (" +
            "key TEXT PRIMARY KEY," +
            "json TEXT NOT NULL," +
            "updatedAt INTEGER NOT NULL" +
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
        db.execSQL(
            "CREATE TABLE IF NOT EXISTS chapter_audio_files (" +
            "chapterId TEXT PRIMARY KEY," +
            "localPath TEXT," +
            "sizeBytes INTEGER," +
            "updatedAt INTEGER" +
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
            "updatedAt INTEGER," +
            "priority INTEGER," +
            "queuedAt INTEGER," +
            "source TEXT," +
            "lastAttemptAt INTEGER," +
            "manual INTEGER" +
            ")"
        );
        db.execSQL(
            "CREATE TABLE IF NOT EXISTS chapter_progress (" +
            "bookId TEXT NOT NULL," +
            "chapterId TEXT NOT NULL," +
            "timeSec REAL NOT NULL," +
            "durationSec REAL," +
            "percent REAL," +
            "isComplete INTEGER NOT NULL," +
            "updatedAt INTEGER NOT NULL," +
            "PRIMARY KEY (bookId, chapterId)" +
            ")"
        );
        try {
            db.execSQL("CREATE INDEX IF NOT EXISTS idx_chapter_progress_chapterId ON chapter_progress(chapterId)");
        } catch (Exception ignored) {}
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
            "sortOrder INTEGER," +
            "title TEXT," +
            "filename TEXT," +
            "sourceUrl TEXT," +
            "volumeName TEXT," +
            "volumeLocalChapter INTEGER," +
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
            "content TEXT," +
            "localPath TEXT," +
            "updatedAt INTEGER NOT NULL" +
            ")"
        );
        db.execSQL(
            "CREATE TABLE IF NOT EXISTS chapter_tombstones (" +
            "bookId TEXT NOT NULL," +
            "chapterId TEXT NOT NULL," +
            "deletedAt INTEGER NOT NULL," +
            "PRIMARY KEY (bookId, chapterId)" +
            ")"
        );
        try {
            db.execSQL("CREATE INDEX IF NOT EXISTS idx_chapter_tombstones_bookId ON chapter_tombstones(bookId)");
        } catch (Exception ignored) {}
        db.execSQL(
            "CREATE TABLE IF NOT EXISTS chapter_cue_maps (" +
            "chapterId TEXT PRIMARY KEY," +
            "cueJson TEXT NOT NULL," +
            "updatedAt INTEGER NOT NULL" +
            ")"
        );
        db.execSQL(
            "CREATE TABLE IF NOT EXISTS chapter_paragraph_maps (" +
            "chapterId TEXT PRIMARY KEY," +
            "paragraphJson TEXT NOT NULL," +
            "updatedAt INTEGER NOT NULL" +
            ")"
        );
        db.execSQL(
            "CREATE TABLE IF NOT EXISTS book_attachments (" +
            "id TEXT PRIMARY KEY," +
            "bookId TEXT NOT NULL," +
            "driveFileId TEXT," +
            "filename TEXT NOT NULL," +
            "mimeType TEXT," +
            "sizeBytes INTEGER," +
            "localPath TEXT," +
            "sha256 TEXT," +
            "createdAt INTEGER NOT NULL," +
            "updatedAt INTEGER NOT NULL" +
            ")"
        );
        try {
            db.execSQL("CREATE INDEX IF NOT EXISTS idx_book_attachments_bookId ON book_attachments(bookId)");
        } catch (Exception ignored) {}
        try {
            db.execSQL("CREATE INDEX IF NOT EXISTS idx_book_attachments_driveFileId ON book_attachments(driveFileId)");
        } catch (Exception ignored) {}
        return db;
    }

    private void closeDbQuietly() {
        if (cachedDb != null) {
            try {
                if (cachedDb.isOpen()) cachedDb.close();
            } catch (Exception ignored) {
                // best-effort close
            } finally {
                cachedDb = null;
            }
        }
    }

    /** Run a runnable on the main thread and block until done. If already on main thread, runs directly. */
    private static void runOnMainSync(final Runnable runnable) {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            runnable.run();
            return;
        }
        final CountDownLatch latch = new CountDownLatch(1);
        new Handler(Looper.getMainLooper()).post(new Runnable() {
            @Override
            public void run() {
                try {
                    runnable.run();
                } finally {
                    latch.countDown();
                }
            }
        });
        try {
            latch.await();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    /** Result for getJobPayloadSync: job row data for workers. */
    public static class JobPayloadResult {
        public final String jobId;
        public final JSONObject payloadJson;
        public final JSONObject progressJson;

        public JobPayloadResult(String jobId, JSONObject payloadJson, JSONObject progressJson) {
            this.jobId = jobId;
            this.payloadJson = payloadJson;
            this.progressJson = progressJson;
        }
    }

    public static JobPayloadResult getJobPayloadSync(final String jobId) {
        final AtomicReference<JobPayloadResult> ref = new AtomicReference<>();
        runOnMainSync(new Runnable() {
            @Override
            public void run() {
                JobRunnerPlugin inst = instance;
                if (inst == null) return;
                SQLiteDatabase db = inst.getDb();
                Cursor cursor = db.query(
                    "jobs",
                    new String[]{"jobId", "payloadJson", "progressJson"},
                    "jobId = ?",
                    new String[]{jobId},
                    null, null, null
                );
                if (cursor.moveToFirst()) {
                    String payloadStr = cursor.getString(cursor.getColumnIndexOrThrow("payloadJson"));
                    String progressStr = cursor.getString(cursor.getColumnIndexOrThrow("progressJson"));
                    try {
                        JSONObject payload = payloadStr != null ? new JSONObject(payloadStr) : null;
                        JSONObject progress = progressStr != null ? new JSONObject(progressStr) : null;
                        ref.set(new JobPayloadResult(jobId, payload, progress));
                    } catch (JSONException ignored) {}
                }
                cursor.close();
            }
        });
        return ref.get();
    }

    /** Returns map chapterId -> volumeName (nullable). */
    public static Map<String, String> getChapterVolumeNamesSync(final String bookId, final List<String> chapterIds) {
        final Map<String, String> out = new HashMap<>();
        if (chapterIds == null || chapterIds.isEmpty()) return out;
        runOnMainSync(new Runnable() {
            @Override
            public void run() {
                JobRunnerPlugin inst = instance;
                if (inst == null) return;
                SQLiteDatabase db = inst.getDb();
                for (String chapterId : chapterIds) {
                    String volumeName = null;
                    if (bookId != null && !bookId.isEmpty()) {
                        Cursor c = db.query("chapters", new String[]{"volumeName"}, "id = ? AND bookId = ?",
                            new String[]{chapterId, bookId}, null, null, null);
                        if (c.moveToFirst()) {
                            volumeName = c.getString(c.getColumnIndexOrThrow("volumeName"));
                            if (volumeName != null) volumeName = volumeName.trim();
                            if (volumeName != null && volumeName.isEmpty()) volumeName = null;
                        }
                        c.close();
                    }
                    if (volumeName == null) {
                        Cursor c = db.query("chapters", new String[]{"volumeName"}, "id = ?",
                            new String[]{chapterId}, null, null, null);
                        if (c.moveToFirst()) {
                            volumeName = c.getString(c.getColumnIndexOrThrow("volumeName"));
                            if (volumeName != null) volumeName = volumeName.trim();
                            if (volumeName != null && volumeName.isEmpty()) volumeName = null;
                        }
                        c.close();
                    }
                    out.put(chapterId, volumeName);
                }
            }
        });
        return out;
    }

    public static String getDriveAccessTokenSync() {
        final AtomicReference<String> ref = new AtomicReference<>();
        runOnMainSync(new Runnable() {
            @Override
            public void run() {
                JobRunnerPlugin inst = instance;
                if (inst == null) return;
                ref.set(inst.getDriveAccessTokenFromDb());
            }
        });
        return ref.get();
    }

    private static final long TOKEN_EXPIRY_GRACE_MS = 5 * 60 * 1000;

    private String getDriveAccessTokenFromDb() {
        SQLiteDatabase db = getDb();
        Cursor c = db.query("kv", new String[]{"json"}, "key = ?", new String[]{"auth_session"}, null, null, null);
        try {
            if (!c.moveToFirst()) return null;
            String raw = c.getString(c.getColumnIndexOrThrow("json"));
            if (raw == null || raw.isEmpty()) return null;
            JSONObject session = new JSONObject(raw);
            String token = extractAccessTokenFromSession(session);
            if (token == null) return null;
            long expiresAt = normalizeEpochMillis(session.optLong("expiresAt", 0));
            if (expiresAt > 0 && System.currentTimeMillis() > expiresAt + TOKEN_EXPIRY_GRACE_MS) return null;
            return token;
        } catch (Exception e) {
            return null;
        } finally {
            c.close();
        }
    }

    private static long normalizeEpochMillis(long value) {
        if (value <= 0) return 0;
        if (value < 1_000_000_000_000L) return value * 1000L;
        return value;
    }

    private static String extractAccessTokenFromSession(JSONObject session) {
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

    /** Returns JSON array string of rule objects (books.rulesJson + app_state.globalRules), or null. */
    public static String getRulesForBookSync(final String bookId) {
        final AtomicReference<String> ref = new AtomicReference<>();
        runOnMainSync(new Runnable() {
            @Override
            public void run() {
                JobRunnerPlugin inst = instance;
                if (inst == null) return;
                ref.set(inst.getRulesForBookFromDb(bookId));
            }
        });
        return ref.get();
    }

    private String getRulesForBookFromDb(String bookId) {
        List<JSONObject> rules = new ArrayList<>();
        SQLiteDatabase db = getDb();
        Cursor cursor = db.query("books", new String[]{"rulesJson"}, "id = ?", new String[]{bookId}, null, null, null);
        if (cursor.moveToFirst()) {
            String rulesStr = cursor.getString(cursor.getColumnIndexOrThrow("rulesJson"));
            addRulesFromJson(rules, rulesStr);
        }
        cursor.close();
        Cursor c2 = db.query("kv", new String[]{"json"}, "key = ?", new String[]{"app_state"}, null, null, null);
        if (c2.moveToFirst()) {
            String appStateStr = c2.getString(c2.getColumnIndexOrThrow("json"));
            try {
                JSONObject appState = new JSONObject(appStateStr);
                JSONArray globalRules = appState.optJSONArray("globalRules");
                if (globalRules != null) addRulesFromJson(rules, globalRules.toString());
            } catch (JSONException ignored) {}
        }
        c2.close();
        if (rules.isEmpty()) return null;
        sortRulesByPriorityDesc(rules);
        try {
            JSONArray arr = new JSONArray();
            for (JSONObject r : rules) arr.put(r);
            return arr.toString();
        } catch (Exception e) {
            return null;
        }
    }

    private void addRulesFromJson(List<JSONObject> out, String rawJson) {
        if (rawJson == null || rawJson.isEmpty()) return;
        try {
            JSONArray arr = new JSONArray(rawJson);
            for (int i = 0; i < arr.length(); i++) {
                JSONObject r = arr.optJSONObject(i);
                if (r != null && r.optBoolean("enabled", true) && r.optString("find", "").length() > 0) {
                    out.add(r);
                }
            }
        } catch (JSONException ignored) {}
    }

    private void sortRulesByPriorityDesc(List<JSONObject> rules) {
        Collections.sort(rules, new Comparator<JSONObject>() {
            @Override
            public int compare(JSONObject a, JSONObject b) {
                return Integer.compare(b.optInt("priority", 0), a.optInt("priority", 0));
            }
        });
    }

    public static void updateJobProgressSync(final String jobId, final String status, final JSONObject progressJson, final String error) {
        runOnMainSync(new Runnable() {
            @Override
            public void run() {
                JobRunnerPlugin inst = instance;
                if (inst == null) return;
                SQLiteDatabase db = inst.getDb();
                ContentValues values = new ContentValues();
                values.put("status", status);
                values.put("error", error);
                values.put("updatedAt", System.currentTimeMillis());
                if (progressJson != null) values.put("progressJson", progressJson.toString());
                db.update("jobs", values, "jobId = ?", new String[]{jobId});
            }
        });
    }

    public static void updateChapterAudioStatusSync(final String bookId, final String chapterId, final String status, final String filePath, final String cloudId) {
        runOnMainSync(new Runnable() {
            @Override
            public void run() {
                JobRunnerPlugin inst = instance;
                if (inst == null) return;
                SQLiteDatabase db = inst.getDb();
                ContentValues values = new ContentValues();
                values.put("audioStatus", status);
                values.put("audioSignature", filePath);
                if (cloudId != null) {
                    values.put("cloudAudioFileId", cloudId);
                    values.put("audioDriveId", cloudId);
                }
                values.put("updatedAt", System.currentTimeMillis());
                int updated = db.update("chapters", values, "id = ? AND bookId = ?", new String[]{chapterId, bookId});
                if (updated == 0) {
                    db.update("chapters", values, "id = ?", new String[]{chapterId});
                }
            }
        });
    }

    // ---------- Sync APIs for GenerateAudioWorker ----------
    public static String getChapterTextSync(final String bookId, final String chapterId) {
        final AtomicReference<String> ref = new AtomicReference<>();
        runOnMainSync(new Runnable() {
            @Override
            public void run() {
                JobRunnerPlugin inst = instance;
                if (inst == null) return;
                ref.set(inst.getChapterTextFromDb(bookId, chapterId));
            }
        });
        return ref.get();
    }

    private String getChapterTextFromDb(String bookId, String chapterId) {
        SQLiteDatabase db = getDb();
        if (bookId != null && !bookId.isEmpty()) {
            Cursor c = db.query("chapter_text", new String[]{"content", "localPath"}, "chapterId = ? AND bookId = ?", new String[]{chapterId, bookId}, null, null, null);
            if (c.moveToFirst()) {
                String content = c.getString(c.getColumnIndexOrThrow("content"));
                c.close();
                return content;
            }
            c.close();
        }
        Cursor c = db.query("chapter_text", new String[]{"content"}, "chapterId = ?", new String[]{chapterId}, null, null, null);
        if (c.moveToFirst()) {
            String content = c.getString(c.getColumnIndexOrThrow("content"));
            c.close();
            return content;
        }
        c.close();
        return null;
    }

    public static String resolveBookIdSync(final String inputBookId) {
        final AtomicReference<String> ref = new AtomicReference<>();
        runOnMainSync(new Runnable() {
            @Override
            public void run() {
                JobRunnerPlugin inst = instance;
                if (inst == null) return;
                ref.set(inst.resolveBookIdFromDb(inputBookId));
            }
        });
        return ref.get();
    }

    private String resolveBookIdFromDb(String inputBookId) {
        SQLiteDatabase db = getDb();
        Cursor c = db.query("books", new String[]{"id"}, "id = ?", new String[]{inputBookId}, null, null, null);
        if (c.moveToFirst()) {
            String id = c.getString(c.getColumnIndexOrThrow("id"));
            c.close();
            return id;
        }
        c.close();
        c = db.query("books", new String[]{"id"}, "driveFolderId = ?", new String[]{inputBookId}, null, null, null);
        if (c.moveToFirst()) {
            String id = c.getString(c.getColumnIndexOrThrow("id"));
            c.close();
            return id;
        }
        c.close();
        return null;
    }

    public static String getChapterFilenameSync(final String bookId, final String chapterId) {
        final AtomicReference<String> ref = new AtomicReference<>();
        runOnMainSync(new Runnable() {
            @Override
            public void run() {
                JobRunnerPlugin inst = instance;
                if (inst == null) return;
                ref.set(inst.getChapterFilenameFromDb(bookId, chapterId));
            }
        });
        return ref.get();
    }

    private String getChapterFilenameFromDb(String bookId, String chapterId) {
        SQLiteDatabase db = getDb();
        if (bookId != null && !bookId.isEmpty()) {
            Cursor c = db.query("chapters", new String[]{"filename"}, "id = ? AND bookId = ?", new String[]{chapterId, bookId}, null, null, null);
            if (c.moveToFirst()) {
                String fn = c.getString(c.getColumnIndexOrThrow("filename"));
                c.close();
                return fn;
            }
            c.close();
        }
        Cursor c = db.query("chapters", new String[]{"filename"}, "id = ?", new String[]{chapterId}, null, null, null);
        if (c.moveToFirst()) {
            String fn = c.getString(c.getColumnIndexOrThrow("filename"));
            c.close();
            return fn;
        }
        c.close();
        return null;
    }

    public static void upsertChapterAudioPathSync(final String chapterId, final String localPath, final int sizeBytes) {
        runOnMainSync(new Runnable() {
            @Override
            public void run() {
                JobRunnerPlugin inst = instance;
                if (inst == null) return;
                SQLiteDatabase db = inst.getDb();
                ContentValues values = new ContentValues();
                values.put("chapterId", chapterId);
                values.put("localPath", localPath);
                values.put("sizeBytes", sizeBytes);
                values.put("updatedAt", System.currentTimeMillis());
                db.insertWithOnConflict("chapter_audio_files", null, values, SQLiteDatabase.CONFLICT_REPLACE);
            }
        });
    }

    public static void enqueueUploadQueueItemSync(final String bookId, final String chapterId, final String localPath) {
        runOnMainSync(new Runnable() {
            @Override
            public void run() {
                JobRunnerPlugin inst = instance;
                if (inst == null) return;
                inst.enqueueUploadQueueItemFromDb(bookId, chapterId, localPath);
            }
        });
    }

    private void enqueueUploadQueueItemFromDb(String bookId, String chapterId, String localPath) {
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
        values.put("priority", 0);
        values.put("queuedAt", now);
        values.put("source", "audio");
        values.put("lastAttemptAt", 0);
        values.put("manual", 0);
        db.insertWithOnConflict("drive_upload_queue", null, values, SQLiteDatabase.CONFLICT_REPLACE);
    }

    public static int countPendingUploadsSync() {
        final AtomicReference<Integer> ref = new AtomicReference<>(0);
        runOnMainSync(new Runnable() {
            @Override
            public void run() {
                JobRunnerPlugin inst = instance;
                if (inst == null) return;
                ref.set(inst.countQueuedUploads());
            }
        });
        return ref.get() != null ? ref.get() : 0;
    }

    public static void ensureUploadQueueJobSync() {
        runOnMainSync(new Runnable() {
            @Override
            public void run() {
                JobRunnerPlugin inst = instance;
                if (inst == null) return;
                inst.scheduleUploadQueueOnce();
            }
        });
    }

    // ---------- Sync APIs for DriveUploadWorker ----------
    public static class DriveUploadItemResult {
        public final String id;
        public final String chapterId;
        public final String bookId;
        public final String localPath;
        public final int attempts;

        public DriveUploadItemResult(String id, String chapterId, String bookId, String localPath, int attempts) {
            this.id = id;
            this.chapterId = chapterId;
            this.bookId = bookId;
            this.localPath = localPath;
            this.attempts = attempts;
        }
    }

    public static List<DriveUploadItemResult> getNextReadyUploadsSync(final long now, final int max) {
        final List<DriveUploadItemResult> out = new ArrayList<>();
        runOnMainSync(new Runnable() {
            @Override
            public void run() {
                JobRunnerPlugin inst = instance;
                if (inst == null) return;
                SQLiteDatabase db = inst.getDb();
                Cursor cursor = db.query(
                    "drive_upload_queue",
                    new String[]{"id", "chapterId", "bookId", "localPath", "attempts"},
                    "(status = ? OR status = ?) AND nextAttemptAt <= ?",
                    new String[]{"queued", "failed", String.valueOf(now)},
                    null, null,
                    "priority DESC, queuedAt ASC, nextAttemptAt ASC",
                    String.valueOf(Math.max(1, max))
                );
                while (cursor.moveToNext()) {
                    out.add(new DriveUploadItemResult(
                        cursor.getString(cursor.getColumnIndexOrThrow("id")),
                        cursor.getString(cursor.getColumnIndexOrThrow("chapterId")),
                        cursor.getString(cursor.getColumnIndexOrThrow("bookId")),
                        cursor.getString(cursor.getColumnIndexOrThrow("localPath")),
                        cursor.getInt(cursor.getColumnIndexOrThrow("attempts"))
                    ));
                }
                cursor.close();
            }
        });
        return out;
    }

    public static void markUploadUploadingSync(final String id, final long nextAttemptAt) {
        runOnMainSync(new Runnable() {
            @Override
            public void run() {
                JobRunnerPlugin inst = instance;
                if (inst == null) return;
                SQLiteDatabase db = inst.getDb();
                db.execSQL(
                    "UPDATE drive_upload_queue SET status = 'uploading', attempts = attempts + 1, nextAttemptAt = ?, lastAttemptAt = ?, updatedAt = ? WHERE id = ?",
                    new Object[]{nextAttemptAt, System.currentTimeMillis(), System.currentTimeMillis(), id}
                );
            }
        });
    }

    public static void markUploadDoneSync(final String id) {
        runOnMainSync(new Runnable() {
            @Override
            public void run() {
                JobRunnerPlugin inst = instance;
                if (inst == null) return;
                inst.getDb().delete("drive_upload_queue", "id = ?", new String[]{id});
            }
        });
    }

    public static void markUploadFailedSync(final String id, final String error, final long nextAttemptAt) {
        runOnMainSync(new Runnable() {
            @Override
            public void run() {
                JobRunnerPlugin inst = instance;
                if (inst == null) return;
                SQLiteDatabase db = inst.getDb();
                db.execSQL(
                    "UPDATE drive_upload_queue SET status = 'failed', lastError = ?, nextAttemptAt = ?, lastAttemptAt = ?, attempts = attempts + 1, updatedAt = ? WHERE id = ?",
                    new Object[]{error, nextAttemptAt, System.currentTimeMillis(), System.currentTimeMillis(), id}
                );
            }
        });
    }

    public static void updateUploadLocalPathSync(final String id, final String localPath) {
        runOnMainSync(new Runnable() {
            @Override
            public void run() {
                JobRunnerPlugin inst = instance;
                if (inst == null) return;
                SQLiteDatabase db = inst.getDb();
                db.execSQL("UPDATE drive_upload_queue SET localPath = ?, updatedAt = ? WHERE id = ?",
                    new Object[]{localPath, System.currentTimeMillis(), id});
            }
        });
    }

    public static String resolveBookDriveFolderIdSync(final String bookId) {
        final AtomicReference<String> ref = new AtomicReference<>();
        runOnMainSync(new Runnable() {
            @Override
            public void run() {
                JobRunnerPlugin inst = instance;
                if (inst == null) return;
                SQLiteDatabase db = inst.getDb();
                Cursor c = db.query("books", new String[]{"driveFolderId"}, "id = ?", new String[]{bookId}, null, null, null);
                if (c.moveToFirst()) {
                    ref.set(c.getString(c.getColumnIndexOrThrow("driveFolderId")));
                }
                c.close();
            }
        });
        return ref.get();
    }

    public static String loadChapterDriveIdSync(final String bookId, final String chapterId) {
        final AtomicReference<String> ref = new AtomicReference<>();
        runOnMainSync(new Runnable() {
            @Override
            public void run() {
                JobRunnerPlugin inst = instance;
                if (inst == null) return;
                SQLiteDatabase db = inst.getDb();
                Cursor c = db.query("chapters", new String[]{"cloudAudioFileId"}, "id = ? AND bookId = ?", new String[]{chapterId, bookId}, null, null, null);
                if (c.moveToFirst()) {
                    ref.set(c.getString(c.getColumnIndexOrThrow("cloudAudioFileId")));
                }
                c.close();
            }
        });
        return ref.get();
    }

    public static void updateChapterAfterUploadSync(final String bookId, final String chapterId, final String uploadedId) {
        runOnMainSync(new Runnable() {
            @Override
            public void run() {
                JobRunnerPlugin inst = instance;
                if (inst == null) return;
                SQLiteDatabase db = inst.getDb();
                ContentValues values = new ContentValues();
                values.put("cloudAudioFileId", uploadedId);
                values.put("audioDriveId", uploadedId);
                values.put("audioStatus", "ready");
                values.put("updatedAt", System.currentTimeMillis());
                db.update("chapters", values, "id = ? AND bookId = ?", new String[]{chapterId, bookId});
            }
        });
    }

    public static boolean isUploadQueuePausedSync() {
        final AtomicReference<Boolean> ref = new AtomicReference<>(false);
        runOnMainSync(new Runnable() {
            @Override
            public void run() {
                JobRunnerPlugin inst = instance;
                if (inst == null) return;
                ref.set(inst.isUploadQueuePaused());
            }
        });
        return ref.get() != null && ref.get();
    }

    public static JSONObject getJobProgressSync(final String jobId) {
        final AtomicReference<JSONObject> ref = new AtomicReference<>();
        runOnMainSync(new Runnable() {
            @Override
            public void run() {
                JobRunnerPlugin inst = instance;
                if (inst == null) return;
                SQLiteDatabase db = inst.getDb();
                Cursor cursor = db.query("jobs", new String[]{"progressJson"}, "jobId = ?", new String[]{jobId}, null, null, null);
                if (cursor.moveToFirst()) {
                    String s = cursor.getString(cursor.getColumnIndexOrThrow("progressJson"));
                    try {
                        ref.set(s != null ? new JSONObject(s) : new JSONObject());
                    } catch (JSONException ignored) {}
                } else {
                    ref.set(new JSONObject());
                }
                cursor.close();
            }
        });
        return ref.get() != null ? ref.get() : new JSONObject();
    }

    @PluginMethod
    public void enqueueGenerateAudio(PluginCall call) {
        if (!ensureNotificationAllowed(call)) return;
        JSObject payload = call.getObject("payload");
        String jobId = UUID.randomUUID().toString();
        long now = System.currentTimeMillis();
        String correlationId = null;
        if (payload != null) {
            try { correlationId = payload.optString("correlationId", null); } catch (Exception ignored) {}
        }

        int total = 0;
        if (payload != null) {
            try {
                JSONArray chapterIds = payload.getJSONArray("chapterIds");
                if (chapterIds != null) total = chapterIds.length();
            } catch (JSONException ignored) {}
        }

        JSONObject progressJson = new JSONObject();
        try {
            progressJson.put("total", total);
            progressJson.put("completed", 0);
            if (correlationId != null && !correlationId.isEmpty()) {
                progressJson.put("correlationId", correlationId);
            }
        } catch (JSONException ignored) {}

        String payloadStr = payload != null ? payload.toString() : null;

        ContentValues values = new ContentValues();
        values.put("jobId", jobId);
        values.put("type", "generateAudio");
        values.put("status", "queued");
        values.put("payloadJson", payloadStr);
        values.put("progressJson", progressJson.toString());
        values.put("error", (String) null);
        values.put("createdAt", now);
        values.put("updatedAt", now);

        SQLiteDatabase db = getDb();
        db.insertWithOnConflict("jobs", null, values, SQLiteDatabase.CONFLICT_REPLACE);

        Constraints.Builder constraintsBuilder = new Constraints.Builder()
            .setRequiredNetworkType(total >= 100 ? NetworkType.UNMETERED : NetworkType.CONNECTED);
        if (total >= 100) {
            constraintsBuilder.setRequiresCharging(true);
        }

        OneTimeWorkRequest request =
            new OneTimeWorkRequest.Builder(GenerateAudioWorker.class)
                .setInputData(new Data.Builder().putString("jobId", jobId).build())
                .setConstraints(constraintsBuilder.build())
                .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 20, TimeUnit.SECONDS)
                .build();
        WorkManager.getInstance(getContext()).enqueue(request);

        try {
            progressJson.put("workRequestId", request.getId().toString());
            ContentValues update = new ContentValues();
            update.put("progressJson", progressJson.toString());
            update.put("updatedAt", System.currentTimeMillis());
            db.update("jobs", update, "jobId = ?", new String[]{jobId});
        } catch (JSONException ignored) {}

        Log.i("JobRunner", "enqueueGenerateAudio jobId=" + jobId + " workId=" + request.getId() + " correlationId=" + (correlationId != null ? correlationId : "none"));

        JSObject ret = new JSObject();
        ret.put("jobId", jobId);
        call.resolve(ret);
    }

    @PluginMethod
    public void enqueueGenerateBookAudio(PluginCall call) {
        if (!ensureNotificationAllowed(call)) return;
        JSObject payload = call.getObject("payload");
        String jobId = UUID.randomUUID().toString();
        long now = System.currentTimeMillis();
        String correlationId = null;
        if (payload != null) {
            try { correlationId = payload.optString("correlationId", null); } catch (Exception ignored) {}
        }

        int total = 0;
        if (payload != null) {
            try {
                JSONArray chapterIds = payload.getJSONArray("chapterIds");
                if (chapterIds != null) total = chapterIds.length();
            } catch (JSONException ignored) {}
        }

        JSONObject progressJson = new JSONObject();
        try {
            progressJson.put("total", total);
            progressJson.put("completed", 0);
            if (correlationId != null && !correlationId.isEmpty()) {
                progressJson.put("correlationId", correlationId);
            }
        } catch (JSONException ignored) {}

        String payloadStr = payload != null ? payload.toString() : null;

        ContentValues values = new ContentValues();
        values.put("jobId", jobId);
        values.put("type", "generate_book_audio");
        values.put("status", "queued");
        values.put("payloadJson", payloadStr);
        values.put("progressJson", progressJson.toString());
        values.put("error", (String) null);
        values.put("createdAt", now);
        values.put("updatedAt", now);

        SQLiteDatabase db = getDb();
        db.insertWithOnConflict("jobs", null, values, SQLiteDatabase.CONFLICT_REPLACE);

        Constraints.Builder constraintsBuilder = new Constraints.Builder()
            .setRequiredNetworkType(total >= 100 ? NetworkType.UNMETERED : NetworkType.CONNECTED);
        if (total >= 100) {
            constraintsBuilder.setRequiresCharging(true);
        }

        OneTimeWorkRequest request =
            new OneTimeWorkRequest.Builder(GenerateAudioWorker.class)
                .setInputData(new Data.Builder().putString("jobId", jobId).build())
                .setConstraints(constraintsBuilder.build())
                .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 20, TimeUnit.SECONDS)
                .build();
        WorkManager.getInstance(getContext()).enqueue(request);

        try {
            progressJson.put("workRequestId", request.getId().toString());
            ContentValues update = new ContentValues();
            update.put("progressJson", progressJson.toString());
            update.put("updatedAt", System.currentTimeMillis());
            db.update("jobs", update, "jobId = ?", new String[]{jobId});
        } catch (JSONException ignored) {}

        Log.i("JobRunner", "enqueueGenerateBookAudio jobId=" + jobId + " workId=" + request.getId() + " correlationId=" + (correlationId != null ? correlationId : "none"));

        JSObject ret = new JSObject();
        ret.put("jobId", jobId);
        call.resolve(ret);
    }

    @PluginMethod
    public void ensureUploadQueueJob(PluginCall call) {
        try {
            if (isUploadQueuePaused()) {
                JSObject out = new JSObject();
                out.put("jobId", (String) null);
                call.resolve(out);
                return;
            }
            int pending = countQueuedUploads();
            if (pending == 0) {
                JSObject out = new JSObject();
                out.put("jobId", (String) null);
                call.resolve(out);
                return;
            }
            SQLiteDatabase db = getDb();
            Cursor c2 = db.query("jobs", new String[]{"jobId", "status"}, "type = ? AND status IN ('queued','running')", new String[]{"drive_upload_queue"}, null, null, null, "1");
            if (c2.moveToFirst()) {
                String jobId = c2.getString(c2.getColumnIndexOrThrow("jobId"));
                c2.close();
                JSObject out = new JSObject();
                out.put("jobId", jobId);
                call.resolve(out);
                return;
            }
            c2.close();

            String jobId = UUID.randomUUID().toString();
            long now = System.currentTimeMillis();
            JSONObject progress = new JSONObject();
            progress.put("total", pending);
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
                    .setConstraints(buildUploadConstraints(call))
                    .addTag("drive_upload_queue")
                    .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 20, TimeUnit.SECONDS)
                    .build();
            WorkManager.getInstance(getContext()).enqueue(request);

            progress.put("workRequestId", request.getId().toString());
            ContentValues update = new ContentValues();
            update.put("progressJson", progress.toString());
            update.put("updatedAt", System.currentTimeMillis());
            db.update("jobs", update, "jobId = ?", new String[]{jobId});

            JSObject out = new JSObject();
            out.put("jobId", jobId);
            call.resolve(out);
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    @PluginMethod
    public void enqueueFixIntegrity(PluginCall call) {
        if (!ensureNotificationAllowed(call)) return;
        JSObject payload = call.getObject("payload");
        String jobId = UUID.randomUUID().toString();
        long now = System.currentTimeMillis();

        ContentValues values = new ContentValues();
        values.put("jobId", jobId);
        values.put("type", "fixIntegrity");
        values.put("status", "queued");
        values.put("payloadJson", payload != null ? payload.toString() : null);
        values.put("progressJson", new JSONObject().toString());
        values.put("error", (String) null);
        values.put("createdAt", now);
        values.put("updatedAt", now);

        SQLiteDatabase db = getDb();
        db.insertWithOnConflict("jobs", null, values, SQLiteDatabase.CONFLICT_REPLACE);

        OneTimeWorkRequest request =
            new OneTimeWorkRequest.Builder(FixIntegrityWorker.class)
                .setInputData(new Data.Builder().putString("jobId", jobId).build())
                .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 20, TimeUnit.SECONDS)
                .build();
        WorkManager.getInstance(getContext()).enqueue(request);

        try {
            JSONObject progressJson = new JSONObject();
            progressJson.put("workRequestId", request.getId().toString());
            ContentValues update = new ContentValues();
            update.put("progressJson", progressJson.toString());
            update.put("updatedAt", System.currentTimeMillis());
            db.update("jobs", update, "jobId = ?", new String[]{jobId});
        } catch (JSONException ignored) {}

        Log.i("JobRunner", "enqueueFixIntegrity jobId=" + jobId + " workId=" + request.getId());

        JSObject ret = new JSObject();
        ret.put("jobId", jobId);
        call.resolve(ret);
    }

    @PluginMethod
    public void kickUploadQueue(PluginCall call) {
        scheduleUploadQueueOnce();
        call.resolve();
    }

    @PluginMethod
    public void setUploadQueuePaused(PluginCall call) {
        Boolean paused = call.getBoolean("paused", false);
        setUploadQueuePausedFlag(paused != null && paused);
        call.resolve();
    }

    @PluginMethod
    public void getUploadQueuePaused(PluginCall call) {
        JSObject out = new JSObject();
        out.put("paused", isUploadQueuePaused());
        call.resolve(out);
    }

    @PluginMethod
    public void enqueueUploadJob(PluginCall call) {
        if (!ensureNotificationAllowed(call)) return;
        long now = System.currentTimeMillis();
        String jobId = UUID.randomUUID().toString();

        int total = countQueuedUploads();
        JSONObject progressJson = new JSONObject();
        try {
            progressJson.put("total", total);
            progressJson.put("completed", 0);
        } catch (JSONException ignored) {}

        ContentValues values = new ContentValues();
        values.put("jobId", jobId);
        values.put("type", "drive_upload_queue");
        values.put("status", "queued");
        values.put("payloadJson", "{}");
        values.put("progressJson", progressJson.toString());
        values.put("error", (String) null);
        values.put("createdAt", now);
        values.put("updatedAt", now);

        SQLiteDatabase db = getDb();
        db.insertWithOnConflict("jobs", null, values, SQLiteDatabase.CONFLICT_REPLACE);

        OneTimeWorkRequest request =
            new OneTimeWorkRequest.Builder(DriveUploadWorker.class)
                .setInputData(new Data.Builder().putString("jobId", jobId).build())
                .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
                .setConstraints(buildUploadConstraints(call))
                .addTag("drive_upload_queue")
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 20, TimeUnit.SECONDS)
                .build();
        WorkManager.getInstance(getContext()).enqueue(request);

        try {
            progressJson.put("workRequestId", request.getId().toString());
            ContentValues update = new ContentValues();
            update.put("progressJson", progressJson.toString());
            update.put("updatedAt", System.currentTimeMillis());
            db.update("jobs", update, "jobId = ?", new String[]{jobId});
        } catch (JSONException ignored) {}

        Log.i("JobRunner", "enqueueUploadJob jobId=" + jobId + " workId=" + request.getId());

        JSObject ret = new JSObject();
        ret.put("jobId", jobId);
        call.resolve(ret);
    }

    @PluginMethod
    public void cancelJob(PluginCall call) {
        String jobId = call.getString("jobId");
        if (jobId == null) {
            call.reject("jobId is required");
            return;
        }
        JobRow row = loadJobRow(jobId);
        if (row != null && row.progressJson != null) {
            String workId = row.progressJson.optString("workRequestId", null);
            if (workId != null && !workId.isEmpty()) {
                try {
                    WorkManager.getInstance(getContext()).cancelWorkById(UUID.fromString(workId));
                } catch (Exception ignored) {}
            }
        }
        updateStatus(jobId, "canceled", null);
        call.resolve();
    }

    @PluginMethod
    public void retryJob(PluginCall call) {
        String jobId = call.getString("jobId");
        if (jobId == null) {
            call.reject("jobId is required");
            return;
        }
        JobRow row = loadJobRow(jobId);
        if (row == null) {
            call.reject("job not found");
            return;
        }
        if (!"failed".equals(row.status) && !"canceled".equals(row.status) && !"queued".equals(row.status)) {
            call.reject("job is not failed or canceled");
            return;
        }

        if ("queued".equals(row.status) && row.progressJson != null) {
            String workId = row.progressJson.optString("workRequestId", null);
            if (workId != null && !workId.isEmpty()) {
                try {
                    WorkManager.getInstance(getContext()).cancelWorkById(UUID.fromString(workId));
                } catch (Exception ignored) {}
            }
        }

        String type = row.type != null ? row.type : "generateAudio";
        Class workerClass;
        if ("fixIntegrity".equals(type)) {
            workerClass = FixIntegrityWorker.class;
        } else if ("generateAudio".equals(type) || "generate_book_audio".equals(type)) {
            workerClass = GenerateAudioWorker.class;
        } else {
            call.reject("unsupported job type");
            return;
        }

        OneTimeWorkRequest request =
            new OneTimeWorkRequest.Builder(workerClass)
                .setInputData(new Data.Builder().putString("jobId", jobId).build())
                .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 20, TimeUnit.SECONDS)
                .build();
        WorkManager.getInstance(getContext()).enqueue(request);

        JSONObject progressJson = row.progressJson != null ? row.progressJson : new JSONObject();
        try {
            progressJson.put("workRequestId", request.getId().toString());
        } catch (JSONException ignored) {}

        updateJobProgress(jobId, "queued", progressJson, null);
        Log.i("JobRunner", "retryJob jobId=" + jobId + " workId=" + request.getId());
        JSObject ret = new JSObject();
        ret.put("jobId", jobId);
        call.resolve(ret);
    }

    @PluginMethod
    public void forceStartJob(PluginCall call) {
        String jobId = call.getString("jobId");
        if (jobId == null) {
            call.reject("jobId is required");
            return;
        }
        JobRow row = loadJobRow(jobId);
        if (row == null) {
            call.reject("job not found");
            return;
        }

        if (row.progressJson != null) {
            String workId = row.progressJson.optString("workRequestId", null);
            if (workId != null && !workId.isEmpty()) {
                try {
                    WorkManager.getInstance(getContext()).cancelWorkById(UUID.fromString(workId));
                } catch (Exception ignored) {}
            }
        }

        String type = row.type != null ? row.type : "generateAudio";
        Class workerClass;
        if ("fixIntegrity".equals(type)) {
            workerClass = FixIntegrityWorker.class;
        } else if ("generateAudio".equals(type) || "generate_book_audio".equals(type)) {
            workerClass = GenerateAudioWorker.class;
        } else {
            call.reject("unsupported job type");
            return;
        }

        OneTimeWorkRequest request =
            new OneTimeWorkRequest.Builder(workerClass)
                .setInputData(new Data.Builder().putString("jobId", jobId).build())
                .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 20, TimeUnit.SECONDS)
                .build();
        WorkManager.getInstance(getContext()).enqueue(request);

        JSONObject progressJson = row.progressJson != null ? row.progressJson : new JSONObject();
        try {
            progressJson.put("workRequestId", request.getId().toString());
        } catch (JSONException ignored) {}

        updateJobProgress(jobId, "queued", progressJson, null);
        Log.i("JobRunner", "forceStartJob jobId=" + jobId + " workId=" + request.getId());
        call.resolve();
    }

    @PluginMethod
    public void deleteJob(PluginCall call) {
        String jobId = call.getString("jobId");
        if (jobId == null) {
            call.reject("jobId is required");
            return;
        }
        SQLiteDatabase db = getDb();
        db.delete("jobs", "jobId = ?", new String[]{jobId});
        call.resolve();
    }

    @PluginMethod
    public void clearJobs(PluginCall call) {
        JSArray statuses = call.getArray("statuses");
        if (statuses == null || statuses.length() == 0) {
            call.resolve();
            return;
        }
        StringBuilder where = new StringBuilder("status IN (");
        String[] args = new String[statuses.length()];
        for (int i = 0; i < statuses.length(); i++) {
            if (i > 0) where.append(",");
            where.append("?");
            args[i] = statuses.optString(i);
        }
        where.append(")");
        SQLiteDatabase db = getDb();
        db.delete("jobs", where.toString(), args);
        call.resolve();
    }

    @PluginMethod
    public void getJob(PluginCall call) {
        String jobId = call.getString("jobId");
        if (jobId == null) {
            call.reject("jobId is required");
            return;
        }

        SQLiteDatabase db = getDb();
        Cursor cursor = db.query(
            "jobs",
            null,
            "jobId = ?",
            new String[]{jobId},
            null,
            null,
            null
        );

        JSObject ret = new JSObject();
        if (cursor.moveToFirst()) {
            ret.put("job", rowToJob(cursor));
        } else {
            ret.put("job", null);
        }
        cursor.close();
        call.resolve(ret);
    }

    @PluginMethod
    public void listJobs(PluginCall call) {
        reconcileWithWorkManager();
        SQLiteDatabase db = getDb();
        Cursor cursor = db.query("jobs", null, null, null, null, null, "createdAt DESC");

        JSArray jobs = new JSArray();
        while (cursor.moveToNext()) {
            jobs.put(rowToJob(cursor));
        }
        cursor.close();

        JSObject ret = new JSObject();
        ret.put("jobs", jobs);
        call.resolve(ret);
    }

    @PluginMethod
    public void checkNotificationPermission(PluginCall call) {
        JSObject out = new JSObject();
        boolean supported = android.os.Build.VERSION.SDK_INT >= 33;
        boolean granted = true;
        boolean enabled = true;
        try {
            PermissionState state = getPermissionState("notifications");
            granted = state == PermissionState.GRANTED || !supported;
            enabled = NotificationManagerCompat.from(getContext()).areNotificationsEnabled();
            NotificationManager nm = (NotificationManager) getContext().getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null && supported) {
                NotificationChannel ch = nm.getNotificationChannel(com.cmwil.talevox.notifications.JobNotificationChannels.CHANNEL_JOBS_ID);
                if (ch != null && ch.getImportance() == NotificationManager.IMPORTANCE_NONE) {
                    enabled = false;
                }
            }
        } catch (Exception ignored) {}
        out.put("supported", supported);
        out.put("granted", granted);
        out.put("enabled", enabled);
        call.resolve(out);
    }

    @PluginMethod
    public void requestNotificationPermission(PluginCall call) {
        if (android.os.Build.VERSION.SDK_INT < 33) {
            JSObject ret = new JSObject();
            ret.put("granted", true);
            call.resolve(ret);
            return;
        }
        requestPermissionForAlias("notifications", call, "notificationsCallback");
    }

    @PermissionCallback
    public void notificationsCallback(PluginCall call) {
        JSObject ret = new JSObject();
        PermissionState state = getPermissionState("notifications");
        ret.put("granted", state == PermissionState.GRANTED);
        call.resolve(ret);
    }

    @PluginMethod
    public void openNotificationSettings(PluginCall call) {
        try {
            Intent intent = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS);
            intent.putExtra(Settings.EXTRA_APP_PACKAGE, getContext().getPackageName());
            intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    @PluginMethod
    public void sendTestNotification(PluginCall call) {
        try {
            JobNotificationChannels.ensureChannels(getContext());
            NotificationManager nm = (NotificationManager) getContext().getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) {
                Notification notification = JobNotificationHelper.buildFinished(
                    getContext(),
                    "test-job",
                    "TaleVox test",
                    "Notifications are working",
                    true
                );
                nm.notify(123456, notification);
            }
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    @PluginMethod
    public void getDiagnostics(PluginCall call) {
        JSObject out = new JSObject();
        try {
            Context ctx = getContext();
            int perm = ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS);
            String permStr = "prompt";
            if (android.os.Build.VERSION.SDK_INT < 33) {
                permStr = "granted";
            } else if (perm == PackageManager.PERMISSION_GRANTED) {
                permStr = "granted";
            } else {
                PermissionState state = getPermissionState("notifications");
                if (state == PermissionState.DENIED) permStr = "denied";
            }
            out.put("permission", permStr);

            NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
            boolean channelExists = false;
            if (nm != null) {
                NotificationChannel ch = nm.getNotificationChannel(JobNotificationChannels.CHANNEL_JOBS_ID);
                channelExists = (ch != null);
            }
            out.put("channelExists", channelExists);
            JSArray chans = new JSArray();
            chans.put(JobNotificationChannels.CHANNEL_JOBS_ID);
            out.put("channels", chans);
            out.put("hasPlugin", true);
            out.put("plugin", "JobRunner");

            long ageMs = System.currentTimeMillis() - lastForegroundAt;
            out.put("foregroundRecent", lastForegroundAt > 0 && ageMs < 30000);
            out.put("foregroundAgeMs", ageMs);

            JSObject tables = new JSObject();
            SQLiteDatabase db = getDb();
            Cursor c = db.rawQuery(
                "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('books','chapters','chapter_text','jobs')",
                null
            );
            while (c.moveToNext()) {
                String name = c.getString(0);
                tables.put(name, true);
            }
            c.close();
            if (!tables.has("books")) tables.put("books", false);
            if (!tables.has("chapters")) tables.put("chapters", false);
            if (!tables.has("chapter_text")) tables.put("chapter_text", false);
            if (!tables.has("jobs")) tables.put("jobs", false);
            out.put("tables", tables);

            try {
                File dbFile = ctx.getDatabasePath(DB_FILE);
                out.put("dbFileExists", dbFile != null && dbFile.exists());
                out.put("dbPath", dbFile != null ? dbFile.getAbsolutePath() : "");
            } catch (Exception ignored) {}
        } catch (Exception e) {
            out.put("error", e.getMessage());
        }
        call.resolve(out);
    }

    @PluginMethod
    public void getNotificationDiagnostics(PluginCall call) {
        JSObject out = new JSObject();
        try {
            Context ctx = getContext();
            int perm = ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS);
            String permStr = "prompt";
            if (android.os.Build.VERSION.SDK_INT < 33) {
                permStr = "granted";
            } else if (perm == PackageManager.PERMISSION_GRANTED) {
                permStr = "granted";
            } else {
                PermissionState state = getPermissionState("notifications");
                if (state == PermissionState.DENIED) permStr = "denied";
            }
            out.put("permission", permStr);

            NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
            boolean channelExists = false;
            if (nm != null) {
                NotificationChannel ch = nm.getNotificationChannel(JobNotificationChannels.CHANNEL_JOBS_ID);
                channelExists = (ch != null);
            }
            out.put("channelExists", channelExists);
            JSArray chans = new JSArray();
            chans.put(JobNotificationChannels.CHANNEL_JOBS_ID);
            out.put("channels", chans);
            out.put("hasPlugin", true);
            out.put("plugin", "JobRunner");

            long ageMs = System.currentTimeMillis() - lastForegroundAt;
            out.put("foregroundRecent", lastForegroundAt > 0 && ageMs < 30000);
            out.put("foregroundAgeMs", ageMs);
        } catch (Exception e) {
            out.put("error", e.getMessage());
        }
        call.resolve(out);
    }

    private void updateStatus(String jobId, String status, @Nullable String error) {
        SQLiteDatabase db = getDb();
        ContentValues values = new ContentValues();
        values.put("status", status);
        values.put("error", error);
        values.put("updatedAt", System.currentTimeMillis());
        db.update("jobs", values, "jobId = ?", new String[]{jobId});
    }

    private void scheduleUploadQueueOnce() {
        Constraints constraints = new Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .build();

        OneTimeWorkRequest request =
            new OneTimeWorkRequest.Builder(DriveUploadWorker.class)
                .setConstraints(constraints)
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 20, TimeUnit.SECONDS)
                .build();
        WorkManager.getInstance(getContext())
            .enqueueUniqueWork("talevox_drive_upload_queue_once", ExistingWorkPolicy.KEEP, request);
    }

    private void schedulePeriodicUploadQueue() {
        try {
            Constraints constraints = new Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .build();
            PeriodicWorkRequest request =
                new PeriodicWorkRequest.Builder(DriveUploadWorker.class, 15, java.util.concurrent.TimeUnit.MINUTES)
                    .setConstraints(constraints)
                    .build();
            WorkManager.getInstance(getContext())
                .enqueueUniquePeriodicWork("talevox_drive_upload_queue_periodic", ExistingPeriodicWorkPolicy.KEEP, request);
        } catch (Exception ignored) {}
    }

    private int countQueuedUploads() {
        int total = 0;
        try {
            SQLiteDatabase db = getDb();
            Cursor cursor = db.rawQuery("SELECT COUNT(*) FROM drive_upload_queue WHERE status IN ('queued','failed','uploading')", null);
            if (cursor.moveToFirst()) total = cursor.getInt(0);
            cursor.close();
        } catch (Exception ignored) {}
        return total;
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

    @PluginMethod
    public void getWorkInfo(PluginCall call) {
        String jobId = call.getString("jobId");
        if (jobId == null) {
            call.reject("jobId is required");
            return;
        }
        try {
            SQLiteDatabase db = getDb();
            Cursor cursor = db.query("jobs", new String[]{"progressJson"}, "jobId = ?", new String[]{jobId}, null, null, null);
            String workId = null;
            if (cursor.moveToFirst()) {
                String progressStr = cursor.getString(cursor.getColumnIndexOrThrow("progressJson"));
                JSONObject prog = parseJsonObject(progressStr);
                workId = prog.optString("workRequestId", null);
            }
            cursor.close();
            if (workId == null || workId.isEmpty()) {
                call.resolve(new JSObject());
                return;
            }
            WorkInfo info = WorkManager.getInstance(getContext()).getWorkInfoById(UUID.fromString(workId)).get();
            if (info == null) {
                call.resolve(new JSObject());
                return;
            }
            JSObject out = new JSObject();
            JSObject wi = new JSObject();
            wi.put("state", info.getState().name());
            wi.put("runAttemptCount", info.getRunAttemptCount());
            out.put("workInfo", wi);
            call.resolve(out);
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    private JobRow loadJobRow(String jobId) {
        SQLiteDatabase db = getDb();
        Cursor cursor = db.query(
            "jobs",
            new String[]{"jobId", "status", "type", "payloadJson", "progressJson"},
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
        String status = cursor.getString(cursor.getColumnIndexOrThrow("status"));
        String type = cursor.getString(cursor.getColumnIndexOrThrow("type"));
        String payloadStr = cursor.getString(cursor.getColumnIndexOrThrow("payloadJson"));
        String progressStr = cursor.getString(cursor.getColumnIndexOrThrow("progressJson"));
        cursor.close();

        try {
            JSONObject payload = payloadStr != null ? new JSONObject(payloadStr) : null;
            JSONObject progress = progressStr != null ? new JSONObject(progressStr) : null;
            return new JobRow(jobId, status, type, payload, progress);
        } catch (JSONException e) {
            return new JobRow(jobId, status, type, null, null);
        }
    }

    private void reconcileWithWorkManager() {
        try {
            SQLiteDatabase db = getDb();
            Cursor cursor = db.query("jobs", new String[]{"jobId", "type", "status", "progressJson"}, null, null, null, null, null);
            while (cursor.moveToNext()) {
                String jobId = cursor.getString(cursor.getColumnIndexOrThrow("jobId"));
                String type = cursor.getString(cursor.getColumnIndexOrThrow("type"));
                String status = cursor.getString(cursor.getColumnIndexOrThrow("status"));
                String progressStr = cursor.getString(cursor.getColumnIndexOrThrow("progressJson"));
                JSONObject progress = parseJsonObject(progressStr);
                String workId = progress != null ? progress.optString("workRequestId", null) : null;
                if (workId == null || workId.isEmpty()) continue;

                WorkManager wm = WorkManager.getInstance(getContext());
                WorkInfo info = wm.getWorkInfoById(UUID.fromString(workId)).get();
                if (info == null) continue;
                String mapped = mapWorkState(info.getState());
                if (mapped != null && !mapped.equals(status)) {
                    // Batched generate jobs: each batch is a new WorkRequest; when one batch SUCCEEDED
                    // we must not mark the job "completed" until all chapters are done.
                    if ("completed".equals(mapped) && ("generate_audio".equals(type) || "generate_book_audio".equals(type)) && progress != null) {
                        int completed = progress.optInt("completed", 0);
                        int total = progress.optInt("total", 0);
                        if (total > 0 && completed < total) {
                            Log.d("JobRunner", "Reconcile skip completed for batched job " + jobId + " (" + completed + "/" + total + ")");
                            continue;
                        }
                    }
                    Log.d("JobRunner", "Reconcile job " + jobId + " from " + status + " -> " + mapped);
                    updateStatus(jobId, mapped, null);
                }
            }
            cursor.close();
        } catch (Exception ignored) {}
    }

    private String mapWorkState(WorkInfo.State s) {
        if (s == WorkInfo.State.ENQUEUED) return "queued";
        if (s == WorkInfo.State.RUNNING) return "running";
        if (s == WorkInfo.State.SUCCEEDED) return "completed";
        if (s == WorkInfo.State.FAILED) return "failed";
        if (s == WorkInfo.State.CANCELLED) return "canceled";
        return null;
    }

    private boolean ensureNotificationAllowed(PluginCall call) {
        if (android.os.Build.VERSION.SDK_INT < 33) return true;
        PermissionState state = getPermissionState("notifications");
        if (state == PermissionState.GRANTED) return true;
        call.reject("notifications_not_granted");
        return false;
    }

    private JSObject rowToJob(Cursor cursor) {
        JSObject job = new JSObject();
        job.put("jobId", cursor.getString(cursor.getColumnIndexOrThrow("jobId")));
        job.put("type", cursor.getString(cursor.getColumnIndexOrThrow("type")));
        job.put("status", cursor.getString(cursor.getColumnIndexOrThrow("status")));

        String payloadStr = cursor.getString(cursor.getColumnIndexOrThrow("payloadJson"));
        String progressStr = cursor.getString(cursor.getColumnIndexOrThrow("progressJson"));
        String error = cursor.getString(cursor.getColumnIndexOrThrow("error"));

        job.put("payloadJson", parseJsonObject(payloadStr));
        job.put("progressJson", parseJsonObject(progressStr));
        if (error != null) job.put("error", error);

        job.put("createdAt", cursor.getLong(cursor.getColumnIndexOrThrow("createdAt")));
        job.put("updatedAt", cursor.getLong(cursor.getColumnIndexOrThrow("updatedAt")));
        return job;
    }

    private JSObject parseJsonObject(String raw) {
        if (raw == null) return new JSObject();
        try {
            return new JSObject(raw);
        } catch (Exception e) {
            return new JSObject();
        }
    }

    private static class JobRow {
        String jobId;
        String status;
        String type;
        JSONObject payloadJson;
        JSONObject progressJson;

        JobRow(String jobId, String status, String type, JSONObject payloadJson, JSONObject progressJson) {
            this.jobId = jobId;
            this.status = status;
            this.type = type;
            this.payloadJson = payloadJson;
            this.progressJson = progressJson;
        }
    }
}
