# TaleVox Overheating & Streamlining Plan

This document identifies **all reasons the app may cause the phone to overheat** and outlines a plan to streamline the app into a smoother, less resource-heavy experience **without removing features**.

---

## 1. Root causes of overheating (identified)

Overheating on mobile is driven by **sustained CPU/GPU work**, **radio use**, **wake locks**, and **memory pressure**. Below are the sources found in the codebase.

---

### 1.1 Playback: JS ↔ Native bridge and state churn

| Source | Location | What it does | Impact |
|-------|----------|---------------|--------|
| **Mobile playback poll** | `services/playbackAdapter.ts` (MobilePlaybackAdapter) | While playing, `setInterval(..., 200)` calls `this.plugin.getState()` every **200 ms** (5×/sec). Each call is a **Capacitor bridge round-trip** to NativePlayerPlugin. | High: Constant bridge traffic + JS work 5×/sec during all playback. |
| **Desktop playback state interval** | `services/playbackAdapter.ts` (DesktopPlaybackAdapter) | While playing, `setInterval(..., 80)` emits state every **80 ms** (~12.5×/sec). Used on web; not on native. | N/A for phone (desktop only). |
| **Sync callback on every state tick** | `src/app/state/usePlayback.ts` → `handleSyncUpdate` | Every adapter state update (native events + 200 ms poll) runs `handleSyncUpdate` → `setAudioCurrentTime(meta.currentTime)` and often `setPlaybackSnapshot(...)`. **No throttle** on these setters. | High: **React re-renders** (App and children) up to **5×/sec** during playback. |
| **Progress commit throttle (mobile)** | `src/app/state/usePlayback.ts` | `commitProgressUpdate` is throttled to **800 ms** on mobile. So we do fewer progress writes, but we still run the sync handler and state updates every 200 ms. | Medium: Throttle helps; the 200 ms driver remains. |

**Summary:** During playback, the app does ~5 bridge calls/sec, ~5 full sync handler runs/sec, and ~5 React state updates/sec for `audioCurrentTime` / `playbackSnapshot`, which can re-render App, Player, Reader, ChapterFolderView, etc.

---

### 1.2 Highlight sync and reader UI

| Source | Location | What it does | Impact |
|-------|----------|---------------|--------|
| **useHighlightSync poll** | `hooks/useHighlightSync.ts` | `setInterval(..., Math.max(80, throttleMs))` with `throttleMs` from settings (**100–500 ms**). When playing, calls `updateFromState` → `setActiveCueIndex`, `setActiveParagraphIndex`, `setActiveCueRange`. | Medium–High: Extra React state updates **2–12×/sec** (depending on highlight rate setting) and DOM work for highlight positioning. |
| **Highlight update rate setting** | `components/Settings.tsx` | User can set **100, 200, 250, 300, 500 ms**. Default **100 ms** = 10 updates/sec for highlight. | High when set to 100 ms on a large chapter. |
| **Reader / scroll** | `components/Reader.tsx`, `ReaderList.tsx` | `requestAnimationFrame` and scroll-follow logic. Re-renders when playback/highlight state changes. | Medium: Amplifies cost of playback/highlight state updates. |

---

### 1.3 Speech service (desktop audio path)

| Source | Location | What it does | Impact |
|-------|----------|---------------|--------|
| **startSyncLoop (50 ms)** | `services/speechService.ts` | When using **HTML audio** (desktop), `setInterval(..., 50)` runs **20×/sec** for `smoothTick`. | N/A for phone: native uses ExoPlayer, not this path. |

---

### 1.4 Native player and wake lock

| Source | Location | What it does | Impact |
|-------|----------|---------------|--------|
| **ExoPlayer WAKE_MODE_LOCAL** | `NativePlayerService.java` | `player.setWakeMode(C.WAKE_MODE_LOCAL)` keeps a **partial wake lock** during playback so audio continues when screen is off. | Medium: Expected for audio; contributes to heat if combined with high CPU. |
| **Keep Awake (screen on)** | `hooks/useKeepAwake.ts`, Settings | When “Keep screen on” is **on**, `KeepAwake.keepAwake()` (FLAG_KEEP_SCREEN_ON) prevents doze and keeps display on. | High: Screen + CPU together increase heat; user-controlled. |
| **Foreground media service** | `NativePlayerService`, AndroidManifest | Media playback runs as foreground service. | Low–medium: Normal for background audio. |

---

### 1.5 Background jobs and WorkManager

| Source | Location | What it does | Impact |
|-------|----------|---------------|--------|
| **Periodic upload queue** | `JobRunnerPlugin.java` | `PeriodicWorkRequest` every **15 minutes** for DriveUploadWorker. | Low under normal use. |
| **Job progress polling** | `App.tsx` (useEffect with `refreshJobs`) | When there are active jobs: **1.5 s** (local) or **5 s** (cloud) interval to refresh job list. | Medium when jobs are running: repeated API/bridge and re-renders. |
| **GenerateAudioWorker / FixIntegrityWorker** | Android workers | CPU-heavy TTS and file work. | High only while jobs run; not idle heat. |

---

### 1.6 Progress and SQLite

| Source | Location | What it does | Impact |
|-------|----------|---------------|--------|
| **Progress flush interval** | `App.tsx` | `setInterval(..., 45_000)` → `flushProgressStoreToDurable()` every **45 s**. | Low: Infrequent. |
| **writeProgressStore / commitProgressUpdate** | `usePlayback.ts`, `progressStore.ts` | On each throttled commit (800 ms on mobile): `writeProgressStore` (localStorage) and sometimes `upsertSingleChapterProgress` (SQLite). | Medium: Repeated SQLite on long sessions if throttle is still too aggressive. |
| **flushProgressStoreToDurable** | `services/progressStore.ts` | Full flush from in-memory/localStorage to SQLite; debounced 1200 ms; also on background. | Low–medium: Serialized; can spike when many chapters. |

---

### 1.7 Other timers and UI

| Source | Location | What it does | Impact |
|-------|----------|---------------|--------|
| **Settings diagnostics log poll** | `components/Settings.tsx` | When diagnostics expanded: `setInterval(..., 1500)` to refresh log buffer. | Low: Only when that panel is open. |
| **Seek confirmation poll** | `usePlayback.ts` (`confirmSeekLanding`) | After seek: up to **30 × 50 ms** polls to confirm position. | Low: Short burst. |
| **Auto-save interval** | `App.tsx` | When Drive is configured: interval (minutes) to auto-save state. | Low. |
| **Downloaded chapters list** | `App.tsx` (useEffect) | When active book changes: loops all chapters and calls `getChapterAudioPath` per chapter; yields every 40. | Medium for books with many chapters: many native calls in one go. |

---

### 1.8 Architecture and re-renders

| Source | Location | What it does | Impact |
|-------|----------|---------------|--------|
| **Single large App state** | `App.tsx` (~6k lines) | One big `useState` for app state; `audioCurrentTime` and `playbackSnapshot` live in usePlayback and feed into App. Every playback tick can re-render a large tree. | High: Magnifies cost of 5×/sec playback updates. |
| **PlaybackDiagnosticsOverlay** | When `state.showDiagnostics` | Receives `audioCurrentTime` etc.; re-renders with playback. | Low unless diagnostics always on. |
| **ChapterFolderView** | Uses `react-window` | Virtualized list; good. Still re-renders when parent state (e.g. `playbackSnapshot`, jobs) changes. | Medium when combined with frequent state updates. |

---

## 2. Prioritized list: what to change (no feature removal)

### High impact (do first)

1. **Reduce mobile playback poll rate**  
   - **Current:** 200 ms (5×/sec) in `MobilePlaybackAdapter.handlePolling()`.  
   - **Change:** Increase to **400–500 ms** (2–2.5×/sec), or make it adaptive (e.g. 500 ms when position change is small).  
   - **Files:** `services/playbackAdapter.ts`.

2. **Throttle or derive playback UI state**  
   - **Current:** Every sync tick calls `setAudioCurrentTime` and often `setPlaybackSnapshot` → full React updates 5×/sec.  
   - **Change:** Throttle these setters (e.g. 250–400 ms) on mobile, or use a ref for “live” position and only set state at throttled interval for UI.  
   - **Files:** `src/app/state/usePlayback.ts`.

3. **Increase default highlight update rate on mobile**  
   - **Current:** Default `highlightUpdateRateMs` can be 100 ms (10×/sec).  
   - **Change:** Default to **250 ms or 300 ms** on native; keep 100 ms optional for users who want maximum smoothness.  
   - **Files:** Default in `App.tsx` / reader settings; `hooks/useHighlightSync.ts` already respects `throttleMs`.

4. **Keep Awake: document and optional default**  
   - **Current:** When enabled, screen stays on (more heat).  
   - **Change:** Default **off**; in Settings, add a short note that “Keep screen on” may increase device temperature. No code change to feature itself.

---

### Medium impact (next)

5. **Job polling when active**  
   - **Current:** 1.5 s (local) or 5 s (cloud) while jobs active.  
   - **Change:** Consider 3 s / 7 s on mobile, or exponential back-off when no progress change.  
   - **Files:** `App.tsx` (effect that calls `refreshJobs`), `src/config/appConfig.ts` if we add mobile-specific config.

6. **Batch or debounce “downloaded chapters” scan**  
   - **Current:** On active book change, one `getChapterAudioPath` per chapter.  
   - **Change:** Batch native calls or debounce when switching books quickly; consider caching with TTL (already have path TTL in appConfig).  
   - **Files:** `App.tsx` (useEffect that sets `downloadedChapters`).

7. **Progress commit on mobile**  
   - **Current:** 800 ms throttle.  
   - **Change:** Optionally increase to **1000–1500 ms** for “tick” commits on mobile only; keep immediate commit on pause/end/background.  
   - **Files:** `src/app/state/usePlayback.ts` (`commitProgressUpdate` throttle).

8. **Native player: avoid redundant getState when we have events**  
   - **Current:** Native already emits “state” on position/playing changes; we also poll `getState()` every 200 ms.  
   - **Change:** Rely more on native events; poll only at lower rate (e.g. 500 ms) or when no event for N ms (safety net).  
   - **Files:** `services/playbackAdapter.ts` (MobilePlaybackAdapter), optionally `NativePlayerPlugin.java` to emit position more often if needed.

---

### Lower impact (polish)

9. **Diagnostics overlay**  
   - Only re-render when diagnostics visible and throttle overlay updates (e.g. 500 ms) when visible.

10. **Seek confirmation**  
    - Slightly increase poll interval (e.g. 80 ms) to reduce burst of bridge calls; keep total timeout similar.

11. **Progress flush**  
    - Keep 45 s; if diagnostics show SQLite contention, consider 60 s on mobile.

12. **React structure (long term)**  
    - Isolate playback “tick” state (current time, snapshot) in a smaller subtree or context so only Player/Reader/progress bar re-render on tick, not the whole App.  
    - Optional: memo/React.memo on heavy list items that only need job/playback snapshot.

---

## 3. Implementation order (streamlining phases)

- **Phase 1 – Playback and UI tick (biggest win)**  
  - Increase mobile poll interval (200 → 400–500 ms).  
  - Throttle `setAudioCurrentTime` / `setPlaybackSnapshot` on native (e.g. 300 ms).  
  - Default highlight rate on native 250–300 ms.

- **Phase 2 – Throttles and defaults**  
  - Progress commit tick throttle 800 → 1000 ms on mobile.  
  - Job poll intervals slightly higher on mobile when active.  
  - Keep Awake default off + Settings note.

- **Phase 3 – Less bridge and re-renders**  
  - Rely more on native “state” events; reduce or adapt getState poll.  
  - Downloaded chapters: batch or debounce.  
  - Optional: throttle diagnostics overlay; slightly relax seek-confirm poll.

- **Phase 4 – Structure (optional)**  
  - Narrow re-render scope for playback state (context or smaller tree).  
  - Memo for heavy components that depend only on snapshot/job.

---

## 4. What we are not removing

- Keep Awake: keep feature; default off and document.
- Highlight sync: keep; reduce frequency by default on mobile.
- Progress persistence: keep; throttle a bit more on mobile.
- Job runner / uploads / TTS: keep; only adjust poll interval when jobs are active.
- Diagnostics overlay: keep; throttle when visible.
- All existing features remain; changes are intervals, defaults, and throttling.

---

## 5. Files to touch (summary)

| Area | Files |
|------|--------|
| Playback poll & throttle | `services/playbackAdapter.ts` |
| Sync/UI throttle | `src/app/state/usePlayback.ts` |
| Highlight default | `App.tsx`, reader defaults / `state.readerSettings` |
| Job poll | `App.tsx`, optionally `src/config/appConfig.ts` |
| Progress commit | `src/app/state/usePlayback.ts` |
| Keep Awake | `components/Settings.tsx` (default + note) |
| Downloaded chapters | `App.tsx` |
| Native events vs poll | `services/playbackAdapter.ts`, (optional) `NativePlayerPlugin.java` |

---

## 6. How to validate

- **Thermal:** Use app for 20–30 min playback (screen on, then screen off with Keep Awake off); compare device temperature before/after Phase 1.  
- **Battery:** Android Battery settings → TaleVox → compare %/hr before/after.  
- **Smoothness:** Subjective; ensure 250–300 ms highlight and 400–500 ms poll still feel responsive; adjust within range if needed.  
- **Correctness:** Progress and position still save on pause/background/end; jobs still update; no regressions in playback or seek.

This plan should significantly reduce sustained CPU and bridge traffic during playback and make the app smoother and less likely to overheat, without removing any features.
