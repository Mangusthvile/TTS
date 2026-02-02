package com.cmwil.talevox.notifications;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.app.NotificationManager;

import androidx.work.WorkManager;

import com.cmwil.talevox.jobrunner.JobsDb;

import org.json.JSONObject;

import java.util.UUID;

public class JobNotificationReceiver extends BroadcastReceiver {
    public static final String ACTION_CANCEL = "com.cmwil.talevox.JOB_CANCEL";
    public static final String ACTION_RETRY = "com.cmwil.talevox.JOB_RETRY";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        String jobId = intent.getStringExtra("jobId");
        if (jobId == null) return;

        JobsDb db = new JobsDb(context);
        JobsDb.JobRow row = db.getJobRow(jobId);

        if (ACTION_CANCEL.equals(action)) {
            cancelWork(context, row);
            db.updateJobStatus(jobId, "canceled", null);
            cancelNotification(context, jobId);
        } else if (ACTION_RETRY.equals(action)) {
            // Retry optional: for now just cancel notification and mark queued if we have a workId
            db.updateJobStatus(jobId, "queued", null);
            cancelNotification(context, jobId);
        }
    }

    private void cancelWork(Context ctx, JobsDb.JobRow row) {
        try {
            if (row != null && row.progressJson != null) {
                String workId = row.progressJson.optString("workRequestId", null);
                if (workId != null && !workId.isEmpty()) {
                    WorkManager.getInstance(ctx).cancelWorkById(UUID.fromString(workId));
                }
            }
        } catch (Exception ignored) {}
    }

    private void cancelNotification(Context ctx, String jobId) {
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) nm.cancel(JobNotificationHelper.getNotificationId(jobId));
    }
}
