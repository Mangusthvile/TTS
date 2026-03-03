# Android log errors – causes and solutions

This doc covers log messages you may see when running TaleVox on Android (Capacitor), their causes, and what can be done.

---

## 1. Capacitor/Console: `[object Object]`

**What you see:**  
`Capacitor/Console ... Msg: [object Object]` or `[TaleVox] text:file:load:failed [object Object]`

**Cause:**  
Errors or objects were passed to `console.error` / `console.warn` without serialization. On Android, the Capacitor bridge often logs the second argument as `[object Object]` instead of expanding the object.

**Solution (done in code):**  
- **utils/trace.ts** – `trace()` and `traceError()` now serialize the payload for console (including `Error` message/stack and plain objects via `JSON.stringify`) so log lines show readable text.  
- **utils/logger.ts** – Logger `emit()` now appends a serialized `context` string to the log line instead of passing a raw object to `console.error`/`console.warn`.

So `text:file:load:failed` and other trace/logger messages should now show the actual error message and context in logcat.

---

## 2. ashmem: "Pinning is deprecated since Android Q"

**What you see:**  
`ashmem ... E  Pinning is deprecated since Android Q. Please use trim or other methods.`

**Cause:**  
Android’s ashmem (shared memory) API had a “pinning” API that was deprecated in Android Q (10). Some native code (often inside the WebView/Chromium stack, or a dependency like SQLite) still uses it. The stack trace usually points to system or WebView code, not your app.

**Solution:**  
- **Not fixable in app code.** The call is inside the platform or a closed-source dependency.  
- Safe to **ignore** for normal operation; it’s a deprecation warning, not a crash.  
- If you need to chase it, use a debug build and `adb logcat` with the PID of your app to see which library is triggering it; often it’s Chromium/WebView or a system component.  
- Long term, it will disappear as Android/WebView and dependencies remove the deprecated API.

---

## 3. Chromium: "Seed missing signature" (variations_seed_loader.cc)

**What you see:**  
`chromium ... E  [..../variations_seed_loader.cc:39] Seed missing signature.`

**Cause:**  
Chromium’s “variations” (A/B config / field trials) seed file is missing or has an invalid signature. This is internal to the WebView/Chromium used by Capacitor.

**Solution:**  
- **Not fixable in app code.** It comes from the WebView implementation (system or bundled).  
- Safe to **ignore**; it doesn’t affect TaleVox behavior.  
- On some devices/ROMs the system WebView doesn’t ship a valid variations seed; the message is cosmetic.  
- No need to change your app; it’s a known, harmless WebView log.

---

## 4. FilePhenotypeFlags: "cannot use FILE backing without declarative registration"

**What you see:**  
`FilePhenotypeFlags ... E  Config package com.google.android.gms.clearcut_client#com.cmwil.talevox cannot use FILE backing without declarative registration. See go/phenotype-android-integration#phenotype ...`

**Cause:**  
Google Play Services (e.g. Phenotype/clearcut) is trying to use “FILE backing” for feature flags for your app, but your app is not declaratively registered for that in the Phenotype configuration. This often happens when Play Services tries to apply flags for your package.

**Solution:**  
- **Usually safe to ignore.** It leads to “stale flags” for that config package, not to crashes or direct app bugs.  
- To remove the warning you’d need to follow Google’s Phenotype/Android integration (declarative registration). That’s only relevant if you rely on specific Phenotype/Play Services config for your app; most apps don’t.  
- No code change required in TaleVox unless you explicitly use Phenotype/clearcut config.

---

## 5. MediaCodec: "Media Quality Service not found" / "Failed to query component interface for required system resources: 6"

**What you see:**  
- `MediaCodec ... E  Media Quality Service not found.`  
- `m.cmwil.talevox ... E  Failed to query component interface for required system resources: 6`

**Cause:**  
- **Media Quality Service** – Optional Android service for media quality/analytics. Some devices or builds don’t ship it; MediaCodec logs when it’s missing.  
- **Failed to query component interface ... 6** – Error 6 in Android media/DRM is often `NO_INIT` or a similar failure when the media stack (or a codec/DRM component) can’t get a required system resource. It can be device- or OEM-specific (e.g. custom codec/DRM implementations).

**Solution:**  
- **App-level:** Ensure audio playback handles failures gracefully (e.g. catch play errors and show a message or fallback). TaleVox already uses error handling around playback; no change required unless you see actual playback failures on specific devices.  
- **System-level:** You can’t fix missing Media Quality Service or system resource 6 in your app; it’s device/ROM dependent.  
- If **playback fails** on certain devices, capture the full logcat around the first `MediaCodec` / `m.cmwil.talevox` error and the app’s own error logs (which will now show real messages thanks to the trace/logger fixes). That will tell you whether to add a device-specific workaround or a clearer user-facing error message.

---

## Summary

| Log | Fixable in app? | Action |
|-----|------------------|--------|
| `[object Object]` in Capacitor/Console | ✅ Yes | Fixed: trace + logger now serialize errors/context for console. |
| ashmem pinning deprecated | ❌ No | Ignore; deprecation warning from platform/dependency. |
| Chromium seed missing signature | ❌ No | Ignore; harmless WebView message. |
| FilePhenotypeFlags FILE backing | ❌ No | Ignore unless you use Phenotype config. |
| MediaCodec / system resources: 6 | ⚠️ Partial | Ignore if playback works; if not, use improved logs to debug and add UX (e.g. error message). |
