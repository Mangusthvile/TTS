import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Book, BookAttachment } from "../../../types";
import { RouteContext } from "../types";
import { bootstrapCore } from "../bootstrap";
import { ensureValidToken } from "../../../services/driveAuth";
import {
  applyFullSnapshot,
  readLocalSnapshotMeta,
  restoreFromDriveIfAvailable,
} from "../../../services/saveRestoreService";
import {
  listBooks,
  listChaptersPage,
  listBookAttachments,
  upsertBook,
  bulkUpsertChapters,
  bulkUpsertBookAttachments,
  upsertChapterTombstone,
} from "../../../services/libraryStore";
import { orderChaptersForDisplay, normalizeBookChapters } from "../../../utils/chapterBookUtils";
import { normalizeBookSettings } from "../../features/library/bookSettings";
import { safeSetLocalStorage } from "../../../utils/safeStorage";
import {
  getPendingStartupProgressConflict,
  hydrateProgressFromDurable,
  hydrateProgressFromIndexedDB,
  readProgressStore,
  setProgressStoreHydrated,
  type StartupProgressConflict,
} from "../../../services/progressStore";
import { ensureAppDatabaseOpen, registerSchemaRunner } from "../../../services/sqliteConnectionManager";
import { runAppMigrationsOnce, runSchemaOnConnection } from "../../../services/sqliteStorageDriver";
import { appConfig } from "../../config/appConfig";
import { Capacitor } from "@capacitor/core";
import { Preferences } from "@capacitor/preferences";
import { LAUNCH_SYNC_KEY, LAUNCH_SYNC_MIN_MS, LAST_ACTIVE_BOOK_ID_KEY } from "../constants";

/** Max concurrent listChaptersPage calls during bootstrap to reduce cold-start I/O spike. */
const PRELOAD_BATCH_SIZE = 4;
/** Optionally preload only the first N books; rest load on demand via loadMoreChapters. */
const PRELOAD_BOOKS_MAX = 10;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

export function useAppBootstrap(opts: {
  stateRef: React.MutableRefObject<AppState>;
  setState: React.Dispatch<React.SetStateAction<AppState>>;
  setChapterPagingByBook: React.Dispatch<
    React.SetStateAction<Record<string, { afterIndex: number; hasMore: boolean; loading: boolean }>>
  >;
  loadMoreChapters: (bookId: string, reset?: boolean) => Promise<void>;
  isOnline: boolean;
  performFullDriveSyncRef: React.MutableRefObject<(manual?: boolean) => Promise<void>>;
  refreshJobs: () => Promise<void>;
  setJobs: (jobs: any[]) => void;
  pushNotice: (opts: { message: string; type?: "info" | "error" | "success"; ms?: number }) => void;
  setIsDirty: (dirty: boolean) => void;
  navContextRef: React.MutableRefObject<RouteContext | null>;
  onStartupProgressConflict?: (conflict: StartupProgressConflict | null) => void;
  /** When startup throws, return "ready" to still enter the app (e.g. user is signed in but restore failed). */
  onStartupError?: (error: Error) => "signin" | "ready";
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
    onStartupProgressConflict,
    onStartupError,
  } = opts;

  const bootstrapPromiseRef = useRef<Promise<void> | null>(null);
  const bootstrapRunRef = useRef(0);
  const [bootstrapStatus, setBootstrapStatus] = useState<"idle" | "running" | "done" | "error">(
    "idle"
  );
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [launchStage, setLaunchStage] = useState<"splash" | "signin" | "ready">("splash");
  const [launchMessage, setLaunchMessage] = useState("Loading library...");
  const [signInError, setSignInError] = useState<string | null>(null);
  const startupRunRef = useRef(0);
  const startupStartedRef = useRef(false);
  const navRestoreRef = useRef<RouteContext | null>(null);
  const navAppliedRef = useRef(false);
  const didRepairIndicesRef = useRef(false);

  const runBootstrap = useCallback(async () => {
    if (bootstrapPromiseRef.current) return bootstrapPromiseRef.current;
    const runId = ++bootstrapRunRef.current;
    setBootstrapStatus("running");
    setBootstrapError(null);
    bootstrapPromiseRef.current = (async () => {
      await bootstrapCore(stateRef.current.googleClientId);
      if (bootstrapRunRef.current !== runId) return;
      if (typeof Capacitor !== "undefined" && Capacitor.isNativePlatform?.()) {
        try {
          registerSchemaRunner(appConfig.db.name, runSchemaOnConnection);
          await ensureAppDatabaseOpen(appConfig.db.name, appConfig.db.version);
          // Run full schema (chapter_progress, drive_upload_queue, etc.) before any progress/library query.
          await runAppMigrationsOnce();
        } catch (e) {
          console.warn("[Bootstrap] SQLite early init failed", e);
        }
      }
      if (bootstrapRunRef.current !== runId) return;
      let durableOk = await hydrateProgressFromDurable();
      if (!durableOk && typeof Capacitor !== "undefined" && Capacitor.isNativePlatform?.()) {
        await new Promise((r) => setTimeout(r, 250));
        durableOk = await hydrateProgressFromDurable();
      }
      await hydrateProgressFromIndexedDB();
      onStartupProgressConflict?.(getPendingStartupProgressConflict());
      if (bootstrapRunRef.current !== runId) return;
      if (durableOk) {
        setProgressStoreHydrated();
      }

      const loadedBooks = (await listBooks()).map((book: Book) => ({
        ...book,
        settings: normalizeBookSettings(book.settings),
      }));
      if (bootstrapRunRef.current !== runId) return;

      const preloadLimit = 60;
      const booksToPreload = loadedBooks.slice(0, PRELOAD_BOOKS_MAX);
      const preloadResults: Array<{ bookId: string; page: Awaited<ReturnType<typeof listChaptersPage>> } | null> = [];
      for (const batch of chunk(booksToPreload, PRELOAD_BATCH_SIZE)) {
        if (bootstrapRunRef.current !== runId) break;
        const batchResults = await Promise.all(
          batch.map(async (book: Book) => {
            try {
              const page = await listChaptersPage(book.id, -1, preloadLimit);
              return { bookId: book.id, page };
            } catch {
              return null;
            }
          })
        );
        preloadResults.push(...batchResults);
      }
      if (bootstrapRunRef.current !== runId) return;

      const pagingSeed: Record<string, { afterIndex: number; hasMore: boolean; loading: boolean }> =
        {};
      const preloadMap = new Map<string, Awaited<ReturnType<typeof listChaptersPage>>>();
      for (const entry of preloadResults) {
        if (!entry) continue;
        preloadMap.set(entry.bookId, entry.page);
      }
      const progressStore = readProgressStore();
      const books = loadedBooks.map((book: Book) => {
        const page = preloadMap.get(book.id);
        if (!page) {
          pagingSeed[book.id] = { afterIndex: -1, hasMore: true, loading: false };
          return normalizeBookChapters(book);
        }
        const ordered = orderChaptersForDisplay(page.chapters || []);
        const progressMap = progressStore.books?.[book.id] || {};
        const chaptersWithProgress = ordered.map((c) => {
          const p = progressMap[c.id];
          if (!p) return c;
          const progressChars =
            p.percent != null && c.textLength
              ? Math.round(p.percent * c.textLength)
              : c.progressChars;
          return {
            ...c,
            progress: p.percent ?? c.progress,
            progressChars,
            progressSec: typeof p.timeSec === "number" ? p.timeSec : c.progressSec,
            durationSec: typeof p.durationSec === "number" ? p.durationSec : c.durationSec,
            isCompleted: p.completed ?? c.isCompleted,
            updatedAt: Math.max(c.updatedAt || 0, p.updatedAt || 0),
          };
        });
        pagingSeed[book.id] = {
          afterIndex: page.nextAfterIndex ?? -1,
          hasMore: page.nextAfterIndex != null,
          loading: false,
        };
        return normalizeBookChapters({
          ...book,
          chapters: chaptersWithProgress,
          chapterCount:
            page.totalCount ??
            (typeof book.chapterCount === "number"
              ? Math.max(book.chapterCount, ordered.length)
              : ordered.length),
        });
      });
      setChapterPagingByBook((prev) => ({ ...prev, ...pagingSeed }));

      // Phase 4.2: On native, restore last active book from Preferences for cold-start.
      let preferredActiveBookId: string | undefined;
      if (typeof Capacitor !== "undefined" && Capacitor.isNativePlatform?.()) {
        try {
          const { value } = await Preferences.get({ key: LAST_ACTIVE_BOOK_ID_KEY });
          if (value && typeof value === "string" && value.length > 0) preferredActiveBookId = value;
          else preferredActiveBookId = undefined;
        } catch {
          preferredActiveBookId = undefined;
        }
      } else {
        preferredActiveBookId = undefined;
      }

      let nextActiveBookId: string | undefined;
      setState((p) => {
        const desired =
          preferredActiveBookId && books.some((b: Book) => b.id === preferredActiveBookId)
            ? preferredActiveBookId
            : p.activeBookId;
        const valid = desired && books.some((b: Book) => b.id === desired);
        nextActiveBookId = valid ? desired : (books[0]?.id ?? undefined);
        return { ...p, books, activeBookId: nextActiveBookId };
      });

      console.log("[TaleVox][Library] Loaded books:", books.length);
      if (bootstrapRunRef.current !== runId) return;
      setBootstrapStatus("done");
      void refreshJobs();
    })().catch((e: any) => {
      console.error("App bootstrap failed", e);
      setBootstrapStatus("error");
      setBootstrapError(String(e?.message ?? e));
      bootstrapPromiseRef.current = null;
    });
    return bootstrapPromiseRef.current;
  }, [onStartupProgressConflict, refreshJobs, setChapterPagingByBook, setState, stateRef]);

  const restoreNavContext = useCallback(async () => {
    if (navAppliedRef.current) return;
    const ctx = navContextRef.current;
    if (!ctx) return;
    navAppliedRef.current = true;
    navRestoreRef.current = ctx;

    if (ctx.bookId) {
      setState((p) => ({ ...p, activeBookId: ctx.bookId }));
    }

    if ((ctx.lastViewType === "collection" || ctx.lastViewType === "reader") && ctx.bookId) {
      await loadMoreChapters(ctx.bookId, true);
    }
  }, [loadMoreChapters, navContextRef, setState]);

  const runStartup = useCallback(async () => {
    const runId = ++startupRunRef.current;
    setLaunchStage("splash");
    setLaunchMessage("Loading library...");
    setSignInError(null);

    try {
      await runBootstrap();
      if (startupRunRef.current !== runId) return;

      setLaunchMessage("Checking session...");
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
                  "talevox_reader_progress",
                  JSON.stringify(restoreResult.snapshot.readerProgress)
                );
              }
              // Progress store is written by applyFullSnapshot via applyExternalProgress
            } catch {}
            for (const restoredBook of merged.state.books) {
              await upsertBook({ ...restoredBook, chapters: [], directoryHandle: undefined });
              if (restoredBook.chapters.length > 0) {
                await bulkUpsertChapters(
                  restoredBook.id,
                  restoredBook.chapters.map((chapter) => ({
                    chapter: { ...chapter, content: undefined },
                    content: typeof chapter.content === "string" ? chapter.content : null,
                  }))
                );
              }
            }
            if (restoreResult.snapshot.chapterTombstones?.length) {
              for (const t of restoreResult.snapshot.chapterTombstones) {
                try {
                  await upsertChapterTombstone(t.bookId, t.chapterId, t.deletedAt);
                } catch (e) {
                  console.warn("[Startup] tombstone restore failed", t.chapterId, e);
                }
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
            pushNotice({ message: "Restored from Drive", type: "success" });
          }
        } catch (e) {
          console.warn("[Startup] restoreFromDriveIfAvailable failed", e);
        }
      }

      await restoreNavContext();

      if (startupRunRef.current !== runId) return;

      // Run initial sync on the loading/sign-in screen so the library loads already synced.
      if (authOk && stateRef.current.driveRootFolderId && isOnline) {
        const lastSync = Number(localStorage.getItem(LAUNCH_SYNC_KEY) || 0);
        const now = Date.now();
        if (now - lastSync > LAUNCH_SYNC_MIN_MS) {
          setLaunchMessage("Syncing...");
          localStorage.setItem(LAUNCH_SYNC_KEY, String(now));
          try {
            await performFullDriveSyncRef.current(false);
          } catch (e) {
            console.warn("[Startup] initial sync failed", e);
          }
        }
      }

      if (authOk) {
        setLaunchStage("ready");
      } else {
        setLaunchStage("signin");
      }
    } catch (e: any) {
      console.error("Startup failed", e);
      setSignInError(String(e?.message ?? e));
      const nextStage = onStartupError?.(e) ?? "signin";
      setLaunchStage(nextStage);
    }
  }, [
    isOnline,
    performFullDriveSyncRef,
    restoreNavContext,
    runBootstrap,
    setIsDirty,
    setJobs,
    setState,
    stateRef,
    pushNotice,
    onStartupError,
  ]);

  // Run startup once on mount. runStartup is not in deps so that changing
  // callbacks (refreshJobs, isOnline, etc.) does not re-trigger startup and
  // cause the sign-in screen to appear multiple times.
  useEffect(() => {
    if (startupStartedRef.current) return;
    startupStartedRef.current = true;
    void runStartup();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: run once on mount only
  }, []);

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
