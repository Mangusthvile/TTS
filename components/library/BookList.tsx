import React from "react";
import { BookOpen } from "lucide-react";
import { StorageBackend, Theme, type Book } from "../../types";

type Props = {
  books: Book[];
  activeBookId?: string;
  onSelectBook: (bookId: string) => void;
  theme: Theme;
};

const BookList: React.FC<Props> = ({ books, activeBookId, onSelectBook, theme }) => {
  const textPrimary = "text-theme";
  const textMuted = "text-muted";

  return (
    <div className="space-y-3">
      {books.map((book) => {
        const chapterCount = book.chapterCount ?? book.chapters.length;
        const localDisabled = __ANDROID_ONLY__ && book.backend === StorageBackend.LOCAL;
        return (
          <button
            key={book.id}
            onClick={() => {
              if (localDisabled) return;
              onSelectBook(book.id);
            }}
            className={`w-full flex items-center gap-4 p-4 rounded-2xl border transition-all ${
              activeBookId === book.id ? "bg-surface-2 ring-2 ring-[color:var(--tvx-accent)]" : "bg-card border-card"
            } ${localDisabled ? "opacity-60 cursor-not-allowed" : "hover:bg-surface-2"}`}
          >
            <div className="w-12 h-16 rounded-xl overflow-hidden bg-surface-2 flex items-center justify-center">
              {book.coverImage ? (
                <img src={book.coverImage} alt={book.title} className="w-full h-full object-cover" />
              ) : (
                <BookOpen className="w-6 h-6 text-muted/50" />
              )}
            </div>
            <div className="flex-1 min-w-0 text-left">
              <div className={`font-black text-sm line-clamp-1 heading-font ${textPrimary}`}>{book.title}</div>
              <div className={`text-[10px] font-bold uppercase tracking-tighter ${textMuted}`}>{chapterCount} chapters</div>
            </div>
          </button>
        );
      })}
    </div>
  );
};

export default BookList;
