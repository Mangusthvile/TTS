import type React from "react";
import { useCallback, useRef } from "react";

type UseSelectionGestureArgs = {
  onTap?: (event: React.MouseEvent) => void;
  onLongPress?: () => void;
  enabled?: boolean;
  longPressMs?: number;
  moveThresholdPx?: number;
};

export function useSelectionGesture({
  onTap,
  onLongPress,
  enabled = true,
  longPressMs = 420,
  moveThresholdPx = 10,
}: UseSelectionGestureArgs) {
  const timerRef = useRef<number | null>(null);
  const pointerIdRef = useRef<number | null>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const longPressTriggeredRef = useRef(false);

  const clear = useCallback(() => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    pointerIdRef.current = null;
    startRef.current = null;
  }, []);

  const onPointerDown = useCallback(
    (event: React.PointerEvent) => {
      if (!enabled) return;
      if (typeof event.isPrimary === "boolean" && !event.isPrimary) return;
      longPressTriggeredRef.current = false;
      pointerIdRef.current = event.pointerId;
      startRef.current = { x: event.clientX, y: event.clientY };
      timerRef.current = window.setTimeout(() => {
        longPressTriggeredRef.current = true;
        onLongPress?.();
        clear();
      }, longPressMs);
    },
    [clear, enabled, longPressMs, onLongPress]
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent) => {
      if (!enabled) return;
      if (pointerIdRef.current == null || event.pointerId !== pointerIdRef.current) return;
      const start = startRef.current;
      if (!start) return;
      const dx = event.clientX - start.x;
      const dy = event.clientY - start.y;
      if (dx * dx + dy * dy > moveThresholdPx * moveThresholdPx) {
        clear();
      }
    },
    [clear, enabled, moveThresholdPx]
  );

  const onPointerUp = useCallback(
    (event: React.PointerEvent) => {
      if (!enabled) return;
      if (pointerIdRef.current != null && event.pointerId !== pointerIdRef.current) return;
      clear();
    },
    [clear, enabled]
  );

  const onPointerCancel = useCallback(
    (event: React.PointerEvent) => {
      if (pointerIdRef.current != null && event.pointerId !== pointerIdRef.current) return;
      clear();
    },
    [clear]
  );

  const onClick = useCallback(
    (event: React.MouseEvent) => {
      if (longPressTriggeredRef.current) {
        longPressTriggeredRef.current = false;
        return;
      }
      onTap?.(event);
    },
    [onTap]
  );

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    onClick,
  };
}
