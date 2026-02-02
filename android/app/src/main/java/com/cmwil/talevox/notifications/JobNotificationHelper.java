package com.cmwil.talevox.notifications;

import android.app.Notification;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import androidx.core.app.NotificationCompat;
import androidx.work.ForegroundInfo;

import com.cmwil.talevox.MainActivity;
import com.cmwil.talevox.jobrunner.JobRunnerPlugin;
import com.cmwil.talevox.R;

public class JobNotificationHelper {

    public static int getNotificationId(String jobId) {
        return Math.abs(jobId.hashCode());
    }

    public static int getSummaryNotificationId() {
        return 999_999;
    }

    private static PendingIntent contentIntent(Context ctx) {
        Intent intent = new Intent(ctx, MainActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(ctx, 1001, intent, PendingIntent.FLAG_IMMUTABLE);
    }

    private static PendingIntent cancelIntent(Context ctx, String jobId) {
        Intent intent = new Intent(ctx, JobNotificationReceiver.class);
        intent.setAction(JobNotificationReceiver.ACTION_CANCEL);
        intent.putExtra("jobId", jobId);
        return PendingIntent.getBroadcast(ctx, Math.abs(("cancel_"+jobId).hashCode()), intent, PendingIntent.FLAG_IMMUTABLE);
    }

    public static Notification buildProgress(Context ctx, String jobId, String title, String text, int total, int done, boolean indeterminate, boolean ongoing) {
        JobNotificationChannels.ensureChannels(ctx);
        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, JobNotificationChannels.CHANNEL_JOBS_ID)
            .setContentTitle(title)
            .setContentText(text)
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setContentIntent(contentIntent(ctx))
            .setGroup(JobNotificationChannels.GROUP_KEY_JOBS)
            .setOngoing(ongoing)
            .setOnlyAlertOnce(true)
            .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Cancel", cancelIntent(ctx, jobId));

        if (indeterminate) {
            b.setProgress(0, 0, true);
        } else {
            b.setProgress(Math.max(total, 1), Math.max(done, 0), false);
        }
        return b.build();
    }

    public static Notification buildFinished(Context ctx, String jobId, String title, String text, boolean success) {
        JobNotificationChannels.ensureChannels(ctx);
        return new NotificationCompat.Builder(ctx, JobNotificationChannels.CHANNEL_JOBS_ID)
            .setContentTitle(title)
            .setContentText(text)
            .setSmallIcon(success ? android.R.drawable.stat_sys_download_done : android.R.drawable.stat_notify_error)
            .setContentIntent(contentIntent(ctx))
            .setAutoCancel(true)
            .setGroup(JobNotificationChannels.GROUP_KEY_JOBS)
            .build();
    }

    public static Notification buildSummary(Context ctx, int activeCount) {
        JobNotificationChannels.ensureChannels(ctx);
        return new NotificationCompat.Builder(ctx, JobNotificationChannels.CHANNEL_JOBS_ID)
            .setContentTitle("Background jobs")
            .setContentText(activeCount + " active")
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setGroup(JobNotificationChannels.GROUP_KEY_JOBS)
            .setGroupSummary(true)
            .setOngoing(activeCount > 0)
            .build();
    }

    public static ForegroundInfo buildForegroundInfo(Context ctx, String jobId, String title, String text, int total, int done, boolean indeterminate, boolean ongoing) {
        Notification n = buildProgress(ctx, jobId, title, text, total, done, indeterminate, ongoing);
        return new ForegroundInfo(getNotificationId(jobId), n);
    }
}
