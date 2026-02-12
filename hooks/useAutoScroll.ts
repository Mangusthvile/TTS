import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
type AutoScrollOptions = {
  selector?: string;
  behavior?: ScrollBehavior;
  block?: ScrollLogicalPosition;
  inline?: ScrollLogicalPosition;
  userLockoutMs?: number;
  enabled?: boolean;
  extraTrigger?: number;
  forceOnTrigger?: boolean;
};

type AutoScrollState = {
  isUserScrolling: boolean;
  resume: () => void;
};

export function useAutoScroll<T extends HTMLElement>(
  activeIndex: number | null,
  containerRef: RefObject<T | null>,
  options: AutoScrollOptions = {}
): AutoScrollState {
  const {
    selector = '[data-active="true"]',
    behavior = "smooth",
    block = "center",
    inline = "nearest",
    userLockoutMs = 900,
    enabled = true,
    extraTrigger,
    forceOnTrigger = true,
  } = options;

  const userScrollingRef = useRef(false);
  const [isUserScrolling, setIsUserScrolling] = useState(false);
  const lockoutTimerRef = useRef<number | null>(null);
  const lastActiveRef = useRef<number | null>(null);
  const autoScrollTimerRef = useRef<number | null>(null);
  const isAutoScrollingRef = useRef(false);

  const scrollToActive = useCallback(
    (overrideBehavior?: ScrollBehavior) => {
      const container = containerRef.current;
      if (!container) return false;
      const target = container.querySelector<HTMLElement>(selector);
      if (!target) return false;
      isAutoScrollingRef.current = true;
      if (autoScrollTimerRef.current) {
        window.clearTimeout(autoScrollTimerRef.current);
      }
      target.scrollIntoView({
        behavior: overrideBehavior ?? behavior,
        block,
        inline,
      });
      autoScrollTimerRef.current = window.setTimeout(() => {
        isAutoScrollingRef.current = false;
      }, 300);
      return true;
    },
    [containerRef, selector, behavior, block, inline]
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const onScroll = () => {
      if (isAutoScrollingRef.current) return;
      userScrollingRef.current = true;
      setIsUserScrolling(true);
      if (lockoutTimerRef.current) {
        window.clearTimeout(lockoutTimerRef.current);
      }
      lockoutTimerRef.current = window.setTimeout(() => {
        userScrollingRef.current = false;
        setIsUserScrolling(false);
      }, userLockoutMs);
    };

    container.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      container.removeEventListener("scroll", onScroll);
      if (lockoutTimerRef.current) {
        window.clearTimeout(lockoutTimerRef.current);
      }
      if (autoScrollTimerRef.current) {
        window.clearTimeout(autoScrollTimerRef.current);
      }
    };
  }, [containerRef, userLockoutMs]);

  useEffect(() => {
    if (!enabled) return;
    if (activeIndex == null) return;
    if (userScrollingRef.current) return;
    if (lastActiveRef.current === activeIndex) return;
    let frame = 0;
    frame = window.requestAnimationFrame(() => {
      const didScroll = scrollToActive();
      if (didScroll) lastActiveRef.current = activeIndex;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeIndex, enabled, scrollToActive]);

  useEffect(() => {
    if (!enabled) return;
    if (extraTrigger == null) return;
    if (!forceOnTrigger && userScrollingRef.current) return;
    let frame = 0;
    frame = window.requestAnimationFrame(() => {
      scrollToActive("auto");
    });
    return () => window.cancelAnimationFrame(frame);
  }, [enabled, extraTrigger, forceOnTrigger, scrollToActive]);

  const resume = useCallback(() => {
    userScrollingRef.current = false;
    setIsUserScrolling(false);
    scrollToActive("auto");
  }, [scrollToActive]);

  return { isUserScrolling, resume };
}
