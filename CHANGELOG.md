# TaleVox TTS Changelog

## 3.0.16
- Volume order changes in chapter view now persist reliably and no longer revert after sync runs.
- Native book loading now preserves full book settings (including `volumeOrder`) so custom volume order survives app restart.
- Book settings updates now merge against the latest in-memory book state to avoid stale overwrites during concurrent syncs.

## 3.0.15
- Drive sync now preserves existing chapter `volumeName`/`volumeLocalChapter` when a partial Drive refresh lacks volume metadata, preventing chapters from popping out of their assigned volume.
- Android Generate Audio jobs now upload chapter MP3 files into the correct book/volume folder (using chapter volume assignment) instead of the global Books folder.
- Android Fix Integrity now scans nested book subfolders recursively and writes restored/generated chapter files into each chapter's assigned volume folder.

## 3.0.14
- Drive integrity scan now walks nested subfolders recursively, so `Check/Fix` sees chapter files stored deeper than one folder level.
- `Check/Fix` now defaults to safe recovery (`Convert Legacy` on, `Generate Audio` off, `Cleanup` off) to prevent accidental mass TTS retries and cleanup noise.
- Background `Fix` queue is now limited to audio-only jobs; conversion/cleanup runs inline with the recursive scan path for consistent folder handling.
- Multi-select now supports batch move to a volume (or Unassigned) through a proper volume picker modal and a dedicated `Volume` action in the bulk dock.

## 3.0.13
- Smart Upload now includes volume options from saved volume order plus live Drive subfolders, so all existing volumes are selectable (not only currently loaded chapter volumes).
- Bulk chapter import now runs sequentially with an in-app upload progress bar and best-effort background notification pings at start/finish.
- Chapter import indexing now uses full book metadata and requested manifest indices safely, preventing duplicate/rolled-back chapter numbers during large uploads.
- Bulk imports no longer auto-trigger per-chapter audio generation, reducing repeated Cloud TTS 500 spam during large chapter uploads.

## 3.0.12
- Drive sync now seeds `volumeOrder` from existing Drive subfolders, so empty volumes still appear in chapter view after reload/sync.
- Existing volume order now merges saved order + Drive folders + chapter metadata to prevent volume headers disappearing.
- App version text now reads from `package.json` at build time, so Settings always shows the current release version.

## 3.0.11
- Smart Upload now reads `talevox_manifest.json` from normal file batches (not just ZIP imports).
- Manifest titles/source URLs/chapter indices are applied to matching chapter files during preview/import.
- Import picker now accepts `.json` so manifest files can be selected alongside chapter files.

## 3.0.10
- Smart Upload preview rows are now mobile-friendly (no off-screen volume selector overflow).
- Added bulk volume assignment in Smart Upload: choose one folder and apply it to all chapters at once.
- Individual chapter volume selectors remain editable after bulk assign for per-chapter overrides.

## 3.0.9
- Creating a volume in chapter view now also creates the matching Drive subfolder for Drive-backed books.
- Moving a chapter between volumes now moves its Drive text/audio files into the destination volume folder (or back to book root when unassigned).
- Added Drive parent lookup helper to support reliable file moves across volume folder changes.

## 3.0.8
- Drive books now place chapter text/audio uploads into per-volume subfolders (using the chapter's assigned volume name).
- Drive sync/integrity scans now include chapter files found inside book subfolders so volume-stored files are recognized.
- Smart Upload now accepts `.zip` batches and reads `talevox_manifest.json` (chapter index/title/source URL) when present.

## 3.0.7
- Fixed wrench-mode long-press move on mobile so the initial release tap no longer cancels the picked chapter/volume.
- Hold-to-pick now reliably keeps the item active, then tap destination reorders/moves as expected.

## 3.0.6
- Organize (wrench) mode now supports mobile long-press move flow: hold a chapter/volume to pick it, then tap destination to reorder/move.
- Added visual picked-state highlight for held chapter/volume targets and ungroup drop zones.
- Android/back handling now cancels the active organize move before other back actions.

## 3.0.5
- Chapter view FAB now opens a create menu with `New chapter` (opens chapter popup) and `New volume`.
- Added support for empty volumes in chapter view, so user-created volumes appear even before they contain chapters.
- Back button now closes the chapter create menu before exiting selection/collection view.

## 3.0.4
- Save/Sync now builds cloud snapshots from full chapter metadata (not only currently paged chapters) so progress for every chapter is included.
- Snapshot save now merges per-chapter progress from `talevox_progress_store` into chapter metadata before upload to keep progress values in sync.
- Manual Sync now checks for a newer Drive snapshot first and merges it locally before uploading, preventing stale progress from overwriting newer cloud progress.

## 3.0.3
- Fixed markdown table parsing for one-column rows that contain `<br>` tags so rows no longer split into stray paragraphs in Reader view.
- Preserved `<br>` line breaks inside markdown table cells so long stat-card entries render fully inside the table.
- Added a parser regression test to lock this behavior for future markdown uploads.

## 3.0.2
- Book header hero metadata now lives in one stacked block (title, Drive + sync chips, last saved, chapter count) instead of repeated cards.
- Sync badge now reacts to active syncing, flips to Syncing during manual sync, and settles back to Synced after completion.
- Grid chapter cards use the slightly larger title font/line-height so the text matches the refreshed sketch.

## 3.0.0
- Stepped into the 3.x cycle and prepared the repo for the upcoming modular refactor.

## 2.10.37
- Added TachiyomiSY-inspired screen state modules for Library, Book, and Reader.
- Refactored core UI into smaller Book/Library/Reader components for stability.
- Centralized in-app notifications with a shared NotificationHost.
- Added shared selection store and Chapter list/grid wrappers.

## 2.10.36
- Mobile-first Book screen spacing with simplified hero and top bar.
- Selection UX parity across list and grid with long-press gestures.
- Book Settings modal now scrolls properly on mobile.
- Audio-ready cloud icon now turns green whenever local audio exists.
- Removed table header row and kept only list/grid layouts.

## 2.10.35
- Preserve original chapter indices during normalization and snapshot merges.
- Stop drag-reorder from overwriting chapter indices.
- Auto-repair overwritten indices using stored sortOrder (restores large chapter numbers).

## 2.10.34
- Restored scroll-driven cover compression/expansion and removed the cover/title bubble card.
- Increased the expanded cover size on the book header.
- Eliminated double scrollbars by making inner views the sole scroll containers.
- Re-saturated the active reader highlight for better visibility.
- Auto-scroll now keeps the active highlight in view within long paragraphs.
- Unified chapter selection overlays and removed the gray "last item" effect.
- Virtualized chapter list/grid rendering to eliminate view-mode switch lag.
- Removed duplicate chapter layout toggle from Book Settings.
- Global Settings no longer jumps to the top when toggling controls.
- Added bulk action to assign selected chapters to a volume.

## 2.10.33
- Unified markdown and plain-text reader into a single block-based renderer with working highlight.
- Markdown tables now render as tables while staying aligned to TTS cue offsets.
- Paragraph spacing handled via spacer blocks, eliminating whitespace-only highlight flashes.
- Removed markdown highlight limitation banner and extra reader mode toggle.

## 2.10.32
- Fixed Book Settings modal scrolling on small screens and kept controls reachable to the bottom.
- Added Android back-button overlay priority: close Book Settings first, then exit selection mode.
- Added explicit in-modal close control and hardened mobile modal behavior.
- Prevented background/body scroll bleed while Book Settings modal is open and added safe-area-friendly modal padding.

## 2.10.31
- Fixed unreliable long-press chapter selection in both sections and grid layouts.
- Unified selection behavior across views, including range select, select-all, and invert.
- Hardened selection persistence when switching between sections and grid views.
- Centralized chapter bulk actions in the selection dock and simplified per-chapter menu to `Edit Title` only.
- Improved bulk action consistency and progress feedback across multi-select operations.

## 2.10.30
- Fixed chapter lists disappearing during open/sync/view transitions by separating loading state from chapter data state.
- Added canonical `sortOrder` chapter ordering with derived display indices to prevent index explosions and ordering drift.
- Added a one-click `Reindex` repair action in the chapter screen to safely normalize corrupted chapter ordering.
- Updated sync/job status handling so paused jobs no longer keep the UI stuck in active loading/syncing state.
- Hardened chapter merge flows so empty/partial sync responses never wipe local chapter lists.

## 2.10.29
- Mobile-first Book screen redesign with a minimal top bar and consolidated hero metadata.
- Removed spreadsheet-style mobile chapter header row and tightened row-level progress/audio alignment.
- Simplified sync state display to a single subtle hero indicator instead of repeated badges.
- Hardened Sections/Grid switching with single-view mounting and per-view scroll restoration.
- Unified audio-ready icon behavior so local cache and Drive-ready chapters both show green-ready state.

## 2.10.28
- Mobile book screen parity pass for top bar, section layout, and selection/organize mode transitions.
- Selection mode behavior aligned across sections and grid, including range selection and sticky bulk action dock.
- Organize drag/reorder/move-to-volume flows hardened with persisted volume ordering and collapse state.
- Audio status icon logic now detects both Drive and local cached audio, showing green-ready state for local-only audio.
- Markdown reader now defaults markdown chapters to highlight/reading mode, keeps rich markdown optional, and improves highlight whitespace behavior.

## 2.10.27
- Finalized sticky chapter screen app bar with dual normal/selection mode UX.
- Selection mode top bar and bottom bulk dock now follow Tachiyomi-style multi-select flows.
- Volume sections and grid rendering refined for Speechify-style grouping parity.
- Organize mode drag/reorder/move-to-volume behaviors hardened and persisted through `volumeOrder`.
- Chapter row actions simplified to edit/move, with upload/audio/reset/delete centralized as bulk actions.
- Removed visible "Ungrouped" folder labeling in chapter list rendering.

## 2.10.26
- Chapter screen redesigned with Speechify-style volume sections and per-section headers.
- Added Tachiyomi-style selection mode with bulk dock actions (upload, regenerate audio, mark complete, reset, delete).
- Added organize mode controls for volume/chapter management and drag/drop move flows.
- Book settings expanded with chapter layout, selection/organize controls, drag options, and safety toggles.

## 2.10.25
- Version bump.
- Added OpenAI TTS as an optional voice provider for background audio jobs.
- Added full snapshot save/restore plumbing (`FullSnapshotV1`) with Drive pointer restore support.
- Added full Backup ZIP workflow (Drive/device/download targets, restore from ZIP/Drive, schema migration scaffold, and backup progress UI).
- Autosave now writes full snapshots (books, chapters, prefs, rules, progress, attachments metadata, jobs metadata) and can restore on startup when newer cloud state exists.
- Chapter collection details view now renders per-volume sections with in-section headers; ungrouped chapters are listed without a fake "Ungrouped" folder.
- Added per-book `autoGenerateAudioOnAdd` setting (default on), and chapter add now auto-generates Drive audio in the background.
- Reader markdown now supports `Reading`/`Formatted` views, auto-switches to `Reading` during playback, restores paragraph spacing in formatted markdown, and removes whitespace-only highlight flashes.

## 2.10.24
- Audio generation: chapter status now updates correctly when background jobs finish (ready/failed), and shows generating state while queued/running.
- Library: volumes behave like folders (Speechify-style) with manual volume management; manual chapter add no longer auto-creates volumes.

## 2.10.23
- Reader: chunked list auto-follow keeps the active highlight pinned during playback, and snaps back after seeks/scrubbing.

## 2.10.22
- Chapter import now supports both `.txt` (plain text) and `.md` (Markdown).
- Markdown chapters render with GFM tables and a styled "stat sheet" look; TTS reads a cleaned plain-text version.

## 2.9.25
- Mobile native playback and background jobs stabilized.
- Mobile filesystem audio: save/play from device storage.
- Cue map highlight sync for accurate reader highlighting.
- Paging fallback for Mobile WebView when IntersectionObserver is flaky.
- Import adapter selected by UiMode with mobile picker support.
- Build cleanup: removed CDN importmap, Tailwind pipeline verified.

## Historical Versions (No Notes Recorded)
The versions below were detected from git history. No release notes were recorded at the time.

- 2.9.34
- 2.9.27
- 2.9.26
- 2.9.23
- 2.9.22
- 2.9.21
- 2.9.20
- 2.9.17
- 2.9.13
- 2.9.12
- 2.9.11
- 2.9.10
- 2.9.9
- 2.9.8
- 2.9.7
- 2.9.6
- 2.9.5
- 2.9.4
- 2.9.3
- 2.9.2
- 2.9.1
- 2.9.0
- 2.8.12
- 2.8.11
- 2.8.10
- 2.8.9
- 2.8.8
- 2.8.7
- 2.8.6
- 2.8.5
- 2.8.4
- 2.8.3
- 2.8.2
- 2.8.1
- 2.8.0
- 2.7.15
- 2.7.14
- 2.7.13
- 2.7.12
- 2.7.11
- 2.7.10
- 2.7.9
- 2.7.8
- 2.7.7
- 2.7.6
- 2.7.4
- 2.7.0
- 2.6.11
- 2.6.10
- 2.6.9
- 2.6.8
- 2.6.7
- 2.6.6
- 2.6.5
- 2.6.4
- 2.6.3
- 2.6.2
- 2.6.1
- 2.6.0
- 2.5.12
- 2.5.11
- 2.5.10
- 2.5.9
- 2.5.7
- 2.5.6
- 2.5.5
- 2.5.1
- 2.4.8
- 2.4.6
- 2.4.5
- 2.4.4
- 2.4.2
- 2.4.1
- 2.4.0
- 2.3.0
- 2.2.5
- 2.2.4
- 2.2.1
- 2.2.0
- 2.1.8
- 2.1.7
- 2.1.6
- 2.1.5
- 2.1.1
- 2.0.9
- 2.0.7
- 2.0.4
- 2.0.3
- 2.0.0
- 1.2.4
- 1.2.3
- 1.2.2
- 1.2.0
- 0.0.0
