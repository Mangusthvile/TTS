import React, { useMemo, useState } from "react";
import { Book, StorageBackend, Theme } from "../types";
import { BookOpen, Plus, Cloud, Database, Monitor } from "lucide-react";

interface Props {
  books: Book[];
  activeBookId?: string;
  onSelectBook: (bookId: string) => void;
  onAddBook: (
    title: string,
    backend: StorageBackend,
    directoryHandle?: any,
    driveFolderId?: string,
    driveFolderName?: string
  ) => Promise<void>;
  theme: Theme;
  isCloudLinked: boolean;
  onLinkCloud: () => void;
}

const Library: React.FC<Props> = ({
  books,
  activeBookId,
  onSelectBook,
  onAddBook,
  theme,
  isCloudLinked,
  onLinkCloud,
}) => {
  const [isAdding, setIsAdding] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [isProcessingAdd, setIsProcessingAdd] = useState(false);


  const isDark = theme === Theme.DARK;
  const isSepia = theme === Theme.SEPIA;

  const textPrimary = "text-theme";
  const textMuted = "text-muted";

  const headerIconColor = isDark ? "text-indigo-300" : "text-indigo-600";

  const chromeButton =
    "btn-primary";

  const panel = "card-cinematic";

  const optionCard =
    "card-cinematic";

  const cardShell =
    "card-cinematic";

  const ringActive = "ring-2 ring-[color:var(--tvx-accent)] shadow-[0_0_24px_rgba(99,102,241,0.35)]";

  const sortedBooks = useMemo(() => {
    return [...books].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  }, [books]);

  const handleAdd = async (backend: StorageBackend, handle?: any, driveFolderId?: string, driveFolderName?: string) => {
    if (!newTitle.trim()) return;

    setIsProcessingAdd(true);
    try {
      await onAddBook(newTitle.trim(), backend, handle, driveFolderId, driveFolderName);
      setIsAdding(false);
      setNewTitle("");
    } catch (e: any) {
      alert("Error adding book: " + (e?.message ?? String(e)));
    } finally {
      setIsProcessingAdd(false);
    }
  };

  const handleStartDriveAdd = async () => {
    if (!isCloudLinked) {
      onLinkCloud();
      return;
    }
    await handleAdd(StorageBackend.DRIVE);
  };

  return (
    <div className="h-full w-full flex flex-col min-w-0 bg-transparent">
      {/* Header matches desktop look */}
      <div className="px-6 sm:px-10 pt-10 sm:pt-12 flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-3">
          <BookOpen className={`w-7 h-7 sm:w-8 sm:h-8 ${headerIconColor}`} />
          <h2 className={`text-3xl sm:text-4xl font-black tracking-tight heading-font ${textPrimary}`}>Library</h2>
        </div>

        <button
          onClick={() => setIsAdding(true)}
          className={`w-12 h-12 rounded-full flex items-center justify-center shadow-xl transition-all active:scale-95 ${chromeButton}`}
          aria-label="Add Book"
        >
          <Plus className="w-6 h-6" />
        </button>
      </div>

      {/* Add book panel */}
      {isAdding && (
        <div className="px-6 sm:px-10 pt-6 flex-shrink-0">
          <div className={`p-6 rounded-[2rem] shadow-2xl ${panel}`}>
            <div className="space-y-2">
              <label className={`text-[10px] font-black uppercase tracking-widest ${textMuted}`}>New Book Title</label>
              <input
                autoFocus
                disabled={isProcessingAdd}
                type="text"
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                placeholder="e.g. The Mech Touch"
                className="w-full px-4 py-4 rounded-xl outline-none text-sm font-bold input-theme border border-card"
              />
            </div>

            <div className={`grid grid-cols-1 ${__ANDROID_ONLY__ ? "" : "sm:grid-cols-3"} gap-3 mt-4`}>
              {!__ANDROID_ONLY__ && (
                <button
                  disabled={isProcessingAdd}
                  onClick={() => handleAdd(StorageBackend.MEMORY)}
                className={`p-4 rounded-2xl flex flex-col items-center gap-2 text-[10px] font-black uppercase transition-all ${optionCard}`}
              >
                <Database className="w-5 h-5 text-emerald-500" />
                Memory
              </button>
              )}

              <button
                disabled={isProcessingAdd}
                onClick={handleStartDriveAdd}
                className={`p-4 rounded-2xl flex flex-col items-center gap-2 text-[10px] font-black uppercase transition-all ${optionCard}`}
              >
                <Cloud className="w-5 h-5 text-indigo-500" />
                {isCloudLinked ? "Drive" : "Link Drive"}
              </button>

              {!__ANDROID_ONLY__ && (
                <button
                  disabled={isProcessingAdd}
                  onClick={async () => {
                    try {
                      const w: any = window as any;
                      if (typeof w.showDirectoryPicker === "function") {
                        const h = await w.showDirectoryPicker({ mode: "readwrite" });
                        await handleAdd(StorageBackend.LOCAL, h);
                      } else {
                        await handleAdd(StorageBackend.LOCAL);
                      }
                    } catch {
                      await handleAdd(StorageBackend.LOCAL);
                    }
                  }}
                  className={`p-4 rounded-2xl flex flex-col items-center gap-2 text-[10px] font-black uppercase transition-all ${optionCard}`}
                >
                  <Monitor className={`w-5 h-5 ${isDark ? "text-slate-300" : isSepia ? "text-[#3c2f25]" : "text-slate-600"}`} />
                  Local
                </button>
              )}
            </div>

            <button
              onClick={() => setIsAdding(false)}
              className={`w-full mt-3 py-2 text-[10px] font-black uppercase tracking-widest ${textMuted}`}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Books grid: matches desktop spacing and left alignment */}
      <div className="flex-1 min-w-0 overflow-y-auto px-6 sm:px-10 pt-10 pb-20">
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-6">
          {sortedBooks.map((book) => {
            const chapterCount = book.chapterCount ?? book.chapters.length;
            const localDisabled = __ANDROID_ONLY__ && book.backend === StorageBackend.LOCAL;

            return (
              <div key={book.id} className="flex flex-col gap-2 group">
                <div
                  onClick={() => {
                    if (localDisabled) {
                      alert("Local-folder books are disabled in this Android-only build.");
                      return;
                    }
                    onSelectBook(book.id);
                  }}
                  className={[
                    "aspect-[2/3] rounded-[2.5rem] overflow-hidden relative shadow-2xl cursor-pointer transition-all",
                    cardShell,
                    activeBookId === book.id ? ringActive : "",
                    localDisabled ? "opacity-60 cursor-not-allowed" : "",
                  ].join(" ")}
                >
                  {book.coverImage ? (
                    <img src={book.coverImage} className="w-full h-full object-cover" alt={book.title} />
                  ) : (
                    <div className={`w-full h-full flex flex-col items-center justify-center text-center ${isDark ? "bg-slate-900" : isSepia ? "bg-[#efe6d5]" : "bg-slate-100"}`}>
                      <BookOpen className={`w-12 h-12 ${isDark ? "text-white/15" : "text-black/10"}`} />
                      <div className={`mt-2 px-3 text-[10px] font-black uppercase tracking-widest ${isDark ? "text-white/40" : "text-black/40"}`}>
                        {book.title}
                      </div>
                    </div>
                  )}

                  {/* Top-right badge like desktop screenshot */}
                  {chapterCount > 0 && (
                    <div className="absolute top-3 right-3 px-2.5 py-1 bg-[color:var(--tvx-accent)] text-white text-[10px] font-black rounded-full shadow-lg">
                      {Math.min(chapterCount, 9999)}
                    </div>
                  )}
                  {localDisabled && (
                    <div className="absolute bottom-3 left-3 px-2 py-1 bg-black/60 text-white text-[10px] font-black rounded-full shadow-lg">
                      LOCAL DISABLED
                    </div>
                  )}
                </div>

                <div
                  onClick={() => {
                    if (localDisabled) return;
                    onSelectBook(book.id);
                  }}
                  className={localDisabled ? "cursor-not-allowed" : "cursor-pointer"}
                >
                  <div className={`font-black text-xs sm:text-sm line-clamp-1 heading-font ${textPrimary}`}>{book.title}</div>
                  <div className={`text-[9px] font-bold uppercase tracking-tighter ${textMuted}`}>{chapterCount} chapters</div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export default Library;
