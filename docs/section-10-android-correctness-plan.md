# Section 10 — Android-Specific Correctness

Address correctness and stability issues that cause wasted work and instability (and can contribute to heat): thread-unsafe cache in the TTS worker, audio focus behavior for the native player, and notification listener accumulation. Priority: Medium (correctness/stability).

---

## Current behavior

- **driveFolderCache in GenerateAudioWorker:** [android/app/src/main/java/com/cmwil/talevox/jobrunner/GenerateAudioWorker.java](android/app/src/main/java/com/cmwil/talevox/jobrunner/GenerateAudioWorker.java) uses a plain `HashMap<String, String>` (line 64) for caching Drive folder IDs by `rootFolderId + "::" + volumeName`. It is read in `resolveOrCreateVolumeFolder` (get, then put after network calls). WorkManager runs `doWork()` on a single worker thread per job, but if the worker or any downstream code is ever called from multiple threads (e.g. parallel chapter processing, or shared worker instance), the HashMap is not thread-safe and can corrupt or throw. Making it thread-safe avoids races and repeat folder fetches if parallel access is introduced later.
- **Audio focus in NativePlayerPlugin / NativePlayerService:** [NativePlayerService.java](android/app/src/main/java/com/cmwil/talevox/player/NativePlayerService.java) builds ExoPlayer with `setAudioAttributes(..., true)` (line 26), so `handleAudioFocus` is already **true**. ExoPlayer can then request and respond to audio focus. If other apps still interrupt without proper handoff (e.g. no pause, or retry/restart loops), we should verify that focus is actually requested when playback starts and that focus loss results in pause (not restart). [NativePlayerPlugin.java](android/app/src/main/java/com/cmwil/talevox/player/NativePlayerPlugin.java) talks to the service via MediaController; the session/service side is where focus is handled. Plan: verify current behavior and, if needed, ensure focus is requested on play and abandoned on stop; handle focus loss by pausing and notifying JS so the UI doesn’t retry unnecessarily.
- **Notification listener accumulation (notificationManager.ts):** [services/notificationManager.ts](services/notificationManager.ts) keeps a global `Set<Listener>` (line 12). [subscribeNotice](services/notificationManager.ts) adds a listener and returns an unsubscribe that removes it. [NotificationHost](components/notifications/NotificationHost.tsx) subscribes in a `useEffect` and returns that unsubscribe (lines 11–22), so on unmount the listener is removed. If any caller ever subscribes without calling the returned unsubscribe (e.g. missing cleanup, or conditional subscribe), or if the same component is mounted multiple times in the tree, listeners can accumulate and every `notify()` will fire all of them. Plan: audit all `subscribeNotice` callers to ensure they unsubscribe on unmount; optionally add a guard or single-subscriber contract to avoid duplicate registration.

---

## 1. Make driveFolderCache thread-safe (GenerateAudioWorker.java)

**Goal:** Prevent cache corruption and undefined behavior if the cache is ever accessed from more than one thread.

- **Current:** `private final Map<String, String> driveFolderCache = new HashMap<>();`
- **Change:** Replace with `ConcurrentHashMap`:  
  `private final Map<String, String> driveFolderCache = new java.util.concurrent.ConcurrentHashMap<>();`  
  Use the same for `rulePatternCache` if it could ever be touched from another thread (currently only from the worker thread in `applyRules`; optional for consistency).
- **Result:** Safe concurrent get/put/clear; no behavioral change for the current single-threaded worker run.

**Files:** [android/app/src/main/java/com/cmwil/talevox/jobrunner/GenerateAudioWorker.java](android/app/src/main/java/com/cmwil/talevox/jobrunner/GenerateAudioWorker.java).

---

## 2. Verify and harden audio focus (NativePlayerService / NativePlayerPlugin)

**Goal:** Ensure other apps can take audio focus without leaving our app in a bad state (retries, restarts, or no pause).

- **Current:** ExoPlayer is built with `setAudioAttributes(..., true)` so `handleAudioFocus` is true. `setHandleAudioBecomingNoisy(true)` is set. MediaSession is used for playback.
- **Verification:** Confirm that when another app takes focus, ExoPlayer pauses and the UI reflects it (no repeated play attempts). Check that when we call `play()`, focus is requested and that when we call `stop()` or pause, focus is abandoned.
- **Change (if needed):** If focus loss does not result in a clean pause, ensure the player or session requests audio focus when starting playback and abandons it when stopping. Media3/ExoPlayer with `handleAudioFocus == true` should do this; if not, add explicit `AudioManager.requestAudioFocus` before play and `abandonAudioFocusRequest` on stop/pause. Emit a state or event to JS on focus loss so the UI can show “Paused (another app is playing)” instead of retrying.
- **Result:** Proper OS handoff when another app plays audio; fewer retries/restarts and less wasted work.

**Files:** [android/app/src/main/java/com/cmwil/talevox/player/NativePlayerService.java](android/app/src/main/java/com/cmwil/talevox/player/NativePlayerService.java), [NativePlayerPlugin.java](android/app/src/main/java/com/cmwil/talevox/player/NativePlayerPlugin.java) (if we need to notify JS on focus loss).

---

## 3. Prevent notification listener accumulation (notificationManager.ts + callers)

**Goal:** Ensure at most one logical subscription per subscriber and that unmount always removes the listener.

- **Current:** Global `listeners` Set; `subscribeNotice` adds and returns a function that removes. NotificationHost uses `useEffect(() => subscribeNotice(...), [])` and returns the unsubscribe.
- **Change:**
  - **Audit:** Confirm every `subscribeNotice` call site (currently [NotificationHost.tsx](components/notifications/NotificationHost.tsx)) stores the returned unsubscribe and calls it in the same effect’s cleanup. Fix any caller that does not.
  - **Optional guard:** If the same listener reference is added twice, avoid adding it again (e.g. `if (listeners.has(listener)) return () => {};` before add). Or document that callers must not subscribe more than once without unsubscribing.
  - **Optional dev warning:** In `notify()`, if `listeners.size > 1` in development, log a warning so accidental accumulation is visible.
- **Result:** No duplicate listeners; each notification is delivered once per intended subscriber.

**Files:** [services/notificationManager.ts](services/notificationManager.ts), [components/notifications/NotificationHost.tsx](components/notifications/NotificationHost.tsx).

---

## Implementation order

| Step | Task | File(s) |
|------|------|--------|
| 1 | Replace driveFolderCache HashMap with ConcurrentHashMap | [GenerateAudioWorker.java](android/app/src/main/java/com/cmwil/talevox/jobrunner/GenerateAudioWorker.java) |
| 2 | Optionally replace rulePatternCache with ConcurrentHashMap for consistency | [GenerateAudioWorker.java](android/app/src/main/java/com/cmwil/talevox/jobrunner/GenerateAudioWorker.java) |
| 3 | Verify audio focus: test focus loss and play/stop; add explicit request/abandon or focus-loss event if needed | [NativePlayerService.java](android/app/src/main/java/com/cmwil/talevox/player/NativePlayerService.java), [NativePlayerPlugin.java](android/app/src/main/java/com/cmwil/talevox/player/NativePlayerPlugin.java) |
| 4 | Audit subscribeNotice callers; add duplicate-add guard or dev warning in notificationManager | [notificationManager.ts](services/notificationManager.ts), [NotificationHost.tsx](components/notifications/NotificationHost.tsx) |

---

## Verification

- **GenerateAudioWorker:** No change in TTS/upload behavior; cache still reduces Drive folder lookups; no ConcurrentModificationException or corruption under load.
- **Audio focus:** When another app plays audio, our player pauses and UI shows paused state; no retry storm. When we stop, focus is abandoned.
- **Notifications:** Only one NotificationHost (or intended subscriber) receives each notice; unmount removes its listener; dev build warns if listener count > 1.

---

## Summary

- **GenerateAudioWorker:** Use `ConcurrentHashMap` for `driveFolderCache` (and optionally `rulePatternCache`) to avoid races if cache is ever accessed from multiple threads.
- **Audio focus:** Rely on ExoPlayer’s `handleAudioFocus`; verify focus loss pauses playback and add explicit request/abandon or JS notification if needed.
- **notificationManager:** Ensure all `subscribeNotice` callers unsubscribe on unmount; add a guard or dev warning to catch duplicate listeners.

No feature changes; only thread safety, focus behavior, and listener lifecycle correctness.
