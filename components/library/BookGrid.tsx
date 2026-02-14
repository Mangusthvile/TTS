import React from "react";
import { BookOpen } from "lucide-react";
import { StorageBackend, Theme, type Book } from "../../types";

type Props = {
  books: Book[];
  activeBookId?: string;
  onSelectBook: (bookId: string) => void;
  theme: Theme;
};

const BookGrid: React.FC<Props> = ({ books, activeBookId, onSelectBook, theme }) => {
  const textPrimary = "text-theme";
  const textMuted = "text-muted";
  const cardShell = "card-cinematic";
  const ringActive = "ring-2 ring-[color:var(--tvx-accent)] shadow-[0_0_24px_rgba(99,102,241,0.35)]";

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-6">
      {books.map((book) => {
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
                <div className="w-full h-full flex flex-col items-center justify-center text-center bg-surface-2">
                  <BookOpen className="w-12 h-12 text-muted/40" />
                  <div className="mt-2 px-3 text-[10px] font-black uppercase tracking-widest text-muted">
                    {book.title}
                  </div>
                </div>
              )}

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
  );
};

export default BookGrid;
