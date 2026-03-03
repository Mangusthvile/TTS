# Issue 2: App freezes during autoplay — Audit & implementation plan

## 1. Audit summary

**Symptom:** App freezes (UI jank or unresponsive main thread) when autoplay advances to the next chapter.

**Root causes identified:** Heavy **synchronous** work on the main thread during the autoplay transition, plus large React state updates and (when no cached paragraph map) deferred work that can run in a busy frame.

---

## 2. Autoplay flow (traced)

1. **Chapter ends**  
   Native/desktop fires `ended` or playback reaches end → `loadAndPlayDriveFile` callback runs → `setPlaybackPhase("ENDING_SETTLE")`, `handleChapterEnd(...)`, then `setTimeout(300ms)` → `handleNextChapterRef.current(true)`.

2. **Next chapter chosen**  
   `handleNextChapter(true)` finds next incomplete chapter, shows “Next: Chapter N” notice, calls `loadChapterSession(nextIncomplete.id, "auto")`.

3. **Alternative path (native queue)**  
   When using native queue, `handlePlaybackItemChanged(nextId, prevId)` is called by the adapter; it calls `loadChapterSession(nextId, "auto")` (no 300ms delay).

4. **loadChapterSession** (main freeze hotspot)  
   - `ensureChapterContentLoaded(bookId, chapterId, session)` — async; on completion may call `setState` with full chapter content (large object).
   - Then **all on main thread between awaits**:
     - `buildSpeakTextFromContent(effectiveContent, isMarkdown, allRules, reflow)` — **sync, heavy**: full markdown/plain parsing (`parseMarkdownBlocks` / `parsePlainTextBlocks`) + `applyRulesAndBuildOffsets` over all blocks. Long chapters = long freeze.
     - `getParagraphMap(chapter.id)` — async (IDB/SQLite), not blocking.
     - When no paragraph map: schedule `runDeferred` via `requestIdleCallback(..., { timeout: 3000 })` or `setTimeout(0)`. **`runDeferred`** runs `buildParagraphMap(text, chapterId)` (sync, regex/Intl over full text) then `saveParagraphMap` then `setActiveParagraphMap(built)`. So paragraph map build is deferred but **when it runs it blocks the main thread** (and can coincide with other work).
     - `normalizeChunkMapForChapter` — sync, lightweight.
     - `computeIntroMs`, intro text build — sync, light.
     - Audio: `getAudioFromCache` / `fetchDriveBinary` / `persistChapterAudio` — async.
     - Cue map: `getCueMap(chapter.id)` async; if `needsRebuild`: **`cueMapFromChunkMap`** (light) or **`generateFallbackCueMap`** — **sync, heavy**: `segmentTextForCues(text)` (Intl.Segmenter or regex over full text), then segment splitting/merging and duration distribution. Long text = noticeable block.
     - **Mobile queue build**: loop for up to 20 next chapters; each iteration `await resolveChapterAudioLocalPath`, `getAudioFromCache`, `fetchDriveBinary`, `persistChapterAudio`. All async but **sequential**; no yield between chapters so the main thread is busy coordinating and doing follow-up sync work (e.g. `setState` from cache) for several hundred ms.
     - `speechController.loadAndPlayDriveFile(...)` — async; then `safePlay()` etc.

5. **handleSyncUpdate** (secondary concern)  
   Invoked on every adapter state update (native “state” events + 1s polling while playing). Does `setAudioCurrentTime`, `setPlaybackSnapshot` (throttled 100ms), and `commitProgressUpdate`. `commitProgressUpdate` is throttled (e.g. 1s) and does `setState` (books/chapters update) + `writeProgressStore`. `writeProgressStore` on native triggers async merge/write; sync part is limited. So tick handling is unlikely the **primary** cause of “freeze during autoplay” but can add up if many updates pile up.

---

## 3. Issues list

| # | Location | What | Impact |
|---|----------|------|--------|
| 1 | `usePlayback.ts` → `loadChapterSession` | **buildSpeakTextFromContent** runs synchronously right after content load. Full markdown parse + rules over entire chapter text. | **High** — long chapters (e.g. 50k+ chars) can block main thread for 100–500ms+. |
| 2 | `usePlayback.ts` → `loadChapterSession` | **generateFallbackCueMap** (when cue map missing or invalid) runs synchronously. Intl.Segmenter or regex over full text + segment splitting. | **High** — same long text can add another 50–200ms+ on main thread. |
| 3 | `usePlayback.ts` → paragraph map path | **buildParagraphMap** is deferred via requestIdleCallback/setTimeout but runs **synchronously** when scheduled. If it runs in the same frame as other work (or when UI is animating), it blocks. | **Medium** — deferred helps; when it runs, still a spike. |
| 4 | `usePlayback.ts` → mobile queue | Building queue for up to **20 chapters** in a tight loop with sequential awaits. No explicit yield; React and microtasks run between awaits but no “let the UI paint” break. | **Medium** — can extend “busy” period during transition. |
| 5 | `App.tsx` → **ensureChapterContentLoaded** | When loading from cache/Drive, **setState** with full chapter content (large string + books/chapters tree). Single big React update. | **Medium** — one large re-render; can feel like a hitch when it happens right before/after other work. |
| 6 | **handleSyncUpdate** | Runs on every state tick; **commitProgressUpdate** does setState + writeProgressStore. Throttled but still periodic. | **Low** for “freeze during autoplay”; more relevant for general playback jank. |

---

## 4. In-depth implementation plan

### 4.1 Goal

- Remove or shorten long main-thread blocks during autoplay transition.
- Keep behavior correct: same data (speak text, cue map, paragraph map, queue) available when playback starts; no user-visible regressions.

### 4.2 Strategy

- **Yield to main thread** between heavy steps so the UI can update (e.g. show “Loading…” or progress).
- **Defer heavy sync work** where possible (e.g. run in requestIdleCallback with a short timeout, or after a microtask/yield), then continue once result is ready.
- **Avoid doing two heavy sync ops in a row** without a yield.

---

### 4.3 Plan items

#### P1. Yield before and after `buildSpeakTextFromContent` (usePlayback.ts)

- **Where:** `loadChapterSession`, immediately before and after the call to `buildSpeakTextFromContent(effectiveContent, ...)`.
- **What:**  
  - Before: `await new Promise(r => requestAnimationFrame(r));` or `await Promise.resolve();` so any pending paint runs.  
  - After: same (one more yield).  
- **Why:** Lets the UI show LOADING_AUDIO / loading state and prevents one 100–500ms block from holding the thread alone.  
- **Risk:** Minimal; just adds two microtasks/frames.

#### P2. Defer cue map build when it’s a fallback (usePlayback.ts)

- **Where:** In `loadChapterSession`, when `needsRebuild` is true and we would call `generateFallbackCueMap` (no chunk map or no duration).
- **What:**  
  - If we have `normalizedChunkMap.length > 0` and `introMs`, keep current behavior (cueMapFromChunkMap is light).  
  - If we need **generateFallbackCueMap**:  
    - Option A: Schedule it in `requestIdleCallback(() => { ... }, { timeout: 500 })`, await a wrapper Promise that resolves when the callback runs and build is done; then continue with `setActiveCueMap` etc.  
    - Option B: `await Promise.resolve();` then build (at least one yield), then continue.  
  - Prefer Option A so the heavy fallback runs in an idle chunk; Option B is a minimal change.  
- **Why:** generateFallbackCueMap can be 50–200ms+ on long text; deferring or yielding avoids stacking it with buildSpeakTextFromContent.  
- **Risk:** Slightly more complex control flow; must ensure we don’t call loadAndPlayDriveFile before cue map is ready (we already use cue map for highlight sync).

#### P3. Yield between mobile queue chapters (usePlayback.ts)

- **Where:** In the loop that builds `queueItems` (up to 20 chapters), after every N chapters (e.g. 3 or 5).  
- **What:** `await Promise.resolve();` or `await new Promise(r => requestAnimationFrame(r));` every 3–5 iterations.  
- **Why:** Prevents one long sequential chain from blocking; allows UI to update during preload.  
- **Risk:** Very low.

#### P4. Optional: yield after ensureChapterContentLoaded setState (App.tsx)

- **Where:** In `ensureChapterContentLoaded`, after each `setState` that injects full chapter content (memory cache hit, local DB hit, file read, Drive fetch).  
- **What:** After the setState, `await Promise.resolve();` before returning so React can commit and paint.  
- **Why:** Large setState can cause a big re-render; yielding once after it helps the next work (e.g. loadChapterSession continuation) not run in the same frame.  
- **Risk:** Low; might need to ensure callers don’t assume synchronously updated state in the very next line (they’re async anyway).

#### P5. Paragraph map: keep deferral, optional chunking (highlightMaps.ts / usePlayback)

- **Current:** Already deferred with requestIdleCallback/setTimeout; when it runs, buildParagraphMap is sync.  
- **Optional improvement:** In `buildParagraphMap` / `buildParagraphsFromBlankLines` (and HTML path), process in chunks (e.g. by paragraph or by 50k chars), yielding every chunk with `await Promise.resolve();` if we make the builder async. **Larger change**; only do if profiling shows paragraph map as a major spike.  
- **Simpler:** Ensure paragraph map deferred callback has a **timeout** so it doesn’t run in the middle of a critical transition (e.g. timeout already 3000ms); consider reducing to 500–1000ms so it runs sooner but in a more controlled window. No code change required for “reduce freeze” unless we see paragraph map in profiles.

#### P6. Trace / diagnostics (optional)

- Add short trace spans (e.g. `trace("perf:buildSpeakText", { ms })`) around buildSpeakTextFromContent and generateFallbackCueMap so we can confirm improvements and spot regressions.  
- No product behavior change.

---

### 4.4 Implementation order

1. **P1** — Yield before/after buildSpeakTextFromContent (small, clear win).  
2. **P3** — Yield every 3–5 chapters in mobile queue build (small, low risk).  
3. **P2** — Defer or yield around generateFallbackCueMap (biggest remaining sync block).  
4. **P4** — Optional yield after setState in ensureChapterContentLoaded.  
5. **P5** — Only if profiling shows paragraph map as a problem.  
6. **P6** — Optional tracing.

---

### 4.5 Testing

- **Manual:** Autoplay through 3–5 chapters on a mid-range device; confirm no multi-second freezes; “Loading…” or transition should be visible.  
- **Regression:** Playback still starts correctly; cue map and paragraph map still used for highlights; progress and completion unchanged.  
- **Unit:** Any existing tests for loadChapterSession / ensureChapterContentLoaded still pass (behavior unchanged; only timing/yields added).

---

### 4.6 Files to touch

| File | Changes |
|-----|--------|
| `src/app/state/usePlayback.ts` | P1 (yield before/after buildSpeakTextFromContent), P2 (defer/yield fallback cue map), P3 (yield in queue loop), optional P6. |
| `App.tsx` | P4 (yield after setState in ensureChapterContentLoaded). |
| `services/highlightMaps.ts` | P5 only if we add async/chunked paragraph build. |
| `utils/trace.ts` | P6 if we add perf traces. |

---

## 5. Summary

- **Primary cause of “freeze during autoplay”:** Long synchronous work in **loadChapterSession**: **buildSpeakTextFromContent** and **generateFallbackCueMap**, with mobile queue build and large setState as contributing factors.
- **Plan:** Add yields (and optionally defer fallback cue map build) so the main thread can paint between steps; keep all logic and data flow the same. Implement P1 and P3 first for quick wins, then P2 for the other major sync block.
