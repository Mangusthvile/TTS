package com.cmwil.talevox.notifications;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.os.Build;

public class JobNotificationChannels {
    public static final String CHANNEL_JOBS_ID = "talevox_jobs";
    public static final String CHANNEL_JOBS_NAME = "Background jobs";
    public static final String GROUP_KEY_JOBS = "talevox_job_group";

    private static volatile boolean created = false;

    public static void ensureChannels(Context ctx) {
        if (created) return;
        if (ctx == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;
            NotificationChannel channel = nm.getNotificationChannel(CHANNEL_JOBS_ID);
            if (channel == null) {
                channel = new NotificationChannel(
                    CHANNEL_JOBS_ID,
                    CHANNEL_JOBS_NAME,
                    NotificationManager.IMPORTANCE_DEFAULT
                );
                nm.createNotificationChannel(channel);
            }
        }
        created = true;
    }
}
