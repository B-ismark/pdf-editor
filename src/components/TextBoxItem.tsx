import { memo, useEffect, useRef } from "react";
import { CSS_FONT } from "../pdf/style";
import { startPointerDrag } from "../hooks/useDrag";
import type { TextBox } from "../pdf/types";

interface Props {
  box: TextBox;
  scale: number;
  pageHeight: number;
  selected: boolean;
  interactive: boolean;
  autoFocus: boolean;
  /** Bumps on undo/redo so the editable text is re-seeded from state. */
  revision: number;
  onSelect: (id: string) => void;
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
  selected,
  interactive,
  autoFocus,
  revision,
  onSelect,
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
    startPointerDrag(e, {
      onMove: (dx, dy) =>
        onChange(box.id, { x: s.x + dx / scale, y: s.y - dy / scale }, key),
    });
  };

  const beginResize = (e: React.PointerEvent) => {
    const key = `resize-tb-${box.id}-${++gesture.current}`;
    const startPx = fontPx;
    startPointerDrag(e, {
      onMove: (_dx, dy) => {
        const size = Math.min(
          MAX_SIZE,
          Math.max(MIN_SIZE, (startPx + dy) / scale),
        );
        onChange(box.id, { style: { ...box.style, size } }, key);
      },
    });
  };

  return (
    <div
      className={`tb-wrap${selected ? " tb-wrap--selected" : ""}`}
      style={{ left: `${left}px`, top: `${top}px` }}
    >
      <div
        ref={ref}
        className="textbox"
        contentEditable={interactive}
        suppressContentEditableWarning
        spellCheck={false}
        data-placeholder="Type…"
        style={{
          fontSize: `${fontPx}px`,
          fontFamily: CSS_FONT[box.style.font],
          fontWeight: box.style.bold ? "bold" : "normal",
          fontStyle: box.style.italic ? "italic" : "normal",
          color: box.style.color,
          lineHeight: 1,
          pointerEvents: interactive ? "auto" : "none",
        }}
        onPointerDown={() => interactive && onSelect(box.id)}
        onInput={(ev) => onChangeText(box.id, ev.currentTarget.textContent ?? "")}
        onKeyDown={(ev) => {
          if (ev.key === "Enter") ev.preventDefault();
        }}
      />
      {selected && interactive && (
        <>
          <div className="tb-move" title="Drag to move" onPointerDown={beginMove} />
          <div
            className="handle tb-resize"
            title="Drag to resize"
            onPointerDown={beginResize}
          />
        </>
      )}
    </div>
  );
}

export const TextBoxItem = memo(TextBoxItemImpl);
