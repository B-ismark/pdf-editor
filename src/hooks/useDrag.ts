import type React from "react";

interface DragHandlers {
  /** Called on each move with the total CSS-pixel delta from the start. */
  onMove: (dx: number, dy: number) => void;
  onEnd?: () => void;
}

/**
 * Start a pointer drag from a React pointer-down event. Tracks the pointer on
 * `window` until release and reports the cumulative delta, so the caller can
 * apply it to geometry captured at drag start. Stops propagation so the page
 * overlay doesn't treat the gesture as a click.
 */
export function startPointerDrag(
  e: React.PointerEvent,
  { onMove, onEnd }: DragHandlers,
): void {
  e.preventDefault();
  e.stopPropagation();
  const startX = e.clientX;
  const startY = e.clientY;

  const move = (ev: PointerEvent) => onMove(ev.clientX - startX, ev.clientY - startY);
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    onEnd?.();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}
