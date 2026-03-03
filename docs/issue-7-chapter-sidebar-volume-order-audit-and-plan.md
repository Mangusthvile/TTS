# Issue 7: Chapter sidebar not sorted by volume order — Audit & implementation plan

## 1. Audit summary

**Symptom:** The chapter sidebar does not respect the user’s volume order (e.g. custom order from Organize mode or `book.settings.volumeOrder`), so volumes appear in the wrong order or in a fallback order instead of the saved one.

**Root causes identified:** (1) **Case-sensitive matching** — Volume order is applied by exact string match between `volumeOrder` and group `volumeName`. If casing differs (e.g. `volumeOrder` has `"Volume 1"` but chapters use `"volume 1"` from import/Drive), the group is treated as “not in list” and sorted by fallback only. (2) **Consistency** — ChapterFolderView (BookState) uses the same case-sensitive logic; Drive folder resolution uses case-insensitive matching elsewhere, so volume names can end up with different casing. (3) **Fallback** when volumeOrder is missing or doesn’t match is correct (Ungrouped last, then volume number, then name).

---

## 2. Flow (traced)

### 2.1 ChapterSidebar (components/ChapterSidebar.tsx)

- **Input:** `book` (with `book.chapters`, `book.settings?.volumeOrder`).
- **volumeGroups useMemo:**
  1. Group chapters by **volumeName** (trimmed); empty/missing → **"Ungrouped"**.
  2. Build **parsed** array: `{ volumeName, volumeNumber, chapters }` (chapters sorted by `index`).
  3. If **book.settings?.volumeOrder** is a non-empty array:
     - Build **orderIndex** `Map`: `volumeOrder.forEach((name, idx) => orderIndex.set(name.trim(), idx))` (only if `name.trim()` is truthy).
     - Sort **parsed**:
       - Both in **orderIndex** → sort by index.
       - Only **a** in → a first.
       - Only **b** in → b first.
       - Neither in → Ungrouped last, then **volumeNumber**, then **volumeName** localeCompare.
  4. Else (no volumeOrder): sort by Ungrouped last, volume number, name.
- **Lookup:** `orderIndex.has(a.volumeName)` and `orderIndex.get(a.volumeName)` use **exact** string match. So **"Volume 1"** ≠ **"volume 1"**.

### 2.2 BookState (src/features/library/BookState.ts)

- **volumeSections** useMemo: groups by **volumeName** (trimmed), builds **volumes** array, then applies **explicitOrder** from `book.settings?.volumeOrder` (trimmed, non-empty).
- **explicitOrderMap**: `explicitOrder.forEach((name, idx) => explicitOrderMap.set(name, idx))` — again exact match.
- Sort: `explicitOrderMap.has(a.volumeName)` / `get(a.volumeName)` — **case-sensitive**.
- Used by **ChapterFolderView** for the main book/chapter list and organize mode.

### 2.3 Where volumeOrder comes from

- **book.settings.volumeOrder** — set when user reorders volumes in Organize mode (ChapterFolderView: **reorderVolumes**, **upsertBookSettings({ volumeOrder: ... })**), or from Drive sync / buildVolumeOrderFromDriveSync (App.tsx), or from save/restore.
- **Persistence:** Stored in book settings (libraryStore, SQLite, IDB). So if the book is loaded with settings, **volumeOrder** should be present.

### 2.4 Where volumeName comes from on chapters

- Set on import (Extractor, volume detection), Drive sync (inventory meta), or Organize (rename volume, move chapter). Can be **"Volume 1"**, **"volume 1"**, **"Book 2"**, etc. Drive folder names may be normalized differently (e.g. folder created as "Volume 1", later referenced as "volume 1" in cache keys in driveChapterFolders — **toCacheKey** uses **toLowerCase()**).

---

## 3. Issues list

| # | Location | What | Impact |
|---|----------|------|--------|
| 1 | **ChapterSidebar** volumeOrder sort | **orderIndex** is keyed by **name.trim()** from volumeOrder; lookup uses **a.volumeName** (already trimmed when grouping). So match is **case-sensitive**. If volumeOrder has "Volume 1" and a group has "volume 1", **orderIndex.has("volume 1")** is false. | **High** — Custom order is ignored for any volume whose name casing differs from volumeOrder. |
| 2 | **BookState** explicitOrderMap | Same: **explicitOrderMap.has(a.volumeName)** is case-sensitive. So ChapterFolderView and ChapterSidebar can both show wrong order when casing differs. | **High** — Same as above. |
| 3 | **Empty volumeOrder** | When volumeOrder is missing or empty, both use fallback (Ungrouped last, volume number, name). Behaviour is correct. | **OK** |
| 4 | **Volumes not in volumeOrder** | ChapterSidebar: volumes not in the list are sorted after “in list” volumes, by ungrouped last, number, name. Correct. BookState: same. | **OK** |
| 5 | **book.settings not hydrated** | If book is loaded without settings (e.g. stale state), volumeOrder can be undefined. Then we always use fallback. Ensure book settings (including volumeOrder) are loaded when opening a book. | **Low** — Likely already correct from library load; mention in plan if we find a path that drops settings. |

---

## 4. In-depth implementation plan

### 4.1 Goal

- Apply **book.settings.volumeOrder** in a **case-insensitive** way so that "Volume 1", "volume 1", and "VOLUME 1" are treated as the same volume for ordering.
- Keep fallback behaviour (Ungrouped last, volume number, name) for volumes not in volumeOrder.
- Align ChapterSidebar and BookState so both use the same normalization rule.

### 4.2 Strategy

- **Normalize** volume names to a canonical form when building the order map and when looking up. Use **lowercase** for canonical form so that order is applied regardless of casing (e.g. "Volume 1" in volumeOrder matches group "volume 1").
- **Display** names unchanged (we only change how we *match* for sort order).
- Optionally extract a small **normalizeVolumeNameForOrder** (or reuse an existing one) so ChapterSidebar and BookState share the same logic.

---

### 4.3 Plan items

#### P1. Case-insensitive volumeOrder lookup in ChapterSidebar (components/ChapterSidebar.tsx)

- **Where:** **volumeGroups** useMemo, where we build **orderIndex** and sort **parsed**.
- **What:**
  - Build **orderIndex** keyed by **normalized** name: e.g. `name.trim().toLowerCase()` (and only set if trimmed is non-empty). So `orderIndex.set(name.trim().toLowerCase(), idx)`.
  - When sorting, get the **order index** for a group by **a.volumeName.trim().toLowerCase()** (and similarly for b). So we need a helper like `getOrderIndex(volumeName: string): number | undefined` that does `orderIndex.get(volumeName.trim().toLowerCase())`.
  - Keep **display** of **group.volumeName** as-is (original casing from chapters).
- **Why:** So "Volume 1" in volumeOrder correctly orders a group whose volumeName is "volume 1" or "VOLUME 1".
- **Risk:** Low. Only affects sort key; display and keys (e.g. React key={group.volumeName}) stay the same.

#### P2. Case-insensitive volumeOrder lookup in BookState (src/features/library/BookState.ts)

- **Where:** **volumeSections** useMemo, **explicitOrderMap** and sort.
- **What:**
  - Build the map keyed by normalized name: `explicitOrder.forEach((name, idx) => { const n = name.trim(); if (n) explicitOrderMap.set(n.toLowerCase(), idx); });`
  - When sorting, use `explicitOrderMap.get(a.volumeName.trim().toLowerCase())` (and b). So volumes are compared by normalized name for order lookup.
  - When adding empty volumes from **explicitOrder**, we still push `{ volumeName: volumeName }` where **volumeName** comes from the **original** entry in explicitOrder (so display matches what the user saved). For lookup we already use normalized key in the map.
  - When checking **grouped.has(volumeName)** for empty volumes we use the **original** name from explicitOrder; grouped is keyed by chapter volumeName (trimmed). So we need to ensure “empty volume” from volumeOrder is only added if no group has a volumeName that matches **after normalization**. So when iterating explicitOrder, check `!volumes.some((v) => v.volumeName.trim().toLowerCase() === volumeName.trim().toLowerCase())` (or keep a set of normalized names from existing volumes). Actually re-reading the code: we have `grouped.has(volumeName)` — grouped is keyed by the exact chapter volumeName (trimmed). So if volumeOrder has "Volume 1" and chapters have "volume 1", grouped has "volume 1", and we'd have `grouped.has("Volume 1")` false, so we'd push an empty volume with volumeName "Volume 1". Then we'd have two entries: one from grouped.entries() ("volume 1") and one from explicitOrder ("Volume 1"). So we'd have duplicate volumes (same logical volume, different casing). So we need to: (1) when building volumes from grouped, use a normalized key for “already seen” when adding empty volumes from explicitOrder — e.g. existingNormalized = new Set(volumes.map((v) => v.volumeName.trim().toLowerCase())); then for volumeName in explicitOrder, if existingNormalized.has(volumeName.trim().toLowerCase()) skip adding empty. And (2) sort using normalized lookup. I'll add that to the plan.
- **Why:** Same as P1; keeps sidebar and main view consistent.
- **Risk:** Low. Need to avoid duplicate empty volume headers when casing differs (see above).

#### P3. Shared normalization helper (optional)

- **Where:** New or existing util (e.g. **utils/volumeDetection.ts** or **services/driveChapterFolders.ts** — already has **normalizeVolumeName** which only trims; we need a “key for order” that is trimmed + lowercased).
- **What:** Export something like **volumeNameForKey(volumeName: string): string** that returns `volumeName.trim().toLowerCase()`. Use it in ChapterSidebar and BookState so the rule is in one place.
- **Why:** Single place to change if we ever want a different rule (e.g. Unicode normalize).
- **Risk:** None.

#### P4. Tests (ChapterSidebar.test.tsx or new)

- **What:** Add a test: book with **volumeOrder: ["Volume 2", "Volume 1"]** and chapters with **volumeName: "volume 1"** and **"volume 2"** (lowercase). Expect sidebar to show Volume 2 first, then Volume 1 (by order in volumeOrder), not by string sort.
- **Why:** Lock in case-insensitive behaviour.
- **Risk:** None.

---

### 4.4 Implementation order

1. **P1** — ChapterSidebar: build orderIndex with normalized keys (e.g. trim + toLowerCase), and use normalized lookup when sorting.
2. **P2** — BookState: build explicitOrderMap with normalized keys; when adding empty volumes from explicitOrder, skip if a volume with same normalized name already exists; sort using normalized lookup.
3. **P3** — (Optional) Extract **volumeNameForKey** and use it in both.
4. **P4** — Add test for case-insensitive volume order.

---

### 4.5 Files to touch

| File | Changes |
|------|--------|
| **components/ChapterSidebar.tsx** | P1: orderIndex keyed by normalized name; sort lookup by normalized name. |
| **src/features/library/BookState.ts** | P2: explicitOrderMap keyed by normalized name; skip duplicate empty volume by normalized name; sort by normalized lookup. |
| **utils/volumeDetection.ts** or **services/driveChapterFolders.ts** | P3 (optional): export **volumeNameForKey**. |
| **tests/ChapterSidebar.test.tsx** | P4: test case-insensitive volume order. |

---

### 4.6 Code-level sketch (P1 — ChapterSidebar)

**Current:**
```ts
volumeOrder.forEach((name, idx) => {
  if (typeof name === "string" && name.trim()) orderIndex.set(name.trim(), idx);
});
// ...
const aIn = orderIndex.has(a.volumeName);
const bIn = orderIndex.has(b.volumeName);
if (aIn && bIn)
  return (orderIndex.get(a.volumeName) ?? NONE) - (orderIndex.get(b.volumeName) ?? NONE);
```

**After P1:**
- Define **key = (v: string) => v.trim().toLowerCase()** (or use a shared helper).
- **orderIndex**: `orderIndex.set(key(name), idx)`.
- **aIn** = `orderIndex.has(key(a.volumeName))`, **bIn** = `orderIndex.has(key(b.volumeName))`.
- When both in: `orderIndex.get(key(a.volumeName)) ?? NONE` and same for b.
- **Display** and **React key** stay **group.volumeName** (no change).

---

### 4.7 Code-level sketch (P2 — BookState)

- **explicitOrder**: keep as trimmed strings for display/empty-volume name.
- **explicitOrderMap**: `explicitOrder.forEach((name, idx) => { const k = name.trim().toLowerCase(); if (k) explicitOrderMap.set(k, idx); });`
- When adding **empty volumes** from explicitOrder: skip if `volumes.some((v) => v.volumeName.trim().toLowerCase() === volumeName.trim().toLowerCase())` (so we don’t add "Volume 1" when we already have "volume 1" from grouped).
- Sort: `explicitA = explicitOrderMap.get(a.volumeName.trim().toLowerCase()) ?? NONE`, same for b.

---

## 5. Summary

- **Why volume order can appear wrong:** **orderIndex** / **explicitOrderMap** use **case-sensitive** string match. If **volumeOrder** has "Volume 1" but chapters use "volume 1" (e.g. from Drive or import), the volume is treated as “not in list” and sorted by fallback only.
- **Fix:** **P1** — In ChapterSidebar, key **orderIndex** by **trim().toLowerCase()** and use the same normalized key when looking up for sort. **P2** — In BookState, key **explicitOrderMap** by normalized name; skip adding an empty volume when one with the same normalized name already exists; sort by normalized lookup. **P3** (optional) — Shared **volumeNameForKey**. **P4** — Test case-insensitive order.
