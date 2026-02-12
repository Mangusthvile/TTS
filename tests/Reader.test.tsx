import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import Reader from "../components/Reader";
import { Theme } from "../types";

describe("Reader component", () => {
  it("calls onBackToCollection when back is clicked", () => {
    const onBack = vi.fn();
    render(
      <Reader
        chapter={{ id: "c1", title: "Chapter 1", index: 1, content: "Hello", filename: "c1.txt", progress: 0 } as any}
        rules={[]}
        theme={Theme.DARK}
        debugMode={false}
        onToggleDebug={() => {}}
        onJumpToOffset={() => {}}
        onBackToCollection={onBack}
        readerSettings={{
          fontFamily: "serif",
          fontSizePx: 18,
          lineHeight: 1.5,
          paragraphSpacing: 1,
          reflowLineBreaks: false,
          highlightColor: "#6366f1",
          followHighlight: false,
          uiMode: "mobile",
        } as any}
        isMobile={true}
      />
    );

    fireEvent.click(screen.getByText("Back"));
    expect(onBack).toHaveBeenCalled();
  });
});
