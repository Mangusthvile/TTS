## Job runner behaviour for large audio batches

### Current model

- Jobs are stored in the `jobs` SQLite table with:
  - `type` = `"generateAudio"`, `"fixIntegrity"`, `"drive_upload_queue"`, etc.
  - `payloadJson` including `bookId`, `chapterIds[]`, `driveFolderId`, `voice`, `settings`, etc.
  - `progressJson` with `total`, `completed`, `currentChapterId`, chunk progress, timestamps, and `workRequestId`.
- On Android, `JobRunnerPlugin.enqueueGenerateAudio`:
  - Creates a `"generateAudio"` job row with `total = chapterIds.length`, `completed = 0`.
  - Schedules a `OneTimeWorkRequest` for `GenerateAudioWorker` with `jobId` as input.
  - Stores the WorkManager `workRequestId` back into `progressJson`.
- On the web / desktop, `services/jobRunnerService` and `JobRunnerWeb` create the same job records but do not actually generate audio.

### GenerateAudioWorker

- Looks up the `jobId` in the `jobs` table and deserializes `payloadJson` and `progressJson`.
- Uses `progressJson.completed` and the `chapterIds[]` array to determine where to resume.
- Processes a batch window:
  - `batchSize` comes from the payload (default 5, clamped to 3–7).
  - For each chapter in `[completed, completed + batchSize)`:
    - Loads chapter text (from `chapter_text` table or fallback file).
    - Applies rules and chunks the text by UTF‑8 byte length.
    - Calls either the Cloud TTS endpoint or OpenAI TTS.
    - Saves the resulting MP3 under `files/talevox/audio/<chapterId>.mp3`.
    - Updates `chapter_audio_files` and the `chapters` row (`audioStatus`, `cloudAudioFileId`, etc.).
    - If Drive upload fails or there is no token, enqueues a row in `drive_upload_queue` and triggers `DriveUploadWorker`.
    - Updates `progressJson` (`completed`, per‑chunk and per‑chapter fields) and persists it via `updateJobProgress`, emitting Capacitor events for JS listeners.
- At the end of the batch:
  - If `completed < total`, it:
    - Writes the latest `progressJson` back to the job.
    - Enqueues a new `OneTimeWorkRequest` for `GenerateAudioWorker` with the same `jobId`.
    - Returns `Result.success()` to WorkManager, causing the next batch to start later.
  - If `completed >= total`, it:
    - Marks the job as `"completed"`, emits a `jobFinished` event, and shows a completion notification.
- When `isStopped()` returns true (WorkManager or the OS stops the worker):
  - The worker:
    - Sets `currentChapterId` to `null` in `progressJson`.
    - Marks the job status as `"canceled"` and emits `jobFinished` with `"canceled"`.
    - Returns `Result.failure()`.
  - This means a partially completed large job (e.g. 50 / 1000 chapters) is treated as a failed/canceled job instead of a resumable one, even though `completed` is persisted.

### JobRunnerPlugin and WorkManager integration

- `JobRunnerPlugin` owns:
  - Job CRUD APIs exposed to JS (`enqueueGenerateAudio`, `enqueueFixIntegrity`, `cancelJob`, `retryJob`, `forceStartJob`, `getJob`, `listJobs`, etc.).
  - Upload queue management (`drive_upload_queue` table and `DriveUploadWorker` scheduling).
  - Notification permission checks and diagnostics.
  - A `reconcileWithWorkManager` helper that reconciles WorkManager’s state with the `jobs.status` field.
- For `"generateAudio"` jobs today:
  - All scheduling uses expedited one‑shot work requests:
    - `enqueueGenerateAudio` always uses `setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)`.
    - `retryJob`/`forceStartJob` also reschedule using the same pattern.
  - There is **no differentiation** between small jobs (a few chapters) and large jobs (hundreds+):
    - Constraints do not change based on `total` chapter count.
    - There is no explicit `"paused"` state; interrupted jobs end up as `"failed"` or `"canceled"`.
- For the upload queue:
  - The plugin configures:
    - One‑shot and periodic background work with `NetworkType.CONNECTED` constraints.
    - Optional user‑provided constraints for Wi‑Fi and charging.

### Observed limitations for 1,000+ chapter jobs

- Long‑running, many‑batch jobs depend on a chain of expedited `OneTimeWorkRequest`s, but:
  - Android background limits and quota may stop workers mid‑job.
  - When a worker is stopped, the job is marked `"canceled"` and not automatically resumed, even though `completed` and `total` are persisted.
- There is no separate `"generate_book_audio"` or book‑level concept:
  - All generation jobs are just `"generateAudio"` with `chapterIds[]` in the payload.
  - The UI has to infer book‑level progress from generic job records.
- WorkManager constraints for generation do not adapt to job size:
  - Large jobs run under the same network/power constraints as small jobs, increasing the likelihood of being killed when the user backgrounds the app, leaves Wi‑Fi, or is on battery.

These behaviours are the starting point for implementing book‑level, resumable generation jobs with clearer statuses (including `paused`) and smarter constraints for very large chapter sets.

