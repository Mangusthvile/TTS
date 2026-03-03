# Section 8 — Startup Performance

Reduce the cold-start CPU/DB spike so the device doesn’t warm before the user starts playing. Two main causes: (1) bootstrap fires a large burst of chapter-page loads in parallel; (2) auth init polls for the GIS script instead of waiting for its load event.

---

## Current behavior

- **useAppBootstrap.runBootstrap** ([src/app/state/useAppBootstrap.ts](src/app/state/useAppBootstrap.ts) lines 124–134): After loading the book list, it runs `Promise.all(loadedBooks.map(async (book) => listChaptersPage(book.id, -1, preloadLimit)))` with `preloadLimit = 60`. So **every book** gets a chapter-page request (up to 60 chapters per book) **in parallel**. With 50 books that is **50 concurrent** `listChaptersPage` calls — each hits IndexedDB (web) or SQLite (native) with a transaction and query. That causes a sharp spike in I/O and CPU on cold start.
- **listChaptersPage** ([services/libraryStore.ts](services/libraryStore.ts), [services/libraryIdb.ts](services/libraryIdb.ts)): One storage operation per book (single query/cursor per book), but running 50 at once stresses the DB and main thread.
- **Auth GIS init** ([services/authManager.ts](services/authManager.ts) lines 121–158): On web, `init(clientId)` calls `tryInit()`. If `window.google?.accounts?.oauth2` is missing, it schedules `setTimeout(tryInit, 500)` and retries up to **20 times** (10 s total). The Google Identity Services script is loaded in [index.html](index.html) as `<script src="https://accounts.google.com/gsi/client" async defer></script>`, so it loads asynchronously. Polling every 500 ms until the global appears works but wastes CPU and timers during startup; it’s better to run init once when the script has actually loaded (e.g. via the script element’s `load` event).

---

## 1. Limit chapter preload concurrency in bootstrap (useAppBootstrap.ts)

**Goal:** Avoid 50+ concurrent `listChaptersPage` calls. Run them in small batches so DB and CPU load are spread out.

- **Current:** `Promise.all(loadedBooks.map(...))` runs one `listChaptersPage` per book concurrently.
- **Change:** Process books in batches of **3–5** (e.g. `PRELOAD_BATCH_SIZE = 4`). Options:
  - **Option A — Sequential batches:** For each batch of N books, `await Promise.all(batch.map(...))`, then move to the next batch. So at most N concurrent listChaptersPage calls.
  - **Option B — Defer non-visible:** Preload only the first K books (e.g. 5–10) fully; for the rest, set paging so the first page loads on demand when the user opens the book or scrolls the list. (Larger product change; Option A is simpler.)
- **Recommendation:** Implement **Option A**. Add a small helper that chunks `loadedBooks` into batches of `PRELOAD_BATCH_SIZE` and runs `Promise.all` per batch in sequence (e.g. `for (const batch of chunks(loadedBooks, 4)) { await Promise.all(batch.map(...)); }`). Keep `preloadLimit = 60` per book so each book still gets up to 60 chapters; only concurrency is reduced.
- **Result:** Cold start does at most 4 concurrent DB operations at a time instead of 50, reducing the I/O spike and main-thread contention. Time to “library ready” may increase slightly; if needed, tune batch size (e.g. 6–8) as a compromise.

**Files:** [src/app/state/useAppBootstrap.ts](src/app/state/useAppBootstrap.ts).

---

## 2. Optional: Preload only a subset of books initially (useAppBootstrap.ts)

**Goal:** Further reduce work on cold start by loading chapter pages only for the first few books (e.g. 10); load the rest when the user navigates to them or when the list is scrolled into view.

- **Current:** Every book gets `listChaptersPage(book.id, -1, 60)` during bootstrap.
- **Change:** Introduce a cap, e.g. `PRELOAD_BOOKS_MAX = 10`. Run the batched preload only for `loadedBooks.slice(0, PRELOAD_BOOKS_MAX)`. For the rest, set `pagingSeed[book.id] = { afterIndex: -1, hasMore: true, loading: false }` and do **not** call `listChaptersPage` until `loadMoreChapters(book.id)` is called (e.g. when the user opens the book or the UI requests more). Ensure the library list and reader still call `loadMoreChapters` when needed so books beyond the first 10 load on demand.
- **Result:** Cold start runs at most 10 × (batched) listChaptersPage calls; the rest are deferred. Best combined with step 1 (batching).
- **Scope:** Optional follow-up after step 1; can be done in the same PR or later.

**Files:** [src/app/state/useAppBootstrap.ts](src/app/state/useAppBootstrap.ts).

---

## 3. Wait for GIS script load instead of polling (authManager.ts + index.html or bootstrap)

**Goal:** Run auth init once when the Google Identity Services script has loaded, instead of polling every 500 ms up to 20 times.

- **Current:** [authManager.ts](services/authManager.ts) `init()` calls `tryInit()`; if `window.google?.accounts?.oauth2` is missing, it reschedules `tryInit` every 500 ms (up to 20 times). The GIS script is included in [index.html](index.html) with `async defer`, so it loads independently.
- **Change:** Prefer the script’s **load** event over polling:
  - **Option A — Script element onload:** In `init()`, when on web and not native, look up the GIS script tag: `const script = document.querySelector('script[src*="gsi/client"]');`. If found: if `window.google?.accounts?.oauth2` is already present, call `tryInit()` immediately; otherwise register `script.addEventListener('load', () => tryInit(), { once: true })`. If the script is not in the DOM (e.g. SPA without that tag in the shell), fall back to the current polling behavior so init still completes.
  - **Option B — Inject script from JS:** Remove the GIS script from index.html and inject it from authManager (or bootstrap) when `init(clientId)` runs: create a `<script src="https://accounts.google.com/gsi/client" async></script>`, set `script.onload = () => tryInit()`, append to document. Then we never poll; we always wait for onload. Downside: script load starts later (when init runs) unless we inject it very early.
- **Recommendation:** Implement **Option A** so we don’t change when/where the script is loaded; we only avoid polling when the tag exists. In `init()`, after the native/__ANDROID_ONLY__ early returns and before `if (this.tokenClient) return;`: get the script element; if present and GIS not yet available, use `script.addEventListener('load', () => this.tryInitOnce(), { once: true })` and return (no timer). If GIS is already available, call tryInit() and return. If script element is missing, keep the existing setTimeout poll as fallback. Ensure we don’t register multiple load listeners if `init` is called more than once (e.g. only add listener if we haven’t already, or use a one-time flag).
- **Result:** No repeated 500 ms timers when the script is in the page; init runs once when the script loads. Slightly less CPU and timer churn on startup.

**Files:** [services/authManager.ts](services/authManager.ts). Optionally [index.html](index.html) if moving to Option B (inject script from JS).

---

## Implementation order

| Step | Task | File(s) |
|------|------|--------|
| 1 | Add PRELOAD_BATCH_SIZE (e.g. 4); chunk loadedBooks and run listChaptersPage in batches (await Promise.all per batch) | [src/app/state/useAppBootstrap.ts](src/app/state/useAppBootstrap.ts) |
| 2 | (Optional) PRELOAD_BOOKS_MAX cap; preload only first N books, defer rest to loadMoreChapters | [src/app/state/useAppBootstrap.ts](src/app/state/useAppBootstrap.ts) |
| 3 | In authManager.init (web), use script[src*="gsi/client"] onload when present; fallback to existing poll | [services/authManager.ts](services/authManager.ts) |

---

## Verification

- **Bootstrap:** Library still loads all books and chapter counts; first N books (or all, if no cap) have chapters preloaded; opening a book or requesting more chapters still loads data. Cold start shows fewer concurrent DB operations (inspect or profile).
- **Auth (web):** Sign-in still works; GIS init runs when the script loads (no “script not loaded” regression). If the script is slow or blocked, fallback poll still retries; after 20 failures behavior matches current.
- **Native:** No change to native auth or to SQLite bootstrap path; only web auth init and JS-side chapter preload are tuned.

---

## Summary

- **Chapter preload:** Run `listChaptersPage` in batches of 3–5 books at a time instead of all books in parallel, to cut the cold-start I/O spike. Optionally preload only the first 10 books and defer the rest to on-demand load.
- **GIS init:** When the GIS script tag is in the page, wait for its `load` event to run `tryInit()` once instead of polling every 500 ms. Keep the existing poll as fallback when the script tag isn’t found.

No features removed; only concurrency and init timing are adjusted for startup performance.
