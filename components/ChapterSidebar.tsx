import React, { useEffect, useRef } from 'react';
import { Book, Chapter, Theme } from '../types';
import { UiMode } from '../types';

interface ChapterSidebarProps {
  book: Book;
  theme: Theme;
  onSelectChapter: (id: string) => void;
  onClose: () => void;
  isDrawer: boolean;
  uiMode?: UiMode;
  isMobile?: boolean;
  playbackSnapshot?: { chapterId: string; percent: number } | null;

  onLoadMoreChapters?: () => void;
  hasMoreChapters?: boolean;
  isLoadingMoreChapters?: boolean;
}

const ChapterSidebar: React.FC<ChapterSidebarProps> = ({
  book,
  theme,
  onSelectChapter,
  onClose,
  isDrawer,
  uiMode,
  isMobile,
  playbackSnapshot,
  onLoadMoreChapters,
  hasMoreChapters,
  isLoadingMoreChapters,
}) => {
  const isDark = theme === Theme.DARK;
  const isSepia = theme === Theme.SEPIA;

  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const lastScrollCallRef = useRef(0);
  const mobileMode = (typeof isMobile === 'boolean') ? isMobile : uiMode === 'mobile';

  const tryLoadMore = () => {
    if (!hasMoreChapters || !onLoadMoreChapters || isLoadingMoreChapters) return;
    onLoadMoreChapters();
  };

  useEffect(() => {
    if (!hasMoreChapters || !onLoadMoreChapters) return;
    const el = sentinelRef.current;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') return;

    const obs = new IntersectionObserver(
      (entries) => {
        const first = entries[0];
        if (first?.isIntersecting && !isLoadingMoreChapters) {
          tryLoadMore();
        }
      },
      { root: containerRef.current || undefined, rootMargin: '200px' }
    );

    obs.observe(el);
    return () => obs.disconnect();
  }, [hasMoreChapters, onLoadMoreChapters, isLoadingMoreChapters]);

  // Mobile / fallback: watch scroll distance and trigger when near end.
  useEffect(() => {
    if (!hasMoreChapters || !onLoadMoreChapters) return;
    const el = containerRef.current;
    if (!el) return;

    const handleScroll = () => {
      const now = Date.now();
      if (now - lastScrollCallRef.current < 250) return;
      const remaining = el.scrollHeight - (el.scrollTop + el.clientHeight);
      if (remaining < 600) {
        lastScrollCallRef.current = now;
        tryLoadMore();
      }
    };

    handleScroll();

    if (mobileMode || typeof IntersectionObserver === 'undefined') {
      el.addEventListener('scroll', handleScroll);
      return () => el.removeEventListener('scroll', handleScroll);
    }
  }, [hasMoreChapters, onLoadMoreChapters, isLoadingMoreChapters, mobileMode]);

  const bgClass = isDark ? 'bg-neutral-900' : isSepia ? 'bg-amber-50' : 'bg-white';
  const textClass = isDark ? 'text-neutral-100' : isSepia ? 'text-amber-900' : 'text-neutral-900';
  const borderClass = isDark ? 'border-neutral-700' : 'border-neutral-200';
  const hoverClass = isDark ? 'hover:bg-neutral-800' : isSepia ? 'hover:bg-amber-100' : 'hover:bg-neutral-100';
  const activeClass = isDark ? 'bg-indigo-900/40' : isSepia ? 'bg-indigo-100' : 'bg-indigo-50';

  const isActive = (chapter: Chapter) => playbackSnapshot?.chapterId === chapter.id;
  const progressOf = (chapter: Chapter) =>
    isActive(chapter) ? playbackSnapshot?.percent ?? 0 : chapter.progress ?? 0;

  return (
    <div className={`flex flex-col h-full ${bgClass} ${textClass} ${isDrawer ? '' : 'border-r'} ${borderClass}`}>
      <div className={`flex items-center justify-between px-6 py-4 border-b ${borderClass}`}>
        <div className="min-w-0">
          <div className="text-xs uppercase tracking-widest opacity-60">Chapters</div>
          <div className="font-semibold truncate">{book.title}</div>
        </div>
        {isDrawer && (
          <button onClick={onClose} className={`px-3 py-1 rounded-lg border ${borderClass} ${hoverClass}`}>
            Close
          </button>
        )}
      </div>

      <div ref={containerRef} className="flex-1 overflow-y-auto">
        {book.chapters.map((chapter) => {
          const active = isActive(chapter);
          const progress = progressOf(chapter);

          return (
            <button
              key={chapter.id}
              onClick={() => onSelectChapter(chapter.id)}
              className={`w-full text-left px-6 py-3 border-b ${borderClass} ${hoverClass} ${active ? activeClass : ''}`}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium truncate">{chapter.title}</div>
                  <div className="text-xs opacity-60">Chapter {chapter.index}</div>
                </div>

                <div className="text-xs opacity-70 tabular-nums">{Math.round(progress * 100)}%</div>
              </div>

              <div className={`mt-2 h-1 rounded-full ${isDark ? 'bg-neutral-700' : 'bg-neutral-200'}`}>
                <div
                  className={`h-1 rounded-full ${isDark ? 'bg-indigo-400' : 'bg-indigo-600'}`}
                  style={{ width: `${Math.round(progress * 100)}%` }}
                />
              </div>
            </button>
          );
        })}

        {hasMoreChapters && (
          <div
            ref={sentinelRef}
            className={`px-6 py-4 text-xs ${textClass} opacity-60 text-center space-y-2`}
          >
            <div>{isLoadingMoreChapters ? 'Loading more...' : 'Scroll or tap to load more'}</div>
            <button
              onClick={tryLoadMore}
              className="px-3 py-1 rounded-full border border-indigo-400 text-indigo-600 text-[11px] font-bold uppercase tracking-widest"
              disabled={isLoadingMoreChapters}
            >
              Load more
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default ChapterSidebar;
