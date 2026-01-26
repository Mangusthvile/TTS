# TaleVox Library + Playback Roadmap (Draft)

This document captures a phased plan for improving library scalability, storage, Drive hygiene, and playback reliability based on current requirements.

## Phase 1: Library + Drive foundation
- **Scalable library storage**
  - Persist books/chapters in the database instead of in-memory lists.
  - Support 10,000+ chapters per book without UI freezes.
  - Paginate chapter lists (initial chunk + infinite scroll).
  - Store chapter text separately from chapter list rows.
- **Storage modes**
  - Memory mode for tests/temporary books.
  - Local mode for device persistence (SQLite on Android, IndexedDB on web).
  - Drive mode as optional backup/sync layer.
- **Migration & compatibility**
  - One-time migration from legacy storage formats.
  - Legacy Drive migration for `####_title.txt/.mp3`:
    - Detect and group by chapter number.
    - Create real chapter records.
    - Write new-format files.
    - Mark legacy files safe to trash only after replacements exist.
- **Drive maintenance tooling**
  - **Check**: scan for missing `.txt`, missing `.mp3`, and stray files.
  - **Fix**: restore missing text, generate missing audio, then clean strays.
  - **Safety-first cleanup**: never trash old files until replacements exist.
  - **Rebuild book files**: ensure current-format `.txt`/`.mp3`, then cleanup old junk.

## Phase 2: Playback + highlight accuracy
- Make playback the source of truth for highlighting.
- Ensure highlights follow actual audio position (not timers).
- Support speed changes, scrubbing, pausing/resuming without drift.

## Phase 3: Android background playback + autoplay
- Use native background playback (MediaSession-style controls).
- Keep playback stable with screen off and during app switching.
- Ensure autoplay between chapters is reliable.

## Phase 4: Sync + Drive backup (v3.0)
- Incremental sync for settings, metadata, and progress.
- Keep chapter text/audio as separate files, upload only when changed.
- Prevent long stalls/conflicts from full-library uploads.

## Phase 5: Batch generation + resiliency
- Add a resumable job queue for 100+ chapter generation.
- Track progress, failures, retries, and resume after restarts.

## Phase 6: Rules engine hardening + release readiness
- Deterministic rules ordering (global + per-book).
- Preview/tester tools before generating audio.
- Strong diagnostics to prevent library corruption.

## Open questions / next decisions
- Data model details for chapter paging + text storage.
- Drive file naming conventions for current and legacy formats.
- Job queue persistence strategy across Android + web.
- Sync conflict resolution policy for settings + progress.
