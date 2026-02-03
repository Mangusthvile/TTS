import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import Library from "../components/Library";
import { Theme, StorageBackend, HighlightMode } from "../types";

describe("Library component", () => {
  it("renders a list of books and triggers selection", async () => {
    const onSelectBook = vi.fn();
    const onAddBook = vi.fn(async () => {});
    render(
      <Library
        books={[
          {
            id: "b1",
            title: "Book One",
            backend: StorageBackend.MEMORY,
            chapters: [],
            rules: [],
            settings: { useBookSettings: false, highlightMode: HighlightMode.WORD },
            updatedAt: Date.now(),
          },
        ]}
        activeBookId="b1"
        onSelectBook={onSelectBook}
        onAddBook={onAddBook}
        theme={Theme.DARK}
        isCloudLinked={false}
        onLinkCloud={() => {}}
      />
    );

    expect(screen.getByText("Library")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Book One"));
    expect(onSelectBook).toHaveBeenCalledWith("b1");
  });
});
