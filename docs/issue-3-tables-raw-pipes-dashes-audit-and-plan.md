# Issue 3: Tables not rendering correctly (raw pipes and dashes) — Audit & implementation plan

## 1. Audit summary

**Symptom:** Table syntax appears as raw text: pipes (`|`) and separator dashes (`---`) are shown in the reader instead of a rendered HTML table.

**Root cause:** Tables are only recognized when the **separator row** passes `isSeparatorRow()`. When it fails, the header and separator (and sometimes body rows) are parsed as **paragraph** content and rendered as plain text, so the user sees the literal markdown.

**Secondary cause:** If the chapter is treated as **plain text** (no markdown parsing), table detection never runs, so any table shows as raw.

---

## 2. Flow (traced)

1. **Content → blocks**  
   `buildReaderModel(rawText, isMarkdown, rules, reflow)` in `utils/markdownBlockParser.ts`:
   - If **isMarkdown** is true → `parseMarkdownBlocks(normalized)`.
   - If false → `parsePlainTextBlocks(normalized)` (no table detection; everything is paragraph).

2. **Markdown table detection**  
   In `parseMarkdownBlocks`, a table is recognized only when `isTableStart(i)` is true at line index `i`:
   - **Header row:** `parseTableRow(lines[i])` must return a non-null array (line must contain at least one `|`, then split by `|`, cells trimmed).
   - **Separator row:** next line `lines[i + 1]` must exist and `isSeparatorRow(separator)` must be true.

3. **isSeparatorRow**  
   - Splits the separator line with `parseTableRow(line)` (so the line must contain `|`).
   - For **each cell** (after trim): cell must be **empty** or match the regex **SEPARATOR_CELL**.

4. **SEPARATOR_CELL** (current)  
   ```ts
   /^:?[\-\u2013\u2014]{3,}:?$/
   ```
   - Optional leading `:`, then **3 or more** of `-` (ASCII hyphen), `\u2013` (EN DASH), `\u2014` (EM DASH), then optional trailing `:`.
   - **No spaces** allowed inside the cell. So `" :---: "` trimmed to `":---:"` matches, but `" : --- : "` trimmed to `": --- :"` does **not** (spaces between tokens).
   - Only **three** dash characters supported; other Unicode dashes (e.g. U+2212 MINUS SIGN, U+2010 HYPHEN) do **not** match.
   - **Exactly 3+** dashes required; `"--"` (two dashes) does **not** match.

5. **Rendering**  
   In `ReaderList.tsx`, only blocks with `block.type === "table"` and `block.rows` are rendered as `<table>`. Any other block falls through to paragraph (`<p>`), which displays `block.content` — so if the table was not detected, that content is the raw markdown (pipes and dashes).

6. **isMarkdown**  
   Set from `chapter.contentFormat === "markdown"` or `(chapter.filename ?? "").toLowerCase().endsWith(".md")` (Reader, App, usePlayback). If the user imports an `.md` file but the chapter is stored with `contentFormat: "text"` or a non-.md filename, markdown (and thus table) parsing is skipped.

---

## 3. Issues list

| # | Location | What | Impact |
|---|----------|------|--------|
| 1 | `markdownBlockParser.ts` — SEPARATOR_CELL | No **spaces** allowed inside a separator cell. GFM allows e.g. ` : --- : ` or ` :---: `. Our regex fails for `": --- :"` or `" :---: "` (if there are spaces). | **High** — common formatting (spaces around colons/dashes) causes table not to be recognized; header + separator appear as raw paragraph. |
| 2 | `markdownBlockParser.ts` — SEPARATOR_CELL | Only **3+** dashes. Some content or generators use exactly **2** dashes (`--`). | **Medium** — such tables show as raw. |
| 3 | `markdownBlockParser.ts` — SEPARATOR_CELL | Only ASCII hyphen and `\u2013`/`\u2014`. **Other Unicode dash/minus** (e.g. U+2212 MINUS SIGN, U+2010 HYPHEN, U+2011 NON-BREAKING HYPHEN, U+2012 FIGURE DASH) not accepted. | **Medium** — pasted or generated content using these characters fails. |
| 4 | `markdownBlockParser.ts` — isSeparatorRow | Empty cells are allowed (`t === ""`). Cells that are **only whitespace** after trim are already `""`; but if we later normalize separator by stripping spaces from the cell string, we might need to treat whitespace-only as valid. | **Low** — current behavior is correct; only relevant if we add space-stripping inside cells. |
| 5 | Content format / isMarkdown | If chapter is parsed as **plain text** (contentFormat !== "markdown" and filename does not end in .md), **no** table detection runs. Entire table appears as one or more paragraphs with raw pipes/dashes. | **High** when wrong — e.g. .md file imported with wrong format or legacy data without contentFormat. |
| 6 | ReaderList fallback | When a block is not table/code/heading/list/spacer, it is rendered as `<p>{block.content}</p>`. So any undetected table shows as raw text. No “table-like” sniffing in the UI. | **Symptom** — not a separate fix; fixing detection removes raw display. |

---

## 4. In-depth implementation plan

### 4.1 Goal

- Tables render as HTML tables whenever the source looks like GFM table syntax (header row + separator row with dashes and optional colons).
- Relaxations are **parser-only** (separator cell recognition); rendering and structure stay the same.

### 4.2 Strategy

- **Normalize separator cells** before matching: remove optional spaces so that ` : --- : ` and `:---:` both count as valid.
- **Widen the separator regex** to allow (1) optional spaces around colons and between colons and dashes, (2) two or more dashes (GFM says 3+, but accepting 2 reduces raw display), (3) additional Unicode dash/minus characters commonly seen in documents.

---

### 4.3 Plan items

#### P1. Normalize separator cell before matching (markdownBlockParser.ts)

- **Where:** `isSeparatorRow`, when checking each cell.
- **What:** Before testing against SEPARATOR_CELL, normalize the cell string:
  - Trim (already done).
  - Optionally: collapse internal spaces (e.g. replace `\s+` with `""`) so `" : --- : "` becomes `":---:"`. Then test the normalized string against the regex.
- **Why:** Many authors and generators use spaces in the separator (e.g. ` | :---: | :---: | `). Normalizing makes this valid without changing the regex to allow arbitrary spaces (which would be more complex).
- **Risk:** Low. Empty string stays empty; purely dash/colon cells remain valid.

#### P2. Widen SEPARATOR_CELL regex (markdownBlockParser.ts)

- **Where:** Constant `SEPARATOR_CELL` and any use of it.
- **What:**
  - **Option A (minimal):** Add common Unicode dash/minus to the character class:  
    `[\-\u2010\u2011\u2012\u2013\u2014\u2212]` (hyphen, various dashes, minus sign). Keep `{3,}` (3+).
  - **Option B (recommended):** After P1 normalization (collapse spaces), use a regex that allows **optional spaces** around colons and dashes, e.g.  
    `^\s*:?\s*[\-\u2010\u2011\u2012\u2013\u2014\u2212]+\s*:?\s*$`  
    and require at least **2** dashes (change `{3,}` to `{2,}` or `+`) for leniency.  
  - If we do **P1** (collapse spaces in cell), we can keep a simple regex `^:?[\-\u2010\u2011\u2012\u2013\u2014\u2212]{2,}:?$` and still accept `": --- :"` → `":---:"`.
- **Why:** Handles (1) spaces in separator cells, (2) two-dash separators, (3) Unicode minus/dash from paste or generators.
- **Risk:** Very low. Only affects the delimiter row; body and header unchanged.

#### P3. Accept 2+ dashes in separator (markdownBlockParser.ts)

- **Where:** Same regex as P2.
- **What:** Use `{2,}` (or `+` if we allow a single dash) so `--` is valid. GFM says 3+, but accepting 2 improves compatibility.
- **Why:** Some sources use `| -- | -- |`; currently we reject and show raw.
- **Risk:** Low. A line of two dashes is extremely unlikely as non-table content in practice.

#### P4. Plain-text table sniffing (optional, larger change)

- **Where:** `parsePlainTextBlocks` or a pre-pass before choosing plain vs markdown.
- **What:** When in **plain text** mode, before splitting by double newlines, scan for a line that contains `|` and whose next line looks like a separator (after normalization). If found, optionally switch to table-aware parsing for that region, or run a single markdown-style table pass over the whole text. This is a larger change and may have edge cases (e.g. code blocks containing `|`).
- **Why:** If content is markdown but stored/opened as plain text, tables would still render.
- **Risk:** Medium (more code paths, possible false positives). Recommend **defer** unless we see many “table in .txt” reports. Prefer fixing contentFormat/filename at import instead.

#### P5. Tests (markdownBlockParser.test.ts)

- **What:** Add tests for:
  - Separator with spaces: `| : --- : | --- | ---: |` → one table block.
  - Separator with two dashes: `| -- | -- |` → one table block.
  - Separator with Unicode minus (U+2212): `| −−− | −−− |` (Unicode minus) → one table block.
  - (Optional) Plain text with table-like lines still treated as paragraph when isMarkdown is false (no regression).
- **Why:** Lock in P1–P3 and prevent regressions.
- **Risk:** None.

#### P6. contentFormat / filename (documentation or import path)

- **What:** Ensure Extractor/import sets `contentFormat: "markdown"` when the file is `.md` (already done via `detectFormatFromName`). Document that tables only render in markdown mode. If we have a path where .md files get `contentFormat: "text"`, fix that.
- **Why:** So users don’t see raw tables just because format was wrong.
- **Risk:** None if we only document; low if we change import logic.

---

### 4.4 Implementation order

1. **P1** — Normalize separator cell (collapse internal spaces) in `isSeparatorRow`.
2. **P2** — Extend SEPARATOR_CELL to include `\u2010`, `\u2011`, `\u2012`, `\u2212` (and keep `\u2013`, `\u2014`).
3. **P3** — Change separator dash count from 3+ to 2+ in the regex.
4. **P5** — Add tests for spaced separator, two dashes, Unicode minus.
5. **P6** — Quick check that .md import sets contentFormat; add a line in docs if needed.
6. **P4** — Defer unless required by user reports.

---

### 4.5 Files to touch

| File | Changes |
|------|--------|
| `utils/markdownBlockParser.ts` | P1: normalize cell in isSeparatorRow. P2: extend SEPARATOR_CELL. P3: 2+ dashes. |
| `tests/markdownBlockParser.test.ts` | P5: new cases for separator with spaces, 2 dashes, Unicode minus. |
| Docs / Extractor | P6: confirm contentFormat for .md; document tables = markdown only if needed. |

---

### 4.6 Code-level sketch (P1 + P2 + P3)

**Current:**
```ts
const SEPARATOR_CELL = /^:?[\-\u2013\u2014]{3,}:?$/;
const isSeparatorRow = (line: string) => {
  const cells = parseTableRow(line);
  if (!cells) return false;
  return cells.every((c) => {
    const t = typeof c === "string" ? c.trim() : "";
    return t === "" || SEPARATOR_CELL.test(t);
  });
};
```

**After P1 + P2 + P3:**
- Add a helper e.g. `normalizeSeparatorCell(s: string): string` that trims and replaces `\s+` with `""`.
- `SEPARATOR_CELL = /^:?[\-\u2010\u2011\u2012\u2013\u2014\u2212]{2,}:?$/` (2+ dashes, more Unicode).
- In `isSeparatorRow`, for each cell: if `t === ""` return true; else `SEPARATOR_CELL.test(normalizeSeparatorCell(t))`.

---

## 5. Summary

- **Why raw pipes/dashes appear:** Table is not recognized because the **separator row** fails `isSeparatorRow()` (strict regex, no spaces, only 3+ of 3 dash chars). The header and separator are then parsed as **paragraph** and rendered as-is.
- **Fix:** (1) **Normalize** separator cells (collapse spaces) so ` : --- : ` is valid. (2) **Widen** SEPARATOR_CELL: allow 2+ dashes and add Unicode dash/minus characters. (3) **Tests** for spaced separator, 2 dashes, Unicode minus. (4) Confirm **contentFormat** for .md so markdown (and table) parsing runs.
