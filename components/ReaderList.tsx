import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildChunks, chunkIndexFromChar } from "../utils/chunking";

type CueRange = { start: number; end: number };

type Props = {
  text: string;
  ttsCharIndex: number | null;
  activeCueRange?: CueRange | null;
  autoFollow: boolean;
  isScrubbing: boolean;
  followNudge: number;
  containerRef: React.RefObject<HTMLDivElement | null>;
  onUserScrollingChange?: (v: boolean) => void;
};

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function isWhitespaceChar(ch: string | undefined): boolean {
  return !!ch && /\s/.test(ch);
}

function snapCharIndexOffWhitespace(text: string, idx: number | null): number | null {
  if (idx == null) return null;
  if (!Number.isFinite(idx)) return null;
  if (!text.length) return null;
  const clamped = clamp(Math.floor(idx), 0, Math.max(0, text.length - 1));
  if (!isWhitespaceChar(text[clamped])) return clamped;

  for (let i = clamped; i >= 0; i -= 1) {
    if (!isWhitespaceChar(text[i])) return i;
  }
  for (let i = clamped + 1; i < text.length; i += 1) {
    if (!isWhitespaceChar(text[i])) return i;
  }
  return clamped;
}

function computeTargetTop(container: HTMLElement, target: HTMLElement): number {
  const containerRect = container.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  return targetRect.top - containerRect.top + container.scrollTop;
}

const ReaderList: React.FC<Props> = ({
  text,
  ttsCharIndex,
  activeCueRange = null,
  autoFollow,
  isScrubbing,
  followNudge,
  containerRef,
  onUserScrollingChange,
}) => {
  const chunks = useMemo(() => buildChunks(text), [text]);
  const itemRefs = useRef<Array<HTMLParagraphElement | null>>([]);

  const userScrollingRef = useRef(false);
  const [isUserScrolling, setIsUserScrolling] = useState(false);
  const lockoutTimerRef = useRef<number | null>(null);

  const isAutoScrollingRef = useRef(false);
  const autoScrollTimerRef = useRef<number | null>(null);

  const lastFollowedChunkRef = useRef<number | null>(null);

  const snappedCharIndex = useMemo(() => snapCharIndexOffWhitespace(text, ttsCharIndex), [text, ttsCharIndex]);

  const activeChunkIndex = useMemo(() => {
    if (snappedCharIndex == null) return null;
    if (!chunks.length) return null;
    return chunkIndexFromChar(chunks, snappedCharIndex);
  }, [chunks, snappedCharIndex]);

  const setUserScrolling = useCallback(
    (v: boolean) => {
      userScrollingRef.current = v;
      setIsUserScrolling(v);
      onUserScrollingChange?.(v);
    },
    [onUserScrollingChange]
  );

  // Reset follow state when chapter text changes.
  useEffect(() => {
    lastFollowedChunkRef.current = null;
    setUserScrolling(false);
  }, [text, setUserScrolling]);

  // Detect manual scrolling without being tripped by our own programmatic scroll.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const clearLockout = () => {
      setUserScrolling(false);
    };

    const onScroll = () => {
      if (isAutoScrollingRef.current) return;
      if (!userScrollingRef.current) setUserScrolling(true);
      if (lockoutTimerRef.current) window.clearTimeout(lockoutTimerRef.current);
      lockoutTimerRef.current = window.setTimeout(clearLockout, 350);
    };

    const onUserInput = () => {
      // If the user is interacting during a smooth programmatic scroll, let them take over.
      if (isAutoScrollingRef.current) isAutoScrollingRef.current = false;
    };

    container.addEventListener("scroll", onScroll, { passive: true });
    container.addEventListener("wheel", onUserInput, { passive: true });
    container.addEventListener("touchmove", onUserInput, { passive: true });

    return () => {
      container.removeEventListener("scroll", onScroll);
      container.removeEventListener("wheel", onUserInput);
      container.removeEventListener("touchmove", onUserInput);
      if (lockoutTimerRef.current) window.clearTimeout(lockoutTimerRef.current);
      if (autoScrollTimerRef.current) window.clearTimeout(autoScrollTimerRef.current);
    };
  }, [containerRef, setUserScrolling]);

  const scrollToChunk = useCallback(
    (index: number, behavior: ScrollBehavior, force: boolean) => {
      const container = containerRef.current;
      if (!container) return false;
      const item = itemRefs.current[index];
      if (!item) return false;
      if (!force && userScrollingRef.current) return false;

      const anchor =
        item.querySelector<HTMLElement>('[data-highlight-anchor="true"]') ?? item;
      const targetTop = computeTargetTop(container, anchor);
      const anchorY = container.clientHeight * 0.3;

      const desired = clamp(
        targetTop - anchorY,
        0,
        Math.max(0, container.scrollHeight - container.clientHeight)
      );

      if (Math.abs(desired - container.scrollTop) <= 6) return true;

      isAutoScrollingRef.current = true;
      if (autoScrollTimerRef.current) window.clearTimeout(autoScrollTimerRef.current);
      const suppressionMs = behavior === "smooth" ? 700 : 250;

      container.scrollTo({ top: desired, behavior });
      autoScrollTimerRef.current = window.setTimeout(() => {
        isAutoScrollingRef.current = false;
      }, suppressionMs);

      return true;
    },
    [containerRef]
  );

  // Follow highlight as it moves.
  useEffect(() => {
    if (!autoFollow) return;
    if (isScrubbing) return;
    if (activeChunkIndex == null) return;
    if (snappedCharIndex == null) return;
    if (userScrollingRef.current) return;
    if (lastFollowedChunkRef.current === activeChunkIndex) return;

    const prev = lastFollowedChunkRef.current;
    const jump = prev == null ? 0 : Math.abs(activeChunkIndex - prev);
    const behavior: ScrollBehavior = jump <= 2 ? "smooth" : "auto";

    const raf = window.requestAnimationFrame(() => {
      const didScroll = scrollToChunk(activeChunkIndex, behavior, false);
      if (didScroll) lastFollowedChunkRef.current = activeChunkIndex;
    });
    return () => window.cancelAnimationFrame(raf);
  }, [activeChunkIndex, autoFollow, isScrubbing, snappedCharIndex, scrollToChunk]);

  // Forced snap after explicit seek/scrub.
  useEffect(() => {
    if (!autoFollow) return;
    if (isScrubbing) return;
    if (activeChunkIndex == null) return;
    if (snappedCharIndex == null) return;

    setUserScrolling(false);

    const raf = window.requestAnimationFrame(() => {
      const didScroll = scrollToChunk(activeChunkIndex, "auto", true);
      if (didScroll) lastFollowedChunkRef.current = activeChunkIndex;
    });
    return () => window.cancelAnimationFrame(raf);
  }, [
    followNudge,
    autoFollow,
    isScrubbing,
    activeChunkIndex,
    snappedCharIndex,
    scrollToChunk,
    setUserScrolling,
  ]);

  const dimOthers = activeChunkIndex != null;

  return (
    <div className="whitespace-pre-wrap">
      {chunks.map((chunk, idx) => {
        const isActiveChunk = idx === activeChunkIndex;
        const hasActiveCue =
          activeCueRange != null &&
          activeCueRange.end > chunk.start &&
          activeCueRange.start < chunk.end;

        let content: React.ReactNode = (
          <span data-base={chunk.start}>{chunk.text}</span>
        );

        if (hasActiveCue && activeCueRange) {
          const relStart = Math.max(0, activeCueRange.start - chunk.start);
          const relEnd = Math.min(
            chunk.text.length,
            Math.max(relStart, activeCueRange.end - chunk.start)
          );
          let highlightStart = relStart;
          let highlightEnd = relEnd;
          while (highlightStart < highlightEnd && isWhitespaceChar(chunk.text[highlightStart])) {
            highlightStart += 1;
          }
          while (highlightEnd > highlightStart && isWhitespaceChar(chunk.text[highlightEnd - 1])) {
            highlightEnd -= 1;
          }
          if (highlightEnd > highlightStart) {
            const before = chunk.text.slice(0, highlightStart);
            const active = chunk.text.slice(highlightStart, highlightEnd);
            const after = chunk.text.slice(highlightEnd);
            content = (
              <>
                {before && <span data-base={chunk.start}>{before}</span>}
                <span
                  data-base={chunk.start + highlightStart}
                  data-highlight-anchor="true"
                  data-active="true"
                  className="rounded px-0.5 py-[0.05rem] bg-[var(--highlight-weak)]"
                >
                  {active}
                </span>
                {after && (
                  <span data-base={chunk.start + highlightEnd}>{after}</span>
                )}
              </>
            );
          }
        }

        const chunkClassName = [
          "leading-relaxed rounded-md px-1 -mx-1 transition-colors",
          dimOthers ? (isActiveChunk ? "opacity-100" : "opacity-60") : "",
        ]
          .filter(Boolean)
          .join(" ");
        const activeTextClass = isActiveChunk
          ? "rounded px-0.5 py-[0.05rem] bg-[var(--highlight-strong)] text-[var(--highlight-strong-text)]"
          : "";

        return (
          <p
            key={chunk.id}
            ref={(el) => {
              itemRefs.current[idx] = el;
            }}
            data-base={chunk.start}
            data-chunk-index={idx}
            data-active={isActiveChunk ? "true" : "false"}
            className={chunkClassName}
          >
            <span className={activeTextClass}>{content}</span>
          </p>
        );
      })}
      {!chunks.length && <p className="opacity-60">No text</p>}
    </div>
  );
};

export default ReaderList;
