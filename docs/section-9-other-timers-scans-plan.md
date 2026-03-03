# Section 9 — Other Timers & Scans

Reduce small but additive sources of CPU, bridge traffic, and I/O: diagnostics log poll, per-chapter audio-path scan on book change, seek confirmation polling burst, Drive auto-save frequency, and per-rule regex compilation in the TTS worker. Priority: Low (individually small; collectively they add to baseline load).

---

## Current behavior

- **Diagnostics log poll:** [components/Settings.tsx](components/Settings.tsx) (lines 174–179): When the diagnostics section is expanded (`isDiagExpanded`), a `setInterval` runs every **1500 ms** calling `setRecentLogs(getLogBuffer(20))`. That keeps the Settings UI and log buffer reads ticking while the panel is open.
- **Downloaded chapters scan:** [App.tsx](App.tsx) (lines 1175–1209): On every `activeBookId` / `books` change, an effect runs that loops over `book.chapters` and calls `getChapterAudioPath(chapter.id)` **once per chapter** (with `yieldToUi` every 40). [services/chapterAudioStore.ts](services/chapterAudioStore.ts) has a TTL cache (default 60 s) and in-flight dedup per chapterId, but there is **no batch API** — each chapter is a separate storage (and on native, bridge) call. For a 100-chapter book that’s up to 100 calls on first open; cache helps when re-opening the same book within TTL.
- **Seek confirmation burst:** [src/app/state/usePlayback.ts](src/app/state/usePlayback.ts) (lines 711–735): After a seek, `confirmSeekLanding` runs a loop with **POLL_ITERATIONS = 30** and **POLL_INTERVAL_MS = 50**. Each iteration calls `adapter.getState()` (on mobile, a JS→native bridge call) and checks `positionMs` against the target. So after every seek we do **up to 30 bridge polls** at 50 ms apart (~1.5 s max) to confirm the position landed.
- **Auto-save:** [App.tsx](App.tsx) (lines 2196–2205): When `state.driveRootFolderId` is set, a `setInterval` runs with `intervalMinutes = state.autoSaveInterval` (default 30). Each tick calls `handleSaveState(false, true)` if `isDirty`, which does **network I/O** (Drive upload). Low frequency but contributes to periodic CPU/network when Drive is configured.
- **Regex in GenerateAudioWorker:** [android/app/src/main/java/com/cmwil/talevox/jobrunner/GenerateAudioWorker.java](android/app/src/main/java/com/cmwil/talevox/jobrunner/GenerateAudioWorker.java) (lines 505–521): `applyRules` loops over each rule and for every rule calls `Pattern.compile(pattern, flags)` **inside the loop**. So for each chunk of text we recompile every rule’s regex instead of compiling once per rule and reusing.

---

## 1. Throttle or slow diagnostics log poll (Settings.tsx)

**Goal:** Reduce how often the log buffer is read and state updated while the diagnostics panel is open.

- **Current:** `setInterval(..., 1500)` → ~40 reads/min.
- **Change:** Increase the interval to **3000 ms** (or 4000 ms) when the diagnostics section is expanded. Use a named constant (e.g. `DIAG_LOG_POLL_INTERVAL_MS = 3000`) so it can be tuned. Alternatively, refresh only on a user action (e.g. "Refresh" button) and remove the interval; the plan prefers throttling so logs still update automatically.
- **Result:** Fewer timer firings and setState calls while the panel is open; logs still update every few seconds.

**Files:** [components/Settings.tsx](components/Settings.tsx).

---

## 2. Downloaded chapters scan: batch or bounded concurrency + cache (App.tsx, chapterAudioStore, storage)

**Goal:** Avoid N sequential (or N unbounded parallel) `getChapterAudioPath` calls on every active book change.

- **Option A — Batch storage API:** Add a method that returns audio path info for many chapter IDs in one go, e.g. `getChapterAudioPaths(chapterIds: string[]): Promise<Map<string, { localPath: string; sizeBytes: number; updatedAt: number } | null>>`. Implement in SQLite with a single `SELECT ... WHERE chapterId IN (...)` (or multiple rows from `chapter_audio_files`). Use it in the App effect so we do **one** storage (and on native, one bridge) call per book instead of N. [chapter_audio_files](services/sqliteStorageDriver.ts) is keyed by chapterId; we can query by a list of ids.
- **Option B — Bounded concurrency:** Keep per-chapter `getChapterAudioPath` but run them in parallel with a concurrency limit (e.g. 5–10 at a time) so we don’t block the main thread for 100 sequential awaits, and rely on existing TTL cache for repeat visits. Simpler than Option A but still N storage calls on first load.
- **Option C — Longer TTL for “downloaded” UI:** Increase `chapterAudioPathTtlMs` for the path used by the downloaded-chapters scan only (e.g. pass a longer TTL when calling from that effect), or add a separate short-lived cache keyed by `bookId` that stores the last “downloaded chapters” result for that book for 30–60 s so switching back to the same book doesn’t re-scan.
- **Recommendation:** Implement **Option A** if the storage layer can support a batch query without much refactor; otherwise **Option B** (bounded concurrency) plus ensure cache TTL is sufficient (Option C). Document that the downloaded list may be up to TTL seconds stale.

**Files:** [App.tsx](App.tsx), [services/chapterAudioStore.ts](services/chapterAudioStore.ts), [services/storageDriver.ts](services/storageDriver.ts), [services/sqliteStorageDriver.ts](services/sqliteStorageDriver.ts) (if batch API added).

---

## 3. Reduce seek confirmation bridge polls (usePlayback.ts)

**Goal:** Fewer `getState()` bridge calls after a seek while still reliably detecting when the position has landed.

- **Current:** 30 iterations × 50 ms, each calling `adapter.getState()` → up to 30 bridge calls per seek.
- **Change:** One or more of:
  - **Reduce iterations:** Use **POLL_ITERATIONS = 15** (and keep 50 ms) so we poll for up to 750 ms instead of 1.5 s; most seeks land within a few hundred ms.
  - **Increase interval:** Use **POLL_INTERVAL_MS = 100** so we do at most 15 polls in 1.5 s (same total time, half the bridge calls), or 30 × 100 ms = 3 s max.
  - **Rely on native events:** If the native player emits a “seeked” or position-update event when the seek completes, subscribe to that and resolve `confirmSeekLanding` on the first event within tolerance instead of polling. Then we can remove or shorten the poll loop. (Larger change; depends on NativePlayerPlugin already emitting such an event.)
- **Recommendation:** Implement **fewer iterations** (e.g. 15) and optionally **longer interval** (100 ms). If profiling shows seeks often need more than 750 ms to land, keep 30 iterations but use 100 ms interval to halve bridge calls.

**Files:** [src/app/state/usePlayback.ts](src/app/state/usePlayback.ts).

---

## 4. Optional: Reduce Drive auto-save frequency on native (App.tsx)

**Goal:** Slightly lower periodic network I/O when Drive is configured and the app is on device.

- **Current:** `intervalMinutes = state.autoSaveInterval` (default 30); same on web and native.
- **Change:** On native only, use a **longer effective interval** for the auto-save timer, e.g. `intervalMinutes * 2` (cap at e.g. 120 min), so we save at most half as often when on device. User-configured “Auto-save interval” can stay in minutes; we only multiply it on native for the timer. Alternatively, leave as-is and document that auto-save is already minutes-scale and low priority.
- **Result:** Fewer Drive uploads per session on mobile; manual save and other flows unchanged.

**Files:** [App.tsx](App.tsx).

---

## 5. Cache compiled regex per rule in GenerateAudioWorker (GenerateAudioWorker.java)

**Goal:** Compile each rule’s `Pattern` once (per rule identity) and reuse instead of recompiling on every `applyRules` call.

- **Current:** In `applyRules`, for each rule we build `pattern` and call `Pattern.compile(pattern, flags)` every time we process a chunk of text.
- **Change:** For each rule we need a stable key (e.g. `rule.find` + `rule.matchCase` + `rule.wholeWord` + `rule.matchExpression` + `rule.ruleType`). Cache `Pattern` instances in a `Map<String, Pattern>` (or per-rule cache) keyed by that string (or by rule object identity if rules list is stable per run). When applying rules, look up the compiled pattern; if missing, compile and put in cache. Clear or limit the cache when the rules list is reloaded (e.g. when `loadRulesForBook` returns a new list, clear the cache for that book or use a cache key that includes bookId + rules hash). Simpler approach: cache per `(find, flags)` or per rule index in the current rules list and invalidate when rules change.
- **Result:** Fewer `Pattern.compile` calls during TTS generation; small CPU saving per chunk when many rules are applied.

**Files:** [android/app/src/main/java/com/cmwil/talevox/jobrunner/GenerateAudioWorker.java](android/app/src/main/java/com/cmwil/talevox/jobrunner/GenerateAudioWorker.java).

---

## Implementation order

| Step | Task | File(s) |
|------|------|--------|
| 1 | Increase diagnostics log poll interval 1500 → 3000 ms (named constant) | [components/Settings.tsx](components/Settings.tsx) |
| 2 | Reduce seek confirmation: POLL_ITERATIONS 30→15 and/or POLL_INTERVAL_MS 50→100 | [src/app/state/usePlayback.ts](src/app/state/usePlayback.ts) |
| 3 | Cache compiled Pattern per rule in ApplyRules (GenerateAudioWorker) | [GenerateAudioWorker.java](android/app/src/main/java/com/cmwil/talevox/jobrunner/GenerateAudioWorker.java) |
| 4 | Downloaded chapters: add batch getChapterAudioPaths or bounded concurrency in App effect | [App.tsx](App.tsx), [chapterAudioStore.ts](services/chapterAudioStore.ts), storage drivers |
| 5 | (Optional) On native, use 2× auto-save interval for the Drive save timer | [App.tsx](App.tsx) |

---

## Verification

- **Diagnostics:** With diagnostics section open, log list still updates; interval is 3 s (or chosen value).
- **Seek:** Seek still lands and UI updates; no regression in scrub or chapter jump; fewer bridge calls in traces.
- **GenerateAudioWorker:** TTS output with rules unchanged; no duplicate or wrong replacements.
- **Downloaded chapters:** List still correct when switching books; first load may use batch or bounded concurrency; cache behavior unchanged for other callers.
- **Auto-save:** Manual save and save-on-blur unchanged; on native, auto-save timer uses longer interval when implemented.

---

## Summary

- **Diagnostics:** 1.5 s → 3 s (or similar) poll interval while the panel is open.
- **Seek confirmation:** Fewer iterations and/or longer interval so we do at most ~15 bridge polls after a seek instead of 30.
- **GenerateAudioWorker:** Cache compiled `Pattern` per rule (keyed by rule identity) and reuse in `applyRules`.
- **Downloaded chapters:** Batch storage API or bounded concurrency for `getChapterAudioPath` in the active-book effect; optional longer TTL/cache for that UI.
- **Auto-save (optional):** On native, double the effective auto-save interval to reduce periodic Drive I/O.

No features removed; only intervals, poll count, regex reuse, and batch/concurrency are tuned.
