# Attachments folder layout

Attachments are stored per book in a dedicated `attachments` folder, both locally and on Drive.

## Local (Capacitor Data directory)

- **Path:** `talevox/{bookId}/attachments/{filename}`
- **Legacy path (migrated on first use):** `talevox/attachments/{bookId}/{filename}`
- When `ensureAttachmentsDir(bookId)` runs, it creates the new path and, if the legacy path exists, copies any files into the new location.
- `resolveAttachmentUri` and `attachmentExists` accept either path; if given a legacy path and the file is not found, they try the new path so migrated or newly saved attachments still resolve.

## Drive

- For Drive-backed books, attachments are uploaded into an `attachments` subfolder under the book's Drive folder.
- `ensureDriveAttachmentsFolder(bookFolderId)` creates or returns that subfolder; uploads use it as the parent so all attachment files live under `Book Folder / attachments /`.

## References

- Local paths: `services/attachmentsService.ts`
- Drive folder: `src/app/state/useAttachments.ts` (`ensureDriveAttachmentsFolder`), `services/driveService.ts` (`createDriveFolder`, `uploadToDrive`)
