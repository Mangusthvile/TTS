import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Chapter } from '../../../types';
import { listChaptersPage, upsertChapterMeta } from '../../../services/libraryStore';
import { getChapterSortOrder } from '../../../services/chapterOrderingService';
import { normalizeChapterTitle } from '../../../utils/titleCase';
import { orderChaptersForDisplay } from '../../../utils/chapterBookUtils';
import { trace } from '../../../utils/trace';

export function useChapterPaging(setState: React.Dispatch<React.SetStateAction<AppState>>) {
  const [chapterPagingByBook, setChapterPagingByBook] = useState<Record<string, { afterIndex: number; hasMore: boolean; loading: boolean }>>({});
  const chapterPagingRef = useRef<Record<string, { afterIndex: number; hasMore: boolean; loading: boolean }>>({});
  const warnedTextClearRef = useRef<Set<string>>(new Set());

  useEffect(() => { chapterPagingRef.current = chapterPagingByBook; }, [chapterPagingByBook]);

  const preserveChapterContent = useCallback((prev: Chapter, next: Chapter, reason: string): Chapter => {
    const prevContent = typeof prev.content === 'string' && prev.content.length > 0 ? prev.content : null;
    const nextContent = typeof next.content === 'string' && next.content.length > 0 ? next.content : null;
    if (prevContent && !nextContent) {
      if (!warnedTextClearRef.current.has(prev.id)) {
        warnedTextClearRef.current.add(prev.id);
        trace('text:clear:prevented', { chapterId: prev.id, reason }, 'warn');
      }
      return {
        ...next,
        content: prevContent,
        textLength: prev.textLength ?? prevContent.length,
      };
    }
    if (nextContent && (!next.textLength || next.textLength === 0)) {
      return { ...next, textLength: nextContent.length };
    }
    return next;
  }, []);

  const loadMoreChapters = useCallback(async (bookId: string, reset: boolean = false) => {
    const limit = 200;

    const current = chapterPagingRef.current[bookId] ?? { afterIndex: -1, hasMore: true, loading: false };
    if (current.loading) return;
    if (!current.hasMore && !reset) return;

    setChapterPagingByBook((p) => ({
      ...p,
      [bookId]: { ...current, afterIndex: reset ? -1 : current.afterIndex, hasMore: true, loading: true },
    }));

    try {
      const afterIndex = reset ? -1 : current.afterIndex;
      const page = await listChaptersPage(bookId, afterIndex, limit);
      const normalizedPageChapters = page.chapters.map((chapter: Chapter) => {
        const sortOrder = getChapterSortOrder(chapter);
        const fallbackTitle =
          Number.isFinite(sortOrder) && sortOrder > 0 ? `Chapter ${sortOrder}` : 'Chapter';
        const normalizedTitle = normalizeChapterTitle(chapter.title, fallbackTitle);
        if (normalizedTitle && normalizedTitle !== chapter.title) {
          const normalizedChapter = {
            ...chapter,
            sortOrder,
            title: normalizedTitle,
          };
          void upsertChapterMeta(bookId, { ...normalizedChapter, content: undefined });
          return normalizedChapter;
        }
        return {
          ...chapter,
          sortOrder,
        };
      });

      setState((p) => {
        const books = p.books.map((b: any) => {
          if (b.id !== bookId) return b;
          const existing = b.chapters;
          const byId = new Map<string, Chapter>();

          const isPlaceholderTitle = (title?: string) => {
            if (!title) return true;
            const t = title.trim().toLowerCase();
            return t.length === 0 || t.startsWith('imported');
          };

          for (const c of existing) {
            byId.set(c.id, c);
          }
          for (const c of normalizedPageChapters) {
            const prev = byId.get(c.id);
            if (!prev) {
              byId.set(c.id, c);
              continue;
            }
            let merged: Chapter = { ...prev, ...c };
            merged.sortOrder = getChapterSortOrder(c);
            if (!isPlaceholderTitle(c.title)) {
              merged.title = c.title;
            } else if (!isPlaceholderTitle(prev.title)) {
              merged.title = prev.title;
            }
            merged = preserveChapterContent(prev, merged, 'loadMoreChapters');
            byId.set(c.id, merged);
          }

          const deduped = orderChaptersForDisplay(Array.from(byId.values()));
          return {
            ...b,
            chapters: deduped,
            chapterCount:
              page.totalCount ??
              (typeof b.chapterCount === 'number' ? Math.max(b.chapterCount, deduped.length) : deduped.length),
          };
        });

        return { ...p, books };
      });

      const hasMore = page.nextAfterIndex != null && page.chapters.length > 0;
      const nextAfterIndex = page.nextAfterIndex ?? (reset ? -1 : current.afterIndex);

      setChapterPagingByBook((p) => ({
        ...p,
        [bookId]: { afterIndex: nextAfterIndex, hasMore, loading: false },
      }));
    } catch (e) {
      console.error('Failed to load chapters page', e);
      setChapterPagingByBook((p) => ({
        ...p,
        [bookId]: { ...current, loading: false },
      }));
    }
  }, [preserveChapterContent, setState]);

  return {
    chapterPagingByBook,
    setChapterPagingByBook,
    loadMoreChapters,
    preserveChapterContent,
  };
}
