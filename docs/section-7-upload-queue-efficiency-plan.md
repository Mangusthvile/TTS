# Section 7 — Upload Queue Efficiency

Reduce wasted work during enqueue and bulk upload: replace full-queue scans for deduplication with keyed lookup, and batch the duplicate check when enqueueing many items so we do one list fetch per batch instead of one per item. No feature removal.

---

## Current behavior

- **uploadQueueStore.enqueueChapterUpload** ([services/uploadQueueStore.ts](services/uploadQueueStore.ts) lines 39–69): Before adding an item, it calls `listQueuedUploads()` (no limit) and runs `existing.some((item) => item.bookId === bookId && item.chapterId === chapterId)`. So **every single enqueue** loads the entire queue from storage and scans it — **O(n)** per enqueue, and n grows with queue size.
- **uploadManager.enqueueUploads** ([services/uploadManager.ts](services/uploadManager.ts) lines 24–40): Loops over `items` and calls `enqueueChapterUpload` for each. So for 100 chapters we do **100 × listQueuedUploads()** (100 full list fetches) plus 100 enqueue writes. No batching of the duplicate check.
- **useUploadQueue** ([src/app/state/useUploadQueue.ts](src/app/state/useUploadQueue.ts)): After each single-chapter action it calls `refreshUploadQueueCount()` and `refreshUploadQueueList()` (lines 65–66, 80–81, 146–147). For "Upload all chapters" it only refreshes once at the end (124–125), which is fine. The main cost is the N list fetches inside `enqueueUploads` when enqueueing N items.
- **Storage:** [sqliteStorageDriver.ts](services/sqliteStorageDriver.ts) has no `hasQueuedUpload(bookId, chapterId)`; it does have `enqueueUpload` with `ON CONFLICT(chapterId) DO UPDATE`, so SQLite can upsert by chapterId, but the **store** still does a full list to decide whether to skip. Memory and localStorage drivers also have no keyed existence check.

---

## 1. Keyed lookup for deduplication (hasQueuedUpload)

**Goal:** Avoid loading the full queue on every enqueue when we only need to know "is (bookId, chapterId) already queued?".

- **Storage driver:** Add an **optional** method `hasQueuedUpload?(bookId: string, chapterId: string): Promise<LoadResult<boolean>>` to the driver interface. Implement it where cheap:
  - **SQLite** ([services/sqliteStorageDriver.ts](services/sqliteStorageDriver.ts)): Run `SELECT 1 FROM drive_upload_queue WHERE bookId = ? AND chapterId = ? AND status IN ('queued', 'failed') LIMIT 1` and return true if any row. Single indexed lookup (add an index on (bookId, chapterId) if not already present for list ordering; otherwise the query is still one scan of the queue table but no large result set).
  - **Memory / LocalStorage:** Implement by iterating the in-memory queue (or loading it once) and checking for matching bookId+chapterId. Still O(n) but avoids returning a full list to the caller; alternatively leave unimplemented and fall back to store-level listQueuedUploads().some() for those drivers.
- **uploadQueueStore.enqueueChapterUpload** ([services/uploadQueueStore.ts](services/uploadQueueStore.ts)): If the storage driver exposes `hasQueuedUpload`, call it instead of `listQueuedUploads()`. If the driver doesn’t have it (or returns false from a type guard), keep the current `listQueuedUploads().some(...)` fallback so all drivers still work.
- **Result:** Single enqueues (e.g. "Upload this chapter") do one lightweight existence check instead of loading and scanning the full queue. Bulk enqueues still benefit from step 2.

**Files:** [services/storageDriver.ts](services/storageDriver.ts) (optional method in interface / type), [services/sqliteStorageDriver.ts](services/sqliteStorageDriver.ts), [services/uploadQueueStore.ts](services/uploadQueueStore.ts). Optionally [services/storageDriver.ts](services/storageDriver.ts) Memory and SafeLocalStorageDriver if we add a simple hasQueuedUpload there.

---

## 2. Batch duplicate check in enqueueUploads

**Goal:** When enqueueing N items, do **one** list fetch, compute the set of existing (bookId, chapterId), then enqueue only items not in that set. No per-item full list.

- **uploadManager.enqueueUploads** ([services/uploadManager.ts](services/uploadManager.ts)):
  - At the start, call `listQueuedUploads()` **once**.
  - Build a `Set<string>` of existing keys, e.g. `existingKeys = new Set(existing.map(i => `${i.bookId}:${i.chapterId}`))`.
  - For each item in `items`, if `${item.bookId}:${item.chapterId}` is in `existingKeys`, skip (treat as already queued, no-op).
  - Otherwise call `enqueueChapterUpload(...)` and add the key to `existingKeys` so we don’t double-enqueue the same chapter in the same batch.
  - Continue to call `enqueueUpload` / `enqueueChapterUpload` for new items so the rest of the flow (notifyUpload, autoStart, etc.) is unchanged.
- **Result:** Enqueueing 100 chapters does 1 list + up to 100 enqueue writes (and 100 hasQueuedUpload calls inside enqueueChapterUpload unless we add a "skip check" path). To avoid 100 hasQueuedUpload calls when we already know the item isn’t in the initial set, we can either:
  - **Option A:** Have `enqueueChapterUpload` accept an optional `skipDuplicateCheck?: boolean`; when true (caller guarantees not duplicate), skip the hasQueuedUpload/list check and go straight to `enqueueUpload`. Then enqueueUploads passes skipDuplicateCheck: true for items not in existingKeys.
  - **Option B:** Keep enqueueChapterUpload as-is; then each of the 100 enqueues does one hasQueuedUpload (SQLite: cheap; memory/localStorage: still O(n) per call unless we added hasQueuedUpload that iterates without building a full list). So after step 1 we only have 1 full list in enqueueUploads + N hasQueuedUpload. Option A is cleaner for bulk: one list, then N direct enqueueUpload calls for new items (no second lookup).
- **Recommendation:** Implement **Option A**: add optional `skipDuplicateCheck` to `enqueueChapterUpload`. In `enqueueUploads`, after building `existingKeys`, for each item not in the set call `enqueueChapterUpload(..., { skipDuplicateCheck: true })` so we don’t call hasQueuedUpload again for that item.

**Files:** [services/uploadQueueStore.ts](services/uploadQueueStore.ts) (add optional param to enqueueChapterUpload), [services/uploadManager.ts](services/uploadManager.ts).

---

## 3. Optional: index for (bookId, chapterId) in SQLite

**Goal:** Make `hasQueuedUpload` and list-by-priority queries fast on large queues.

- **sqliteStorageDriver:** Ensure there is an index on `drive_upload_queue(bookId, chapterId)` (or at least `chapterId` if uniqueness is by chapterId). If the table is only ever small, skip; if we expect hundreds of queued items, add `CREATE INDEX IF NOT EXISTS idx_upload_queue_book_chapter ON drive_upload_queue(bookId, chapterId);` in the schema so the EXISTS query and any filters are cheap.
- **Result:** Faster hasQueuedUpload and less full-table scan when checking existence.

**Files:** [services/sqliteStorageDriver.ts](services/sqliteStorageDriver.ts) (schema or migration).

---

## Implementation order

| Step | Task | File(s) |
|------|------|--------|
| 1 | Add optional `hasQueuedUpload(bookId, chapterId)`; implement in SQLite (and optionally Memory/LocalStorage) | [storageDriver.ts](services/storageDriver.ts), [sqliteStorageDriver.ts](services/sqliteStorageDriver.ts) |
| 2 | In enqueueChapterUpload, use hasQueuedUpload when available, else listQueuedUploads().some() | [uploadQueueStore.ts](services/uploadQueueStore.ts) |
| 3 | In enqueueUploads, list once, build existingKeys Set, call enqueueChapterUpload only for new items; add skipDuplicateCheck to enqueueChapterUpload and pass true from enqueueUploads | [uploadQueueStore.ts](services/uploadQueueStore.ts), [uploadManager.ts](services/uploadManager.ts) |
| 4 | (Optional) Add index on drive_upload_queue(bookId, chapterId) in SQLite schema | [sqliteStorageDriver.ts](services/sqliteStorageDriver.ts) |

---

## Verification

- **Single enqueue:** "Upload this chapter" / one call to enqueueChapterUpload still dedupes; no duplicate rows for same bookId+chapterId; storage that implements hasQueuedUpload does not load full list.
- **Bulk enqueue:** "Upload all" or enqueueUploads([...100 items]) does one listQueuedUploads() at start; only items not already in queue are enqueued; count and notifications correct.
- **Drivers:** SQLite uses hasQueuedUpload; Memory/LocalStorage either implement it or fall back to listQueuedUploads().some(); no regression on web or native.
- **No feature removal:** All enqueue behavior and UI unchanged; only internal efficiency of duplicate checks and list fetches changes.

---

## Summary

- **Dedup lookup:** Add optional `hasQueuedUpload(bookId, chapterId)`; use it in enqueueChapterUpload instead of loading the full queue for every enqueue. SQLite implements with a single SELECT EXISTS.
- **Bulk enqueue:** In enqueueUploads, list the queue once, build a set of existing (bookId, chapterId), and only call enqueueChapterUpload for items not in the set; support skipDuplicateCheck so we don’t re-check inside enqueueChapterUpload when the caller already did.
- **Optional:** Index on (bookId, chapterId) for the upload queue table in SQLite for large queues.

No features removed; only duplicate-check and list-fetch behavior are made more efficient.
