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
import com.getcapacitor.annotation.CapacitorPlugin;

import androidx.work.Data;
import androidx.work.OneTimeWorkRequest;
import androidx.work.WorkManager;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.UUID;

@CapacitorPlugin(name = "JobRunner")
public class JobRunnerPlugin extends Plugin {
    private static final String DB_NAME = "talevox_db";
    private static JobRunnerPlugin instance;

    @Override
    public void load() {
        super.load();
        instance = this;
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
        return db;
    }

    @PluginMethod
    public void enqueueGenerateAudio(PluginCall call) {
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
        if (!"failed".equals(row.status) && !"canceled".equals(row.status)) {
            call.reject("job is not failed or canceled");
            return;
        }

        OneTimeWorkRequest request =
            new OneTimeWorkRequest.Builder(GenerateAudioWorker.class)
                .setInputData(new Data.Builder().putString("jobId", jobId).build())
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

    private void updateStatus(String jobId, String status, @Nullable String error) {
        SQLiteDatabase db = getDb();
        ContentValues values = new ContentValues();
        values.put("status", status);
        values.put("error", error);
        values.put("updatedAt", System.currentTimeMillis());
        db.update("jobs", values, "jobId = ?", new String[]{jobId});
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

    private JobRow loadJobRow(String jobId) {
        SQLiteDatabase db = getDb();
        Cursor cursor = db.query(
            "jobs",
            new String[]{"jobId", "status", "payloadJson", "progressJson"},
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
        String payloadStr = cursor.getString(cursor.getColumnIndexOrThrow("payloadJson"));
        String progressStr = cursor.getString(cursor.getColumnIndexOrThrow("progressJson"));
        cursor.close();

        try {
            JSONObject payload = payloadStr != null ? new JSONObject(payloadStr) : null;
            JSONObject progress = progressStr != null ? new JSONObject(progressStr) : null;
            return new JobRow(jobId, status, payload, progress);
        } catch (JSONException e) {
            return new JobRow(jobId, status, null, null);
        }
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
        JSONObject payloadJson;
        JSONObject progressJson;

        JobRow(String jobId, String status, JSONObject payloadJson, JSONObject progressJson) {
            this.jobId = jobId;
            this.status = status;
            this.payloadJson = payloadJson;
            this.progressJson = progressJson;
        }
    }
}
