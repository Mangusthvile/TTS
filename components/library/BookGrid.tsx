import React from "react";
import { BookOpen, Cloud, HardDrive } from "lucide-react";
import { StorageBackend, Theme, type Book } from "../../types";

type Props = {
  books: Book[];
  activeBookId?: string;
  onSelectBook: (bookId: string) => void;
  theme: Theme;
};

/** Deterministic gradient from book id so each book has its own consistent color */
function bookGradient(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  const gradients = [
    "from-indigo-600 to-violet-700",
    "from-violet-600 to-purple-700",
    "from-blue-600 to-indigo-700",
    "from-emerald-600 to-teal-700",
    "from-rose-600 to-pink-700",
    "from-amber-600 to-orange-700",
    "from-cyan-600 to-blue-700",
    "from-fuchsia-600 to-pink-700",
    "from-teal-600 to-emerald-700",
    "from-orange-600 to-red-700",
  ];
  return gradients[hash % gradients.length];
}

const BookGrid: React.FC<Props> = ({ books, activeBookId, onSelectBook, theme }) => {
  const isDark = theme === Theme.DARK;
  const ringActive =
    "ring-2 ring-[color:var(--tvx-accent)] shadow-[0_0_32px_rgba(99,102,241,0.45)]";

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-5">
      {books.map((book) => {
        const chapterCount = book.chapterCount ?? book.chapters.length;
        const localDisabled = __ANDROID_ONLY__ && book.backend === StorageBackend.LOCAL;
        const isActive = activeBookId === book.id;
        const gradient = bookGradient(book.id || book.title);

        return (
          <div key={book.id} className="flex flex-col gap-2.5 group">
            {/* Card */}
            <div
              onClick={() => {
                if (localDisabled) {
                  alert("Local-folder books are disabled in this Android-only build.");
                  return;
                }
                onSelectBook(book.id);
              }}
              className={[
                "aspect-[2/3] rounded-[2rem] overflow-hidden relative cursor-pointer transition-all duration-200",
                "shadow-[0_8px_24px_rgba(0,0,0,0.18)] hover:shadow-[0_12px_36px_rgba(0,0,0,0.28)]",
                "hover:scale-[1.03] active:scale-[0.98]",
                isActive ? ringActive : "",
                localDisabled ? "opacity-50 cursor-not-allowed" : "",
              ].join(" ")}
            >
              {book.coverImage ? (
                <img
                  src={book.coverImage}
                  className="w-full h-full object-cover"
                  alt={book.title}
                />
              ) : (
                /* Polished gradient placeholder */
                <div
                  className={`w-full h-full bg-gradient-to-br ${gradient} flex flex-col items-center justify-center relative overflow-hidden`}
                >
                  {/* decorative circles */}
                  <div className="absolute -top-6 -right-6 w-24 h-24 rounded-full bg-white/10" />
                  <div className="absolute -bottom-8 -left-8 w-32 h-32 rounded-full bg-black/10" />
                  <div className="absolute top-1/3 left-1/2 -translate-x-1/2 -translate-y-1/2 w-16 h-16 rounded-full bg-white/10" />
                  {/* icon */}
                  <BookOpen className="w-9 h-9 text-white/80 relative z-10 drop-shadow mb-2" />
                  {/* title inset */}
                  <div className="relative z-10 px-3 text-center">
                    <div
                      className="text-white font-black leading-tight drop-shadow-md"
                      style={{
                        fontSize: "clamp(8px, 2.5vw, 11px)",
                        WebkitLineClamp: 3,
                        WebkitBoxOrient: "vertical",
                        display: "-webkit-box",
                        overflow: "hidden",
                      }}
                    >
                      {book.title}
                    </div>
                  </div>
                </div>
              )}

              {/* Chapter count badge */}
              {chapterCount > 0 && (
                <div className="absolute top-2.5 right-2.5 px-2 py-0.5 bg-black/50 backdrop-blur-sm text-white text-[9px] font-black rounded-full shadow">
                  {Math.min(chapterCount, 9999)}
                </div>
              )}

              {/* Backend badge */}
              <div className="absolute bottom-2.5 left-2.5">
                {book.backend === StorageBackend.DRIVE ? (
                  <div className="flex items-center gap-1 px-1.5 py-0.5 bg-black/50 backdrop-blur-sm rounded-full">
                    <Cloud className="w-2.5 h-2.5 text-white/80" />
                  </div>
                ) : book.backend === StorageBackend.LOCAL ? (
                  <div className="flex items-center gap-1 px-1.5 py-0.5 bg-black/50 backdrop-blur-sm rounded-full">
                    <HardDrive className="w-2.5 h-2.5 text-white/80" />
                  </div>
                ) : null}
              </div>

              {localDisabled && (
                <div className="absolute inset-0 flex items-end justify-center pb-3">
                  <div className="px-2 py-1 bg-black/70 text-white text-[9px] font-black rounded-full">
                    LOCAL DISABLED
                  </div>
                </div>
              )}

              {/* Active tint overlay */}
              {isActive && (
                <div className="absolute inset-0 bg-[color:var(--tvx-accent)]/10 pointer-events-none" />
              )}
            </div>

            {/* Title + chapter count below card */}
            <div
              onClick={() => {
                if (localDisabled) return;
                onSelectBook(book.id);
              }}
              className={localDisabled ? "cursor-not-allowed" : "cursor-pointer"}
            >
              <div
                className={`font-black text-xs sm:text-sm line-clamp-1 heading-font transition-colors ${
                  isActive
                    ? "text-[color:var(--tvx-accent)]"
                    : isDark
                      ? "text-white/90"
                      : "text-gray-900"
                }`}
              >
                {book.title}
              </div>
              <div className="text-[9px] font-bold uppercase tracking-tighter text-muted">
                {chapterCount} {chapterCount === 1 ? "chapter" : "chapters"}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
};

export default BookGrid;
