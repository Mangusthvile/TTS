# Progress system overview

Everything in the app that uses the word "progress" and how it fits together.

---

## 1. Reading progress (per-chapter playback position)

**What it is:** Where the user is in each chapter (time, percent, completed).

### Types and shapes

| Where                    | Type / key                                                                                                   | Purpose                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| **types.ts**             | `Chapter.progress`, `.progressChars`, `.progressSec`, `.durationSec`, `.progressTotalLength`, `.isCompleted` | In-memory chapter: ratio 0–1, char offset, time in sec, completion                                          |
| **storageDriver.ts**     | `ChapterProgress`                                                                                            | Storage driver shape: `chapterId`, `timeSec`, `durationSec`, `percent`, `isComplete`, `updatedAt`           |
| **progressStore.ts**     | `ProgressStoreEntry`                                                                                         | One chapter in the store: `timeSec`, `durationSec`, `percent`, `completed`, `updatedAt`                     |
| **progressStore.ts**     | `ProgressStorePayload`                                                                                       | Full store: `{ schemaVersion, books: { [bookId]: { [chapterId]: ProgressStoreEntry } } }`                   |
| **useReaderProgress.ts** | `ChapterProgress`, `ProgressMap`                                                                             | Reader hook: `chapterId`, `index`, `total`, `percent`, `isCompleted`, `updatedAt`, `timeSec`, `durationSec` |
| **progressCommit.ts**    | `ProgressSnapshot`, `ProgressCommitInput`, `ProgressCommitResult`                                            | Commit semantics: current vs next progress, reason, allowDecrease                                           |

### Storage (where it’s persisted)

| Layer                                     | Key / table                                                                     | Used by                                                                        |
| ----------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| **speechService.ts**                      | `PROGRESS_STORE_KEY = 'talevox_progress_store'`                                 | progressStore (localStorage key)                                               |
| **speechService.ts**                      | `PROGRESS_STORE_LEGACY_KEYS` (`talevox_progress_v4`, v3, v2, v1)                | Migration from old keys                                                        |
| **progressStore.ts**                      | localStorage: above key; native: SQLite `chapter_progress`                      | Main reading-progress persistence                                              |
| **progressStore.ts**                      | `readProgressStore()`, `writeProgressStore()`, `readProgressStoreForSave()`     | Sync read; write (with native merge); save/snapshot read                       |
| **progressStore.ts**                      | `commitProgressLocal()`, `loadProgressLocal()`, `upsertSingleChapterProgress()` | Single-chapter commit; load one chapter; native single-row SQLite upsert       |
| **progressStore.ts**                      | `flushProgressStoreToDurable()`, `hydrateProgressFromDurable()`                 | Copy localStorage → SQLite; bootstrap: SQLite → localStorage (merge)           |
| **useReaderProgress.ts**                  | `talevox_reader_progress` (localStorage)                                        | Legacy reader progress map (chapterId → progress); still used for some UI/sync |
| **storageDriver.ts** (LocalStorageDriver) | `talevox_progress:{chapterId}`                                                  | Per-chapter key; used when storage driver is localStorage                      |
| **sqliteStorageDriver.ts**                | `chapter_progress` table                                                        | Native: `loadChapterProgress(chapterId)`, `saveChapterProgress(progress)`      |

### Flow (who writes reading progress)

1. **usePlayback.ts**  
   On playback tick / chapter change: `readProgressStore()` → merge current chapter → `writeProgressStore(...)` and `upsertSingleChapterProgress(bookId, chapterId, nextEntry)`.

2. **speechService.ts**  
   Audio events (timeupdate, pause, ended, seeked, play): `commitLocalProgress(...)` → `commitProgressLocal({ bookId, chapterId, timeSec, durationSec, isComplete })` (throttled 500 ms).

3. **progressStore.ts**
   - **Web:** `writeProgressStore(store)` trims and writes to localStorage only.
   - **Native:** `writeProgressStoreNative(store)` merges with `readChapterProgressDurable()`, then writes trimmed merge to localStorage and full merge to SQLite (avoids race that dropped latest chapter).

4. **App.tsx**
   - Pause / background: `speechController.forceFlushProgressForBackground()`, then rebuild `ProgressMap` from state and `writeProgressStore(...)`, then `flushProgressStoreToDurable()`.
   - Periodic: interval `flushProgressStoreToDurable()` so a hard kill doesn’t lose progress.
   - Reconcile: `handleReconcileProgress` normalizes chapter progress and writes back.
   - Reset: `handleResetChapterProgress` → `commitProgressUpdate(..., "reset", ...)`.

### Flow (who reads reading progress)

1. **Bootstrap (useAppBootstrap / sync)**  
   `hydrateProgressFromDurable()` once; then chapters are merged with progress via `mergeProgressEntryIntoChapter(chapter, progressByChapter[chapter.id])` in `buildSnapshotState` and sync.

2. **Save to Drive**  
   `readProgressStoreForSave()` (on native: merge localStorage + SQLite) → `progressStorePayload` → snapshot and `saveProgressFileToDrive(..., progressStorePayload)`.

3. **Sync from Drive**  
   `loadProgressFileFromDrive()` → `progressData.readerProgress` / `legacyProgressStore` → `writeProgressStore(normalized)` or merge into books; then `readProgressStore()` and apply to books for UI.

4. **UI**  
   `readerProgressMap` (from books’ `progress` / `progressChars` / `progressSec`), `persistReaderProgress`, `applyReaderProgressCommit`; `useReaderProgress` with `externalProgress: readerProgressMap` and `persist: persistReaderProgress`.

### Utilities

| File                          | Exports                                                                   | Purpose                                                                             |
| ----------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| **utils/progress.ts**         | `computePercent`, `clamp`, `isNearCompletion`, `COMPLETE_*` constants     | Percent from time/char, completion thresholds                                       |
| **utils/progressCommit.ts**   | `computeProgressUpdate`, `ProgressCommitReason`, `ProgressSnapshot`, etc. | Monotonic progress + completion rules for commits                                   |
| **utils/chapterBookUtils.ts** | `normalizeChapterProgress(chapter)`                                       | Derive `progress` and `isCompleted` from `progressSec`/`progressChars`/`textLength` |

---

## 2. Reader progress (legacy / alternate map)

**What it is:** A separate map keyed by chapter ID used by the reader hook and stored in `talevox_reader_progress`.

- **useReaderProgress.ts:** Builds/loads/saves `ProgressMap` (chapterId → `ChapterProgress`: index, total, percent, etc.).
- **App.tsx:** `readerProgress` in snapshot = `localStorage.getItem("talevox_reader_progress")`; saved/restored in full snapshot and in `saveProgressFileToDrive` / `loadProgressFileFromDrive`.
- Used as `externalProgress` and `persist` for `useReaderProgress` and for sync/backup; merged with chapter-based progress where snapshots are applied.

---

## 3. Job progress (background jobs)

**What it is:** Progress of background jobs (e.g. audio generation, fix-integrity, upload queue): total, completed, currentChapterId, etc.

| Where                                                       | Type / field                                                                      | Purpose                                                                                       |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| **types.ts**                                                | `JobProgress`                                                                     | `total`, `completed`, `currentChapterId`, `currentChunkIndex`, `startedAt`, `lastError`, etc. |
| **types.ts**                                                | `JobRecord.progressJson`                                                          | Stored job progress                                                                           |
| **sqliteStorageDriver.ts**                                  | `progressJson` column on jobs table                                               | Persist/load job progress                                                                     |
| **Android (FixIntegrityWorker, GenerateAudioWorker, etc.)** | `progressJson`, `updateJobProgress`, `emitProgress`                               | Update and emit job progress to JS                                                            |
| **App.tsx**                                                 | `event.progress` / `event.progressJson`, `progress?.completed`, `progress?.total` | Job events and UI                                                                             |
| **JobListPanel, useJobs**                                   | Job list and progress display                                                     | UI for running jobs                                                                           |

This is unrelated to reading position; it’s “how far the job has run”.

---

## 4. Backup progress

**What it is:** Step-by-step status of backup/restore (collecting, zipping, saving, etc.).

| Where                        | Type / field                           | Purpose                                            |
| ---------------------------- | -------------------------------------- | -------------------------------------------------- |
| **types.ts**                 | `BackupProgress`, `BackupProgressStep` | `step`, `message`, `current`, `total`              |
| **types.ts**                 | `AppState.backupInProgress`            | Whether a backup is running                        |
| **App.tsx**                  | `backupProgress`, `backupInProgress`   | Passed to Settings/UI; “Backup in progress” notice |
| **useBackup, backupService** | Backup state and steps                 | Drive/local backup and restore                     |

---

## 5. Snapshot / Drive progress file

**What it is:** Progress data stored in the cloud (Drive) and in full snapshots.

| Where                     | Key / field                                                                     | Purpose                                                    |
| ------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| **saveRestoreService.ts** | `PROGRESS_FILE_NAME = "talevox_progress.json"`                                  | File name on Drive                                         |
| **saveRestoreService.ts** | `ProgressFilePayload`: `readerProgress`, `legacyProgressStore`, `progressStore` | Shape of progress file                                     |
| **saveRestoreService.ts** | `loadProgressFileFromDrive`, `saveProgressFileToDrive`                          | Load/save progress file on Drive                           |
| **saveRestoreService.ts** | `normaliseProgressFile`, `normaliseSnapshotProgress`                            | Prefer `progressStore`, fall back to `legacyProgressStore` |
| **fullSnapshot.ts**       | `readerProgress`, `legacyProgressStore` in snapshot                             | Part of full snapshot for backup/restore                   |
| **types.ts**              | `FullSnapshotV1.readerProgress`, `.legacyProgressStore`                         | Snapshot type                                              |

On restore/sync, this progress is applied via `writeProgressStore` / `applyExternalProgress` and by merging into books so the UI shows the right progress.

---

## 5. Diagnostics / UI labels

- **App.tsx:** `progressChars`, `progress` (e.g. player), `onResetChapterProgress`, `onRecalculateProgress` (reconcile), `handleReconcileProgress`, “Progress already consistent”.
- **ChapterFolderView, Settings, etc.:** Scan progress, job progress in UI only (no extra storage).

---

## 6. Constants and keys (quick reference)

| Constant                                | Value                         | File                                       |
| --------------------------------------- | ----------------------------- | ------------------------------------------ |
| `PROGRESS_STORE_KEY`                    | `'talevox_progress_store'`    | speechService.ts                           |
| `PROGRESS_STORE_LEGACY_KEYS`            | `talevox_progress_v4` … v1    | speechService.ts                           |
| `talevox_reader_progress`               | Reader progress map           | useReaderProgress, App, saveRestoreService |
| `talevox_progress.json`                 | Progress file on Drive        | saveRestoreService.ts                      |
| `chapter_progress`                      | SQLite table (native)         | progressStore, sqliteStorageDriver         |
| `MAX_CHAPTER_PROGRESS_ENTRIES_PER_BOOK` | 10000 (localStorage trim cap) | progressStore.ts                           |

---

## 7. Data flow summary

```
Playback (usePlayback + speechService)
  → commitProgressLocal / writeProgressStore + upsertSingleChapterProgress
  → progressStore (localStorage + native SQLite chapter_progress)

Bootstrap / sync from Drive
  → hydrateProgressFromDurable (SQLite → localStorage)
  → loadProgressFileFromDrive → writeProgressStore / apply to books

Save to Drive
  → readProgressStoreForSave() (localStorage + SQLite on native)
  → progressStorePayload → snapshot + saveProgressFileToDrive

UI
  → readProgressStore / books with progress merged
  → readerProgressMap, useReaderProgress, mergeProgressEntryIntoChapter
```

All “progress” in the app is either (1) reading position per chapter, (2) reader progress map, (3) job progress, (4) snapshot/Drive progress file; the reading position and reader map are the ones that interact heavily with `progressStore`, SQLite, and Drive.
