import { memo, useEffect, useRef } from "react";
import { CSS_FONT, TEXTBOX_LINE_HEIGHT } from "../pdf/style";
import { elementTap, lastEditPoint, startPointerDrag } from "../hooks/useDrag";
import { clearGuides, setGuides, snapBox } from "../hooks/useSnap";
import { focusEditable, placeCaretEnd } from "../caret";
import { baselineOffset, fontShorthand } from "../textBaseline";
import { EditDoneButton } from "./EditDoneButton";
import type { TextBox } from "../pdf/types";

interface Props {
  box: TextBox;
  scale: number;
  pageHeight: number;
  pageWidth: number;
  selected: boolean;
  interactive: boolean;
  /** Typing allowed now (always on desktop; edit mode only on mobile). */
  editing: boolean;
  autoFocus: boolean;
  onSelect: (id: string) => void;
  /** Double-tap (touch) to enter edit mode on mobile. */
  onEdit?: (id: string) => void;
  /** When set (mobile edit mode), a "done" checkmark is shown; commits the edit. */
  onDone?: () => void;
  onChangeText: (id: string, text: string) => void;
  onChange: (id: string, patch: Partial<TextBox>, key: string) => void;
}

const MIN_SIZE = 4;
const MAX_SIZE = 400;

/** A user-added text box: editable, draggable, and font-size resizable. */
function TextBoxItemImpl({
  box,
  scale,
  pageHeight,
  pageWidth,
  selected,
  interactive,
  editing,
  autoFocus,
  onSelect,
  onEdit,
  onDone,
  onChangeText,
  onChange,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const gesture = useRef(0);
  const H = pageHeight;

  // Re-seed the uncontrolled contentEditable from state only when it actually
  // differs — a no-op while typing (no caret jump), a re-seed on undo/redo or
  // any other external change. See EditableFragment for the rationale. Text
  // boxes are multi-line, so we round-trip through `innerText` (which maps
  // rendered line breaks to "\n" and back) rather than `textContent`.
  useEffect(() => {
    const el = ref.current;
    if (!el || el.innerText === box.text) return;
    el.innerText = box.text;
    if (document.activeElement === el) placeCaretEnd(el);
  }, [box.text]);

  // Enter edit (mobile "Edit", double-tap, or a freshly added box): focus,
  // drop the caret where the entering tap landed (or at the end), and scroll
  // into view above the keyboard.
  useEffect(() => {
    if (!autoFocus || !ref.current) return;
    focusEditable(ref.current, lastEditPoint);
  }, [autoFocus]);

  const fontPx = box.style.size * scale;
  const left = box.x * scale;
  // `box.y` is the first line's baseline — that's where the exporter draws it —
  // so the wrapper's top edge sits a measured baseline offset above it, not a
  // whole font size (see `textBaseline.ts`). Subsequent lines step by
  // TEXTBOX_LINE_HEIGHT on both sides, so anchoring line one anchors them all.
  const shorthand = fontShorthand(
    box.style.italic ? "italic" : "normal",
    box.style.bold ? "bold" : "normal",
    fontPx,
    CSS_FONT[box.style.font],
  );
  const top = (H - box.y) * scale - baselineOffset(shorthand, TEXTBOX_LINE_HEIGHT, fontPx);

  const beginMove = (e: React.PointerEvent) => {
    onSelect(box.id);
    const key = `move-tb-${box.id}-${++gesture.current}`;
    const s = { x: box.x, y: box.y };
    const wPdf = (ref.current?.offsetWidth ?? 0) / scale;
    const hPdf = box.style.size;
    startPointerDrag(e, {
      onMove: (dx, dy) => {
        const px = s.x + dx / scale;
        const py = s.y - dy / scale;
        const sn = snapBox(px, py, wPdf, hPdf, pageWidth, H, 6 / scale);
        onChange(box.id, { x: sn.x, y: sn.y }, key);
        setGuides(sn.gx, sn.gy);
      },
      onEnd: clearGuides,
    });
  };

  const beginResize = (e: React.PointerEvent) => {
    const key = `resize-tb-${box.id}-${++gesture.current}`;
    const startPx = fontPx;
    startPointerDrag(e, {
      onMove: (dx, dy) => {
        // Bottom-right corner handle: dragging outward (down/right) grows the
        // text, inward (up/left) shrinks it. Averaging both axes lets the size
        // follow a natural diagonal drag instead of only vertical motion —
        // which is what made shrinking feel unresponsive on touch.
        const delta = (dx + dy) / 2;
        const size = Math.min(
          MAX_SIZE,
          Math.max(MIN_SIZE, (startPx + delta) / scale),
        );
        onChange(box.id, { style: { ...box.style, size } }, key);
      },
    });
  };

  return (
    <>
      <div
        className={`tb-wrap${selected ? " tb-wrap--selected" : ""}`}
        data-el-id={box.id}
        style={{ left: `${left}px`, top: `${top}px` }}
      >
        <div
          ref={ref}
          className="textbox"
        contentEditable={interactive && editing}
        suppressContentEditableWarning
        spellCheck={false}
        data-placeholder="Type…"
        role={interactive ? "textbox" : undefined}
        aria-multiline="true"
        aria-label="Text box"
        style={{
          fontSize: `${fontPx}px`,
          fontFamily: CSS_FONT[box.style.font],
          fontWeight: box.style.bold ? "bold" : "normal",
          fontStyle: box.style.italic ? "italic" : "normal",
          color: box.style.color,
          lineHeight: TEXTBOX_LINE_HEIGHT,
          pointerEvents: interactive ? "auto" : "none",
        }}
        onPointerDown={(e) => {
          if (!interactive) return;
          // Active mobile edit target: let the browser handle taps natively
          // (caret placement / word selection). See EditableFragment.
          if (onDone && e.pointerType === "touch") return;
          elementTap(e, {
            id: box.id,
            onTap: () => onSelect(box.id),
            onDoubleTap: onEdit ? () => onEdit(box.id) : undefined,
          });
        }}
        // Multi-line: `innerText` preserves the line breaks that Enter inserts
        // (`textContent` would flatten them). Enter falls through to the
        // browser's default line break.
        onInput={(ev) => onChangeText(box.id, ev.currentTarget.innerText)}
        />
        {selected && interactive && (
          <>
            <div
              className="tb-move"
              data-tip="Drag to move"
              aria-label="Drag to move text box"
              onPointerDown={beginMove}
            />
            <div
              className="handle tb-resize"
              data-tip="Drag to resize"
              aria-label="Drag to resize text box"
              onPointerDown={beginResize}
            />
          </>
        )}
      </div>
      {/* The done tick lives outside .tb-wrap so it positions against the page
          overlay (like the other overlay chrome), not the text box. */}
      {onDone && <EditDoneButton editableRef={ref} onDone={onDone} />}
    </>
  );
}

export const TextBoxItem = memo(TextBoxItemImpl);
