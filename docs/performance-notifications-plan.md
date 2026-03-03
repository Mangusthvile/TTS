# Performance, Speed & Notifications Plan

## Goals

1. **Performance (no degradation over time)** – App should not get slower the longer it runs
2. **Speed** – Jobs run at a reasonable pace (not too fast or too slow)
3. **App chunking** – Split App.tsx for faster loads and better maintainability
4. **Notifications** – More coverage, fewer blank notifications

---

## Part 1: Performance (Avoid Degradation Over Time)

### 1.1 Unbounded Caches & Maps

| Location                                      | Issue                                                                                            | Fix                                                                                                                |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `libraryStore.ts` `chapterTextCache`          | Map grows with every loaded chapter; TTL evicts old entries but no size cap                      | Add max size (e.g. 200 entries), evict LRU when exceeded                                                           |
| `libraryStore.ts` `chapterTextInFlight`       | Deduplicates in-flight requests; entries removed on resolve, but long stalls could leave orphans | Add timeout cleanup for stuck entries (e.g. 60s)                                                                   |
| `App.tsx` `chapterTextCacheRef`               | In-memory cache keyed by `bookId:chapterId`; no limit                                            | Add max size (e.g. 50) and evict LRU; or rely on single source (libraryStore cache)                                |
| `driveChapterFolders.ts` `folderIdCache`      | Grows with each book×volume; no cap                                                              | Add max size (e.g. 100), evict LRU when exceeded                                                                   |
| `GenerateAudioWorker.java` `driveFolderCache` | Already capped at 200 (from prior fix)                                                           | Keep as-is                                                                                                         |
| `audioCache` (IndexedDB)                      | Persistent; grows until user clears                                                              | Add optional size/quota check; document "Clear cache" in Settings; consider LRU eviction when DB exceeds threshold |

### 1.2 Event Listener / Subscription Leaks

| Location                 | Issue                                                                           | Fix                                                                              |
| ------------------------ | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `playbackAdapter.ts`     | `stateListeners`, `itemListeners`, etc. – components may not always unsubscribe | Audit `usePlayback` and any adapters to ensure cleanup in `useEffect` return     |
| `notificationManager.ts` | `listeners` Set – subscribe/unsubscribe pattern                                 | Verify all `subscribeNotice` callers unsubscribe on unmount                      |
| `JobRunner.addListener`  | `jobProgress`, `jobFinished` in App.tsx                                         | Verify `applyJobEvent` listeners removed when App unmounts (or when deps change) |

### 1.3 React Re-renders & Heavy Computations

| Location                 | Issue                                                                          | Fix                                                                              |
| ------------------------ | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `App.tsx`                | Large monolithic component; any state change re-renders everything             | Chunk into lazy-loaded feature modules (see Part 3)                              |
| `loadMoreChapters` merge | `orderChaptersForDisplay(Array.from(byId.values()))` on every page; O(n log n) | Already paginated; consider `useMemo` on derived chapter lists where appropriate |
| `useBookState`           | `volumeSections` and `visibleChapters` derived on every `book.chapters` change | Already memoized; verify deps are stable                                         |

---

## Part 2: Speed (Reasonable Job Pace)

### 2.1 Current Job Speeds

| Job                | Current                                 | Notes                                                      |
| ------------------ | --------------------------------------- | ---------------------------------------------------------- |
| GenerateAudio      | `CHAPTER_BATCH_SIZE=5`; TTS per chapter | Consider 3–5 chapters per batch; add config for batch size |
| DriveUploadWorker  | `processedThisRun < 20` per run         | 20 uploads per WorkManager run; reasonable                 |
| FixIntegrityWorker | Per-chapter operations                  | Depends on Drive/local I/O                                 |

### 2.2 Recommendations

- **GenerateAudioWorker**: Keep batch size 5 or make configurable (3–7); ensure token refresh and heartbeat pacing are adequate
- **DriveUploadWorker**: 20 per run is reasonable; add small delay between uploads (e.g. 200–500 ms) if rate limiting or UX issues occur
- **Vite build**: Ensure code-splitting for routes/features so initial load is fast; lazy-load Settings, Diagnostics, large modals

---

## Part 3: App.tsx Chunking

### 3.1 Current Structure

- `App.tsx` ~4970 lines
- Heavy imports: driveService, libraryStore, saveRestoreService, jobRunnerService, nativeLibraryBridge, etc.
- Many handlers and callbacks inline

### 3.2 Proposed Chunking Strategy

| Chunk                           | Contents                                           | Lazy?                                                        |
| ------------------------------- | -------------------------------------------------- | ------------------------------------------------------------ |
| **AppShell** (existing)         | Layout, tab bar                                    | No                                                           |
| **AppRouter**                   | Route resolution                                   | No                                                           |
| **useAppState** (new hook)      | Core state: books, activeBook, jobs, isDirty, etc. | No                                                           |
| **useAppHandlers** (new hook)   | Handlers: sync, backup, jobs, Drive, attachments   | Lazy or split by domain                                      |
| **Library + ChapterFolderView** | Library tab content                                | Already in `src/features/library`                            |
| **Reader + Player**             | Reader tab content                                 | Already in `src/features/reader`                             |
| **Settings**                    | Settings screen                                    | Lazy: `React.lazy(() => import('./Settings'))`               |
| **Diagnostics**                 | Diagnostics modal/panel                            | Lazy                                                         |
| **Drive / Sync logic**          | performFullDriveSync, restoreFromDrive             | Extract to `useDriveSync.ts`                                 |
| **Job UI**                      | Job list, cancel/retry/force-start                 | Extract to `JobListPanel.tsx` + `useJobActions.ts`           |
| **Attachment handlers**         | onAddAttachment, onDownload, etc.                  | Extract to `useAttachments.ts`                               |
| **Bulk generation UI**          | Bulk audio generation modal logic                  | Extract to `useBulkGeneration.ts` or `BulkGenerateModal.tsx` |

### 3.3 Implementation Order

1. Extract `useDriveSync` – moves ~150 lines
2. Extract `useJobActions` – cancel, retry, delete, forceStart
3. Extract `JobListPanel` / job-related JSX
4. Lazy-load Settings: `const Settings = React.lazy(() => import('./components/Settings'))`
5. Lazy-load Diagnostics panel
6. Extract attachment handlers to `useAttachments`
7. Extract bulk generation modal
8. Split remaining inline handlers into domain hooks

---

## Part 4: Notifications

### 4.1 Blank Notification Root Causes

- **Empty `text`**: Many native notifications pass `""` for `text` (e.g. `buildForegroundInfo(..., "", ...)`)
- **Generic titles only**: e.g. "Generating audio" with no subtitle when `total == 0`
- **Finished notifications**: `showFinishedNotification(jobId, title)` uses `text = ""` – user sees only title
- **Progress edge cases**: When `total == 0`, "Chapter 1 of 0" or empty string can produce odd UX

### 4.2 Native (Android) Notification Improvements

| Worker                             | Current                                                                  | Improvement                                                                                               |
| ---------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| **GenerateAudioWorker**            | Title: "Generating audio"; Text: "Chapter X of Y" or currentChapterId    | Ensure text is never empty: fallback "Preparing…" when total==0; include book/chapter name when available |
| **GenerateAudioWorker** (finished) | Title: "Audio generation complete" / "Audio generation failed"; Text: "" | Add text: "N chapters completed" or error summary                                                         |
| **FixIntegrityWorker**             | Title: "Fixing integrity"; Text: "Step X of Y" or currentChapterId       | Same: never empty text; "Scanning…" when total==0                                                         |
| **FixIntegrityWorker** (finished)  | Title only; Text: ""                                                     | Add: "Integrity check complete" or error message                                                          |
| **DriveUploadWorker**              | Title: "Uploading audio"; Text: "Uploaded X of Y" or "Uploading audio"   | Already has text; ensure "Uploads complete" / "Uploads paused" in finished                                |
| **DriveUploadWorker** (finished)   | "Uploads " + status, message                                             | Ensure message is never null/empty; use "All uploads completed" etc.                                      |

### 4.3 In-App Toast (pushNotice) Coverage

Add or strengthen notifications for:

| Event                   | Current                                                 | Improvement                                                        |
| ----------------------- | ------------------------------------------------------- | ------------------------------------------------------------------ |
| Job queued              | "Background job queued."                                | Add: "Audio generation started for N chapters"                     |
| Job progress (optional) | None                                                    | Consider periodic: "Generating: ch. X of Y" (throttled)            |
| Job completed           | Via jobFinished handler                                 | Ensure pushNotice: "Audio generation complete – N chapters"        |
| Job failed              | "Job failed: {msg}"                                     | Ensure msg is never empty; fallback "Unknown error"                |
| Job canceled            | "Cancel requested."                                     | Add: "Job canceled"                                                |
| Job retried             | None                                                    | Add: "Retrying job"                                                |
| Drive sync start        | "Checking library…" (in launch)                         | Add: "Sync started" when manual sync begins                        |
| Drive sync complete     | "Sync Complete"                                         | Keep; ensure it always fires                                       |
| Drive sync failed       | "Sync Failed: …"                                        | Ensure error message included                                      |
| Token expired           | "Drive session expired…"                                | Keep                                                               |
| Backup started          | None                                                    | Add: "Backup started"                                              |
| Backup complete         | "Backup complete: …"                                    | Keep                                                               |
| Backup failed           | "Backup failed: …"                                      | Keep                                                               |
| Native DB sync          | "Library synced to native DB" / "Native DB sync failed" | Keep                                                               |
| Attachments             | Various                                                 | Ensure every error path has a message                              |
| Integrity check/fix     | Multiple                                                | Ensure CHECK/FIX start, progress, complete, fail all have messages |
| Voice test              | "Voice test failed"                                     | Keep                                                               |
| Cover sync/upload       | Error messages                                          | Keep                                                               |

### 4.4 Notification Message Catalog

Create `services/notificationMessages.ts` (or similar) with:

- Centralized message templates: `NOTIFICATION.JOB_QUEUED`, `NOTIFICATION.JOB_FAILED`, etc.
- Fallbacks for empty strings: `msg || "Operation completed"` / `msg || "An error occurred"`
- Ensure every `pushNotice` and native notification path has a non-empty message

---

## Implementation Order (Recommended)

1. **Notifications (high impact, fixes blank UX)**
   - Add fallback text to all native `buildProgress` / `buildFinished` / `buildForegroundInfo` calls
   - Add missing pushNotice calls for job lifecycle events
   - Centralize message fallbacks

2. **Cache size limits (prevents long-run degradation)**
   - `chapterTextCache` max size + LRU eviction
   - `folderIdCache` max size + LRU eviction
   - `chapterTextCacheRef` in App – cap or remove if redundant

3. **App chunking (maintainability + load time)**
   - Lazy-load Settings and Diagnostics
   - Extract `useDriveSync`, `useJobActions`, `useAttachments`
   - Extract JobListPanel and BulkGenerateModal

4. **Listener cleanup audit**
   - Verify JobRunner listeners, playback listeners, notification subscribers

---

## Files to Modify

### Notifications

- `android/.../GenerateAudioWorker.java` – progress/finished notification text
- `android/.../FixIntegrityWorker.java` – progress/finished notification text
- `android/.../DriveUploadWorker.java` – finished notification text
- `android/.../JobNotificationHelper.java` – optional: default text when empty
- `App.tsx` – add pushNotice for job queued/completed/retried/canceled
- `ChapterFolderView.tsx` – ensure all error/success paths have messages

### Performance

- `services/libraryStore.ts` – chapterTextCache max size
- `services/driveChapterFolders.ts` – folderIdCache max size
- `App.tsx` – chapterTextCacheRef cap or removal

### Chunking

- `App.tsx` – extract hooks, lazy-load components
- New: `src/app/state/useDriveSync.ts`
- New: `src/app/state/useJobActions.ts`
- New: `src/app/state/useAttachments.ts` (or similar)
