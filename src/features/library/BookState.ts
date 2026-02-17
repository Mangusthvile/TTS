import { useMemo } from "react";
import type { Book, Chapter } from "../../../types";
import { normalizeChapterOrder, getChapterSortOrder } from "../../../services/chapterOrderingService";
import { useSelectionStore } from "../../../hooks/useSelectionStore";

type VolumeSection = {
  volumeName: string;
  volumeNumber: number | null;
  chapters: Chapter[];
};

export type BookDerivedState = {
  chapters: Chapter[];
  filteredChapters: Chapter[];
  volumeSections: { volumes: VolumeSection[]; ungrouped: Chapter[] };
  visibleChapters: Chapter[];
};

type Params = {
  book: Book;
  searchQuery: string;
  collapsedVolumes: Record<string, boolean>;
  selectionEnabled: boolean;
};

export function useBookState(params: Params) {
  const { book, searchQuery, collapsedVolumes, selectionEnabled } = params;

  const chapters = useMemo(() => normalizeChapterOrder(book.chapters || []), [book.chapters]);

  const filteredChapters = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return chapters;
    return chapters.filter((chapter) => {
      const title = `${chapter.title || ""}`.toLowerCase();
      const filename = `${chapter.filename || ""}`.toLowerCase();
      const idx = `${chapter.index || getChapterSortOrder(chapter) || ""}`;
      return title.includes(q) || filename.includes(q) || idx.includes(q);
    });
  }, [chapters, searchQuery]);

  const volumeSections = useMemo(() => {
    const grouped = new Map<string, Chapter[]>();
    const ungrouped: Chapter[] = [];
    for (const ch of filteredChapters) {
      const volumeName =
        typeof (ch as any).volumeName === "string" ? String((ch as any).volumeName).trim() : "";
      if (!volumeName) {
        ungrouped.push(ch);
        continue;
      }
      const list = grouped.get(volumeName) || [];
      list.push(ch);
      grouped.set(volumeName, list);
    }

    const volumes = Array.from(grouped.entries()).map(([volumeName, items]) => {
      const m = volumeName.match(/^(book|volume)\s*(\d+)/i);
      const volumeNumber = m ? parseInt(m[2], 10) : null;
      const sorted = normalizeChapterOrder(items);
      return { volumeName, volumeNumber: Number.isFinite(volumeNumber) ? volumeNumber : null, chapters: sorted };
    });

    const explicitOrder = Array.isArray(book.settings?.volumeOrder)
      ? book.settings.volumeOrder
          .filter((name): name is string => typeof name === "string" && name.trim().length > 0)
          .map((name) => name.trim())
      : [];
    const includeEmptyVolumes = searchQuery.trim().length === 0;
    if (includeEmptyVolumes) {
      for (const volumeName of explicitOrder) {
        if (grouped.has(volumeName)) continue;
        const m = volumeName.match(/^(book|volume)\s*(\d+)/i);
        const volumeNumber = m ? parseInt(m[2], 10) : null;
        volumes.push({
          volumeName,
          volumeNumber: Number.isFinite(volumeNumber) ? volumeNumber : null,
          chapters: [],
        });
      }
      for (const [volumeName] of Object.entries(collapsedVolumes || {})) {
        const normalized = volumeName.trim();
        if (!normalized || grouped.has(normalized) || volumes.some((v) => v.volumeName === normalized)) continue;
        const m = normalized.match(/^(book|volume)\s*(\d+)/i);
        const volumeNumber = m ? parseInt(m[2], 10) : null;
        volumes.push({
          volumeName: normalized,
          volumeNumber: Number.isFinite(volumeNumber) ? volumeNumber : null,
          chapters: [],
        });
      }
    }
    const explicitOrderMap = new Map<string, number>();
    explicitOrder.forEach((name, idx) => explicitOrderMap.set(name, idx));

    const NONE = 1_000_000_000;
    volumes.sort((a, b) => {
      const explicitA = explicitOrderMap.has(a.volumeName) ? explicitOrderMap.get(a.volumeName)! : NONE;
      const explicitB = explicitOrderMap.has(b.volumeName) ? explicitOrderMap.get(b.volumeName)! : NONE;
      if (explicitA !== explicitB) return explicitA - explicitB;
      const aN = a.volumeNumber ?? NONE;
      const bN = b.volumeNumber ?? NONE;
      if (aN !== bN) return aN - bN;
      return a.volumeName.localeCompare(b.volumeName, undefined, { numeric: true });
    });

    return {
      volumes,
      ungrouped: normalizeChapterOrder(ungrouped),
    };
  }, [filteredChapters, book.settings?.volumeOrder, collapsedVolumes, searchQuery]);

  const visibleChapters = useMemo(() => {
    const rows: Chapter[] = [];
    for (const group of volumeSections.volumes) {
      if (collapsedVolumes[group.volumeName]) continue;
      rows.push(...group.chapters);
    }
    rows.push(...volumeSections.ungrouped);
    return rows;
  }, [volumeSections, collapsedVolumes]);

  const selection = useSelectionStore(
    () => visibleChapters.map((chapter) => chapter.id),
    selectionEnabled
  );

  return {
    derived: { chapters, filteredChapters, volumeSections, visibleChapters },
    selection,
  };
}
