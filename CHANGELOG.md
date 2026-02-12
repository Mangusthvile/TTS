# TaleVox TTS Changelog

## 2.10.25
- Version bump.
- Added OpenAI TTS as an optional voice provider for background audio jobs.
- Added full snapshot save/restore plumbing (`FullSnapshotV1`) with Drive pointer restore support.
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
