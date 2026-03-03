# Issue 4: Autoplay transition errors (high priority) — Audit & implementation plan

## 1. Audit summary

**Symptom:** Errors, stuck states, or inconsistent behaviour when autoplay advances from one chapter to the next (e.g. duplicate loads, wrong chapter, loading never clears, or generic “transition” failures).

**Root causes identified:** (1) **Duplicate load** when both native `itemChanged` and the delayed `handleNextChapter(true)` run for the same next chapter. (2) **Session and phase** are mostly correct, but a few edge paths can leave UI or phase out of sync. (3) **Preload and retry** logic is present (one retry for missing content/audio/load failure) but could be clearer and more robust. (4) **Error messaging** could better distinguish “no text” vs “no audio” vs “load threw” for autoplay.

---

## 2. Autoplay transition flow (traced)

### 2.1 Chapter end → next chapter start

1. **Track ends**  
   Native adapter fires `onEnded`, or desktop `ended` on `<audio>`.  
   - **speechService:** `onEnded` listener runs → `emitSyncTick(true)`, `commitLocalProgress(true, "ended")`, `stopSyncLoop()`, then `setTimeout(() => onEndCallback?.(), 0)`.  
   - So **onEndCallback** (the `onEnd` passed from usePlayback) runs on the next tick.

2. **onEnd callback (usePlayback)**  
   In `loadChapterSession` we pass:
   ```ts
   onEnd: () => {
     if (session === chapterSessionRef.current) {
       setPlaybackPhase("ENDING_SETTLE");
       handleChapterEnd(chapter.id, totalChars, totalChars, { timeSec, durationSec });
       setTimeout(() => {
         if (session === chapterSessionRef.current) {
           handleNextChapterRef.current(true);
         }
       }, 300);
     }
   }
   ```
   So we set **ENDING_SETTLE**, commit chapter end progress, then after **300 ms** call **handleNextChapter(true)**.

3. **handleNextChapter(true)**  
   - Guards: not if `isUserScrubbingRef.current` or `seekTxnRef.current.inFlight`.  
   - Finds next incomplete chapter (or next chapter for manual), shows “Next: Chapter N” (or “Moving onto [volume]”), then calls **loadChapterSession(nextIncomplete.id, "auto")** (or next.id for manual).  
   - If no next chapter: sets phase **IDLE**, “End of book”.

4. **Native queue path (alternative)**  
   When using **loadQueue** (mobile/native), the adapter may advance to the **next item** when the current track ends. That triggers **onItemChanged(nextItem)**.  
   - **speechService:** `itemChangedCallback(nextId, prevId)` is invoked.  
   - **usePlayback:** `handlePlaybackItemChanged(nextId, _prevId)` runs: if `book.currentChapterId === nextId` it returns; else sets **itemChangeInFlightRef.current = nextId** and calls **loadChapterSession(nextId, "auto")**, clearing the ref in `.finally()`.

So we have **two possible triggers** for “load next chapter” on native with queue:

- **A.** `onEnded` → onEnd → 300 ms later → **handleNextChapter(true)** → **loadChapterSession(nextId, "auto")**  
- **B.** Native advances item → **itemChanged(nextId)** → **handlePlaybackItemChanged** → **loadChapterSession(nextId, "auto")**

If both fire (order can vary), we can call **loadChapterSession** for the **same** next chapter **twice**: once from (B) and once from (A) 300 ms later. Both run; the first may still be in progress (e.g. `ensureChapterContentLoaded` or building queue). The second increments **chapterSessionRef**, so the first load will later see `session !== chapterSessionRef.current` and bail at various checks—but we still do **duplicate work** and risk **double loadAndPlayDriveFile** or UI flicker.

### 2.2 loadChapterSession (usePlayback.ts)

- **Entry:** `setIsLoadingChapter(true)`, `setPlaybackPhase("LOADING_TEXT")`, increment session, `onSessionChange?.(session)`, `speechController.safeStop()`, `nextChapterPreloadRef.current = null`.
- **Content:** `ensureChapterContentLoaded(book.id, chapter.id, session)`. If session changed, return and `setIsLoadingChapter(false)`. If no content: **autoplay** and **attempt === 1** → “Retrying next chapter…”, wait 1.5 s, then **loadChapterSession(targetChapterId, "auto", 2)**; else push notice and stop.
- **Audio:** Resolve `playbackUrl` (cache, Drive, persist). If no URL: same **one retry** for autoplay (attempt 1) then “Audio not found. Try generating it.” and **setPlaybackPhase("READY")**, **setIsPlaying(false)**, **setIsLoadingChapter(false)**.
- **Cue map:** Build/load; on failure only log (no hard stop).
- **Queue:** Build mobile queue (up to 20 chapters) when using local/native audio.
- **Play:** `speechController.loadAndPlayDriveFile(..., onEnd, onPlayStart, ..., mobileQueue, 0)`.  
  - **On throw:** if autoplay and attempt === 1, retry once (1.5 s delay, then **loadChapterSession(..., "auto", 2)**); else set phase **READY**, **setIsPlaying(false)**, push error, **setIsLoadingChapter(false)**.
- **After loadAndPlayDriveFile success:** if session changed, return and **setIsLoadingChapter(false)**. If mobile autoplay and `!canAutoPlay()`, set autoplay blocked and **setIsLoadingChapter(false)**. Then **safePlay()**: if **"blocked"**, set autoplay blocked and phase **READY**; else set playing and phase **PLAYING_BODY**. **setIsLoadingChapter(false)** at end of callback (all paths).

So: **one retry** for (1) missing content, (2) no playback URL, (3) loadAndPlayDriveFile throw. After retry we stop with a notice. All early returns and the final path call **setIsLoadingChapter(false)**.

### 2.3 ensureChapterContentLoaded (App.tsx)

- Uses **chapterTextInFlightRef** to coalesce concurrent calls for the same `bookId:chapterId`.  
- Returns **string | null**. On failure or missing data, returns **null** (caller handles retry/notice).  
- **finally** always deletes the in-flight promise, so no leak.

### 2.4 Preload (handleSyncUpdate)

- When **PLAYING_BODY**, duration &gt; 60 s, and &lt; 2 min left, we set **nextChapterPreloadRef.current = chapterId** and call **ensureChapterContentLoaded(b.id, next.id, chapterSessionRef.current)**.  
- So next chapter text is loaded in the background; when **loadChapterSession(next.id)** runs it may get content from cache/state. Session is passed so preload can abort if session changed; key is per chapter so no cross-chapter mix-up.

---

## 3. Issues list

| # | Location | What | Impact |
|---|----------|------|--------|
| 1 | **itemChanged vs handleNextChapter** | On native with queue, both **itemChanged(nextId)** and **handleNextChapter(true)** (300 ms after onEnd) can run. Both call **loadChapterSession(nextId, "auto")** with no check that we’re already loading that chapter. | **High** — duplicate work, two in-flight loads, possible double **loadAndPlayDriveFile**, session thrash, UI/state flicker. |
| 2 | **No “loading chapter id” guard** | We set **setIsLoadingChapter(true)** but don’t store **which** chapter we’re loading. So we can’t skip a second **loadChapterSession** for the same id. | **High** — enables duplicate load (above). |
| 3 | **Retry only once** | We retry once (attempt 2) for missing content, no URL, or load throw. Transient network/Drive errors may need more than one retry for a smooth experience. | **Medium** — user may see “Autoplay stopped” after a single transient failure. |
| 4 | **Error messages** | “Retrying next chapter…” is generic. After final failure we have “missing chapter text”, “Audio not found”, or “Audio load failed”. Could be clearer (e.g. “No text for Chapter N”, “No audio for Chapter N”). | **Low** — UX clarity. |
| 5 | **safePlay() "blocked"** | When **safePlay()** returns **"blocked"** we set **setPlaybackPhase("READY")**, **setAutoplayBlocked(true)**, **setIsPlaying(false)**. We do **setIsLoadingChapter(false)** at the end of the callback (line 1555), so loading is cleared. No bug. | — |
| 6 | **ENDING_SETTLE** | Set in onEnd; 300 ms later we call handleNextChapter which either starts **loadChapterSession** (→ **LOADING_TEXT**) or sets **IDLE** (end of book). So we don’t get stuck in ENDING_SETTLE. | — |
| 7 | **Preload session** | Preload uses **chapterSessionRef.current**; if user switches book/chapter we may still complete preload for the previous next chapter. Content is keyed by bookId:chapterId so we don’t apply it to the wrong chapter. Acceptable. | **Low** |

---

## 4. In-depth implementation plan

### 4.1 Goal

- **No duplicate load** for the same chapter during autoplay transition.  
- **Clear, consistent state** (phase, loading flag, current chapter) after success or failure.  
- **Better resilience** and clearer messages for autoplay errors (optional: extra retry or backoff).

### 4.2 Strategy

- **Coalesce** duplicate **loadChapterSession** for the same chapter: track “currently loading chapter id” and skip (or re-use) a second request for the same id.  
- **Keep** existing retry-once behaviour; optionally add one more retry or a short backoff for autoplay.  
- **Tighten** error messages for autoplay so “no text” vs “no audio” vs “load failed” are explicit.

---

### 4.3 Plan items

#### P1. Coalesce duplicate loadChapterSession by chapter id (usePlayback.ts)

- **Where:** Start of **loadChapterSession**, and when the callback completes (all exit paths).
- **What:**  
  - Add a ref, e.g. **loadingChapterIdRef** (or reuse/align with existing refs), set to **targetChapterId** at the very start of **loadChapterSession**.  
  - At the **very start** of **loadChapterSession**, before incrementing session:  
    - If **loadingChapterIdRef.current === targetChapterId**, **return** immediately (no-op). Optionally trace “chapter:load:skipped:already_loading”, { targetChapterId }).  
  - In a **finally** block at the end of the **loadChapterSession** callback (or on every return path), set **loadingChapterIdRef.current = null** (so we clear it when we’re done, whether we succeeded, failed, or bailed on session mismatch).  
- **Why:** When both **itemChanged** and **handleNextChapter** fire for the same next chapter, the second call will see “already loading this id” and skip, avoiding duplicate work and double **loadAndPlayDriveFile**.  
- **Risk:** Low. We only skip when the same chapter id is already being loaded; we always clear the ref when the load finishes.

#### P2. (Optional) Prefer itemChanged over handleNextChapter for queue

- **Where:** **handleNextChapter(true)** when we’re about to call **loadChapterSession(nextIncomplete.id, "auto")**.  
- **What:** If **itemChangeInFlightRef.current === nextIncomplete.id**, skip calling **loadChapterSession** (we already started it from **handlePlaybackItemChanged**).  
- **Why:** Reduces duplicate work when both fire; we rely on the itemChanged path to have already started the load.  
- **Risk:** Low. Complements P1; with P1 we could still do this for clarity.

#### P3. Ensure loading ref cleared on every exit (usePlayback.ts)

- **Where:** **loadChapterSession** — every return and the normal end.  
- **What:** Use a single **finally** block that runs after the entire async body (and all inner returns) so that **loadingChapterIdRef.current = null** is always executed. Ensure no return path bypasses it (e.g. wrap the whole callback body in try/finally).  
- **Why:** Prevents “stuck” state where we think we’re still loading a chapter after an early return or throw.  
- **Risk:** None if we add a try/finally correctly.

#### P4. (Optional) Second retry or backoff for autoplay

- **Where:** **loadChapterSession** — when we currently do “attempt === 1” retry for missing content, no URL, or loadAndPlayDriveFile throw.  
- **What:** For **reason === "auto"** only, allow **attempt === 2** to retry once more (attempt 3) after a delay (e.g. 2 s), then stop with notice. Or keep single retry but increase delay to 2 s for attempt 2.  
- **Why:** Transient failures (e.g. Drive/network) sometimes resolve on a second or third try.  
- **Risk:** Slight delay before showing “Autoplay stopped”; acceptable if we cap at 2 retries total.

#### P5. Clearer autoplay error messages (usePlayback.ts)

- **Where:** Push notices when autoplay stops: missing content, no playback URL, loadAndPlayDriveFile throw.  
- **What:** Use distinct messages, e.g.:  
  - No content: “Autoplay stopped: no text for [Chapter N]. Run Fix Integrity or re-import.”  
  - No URL: “Autoplay stopped: no audio for [Chapter N]. Generate or download audio.”  
  - Load throw: “Autoplay stopped: couldn’t load audio for [Chapter N]. Check connection and try again.”  
  Include chapter label (title or “Chapter N”) where possible.  
- **Why:** User can tell whether the problem is text, audio, or load/network.  
- **Risk:** None.

#### P6. Trace / diagnostics (optional)

- **Where:** **loadChapterSession** and **handlePlaybackItemChanged** / **handleNextChapter**.  
- **What:** Add trace events, e.g. **chapter:load:skip:already_loading**, **chapter:load:start** (existing), **chapter:load:retry**, **chapter:load:done**, **chapter:load:fail**.  
- **Why:** Easier to debug transition races and retries.  
- **Risk:** None.

---

### 4.4 Implementation order

1. **P1** — Add **loadingChapterIdRef**, skip at start when already loading same id, set ref at start and clear in **finally**.  
2. **P3** — Ensure **finally** runs on every exit (ref clear).  
3. **P2** — (Optional) In **handleNextChapter(true)**, skip **loadChapterSession** when **itemChangeInFlightRef.current === nextIncomplete.id**.  
4. **P5** — Clarify autoplay stop messages.  
5. **P4** — (Optional) Add second retry or longer delay for autoplay.  
6. **P6** — (Optional) Add trace events.

---

### 4.5 Files to touch

| File | Changes |
|------|--------|
| **src/app/state/usePlayback.ts** | P1: loadingChapterIdRef, guard at start, clear in finally. P2: skip load in handleNextChapter when itemChangeInFlightRef matches. P3: ensure finally. P4: optional second retry. P5: message strings. P6: optional trace. |

---

### 4.6 Code-level sketch (P1 + P3)

- Add ref:  
  `const loadingChapterIdRef = useRef<string | null>(null);`  
  (and pass or expose if needed; if usePlayback is the only caller, keep local.)

- Start of **loadChapterSession**:  
  ```ts
  if (loadingChapterIdRef.current === targetChapterId) {
    trace("chapter:load:skip:already_loading", { targetChapterId });
    return;
  }
  loadingChapterIdRef.current = targetChapterId;
  const session = ++chapterSessionRef.current;
  // ... rest
  ```

- Wrap the entire async body of **loadChapterSession** in:  
  ```ts
  try {
    // existing body (all returns stay inside try)
  } finally {
    loadingChapterIdRef.current = null;
  }
  ```  
  Ensure every return path is inside this try (so finally always runs). The existing **setIsLoadingChapter(false)** can stay where it is; the ref clear in **finally** is the single place we clear “loading chapter id”.

---

## 5. Summary

- **Main cause of “autoplay transition errors”:** **Duplicate loadChapterSession** when both **itemChanged** and **handleNextChapter** run for the same next chapter, causing duplicate work, possible double **loadAndPlayDriveFile**, and session/UI thrash.  
- **Fix:** **P1** — Track “currently loading chapter id” and skip a second **loadChapterSession** for the same id; clear the ref in **finally** so we never leave it set. **P3** — Ensure **finally** runs on every exit. **P2** (optional) — In **handleNextChapter**, skip starting a load when **itemChangeInFlightRef** already matches the next chapter. **P5** — Clearer autoplay error messages. **P4** (optional) — One more retry or longer delay for autoplay.
