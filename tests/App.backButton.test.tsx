import { describe, expect, it, vi } from "vitest";
import { handleAndroidBackPriority } from "../App";

describe("handleAndroidBackPriority", () => {
  it("consumes overlay handler first and skips default navigation", () => {
    const consumeOverlayBack = vi.fn(() => true);
    const goBack = vi.fn();
    const exitApp = vi.fn();

    handleAndroidBackPriority({
      canGoBack: true,
      consumeOverlayBack,
      goBack,
      exitApp,
    });

    expect(consumeOverlayBack).toHaveBeenCalledTimes(1);
    expect(goBack).not.toHaveBeenCalled();
    expect(exitApp).not.toHaveBeenCalled();
  });

  it("uses history navigation when overlay is not consumed and canGoBack is true", () => {
    const consumeOverlayBack = vi.fn(() => false);
    const goBack = vi.fn();
    const exitApp = vi.fn();

    handleAndroidBackPriority({
      canGoBack: true,
      consumeOverlayBack,
      goBack,
      exitApp,
    });

    expect(goBack).toHaveBeenCalledTimes(1);
    expect(exitApp).not.toHaveBeenCalled();
  });

  it("exits app when overlay is not consumed and canGoBack is false", () => {
    const consumeOverlayBack = vi.fn(() => false);
    const goBack = vi.fn();
    const exitApp = vi.fn();

    handleAndroidBackPriority({
      canGoBack: false,
      consumeOverlayBack,
      goBack,
      exitApp,
    });

    expect(goBack).not.toHaveBeenCalled();
    expect(exitApp).toHaveBeenCalledTimes(1);
  });
});
