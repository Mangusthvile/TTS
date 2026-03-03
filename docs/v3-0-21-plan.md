# TaleVox 3.0.21 – Optimized Implementation Plan

> Grounded in actual code audit of the current codebase (Feb 2026).
> Each fix section names the exact file, line, and change required.

---

## 0. Release Housekeeping

- **`package.json`**: bump version `3.0.20` → `3.0.21`
- **`CHANGELOG.md`**: prepend `## 3.0.21` section with the six fix summaries below

---

## 1. Background Progress Not Saving (Issue 1)

### Root cause (confirmed by code audit)

`App.tsx` line 325–337 already has a `CapacitorApp.addListener('appStateChange', ...)` hook.
When the app is backgrounded (`!isActive`) it calls:

```
void flushProgressStoreToDurable().catch(() => {});
```

**Missing**: it does NOT call `commitProgressUpdate` first.
If audio has been ticking for 30 seconds since the last save, those 30 seconds are lost before the flush.

The `visibilitychange` handler in `usePlayback.ts` (lines 483–502) DOES call `commitProgressUpdate` + `flushProgressStoreToDurable`, but on Android native the WebView visibilitychange is unreliable when the app goes into the background while audio is running in the native player.

A second gap: when the user returns to the foreground, `speechController.emitSyncTick()` fires but does not query the native player for its current position. If the native player advanced significantly during background play, the JS state has no way to pick that up.

### Changes

**File: `App.tsx` — `appStateChange` listener (~line 327)**

The listener has access to `stateRef`. Extend it:

```typescript
const listener = CapacitorApp.addListener("appStateChange", ({ isActive }) => {
  if (!isActive) {
    // NEW: commit current in-flight progress before flush
    const s = stateRef.current;
    if (s.activeBookId && s.books) {
      const b = s.books.find((bk) => bk.id === s.activeBookId);
      if (b) {
        const meta = speechController.getMetadata();
        const chapterId = meta.chapterId ?? b.currentChapterId;
        if (chapterId) {
          commitProgressUpdate(b.id, chapterId, meta, "pause", false, true);
        }
      }
    }
    // existing flush
    void flushProgressStoreToDurable().catch(() => {});
    void Preferences.set({ key: LAST_ACTIVE_BOOK_ID_KEY, value: s.activeBookId ?? "" }).catch(
      () => {}
    );
  }
  // NEW: on foreground return, re-sync from native player position
  if (isActive) {
    speechController.emitSyncTick();
    // Brief delay to let native adapter report current position
    setTimeout(() => speechController.emitSyncTick(), 500);
  }
});
```

Note: `commitProgressUpdate` is defined in `usePlayback` and is not directly accessible in `App.tsx`'s top-level effect. Two options:

- **Option A (simplest)**: Move the `appStateChange` listener into `usePlayback.ts` (alongside the existing `visibilitychange` listener), where `commitProgressUpdate` is already in scope. Both handlers live in the same hook.
- **Option B**: Expose a `onAppBackground` callback from `usePlayback` and call it from the `App.tsx` listener.

**Recommended: Option A** — move the `appStateChange` listener (currently in `App.tsx` ~line 325) into `usePlayback.ts` next to the existing `visibilitychange` effect (~line 482). Then remove it from `App.tsx` (but keep the `LAST_ACTIVE_BOOK_ID_KEY` Preferences save and `flushProgressStoreToDurable` call in `App.tsx` as a secondary safety net).

**File: `usePlayback.ts` — after the `visibilitychange` useEffect (~line 502)**

Add a new `useEffect`:

```typescript
useEffect(() => {
  if (!Capacitor.isNativePlatform()) return;
  const listenerPromise = CapacitorApp.addListener("appStateChange", ({ isActive }) => {
    if (!isActive) {
      const s = stateRef.current;
      if (s.activeBookId && s.books) {
        const b = s.books.find((bk) => bk.id === s.activeBookId);
        if (b) {
          const meta = speechController.getMetadata();
          const chapterId = meta.chapterId ?? b.currentChapterId;
          if (chapterId) {
            commitProgressUpdate(b.id, chapterId, meta, "pause", false, true);
          }
        }
      }
      void flushProgressStoreToDurable({ immediate: true }).catch(() => {});
    } else {
      // Re-sync after returning from background
      setTimeout(() => speechController.emitSyncTick(), 300);
    }
  });
  return () => {
    void listenerPromise.then((l) => l.remove());
  };
}, [commitProgressUpdate, stateRef]);
```

---

## 2. Progress Display Not Reflecting Stored Progress (Issue 4)

### Root cause (confirmed by code audit)

`useAppBootstrap.ts` hydrates chapters with progress at startup (lines 136–152). After that, each call to `writeProgressStore` (called on every tick) updates the in-memory progressStore but does **not** push updated `progress`/`progressSec`/`isCompleted` back into `state.books[].chapters[]`.

The chapter list (`ChapterFolderView`, `BookGrid`) reads `chapter.progress` from `state.books[].chapters[]`, which is stale after startup. Meanwhile the progressStore has the live data. This is why resuming works (it reads from progressStore directly) but the progress bar shows 0%.

### Changes

**File: `App.tsx` — add a progressStore subscriber that keeps chapter progress fields in sync**

After `writeProgressStore` is called (on every tick via `commitProgressUpdate`), the corresponding chapter in `state.books` needs its `progress`, `progressSec`, and `isCompleted` fields updated.

The cleanest place to do this is in `commitProgressUpdate` (in `usePlayback.ts`) after `writeProgressStore` is called — add a callback/state update that patches the chapter in `state`.

Concrete approach: expose an `onProgressUpdate` callback prop from `usePlayback` (or add it to `stateRef.current` callbacks), and in `App.tsx` wire it to:

```typescript
const handleProgressUpdate = useCallback(
  (bookId: string, chapterId: string, entry: ProgressStoreEntry) => {
    setState((prev) => ({
      ...prev,
      books: prev.books.map((b) =>
        b.id !== bookId
          ? b
          : {
              ...b,
              chapters: b.chapters.map((c) =>
                c.id !== chapterId
                  ? c
                  : {
                      ...c,
                      progress: entry.percent ?? c.progress,
                      progressSec: entry.timeSec ?? c.progressSec,
                      isCompleted: entry.completed ?? c.isCompleted,
                    }
              ),
            }
      ),
    }));
  },
  []
);
```

Alternatively (simpler): In `commitProgressUpdate` in `usePlayback.ts`, after calling `writeProgressStore`, call `stateRef.current.onProgressUpdate?.(bookId, chapterId, entry)` if a callback is registered.

**Alternative (even simpler)**: In `ChapterFolderView` and `BookGrid`, read progress directly from `readProgressStore()` for each chapter rather than from `chapter.progress`. This avoids any wiring changes. Use a `useMemo` or `useEffect` that reads from progressStore when the component mounts/updates.

**Recommended approach**: Add a lightweight `useEffect` in `ChapterFolderView` that reads from `readProgressStore()` on mount and whenever the book changes, merging results into local state for display. This keeps changes isolated to the component and avoids threading callbacks through multiple layers.

---

## 3. Chapter Reset Not Working (Issue 6)

### Root cause (confirmed by code audit)

`handleResetChapterProgress` in `App.tsx` (line 2320–2323):

```typescript
const handleResetChapterProgress = (bid: string, cid: string) => {
  commitProgressUpdate(
    bid,
    cid,
    { currentTime: 0, duration: 0, charOffset: 0, completed: false },
    "reset",
    true,
    true,
    true
  );
  pushNotice({ message: "Reset", type: "info", ms: 1000 });
};
```

The 7th arg is `forceReset: true`, which correctly bypasses `shouldSkipProgressWrite`'s monotonicity guard (line 338: `if (forceReset) return false`). The DB write should succeed.

The likely root cause is **display** (same as Issue 4): the chapter card still shows the old progress because `state.books[].chapters[].progress` is not updated. The user sees the bar unchanged and concludes "reset didn't work."

A secondary possibility: if the chapter is actively playing and producing ticks, a tick immediately after reset overwrites the reset (since `currentTime` from the adapter may still be > 10s if the audio seeks slowly). The reset races with the next tick.

### Changes

**Display fix**: implementing Issue 4's fix (propagating progressStore writes back into chapter state) will also fix the visual side of Issue 6.

**Race condition fix** (in `commitProgressUpdate`, `usePlayback.ts`): When `reason === 'reset'`, after writing progress, call `speechController.safeStop()` or seek to 0 so subsequent ticks start from 0, not from a stale audio position.

**Additional safety**: In `usePlayback.ts`, after a reset reason, also call `resetProgress` on `useReaderProgress` to clear its local `progressByChapter` map for that chapter. Currently the local ProgressMap and progressStore can diverge post-reset.

---

## 4. Attachments Folder Structure (Issue 2)

### Root cause (confirmed by code audit)

**Local**: `attachmentsService.ts` already stores per-book: `talevox/attachments/{bookId}/{filename}`. This path is under `Directory.Data` → `talevox/attachments/`. It is NOT co-located with the book's content folder.

The user's expectation: `talevox/<bookId>/attachments/<filename>` (or at minimum, visually under the book in Drive).

**Drive**: No `attachments` subfolder is created under the book's Drive folder. Uploads likely land at a global location.

### Changes

**`attachmentsService.ts`** — change `BASE_DIR`:

```typescript
// Before:
const BASE_DIR = appConfig.paths.attachmentsDir; // "talevox/attachments"

// After: attachments live under the book's data folder
// buildAttachmentPath becomes:
function buildAttachmentPath(bookId: string, filename: string): string {
  return `talevox/${bookId}/attachments/${filename}`;
}
// ensureAttachmentsDir path becomes:
const path = `talevox/${bookId}/attachments`;
```

> **Migration**: Existing attachments at the old path (`talevox/attachments/{bookId}/`) won't auto-move. In `ensureAttachmentsDir`, add a one-time migration check that looks for the old path and copies files to the new path if found. Or handle this lazily in `resolveAttachmentUri` by falling back to the old path if the new one doesn't exist.

**Drive**: In `driveChapterFolders.ts` (or `driveService.ts`), when saving an attachment for a Drive-backed book:

1. Call `ensureBookFolder(bookId)` to get/create the book's Drive folder.
2. Call `ensureRootStructure` or `createDriveFolder` to create an `attachments` subfolder under the book folder (use name `"attachments"`).
3. Upload the attachment file to that subfolder instead of the root Books folder.
4. Store the `driveParentFolderId` of the attachments folder in the `BookAttachment` record.

**`appConfig.ts`**: The `attachmentsDir` config key becomes unused (paths now computed inline). Either remove it or keep it as a fallback for the migration path.

---

## 5. Playback Speed Not Persisting (Issue 3)

### Root cause (confirmed by code audit)

`state.playbackSpeed` IS saved to `localStorage` via `prefsJson` (line 4135) and IS read back at startup (line 370: `playbackSpeed: parsed.playbackSpeed || 1.0`).

The missing piece: **the adapter is never initialized with the stored speed**. On startup:

- `state.playbackSpeed` = 1.5 (from localStorage) ✓
- `speechController.requestedSpeed` = 1.0 (default, never set on startup) ✗
- `speechController.adapter.playbackRate` = 1.0 ✗

When the user presses play, `handleManualPlay` (line 1306) calls `speechController.setPlaybackRate(effectiveSpeed)` where `effectiveSpeed = stateRef.current.playbackSpeed` = 1.5. So **manual play should work at the right speed** — but only after the user taps play.

If the issue occurs with auto-resume or background playback starting before a manual tap, `speechController.requestedSpeed` is still 1.0 at that point.

### Changes

**`usePlayback.ts`** — on mount, apply initial speed to adapter:

```typescript
// Near the top of the hook, add a one-time effect:
useEffect(() => {
  const initialSpeed = stateRef.current.playbackSpeed;
  if (initialSpeed && initialSpeed !== 1) {
    speechController.setPlaybackRate(initialSpeed);
  }
}, []); // empty deps — run once on mount
```

**`App.tsx`** — also call when `getEffectivePlaybackSpeed` changes on session load:

In `useAppBootstrap.ts` or the early bootstrap effect in `App.tsx`, after state is initialized:

```typescript
// After bootstrapCore completes:
const initialSpeed = stateRef.current.playbackSpeed;
speechController.setPlaybackRate(initialSpeed);
```

This ensures the adapter is in the right state before any playback starts, including background auto-resume.

---

## 6. Play Button / Highlight Desync (Issue 5)

### Root cause (confirmed by code audit)

`MobilePlaybackAdapter` polls native state every 2000ms (line 356). System media control actions (play/pause from notification shade) change native player state immediately, but the JS adapter only learns about it on the next 2s poll cycle.

More critically: `isPlaying` in `usePlayback` is set by `setIsPlaying(true/false)` at specific code paths (manual play, auto-advance, etc.) and may not be updated when the system changes playback state. If the adapter polls and finds `isPlaying=false` (native paused) but the React state still has `isPlaying=true`, the UI stays in "playing" state.

The user's workaround (press pause in media notification → resets state) works because it triggers a state sync event that eventually propagates.

### Changes

**`playbackAdapter.ts` — `MobilePlaybackAdapter`**: Verify that the `onState` callback fires whenever `isPlaying` changes in the poll result. Currently the poll likely only calls `onState` if `state.isPlaying` changed. Confirm this check exists:

```typescript
// In the poll loop, after getting native state:
if (
  nativeState.isPlaying !== this.state.isPlaying ||
  nativeState.currentItemId !== this.state.currentItemId
) {
  this.state = { ...this.state, ...nativeState };
  this.onStateListeners.forEach((cb) => cb(this.state));
}
```

If the adapter does NOT have this check and calls `onState` unconditionally, add the diff check to avoid unnecessary re-renders, and confirm it fires when state actually changes.

**`usePlayback.ts`** — `handleSyncUpdate` (the `onState` listener from the adapter): Confirm that when `isPlaying` comes from the adapter as `false`, `setIsPlaying(false)` is called and `playbackPhase` is updated to `'IDLE'` or similar (not left as `'PLAYING_BODY'`).

Key check: in `handleSyncUpdate`, if `PlaybackState.isPlaying === false` arrives while React state `isPlaying === true`, does the code update React state? Trace the exact code path and fix any conditional that skips the update.

**Reduce poll latency for system control responsiveness**: Consider reducing the poll interval from 2000ms to 750ms specifically for the window after a play/pause event (when sync is most critical). Or better: ensure the native plugin fires a push event (not poll) when system media controls change state, and make the adapter handle that event.

---

## 7. Default Voice Picker Stacking (Issue 7)

### Root cause (confirmed by code audit)

`BookTopBar.tsx` overflow menu renders at `z-[60]` (line 97). When `onOpenSettingsFromMenu` opens the Book Options/Settings panel, that panel is likely a sheet or modal rendered at a lower z-index. Inside that settings panel, the default voice picker renders inline, competing with the overflow dropdown rather than stacking above it.

The overflow menu is not closed before the settings panel opens (no `onToggleOverflow()` call in `onOpenSettingsFromMenu`).

### Changes

**`App.tsx` — `onOpenSettingsFromMenu` handler (wherever it sets `showSettings = true` or similar)**:

Close the overflow menu before opening settings:

```typescript
const handleOpenSettingsFromMenu = useCallback(() => {
  setShowOverflow(false); // close the overflow dropdown first
  setShowBookSettings(true);
}, []);
```

This already prevents the overlap issue since the overflow is gone before settings opens.

**Voice picker z-index**: In the `Settings` component (or wherever the voice picker dialog/sheet renders), ensure its z-index is higher than both the settings sheet AND the overflow menu:

- Settings sheet: e.g., `z-[70]`
- Voice picker modal: `z-[80]`

OR use a React portal (`createPortal`) to render the voice picker at the document body level, bypassing any z-index stacking context from parent components.

**Simplest complete fix**: Close overflow → open Settings panel → voice picker opens inside Settings at a z-index above everything. Since the overflow is already closed, stacking is not an issue. Ensure the Settings modal itself uses `z-[80]` or higher.

---

## 7. Implementation Order (Suggested)

| Priority | Fix                                      | Effort | Risk               |
| -------- | ---------------------------------------- | ------ | ------------------ |
| 1        | **Issue 7** — Voice picker z-index       | Low    | Low                |
| 2        | **Issue 3** — Speed init on mount        | Low    | Low                |
| 3        | **Issue 4/6** — Progress display sync    | Medium | Medium             |
| 4        | **Issue 1** — Background commit          | Medium | Low                |
| 5        | **Issue 5** — Play/pause desync          | Medium | Medium             |
| 6        | **Issue 2** — Attachments path migration | Medium | Medium (migration) |

Start with the quick wins (7, 3, 4/6) before tackling the more systemic ones (1, 5, 2).

---

## 8. Tests to Add / Update

| File                               | What to test                                                              |
| ---------------------------------- | ------------------------------------------------------------------------- |
| `tests/progressStore.test.ts`      | `shouldSkipProgressWrite` with `forceReset=true` allows 0 → committed     |
| `tests/progressStore.test.ts`      | Write then reset then re-accumulate: final progress is > 0                |
| `tests/ChapterFolderView.test.tsx` | Chapter with stored progress > 0 renders non-zero bar                     |
| `tests/usePlayback.test.ts`        | `handleSyncUpdate` with `isPlaying=false` updates React `isPlaying` state |
| `tests/saveRestoreService.test.ts` | Snapshot round-trip preserves `playbackSpeed`                             |

---

## 9. What Was Already Correct (Do Not Change)

- `shouldSkipProgressWrite` monotonicity guard logic (correct, `forceReset` bypasses properly)
- `visibilitychange` handler in `usePlayback.ts` (already calls commit + flush)
- `prefsJson` save to localStorage (speed IS persisted correctly)
- Local attachments per-bookId directory structure (already per-book, only path prefix changes)
- `ensureAttachmentsDir` "already exists" error handling
- Progress hydration in `useAppBootstrap` (correct, runs on startup)
- SQLite `chapter_progress` table schema and migration
