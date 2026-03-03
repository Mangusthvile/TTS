# Section 4 — Progress & SQLite Writes

Reduce sustained I/O during playback by relaxing the progress-commit throttle on mobile, increasing the periodic flush interval on native, and optionally coalescing rapid writes. No change to pause/ended/reset persistence (they remain immediate).

---

## Current behavior

- **commitProgressUpdate** ([src/app/state/usePlayback.ts](src/app/state/usePlayback.ts)): Throttled to **800 ms** on mobile (line 271). When the throttle allows, it runs the full path: `readProgressStore()` → merge current chapter → `writeProgressStore(store, { persistToNative })`. For **tick** commits, `persistToNative` is false (lines 396–399), so we call `writeProgressStore(..., { persistToNative: false })`, which on native does **localStorage only** ([progressStore.ts](services/progressStore.ts) `writeProgressStoreNativeLocalOnly`). For **pause**, **ended**, and **reset**, `persistToNative` is true, so we call `writeProgressStore(..., { persistToNative: true })` (full native merge + SQLite) and `upsertSingleChapterProgress`. So during active playback we are **not** writing to SQLite on every throttled commit—only to localStorage every 800 ms. SQLite is written on pause/ended/reset and by the periodic flush.

- **handleSyncUpdate** still runs on every adapter state tick (~500 ms after Section 1). Each tick calls `commitProgressUpdate`; when the 800 ms throttle blocks, we return early and do no write. So we do at most one localStorage write per 800 ms during playback, plus setState and other logic every tick.

- **flushProgressStoreToDurable** ([services/progressStore.ts](services/progressStore.ts)): Runs every **45 s** from [App.tsx](App.tsx) (line 417–419). Non-immediate calls are debounced (**1200 ms**, line 1346); only one flush runs at a time (mutex). Each flush reads localStorage, normalizes, reads SQLite, merges, and writes full store to SQLite—so with many chapters it can spike. On native only.

- **No batching of tick commits:** Multiple `commitProgressUpdate` calls in quick succession (e.g. several ticks within 800 ms) still each run the throttle check; when the throttle allows, we do one `writeProgressStore` (localOnly). We do not currently coalesce "pending" progress into a single write after a quiet period; the throttle alone limits frequency.

- **Files:** There is no separate `progressFlush.ts`; flush and write logic live in [services/progressStore.ts](services/progressStore.ts) and the 45 s interval in [App.tsx](App.tsx). [src/app/state/usePlayback.ts](src/app/state/usePlayback.ts) owns `commitProgressUpdate` and the 800 ms throttle.

---

## 1. Increase progress-commit throttle on mobile (usePlayback.ts)

- **Current:** `throttleMs = effectiveMobileMode ? 800 : 250` (line 271).
- **Change:** Use **1000 ms** (or 1500 ms) on mobile for tick commits. Keep desktop at 250 ms. Pause/ended/reset already bypass the throttle when `force` or `bypassThrottle` is true, so they remain immediate.
- **Result:** Fewer localStorage writes during playback on mobile (e.g. once per second instead of ~1.25×/sec), and slightly less work in `commitProgressUpdate` per minute. Progress remains accurate; we only spread writes out a bit more.
- **Location:** [src/app/state/usePlayback.ts](src/app/state/usePlayback.ts), line 271. Replace `800` with a named constant (e.g. `PROGRESS_TICK_THROTTLE_MOBILE_MS = 1000`) and use it when `effectiveMobileMode` is true.

---

## 2. Increase periodic flush interval on native (App.tsx)

- **Current:** `setInterval(..., 45_000)` → `flushProgressStoreToDurable()` every 45 s (App.tsx lines 417–419). Applies to all platforms; flush is no-op on web.
- **Change:** On native only, use **60 s** instead of 45 s. On web, keep 45 s or use the same 60 s for consistency (flush is no-op there). Simplest: use 60_000 for the interval everywhere so native gets fewer full-store flushes per session.
- **Result:** Fewer SQLite full-write cycles during long listening sessions, reducing I/O spikes. Progress is still flushed on app background (immediate) and on pause/ended via commit path; the periodic flush is a safety net.
- **Location:** [App.tsx](App.tsx), line 419. Change `45_000` to `60_000` and add a short comment that the interval is chosen to limit SQLite I/O on native.

---

## 3. Optional: debounce/coalesce writeProgressStore for tick commits (progressStore or usePlayback)

- **Idea:** When `writeProgressStore(store, { persistToNative: false })` is called repeatedly in a short window (e.g. from multiple commitProgressUpdate ticks), coalesce into a single write after a short debounce (e.g. 300–500 ms), so we never write localStorage more than once per debounce window even if the throttle allows multiple commits.
- **Complexity:** `writeProgressStore` is synchronous (localStorage write); debouncing would require keeping a "pending" store and a timer, and ensuring the latest state is written when the timer fires. This touches shared state in progressStore or the call site. Lower priority than 1 and 2.
- **Recommendation:** Implement 1 and 2 first and measure. Add coalescing only if profiling shows localStorage write volume is still high.

---

## 4. Clarify in code that tick commits do not touch SQLite (optional comment)

- In [usePlayback.ts](src/app/state/usePlayback.ts), next to the `persistToNative` logic (lines 396–405), add a one-line comment: tick commits use `persistToNative: false` so SQLite is only updated on pause/ended/reset and via the periodic flush. This avoids future changes from accidentally turning every tick into a SQLite write.

---

## Implementation order

| Step | Task | File(s) |
|------|------|--------|
| 1 | Increase mobile progress tick throttle 800 ms → 1000 ms (named constant) | [src/app/state/usePlayback.ts](src/app/state/usePlayback.ts) |
| 2 | Increase periodic flush interval 45 s → 60 s; add brief comment | [App.tsx](App.tsx) |
| 3 | (Optional) Add comment that tick commits use persistToNative false | [src/app/state/usePlayback.ts](src/app/state/usePlayback.ts) |
| 4 | (Optional) Debounce/coalesce writeProgressStore for tick path | [services/progressStore.ts](services/progressStore.ts) or usePlayback |

---

## Verification

- **Playback:** Progress bar and chapter progress still update; after pause or chapter end, position is saved and restores correctly.
- **Background:** App background still triggers immediate flush; no regression.
- **Periodic:** After 60 s of playback, progress is persisted via the interval flush.
- **No feature removal:** Pause/ended/reset still write immediately; only tick throttle and flush interval are relaxed.

---

## Summary

- **Tick throttle (mobile):** 800 ms → 1000 ms in usePlayback to reduce localStorage write frequency during playback.
- **Periodic flush:** 45 s → 60 s in App.tsx to reduce SQLite full-write frequency on native.
- **Optional:** Comment in usePlayback clarifying tick vs pause/ended/reset; optional coalesce for writeProgressStore if needed after measuring.

No change to when we call `upsertSingleChapterProgress` (still only on pause/ended/reset). No change to flush on background or to the debounced flush mutex in progressStore.
