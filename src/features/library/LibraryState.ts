import { useCallback, useMemo, useState } from "react";
import type { Book } from "../../../types";
import { StorageBackend } from "../../../types";

type Params = {
  books: Book[];
  onAddBook: (
    title: string,
    backend: StorageBackend,
    directoryHandle?: any,
    driveFolderId?: string,
    driveFolderName?: string
  ) => Promise<void>;
  isCloudLinked: boolean;
  onLinkCloud: () => void;
};

export type LibraryState = {
  sortedBooks: Book[];
  isAdding: boolean;
  newTitle: string;
  isProcessingAdd: boolean;
};

export type LibraryActions = {
  startAdd: () => void;
  cancelAdd: () => void;
  setTitle: (title: string) => void;
  addWithBackend: (backend: StorageBackend, handle?: any, driveFolderId?: string, driveFolderName?: string) => Promise<void>;
  startDriveAdd: () => Promise<void>;
};

export function useLibraryState(params: Params): { state: LibraryState; actions: LibraryActions } {
  const { books, onAddBook, isCloudLinked, onLinkCloud } = params;
  const [isAdding, setIsAdding] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [isProcessingAdd, setIsProcessingAdd] = useState(false);

  const sortedBooks = useMemo(() => {
    return [...books].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  }, [books]);

  const addWithBackend = useCallback(
    async (backend: StorageBackend, handle?: any, driveFolderId?: string, driveFolderName?: string) => {
      if (!newTitle.trim()) return;
      setIsProcessingAdd(true);
      try {
        await onAddBook(newTitle.trim(), backend, handle, driveFolderId, driveFolderName);
        setIsAdding(false);
        setNewTitle("");
      } finally {
        setIsProcessingAdd(false);
      }
    },
    [newTitle, onAddBook]
  );

  const startDriveAdd = useCallback(async () => {
    if (!isCloudLinked) {
      onLinkCloud();
      return;
    }
    await addWithBackend(StorageBackend.DRIVE);
  }, [addWithBackend, isCloudLinked, onLinkCloud]);

  return {
    state: {
      sortedBooks,
      isAdding,
      newTitle,
      isProcessingAdd,
    },
    actions: {
      startAdd: () => setIsAdding(true),
      cancelAdd: () => setIsAdding(false),
      setTitle: setNewTitle,
      addWithBackend,
      startDriveAdd,
    },
  };
}
