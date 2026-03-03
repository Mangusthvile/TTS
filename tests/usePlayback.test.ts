import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { usePlayback } from "../src/app/state/usePlayback";
import { AudioStatus } from "../types";

vi.mock("../services/speechService", () => ({
  speechController: {
    setSyncCallback: vi.fn(),
    emitSyncTick: vi.fn(),
    setItemChangedCallback: vi.fn(),
    setPlaybackRate: vi.fn(),
    setContext: vi.fn(),
    updateMetadata: vi.fn(),
    safeStop: vi.fn(),
    safePlay: vi.fn(async () => ({ ok: false })),
    pause: vi.fn(),
    stop: vi.fn(),
    seekTo: vi.fn(async () => true),
    getCurrentTime: vi.fn(() => 0),
    getTimeForOffset: vi.fn(() => 0),
    loadAndPlayDriveFile: vi.fn(async () => true),
    hasAudioSource: false,
    getMetadata: vi.fn(() => ({})),
    getPlaybackAdapter: vi.fn(() => null),
  },
}));

describe("usePlayback autoplay missing text", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("stops autoplay with explicit error and does not advance chapter when text is missing", async () => {
    const pushNotice = vi.fn();
    const setState = vi.fn();

    const stateRef = {
      current: {
        activeBookId: "book-1",
        globalRules: [],
        readerSettings: {
          uiMode: "mobile",
          reflowLineBreaks: false,
          speakChapterIntro: true,
        },
        books: [
          {
            id: "book-1",
            rules: [],
            currentChapterId: "c-1",
            settings: { defaultVoiceId: "en-US-Standard-C" },
            chapters: [
              {
                id: "c-1",
                index: 1,
                title: "Current chapter",
                filename: "c1.txt",
                progress: 0,
                audioStatus: AudioStatus.PENDING,
                content: "has text",
              },
              {
                id: "c-2",
                index: 2,
                title: "Missing text chapter",
                filename: "c2.txt",
                progress: 0,
                audioStatus: AudioStatus.PENDING,
              },
            ],
          },
        ],
      } as any,
    };

    const chapterSessionRef = { current: 0 };
    const chapterTextCacheRef = { current: new Map<string, string>() };
    const pendingCueFallbackRef = { current: null as any };
    const activeSpeakTextRef = { current: null as any };
    const cueIntegrityRef = {
      current: { chapterId: "", driftCount: 0, lastRebuildAt: 0, lastNoticeAt: 0 },
    };
    const cueDurationRef = {
      current: { chapterId: "", lastDurationMs: 0, lastRebuildAt: 0 },
    };
    const isInIntroRef = { current: false };

    const { result } = renderHook(() =>
      usePlayback({
        stateRef,
        setState,
        pushNotice,
        effectiveMobileMode: true,
        isAuthorized: false,
        playbackAdapter: null,
        markDirty: vi.fn(),
        handleManualScrub: vi.fn(),
        handleChapterEnd: vi.fn(),
        handleSkip: vi.fn(),
        chapterSessionRef,
        chapterTextCacheRef,
        ensureChapterContentLoaded: vi.fn(async () => null),
        getEffectivePlaybackSpeed: vi.fn(() => 1),
        isOnline: true,
        setActiveCueMap: vi.fn(),
        setActiveParagraphMap: vi.fn(),
        setCueMeta: vi.fn(),
        pendingCueFallbackRef,
        activeSpeakTextRef,
        cueIntegrityRef,
        cueDurationRef,
        isInIntroRef,
      })
    );

    await act(async () => {
      await result.current.loadChapterSession("c-2", "auto");
    });

    expect(pushNotice).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
      })
    );
    expect(String(pushNotice.mock.calls[0]?.[0]?.message || "")).toContain("Autoplay stopped");
    expect(result.current.playbackPhase).toBe("READY");
    expect(result.current.isLoadingChapter).toBe(false);
    expect(setState).not.toHaveBeenCalled();
    expect(stateRef.current.books[0].currentChapterId).toBe("c-1");
  });

  it("updates isPlaying and playbackPhase when adapter emits isPlaying false", async () => {
    let stateListener: ((s: any) => void) | null = null;
    const mockAdapter = {
      onState: (fn: (s: any) => void) => {
        stateListener = fn;
        return () => {
          stateListener = null;
        };
      },
      onItemChanged: () => () => {},
      onEnded: () => () => {},
      onError: () => () => {},
      getState: () => ({
        isPlaying: false,
        currentTime: 0,
        duration: 0,
        positionMs: 0,
        durationMs: 0,
        playbackRate: 1,
        currentItemId: null,
      }),
      load: () => {},
      loadQueue: () => {},
      play: () => {},
      pause: () => {},
      stop: () => {},
      seek: () => {},
      setSpeed: () => {},
    };

    const stateRef = {
      current: {
        activeBookId: "book-1",
        globalRules: [],
        readerSettings: { uiMode: "mobile", reflowLineBreaks: false, speakChapterIntro: true },
        books: [{ id: "book-1", rules: [], currentChapterId: "c-1", settings: {}, chapters: [] }],
        playbackSpeed: 1,
      } as any,
    };

    const { result } = renderHook(() =>
      usePlayback({
        stateRef,
        setState: vi.fn(),
        pushNotice: vi.fn(),
        effectiveMobileMode: false,
        isAuthorized: false,
        playbackAdapter: mockAdapter as any,
        markDirty: vi.fn(),
        handleManualScrub: vi.fn(),
        handleChapterEnd: vi.fn(),
        handleSkip: vi.fn(),
        chapterSessionRef: { current: 0 },
        chapterTextCacheRef: { current: new Map() },
        ensureChapterContentLoaded: vi.fn(async () => null),
        getEffectivePlaybackSpeed: () => 1,
        isOnline: true,
        setActiveCueMap: vi.fn(),
        setActiveParagraphMap: vi.fn(),
        setCueMeta: vi.fn(),
        pendingCueFallbackRef: { current: null },
        activeSpeakTextRef: { current: null },
        cueIntegrityRef: {
          current: { chapterId: "", driftCount: 0, lastRebuildAt: 0, lastNoticeAt: 0 },
        },
        cueDurationRef: { current: { chapterId: "", lastDurationMs: 0, lastRebuildAt: 0 } },
        isInIntroRef: { current: false },
      })
    );

    expect(stateListener).not.toBeNull();
    await act(() => {
      stateListener!({
        isPlaying: true,
        currentTime: 0,
        duration: 100,
        positionMs: 0,
        durationMs: 100000,
        playbackRate: 1,
        currentItemId: null,
      });
    });
    expect(result.current.isPlaying).toBe(true);

    await act(() => {
      stateListener!({
        isPlaying: false,
        currentTime: 50,
        duration: 100,
        positionMs: 50000,
        durationMs: 100000,
        playbackRate: 1,
        currentItemId: null,
      });
    });
    expect(result.current.isPlaying).toBe(false);
  });
});
