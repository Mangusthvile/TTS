import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";
import React from "react";

class MockAudio {
  preload = "";
  currentTime = 0;
  duration = 0;
  paused = true;
  volume = 1;
  playbackRate = 1;
  addEventListener = vi.fn();
  removeEventListener = vi.fn();
  play = vi.fn().mockResolvedValue(undefined);
  pause = vi.fn();
  load = vi.fn();
}

// Avoid real media elements keeping the event loop alive in jsdom.
if (typeof (globalThis as any).Audio === "undefined") {
  (globalThis as any).Audio = MockAudio;
} else {
  (globalThis as any).Audio = MockAudio;
}

if (typeof (globalThis as any).ResizeObserver === "undefined") {
  (globalThis as any).ResizeObserver = class {
    observe() {}
    disconnect() {}
    unobserve() {}
  };
}

if (typeof (globalThis as any).IntersectionObserver === "undefined") {
  (globalThis as any).IntersectionObserver = class {
    observe() {}
    disconnect() {}
    unobserve() {}
  };
}

if (typeof (globalThis as any).requestAnimationFrame === "undefined") {
  (globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) =>
    window.setTimeout(() => cb(Date.now()), 0);
  (globalThis as any).cancelAnimationFrame = (id: number) => window.clearTimeout(id);
}

if (typeof (globalThis as any).requestIdleCallback === "undefined") {
  (globalThis as any).requestIdleCallback = (cb: () => void) =>
    window.setTimeout(cb, 0);
  (globalThis as any).cancelIdleCallback = (id: number) => window.clearTimeout(id);
}

vi.mock("react-window", () => {
  return {
    VariableSizeList: ({
      itemCount,
      itemData,
      children,
      className,
      outerRef,
    }: {
      itemCount: number;
      itemData?: unknown;
      children: (props: { index: number; style: React.CSSProperties; data?: unknown }) => React.ReactNode;
      className?: string;
      outerRef?: React.Ref<HTMLDivElement>;
    }) => {
      const items: React.ReactNode[] = [];
      for (let index = 0; index < itemCount; index += 1) {
        items.push(children({ index, style: {}, data: itemData }));
      }
      return React.createElement("div", { ref: outerRef, className }, items);
    },
  };
});
