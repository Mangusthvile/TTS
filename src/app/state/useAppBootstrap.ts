import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Book, BookAttachment } from '../../../types';
import { RouteContext } from '../types';
import { bootstrapCore } from '../bootstrap';
import { ensureValidToken } from '../../../services/driveAuth';
import { applyFullSnapshot, readLocalSnapshotMeta, restoreFromDriveIfAvailable } from '../../../services/saveRestoreService';
import {
  listBooks,
  listChaptersPage,
  listBookAttachments,
  upsertBook,
  bulkUpsertChapters,
  bulkUpsertBookAttachments,
} from '../../../services/libraryStore';
import { orderChaptersForDisplay, normalizeBookChapters } from '../../../utils/chapterBookUtils';
import { normalizeBookSettings } from '../../features/library/bookSettings';
import { safeSetLocalStorage } from '../../../utils/safeStorage';
import { PROGRESS_STORE_KEY } from '../../../services/speechService';
import { LAUNCH_SYNC_KEY, LAUNCH_SYNC_MIN_MS } from '../constants';

export function useAppBootstrap(opts: {
  stateRef: React.MutableRefObject<AppState>;
  setState: React.Dispatch<React.SetStateAction<AppState>>;
  setChapterPagingByBook: React.Dispatch<React.SetStateAction<Record<string, { afterIndex: number; hasMore: boolean; loading: boolean }>>>;
  loadMoreChapters: (bookId: string, reset?: boolean) => Promise<void>;
  isOnline: boolean;
  performFullDriveSyncRef: React.MutableRefObject<(manual?: boolean) => Promise<void>>;
  refreshJobs: () => Promise<void>;
  setJobs: (jobs: any[]) => void;
  pushNotice: (opts: { message: string; type?: 'info' | 'error' | 'success'; ms?: number }) => void;
  setIsDirty: (dirty: boolean) => void;
  navContextRef: React.MutableRefObject<RouteContext | null>;
}) {
  const {
    stateRef,
    setState,
    setChapterPagingByBook,
    loadMoreChapters,
    isOnline,
    performFullDriveSyncRef,
    refreshJobs,
    setJobs,
    pushNotice,
    setIsDirty,
    navContextRef,
  } = opts;

  const bootstrapPromiseRef = useRef<Promise<void> | null>(null);
  const bootstrapRunRef = useRef(0);
  const [bootstrapStatus, setBootstrapStatus] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [launchStage, setLaunchStage] = useState<'splash' | 'signin' | 'ready'>('splash');
  const [launchMessage, setLaunchMessage] = useState('Loading library...');
  const [signInError, setSignInError] = useState<string | null>(null);
  const startupRunRef = useRef(0);
  const navRestoreRef = useRef<RouteContext | null>(null);
  const navAppliedRef = useRef(false);
  const didRepairIndicesRef = useRef(false);

  const runBootstrap = useCallback(async () => {
    if (bootstrapPromiseRef.current) return bootstrapPromiseRef.current;
    const runId = ++bootstrapRunRef.current;
    setBootstrapStatus('running');
    setBootstrapError(null);
    bootstrapPromiseRef.current = (async () => {
      await bootstrapCore(stateRef.current.googleClientId);
      if (bootstrapRunRef.current !== runId) return;

      const loadedBooks = (await listBooks()).map((book: Book) => ({
        ...book,
        settings: normalizeBookSettings(book.settings),
      }));
      if (bootstrapRunRef.current !== runId) return;

      const preloadLimit = 200;
      const preloadResults = await Promise.all(
        loadedBooks.map(async (book: Book) => {
          try {
            const page = await listChaptersPage(book.id, -1, preloadLimit);
            return { bookId: book.id, page };
          } catch {
            return null;
          }
        })
      );
      if (bootstrapRunRef.current !== runId) return;

      const pagingSeed: Record<string, { afterIndex: number; hasMore: boolean; loading: boolean }> = {};
      const preloadMap = new Map<string, Awaited<ReturnType<typeof listChaptersPage>>>();
      for (const entry of preloadResults) {
        if (!entry) continue;
        preloadMap.set(entry.bookId, entry.page);
      }
      const books = loadedBooks.map((book: Book) => {
        const page = preloadMap.get(book.id);
        if (!page) {
          pagingSeed[book.id] = { afterIndex: -1, hasMore: true, loading: false };
          return normalizeBookChapters(book);
        }
        const ordered = orderChaptersForDisplay(page.chapters || []);
        pagingSeed[book.id] = {
          afterIndex: page.nextAfterIndex ?? -1,
          hasMore: page.nextAfterIndex != null,
          loading: false,
        };
        return normalizeBookChapters({
          ...book,
          chapters: ordered,
          chapterCount:
            page.totalCount ??
            (typeof book.chapterCount === 'number' ? Math.max(book.chapterCount, ordered.length) : ordered.length),
        });
      });
      setChapterPagingByBook((prev) => ({ ...prev, ...pagingSeed }));

      let nextActiveBookId: string | undefined;
      setState((p) => {
        const desired = p.activeBookId;
        const valid = desired && books.some((b: Book) => b.id === desired);
        nextActiveBookId = valid ? desired : (books[0]?.id ?? undefined);
        return { ...p, books, activeBookId: nextActiveBookId };
      });

      console.log('[TaleVox][Library] Loaded books:', books.length);
      if (bootstrapRunRef.current !== runId) return;
      await refreshJobs();
      setBootstrapStatus('done');
    })().catch((e: any) => {
      console.error('App bootstrap failed', e);
      setBootstrapStatus('error');
      setBootstrapError(String(e?.message ?? e));
      bootstrapPromiseRef.current = null;
    });
    return bootstrapPromiseRef.current;
  }, [refreshJobs, setChapterPagingByBook, setState, stateRef]);

  const restoreNavContext = useCallback(async () => {
    if (navAppliedRef.current) return;
    const ctx = navContextRef.current;
    if (!ctx) return;
    navAppliedRef.current = true;
    navRestoreRef.current = ctx;

    if (ctx.bookId) {
      setState((p) => ({ ...p, activeBookId: ctx.bookId }));
    }

    if ((ctx.lastViewType === 'collection' || ctx.lastViewType === 'reader') && ctx.bookId) {
      await loadMoreChapters(ctx.bookId, true);
    }
  }, [loadMoreChapters, navContextRef, setState]);

  const runStartup = useCallback(async () => {
    const runId = ++startupRunRef.current;
    setLaunchStage('splash');
    setLaunchMessage('Loading library...');
    setSignInError(null);

    try {
      await runBootstrap();
      if (startupRunRef.current !== runId) return;

      setLaunchMessage('Checking session...');
      let authOk = false;
      try {
        await ensureValidToken(false);
        authOk = true;
      } catch {
        authOk = false;
      }

      if (startupRunRef.current !== runId) return;

      if (authOk && stateRef.current.driveRootFolderId && isOnline) {
        try {
          const restoreResult = await restoreFromDriveIfAvailable({
            rootFolderId: stateRef.current.driveRootFolderId,
            lastSnapshotCreatedAt: readLocalSnapshotMeta().lastSnapshotCreatedAt,
          });
          if (restoreResult.restored) {
            const currentState = stateRef.current;
            const attachmentLists = await Promise.all(
              currentState.books.map((book: Book) => listBookAttachments(book.id).catch(() => []))
            );
            const merged = applyFullSnapshot({
              snapshot: restoreResult.snapshot,
              currentState,
              currentAttachments: attachmentLists.flat(),
              currentJobs: [],
            });
            try {
              if (restoreResult.snapshot.readerProgress) {
                safeSetLocalStorage(
                  'talevox_reader_progress',
                  JSON.stringify(restoreResult.snapshot.readerProgress)
                );
              }
              if (restoreResult.snapshot.legacyProgressStore) {
                safeSetLocalStorage(
                  PROGRESS_STORE_KEY,
                  JSON.stringify(restoreResult.snapshot.legacyProgressStore)
                );
              }
            } catch {}
            for (const restoredBook of merged.state.books) {
              await upsertBook({ ...restoredBook, chapters: [], directoryHandle: undefined });
              if (restoredBook.chapters.length > 0) {
                await bulkUpsertChapters(
                  restoredBook.id,
                  restoredBook.chapters.map((chapter) => ({
                    chapter: { ...chapter, content: undefined },
                    content: typeof chapter.content === 'string' ? chapter.content : null,
                  }))
                );
              }
            }
            if (merged.attachments.length) {
              const attachmentsByBook = new Map<string, BookAttachment[]>();
              for (const attachment of merged.attachments) {
                const list = attachmentsByBook.get(attachment.bookId) || [];
                list.push(attachment);
                attachmentsByBook.set(attachment.bookId, list);
              }
              for (const [bookId, items] of attachmentsByBook.entries()) {
                await bulkUpsertBookAttachments(bookId, items);
              }
            }
            setState(merged.state);
            setJobs(merged.jobs);
            setIsDirty(false);
            pushNotice({ message: 'Restored from Drive', type: 'success' });
          }
        } catch (e) {
          console.warn('[Startup] restoreFromDriveIfAvailable failed', e);
        }
      }

      if (authOk && stateRef.current.driveRootFolderId && isOnline) {
        const lastSync = Number(localStorage.getItem(LAUNCH_SYNC_KEY) || 0);
        const now = Date.now();
        if (now - lastSync > LAUNCH_SYNC_MIN_MS) {
          setLaunchMessage('Checking library...');
          localStorage.setItem(LAUNCH_SYNC_KEY, String(now));
          try {
            await performFullDriveSyncRef.current(false);
          } catch (e) {
            console.warn('[Startup] launch sync failed', e);
          }
        }
      }

      await restoreNavContext();

      if (startupRunRef.current !== runId) return;

      if (authOk) {
        setLaunchStage('ready');
      } else {
        setLaunchStage('signin');
      }
    } catch (e: any) {
      console.error('Startup failed', e);
      setSignInError(String(e?.message ?? e));
      setLaunchStage('signin');
    }
  }, [isOnline, performFullDriveSyncRef, restoreNavContext, runBootstrap, setIsDirty, setJobs, setState, stateRef, pushNotice]);

  useEffect(() => {
    void runStartup();
  }, [runStartup]);

  return {
    launchStage,
    launchMessage,
    signInError,
    setLaunchStage,
    setLaunchMessage,
    setSignInError,
    bootstrapStatus,
    bootstrapError,
    runBootstrap,
    restoreNavContext,
    runStartup,
    navRestoreRef,
    didRepairIndicesRef,
  };
}
