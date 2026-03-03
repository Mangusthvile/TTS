# Reading progress: rules and functions

Focused reference for the **reading progress** system (per-chapter playback position).  
Storage key: `talevox_progress_store`. On native, SQLite table `chapter_progress` is the durable source of truth.

---

## 1. Rules (semantics and invariants)

### 1.1 Monotonicity (unless reset)

- **progress** (ratio 0–1), **progressSec**, and **progressChars** do not decrease during normal playback.
- They can only go backward when **reason === "reset"** (e.g. “Reset chapter progress” in the UI).
- Scrubs/seeks that move backward use **allowDecrease: true** so the stored position can move back.

### 1.2 Completion

- **isCompleted** becomes `true` when:
  - **Explicit:** `reason === "ended"` | `"scrubToEnd"` | `"seekToNearEnd"` or `completed === true`, or
  - **Implicit:** percent ≥ **COMPLETE_PERCENT_THRESHOLD** (0.995), or
  - **Implicit:** duration ≥ **MIN_DURATION_SECONDS_FOR_COMPLETE** (5s) and remaining time ≤ **COMPLETE_TIME_EPSILON_SECONDS** (0.5s) or ≤ **COMPLETE_REMAINING_SECONDS_THRESHOLD** (2s).
- Once completed, **progress** is set to 1, **progressSec** to duration (if known), **progressChars** to textLength (if known).

### 1.3 Merge rule (when combining two sources)

When picking the “best” of two progress entries for the same chapter (`bestChapterProgress`):

1. **Completed beats incomplete** (completed always wins).
2. **Same completion** → **newer `updatedAt`** wins.
3. **Same timestamp** → **higher percent** wins.

Used when: merging local + SQLite, local + Drive/snapshot, or SQLite + incoming write on native.

### 1.4 Constants (utils/progress.ts)

| Constant                                 | Value | Meaning                                            |
| ---------------------------------------- | ----- | -------------------------------------------------- |
| **COMPLETE_PERCENT_THRESHOLD**           | 0.995 | Percent ≥ this → treat as complete                 |
| **COMPLETE_REMAINING_SECONDS_THRESHOLD** | 2.0   | ≤ this much left → near completion                 |
| **MIN_DURATION_SECONDS_FOR_COMPLETE**    | 5.0   | Shorter chapters don’t use time-epsilon completion |
| **COMPLETE_TIME_EPSILON_SECONDS**        | 0.5   | Within this of end → complete                      |

### 1.5 Commit reasons (utils/progressCommit.ts)

| Reason            | Allow decrease? | Notes                           |
| ----------------- | --------------- | ------------------------------- |
| **tick**          | No              | Normal playback tick            |
| **pause**         | No              | User paused                     |
| **sceneChange**   | No              | Scene/chunk change              |
| **chapterSwitch** | No              | Switched chapter                |
| **scrub**         | Yes             | User scrubbed (can go backward) |
| **scrubToEnd**    | Yes             | Scrubbed to end → complete      |
| **seek**          | Yes             | Seek (e.g. seeked event)        |
| **seekToNearEnd** | Yes             | Seek near end → complete        |
| **ended**         | No              | Playback ended → complete       |
| **reset**         | N/A             | All progress for chapter zeroed |

### 1.6 Storage limits

- **localStorage:** Trimmed to at most **MAX_CHAPTER_PROGRESS_ENTRIES_PER_BOOK** (10_000) entries per book. Trim keeps entries with **most recent `updatedAt`**.
- **SQLite (native):** No per-book limit; all chapter progress rows are kept.
- On native, **writeProgressStore** merges incoming store with SQLite before writing so a stale write never drops a chapter that exists only in SQLite.

---

## 2. Types (shapes)

### 2.1 In-memory / UI (Chapter, progressCommit)

- **Chapter:** `progress` (0–1), `progressChars`, `progressSec`, `durationSec`, `textLength`, `isCompleted`, `updatedAt`.
- **ProgressSnapshot:** `progress`, `progressSec?`, `durationSec?`, `progressChars?`, `textLength?`, `isCompleted?`.
- **ProgressCommitInput:** `current` (ProgressSnapshot), `timeSec`, `durationSec?`, `progressChars?`, `textLength?`, `reason`, `completed?`, `allowDecrease?`.
- **ProgressCommitResult:** `next` (ProgressSnapshot), `changed` (boolean).

### 2.2 Store (progressStore)

- **ProgressStoreEntry:** `timeSec?`, `durationSec?`, `percent?`, `completed?`, `updatedAt?`.
- **ProgressStorePayload:** `{ schemaVersion, books: { [bookId]: { [chapterId]: ProgressStoreEntry } } }`.

---

## 3. Functions

### 3.1 utils/progress.ts (math and thresholds)

| Function                                    | Purpose                                                        |
| ------------------------------------------- | -------------------------------------------------------------- |
| **clamp(value, min, max)**                  | Clamp number to [min, max].                                    |
| **computePercent(timeSec, durationSec?)**   | Percent 0–1 from time; `undefined` if no duration.             |
| **isNearCompletion(timeSec, durationSec?)** | True if percent ≥ 0.995 or remaining ≤ 2s (and duration ≥ 5s). |

### 3.2 utils/progressCommit.ts (compute next state)

| Function                                              | Purpose                                                                                                                                              |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **computeProgressUpdate(input: ProgressCommitInput)** | Returns **ProgressCommitResult**: next snapshot and whether it changed. Enforces monotonicity (unless `allowDecrease`), completion rules, and reset. |

### 3.3 utils/chapterBookUtils.ts (normalize for display)

| Function                                 | Purpose                                                                                                                                    |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **normalizeChapterProgress(c: Chapter)** | Derive `progress` (0–1) and `isCompleted` from `progressSec`/`durationSec` or `progressChars`/`textLength`; clamp; return updated chapter. |

### 3.4 services/progressStore.ts (storage and merge)

| Function                                                                                        | Purpose                                                                                                                                                                                       |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **readProgressStore()**                                                                         | **Sync.** Read current store from localStorage (and legacy keys). Returns **ProgressStorePayload**.                                                                                           |
| **readProgressStoreForSave()**                                                                  | **Async.** On native: merge localStorage + SQLite and return; on web: same as readProgressStore. Use when building snapshot / cloud save.                                                     |
| **writeProgressStore(store)**                                                                   | **Sync.** Write store: web → trimmed to localStorage; native → async merge with SQLite, then write trimmed to localStorage and full merged to SQLite (avoids race that drops latest chapter). |
| **commitProgressLocal({ bookId?, chapterId, timeSec, durationSec?, isComplete?, updatedAt? })** | **Async.** Read store, update one chapter’s entry, call writeProgressStore. Used by speechService (timeupdate, pause, ended, etc.).                                                           |
| **loadProgressLocal(chapterId, bookId?)**                                                       | **Async.** Return **ProgressStoreEntry** for that chapter (resolve book from store if bookId omitted).                                                                                        |
| **upsertSingleChapterProgress(bookId, chapterId, entry)**                                       | **Async.** Native only. Single INSERT OR REPLACE into `chapter_progress`. Used by usePlayback so each tick is durable without full-store write.                                               |
| **flushProgressStoreToDurable()**                                                               | **Async.** Native only. Copy current localStorage store to SQLite (no merge).                                                                                                                 |
| **hydrateProgressFromDurable()**                                                                | **Async.** Native only. Call once at bootstrap: read SQLite, merge with localStorage via **mergeStores**, write merged result to localStorage (no trim at hydrate).                           |
| **mergeStores(local, incoming)**                                                                | Merge two payloads using **bestChapterProgress** per chapter. Returns new **ProgressStorePayload**.                                                                                           |
| **bestChapterProgress(a, b)**                                                                   | Pick better of two **ProgressStoreEntry**: completed > incomplete; else newer updatedAt; else higher percent.                                                                                 |
| **normalizeProgressStore(value)**                                                               | Parse/normalize raw value to **ProgressStorePayload** (handles legacy shapes).                                                                                                                |
| **applyExternalProgress(incoming)**                                                             | Normalize incoming, merge with readProgressStore(), writeProgressStore(merged). Used when applying snapshot/restore.                                                                          |

### 3.5 Internal / not exported (progressStore)

- **trimProgressStorePayload(store)** – Per-book cap to MAX_CHAPTER_PROGRESS_ENTRIES_PER_BOOK by latest `updatedAt`.
- **writeProgressStoreNative(store)** – On native: async merge with SQLite, trim, write localStorage + full merge to SQLite.
- **readChapterProgressDurable()** – Read all rows from `chapter_progress` into ProgressStorePayload.
- **writeChapterProgressDurable(store)** – Write full store to `chapter_progress` (INSERT OR REPLACE per row).
- **ensureChapterProgressTable()** – Create `chapter_progress` table if missing.
- **migrateToChapterProgress()** – One-time migration from kv/store and old progress table into `chapter_progress`.

---

## 4. Who calls what (flow)

- **usePlayback:** On meaningful progress change → `readProgressStore()` → merge current chapter → `writeProgressStore(store)` and **upsertSingleChapterProgress(bookId, chapterId, nextEntry)**.
- **speechService:** On timeupdate / pause / ended / seeked / play → **commitProgressLocal(...)** (throttled 500 ms).
- **Bootstrap / sync:** **hydrateProgressFromDurable()** once; then chapters are merged with store via **mergeProgressEntryIntoChapter** in buildSnapshotState.
- **Save to Drive:** **readProgressStoreForSave()** → include in snapshot and **saveProgressFileToDrive**.
- **Restore / apply snapshot:** **applyExternalProgress(incoming)** or equivalent merge + **writeProgressStore**.
- **Reconcile progress (Settings):** Recompute chapter progress from store and update books; **writeProgressStore** as needed.
- **Reset chapter:** **commitProgressUpdate(..., "reset", ...)** which drives **computeProgressUpdate** with reason `"reset"` and then persistence.

---

## 5. Quick reference: “where do I…?”

| Goal                                                | Use                                                                                                               |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Get full store (sync)                               | **readProgressStore()**                                                                                           |
| Get store for cloud save (include SQLite on native) | **readProgressStoreForSave()**                                                                                    |
| Persist one chapter from playback                   | **writeProgressStore** + **upsertSingleChapterProgress** (usePlayback) or **commitProgressLocal** (speechService) |
| Compute next progress from current + input          | **computeProgressUpdate(input)**                                                                                  |
| Merge two stores (e.g. local + SQLite)              | **mergeStores(local, incoming)**                                                                                  |
| Pick better of two entries for one chapter          | **bestChapterProgress(a, b)**                                                                                     |
| Apply snapshot/restore progress                     | **applyExternalProgress(incoming)**                                                                               |
| Load app: bring SQLite into localStorage            | **hydrateProgressFromDurable()** (once at bootstrap)                                                              |
| Normalize a chapter for display                     | **normalizeChapterProgress(chapter)**                                                                             |
| Percent from time or chars                          | **computePercent(timeSec, durationSec)** or **computePercent(progressChars, textLength)**                         |
