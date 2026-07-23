import { memo, useEffect, useRef } from "react";
import { CSS_FONT } from "../pdf/style";
import { elementTap, startPointerDrag } from "../hooks/useDrag";
import { clearGuides, setGuides, snapBox } from "../hooks/useSnap";
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
  /** Bumps on undo/redo so the editable text is re-seeded from state. */
  revision: number;
  onSelect: (id: string) => void;
  /** Double-tap (touch) to enter edit mode on mobile. */
  onEdit?: (id: string) => void;
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
  revision,
  onSelect,
  onEdit,
  onChangeText,
  onChange,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const gesture = useRef(0);
  const H = pageHeight;

  // Seed on mount, and re-seed when an undo/redo changes the stored text.
  useEffect(() => {
    if (!ref.current) return;
    if (ref.current.textContent !== box.text) ref.current.textContent = box.text;
    if (autoFocus) {
      ref.current.focus();
      const range = document.createRange();
      range.selectNodeContents(ref.current);
      range.collapse(false);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      ref.current.scrollIntoView({ block: "center", inline: "nearest" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision]);

  const fontPx = box.style.size * scale;
  const left = box.x * scale;
  const top = (H - box.y) * scale - fontPx;

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
        aria-multiline="false"
        aria-label="Text box"
        style={{
          fontSize: `${fontPx}px`,
          fontFamily: CSS_FONT[box.style.font],
          fontWeight: box.style.bold ? "bold" : "normal",
          fontStyle: box.style.italic ? "italic" : "normal",
          color: box.style.color,
          lineHeight: 1,
          pointerEvents: interactive ? "auto" : "none",
        }}
        onPointerDown={(e) =>
          interactive &&
          elementTap(e, {
            onTap: () => onSelect(box.id),
            onDoubleTap: onEdit ? () => onEdit(box.id) : undefined,
          })
        }
        onInput={(ev) => onChangeText(box.id, ev.currentTarget.textContent ?? "")}
        onKeyDown={(ev) => {
          if (ev.key === "Enter") ev.preventDefault();
        }}
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
  );
}

export const TextBoxItem = memo(TextBoxItemImpl);
