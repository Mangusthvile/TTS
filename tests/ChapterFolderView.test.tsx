import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import ChapterFolderView from "../components/ChapterFolderView";
import { AudioStatus, HighlightMode, StorageBackend, Theme, type Book, type Chapter } from "../types";

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
}) => {
  const book = opts?.book ?? makeBook();
  const rendered = render(
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
    />
  );
  await act(async () => {
    await Promise.resolve();
  });
  return rendered;
};

const openBookSettings = () => {
  fireEvent.click(screen.getByTitle("More"));
  fireEvent.click(screen.getByText("Book Settings"));
};

const triggerLongPress = async (target: Element, options?: { pointerId?: number; startX?: number; startY?: number; moveX?: number; moveY?: number; holdMs?: number }) => {
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

      const gridCard = screen.getByText("Volume Chapter").closest("[data-chapter-id='c-1']") as HTMLElement;
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

      const gridCard = screen.getByText("Volume Chapter").closest("[data-chapter-id='c-1']") as HTMLElement;
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
      const first = screen.getByText("Volume Chapter").closest("[data-chapter-id='c-1']") as HTMLElement;

      await triggerLongPress(first, { pointerId: 21 });
      await act(async () => {
        await Promise.resolve();
      });
      const second = screen.getByText("Ungrouped Chapter").closest("[data-chapter-id='c-2']") as HTMLElement;
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

      const source = screen.getByText("Volume Chapter").closest("[data-chapter-id='c-1']") as HTMLElement;
      await triggerLongPress(source, { pointerId: 31, holdMs: 320 });

      const target = screen.getByText("Ungrouped Chapter").closest("[data-chapter-id='c-2']") as HTMLElement;
      fireEvent.click(target);
      await act(async () => {
        await Promise.resolve();
      });

      expect(onUpdateChapter).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows only Edit Title in chapter overflow menu", async () => {
    await renderView();

    fireEvent.click(screen.getAllByTitle("Chapter menu")[0]);

    expect(screen.getByText("Edit Title")).toBeInTheDocument();
    expect(screen.queryByText("Move To Volume")).not.toBeInTheDocument();
  });

  it("renders a scrollable book settings modal with a visible close button", async () => {
    await renderView();

    openBookSettings();

    expect(screen.getByTestId("book-settings-modal")).toBeInTheDocument();
    expect(screen.getByTestId("book-settings-scroll")).toBeInTheDocument();
    expect(screen.getByTitle("Close Book Settings")).toBeInTheDocument();
  });

  it("registers a back handler that closes settings first, then selection mode", async () => {
    const registerBackHandler = vi.fn();
    await renderView({ onRegisterBackHandler: registerBackHandler });

    const getLatestHandler = () =>
      [...registerBackHandler.mock.calls]
        .reverse()
        .map((call) => call[0])
        .find((value) => typeof value === "function") as (() => boolean);

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
});
