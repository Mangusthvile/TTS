package com.cmwil.talevox.player;

import androidx.annotation.Nullable;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.PluginMethod;

@CapacitorPlugin(name = "NativePlayer")
public class NativePlayerPlugin extends Plugin {
    private final NativePlayerState state = new NativePlayerState();

    @PluginMethod
    public void load(PluginCall call) {
        JSObject item = call.getObject("item");
        state.currentItemId = item != null ? item.getString("id") : null;
        state.isPlaying = false;
        notifyState();
        call.resolve();
    }

    @PluginMethod
    public void loadQueue(PluginCall call) {
        int startIndex = call.getInt("startIndex", 0);
        state.queueIndex = startIndex;
        state.isPlaying = false;
        notifyState();
        call.resolve();
    }

    @PluginMethod
    public void play(PluginCall call) {
        state.isPlaying = true;
        notifyState();
        call.resolve();
    }

    @PluginMethod
    public void pause(PluginCall call) {
        state.isPlaying = false;
        notifyState();
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        state.isPlaying = false;
        state.currentTimeMs = 0;
        notifyState();
        call.resolve();
    }

    @PluginMethod
    public void seekTo(PluginCall call) {
        int ms = call.getInt("ms", 0);
        state.currentTimeMs = Math.max(0, ms);
        notifyState();
        call.resolve();
    }

    @PluginMethod
    public void setSpeed(PluginCall call) {
        double rate = call.getDouble("rate", 1.0);
        state.speed = rate;
        notifyState();
        call.resolve();
    }

    @PluginMethod
    public void next(PluginCall call) {
        state.queueIndex = Math.max(0, state.queueIndex + 1);
        notifyState();
        call.resolve();
    }

    @PluginMethod
    public void previous(PluginCall call) {
        state.queueIndex = Math.max(0, state.queueIndex - 1);
        notifyState();
        call.resolve();
    }

    @PluginMethod
    public void getState(PluginCall call) {
        call.resolve(state.toJSObject());
    }

    private void notifyState() {
        notifyListeners("state", state.toJSObject(), true);
    }

    private static class NativePlayerState {
        @Nullable String currentItemId = null;
        int currentTimeMs = 0;
        int durationMs = 0;
        boolean isPlaying = false;
        double speed = 1.0;
        int queueIndex = 0;

        JSObject toJSObject() {
            JSObject obj = new JSObject();
            obj.put("currentItemId", currentItemId);
            obj.put("currentTime", currentTimeMs / 1000.0);
            obj.put("duration", durationMs / 1000.0);
            obj.put("isPlaying", isPlaying);
            obj.put("speed", speed);
            return obj;
        }
    }
}
