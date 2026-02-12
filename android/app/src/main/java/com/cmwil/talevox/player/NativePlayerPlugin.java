package com.cmwil.talevox.player;

import android.content.ComponentName;
import android.net.Uri;

import androidx.annotation.Nullable;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MediaMetadata;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.PlaybackParameters;
import androidx.media3.common.Player;
import androidx.media3.session.MediaController;
import androidx.media3.session.SessionToken;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.PluginMethod;
import com.google.common.util.concurrent.ListenableFuture;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutionException;

@CapacitorPlugin(name = "NativePlayer")
public class NativePlayerPlugin extends Plugin {
    private MediaController controller;
    private ListenableFuture<MediaController> controllerFuture;
    private boolean listenerAttached = false;

    private static class QueueItem {
        String id;
        String url;
        String title;
        String artist;
        String album;
        String artworkUrl;
    }

    private final List<QueueItem> queue = new ArrayList<>();

    private interface ControllerCallback {
        void onReady(MediaController controller);
        void onError(Exception e);
    }

    private void ensureController(ControllerCallback callback) {
        if (controller != null) {
            callback.onReady(controller);
            return;
        }
        if (controllerFuture == null) {
            SessionToken token = new SessionToken(getContext(), new ComponentName(getContext(), NativePlayerService.class));
            controllerFuture = new MediaController.Builder(getContext(), token).buildAsync();
        }
        controllerFuture.addListener(() -> {
            try {
                controller = controllerFuture.get();
                attachListenerIfNeeded(controller);
                callback.onReady(controller);
            } catch (ExecutionException | InterruptedException e) {
                callback.onError(e);
            }
        }, command -> command.run());
    }

    private void attachListenerIfNeeded(MediaController controller) {
        if (listenerAttached) return;
        listenerAttached = true;
        controller.addListener(new Player.Listener() {
            @Override
            public void onIsPlayingChanged(boolean isPlaying) {
                emitState();
            }

            @Override
            public void onPlaybackStateChanged(int state) {
                emitState();
                if (state == Player.STATE_ENDED) {
                    notifyListeners("ended", new JSObject(), true);
                }
            }

            @Override
            public void onPlaybackParametersChanged(PlaybackParameters playbackParameters) {
                emitState();
            }

            @Override
            public void onPositionDiscontinuity(Player.PositionInfo oldPosition, Player.PositionInfo newPosition, int reason) {
                emitState();
            }

            @Override
            public void onMediaItemTransition(@Nullable MediaItem mediaItem, int reason) {
                emitItemChanged(mediaItem);
                emitState();
            }

            @Override
            public void onPlayerError(PlaybackException error) {
                JSObject payload = new JSObject();
                payload.put("error", error != null ? error.getMessage() : "Unknown");
                notifyListeners("error", payload, true);
            }
        });
    }

    private void emitItemChanged(@Nullable MediaItem mediaItem) {
        if (mediaItem == null) return;
        String id = mediaItem.mediaId;
        QueueItem match = null;
        for (QueueItem item : queue) {
            if (item.id != null && item.id.equals(id)) {
                match = item;
                break;
            }
        }
        JSObject payload = new JSObject();
        JSObject item = new JSObject();
        item.put("id", id);
        if (match != null) {
            item.put("url", match.url);
            if (match.title != null) item.put("title", match.title);
            if (match.artist != null) item.put("artist", match.artist);
            if (match.album != null) item.put("album", match.album);
            if (match.artworkUrl != null) item.put("artworkUrl", match.artworkUrl);
        }
        payload.put("item", item);
        notifyListeners("itemChanged", payload, true);
    }

    private void emitState() {
        if (controller == null) return;
        JSObject obj = new JSObject();
        MediaItem current = controller.getCurrentMediaItem();
        obj.put("currentItemId", current != null ? current.mediaId : null);
        obj.put("currentTime", controller.getCurrentPosition() / 1000.0);
        long duration = controller.getDuration();
        if (duration == C.TIME_UNSET) duration = 0;
        obj.put("duration", duration / 1000.0);
        obj.put("isPlaying", controller.isPlaying());
        obj.put("speed", controller.getPlaybackParameters().speed);
        notifyListeners("state", obj, true);
    }

    private MediaItem buildItem(QueueItem item) {
        MediaMetadata.Builder meta = new MediaMetadata.Builder();
        if (item.title != null) meta.setTitle(item.title);
        if (item.artist != null) meta.setArtist(item.artist);
        if (item.album != null) meta.setAlbumTitle(item.album);
        if (item.artworkUrl != null && !item.artworkUrl.startsWith("data:")) {
            try {
                meta.setArtworkUri(Uri.parse(item.artworkUrl));
            } catch (Exception ignored) {}
        }
        return new MediaItem.Builder()
            .setMediaId(item.id != null ? item.id : "")
            .setUri(item.url)
            .setMediaMetadata(meta.build())
            .build();
    }

    private QueueItem parseItem(JSONObject obj) {
        QueueItem item = new QueueItem();
        item.id = obj.optString("id", "");
        item.url = obj.optString("url", "");
        item.title = obj.optString("title", null);
        item.artist = obj.optString("artist", null);
        item.album = obj.optString("album", null);
        item.artworkUrl = obj.optString("artworkUrl", null);
        return item;
    }

    @PluginMethod
    public void load(PluginCall call) {
        JSONObject itemObj = call.getObject("item");
        if (itemObj == null) {
            call.reject("Missing item");
            return;
        }
        QueueItem item = parseItem(itemObj);
        queue.clear();
        queue.add(item);
        ensureController(new ControllerCallback() {
            @Override
            public void onReady(MediaController controller) {
                controller.setMediaItem(buildItem(item));
                controller.prepare();
                emitItemChanged(controller.getCurrentMediaItem());
                emitState();
                call.resolve();
            }

            @Override
            public void onError(Exception e) {
                call.reject(e.getMessage());
            }
        });
    }

    @PluginMethod
    public void loadQueue(PluginCall call) {
        JSONArray items = call.getArray("items");
        int startIndex = call.getInt("startIndex", 0);
        if (items == null || items.length() == 0) {
            call.reject("Missing items");
            return;
        }
        List<MediaItem> mediaItems = new ArrayList<>();
        queue.clear();
        for (int i = 0; i < items.length(); i++) {
            JSONObject obj = items.optJSONObject(i);
            if (obj == null) continue;
            QueueItem item = parseItem(obj);
            queue.add(item);
            mediaItems.add(buildItem(item));
        }
        int clamped = Math.max(0, Math.min(startIndex, mediaItems.size() - 1));
        ensureController(new ControllerCallback() {
            @Override
            public void onReady(MediaController controller) {
                controller.setMediaItems(mediaItems, clamped, 0);
                controller.prepare();
                emitItemChanged(controller.getCurrentMediaItem());
                emitState();
                call.resolve();
            }

            @Override
            public void onError(Exception e) {
                call.reject(e.getMessage());
            }
        });
    }

    @PluginMethod
    public void play(PluginCall call) {
        ensureController(new ControllerCallback() {
            @Override
            public void onReady(MediaController controller) {
                controller.play();
                emitState();
                call.resolve();
            }

            @Override
            public void onError(Exception e) {
                call.reject(e.getMessage());
            }
        });
    }

    @PluginMethod
    public void pause(PluginCall call) {
        ensureController(new ControllerCallback() {
            @Override
            public void onReady(MediaController controller) {
                controller.pause();
                emitState();
                call.resolve();
            }

            @Override
            public void onError(Exception e) {
                call.reject(e.getMessage());
            }
        });
    }

    @PluginMethod
    public void stop(PluginCall call) {
        ensureController(new ControllerCallback() {
            @Override
            public void onReady(MediaController controller) {
                controller.stop();
                controller.clearMediaItems();
                emitState();
                call.resolve();
            }

            @Override
            public void onError(Exception e) {
                call.reject(e.getMessage());
            }
        });
    }

    @PluginMethod
    public void seekTo(PluginCall call) {
        int ms = call.getInt("ms", 0);
        ensureController(new ControllerCallback() {
            @Override
            public void onReady(MediaController controller) {
                controller.seekTo(Math.max(0, ms));
                emitState();
                call.resolve();
            }

            @Override
            public void onError(Exception e) {
                call.reject(e.getMessage());
            }
        });
    }

    @PluginMethod
    public void setSpeed(PluginCall call) {
        double rate = call.getDouble("rate", 1.0);
        ensureController(new ControllerCallback() {
            @Override
            public void onReady(MediaController controller) {
                controller.setPlaybackParameters(new PlaybackParameters((float) rate));
                emitState();
                call.resolve();
            }

            @Override
            public void onError(Exception e) {
                call.reject(e.getMessage());
            }
        });
    }

    @PluginMethod
    public void next(PluginCall call) {
        ensureController(new ControllerCallback() {
            @Override
            public void onReady(MediaController controller) {
                controller.seekToNextMediaItem();
                emitState();
                call.resolve();
            }

            @Override
            public void onError(Exception e) {
                call.reject(e.getMessage());
            }
        });
    }

    @PluginMethod
    public void previous(PluginCall call) {
        ensureController(new ControllerCallback() {
            @Override
            public void onReady(MediaController controller) {
                controller.seekToPreviousMediaItem();
                emitState();
                call.resolve();
            }

            @Override
            public void onError(Exception e) {
                call.reject(e.getMessage());
            }
        });
    }

    @PluginMethod
    public void getState(PluginCall call) {
        ensureController(new ControllerCallback() {
            @Override
            public void onReady(MediaController controller) {
                JSObject obj = new JSObject();
                MediaItem current = controller.getCurrentMediaItem();
                obj.put("currentItemId", current != null ? current.mediaId : null);
                obj.put("currentTime", controller.getCurrentPosition() / 1000.0);
                long duration = controller.getDuration();
                if (duration == C.TIME_UNSET) duration = 0;
                obj.put("duration", duration / 1000.0);
                obj.put("isPlaying", controller.isPlaying());
                obj.put("speed", controller.getPlaybackParameters().speed);
                call.resolve(obj);
            }

            @Override
            public void onError(Exception e) {
                call.reject(e.getMessage());
            }
        });
    }

    @Override
    protected void handleOnDestroy() {
        if (controller != null) {
            controller.release();
            controller = null;
        }
        super.handleOnDestroy();
    }
}
