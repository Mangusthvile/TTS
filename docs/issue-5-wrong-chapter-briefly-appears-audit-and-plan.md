# Issue 5: Wrong chapter briefly appears when opening a chapter — Audit & implementation plan

## 1. Audit summary

**Symptom:** When the user opens a chapter (e.g. taps a chapter in the sidebar or library), the **previous** chapter’s title/metadata (and sometimes content) is shown briefly before the **requested** chapter appears.

**Root cause:** **currentChapterId** is updated only **after** content (and audio) are loaded in **loadChapterSession**. Until then, the Reader is driven by the **previous** `currentChapterId`, so it displays the previous chapter’s metadata and, until loading state was fixed, could show that chapter’s content. So the “wrong chapter” is the **previously open** chapter, visible for the whole duration of the load.

**Existing mitigation:** When **isLoadingChapter** is true, App passes **chapterText=""**, **readerBlocks=[]**, and **contentLoading=true** to the Reader, and ReaderList shows “Loading…” when there are no blocks and **contentLoading** is true. That hides **content** from the wrong chapter but does **not** fix the **header/title**: the Reader still receives **chapter={activeChapterMetadata}**, and **activeChapterMetadata** is derived from **activeBook.currentChapterId**, which stays the old chapter until **loadChapterSession** updates it late.

---

## 2. Flow (traced)

### 2.1 Opening a chapter (user tap)

1. **handleSmartOpenChapter(id)** (App.tsx)  
   - Resolves book and **clickedChapter** (the chapter the user tapped).  
   - Optionally restores scroll if re-opening the same chapter.  
   - **setActiveTab("reader")** — switches to the reader tab **immediately**.  
   - If clicked chapter is completed, may redirect to next incomplete and call **loadChapterSession(nextIncomplete.id, "user")**; otherwise **loadChapterSession(id, "user")**.  
   - **No** update to **currentChapterId** here. So at this moment **activeBook.currentChapterId** is still the **previous** chapter (e.g. ch1).

2. **Reader mounts / re-renders**  
   - **activeChapterMetadata** = `activeBook?.chapters.find((c) => c.id === activeBook.currentChapterId)` → still the **previous** chapter.  
   - **activeChapterText** = that chapter’s content (or cache).  
   - **activeReaderModel** = buildReaderModel(activeChapterText, …).  
   - So the Reader shows **previous chapter’s** metadata (title, etc.) and, before the loading-state fix, could show its content.

3. **loadChapterSession(targetChapterId, "user")** runs  
   - **setIsLoadingChapter(true)**, **setPlaybackPhase("LOADING_TEXT")**.  
   - **await ensureChapterContentLoaded(book.id, targetChapterId, session)** — can take hundreds of ms or more.  
   - Only **after** content is available does **loadChapterSession** do **setState({ … books: [… currentChapterId: targetChapterId ], currentOffsetChars: 0 })** (usePlayback.ts ~1155–1161).  
   - So for the **entire** load (and optionally until audio is ready), **currentChapterId** remains the old one. The UI shows: **previous chapter’s title** + “Loading…” (content is hidden by **contentLoading** and empty blocks).

### 2.2 Other entry points

- **Nav restore:** **setActiveTab("reader")** then **loadChapterSession(pending.chapterId, "user")**. Same as above: **currentChapterId** is not set until late in **loadChapterSession**.  
- **Autoplay / itemChanged:** **loadChapterSession(nextId, "auto")** — same internal behaviour; **currentChapterId** is updated only after content (and the rest of the load) is done.

### 2.3 Where Reader gets its chapter

- **App.tsx:**  
  - **activeChapterMetadata** = chapter for **activeBook.currentChapterId**.  
  - **Reader** receives **chapter={activeChapterMetadata}**, **chapterText**, **readerBlocks**, **contentLoading**.  
- So whatever **currentChapterId** is, that’s the chapter (title, index, etc.) the Reader shows. Content is either that chapter’s text/blocks or, when **contentLoading** and empty blocks, “Loading…”.

---

## 3. Issues list

| # | Location | What | Impact |
|---|----------|------|--------|
| 1 | **loadChapterSession** (usePlayback.ts) | **currentChapterId** is set only in the **middle** of the flow (after content is loaded, ~line 1155). Until then, **activeBook.currentChapterId** is still the previous chapter. | **High** — Reader shows **previous chapter’s title/metadata** for the whole load. |
| 2 | **handleSmartOpenChapter** (App.tsx) | Switches to reader tab and calls **loadChapterSession** but does **not** set **currentChapterId** to the tapped chapter. Relying on **loadChapterSession** to update it late. | **High** — Same as above; enables the wrong-chapter header. |
| 3 | **Content loading state** (existing) | When **isLoadingChapter**, App passes empty **chapterText**/ **readerBlocks** and **contentLoading=true**; ReaderList shows “Loading…” when no blocks and **contentLoading**. So **content** from the wrong chapter is already hidden. | **Mitigation** — Only content; title/header still wrong. |
| 4 | **activeReaderModel** (App.tsx) | Derived from **activeChapterText** and **activeChapterMetadata**. When **currentChapterId** is old, **activeChapterMetadata** is old, so any non-empty content would be for the old chapter. With **contentLoading** and empty blocks we avoid showing it. | **Addressed** by loading state; header still needs **currentChapterId** fix. |

---

## 4. In-depth implementation plan

### 4.1 Goal

- As soon as we **start** loading a chapter, the UI should show that **chapter’s** metadata (title, number) and a loading state, not the previous chapter.
- No change to success/failure behaviour; only the **timing** of when **currentChapterId** is updated.

### 4.2 Strategy

- Update **currentChapterId** to the **target** chapter at the **start** of **loadChapterSession**, right after we know the book and chapter exist and have set the loading phase, so the very next render shows the correct chapter with “Loading…”.

---

### 4.3 Plan items

#### P1. Set currentChapterId at start of loadChapterSession (usePlayback.ts)

- **Where:** **loadChapterSession**, immediately after **setPlaybackPhase("LOADING_TEXT")** and **trace("chapter:load:start", …)** (and after **nextChapterPreloadRef.current = null**, **speechController.safeStop()**, **setAutoplayBlocked(false)** if desired), and **before** **await ensureChapterContentLoaded(...)**.
- **What:**  
  - Call **setState** to set **currentChapterId** to **targetChapterId** for the active book, and **currentOffsetChars** to **0** (so progress/slider reflect “starting this chapter” during load).  
  - Example:  
    `setState((p) => ({ ...p, books: p.books.map((b) => b.id === book.id ? { ...b, currentChapterId: targetChapterId } : b), currentOffsetChars: 0 }));`  
  - Leave the **later** **setState** (after content, ~1155) as is; it already sets **currentChapterId** and **currentOffsetChars** again — redundant but harmless.
- **Why:** The next React render will have **activeChapterMetadata** = the **target** chapter, so the Reader shows the correct title/header and “Loading…” (because **isLoadingChapter** is true and we pass empty blocks and **contentLoading**).
- **Risk:** Low. If **loadChapterSession** later fails (e.g. no content, no audio), we already show notices and **setIsLoadingChapter(false)**; the user still sees the chapter they asked for (with error/empty state), which is correct.

#### P2. (Optional) Reset playback snapshot for target chapter

- **Where:** Same early block in **loadChapterSession** (with P1).  
- **What:** **setPlaybackSnapshot(null)** or **setPlaybackSnapshot({ chapterId: targetChapterId, percent: 0 })** so the player/progress UI doesn’t show the previous chapter’s position.  
- **Why:** Avoids a brief wrong-chapter percent or position in the player.  
- **Risk:** Low. Currently **setPlaybackSnapshot(null)** is done later (~1166); moving or duplicating it here is safe.

#### P3. Keep content loading behaviour (no code change)

- **What:** Keep passing **chapterText=""**, **readerBlocks=[]**, and **contentLoading=true** when **isLoadingChapter**, and ReaderList showing “Loading…” when there are no blocks and **contentLoading**.  
- **Why:** Ensures we never flash the previous chapter’s **content** even if something else was wrong.  
- **Risk:** None.

#### P4. Nav restore / handleSmartOpenChapter (no change required)

- **What:** No need to set **currentChapterId** in App before calling **loadChapterSession**. **loadChapterSession** will set it at the start (P1).  
- **Why:** Keeps a single place that “opens” a chapter (usePlayback) and avoids duplicate logic.  
- **Risk:** None.

---

### 4.4 Implementation order

1. **P1** — In **loadChapterSession**, right after setting phase and before **ensureChapterContentLoaded**, add **setState** to set **currentChapterId** to **targetChapterId** and **currentOffsetChars** to **0**.  
2. **P2** — (Optional) Set **setPlaybackSnapshot(null)** (or snapshot for target chapter) in the same early block.  
3. **P3** — No change; confirm existing loading behaviour.  
4. **P4** — No change.

---

### 4.5 Files to touch

| File | Changes |
|------|--------|
| **src/app/state/usePlayback.ts** | P1: early **setState** in **loadChapterSession** to set **currentChapterId** and **currentOffsetChars**. P2 (optional): **setPlaybackSnapshot** in same block. |

---

### 4.6 Code-level sketch (P1)

**Current (simplified):**
```ts
setPlaybackPhase("LOADING_TEXT");
trace("chapter:load:start", { targetChapterId, reason, session, attempt });
nextChapterPreloadRef.current = null;
speechController.safeStop();
setAutoplayBlocked(false);
const content = await ensureChapterContentLoaded(book.id, chapter.id, session);
// ... later ...
setState((p) => ({
  ...p,
  books: p.books.map((b) =>
    b.id === book.id ? { ...b, currentChapterId: targetChapterId } : b
  ),
  currentOffsetChars: 0,
}));
```

**After P1:** Insert right after **setAutoplayBlocked(false)** (and before **ensureChapterContentLoaded**):
```ts
setState((p) => ({
  ...p,
  books: p.books.map((b) =>
    b.id === book.id ? { ...b, currentChapterId: targetChapterId } : b
  ),
  currentOffsetChars: 0,
}));
setPlaybackSnapshot(null);  // P2 optional
```
Keep the existing **setState** later (after content) as is.

---

## 5. Summary

- **Why the wrong chapter appears:** **currentChapterId** is updated only **after** content (and the rest of the load) in **loadChapterSession**, so the Reader keeps showing the **previous** chapter’s metadata (and, before loading state, its content) for the whole load.  
- **Fix:** **P1** — Set **currentChapterId** (and **currentOffsetChars**) at the **start** of **loadChapterSession**, right after setting the loading phase and before **ensureChapterContentLoaded**. Then the next render shows the **target** chapter’s title with “Loading…”. **P2** (optional): clear or set **playbackSnapshot** in the same block so the player doesn’t show the previous chapter’s position. **P3** — Keep existing **contentLoading** and empty blocks so wrong content never flashes.
