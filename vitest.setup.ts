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

// Use a consistent setTimeout-based pair so clear always matches (Vitest 3 / jsdom may provide
// requestIdleCallback with an id that cannot be cleared with clearTimeout).
const idleCb = (cb: () => void) => window.setTimeout(cb, 0) as unknown as number;
const cancelIdle = (id: number) => window.clearTimeout(id);
vi.stubGlobal("requestIdleCallback", idleCb);
vi.stubGlobal("cancelIdleCallback", cancelIdle);
(globalThis as any).requestIdleCallback = idleCb;
(globalThis as any).cancelIdleCallback = cancelIdle;

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
      children: (props: {
        index: number;
        style: React.CSSProperties;
        data?: unknown;
      }) => React.ReactNode;
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
