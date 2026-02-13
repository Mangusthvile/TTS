import React, { useCallback, useEffect, useMemo, useRef } from "react";
import { Theme } from "../types";
import { RenderBlock } from "../utils/markdownBlockParser";

type CueRange = { start: number; end: number };

type Props = {
  blocks: RenderBlock[];
  activeCueRange?: CueRange | null;
  autoFollow: boolean;
  isScrubbing: boolean;
  followNudge: number;
  containerRef: React.RefObject<HTMLDivElement | null>;
  onUserScrollingChange?: (v: boolean) => void;
  theme?: Theme;
  spacerClassName?: string;
};

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function isWhitespaceChar(ch: string | undefined): boolean {
  return !!ch && /\s/.test(ch);
}

function computeTargetTop(container: HTMLElement, target: HTMLElement): number {
  const containerRect = container.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  return targetRect.top - containerRect.top + container.scrollTop;
}

function isSpeakableBlock(block: RenderBlock): boolean {
  return block.startIndex >= 0 && block.endIndex > block.startIndex;
}

function findActiveBlockIndex(blocks: RenderBlock[], index: number): number | null {
  const direct = blocks.findIndex(
    (b) =>
      isSpeakableBlock(b) &&
      index >= b.startIndex &&
      index < b.endIndex
  );
  if (direct >= 0) return direct;

  let previous: number | null = null;
  for (let i = 0; i < blocks.length; i += 1) {
    const b = blocks[i];
    if (!isSpeakableBlock(b)) continue;
    if (b.endIndex <= index) previous = i;
  }
  if (previous != null) return previous;

  for (let i = 0; i < blocks.length; i += 1) {
    const b = blocks[i];
    if (!isSpeakableBlock(b)) continue;
    if (b.startIndex > index) return i;
  }

  return null;
}

const ReaderList: React.FC<Props> = ({
  blocks,
  activeCueRange = null,
  autoFollow,
  isScrubbing,
  followNudge,
  containerRef,
  onUserScrollingChange,
  theme,
  spacerClassName,
}) => {
  const blockRefs = useRef<Array<HTMLElement | null>>([]);

  const userScrollingRef = useRef(false);
  const lockoutTimerRef = useRef<number | null>(null);

  const isAutoScrollingRef = useRef(false);
  const autoScrollTimerRef = useRef<number | null>(null);

  const lastFollowedBlockRef = useRef<number | null>(null);
  const followRafRef = useRef<number | null>(null);
  const lastForcedScrollRef = useRef<number>(0);

  const activeBlockIndex = useMemo(() => {
    if (!activeCueRange) return null;
    return findActiveBlockIndex(blocks, activeCueRange.start);
  }, [blocks, activeCueRange]);

  const setUserScrolling = useCallback(
    (v: boolean) => {
      userScrollingRef.current = v;
      onUserScrollingChange?.(v);
    },
    [onUserScrollingChange]
  );

  useEffect(() => {
    lastFollowedBlockRef.current = null;
    setUserScrolling(false);
  }, [blocks, setUserScrolling]);

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

  const scrollToBlock = useCallback(
    (index: number, behavior: ScrollBehavior, force: boolean) => {
      const container = containerRef.current;
      if (!container) return false;
      const item = blockRefs.current[index];
      if (!item) return false;
      if (!force && userScrollingRef.current) return false;

      const anchor =
        item.querySelector<HTMLElement>("[data-highlight-anchor='true']") ?? item;
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

  useEffect(() => {
    if (!autoFollow) return;
    if (isScrubbing) return;
    if (activeBlockIndex == null) return;
    if (userScrollingRef.current) return;
    if (lastFollowedBlockRef.current === activeBlockIndex) return;

    const prev = lastFollowedBlockRef.current;
    const jump = prev == null ? 0 : Math.abs(activeBlockIndex - prev);
    const behavior: ScrollBehavior = jump <= 2 ? "smooth" : "auto";

    const raf = window.requestAnimationFrame(() => {
      const didScroll = scrollToBlock(activeBlockIndex, behavior, false);
      if (didScroll) lastFollowedBlockRef.current = activeBlockIndex;
    });
    return () => window.cancelAnimationFrame(raf);
  }, [activeBlockIndex, autoFollow, isScrubbing, scrollToBlock]);

  useEffect(() => {
    if (!autoFollow) return;
    if (isScrubbing) return;
    if (activeBlockIndex == null) return;
    if (userScrollingRef.current) return;

    if (followRafRef.current) {
      window.cancelAnimationFrame(followRafRef.current);
      followRafRef.current = null;
    }

    followRafRef.current = window.requestAnimationFrame(() => {
      const container = containerRef.current;
      const blockEl = blockRefs.current[activeBlockIndex];
      if (!container || !blockEl) return;
      const anchor =
        blockEl.querySelector<HTMLElement>("[data-highlight-anchor='true']") ?? blockEl;
      const containerRect = container.getBoundingClientRect();
      const anchorRect = anchor.getBoundingClientRect();
      const marginTop = containerRect.height * 0.25;
      const marginBottom = containerRect.height * 0.25;
      const topBound = containerRect.top + marginTop;
      const bottomBound = containerRect.bottom - marginBottom;
      const outOfView = anchorRect.top < topBound || anchorRect.bottom > bottomBound;

      if (!outOfView) return;

      const now = Date.now();
      if (now - lastForcedScrollRef.current < 140) return;
      lastForcedScrollRef.current = now;
      scrollToBlock(activeBlockIndex, "smooth", false);
    });

    return () => {
      if (followRafRef.current) {
        window.cancelAnimationFrame(followRafRef.current);
        followRafRef.current = null;
      }
    };
  }, [
    activeBlockIndex,
    activeCueRange?.start,
    activeCueRange?.end,
    autoFollow,
    containerRef,
    isScrubbing,
    scrollToBlock,
  ]);

  useEffect(() => {
    if (!autoFollow) return;
    if (isScrubbing) return;
    if (activeBlockIndex == null) return;

    setUserScrolling(false);

    const raf = window.requestAnimationFrame(() => {
      const didScroll = scrollToBlock(activeBlockIndex, "auto", true);
      if (didScroll) lastFollowedBlockRef.current = activeBlockIndex;
    });
    return () => window.cancelAnimationFrame(raf);
  }, [followNudge, autoFollow, isScrubbing, activeBlockIndex, scrollToBlock, setUserScrolling]);

  const dimOthers = activeBlockIndex != null;

  const renderHighlightedText = (text: string, blockStart: number) => {
    if (!activeCueRange) return <span data-base={blockStart}>{text}</span>;

    const relStart = Math.max(0, activeCueRange.start - blockStart);
    const relEnd = Math.min(text.length, activeCueRange.end - blockStart);

    if (relStart >= relEnd) return <span data-base={blockStart}>{text}</span>;

    let highlightStart = relStart;
    let highlightEnd = relEnd;
    while (highlightStart < highlightEnd && isWhitespaceChar(text[highlightStart])) {
      highlightStart += 1;
    }
    while (highlightEnd > highlightStart && isWhitespaceChar(text[highlightEnd - 1])) {
      highlightEnd -= 1;
    }
    if (highlightEnd <= highlightStart) {
      return <span data-base={blockStart}>{text}</span>;
    }

    const before = text.slice(0, highlightStart);
    const active = text.slice(highlightStart, highlightEnd);
    const after = text.slice(highlightEnd);

    return (
      <>
        {before && <span data-base={blockStart}>{before}</span>}
        <span
          data-base={blockStart + highlightStart}
          data-highlight-anchor="true"
          data-active="true"
          className="rounded px-0.5 py-[0.05rem] bg-[var(--highlight-strong)] text-[var(--highlight-strong-text)]"
        >
          {active}
        </span>
        {after && <span data-base={blockStart + highlightEnd}>{after}</span>}
      </>
    );
  };

  const tableChrome =
    theme === Theme.DARK
      ? "border-sky-400/30 bg-sky-500/10 text-slate-100"
      : theme === Theme.SEPIA
        ? "border-sky-700/20 bg-sky-600/10 text-[#3c2f25]"
        : "border-sky-500/20 bg-sky-500/10 text-slate-900";
  const cellBorder = theme === Theme.DARK ? "border-white/10" : "border-black/10";
  const spacerClass = spacerClassName ?? "h-6";

  return (
    <div className="whitespace-pre-wrap flex flex-col">
      {blocks.map((block, idx) => {
        const isActiveBlock = idx === activeBlockIndex;
        const opacityClass = dimOthers ? (isActiveBlock ? "opacity-100" : "opacity-60") : "opacity-100";

        if (block.type === "spacer") {
          return (
            <div
              key={block.id}
              className={`${spacerClass} w-full select-none`}
              aria-hidden="true"
              ref={(el) => {
                blockRefs.current[idx] = el as HTMLElement | null;
              }}
            />
          );
        }

        if (block.type === "table" && block.rows) {
          const headerRow = block.headers ?? [];
          const bodyRows = block.rows ?? [];

          return (
            <div
              key={block.id}
              ref={(el) => {
                blockRefs.current[idx] = el as HTMLElement | null;
              }}
              className={`my-4 overflow-x-auto rounded-2xl border ${tableChrome} ${opacityClass} transition-opacity duration-300`}
            >
              <table className="min-w-full border-separate border-spacing-0 text-sm">
                {headerRow.length > 0 && (
                  <thead className={`text-[10px] font-black uppercase tracking-widest opacity-80 border-b ${cellBorder}`}>
                    <tr>
                      {headerRow.map((cell, colIdx) => {
                        const cellRange = block.cellRanges?.find(
                          (r) => r.row === 0 && r.col === colIdx && r.isHeader
                        );
                        const content = cellRange
                          ? renderHighlightedText(cell, cellRange.startIndex)
                          : cell;
                        return (
                          <th key={colIdx} className={`px-4 py-3 text-left whitespace-nowrap border-b ${cellBorder}`}>
                            {content}
                          </th>
                        );
                      })}
                    </tr>
                  </thead>
                )}
                <tbody className="text-sm">
                  {bodyRows.map((row, rIdx) => (
                    <tr key={rIdx} className={`border-b last:border-0 ${cellBorder}`}>
                      {row.map((cell, cIdx) => {
                        const cellRange = block.cellRanges?.find(
                          (r) => r.row === rIdx + 1 && r.col === cIdx && !r.isHeader
                        );
                        const content = cellRange
                          ? renderHighlightedText(cell, cellRange.startIndex)
                          : cell;
                        return (
                          <td key={cIdx} className={`px-4 py-3 align-top border-b ${cellBorder}`}>
                            {content}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }

        if (block.type === "code") {
          return (
            <pre
              key={block.id}
              ref={(el) => {
                blockRefs.current[idx] = el as HTMLElement | null;
              }}
              className={`my-4 overflow-x-auto rounded-xl p-4 text-xs ${theme === Theme.DARK ? "bg-slate-950/80" : "bg-black/5"} ${opacityClass} transition-opacity duration-300`}
            >
              <code>{block.content}</code>
            </pre>
          );
        }

        if (block.type === "heading") {
          const Tag = `h${Math.min(6, Math.max(1, block.level || 1))}` as React.ElementType;
          const sizeClass = block.level === 1 ? "text-2xl" : block.level === 2 ? "text-xl" : "text-lg";
          return (
            <Tag
              key={block.id}
              ref={(el: HTMLElement | null) => {
                blockRefs.current[idx] = el;
              }}
              className={`mt-4 mb-2 font-black tracking-tight ${sizeClass} ${opacityClass} transition-opacity duration-300`}
            >
              {renderHighlightedText(block.content || "", block.startIndex)}
            </Tag>
          );
        }

        if (block.type === "list" && block.items) {
          const ListTag = block.ordered ? "ol" : "ul";
          return (
            <ListTag
              key={block.id}
              ref={(el) => {
                blockRefs.current[idx] = el as HTMLElement | null;
              }}
              className={`my-4 ${block.ordered ? "list-decimal" : "list-disc"} pl-6 space-y-2 ${opacityClass} transition-opacity duration-300`}
            >
              {block.items.map((item, itemIdx) => {
                const range = block.itemRanges?.find((r) => r.index === itemIdx);
                return (
                  <li key={itemIdx} className="leading-relaxed">
                    {range ? renderHighlightedText(item, range.startIndex) : item}
                  </li>
                );
              })}
            </ListTag>
          );
        }

        return (
          <p
            key={block.id}
            ref={(el) => {
              blockRefs.current[idx] = el as HTMLElement | null;
            }}
            className={`leading-relaxed rounded-md transition-opacity duration-300 ${opacityClass} ${isActiveBlock ? "font-semibold" : ""}`}
          >
            {renderHighlightedText(block.content || "", block.startIndex)}
          </p>
        );
      })}
      {!blocks.length && <p className="opacity-60">No text</p>}
    </div>
  );
};

export default ReaderList;
