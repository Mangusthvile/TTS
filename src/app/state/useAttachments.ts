import { useCallback, useState, useEffect } from "react";
import type { Book, BookAttachment } from "../../../types";
import {
  listBookAttachments as libraryListBookAttachments,
  upsertBookAttachment as libraryUpsertBookAttachment,
  deleteBookAttachment as libraryDeleteBookAttachment,
} from "../../../services/libraryStore";
import {
  saveAttachmentBytes,
  saveAttachmentBlob,
  resolveAttachmentUri,
  attachmentExists,
  guessMimeType,
} from "../../../services/attachmentsService";
import {
  fetchDriveBinary,
  uploadToDrive,
  listFoldersInFolder,
  createDriveFolder,
} from "../../../services/driveService";
import { getImportAdapter } from "../../../services/importAdapter";
import { StorageBackend } from "../../../types";

export function useAttachments(opts: {
  activeBook: Book | null;
  isAuthorized: boolean;
  isOnline: boolean;
  uiMode: string;
  pushNotice: (n: { message: string; type: "info" | "success" | "error"; ms?: number }) => void;
}) {
  const { activeBook, isAuthorized, isOnline, uiMode, pushNotice } = opts;

  const [attachmentsList, setAttachmentsList] = useState<BookAttachment[]>([]);
  const [attachmentsLocalStatus, setAttachmentsLocalStatus] = useState<Record<string, boolean>>({});
  const [attachmentViewer, setAttachmentViewer] = useState<{
    attachment: BookAttachment;
    uri: string;
  } | null>(null);
  const [attachmentDownloads, setAttachmentDownloads] = useState<Record<string, boolean>>({});
  const [editingAttachmentId, setEditingAttachmentId] = useState<string | null>(null);
  const [editingFilename, setEditingFilename] = useState("");

  const refreshAttachmentsForBook = useCallback(
    async (bookId: string) => {
      try {
        console.log("[Attachments] refreshing for book", bookId);
        const items = await libraryListBookAttachments(bookId);
        console.log("[Attachments] loaded", items.length, "items");
        const statusEntries = await Promise.all(
          items.map(async (att) => [att.id, await attachmentExists(att.localPath)] as const)
        );
        setAttachmentsList(items);
        setAttachmentsLocalStatus(Object.fromEntries(statusEntries));
        console.log("[Attachments] state updated", { count: items.length });
      } catch (e: any) {
        console.warn("[Attachments] list failed", e);
        pushNotice({ message: "Failed to load attachments", type: "error" });
      }
    },
    [pushNotice]
  );

  const ensureDriveAttachmentsFolder = useCallback(async (driveFolderId: string) => {
    const folders = await listFoldersInFolder(driveFolderId);
    const existing = folders.find((f) => f.name?.toLowerCase() === "attachments");
    if (existing) return existing.id;
    return createDriveFolder("attachments", driveFolderId);
  }, []);

  const handleAddBookAttachment = useCallback(async () => {
    if (!activeBook) return;
    try {
      const adapter = getImportAdapter(uiMode as any);
      if (!adapter.pickAttachmentFiles) {
        pushNotice({ message: "Attachment picker not available", type: "error" });
        return;
      }
      const picks = await adapter.pickAttachmentFiles();
      if (!picks.length) return;

      let successCount = 0;
      let driveFolder: string | undefined;

      for (const picked of picks) {
        try {
          const filename = picked.name || `Attachment-${Date.now()}.pdf`;
          const mimeType = picked.mimeType || guessMimeType(filename);
          const bytes = await adapter.readBytes(picked);
          const saved = await saveAttachmentBytes(activeBook.id, filename, bytes);
          let driveFileId: string | undefined;

          if (activeBook.backend === StorageBackend.DRIVE && activeBook.driveFolderId) {
            if (!isAuthorized) {
              pushNotice({
                message: "Drive not connected. Cannot upload attachment.",
                type: "error",
              });
            } else if (!isOnline) {
              pushNotice({ message: "Offline. Connect to upload attachment.", type: "info" });
            } else {
              if (!driveFolder) {
                driveFolder = await ensureDriveAttachmentsFolder(activeBook.driveFolderId);
              }
              const blob = new Blob([bytes as BlobPart], { type: mimeType });
              driveFileId = await uploadToDrive(driveFolder, filename, blob, undefined, mimeType);
            }
          }

          const now = Date.now();
          const attachment: BookAttachment = {
            id: crypto.randomUUID(),
            bookId: activeBook.id,
            driveFileId,
            filename,
            mimeType,
            sizeBytes: saved.sizeBytes,
            localPath: saved.localPath,
            createdAt: now,
            updatedAt: now,
          };
          await libraryUpsertBookAttachment(attachment);
          console.log("[Attachments] addAttachment success", {
            bookId: activeBook.id,
            filename,
            attachmentId: attachment.id,
          });
          successCount++;

          // Immediately refresh the list to ensure the new attachment appears
          try {
            await refreshAttachmentsForBook(activeBook.id);
            console.log("[Attachments] immediate refresh after add", { bookId: activeBook.id });
          } catch (refreshErr) {
            console.warn("[Attachments] immediate refresh failed", refreshErr);
          }
        } catch (e: any) {
          console.warn("[Attachments] addAttachment failed for file", picked.name, e);
          pushNotice({
            message: e?.message || `Failed to add ${picked.name || "attachment"}`,
            type: "error",
          });
        }
      }

      if (successCount > 0) {
        // Final refresh to ensure all attachments are visible (in case multiple were added)
        try {
          // Small delay to ensure database writes are committed
          await new Promise((resolve) => setTimeout(resolve, 100));
          await refreshAttachmentsForBook(activeBook.id);
          console.log("[Attachments] final refresh after add", {
            bookId: activeBook.id,
            count: successCount,
          });
        } catch (refreshError) {
          console.warn("[Attachments] final refresh after add failed", refreshError);
        }
        pushNotice({
          message: successCount === 1 ? "Attachment added" : `${successCount} attachments added`,
          type: "success",
        });
      }
    } catch (e: any) {
      console.warn("[Attachments] addAttachment failed", e);
      pushNotice({ message: e?.message || "Failed to add attachment", type: "error" });
    }
  }, [
    activeBook,
    ensureDriveAttachmentsFolder,
    isAuthorized,
    isOnline,
    pushNotice,
    refreshAttachmentsForBook,
    uiMode,
  ]);

  const handleDownloadAttachment = useCallback(
    async (attachment: BookAttachment) => {
      if (!activeBook) return;
      if (!attachment.driveFileId) {
        pushNotice({ message: "Attachment missing Drive link", type: "error" });
        return;
      }
      if (!isAuthorized) {
        pushNotice({ message: "Drive disconnected", type: "error" });
        return;
      }
      if (!isOnline) {
        pushNotice({ message: "Offline. Connect to download.", type: "info" });
        return;
      }
      setAttachmentDownloads((p) => ({ ...p, [attachment.id]: true }));
      try {
        console.log("[Attachments] download start", {
          id: attachment.id,
          fileId: attachment.driveFileId,
        });
        const blob = await fetchDriveBinary(attachment.driveFileId);
        const filename = attachment.filename || `Attachment-${attachment.id}.pdf`;
        const saved = await saveAttachmentBlob(activeBook.id, filename, blob);
        const updated: BookAttachment = {
          ...attachment,
          localPath: saved.localPath,
          sizeBytes: saved.sizeBytes,
          updatedAt: Date.now(),
        };
        await libraryUpsertBookAttachment(updated);
        console.log("[Attachments] download done", { id: attachment.id, bytes: saved.sizeBytes });
        await refreshAttachmentsForBook(activeBook.id);
      } catch (e: any) {
        console.warn("[Attachments] download failed", e);
        pushNotice({ message: e?.message || "Attachment download failed", type: "error" });
      } finally {
        setAttachmentDownloads((p) => ({ ...p, [attachment.id]: false }));
      }
    },
    [activeBook, isAuthorized, isOnline, pushNotice, refreshAttachmentsForBook]
  );

  const handleOpenAttachment = useCallback(
    async (attachment: BookAttachment) => {
      const exists = await attachmentExists(attachment.localPath);
      if (!exists) {
        pushNotice({ message: "Attachment missing locally. Download it first.", type: "info" });
        return;
      }
      const uri = await resolveAttachmentUri(attachment.localPath);
      if (!uri) {
        pushNotice({ message: "Unable to open attachment", type: "error" });
        return;
      }
      setAttachmentViewer({ attachment, uri });
    },
    [pushNotice]
  );

  const startEditingAttachment = useCallback((att: BookAttachment) => {
    setEditingAttachmentId(att.id);
    setEditingFilename(att.filename);
  }, []);

  const cancelEditingAttachment = useCallback(() => {
    setEditingAttachmentId(null);
    setEditingFilename("");
  }, []);

  const commitRenameAttachment = useCallback(
    async (attachment: BookAttachment, newFilename: string) => {
      const trimmed = newFilename.trim();
      setEditingAttachmentId(null);
      setEditingFilename("");
      if (!trimmed || !activeBook || trimmed === attachment.filename) return;
      try {
        const updated: BookAttachment = { ...attachment, filename: trimmed, updatedAt: Date.now() };
        await libraryUpsertBookAttachment(updated);
        await refreshAttachmentsForBook(activeBook.id);
        pushNotice({ message: "Attachment renamed", type: "success" });
      } catch (e: any) {
        console.warn("[Attachments] rename failed", e);
        pushNotice({ message: e?.message || "Failed to rename attachment", type: "error" });
      }
    },
    [activeBook, pushNotice, refreshAttachmentsForBook]
  );

  const handleDeleteBookAttachment = useCallback(
    async (attachment: BookAttachment) => {
      if (!activeBook) return;
      try {
        await libraryDeleteBookAttachment(attachment.id);
        await refreshAttachmentsForBook(activeBook.id);
        if (attachmentViewer?.attachment.id === attachment.id) {
          setAttachmentViewer(null);
        }
        pushNotice({ message: "Attachment removed", type: "success" });
      } catch (e: any) {
        console.warn("[Attachments] delete failed", e);
        pushNotice({ message: e?.message || "Failed to remove attachment", type: "error" });
      }
    },
    [activeBook, attachmentViewer?.attachment.id, pushNotice, refreshAttachmentsForBook]
  );

  // Auto-load attachments when activeBook changes
  useEffect(() => {
    if (activeBook?.id) {
      console.log("[Attachments] auto-loading for book", activeBook.id);
      void refreshAttachmentsForBook(activeBook.id);
    } else {
      setAttachmentsList([]);
      setAttachmentsLocalStatus({});
    }
  }, [activeBook?.id, refreshAttachmentsForBook]);

  return {
    attachmentsList,
    attachmentsLocalStatus,
    attachmentViewer,
    setAttachmentViewer,
    attachmentDownloads,
    editingAttachmentId,
    editingFilename,
    setEditingFilename,
    startEditingAttachment,
    cancelEditingAttachment,
    commitRenameAttachment,
    refreshAttachmentsForBook,
    ensureDriveAttachmentsFolder,
    handleAddBookAttachment,
    handleDownloadAttachment,
    handleOpenAttachment,
    handleDeleteBookAttachment,
  };
}
