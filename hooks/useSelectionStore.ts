import { useCallback, useMemo, useRef, useState } from "react";

type ToggleOptions = { range?: boolean; additive?: boolean };

export type SelectionStore = {
  selectionMode: boolean;
  selectedIds: Set<string>;
  anchorId: string | null;
  replace: (next: Set<string>) => void;
  enterSelection: (id: string) => void;
  toggle: (id: string, opts?: ToggleOptions) => void;
  rangeSelect: (toId: string, additive?: boolean) => void;
  selectAll: (ids: string[]) => void;
  invert: (ids: string[]) => void;
  clear: () => void;
};

export function useSelectionStore(
  getVisibleIds: () => string[],
  enabled: boolean
): SelectionStore {
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [anchorId, setAnchorId] = useState<string | null>(null);
  const anchorRef = useRef<string | null>(null);

  const replace = useCallback((next: Set<string>) => {
    setSelectedIds(next);
  }, []);

  const enterSelection = useCallback(
    (id: string) => {
      if (!enabled) return;
      setSelectionMode(true);
      setSelectedIds(new Set([id]));
      setAnchorId(id);
      anchorRef.current = id;
    },
    [enabled]
  );

  const rangeSelect = useCallback(
    (toId: string, additive: boolean = true) => {
      if (!enabled) return;
      const order = getVisibleIds();
      const anchor = anchorRef.current ?? anchorId ?? Array.from(selectedIds)[0] ?? null;
      if (!anchor) {
        setSelectedIds(new Set([toId]));
        setAnchorId(toId);
        anchorRef.current = toId;
        setSelectionMode(true);
        return;
      }
      const startIdx = order.indexOf(anchor);
      const endIdx = order.indexOf(toId);
      if (startIdx === -1 || endIdx === -1) {
        setSelectedIds((prev) => {
          const next = additive ? new Set(prev) : new Set<string>();
          next.add(toId);
          return next;
        });
        setAnchorId(toId);
        anchorRef.current = toId;
        setSelectionMode(true);
        return;
      }
      const [lo, hi] = startIdx <= endIdx ? [startIdx, endIdx] : [endIdx, startIdx];
      const rangeIds = order.slice(lo, hi + 1);
      setSelectedIds((prev) => {
        const next = additive ? new Set(prev) : new Set<string>();
        rangeIds.forEach((id) => next.add(id));
        return next;
      });
      setAnchorId(toId);
      anchorRef.current = toId;
      setSelectionMode(true);
    },
    [anchorId, enabled, getVisibleIds, selectedIds]
  );

  const toggle = useCallback(
    (id: string, opts?: ToggleOptions) => {
      if (!enabled) return;
      if (opts?.range) {
        rangeSelect(id, opts.additive !== false);
        return;
      }
      setSelectionMode(true);
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      setAnchorId((prev) => prev || id);
      if (!anchorRef.current) anchorRef.current = id;
    },
    [enabled, rangeSelect]
  );

  const selectAll = useCallback(
    (ids: string[]) => {
      if (!enabled) return;
      setSelectionMode(true);
      setSelectedIds(new Set(ids));
      setAnchorId(ids[0] ?? null);
      anchorRef.current = ids[0] ?? null;
    },
    [enabled]
  );

  const invert = useCallback(
    (ids: string[]) => {
      if (!enabled) return;
      const nextIds: string[] = [];
      const set = new Set(selectedIds);
      for (const id of ids) {
        if (!set.has(id)) nextIds.push(id);
      }
      setSelectionMode(true);
      setSelectedIds(new Set(nextIds));
      setAnchorId((prev) => (prev && nextIds.includes(prev) ? prev : nextIds[0] ?? null));
      anchorRef.current = nextIds[0] ?? null;
    },
    [enabled, selectedIds]
  );

  const clear = useCallback(() => {
    setSelectionMode(false);
    setSelectedIds(new Set());
    setAnchorId(null);
    anchorRef.current = null;
  }, []);

  return useMemo(
    () => ({
      selectionMode,
      selectedIds,
      anchorId,
      replace,
      enterSelection,
      toggle,
      rangeSelect,
      selectAll,
      invert,
      clear,
    }),
    [selectionMode, selectedIds, anchorId, replace, enterSelection, toggle, rangeSelect, selectAll, invert, clear]
  );
}
