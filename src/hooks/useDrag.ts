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

const TAP_SLOP = 10; // px of movement still counted as a tap, not a drag

/**
 * Touch-friendly tap detection. Fires `onTap` only if the pointer barely
 * moved, and never stops propagation or sets the drag lock — so a pan gesture
 * that happens to start on an element passes through to the viewport instead
 * of selecting it. On mouse, selection is immediate (a click is precise).
 */
export function tapSelect(e: React.PointerEvent, onTap: () => void): void {
  if (e.pointerType !== "touch") {
    onTap();
    return;
  }
  const sx = e.clientX;
  const sy = e.clientY;
  const t0 = performance.now();
  let moved = false;
  const move = (ev: PointerEvent) => {
    if (Math.hypot(ev.clientX - sx, ev.clientY - sy) > TAP_SLOP) moved = true;
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", up);
    if (!moved && performance.now() - t0 < 700) onTap();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", up);
}

interface ElementGesture {
  selected: boolean;
  onSelect: () => void;
  onMove: (dx: number, dy: number) => void;
  onEnd?: () => void;
}

/**
 * Select-first element gesture. On touch, an *unselected* element ignores the
 * drag (letting the page pan under the finger) and only selects on a clean
 * tap; once selected it can be dragged. On mouse, press-drag always moves it.
 * This stops a phone user's every stray touch from grabbing/moving elements.
 */
export function startElementGesture(e: React.PointerEvent, o: ElementGesture): void {
  if (e.pointerType === "touch" && !o.selected) {
    tapSelect(e, o.onSelect);
    return;
  }
  o.onSelect();
  startPointerDrag(e, { onMove: o.onMove, onEnd: o.onEnd });
}
