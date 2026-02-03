package com.cmwil.talevox.jobrunner;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;

import org.json.JSONObject;

public class JobsDb {
    private static final String DB_NAME = "talevox_db";
    private static final String DB_FILE = DB_NAME + "SQLite.db";
    private final Context context;

    public JobsDb(Context ctx) {
        this.context = ctx.getApplicationContext();
    }

    private SQLiteDatabase db() {
        return context.openOrCreateDatabase(DB_FILE, Context.MODE_PRIVATE, null);
    }

    public JobRow getJobRow(String jobId) {
        SQLiteDatabase db = db();
        Cursor cursor = db.query("jobs", new String[]{"jobId", "status", "type", "payloadJson", "progressJson"}, "jobId = ?", new String[]{jobId}, null, null, null);
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
        } catch (Exception e) {
            return null;
        }
    }

    public void updateJobStatus(String jobId, String status, String error) {
        try {
            SQLiteDatabase db = db();
            ContentValues values = new ContentValues();
            values.put("status", status);
            values.put("error", error);
            values.put("updatedAt", System.currentTimeMillis());
            db.update("jobs", values, "jobId = ?", new String[]{jobId});
        } catch (Exception ignored) {}
    }

    public void updateJobProgress(String jobId, String status, JSONObject progressJson, String error) {
        try {
            SQLiteDatabase db = db();
            ContentValues values = new ContentValues();
            values.put("status", status);
            values.put("error", error);
            values.put("updatedAt", System.currentTimeMillis());
            if (progressJson != null) {
                values.put("progressJson", progressJson.toString());
            }
            db.update("jobs", values, "jobId = ?", new String[]{jobId});
        } catch (Exception ignored) {}
    }

    public static class JobRow {
        public final String jobId;
        public final String status;
        public final String type;
        public final JSONObject payloadJson;
        public final JSONObject progressJson;

        public JobRow(String jobId, String status, String type, JSONObject payloadJson, JSONObject progressJson) {
            this.jobId = jobId;
            this.status = status;
            this.type = type;
            this.payloadJson = payloadJson;
            this.progressJson = progressJson;
        }
    }
}
