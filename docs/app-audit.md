# TaleVox App Audit

**Date:** February 2026  
**Version:** 3.0.23  
**Scope:** Dependencies, build, tests, codebase structure, and quality. For a **full app audit** (entire application), see [full-app-audit.md](full-app-audit.md).

---

## 1. Executive summary

| Area             | Status   | Notes                                                                                                                        |
| ---------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **Dependencies** | ✅ Clear | Vite 7 + Vitest 3 upgrade applied; **0 vulnerabilities**. See [Section 10](#10-remaining-advisories-after-conservative-fix). |
| **TypeScript**   | ✅ Fixed | One type error in `attachmentsService.ts` (Filesystem.readdir `files` type) corrected                                        |
| **Tests**        | ✅ Pass  | 19 files, 86 tests pass, 1 skipped; IDB warnings in Node env are expected                                                   |
| **Structure**    | ✅ Good  | Clear split: `src/features`, `components`, `services`, `hooks`, `src/app`                                                    |
| **Tooling**      | ✅ Added | ESLint (flat config) + Prettier added; `npm run lint` and `npm run format` / `format:check`; CI runs both.                   |
| **Sync / sign-in** | ✅ Fixed | Sync button no longer stuck on sign-in form; auto-advance when auth is valid; startup error handler keeps user in app when token present. See [Section 8](#8-sync-and-sign-in-flow-audit). |

---

## 2. Dependencies (npm audit)

**Result:** After Vite 7 + Vitest 3 upgrade: **0 vulnerabilities**.

| Severity | Before fix (earlier 3.0.22) | After Vite upgrade |
| -------- | --------------------------- | ------------------ |
| High     | 0                           | 0                  |
| Moderate | 6 (esbuild chain)           | 0                  |

**Previous remaining (now fixed):** All stemmed from **esbuild** (GHSA-67mh-4wv8-2f99). Upgrading to Vite 7 and Vitest 3 (Option A in [vite-upgrade-pr-plan.md](vite-upgrade-pr-plan.md)) cleared these. Install uses `legacy-peer-deps` until vite-plugin-pwa declares Vite 7 support.

**Recommended actions:**

- ~~Run **`npm audit fix`**~~ **Done.** Non-breaking fixes applied; high-severity issues resolved.
- ~~**esbuild/vite:** Remaining moderate issues require a major upgrade (Vite 7+)~~ **Done.** Vite 7 and Vitest 3 applied; 0 vulnerabilities.
- **Capacitor + tar:** Was fixed by `npm audit fix` (transitive `tar` updated). No longer in the remaining list.

---

## 3. Build and type-check

- **TypeScript:** `npx tsc --noEmit` passes after fixing `services/attachmentsService.ts`.
- **Fix applied:** `Filesystem.readdir()` returns `files` as `(string | FileInfo)[]` in Capacitor's types. The migration loop now normalizes entries to filenames with:
  `rawFiles.map((f) => (typeof f === "string" ? f : (f as { name: string }).name))`.
- **Recommendation:** Run `tsc --noEmit` in CI (e.g. in `.github/workflows/ci.yml`) so type regressions are caught.

---

## 4. Tests

- **Result:** All 19 test files, 86 tests pass; 1 skipped (ChapterFolderView scroll-restore test under Vitest 3; see [vite-upgrade-pr-plan.md](vite-upgrade-pr-plan.md)).
- **Environment:** Vitest 3 with jsdom; no browser IndexedDB in Node, so `progressStore` tests log "indexedDB is not defined" but still pass (logic uses in-memory fallback or mocks).
- **Coverage:** Good coverage for progress, save/restore, playback, chapter view, and job runner; no coverage config in the audit run.
- **Recommendation:** Add `vitest --coverage` (or similar) to CI and optionally enforce a minimum coverage threshold.

---

## 5. Codebase structure

Aligned with `docs/ARCHITECTURE.md`:

- **`src/features/*`** – Feature screens and state (library, reader, rules, settings).
- **`components/*`** – Shared UI (ChapterFolderView, Player, Settings, BookGrid, etc.).
- **`services/*`** – Data and I/O (progressStore, attachmentsService, playbackAdapter, drive\*, jobRunner, etc.).
- **`hooks/*`** – Shared hooks (useReaderProgress, usePlayback usage, useNotify, etc.).
- **`src/app/*`** – Shell, routing, and core state (useAppBootstrap, usePlayback, useJobs, etc.).

State flow is clear: bootstrap → app state → playback/progress/attachments/jobs. No major structural issues observed.

---

## 6. Tooling and quality

- **Linting/formatting:** No ESLint or Prettier in `package.json`. Editor/IDE may apply defaults but there is no shared config or CI check.
- **Recommendation:** Add ESLint (e.g. `@eslint/js`, `typescript-eslint`, `eslint-plugin-react`) and Prettier with a shared config, and run them in CI to keep style and basic rules consistent.

---

## 7. Security (high level)

- **Secrets:** `.env.production` is present; ensure it is in `.gitignore` and never committed.
- **Auth:** `authManager` and storage usage exist; a dedicated security review (e.g. using the security-best-practices skill) is recommended if the app handles sensitive or regulated data.
- **Dependencies:** Addressing npm audit findings (Section 2) reduces supply-chain risk.

---

## 8. Sync and sign-in flow (audit)

**Scope:** Header Sync button, sign-in screen, and avoiding getting stuck on the sign-in form.

| Area | Status | Notes |
|------|--------|--------|
| **Header button** | ✅ Fixed | When `authStatus` is `signed_in` and token present, header shows **Sync** and `onSync` runs `handleSync(true)` (no sign-in). When `expired`/`signed_out`, header shows **Sign in** and `onReconnectDrive` runs `ensureValidToken(true)` then sync. |
| **Stuck on sign-in form** | ✅ Fixed | (1) If we land on `launchStage === "signin"` but auth has since become valid (e.g. `loadFromStorage` completed late), an effect in `App.tsx` advances to `ready` so the main app and Sync are available. (2) If startup throws after the user has already signed in (e.g. `restoreFromDriveIfAvailable` fails), `onStartupError` returns `"ready"` when a token is present so we do not revert to the sign-in screen. |
| **Sync path** | ✅ Safe | `handleSync` only calls `performFullDriveSync` and `handleSaveState`; it never sets `launchStage`. So clicking Sync never forces the sign-in screen. |
| **Bootstrap** | ✅ Clear | `runStartup` (in `useAppBootstrap`) runs once on mount; it uses `ensureValidToken(false)` to decide `authOk`. If `authOk` it sets `launchStage("ready")`; else `launchStage("signin")`. Optional `onStartupError(error)` lets the host choose `"ready"` when a token exists so post-sign-in failures (e.g. restore) do not trap the user on sign-in. |

**Files touched:** `App.tsx` (effect to advance from signin when already signed in; `onStartupError` passed to bootstrap), `src/app/state/useAppBootstrap.ts` (`onStartupError` option and use in startup catch).

---

## 9. Summary of changes made during audit

1. **`services/attachmentsService.ts`** – Legacy migration loop now treats `readdir` `files` as `(string | FileInfo)[]` and maps each entry to a string filename before building paths, resolving the TypeScript error and avoiding runtime type issues.
2. **Sync / sign-in (Feb 2026):** `App.tsx` – Effect when `launchStage === "signin"` and `authState.status === "signed_in"` with token: set `launchStage("ready")` so the user is not stuck on the sign-in form. `useAppBootstrap` – Added `onStartupError`; on startup failure, use it to set `launchStage` to `"ready"` when a token is present so successful sign-in followed by restore failure does not revert to the sign-in screen.
3. **Tests (Feb 2026):** `tests/jobRunnerService.test.ts` – Fixed “enqueueCloudGenerateBookAudio throws when endpoint is not configured” by stubbing env (`vi.stubEnv`) and `vi.resetModules()` so the test runs without `VITE_TALEVOX_BATCH_JOBS_ENDPOINT`; all 86 tests pass.

---

## 10. Remaining advisories after conservative fix (Feb 2026)

**Update (Vite 7 upgrade):** The esbuild advisories have been **cleared** by upgrading to Vite 7 and Vitest 3 (Option A in [vite-upgrade-pr-plan.md](vite-upgrade-pr-plan.md)). `npm audit` now reports **0 vulnerabilities**.

The following applied before that upgrade. Kept for context.

After running `npm audit fix` (no `--force`), the following advisories _remained_. They are **not** fixed in the conservative pass because doing so would require major version upgrades (e.g. Vite 7).

| Advisory ID                                                              | Package                                                | Severity | Why deferred                                                                                                           | Impact                                                                                                                                                                  |
| ------------------------------------------------------------------------ | ------------------------------------------------------ | -------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [GHSA-67mh-4wv8-2f99](https://github.com/advisories/GHSA-67mh-4wv8-2f99) | esbuild (via vite, vitest, vite-node, vite-plugin-pwa) | Moderate | Patched esbuild is only available in toolchains that depend on Vite 7+. We stay on Vite 5.x to avoid breaking changes. | **Dev only:** Affects the Vite dev server (any website could send requests to it and read responses). Does **not** affect the built production app or Capacitor binary. |

**Rationale for deferral (at the time):** (1) No non-breaking fix exists within Vite 5.x / Vitest 2.x. (2) Risk is limited to local development; production builds do not ship the vulnerable dev server. (3) A future release will upgrade Vite (and related tooling) in a dedicated change with full regression testing.

**Remediation completed:** Vite 7 and Vitest 3 were upgraded in the same release; see [vite-upgrade-pr-plan.md](vite-upgrade-pr-plan.md). Install uses `legacy-peer-deps` (`.npmrc`) until vite-plugin-pwa declares Vite 7 support.

---

## 11. Recommended next steps (priority order)

1. ~~Run **`npm audit fix`**~~ **Done.** Non-breaking fixes applied.
2. Add **`tsc --noEmit`** to CI so type errors fail the build.
3. ~~Optionally add **ESLint + Prettier**~~ **Done.** ESLint (flat config with TypeScript + React) and Prettier added; CI runs `npm run lint` and `npm run format:check`.
4. ~~Plan a **Vite upgrade**~~ **Done.** Vite 7 and Vitest 3 applied (Option A in [vite-upgrade-pr-plan.md](vite-upgrade-pr-plan.md)); `npm audit` reports 0 vulnerabilities. One ChapterFolderView test skipped under Vitest 3.
5. ~~Consider **coverage**~~ **Done.** `vitest run --coverage` with v8 provider; `npm run coverage` runs tests and enforces minimum thresholds (25% lines, functions, branches, statements). CI runs coverage; report in `coverage/` (gitignored). Increase thresholds in `vitest.config.ts` as needed.
6. If the app handles sensitive data, schedule a **security best-practices review** for the stack (e.g. TypeScript/React/Capacitor).
