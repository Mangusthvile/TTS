# Why Progress Still Resets: The Software Issue (Not a Bug)

This is an **architectural / design issue**, not a random bug. Here’s what’s going on.

---

## 1. How the system is designed

- **SQLite** (native) = durable source of truth. It survives process kill and app restart.
- **localStorage** (and in-memory state) = session cache. On Android it can be cleared by the OS; it is not durable.
- **Flow today:**
  1. **Startup:** We “hydrate”: read from SQLite → merge with localStorage → write result **into localStorage**. Then we set `progressStoreHydrated = true` and build the UI from `readProgressStore()` (which reads **localStorage**).
  2. **During session:** We update localStorage (and React state) every tick; we only write to SQLite on pause/end/background and every 45s.
  3. **Flush:** `flushProgressStoreToDurable()` reads **localStorage** and writes it to SQLite.

So: **the only way the UI ever sees SQLite data is step 1.** After that, the app treats localStorage as the source of truth and only _pushes_ from localStorage → SQLite.

---

## 2. The actual problem: “success” without loading SQLite

We **always** call `setProgressStoreHydrated()` after `hydrateProgressFromDurable()` and `hydrateProgressFromIndexedDB()`, **even when the SQLite read failed or returned nothing.**

What happens in practice:

1. **Cold start (e.g. after process kill):**
   - `hydrateProgressFromDurable()` runs.
   - It calls `readChapterProgressDurable()` (read from SQLite).
   - If the **first** DB access fails (connection not ready, “connection already exists”, timeout, etc.), we **catch** and do “keep localStorage as-is”. We do **not** write any SQLite data into localStorage.
   - So localStorage stays **empty** (or old).
   - We do **not** rethrow, so bootstrap continues.
   - We then call **`setProgressStoreHydrated()`** anyway.
   - Bootstrap builds books from `readProgressStore()` → reads **localStorage** → gets empty → UI shows 0%.
   - Later: 45s timer, or pause, or app background runs **`flushProgressStoreToDurable()`**.
   - That function **reads localStorage** (empty) and **writes it to SQLite**.
   - So we **overwrite good SQLite data with empty**. Progress is “reset” even though the failure was at startup, not during playback.

So the **software issue** is: **we treat “hydration ran” as “we have loaded from durable storage.”** We don’t. If the SQLite read fails or returns empty, we never put that data into localStorage, but we still unlock writes and later flush localStorage → SQLite, which can overwrite real progress with empty.

---

## 3. Why the SQLite read might fail on startup

- **Zombie connection:** After a hard refresh or reload, the native SQLite connection can be in a bad state (“connection already exists” or JS/native out of sync). The first `getSqliteDb` / `dbQuery` can fail or throw.
- **Timing:** The first access to the DB happens inside `hydrateProgressFromDurable()`. If that runs before the connection layer is really ready, the read can fail.
- **Errors are swallowed:** In `readChapterProgressDurable()` and `hydrateProgressFromDurable()` we use try/catch and return null or “keep localStorage as-is.” So the rest of the app never knows that we **did not** load from SQLite.

So: **one failed or empty read at startup** leads to empty localStorage, then later to **one flush that overwrites SQLite with empty**. That’s why it’s not “a bug” in one line, but a **design issue**: we don’t distinguish “hydration ran” from “hydration actually loaded durable data,” and we allow flushes to overwrite SQLite even when we never successfully read from it.

---

## 4. What needs to change (in short)

- **On native:** Only set **`progressStoreHydrated = true`** when we have **actually loaded** from SQLite (e.g. `readChapterProgressDurable()` returned a non-empty result), or after a deliberate retry. If the read failed or returned empty, we should **not** unlock writes (so we never flush empty localStorage into SQLite), and optionally retry the read or surface a “progress couldn’t be loaded” state.
- **Flush behavior:** Optionally, in `flushProgressStoreToDurable()`, on native, if we have never successfully hydrated (e.g. a “durable load succeeded” flag), we could skip the flush or merge with SQLite first instead of overwriting. The minimal fix is: **don’t set hydrated when the native durable read didn’t succeed**, so we never open the door to flushing empty into SQLite.

That’s the cause (failed or empty SQLite read at startup + unconditional hydrated flag + flush overwrites SQLite), and the direction for a fix.
