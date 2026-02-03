import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import ChapterSidebar from "../components/ChapterSidebar";
import { Theme } from "../types";

describe("ChapterSidebar component", () => {
  it("renders a long chapter list", () => {
    const chapters = Array.from({ length: 50 }, (_, i) => ({
      id: `c${i}`,
      title: `Chapter ${i + 1}`,
      index: i + 1,
      progress: 0,
    }));

    render(
      <ChapterSidebar
        book={{ id: "b1", title: "Book 1", chapters } as any}
        theme={Theme.DARK}
        onSelectChapter={vi.fn()}
        onClose={vi.fn()}
        isDrawer={false}
        hasMoreChapters={false}
      />
    );

    expect(screen.getByText("Chapter 1")).toBeInTheDocument();
    expect(screen.getByText("Chapter 50")).toBeInTheDocument();
  });
});
