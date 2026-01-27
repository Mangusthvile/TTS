package com.cmwil.talevox.player;

import android.content.Intent;

import androidx.annotation.Nullable;
import androidx.media3.common.AudioAttributes;
import androidx.media3.common.C;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.session.DefaultMediaNotificationProvider;
import androidx.media3.session.MediaSession;
import androidx.media3.session.MediaSessionService;

public class NativePlayerService extends MediaSessionService {
    private MediaSession mediaSession;
    private ExoPlayer player;

    @Override
    public void onCreate() {
        super.onCreate();
        player = new ExoPlayer.Builder(this)
            .setAudioAttributes(
                new AudioAttributes.Builder()
                    .setUsage(C.USAGE_MEDIA)
                    .setContentType(C.AUDIO_CONTENT_TYPE_SPEECH)
                    .build(),
                true
            )
            .build();
        player.setHandleAudioBecomingNoisy(true);

        mediaSession = new MediaSession.Builder(this, player).build();
        setMediaNotificationProvider(new DefaultMediaNotificationProvider(this));
        setSession(mediaSession);
    }

    @Nullable
    @Override
    public MediaSession onGetSession(MediaSession.ControllerInfo controllerInfo) {
        return mediaSession;
    }

    @Override
    public void onDestroy() {
        if (mediaSession != null) {
            mediaSession.release();
            mediaSession = null;
        }
        if (player != null) {
            player.release();
            player = null;
        }
        super.onDestroy();
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        if (player != null) {
            player.pause();
        }
        super.onTaskRemoved(rootIntent);
    }
}
