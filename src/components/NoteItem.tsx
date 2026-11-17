import { memo, useEffect, useRef } from "react";
import { elementTap, lastEditPoint } from "../hooks/useDrag";
import { focusEditable, placeCaretEnd } from "../caret";
import { EditDoneButton } from "./EditDoneButton";

interface Props {
  id: string;
  x: number;
  /** Clockwise degrees about the top-left anchor. */
  rotation?: number;
  y: number;
  text: string;
  color: string;
  scale: number;
  pageHeight: number;
  selected: boolean;
  interactive: boolean;
  editing: boolean;
  autoFocus: boolean;
  onSelect: (id: string) => void;
  /** Double-tap (touch) to enter edit mode on mobile. */
  onEdit?: (id: string) => void;
  /** When set (mobile edit mode), a "done" checkmark is shown; commits the edit. */
  onDone?: () => void;
  onChangeText: (id: string, text: string) => void;
}

/** Pick black or white text for legibility on a given note colour, from the
 * sRGB relative luminance of the background (audit #18). */
function readableText(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return "#1a1a1a";
  const n = parseInt(m[1], 16);
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const L =
    0.2126 * lin((n >> 16) & 255) +
    0.7152 * lin((n >> 8) & 255) +
    0.0722 * lin(n & 255);
  return L > 0.42 ? "#111111" : "#ffffff";
}

/** A sticky note: a small coloured, editable label pinned to the page. */
function NoteItemImpl({
  id,
  x,
  rotation,
  y,
  text,
  color,
  scale,
  pageHeight,
  selected,
  interactive,
  editing,
  autoFocus,
  onSelect,
  onEdit,
  onDone,
  onChangeText,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);

  // Re-seed the uncontrolled contentEditable from state only when it differs
  // (no-op while typing, re-seed on undo/redo or other external change).
  useEffect(() => {
    const el = ref.current;
    if (!el || el.textContent === text) return;
    el.textContent = text;
    if (document.activeElement === el) placeCaretEnd(el);
  }, [text]);

  useEffect(() => {
    if (!autoFocus || !ref.current) return;
    focusEditable(ref.current, lastEditPoint);
  }, [autoFocus]);

  return (
    <>
      <div
        ref={ref}
        className={`note${selected ? " note--sel" : ""}`}
        data-el-id={id}
        contentEditable={interactive && editing}
        suppressContentEditableWarning
        spellCheck={false}
        data-placeholder="Note…"
        role={interactive ? "textbox" : undefined}
        aria-multiline="false"
        aria-label="Sticky note"
        style={{
          left: `${x * scale}px`,
          top: `${(pageHeight - y) * scale}px`,
          ...(rotation ? { transform: `rotate(${rotation}deg)`, transformOrigin: "0 0" } : null),
          background: color,
          color: readableText(color),
          pointerEvents: interactive ? "auto" : "none",
        }}
        onPointerDown={(e) => {
          if (!interactive) return;
          // Active mobile edit target: let the browser handle taps natively
          // (caret placement / word selection). See EditableFragment.
          if (onDone && e.pointerType === "touch") return;
          elementTap(e, {
            id,
            onTap: () => onSelect(id),
            onDoubleTap: onEdit ? () => onEdit(id) : undefined,
          });
        }}
        onInput={(e) => onChangeText(id, e.currentTarget.textContent ?? "")}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.preventDefault();
        }}
      />
      {onDone && <EditDoneButton editableRef={ref} onDone={onDone} />}
    </>
  );
}

export const NoteItem = memo(NoteItemImpl);
