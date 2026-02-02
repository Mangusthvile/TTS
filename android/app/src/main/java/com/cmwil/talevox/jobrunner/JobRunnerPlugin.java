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

import androidx.work.Data;
import androidx.work.Constraints;
import androidx.work.NetworkType;
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

import java.util.UUID;
import java.util.List;
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
    private static JobRunnerPlugin instance;
    private static volatile long lastForegroundAt = 0;

    @Override
    public void load() {
        super.load();
        instance = this;
        try { JobNotificationChannels.ensureChannels(getContext()); } catch (Exception ignored) {}
        schedulePeriodicUploadQueue();
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

    private SQLiteDatabase getDb() {
        Context ctx = getContext();
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
            "updatedAt INTEGER" +
            ")"
        );
        return db;
    }

    @PluginMethod
    public void enqueueGenerateAudio(PluginCall call) {
        if (!ensureNotificationAllowed(call)) return;
        JSObject payload = call.getObject("payload");
        String jobId = UUID.randomUUID().toString();
        long now = System.currentTimeMillis();

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

        OneTimeWorkRequest request =
            new OneTimeWorkRequest.Builder(GenerateAudioWorker.class)
                .setInputData(new Data.Builder().putString("jobId", jobId).build())
                .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
                .build();
        WorkManager.getInstance(getContext()).enqueue(request);

        try {
            progressJson.put("workRequestId", request.getId().toString());
            ContentValues update = new ContentValues();
            update.put("progressJson", progressJson.toString());
            update.put("updatedAt", System.currentTimeMillis());
            db.update("jobs", update, "jobId = ?", new String[]{jobId});
        } catch (JSONException ignored) {}

        JSObject ret = new JSObject();
        ret.put("jobId", jobId);
        call.resolve(ret);
    }

    @PluginMethod
    public void ensureUploadQueueJob(PluginCall call) {
        try {
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
                .build();
        WorkManager.getInstance(getContext()).enqueue(request);

        try {
            progressJson.put("workRequestId", request.getId().toString());
            ContentValues update = new ContentValues();
            update.put("progressJson", progressJson.toString());
            update.put("updatedAt", System.currentTimeMillis());
            db.update("jobs", update, "jobId = ?", new String[]{jobId});
        } catch (JSONException ignored) {}

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
        } else if ("generateAudio".equals(type)) {
            workerClass = GenerateAudioWorker.class;
        } else {
            call.reject("unsupported job type");
            return;
        }

        OneTimeWorkRequest request =
            new OneTimeWorkRequest.Builder(workerClass)
                .setInputData(new Data.Builder().putString("jobId", jobId).build())
                .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
                .build();
        WorkManager.getInstance(getContext()).enqueue(request);

        JSONObject progressJson = row.progressJson != null ? row.progressJson : new JSONObject();
        try {
            progressJson.put("workRequestId", request.getId().toString());
        } catch (JSONException ignored) {}

        updateJobProgress(jobId, "queued", progressJson, null);
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
        } else if ("generateAudio".equals(type)) {
            workerClass = GenerateAudioWorker.class;
        } else {
            call.reject("unsupported job type");
            return;
        }

        OneTimeWorkRequest request =
            new OneTimeWorkRequest.Builder(workerClass)
                .setInputData(new Data.Builder().putString("jobId", jobId).build())
                .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
                .build();
        WorkManager.getInstance(getContext()).enqueue(request);

        JSONObject progressJson = row.progressJson != null ? row.progressJson : new JSONObject();
        try {
            progressJson.put("workRequestId", request.getId().toString());
        } catch (JSONException ignored) {}

        updateJobProgress(jobId, "queued", progressJson, null);
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

    @PluginMethod
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
            Cursor cursor = db.query("jobs", new String[]{"jobId", "status", "progressJson"}, null, null, null, null, null);
            while (cursor.moveToNext()) {
                String jobId = cursor.getString(cursor.getColumnIndexOrThrow("jobId"));
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
