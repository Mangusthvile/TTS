import React from "react";
import { Book, StorageBackend, Theme } from "../types";
import { Cloud, Database, Monitor } from "lucide-react";
import LibraryTopBar from "./library/LibraryTopBar";
import LibraryTabs from "./library/LibraryTabs";
import BookGrid from "./library/BookGrid";
import { useLibraryState } from "../src/features/library/LibraryState";

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
  const isDark = theme === Theme.DARK;
  const isSepia = theme === Theme.SEPIA;

  const textPrimary = "text-theme";
  const textMuted = "text-muted";

  const headerIconColor = isDark ? "text-indigo-300" : "text-indigo-600";
  const panel = "card-cinematic";
  const optionCard = "card-cinematic";

  const { state, actions } = useLibraryState({
    books,
    onAddBook,
    isCloudLinked,
    onLinkCloud,
  });

  return (
    <div className="h-full w-full flex flex-col min-w-0 bg-transparent">
      {/* Header matches desktop look */}
      <LibraryTopBar
        title="Library"
        headerIconColor={headerIconColor}
        textPrimary={textPrimary}
        onAdd={actions.startAdd}
      />

      <LibraryTabs tabs={[]} />

      {/* Add book panel */}
      {state.isAdding && (
        <div className="px-6 sm:px-10 pt-6 flex-shrink-0">
          <div className={`p-6 rounded-[2rem] shadow-2xl ${panel}`}>
            <div className="space-y-2">
              <label className={`text-[10px] font-black uppercase tracking-widest ${textMuted}`}>New Book Title</label>
              <input
                autoFocus
                disabled={state.isProcessingAdd}
                type="text"
                value={state.newTitle}
                onChange={(e) => actions.setTitle(e.target.value)}
                placeholder="e.g. The Mech Touch"
                className="w-full px-4 py-4 rounded-xl outline-none text-sm font-bold input-theme border border-card"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-4">
              {!__ANDROID_ONLY__ && (
                <button
                  disabled={state.isProcessingAdd}
                  onClick={() => actions.addWithBackend(StorageBackend.MEMORY)}
                className={`p-4 rounded-2xl flex flex-col items-center gap-2 text-[10px] font-black uppercase transition-all ${optionCard}`}
              >
                <Database className="w-5 h-5 text-emerald-500" />
                Memory
              </button>
              )}

              <button
                disabled={state.isProcessingAdd}
                onClick={actions.startDriveAdd}
                className={`p-4 rounded-2xl flex flex-col items-center gap-2 text-[10px] font-black uppercase transition-all ${optionCard}`}
              >
                <Cloud className="w-5 h-5 text-indigo-500" />
                {isCloudLinked ? "Drive" : "Link Drive"}
              </button>

              <button
                disabled={state.isProcessingAdd}
                onClick={async () => {
                  try {
                    const w: any = window as any;
                    if (typeof w.showDirectoryPicker === "function") {
                      const h = await w.showDirectoryPicker({ mode: "readwrite" });
                      await actions.addWithBackend(StorageBackend.LOCAL, h);
                    } else {
                      await actions.addWithBackend(StorageBackend.LOCAL);
                    }
                  } catch {
                    await actions.addWithBackend(StorageBackend.LOCAL);
                  }
                }}
                className={`p-4 rounded-2xl flex flex-col items-center gap-2 text-[10px] font-black uppercase transition-all ${optionCard}`}
              >
                <Monitor className={`w-5 h-5 ${isDark ? "text-slate-300" : isSepia ? "text-[#3c2f25]" : "text-slate-600"}`} />
                Local
              </button>
            </div>

            <button
              onClick={actions.cancelAdd}
              className={`w-full mt-3 py-2 text-[10px] font-black uppercase tracking-widest ${textMuted}`}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Books grid: matches desktop spacing and left alignment */}
      <div className="flex-1 min-w-0 overflow-y-auto px-6 sm:px-10 pt-10 pb-20">
        <BookGrid books={state.sortedBooks} activeBookId={activeBookId} onSelectBook={onSelectBook} theme={theme} />
      </div>
    </div>
  );
};

export default Library;
