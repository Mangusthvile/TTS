# TaleVox TTS — Full App Audit

**Date:** February 2026  
**Version:** 3.0.23  
**Scope:** Entire application — structure, state, storage, flows, config, security, tests, and recommendations.

---

## 1. Executive summary

| Area | Status | Notes |
|------|--------|--------|
| **Structure** | ✅ Good | Clear split: `src/app`, `src/features`, `components`, `services`, `hooks`; single AppState in App.tsx. |
| **State & routing** | ✅ Good | One AppState (useState + stateRef); tab-based routing (library \| collection \| reader \| rules \| settings); no React Router. |
| **Persistence** | ✅ Good | Native: SQLite (library + progress + storage driver) + WAL; Web: IndexedDB + localStorage. Single migration path at bootstrap. |
| **DB & workers** | ✅ Addressed | Single Java DB owner (JobRunnerPlugin); workers use sync APIs only; full schema before any query; WAL enabled. |
| **Cloud scale** | ✅ Wired | Cloud batch for large runs (config threshold, polling, cancel, Settings toggle). |
| **Dependencies** | ✅ Clear | React 19, Vite 7, Capacitor 8, SQLite, Drive; run `npm audit` in CI. |
| **Build & types** | ✅ Pass | `tsc --noEmit` and `npm run build` succeed. |
| **Tests** | ✅ Pass | Vitest; 20 test files; services and key components covered. |
| **Security** | ⚠️ Review | No secrets in repo; env for client ID and batch endpoint; tokens in storage driver. Recommend dedicated review if handling sensitive data. |
| **Documentation** | ✅ Present | ARCHITECTURE.md, plans, this audit, CHANGELOG. |

---

## 2. Top-level structure

### Entry points

- **HTML:** `index.html` — root `<div id="root">`, loads `/index.tsx`.
- **JS:** `index.tsx` — installs trace handlers, runs `ensureDbReady()` and `ensureAuthReady()` (non-blocking), mounts `<App />` inside an `ErrorBoundary` and `React.StrictMode`.
- **Root component:** `App.tsx` — main UI and orchestration (~6k lines). Tab state and AppState live here; routing is tab-based via `AppRouter.tsx`.

### Directories and roles

| Directory | Role |
|-----------|------|
| **src/app/** | App shell: `AppRouter`, `AppShell`, `bootstrap`, constants, types. State hooks in `state/`: useAppBootstrap, usePlayback, useJobs, useChapterPaging, useUploadQueue, useDiagnostics, useNotifications, useJobActions, useAttachments. |
| **src/features/** | Library (Library, ChapterFolderView, ChapterSidebar, Extractor, BookState), Reader (Reader, Player, ReaderState, PlaybackDiagnosticsOverlay), rules (RuleManager), settings (Settings, JobListPanel). Many re-export from `components/`. |
| **components/** | Shared UI: Library, Reader, Player, ChapterSidebar, Extractor, Settings, notifications, reader/*, library/*, book/*. |
| **services/** | Storage (storageSingleton, storageDriver, sqliteConnectionManager, sqliteStorageDriver, libraryStore, libraryIdb), progress (progressStore), auth (driveAuth, authManager), Drive (driveService, driveFolderAdapter, saveRestoreService), jobs (jobRunnerService, jobStore, cloudBatchApi), playback/TTS, upload queue, diagnostics, etc. |
| **hooks/** | useNotify, useReaderProgress, useHighlightSync, useAutoScroll, useSelectionStore, useChapterSelection. |
| **utils/** | Trace, logger, errors, markdown/chunking, TTS voice parsing, safeStorage, chapterBookUtils, platform. |
| **android/** | Capacitor Android: MainActivity, JobRunnerPlugin (single DB owner), GenerateAudioWorker, FixIntegrityWorker, DriveUploadWorker (plugin sync APIs only), notifications. |
| **cloud-batch-service/** | Optional Node/Express + Firestore backend for batch TTS (POST/GET /v1/batch-jobs, POST /internal/process). |
| **tests/** | Vitest: jobRunnerService, progressStore, saveRestore, Library, Reader, ChapterFolderView, nativeLibraryBridge, etc. |

---

## 3. State management

### Global app state

- **Single source of truth:** `AppState` in `App.tsx`:
  - **useState&lt;AppState&gt;(state)** and **setState** for updates.
  - **stateRef** (useRef) so async code and callbacks see the latest state.
- **AppState** (types.ts): `books`, `activeBookId`, `playbackSpeed`, `selectedVoiceName`, `theme`, `readerSettings`, Drive fields (`driveRootFolderId`, etc.), `globalRules`, `showDiagnostics`, `autoSaveInterval`, and related flags.

### Ownership

- **Books / chapters:** `state.books` and `state.activeBookId`. Loaded by **useAppBootstrap** from `libraryStore.listBooks()` and `listChaptersPage()`; paging via **useChapterPaging** (`chapterPagingByBook`, `loadMoreChapters`). Writes through `libraryStore` then `setState`.
- **Jobs:** **useJobs** — loads from job runner / jobStore, exposes `jobs` and `setJobs`; **useJobActions** for cancel/retry/delete. Persisted via storage driver (SQLite on native, localStorage on web). Cloud jobs polled on interval when active.
- **Progress:** **progressStore** (in-memory + durable). **usePlayback** and **useReaderProgress** read/write; persisted via storage driver and SQLite `chapter_progress` on native.
- **Settings:** Part of AppState (`readerSettings`, `theme`, etc.); restored in bootstrap and persisted via snapshot/localStorage.
- **Nav context:** **RouteContext** — `bookId`, `chapterId`, scroll position, `lastViewType`; stored in localStorage, restored in **restoreNavContext**.
- **Playback:** **usePlayback** — current chapter session, phase, position, adapter; drives Player and Reader.

---

## 4. Storage and persistence

### SQLite (native only)

- **When opened:** **ensureAppDatabaseOpen()** in **useAppBootstrap.runBootstrap** (after `bootstrapCore()`). Then **runAppMigrationsOnce()** runs full schema (chapter_progress, drive_upload_queue, library tables, ensureColumn) so no query runs before schema exists.
- **WAL:** **sqliteConnectionManager** runs `PRAGMA journal_mode=WAL` after open (best-effort). **JobRunnerPlugin.getDb()** runs the same on Android.
- **Used by:** libraryStore (books, chapters, chapter_text, cue/paragraph maps, tombstones, attachments), progressStore (chapter_progress), SqliteStorageDriver (kv, jobs, chapter_audio_files, drive_upload_queue, auth session, app state). Single Java connection in JobRunnerPlugin; workers use plugin sync APIs only.

### IndexedDB (web)

- **libraryIdb:** Books, chapters, chapter_text, cue/paragraph maps, attachments, tombstones. Used by **libraryStore** when not native.
- **storageService (keyval):** Large values; **progressStore** uses it for progress on web.

### localStorage

- Progress (web fallback/session delta), nav context, launch sync, last active book (native), snapshot meta, reader progress backup. Storage driver on web uses size-capped localStorage (SafeLocalStorageDriver).

### Drive

- **saveRestoreService:** Restore on startup when signed in and online; manual save/sync. Upload queue (storage driver + DriveUploadWorker) for chapter audio.

### Summary

| Data | Web | Native |
|------|-----|--------|
| Library | IndexedDB via libraryStore | SQLite via libraryStore |
| App state, settings, auth, jobs, upload queue | localStorage (SafeLocalStorageDriver) | SQLite (SqliteStorageDriver) |
| Progress | In-memory + IndexedDB + localStorage | In-memory + SQLite chapter_progress + localStorage cache |
| Nav, launch sync | localStorage | localStorage + Preferences (last active book) |

---

## 5. Key user flows

### App open → Library → Book → Play chapter

1. **Open app:** `index.tsx` runs `ensureDbReady()` and `ensureAuthReady()`. App mounts; **useAppBootstrap.runStartup** runs once: **runBootstrap** (bootstrapCore → ensureAppDatabaseOpen → runAppMigrationsOnce → hydrateProgressFromDurable → hydrateProgressFromIndexedDB → listBooks → listChaptersPage), then optional **restoreFromDriveIfAvailable** and **restoreNavContext**. Launch stage moves to signin or ready.
2. **Library:** When `launchStage === "ready"`, content shows. **AppRouter** renders by **activeTab**. Library uses **state.books** and **state.activeBookId**.
3. **Open book:** User selects book → **setState** (activeBookId), **setActiveTab("collection")**, **loadMoreChapters(bookId, true)**. Collection view is **ChapterFolderView** with **activeBook** and chapter paging.
4. **Play chapter:** User taps chapter → **handleSmartOpenChapter** → **setActiveTab("reader")** → **loadChapterSession(chapterId)**. Reader and Player use session + **usePlayback** and progressStore.

### Generate audio / cloud batch

- **Small runs:** On-device via JobRunnerPlugin (GenerateAudioWorker). **startBookGenerationJob** or **enqueueGenerateAudio** enqueues native work.
- **Large runs (e.g. ≥50 chapters or “use cloud batch” toggle):** **enqueueCloudGenerateBookAudio** calls cloud-batch-service POST /v1/batch-jobs (userId, driveRootFolderId, driveBookFolderId, voice, settings). Local job record stores cloudJobId; **syncCloudBackedJobs** and polling (e.g. 5s when active cloud jobs) update progress. Cancel calls POST .../cancel when backend supports it.

---

## 6. Config and environment

- **Source:** `src/config/appConfig.ts`; values from `import.meta.env` (Vite). No secrets in repo; use `.env.local` or `.env.production` (`.gitignore` has `*.local`).
- **Notable keys:** `VITE_GOOGLE_WEB_CLIENT_ID` (or equivalent for auth), `VITE_TALEVOX_BATCH_JOBS_ENDPOINT` / `VITE_BATCH_JOBS_ENDPOINT`, `VITE_TALEVOX_CLOUD_BATCH_MIN_CHAPTERS`, `VITE_TALEVOX_CLOUD_JOB_POLL_MS`, DB name/version, paths, cache TTLs, job batch size, etc.
- **cloud-batch-service:** `OPENAI_API_KEY`, `TTS_ENDPOINT`, `FIRESTORE_DATABASE_ID`, `PORT`; service account token from metadata server in Cloud Run.

---

## 7. Security

- **Auth:** Google OAuth (Drive scopes); token and session in storage driver (localStorage or SQLite). No credentials in source.
- **Drive:** Scopes limited to drive.file and metadata/read; app uses user’s Drive folder.
- **Recommendation:** If handling sensitive or regulated data, run a dedicated security review (auth, storage, env, Drive usage).

---

## 8. Error handling and resilience

- **Global:** `index.tsx` — ErrorBoundary with recovery UI; fatal error stored in localStorage for debugging.
- **Bootstrap:** `onStartupError` allows entering app when token exists but restore fails.
- **Sync / Drive:** Try/catch in full sync; per-book errors don’t abort entire sync.
- **Workers:** Retries and token refresh where applicable; progress/status via plugin only.
- **ProgressStore:** IDB write failures logged; in-memory/localStorage fallback when IDB unavailable.

---

## 9. Tests

- **Runner:** Vitest 3, jsdom. **20 test files** (e.g. jobRunnerService, progressStore, saveRestoreService, fullSnapshot, ChapterFolderView, Reader, Library, nativeLibraryBridge).
- **Setup:** `vitest.setup.ts` — mocks for Audio, ResizeObserver, IntersectionObserver, requestIdleCallback, react-window.
- **CI:** Run `npm run test`, `tsc --noEmit`, `npm run lint`, `npm run format:check` (and optionally coverage) on every PR.

---

## 10. Performance

- **Bundle:** Main chunk can exceed 500 kB; Vite may warn. Consider `manualChunks` or further code-split for heavy screens (e.g. ChapterFolderView, Extractor).
- **Caching:** appConfig cache TTLs for chapter text, audio path, file stat; progress flush/commit serialized.

---

## 11. Accessibility and UX

- **ErrorBoundary** wraps the app with recovery actions (refresh, copy diagnostics).
- **aria-** and **role=** usage present in AppShell, Player, ReaderList, ChapterFolderView, LibraryTopBar, BookTopBar. Consider an accessibility pass for focus order and screen readers.

---

## 12. Technical debt and recommendations

1. **Bundle size:** Split or document strategy for chunks &gt; 500 kB.
2. **Tests:** Reduce `act(...)` warnings where possible; add coverage for critical Drive/sync paths if missing.
3. **IDB in tests:** Optional fake IndexedDB in Vitest to remove “indexedDB is not defined” noise and test IDB paths.
4. **Security:** Schedule a focused security review if the app handles sensitive data.
5. **CI:** Enforce `tsc --noEmit`, lint, format-check, and tests (and optionally coverage) on every PR.

---

## 13. Related docs

- **Architecture:** [ARCHITECTURE.md](ARCHITECTURE.md)
- **Plans:** fix_audio_generation_db_and_scale, library-plan, progress-system-overview, cloud-batch-api, etc.
- **Changelog:** CHANGELOG.md
