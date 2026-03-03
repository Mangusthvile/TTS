# Full-Scale Overheating Audit (Post Sections 1–10)

This document audits **all heat-related behavior** after implementing the streamlining plans (Sections 1–10). It confirms what was fixed, flags any remaining issues, and recommends follow-ups where useful.

---

## Summary of What Was Implemented

| Section | Area | Changes |
|--------|------|--------|
| **1** | Playback polling & bridge | Mobile poll 200→500 ms; sync UI throttle 300 ms on mobile; NativePlayerPlugin listener cleanup; adapter teardown removes Capacitor listeners |
| **2** | Highlight sync | Platform default 250 ms on native (100 ms on web); Settings shows platform-aware default; single setState per tick (batched state object, commented) |
| **3** | Wake lock & screen | Default Keep Awake off on native; document that screen-on is main heat contributor when on |
| **4** | Progress & SQLite | Mobile progress throttle 800→1000 ms; periodic flush 45→60 s |
| **5** | App state & re-renders | PlaybackTickContext; diagnostics overlay reads tick from context; AppShell memoized; optional throttle/memo not done |
| **6** | Job polling & CPU | Native job poll 2.5 s local / 7 s cloud; round-robin one cloud job per refresh; WorkManager backoff 20 s; DriveUploadWorker single-task path when concurrency=1; FixIntegrityWorker MAX_FOLDER_DEPTH=5 |
| **7** | Upload queue | hasQueuedUpload + batch enqueueUploads (one list, existingKeys, skipDuplicateCheck); index on (bookId, chapterId) |
| **8** | Startup | Batched chapter preload (batch size 4, first 10 books); GIS script onload instead of 500 ms poll |
| **9** | Other timers | Diagnostics log poll 1500→3000 ms; seek confirmation 15×100 ms; regex cache in GenerateAudioWorker; downloaded chapters 8-way concurrency; native auto-save 2× interval |
| **10** | Android correctness | driveFolderCache + rulePatternCache → ConcurrentHashMap; audio focus documented; notificationManager duplicate guard + dev warning |

---

## 1. Playback (Mobile)

| Source | Status | Notes |
|--------|--------|--------|
| Mobile playback poll | **FIXED** | 500 ms (MOBILE_POLL_INTERVAL_MS); native event freshness skip reduces bridge calls further |
| Sync UI updates | **FIXED** | Throttle 300 ms on mobile for setAudioCurrentTime / setPlaybackSnapshot |
| Native listener cleanup | **FIXED** | Listener removed in handleOnDestroy; listenerAttached reset |
| Adapter Capacitor listeners | **FIXED** | destroy() / removeNativeListeners stored and called when swapping adapter |
| Desktop state interval (80 ms) | **N/A** | Desktop only; not used on native |
| Seek confirmation burst | **FIXED** | 15 iterations × 100 ms (was 30×50 ms) |

**Remaining:** None significant. Playback path on native is now ~2 bridge polls/sec and ~2–3 UI update ticks/sec when throttled.

---

## 2. Highlight Sync

| Source | Status | Notes |
|--------|--------|--------|
| Default rate on native | **FIXED** | 250 ms when unset (was 100 ms) |
| Settings selected state | **FIXED** | Platform-aware default so 250 ms shows selected on native |
| Single setState per tick | **NOT DONE** | Optional; would reduce re-renders from 3 to 1 per tick |

**Remaining:** None. Optional: batch activeCueIndex, activeParagraphIndex, activeCueRange into one state object in useHighlightSync — **done**: single state object + comment.

---

## 3. Wake Lock & Screen

| Source | Status | Notes |
|--------|--------|------|
| Keep Awake default | **FIXED** | Off on native by default |
| WAKE_MODE_LOCAL | **UNCHANGED** | Required for background audio; documented |
| Screen-on when Keep Awake on | **DOCUMENTED** | Main heat contributor when enabled; user choice |

**Remaining:** None. Behavior is intentional and user-controlled.

---

## 4. Progress & SQLite

| Source | Status | Notes |
|--------|--------|------|
| Tick commit throttle (mobile) | **FIXED** | 1000 ms (was 800 ms) |
| Periodic flush | **FIXED** | 60 s (was 45 s) |
| flushProgressStoreToDurable | **UNCHANGED** | Debounce 1200 ms; mutex; only on native |

**Remaining:** None. SQLite write frequency is reduced.

---

## 5. App State & Re-renders

| Source | Status | Notes |
|--------|--------|------|
| diagnosticsNode through AppShell | **FIXED** | Overlay reads from PlaybackTickContext; AppShell no longer gets new prop every tick |
| AppShell memo | **FIXED** | React.memo so shell skips re-render when only tick changes |
| Player / ChapterFolderView / ChapterSidebar memo | **NOT DONE** | Optional |
| Diagnostics overlay display throttle | **FIXED** | PlaybackDiagnosticsOverlay already uses DISPLAY_THROTTLE_MS = 500 |

**Remaining:** None. Optional: React.memo on Player, ChapterSidebar, ChapterFolderView — **done** (already present; displayName added). Tick in child provider — **done** (tick in tickStore; App does not subscribe).

---

## 6. Job Polling & Active Job CPU

| Source | Status | Notes |
|--------|--------|------|
| Job poll interval (native) | **FIXED** | 2.5 s local, 7 s cloud |
| syncCloudBackedJobs | **FIXED** | Round-robin one cloud job per refresh |
| WorkManager backoff | **FIXED** | 20 s exponential for all three workers |
| DriveUploadWorker executor | **FIXED** | Single upload on worker thread when CONCURRENT_UPLOADS=1 |
| FixIntegrityWorker depth | **FIXED** | MAX_FOLDER_DEPTH = 5 |
| OkHttp connection reuse | **NOT DONE** | Optional follow-up |

**Remaining:** Optional: OkHttp client for Drive/TTS to reuse TCP connections. Workers are already backoff-limited and less chatty.

---

## 7. Upload Queue

| Source | Status | Notes |
|--------|--------|------|
| hasQueuedUpload | **FIXED** | SQLite + Memory + LocalStorage; used in enqueueChapterUpload |
| enqueueUploads batch | **FIXED** | One list, existingKeys Set, skipDuplicateCheck |
| Index (bookId, chapterId) | **FIXED** | In SQLite schema |

**Remaining:** None.

---

## 8. Startup

| Source | Status | Notes |
|--------|--------|------|
| Chapter preload concurrency | **FIXED** | Batches of 4; first 10 books only |
| GIS init | **FIXED** | Script onload when tag present; fallback poll otherwise |

**Remaining:** None. Cold start is much lighter.

---

## 9. Other Timers & Scans

| Source | Status | Notes |
|--------|--------|------|
| Diagnostics log poll | **FIXED** | 3000 ms (was 1500 ms) |
| Seek confirmation | **FIXED** | 15 × 100 ms |
| GenerateAudioWorker regex | **FIXED** | Pattern cache per (pattern, flags) |
| Downloaded chapters | **FIXED** | 8-way concurrency |
| Auto-save on native | **FIXED** | 2× interval (cap 120 min) |

**Remaining:** None.

---

## 10. Android Correctness

| Source | Status | Notes |
|--------|--------|------|
| driveFolderCache | **FIXED** | ConcurrentHashMap |
| rulePatternCache | **FIXED** | ConcurrentHashMap |
| Audio focus | **DOCUMENTED** | ExoPlayer handleAudioFocus=true; comment in NativePlayerService |
| notificationManager | **FIXED** | Duplicate-add guard; dev warning when listeners > 1 |

**Remaining:** None.

---

## Remaining Potential Heat Sources (Low or Edge Case)

### 1. Sleep timer interval (usePlayback.ts)

- **What:** `setInterval(..., 500)` while sleep timer is active to check `Date.now() >= endsAt`.
- **Impact:** Only when user has set a sleep timer; 2×/sec for the duration.
- **Recommendation:** Leave as-is or optionally increase to 1000 ms. Low impact.

### 2. speechService startSyncLoop (50 ms) — desktop only

- **What:** When using HTML audio (web), `setInterval(..., 50)` for smoothTick.
- **Impact:** N/A on phone (native uses ExoPlayer). On web, 20×/sec.
- **Recommendation:** No change for mobile. Optional: increase to 100 ms on web if needed.

### 3. DesktopPlaybackAdapter state interval (80 ms)

- **What:** While playing on desktop, emit state every 80 ms.
- **Impact:** N/A on phone.
- **Recommendation:** None for mobile.

### 4. Progress flush debounce (1200 ms) and full flush (60 s)

- **What:** When many chapters, one flush can do a lot of SQLite work.
- **Impact:** Already serialized and debounced; 60 s interval limits frequency.
- **Recommendation:** Monitor; if needed, increase flush interval further on native (e.g. 90 s) or cap chapters per flush.

### 5. Job refresh when jobs are active

- **What:** refreshJobs every 2.5 s (local) or 7 s (cloud) when there are active jobs; each run does listAllJobs + syncCloudBackedJobs (one cloud job) + healthCheck + refreshUploadQueueCount.
- **Impact:** Reduced vs original; still some bridge/network every few seconds while jobs run.
- **Recommendation:** Acceptable. Optional: increase to 4 s / 10 s on native if thermal issues persist during long TTS runs.

### 6. Keep Awake + playback together

- **What:** When user turns “Keep screen on” on, screen and CPU stay active during playback.
- **Impact:** Largest single heat contributor when enabled; by design.
- **Recommendation:** Document in Settings that disabling Keep Awake reduces heat; default is already off on native.

### 7. Large books / many chapters

- **What:** First open of a book with 100+ chapters still does 8 concurrent getChapterAudioPath calls per chunk (bounded); reader with many chapters still does highlight updates at throttle rate.
- **Impact:** Bounded; cache helps on re-open.
- **Recommendation:** None unless profiling shows hotspots in very large books.

---

## Checklist: No Obvious Heat Bugs Left

- [x] Playback poll and sync UI throttled on mobile
- [x] Highlight default 250 ms on native
- [x] Keep Awake off by default on native
- [x] Progress throttle and flush interval increased
- [x] AppShell and diagnostics overlay isolated from tick
- [x] Job poll and cloud sync capped; workers backoff and executor/depth fixed
- [x] Upload queue dedup and batch
- [x] Startup batched and GIS onload
- [x] Other timers (diagnostics, seek, regex, downloaded list, auto-save) tuned
- [x] Caches thread-safe; notification listeners guarded

---

## Recommended Follow-Ups (Optional)

1. **Profile on device:** Run a 20–30 min playback session with “Keep Awake” off and measure temperature/battery; repeat with Keep Awake on to confirm screen is the main delta.
2. **Optional UI tweaks:** Batch highlight state in useHighlightSync — **done** (single state object, commented). React.memo on Player / ChapterSidebar / ChapterFolderView — **done** (already present; displayName added). Move tick state to a child provider — **done** (tick lives in tickStore; App does not subscribe; comment in App and PlaybackTickContext).
3. **Optional job tuning:** If heat remains during long TTS/upload runs, increase native job poll to 4 s / 10 s or add a “low power” mode that further relaxes job poll and cloud sync.
4. **OkHttp:** If Drive/TTS workers are still a thermal hotspot, add OkHttp and reuse connections (Section 6 optional).

---

## Conclusion

All high-impact heat sources identified in the original plan have been addressed in Sections 1–10. Remaining items are either desktop-only, low-frequency, user-controlled (Keep Awake), or optional refinements. No further critical overheating bugs were found in the full audit. If the device still runs hot, the next step is on-device profiling (CPU, network, wake locks) during playback and during active jobs to find any platform-specific or device-specific hotspots.
