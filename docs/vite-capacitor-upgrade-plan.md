# Vite & Capacitor CLI Upgrade Plan (future release)

This document outlines steps to clear the **remaining npm advisories** (6 moderate, all from the esbuild/vite chain) after the conservative security pass. These upgrades involve **major version bumps** and should be done in a dedicated release with full regression testing.

**Related:** [app-audit.md](app-audit.md) Section 10 – remaining advisories and rationale for deferral.

---

## 1. Goals

- **Vite:** Upgrade to a major that depends on a patched esbuild (e.g. Vite 7.x per `npm audit fix --force` suggestion). This clears GHSA-67mh-4wv8-2f99.
- **Vitest:** Align with the chosen Vite major (e.g. Vitest 3.x if moving to Vite 7) so tests keep running against the same toolchain.
- **vite-plugin-pwa:** Upgrade to a version compatible with the new Vite major.
- **@capacitor/cli:** If a newer major (e.g. 9.x) ships with a patched `tar` or other deps, consider upgrading in the same pass or a follow-up; current conservative fix already resolved the `tar` advisory via transitive updates.

---

## 2. Pre-upgrade checklist

- [ ] Create a feature branch (e.g. `chore/vite-capacitor-upgrade`).
- [ ] Ensure current main has green CI: `npm run test`, `npx tsc --noEmit`, `npm run build`.
- [ ] Run `npm audit` and note the current “6 moderate” count to confirm it drops to 0 after upgrades.

---

## 3. Upgrade steps

### 3.1 Vite and related devDependencies

1. **Vite**
   - Bump `vite` in `package.json` to the target major (e.g. `^7.0.0` or latest 7.x). Check [Vite releases](https://github.com/vitejs/vite/releases) and [migration guide](https://vite.dev/guide/migration.html) for breaking changes.
2. **Vitest**
   - Bump `vitest` to a version compatible with the new Vite (e.g. Vitest 3.x for Vite 7). Update `@vitest/*` packages if present.
3. **vite-plugin-pwa**
   - Bump `vite-plugin-pwa` to a release that supports the new Vite major (see [vite-plugin-pwa releases](https://github.com/vite-pwa/vite-plugin-pwa/releases)).
4. **Install and fix**
   - Run `npm install`.
   - Resolve any peer dependency or type errors; run `npx tsc --noEmit` and fix issues.
   - Run `npm run build` and fix any Vite/Rollup config or plugin API breakages.
   - Run `npm run test -- --run` and fix any Vitest or test-runner breakages.

### 3.2 Optional: @capacitor/cli

- If `npm audit` still reports issues from `@capacitor/cli` (e.g. a future `tar` or other transitive), check [Capacitor releases](https://github.com/ionic-team/capacitor/releases) for a version that addresses them.
- Upgrade `@capacitor/cli` (and optionally other `@capacitor/*` packages together) per [Capacitor upgrade guide](https://capacitorjs.com/docs/updating/6-0). Re-run `npm run cap:sync` and Android build.

---

## 4. Regression strategy

| Step                     | Command / action                                                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Unit / integration tests | `npm run test -- --run` – must remain green.                                                                                          |
| Type check               | `npx tsc --noEmit` – no new errors.                                                                                                   |
| Production build         | `npm run build` – must succeed.                                                                                                       |
| Audit                    | `npm audit` – expect 0 vulnerabilities (or document any that remain).                                                                 |
| Android sync & build     | `npm run android:sync` then open in Android Studio or run device; confirm app builds and launches.                                    |
| Manual smoke             | In dev (`npm run dev` or `npm run dev:cap`): open library, open a book, play audio, open attachments/settings. On device: same flows. |

---

## 5. Rollback

If the upgrade introduces regressions that are not quickly fixable:

- Revert the branch or restore `package.json` and `package-lock.json` from before the upgrade.
- Re-run `npm install`, `npm run test -- --run`, `npx tsc --noEmit`, and `npm run build` to confirm the pre-upgrade state.

---

## 6. After the upgrade

- Update this doc or [app-audit.md](app-audit.md) to note that the esbuild-related advisories have been cleared.
- Add a CHANGELOG entry for the release (e.g. “Upgraded Vite to 7.x and Vitest to 3.x to resolve remaining npm advisories (GHSA-67mh-4wv8-2f99).”).
