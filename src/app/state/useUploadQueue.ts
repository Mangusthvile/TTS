import { useCallback, useState } from "react";
import type { Book, UiMode } from "../../../types";
import { enqueueUploads, listUploadQueue, countUploadQueue, startUploads } from "../../../services/uploadManager";
import { removeQueuedUpload } from "../../../services/uploadQueueStore";
import type { DriveUploadQueuedItem } from "../../../services/driveUploadQueueService";

export type UploadQueueHookArgs = {
  uiMode: UiMode;
  books: Book[];
  activeBookId?: string;
  resolveLocalPathForUpload: (chapterId: string, fallbackPath?: string) => Promise<string | null>;
  uploadChapterNow: (bookId: string, chapterId: string) => Promise<boolean>;
  pushNotice: (notice: { message: string; type: "info" | "success" | "error" }) => void;
};

export function useUploadQueue(args: UploadQueueHookArgs) {
  const { uiMode, books, activeBookId, resolveLocalPathForUpload, uploadChapterNow, pushNotice } = args;
  const [uploadQueueCount, setUploadQueueCount] = useState(0);
  const [uploadQueueItems, setUploadQueueItems] = useState<DriveUploadQueuedItem[]>([]);
  const [isUploadingAll, setIsUploadingAll] = useState(false);
  const [showDownloadedChapters, setShowDownloadedChapters] = useState(false);
  const [showUploadQueue, setShowUploadQueue] = useState(false);

  const refreshUploadQueueCount = useCallback(async () => {
    try {
      const count = await countUploadQueue();
      setUploadQueueCount(count);
    } catch {
      // ignore
    }
  }, []);

  const refreshUploadQueueList = useCallback(async () => {
    try {
      const items = await listUploadQueue();
      setUploadQueueItems(items);
      setUploadQueueCount(items.length);
    } catch {
      // ignore
    }
  }, []);

  const kickUploadQueue = useCallback(async () => {
    try {
      await startUploads(uiMode);
    } catch {
      // ignore
    }
  }, [uiMode]);

  const handleQueueChapterUpload = useCallback(
    async (chapterId: string) => {
      const book = books.find((b) => b.id === activeBookId);
      if (!book) return;
      const chapter = book.chapters.find((c) => c.id === chapterId);
      if (!chapter) return;
      try {
        await uploadChapterNow(book.id, chapterId);
        pushNotice({ message: "Chapter uploaded", type: "success" });
        await refreshUploadQueueCount();
        await refreshUploadQueueList();
        return;
      } catch (e: any) {
        const localPath = await resolveLocalPathForUpload(chapterId, chapter.audioSignature);
        if (!localPath) {
          pushNotice({ message: "Local audio not found for upload", type: "error" });
          return;
        }
        const queued = await enqueueUploads(
          [{ bookId: book.id, chapterId, localPath, manual: true, source: "audio" }],
          uiMode
        );
        if (queued) {
          pushNotice({ message: "Upload queued (will retry)", type: "info" });
          await kickUploadQueue();
          await refreshUploadQueueCount();
          await refreshUploadQueueList();
        } else {
          pushNotice({ message: `Upload failed: ${String(e?.message ?? e)}`, type: "error" });
        }
      }
    },
    [activeBookId, books, resolveLocalPathForUpload, uploadChapterNow, pushNotice, refreshUploadQueueCount, refreshUploadQueueList, kickUploadQueue, uiMode]
  );

  const handleUploadAllChapters = useCallback(async () => {
    setIsUploadingAll(true);
    try {
      const book = books.find((b) => b.id === activeBookId);
      if (!book) return;
      let queued = 0;
      let uploaded = 0;
      for (const ch of book.chapters) {
        try {
          await uploadChapterNow(book.id, ch.id);
          uploaded += 1;
        } catch (e: any) {
          const localPath = await resolveLocalPathForUpload(ch.id, ch.audioSignature);
          if (!localPath) continue;
          const queuedCount = await enqueueUploads(
            [{ bookId: book.id, chapterId: ch.id, localPath, manual: true, source: "audio" }],
            uiMode
          );
          if (queuedCount) queued += 1;
        }
      }
      if (uploaded) pushNotice({ message: `Uploaded ${uploaded} chapters`, type: "success" });
      if (queued) pushNotice({ message: `Queued ${queued} uploads (will retry)`, type: "info" });
      if (queued) await kickUploadQueue();
      await refreshUploadQueueCount();
      await refreshUploadQueueList();
    } finally {
      setIsUploadingAll(false);
    }
  }, [activeBookId, books, resolveLocalPathForUpload, uploadChapterNow, pushNotice, refreshUploadQueueCount, refreshUploadQueueList, kickUploadQueue, uiMode]);

  const handleDismissQueuedUpload = useCallback(async (id: string) => {
    const ok = await removeQueuedUpload(id);
    if (ok) {
      await refreshUploadQueueCount();
      await refreshUploadQueueList();
    }
  }, [refreshUploadQueueCount, refreshUploadQueueList]);

  return {
    uploadQueueCount,
    uploadQueueItems,
    isUploadingAll,
    showDownloadedChapters,
    setShowDownloadedChapters,
    showUploadQueue,
    setShowUploadQueue,
    refreshUploadQueueCount,
    refreshUploadQueueList,
    handleQueueChapterUpload,
    handleUploadAllChapters,
    handleDismissQueuedUpload,
    kickUploadQueue,
  };
}
