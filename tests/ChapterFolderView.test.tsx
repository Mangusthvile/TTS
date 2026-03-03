import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import ChapterFolderView from "../components/ChapterFolderView";
import {
  AudioStatus,
  HighlightMode,
  StorageBackend,
  Theme,
  type Book,
  type Chapter,
} from "../types";

const generateAndPersistChapterAudioMock = vi.fn(async (args: any) => {
  const text = await args?.loadChapterText?.();
  if (!text) throw new Error("No chapter text found.");
  return {};
});

vi.mock("../services/chapterAudioService", () => ({
  generateAndPersistChapterAudio: (args: any) => generateAndPersistChapterAudioMock(args),
}));

const makeChapter = (overrides: Partial<Chapter>): Chapter => ({
  id: `ch-${Math.random().toString(36).slice(2)}`,
  index: 1,
  title: "Chapter",
  filename: "chapter.txt",
  wordCount: 100,
  progress: 0,
  progressChars: 0,
  audioStatus: AudioStatus.PENDING,
  ...overrides,
});

const makeBook = (): Book => ({
  id: "book-1",
  title: "Path of Dragons",
  backend: StorageBackend.DRIVE,
  chapters: [
    makeChapter({ id: "c-1", index: 1, title: "Volume Chapter", volumeName: "Volume 1" }),
    makeChapter({ id: "c-2", index: 2, title: "Ungrouped Chapter" }),
  ],
  rules: [],
  settings: {
    useBookSettings: false,
    highlightMode: HighlightMode.SENTENCE,
    chapterLayout: "sections",
    enableSelectionMode: true,
    enableOrganizeMode: true,
    allowDragReorderChapters: true,
    allowDragMoveToVolume: true,
    allowDragReorderVolumes: true,
    volumeOrder: ["Volume 1"],
    collapsedVolumes: {},
    autoGenerateAudioOnAdd: true,
    autoUploadOnAdd: false,
    confirmBulkDelete: true,
  },
});

const renderView = async (opts?: {
  isDirty?: boolean;
  book?: Book;
  onRegisterBackHandler?: (handler: (() => boolean) | null) => void;
  onUpdateChapter?: (chapter: Chapter) => void;
  restoreScrollTop?: number | null;
  onResolveChapterText?: (bookId: string, chapterId: string) => Promise<string | null>;
}) => {
  const defaultBook = opts?.book ?? makeBook();
  const renderNode = (book: Book, restoreScrollTop: number | null | undefined) => (
    <ChapterFolderView
      book={book}
      theme={Theme.DARK}
      globalRules={[]}
      reflowLineBreaksEnabled={false}
      uiMode="mobile"
      jobs={[]}
      onCancelJob={vi.fn()}
      onRetryJob={vi.fn()}
      onRefreshJobs={vi.fn()}
      onUpdateBook={vi.fn()}
      onDeleteBook={vi.fn()}
      onAddChapter={vi.fn()}
      onOpenChapter={vi.fn()}
      onToggleFavorite={vi.fn()}
      uploadQueueCount={0}
      onToggleUploadQueue={vi.fn()}
      onUploadAllChapters={vi.fn()}
      onQueueChapterUpload={vi.fn()}
      uploadedChapterCount={0}
      isUploadingAll={false}
      onUpdateChapterTitle={vi.fn()}
      onDeleteChapter={vi.fn()}
      onUpdateChapter={opts?.onUpdateChapter ?? vi.fn()}
      onUpdateBookSettings={vi.fn()}
      onBackToLibrary={vi.fn()}
      onResetChapterProgress={vi.fn()}
      isDirty={opts?.isDirty}
      isSyncing={false}
      onRegisterBackHandler={opts?.onRegisterBackHandler}
      restoreScrollTop={restoreScrollTop}
      onResolveChapterText={opts?.onResolveChapterText}
    />
  );
  const rendered = render(renderNode(defaultBook, opts?.restoreScrollTop));
  await act(async () => {
    await Promise.resolve();
  });
  return {
    ...rendered,
    rerenderView: (book: Book, restoreScrollTop: number | null | undefined) =>
      rendered.rerender(renderNode(book, restoreScrollTop)),
  };
};

const openBookSettings = () => {
  fireEvent.click(screen.getByTitle("More"));
  fireEvent.click(screen.getByText(/Book (Options|Settings)/i));
};

const triggerLongPress = async (
  target: Element,
  options?: {
    pointerId?: number;
    startX?: number;
    startY?: number;
    moveX?: number;
    moveY?: number;
    holdMs?: number;
  }
) => {
  const pointerId = options?.pointerId ?? 1;
  const startX = options?.startX ?? 50;
  const startY = options?.startY ?? 50;
  fireEvent.pointerDown(target, {
    pointerId,
    pointerType: "touch",
    isPrimary: true,
    clientX: startX,
    clientY: startY,
  });
  if (typeof options?.moveX === "number" && typeof options?.moveY === "number") {
    fireEvent.pointerMove(target, {
      pointerId,
      pointerType: "touch",
      isPrimary: true,
      clientX: options.moveX,
      clientY: options.moveY,
    });
  }
  await act(async () => {
    vi.advanceTimersByTime(options?.holdMs ?? 460);
  });
  fireEvent.pointerUp(target, {
    pointerId,
    pointerType: "touch",
    isPrimary: true,
    clientX: typeof options?.moveX === "number" ? options.moveX : startX,
    clientY: typeof options?.moveY === "number" ? options.moveY : startY,
  });
  await act(async () => {
    await Promise.resolve();
  });
};

describe("ChapterFolderView chapter UX", () => {
  const confirmMock = vi.fn(() => true);

  beforeEach(() => {
    vi.stubGlobal("confirm", confirmMock);
    generateAndPersistChapterAudioMock.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    confirmMock.mockReset();
  });

  it("shows only Sections/Grid toggles and does not render an Ungrouped folder label", async () => {
    await renderView();

    expect(screen.getByTitle("Sections")).toBeInTheDocument();
    expect(screen.getByTitle("Grid")).toBeInTheDocument();
    expect(screen.queryByText(/^Ungrouped$/i)).not.toBeInTheDocument();
  });

  it("renders chapter progress bar from chapter.progress (stored progress)", async () => {
    const bookWithProgress = makeBook();
    const chapters = [...(bookWithProgress.chapters || [])];
    chapters[0] = makeChapter({
      id: "c-1",
      index: 1,
      title: "Volume Chapter",
      volumeName: "Volume 1",
      progress: 0.65,
      progressSec: 65,
      durationSec: 100,
      isCompleted: false,
    });
    bookWithProgress.chapters = chapters;
    await renderView({ book: bookWithProgress });

    expect(screen.getByText("65%")).toBeInTheDocument();
  });

  it("shows hero title once and a single subtle Not synced label", async () => {
    await renderView({ isDirty: true });

    expect(screen.getAllByText("Path of Dragons")).toHaveLength(1);
    expect(screen.getAllByText(/Not synced/i)).toHaveLength(1);
  });

  it("does not render the table header labels on mobile", async () => {
    await renderView();

    expect(screen.queryByText(/^Idx$/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Title$/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Progress$/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Actions$/i)).not.toBeInTheDocument();
  });

  it("enters selection mode and shows top bar + bottom bulk dock", async () => {
    await renderView();

    fireEvent.contextMenu(screen.getByText("Volume Chapter"), { button: 2 });

    expect(screen.getByText("1 selected")).toBeInTheDocument();
    expect(screen.getByText("Upload")).toBeInTheDocument();
    expect(screen.getByText("Regen Audio")).toBeInTheDocument();
    expect(screen.getByText("Done")).toBeInTheDocument();
    expect(screen.getByText("Reset")).toBeInTheDocument();
    expect(screen.getByText("Delete")).toBeInTheDocument();
  });

  it("confirms before resetting selected chapter progress", async () => {
    await renderView();

    fireEvent.contextMenu(screen.getByText("Volume Chapter"), { button: 2 });
    fireEvent.click(screen.getByText("Reset"));

    expect(confirmMock).toHaveBeenCalled();
    expect(confirmMock).toHaveBeenCalledWith(expect.stringContaining("Reset progress"));
  });

  it("supports shift range selection using visible chapter order", async () => {
    await renderView();

    fireEvent.contextMenu(screen.getByText("Volume Chapter"), { button: 2 });
    fireEvent.click(screen.getByText("Ungrouped Chapter"), { shiftKey: true });

    expect(screen.getByText("2 selected")).toBeInTheDocument();
  });

  it("starts selection on first long-press in grid view", async () => {
    vi.useFakeTimers();
    try {
      await renderView();
      fireEvent.click(screen.getByTitle("Grid"));

      const gridCard = screen
        .getByText("Volume Chapter")
        .closest("[data-chapter-id='c-1']") as HTMLElement;
      await triggerLongPress(gridCard, { pointerId: 11 });

      expect(screen.getByText("1 selected")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels long-press selection on pointer cancel", async () => {
    vi.useFakeTimers();
    try {
      await renderView();
      fireEvent.click(screen.getByTitle("Grid"));

      const gridCard = screen
        .getByText("Volume Chapter")
        .closest("[data-chapter-id='c-1']") as HTMLElement;
      fireEvent.pointerDown(gridCard, {
        pointerId: 13,
        pointerType: "touch",
        isPrimary: true,
        clientX: 20,
        clientY: 20,
      });
      fireEvent.pointerCancel(gridCard, {
        pointerId: 13,
        pointerType: "touch",
        isPrimary: true,
      });
      await act(async () => {
        vi.advanceTimersByTime(500);
      });

      expect(screen.queryByText(/selected$/i)).not.toBeInTheDocument();
      expect(screen.queryByText("Upload")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("selects an inclusive range on long-press when already in selection mode", async () => {
    vi.useFakeTimers();
    try {
      await renderView();
      const first = screen
        .getByText("Volume Chapter")
        .closest("[data-chapter-id='c-1']") as HTMLElement;

      await triggerLongPress(first, { pointerId: 21 });
      await act(async () => {
        await Promise.resolve();
      });
      const second = screen
        .getByText("Ungrouped Chapter")
        .closest("[data-chapter-id='c-2']") as HTMLElement;
      await triggerLongPress(second, { pointerId: 22 });

      expect(screen.getByText("2 selected")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps picked chapter active after organize hold and allows destination tap reorder", async () => {
    vi.useFakeTimers();
    const onUpdateChapter = vi.fn();
    try {
      await renderView({ onUpdateChapter });
      fireEvent.click(screen.getByTitle("Organize"));

      const source = screen
        .getByText("Volume Chapter")
        .closest("[data-chapter-id='c-1']") as HTMLElement;
      await triggerLongPress(source, { pointerId: 31, holdMs: 320 });

      const target = screen
        .getByText("Ungrouped Chapter")
        .closest("[data-chapter-id='c-2']") as HTMLElement;
      fireEvent.click(target);
      await act(async () => {
        await Promise.resolve();
      });

      expect(onUpdateChapter).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows Edit Chapter in chapter overflow menu", async () => {
    await renderView();

    fireEvent.click(screen.getAllByTitle("Chapter menu")[0]);

    expect(screen.getByText("Edit Chapter")).toBeInTheDocument();
    expect(screen.queryByText("Move To Volume")).not.toBeInTheDocument();
  });

  it("renders a scrollable book settings modal with a visible close button", async () => {
    await renderView();

    openBookSettings();

    expect(screen.getByTestId("book-settings-modal")).toBeInTheDocument();
    expect(screen.getByTestId("book-settings-scroll")).toBeInTheDocument();
    expect(screen.getByTitle(/Close Book (Options|Settings)/i)).toBeInTheDocument();
  });

  it("registers a back handler that closes settings first, then selection mode", async () => {
    const registerBackHandler = vi.fn();
    await renderView({ onRegisterBackHandler: registerBackHandler });

    const getLatestHandler = () =>
      [...registerBackHandler.mock.calls]
        .reverse()
        .map((call) => call[0])
        .find((value) => typeof value === "function") as () => boolean;

    const handler = getLatestHandler();

    expect(typeof handler).toBe("function");
    expect(handler()).toBe(false);

    fireEvent.contextMenu(screen.getByText("Volume Chapter"), { button: 2 });
    expect(screen.getByText("1 selected")).toBeInTheDocument();
    await act(async () => {
      expect(getLatestHandler()()).toBe(true);
    });
    expect(screen.queryByText(/selected$/i)).not.toBeInTheDocument();

    openBookSettings();
    expect(screen.getByTestId("book-settings-modal")).toBeInTheDocument();
    await act(async () => {
      expect(getLatestHandler()()).toBe(true);
    });
    expect(screen.queryByTestId("book-settings-modal")).not.toBeInTheDocument();
  });

  // Skipped: scroll restore timing/container differs under Vitest 3; TODO re-enable when test env is stable
  it.skip("restores scroll once for explicit restore and does not reapply on chapter list growth", async () => {
    const initialBook = makeBook();
    const { rerenderView, container } = await renderView({
      book: initialBook,
      restoreScrollTop: 120,
    });

    const scrollContainer = container.querySelector(".overflow-y-auto") as HTMLDivElement | null;
    expect(scrollContainer).toBeTruthy();
    await waitFor(() => {
      expect(scrollContainer!.scrollTop).toBe(120);
    });

    scrollContainer!.scrollTop = 33;

    const expandedBook: Book = {
      ...initialBook,
      chapters: [
        ...initialBook.chapters,
        makeChapter({ id: "c-3", index: 3, title: "Later chapter" }),
      ],
    };
    rerenderView(expandedBook, 120);

    await act(async () => {
      await Promise.resolve();
    });

    const scrollContainerAfter = container.querySelector(
      ".overflow-y-auto"
    ) as HTMLDivElement | null;
    expect(scrollContainerAfter!.scrollTop).toBe(33);
  });

  it("uses resolver during generation and does not show blocking alert on missing text", async () => {
    const alertMock = vi.fn();
    vi.stubGlobal("alert", alertMock);

    const resolver = vi.fn(async () => null);
    const book: Book = {
      ...makeBook(),
      chapters: [makeChapter({ id: "c-1", index: 1, title: "Only chapter", content: undefined })],
    };

    await renderView({
      book,
      onResolveChapterText: resolver,
    });

    openBookSettings();
    fireEvent.click(screen.getByTitle("Show more actions"));
    fireEvent.click(screen.getByTitle("Regenerate audio for this book"));

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(resolver).toHaveBeenCalledWith("book-1", "c-1");
    expect(alertMock).not.toHaveBeenCalled();
  });
});
