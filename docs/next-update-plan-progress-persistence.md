# TaleVox Next Update Plan: Progress Persistence (Safe Hydration)

**Target version:** 3.0.20  
**Theme:** Fix reading/listening progress loss on hard refresh, app restart, or process death (Android). Ensure progress survives reloads and matches user expectations (e.g. YouTube/Speechify-style position retention).

---

## 1. Executive summary

Progress is currently lost after a full page reload or when the Android process is killed because:

- **Hydration race:** React state (and any in-memory progress) initializes with defaults before the async SQLite read completes. Writes (auto-save, flush, unmount) can run in that window and overwrite valid DB progress with 0.
- **Zombie connection:** After a hard refresh, the Capacitor SQLite plugin’s JS layer can think there is no connection while the native layer still has one (`Connection already exists`), or the opposite, making the DB temporarily unusable during hydration.
- **No write barrier:** There is no guard that blocks progress writes until the first successful load from durable storage has completed.
- **Blind overwrites:** Persistence uses simple INSERT OR REPLACE, so a transient “0” or an old value can overwrite good progress (no monotonicity / “implausible reset” guard at the DB layer).

This plan addresses these with: **connection consistency on init**, **hydration guard (write barrier)**, **monotonicity/implausible-reset guards**, **WAL + throttled writes**, and **lifecycle-triggered saves**. No change to the app’s “single global state (useState + refs)” architecture—only how and when we sync that state to durable storage.

---

## 2. Implementation roadmap

### Phase 1: Harden database initialization

**Goal:** Reliable SQLite connection after hard refresh; avoid zombie connection and failed hydration.

| Step | Task                                | Details                                                                                                                                                                                                                                                                                                                                                                                           |
| ---- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.1  | **Init order (consistency-first)**  | In `sqliteConnectionManager.ts`, before creating or retrieving a connection: (1) Call `checkConnectionsConsistency()`. (2) Call `isConnection(dbName)`. (3) If **both** `consistency.result === true` and `isConnection === true` → `retrieveConnection(dbName)`. (4) Else → `createConnection(...)`. This matches the plugin’s recommended pattern and avoids create-then-catch on zombie state. |
| 1.2  | **WAL and tuning**                  | After opening the DB, run `PRAGMA journal_mode=WAL;` and `PRAGMA synchronous=NORMAL;` (or equivalent via existing `dbExecute`). Enables better read/write concurrency and faster writes.                                                                                                                                                                                                          |
| 1.3  | **Optional: DB service extraction** | If helpful for tests and single responsibility, move init + consistency + WAL into a small `DatabaseService` (or keep logic in `sqliteConnectionManager` but ensure a single entry point used by progress and library code).                                                                                                                                                                      |

**Files:** `services/sqliteConnectionManager.ts`, `src/config/appConfig.ts` (if DB name/version are centralized).

---

### Phase 2: Hydration guard (write barrier)

**Goal:** No progress write (localStorage + SQLite) may run until durable progress has been successfully loaded at least once. Prevents default/empty state from overwriting real data.

| Step | Task                                | Details                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2.1  | **Global “progress hydrated” flag** | Introduce a shared flag (e.g. in `progressStore.ts` or a small progress-bootstrap module) that is `false` at startup and set to `true` only after **both** `hydrateProgressFromDurable()` and `hydrateProgressFromIndexedDB()` have completed (respecting platform: native runs durable only, web runs IDB only). Bootstrap in `useAppBootstrap` is the single place that sets this to `true` after those calls.                                                                                                                                        |
| 2.2  | **Guard all native write paths**    | In `progressStore.ts`, before performing any **native** persistence (SQLite or merge-then-SQLite), check the flag. If not hydrated, skip the write (and optionally log a short warning in dev). Apply to: `writeProgressStoreNative`, `flushProgressStoreToDurable`, `upsertSingleChapterProgress`. Web-only paths (IndexedDB / localStorage for web) can either use the same flag (set after IDB hydration) or keep current behavior; recommendation: set flag only after the appropriate hydration for the platform so web and native are consistent. |
| 2.3  | **Bootstrap ordering**              | Ensure bootstrap still runs `hydrateProgressFromDurable()` and `hydrateProgressFromIndexedDB()` before any code that can trigger progress writes (e.g. before setting `launchStage` to `'ready'` or rendering progress-dependent UI). Already largely in place; document that the hydration flag must be set immediately after these two calls.                                                                                                                                                                                                         |

**Files:** `services/progressStore.ts`, `src/app/state/useAppBootstrap.ts`.

---

### Phase 3: Monotonicity and implausible-reset guards

**Goal:** DB layer never accepts updates that look like accidental resets (e.g. 0 overwriting 50%) or that mark a completed chapter as incomplete. User-initiated reset remains possible via an explicit action that clears storage and state.

| Step | Task                                | Details                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 3.1  | **Completion lock**                 | When persisting a chapter row, if the **existing** row in `chapter_progress` has `isComplete = 1`, do not overwrite it with an incomplete entry (unless the update is explicitly a “reset” from the reset button). So: read current row by (bookId, chapterId); if `isComplete` and incoming is not complete, skip write (or only allow when a dedicated `forceReset` flag is set).                                      |
| 3.2  | **Implausible reset guard**         | If the **incoming** `timeSec` is 0 (or very low) and the **existing** stored position is above a threshold (e.g. > 10 seconds), treat this as a likely glitch (e.g. hydration default or player emitting 0 before seek). Skip the write unless the call is explicitly a user “reset” (e.g. `commitProgressUpdate(..., "reset", ...)` or a dedicated reset API). Threshold and exact rule can be tuned (e.g. 10s or 30s). |
| 3.3  | **Centralize in DAO/write helpers** | Implement these rules in one place: e.g. a small helper used by `writeChapterProgressDurable` and `upsertSingleChapterProgress` that loads current row, applies completion lock + implausible-reset check, then runs INSERT/UPDATE only when allowed.                                                                                                                                                                    |

**Files:** `services/progressStore.ts` (chapter_progress read/write and any new helper).

---

### Phase 4: Lifecycle and save triggers

**Goal:** Progress is saved at the right times (background, pause, chapter change) without relying solely on unmount/onDestroy, which may not run on Android.

| Step | Task                           | Details                                                                                                                                                                                                                                                        |
| ---- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4.1  | **Keep appStateChange save**   | Already implemented: on `appStateChange` with `isActive === false`, call `flushProgressStoreToDurable()`. Ensure this runs only when hydration is complete (Phase 2). No change to event registration; only ensure the flush path respects the hydration flag. |
| 4.2  | **Optional: lastActiveBookId** | For cold start, optionally persist “last active book” (e.g. in Capacitor Preferences or a small SQLite table) so on next launch the app can open that book and show correct progress context. Lower priority than Phases 1–3.                                  |

**Files:** `App.tsx` (listener already present), `progressStore.ts` (flush guard).

---

### Phase 5: Buffered / throttled writes (performance and safety)

**Goal:** Reduce SQLite write frequency during playback so we don’t write on every timeupdate tick, lowering bridge traffic, jank risk, and accidental overwrites from rapid updates.

| Step | Task                      | Details                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5.1  | **Throttle persistence**  | Keep UI (slider/position) updated on every timeupdate (ref or state). Persist to SQLite only: (a) every N seconds (e.g. 30s) during playback, (b) on pause, (c) on chapter end, (d) on app background (already via appStateChange). Implement in the layer that currently calls `writeProgressStore` / `upsertSingleChapterProgress` from playback (e.g. `usePlayback`, speechService, or a small progress-flush utility). |
| 5.2  | **Ref for live position** | Use a ref to hold the latest position for the current chapter so the UI can show smooth updates without triggering a write on every tick. Only the throttled/flush path reads from this ref and persists.                                                                                                                                                                                                                  |

**Files:** `src/app/state/usePlayback.ts`, `services/speechService.ts` (or wherever timeupdate commits progress), and/or `utils/progressFlush.ts` if present.

---

## 3. Testing and validation

- **Unit:** Hydration flag: writes are no-ops until flag is set; after set, writes run. Monotonicity: completed row not overwritten by incomplete; timeSec 0 with stored > 10s is ignored unless reset.
- **Integration:** Bootstrap: after full bootstrap, `readProgressStore()` and SQLite `chapter_progress` reflect previously saved progress; hard refresh (or simulated reload) does not zero out progress.
- **Manual (Android):** Play to ~50%, force stop or hard refresh, reopen app — position should remain ~50%. Complete a chapter, refresh — chapter stays complete. Reset button clears progress and storage as today.

---

## 4. Version and changelog

- **Version:** Bump to **3.0.20** in `package.json`.
- **Changelog:** Add a **3.0.20** section at the top of `CHANGELOG.md` with the following (or equivalent):

```markdown
## 3.0.20

- Reading/listening progress now persists correctly across app restarts, hard refresh, and process death on Android.
- Fixed hydration race: progress is no longer overwritten with 0 before SQLite has loaded saved state; a write barrier blocks all progress writes until durable storage has been hydrated at startup.
- SQLite initialization now uses connection-consistency checks and retrieve-vs-create branching to avoid "Connection already exists" and zombie connection issues after hard refresh.
- Progress persistence enforces monotonicity: completed chapters stay completed, and implausible resets (e.g. 0 overwriting a saved position > 10s) are ignored unless the user explicitly resets.
- SQLite uses WAL mode for better concurrency; progress writes are throttled (e.g. every 30s during playback, plus on pause, chapter end, and app background) to reduce bridge traffic and avoid accidental overwrites.
```

---

## 5. References (from your notes)

- Persisting React state (e.g. lazy init from storage + useEffect sync).
- Capacitor: prefer Preferences or SQLite over raw `localStorage` on native.
- capacitor-community/sqlite: `checkConnectionsConsistency`, `retrieveConnection`, and lifecycle handling.
- Offline-first / server-authoritative patterns: DB as source of truth, UI as derived view; never let default state overwrite DB before first successful read.

---

## 6. Out of scope for this update

- Redesign to Redux/Context or a separate state library.
- Server-side progress sync (e.g. Speechify-style server-authoritative sync); this plan keeps the local DB as the source of truth for progress.
- Foreground service / native audio process for playback (future improvement only).
