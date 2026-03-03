# Vite Upgrade PR Plan

**Status:** Option A completed. Vite 7 + Vitest 3 applied; `npm audit` reports 0 vulnerabilities. One test skipped under Vitest 3 (ChapterFolderView scroll restore). Install uses `legacy-peer-deps` (`.npmrc`).

Use this as the **PR scope and testing checklist** for a separate branch/PR that upgrades Vite (and optionally runs `npm audit fix --force`) to clear the remaining 6 moderate advisories. Full technical steps remain in [vite-capacitor-upgrade-plan.md](vite-capacitor-upgrade-plan.md).

---

## PR scope

- **Branch:** `chore/vite-upgrade` (or `chore/vite-audit-fix`)
- **Goal:** Upgrade Vite to a major that uses a patched esbuild; align Vitest and vite-plugin-pwa; optionally run `npm audit fix --force` and resolve any resulting changes.
- **Out of scope:** No app feature changes; no Capacitor runtime upgrades unless needed for compatibility.

---

## Option A: Manual version bumps (recommended)

1. In `package.json` devDependencies, set:
   - `vite`: `^7.0.0` (or latest 7.x from [Vite releases](https://github.com/vitejs/vite/releases))
   - `vitest`: version compatible with Vite 7 (e.g. Vitest 3.x – check [Vitest docs](https://vitest.dev/guide/))
   - `vite-plugin-pwa`: version that supports Vite 7 ([releases](https://github.com/vite-pwa/vite-plugin-pwa/releases))
   - `@vitejs/plugin-react`: version compatible with Vite 7 if needed
2. Run `npm install`.
3. Fix any peer dependency warnings, config, or code breakages (see [vite-capacitor-upgrade-plan.md](vite-capacitor-upgrade-plan.md) §3).
4. Run full testing checklist below.

---

## Option B: `npm audit fix --force` (alternative)

1. Run `npm audit fix --force` (this may install Vite 7.x and related versions automatically).
2. Inspect `package.json` and `package-lock.json` for unwanted major bumps (e.g. React, Capacitor). Revert those to current versions if the force fix changed them.
3. Run `npm install` again if you reverted any top-level deps.
4. Fix config and code breakages from the new Vite/Vitest versions (migration guides in §3 of the main plan).
5. Run full testing checklist below.

---

## Full testing checklist (before merging)

Use this in the PR to confirm no regressions.

### Automated (must all pass)

| Check                    | Command                 | Notes                                                     |
| ------------------------ | ----------------------- | --------------------------------------------------------- |
| Type check               | `npx tsc --noEmit`      | No new type errors.                                       |
| Lint                     | `npm run lint`          | Existing config; fix any new errors.                      |
| Format                   | `npm run format:check`  | Prettier; run `npm run format` if needed.                 |
| Unit / integration tests | `npm run test -- --run` | All 19 test files, 85 tests green.                        |
| Production build         | `npm run build`         | `tsc && vite build --mode capacitor` succeeds.            |
| Audit                    | `npm audit`             | Expect **0 vulnerabilities** (or document any remaining). |

### Manual (recommended before merge)

| Check         | Action                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------ |
| Dev server    | `npm run dev` – app loads; open library, open a book, play chapter.                                    |
| Capacitor dev | `npm run dev:cap` – same flows if you use Capacitor dev.                                               |
| Android build | `npm run android:sync` then build/run on device or emulator – app launches, play audio, open settings. |
| PWA/build:web | `npm run build:web` – succeeds; optional quick `npm run preview` smoke.                                |

### After merge

- [ ] Update [app-audit.md](app-audit.md) Section 10 to state that esbuild advisories are cleared (or link to this PR).
- [ ] Add a CHANGELOG entry for the release (e.g. “Upgraded Vite to 7.x and Vitest to 3.x to resolve remaining npm advisories (GHSA-67mh-4wv8-2f99).”).

---

## Rollback

If the upgrade causes blocking issues:

- Revert the PR branch to the commit before the upgrade.
- Restore `package.json` and `package-lock.json` from main if needed, run `npm install`, then re-run the automated checklist to confirm the pre-upgrade state.

---

## References

- [vite-capacitor-upgrade-plan.md](vite-capacitor-upgrade-plan.md) – detailed upgrade steps, regression strategy, rollback.
- [app-audit.md](app-audit.md) §10 – remaining advisories and why they were deferred.
- [Vite migration guide](https://vite.dev/guide/migration.html) – breaking changes by version.
- [Vitest migration](https://vitest.dev/guide/migration) – if moving to Vitest 3.
