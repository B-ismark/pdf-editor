import type React from "react";

/** Shared lock so the viewport's pan/pinch ignores gestures that belong to an
 * element drag/resize or an in-overlay redaction draw. */
export const dragState = { active: false };

interface DragHandlers {
  /** Called on each move with the total CSS-pixel delta from the start. */
  onMove: (dx: number, dy: number) => void;
  onEnd?: () => void;
}

/**
 * Start a pointer drag from a React pointer-down event. Tracks the pointer on
 * `window` until release and reports the cumulative delta, so the caller can
 * apply it to geometry captured at drag start. Stops propagation and sets the
 * shared drag lock so the page viewport doesn't also pan.
 */
export function startPointerDrag(
  e: React.PointerEvent,
  { onMove, onEnd }: DragHandlers,
): void {
  e.preventDefault();
  e.stopPropagation();
  const startX = e.clientX;
  const startY = e.clientY;
  dragState.active = true;

  const move = (ev: PointerEvent) => onMove(ev.clientX - startX, ev.clientY - startY);
  const up = () => {
    dragState.active = false;
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", up);
    onEnd?.();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", up);
}
