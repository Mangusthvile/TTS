## Cloud batch generation API (design)

This API is intended to run in a cloud environment (e.g. Cloud Run) and orchestrate long-running, book-level audio generation jobs using the existing TaleVox TTS backend.

### Base URL

- Configured in the app via:
  - `VITE_TALEVOX_BATCH_JOBS_ENDPOINT` (preferred), or
  - `VITE_BATCH_JOBS_ENDPOINT`
- Exposed to the app as `appConfig.cloud.batchJobsEndpoint`.

### Create batch job

- **Method**: `POST`
- **Path**: `/v1/batch-jobs`
- **Request body**:

```json
{
  "userId": "optional-user-id",
  "bookId": "book-123",
  "chapterIds": ["c1", "c2", "c3"],
  "voice": { "id": "en-US-Standard-C", "provider": "google" },
  "settings": {
    "playbackSpeed": 1.0
  },
  "driveRootFolderId": "optional-root-folder-id",
  "driveBookFolderId": "optional-book-folder-id"
}
```

- **Response** (`201 Created`):

```json
{
  "jobId": "job-uuid",
  "status": "queued",
  "totalChapters": 3
}
```

### Get job status

- **Method**: `GET`
- **Path**: `/v1/batch-jobs/{jobId}`
- **Response** (`200 OK`):

```json
{
  "jobId": "job-uuid",
  "status": "running",
  "bookId": "book-123",
  "totalChapters": 1000,
  "completedChapters": 237,
  "failedChapters": 3,
  "lastChapterId": "chapter-237",
  "errorSummary": "3 chapters failed (see logs)",
  "createdAt": 1739990000000,
  "updatedAt": 1739990300000,
  "progress": {
    "total": 1000,
    "completed": 237,
    "currentChapterId": "chapter-238",
    "currentChunkIndex": 1,
    "currentChunkTotal": 3,
    "currentChapterProgress": 0.33
  }
}
```

### Cancel job (optional)

- **Method**: `POST`
- **Path**: `/v1/batch-jobs/{jobId}/cancel`
- **Response** (`200 OK`):

```json
{
  "jobId": "job-uuid",
  "status": "canceled"
}
```

### Worker behaviour (high level)

- Accepts a job with `bookId`, `chapterIds[]`, `voice`, and `settings`.
- Iterates chapters sequentially or with limited parallelism:
  - Loads or receives chapter text for each `chapterId`.
  - Calls the existing TTS backend (same endpoint used by `cloudTtsService` and `GenerateAudioWorker`) to synthesize MP3 audio, using voice + playback speed.
  - Writes the resulting audio to:
    - A per-book location in cloud storage (e.g. `talevox/{bookId}/audio/{chapterId}.mp3`), or
    - A per-book folder in Drive using a service account (`driveRootFolderId` / `driveBookFolderId`).
- Maintains a job record (e.g. in Firestore, Postgres, or other durable store) with:
  - `status` (`queued` / `running` / `paused` / `completed` / `failed` / `canceled`)
  - `totalChapters`, `completedChapters`, `failedChapters`
  - `lastChapterId`, `errorSummary`
  - Optional `progress` payload mirroring the shape of `JobProgress` used in the app.
- Is **idempotent per chapter** (e.g. by checking if audio already exists for a given `{bookId, chapterId}` and skipping if so), so a resumed job does not duplicate work.

The app talks to this API via `services/cloudBatchApi.ts`, which wraps the HTTP calls and returns strongly typed results.

