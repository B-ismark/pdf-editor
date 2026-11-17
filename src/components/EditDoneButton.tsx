import { useEffect, useRef, useState, type RefObject } from "react";
import { Icon } from "./Icon";
import { toLocal } from "../hooks/useDrag";

/**
 * A subtle "done editing" tick that trails the end of a text element while it
 * is being edited on mobile. Gives an explicit way to commit and dismiss the
 * keyboard. It hides itself while the user is actively typing (so it never
 * sits on top of the text being written) and reappears — repositioned to the
 * new end of the text — once typing pauses. Pointer-down is swallowed so
 * pressing it doesn't blur the editable before the click lands.
 */
export function EditDoneButton({
  editableRef,
  onDone,
}: {
  editableRef: RefObject<HTMLElement | null>;
  onDone: () => void;
}) {
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [typing, setTyping] = useState(false);
  const timer = useRef<number>(0);

  // Position the tick just past the caret at the very end of the content,
  // in the page overlay's coordinate space (the same space the editable and
  // the other overlay chrome live in).
  const measure = () => {
    const el = editableRef.current;
    if (!el) return;
    const overlay = el.closest(".page__overlay") as HTMLElement | null;
    if (!overlay) return;
    // Worked out in the overlay's own (unturned) frame: on a turned page its
    // screen box is rotated, so client-rect arithmetic would put the tick off
    // to a side.
    const W = overlay.offsetWidth;
    // Which way the text runs in that frame: a page's own text runs along it,
    // but a text box or note made upright on a turned page is turned against
    // it, and the tick has to trail the text, not the frame.
    let rel = 0;
    for (let n: HTMLElement | null = el; n && n !== overlay; n = n.parentElement) {
      const t = getComputedStyle(n).transform;
      if (t && t !== "none") {
        const m = new DOMMatrix(t);
        rel += Math.atan2(m.b, m.a);
      }
    }
    const dir = { x: Math.cos(rel), y: Math.sin(rel) };
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const rects = range.getClientRects();
    // Empty element (no text yet) has no caret rects — anchor to its own box.
    const r = rects.length ? rects[rects.length - 1] : el.getBoundingClientRect();
    // The caret at the end of the text, mapped into the overlay frame; its
    // centre survives any turn. A caret is a line, so its length is its line
    // height whichever way it's turned.
    const end = toLocal(overlay, r.left + r.width / 2, r.top + r.height / 2);
    const lineH = rects.length ? Math.max(r.width, r.height) : el.offsetHeight;
    // An empty element's own box has width to clear.
    const halfW = rects.length ? 0 : el.offsetWidth / 2;
    const TICK = 24;
    const at = { x: end.x + dir.x * (halfW + 8), y: end.y + dir.y * (halfW + 8) };
    // The overlay clips 16px past the page edge (to match the exported page),
    // so a tick for text ending near the edge would be cut off. There it sits
    // above the end of the text instead, inside the page.
    if (Math.abs(rel) < 0.01 && at.x + TICK > W + 12) {
      setPos({ left: W - TICK - 4, top: Math.max(TICK / 2, end.y - lineH / 2 - TICK / 2 - 4) });
    } else {
      setPos({ left: at.x, top: at.y });
    }
  };

  useEffect(() => {
    measure();
    const el = editableRef.current;
    if (!el) return;
    const onInput = () => {
      setTyping(true);
      window.clearTimeout(timer.current);
      // "Done typing" = a short pause after the last keystroke.
      timer.current = window.setTimeout(() => {
        setTyping(false);
        measure();
      }, 650);
    };
    el.addEventListener("input", onInput);
    return () => {
      el.removeEventListener("input", onInput);
      window.clearTimeout(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!pos || typing) return null;

  return (
    <button
      type="button"
      className="edit-done"
      aria-label="Done editing"
      data-tip="Done"
      style={{ left: `${pos.left}px`, top: `${pos.top}px` }}
      onPointerDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onDone();
      }}
    >
      <Icon name="check" size={16} />
    </button>
  );
}
