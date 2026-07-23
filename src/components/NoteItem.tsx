import { memo, useEffect, useRef } from "react";
import { elementTap } from "../hooks/useDrag";

interface Props {
  id: string;
  x: number;
  y: number;
  text: string;
  color: string;
  scale: number;
  pageHeight: number;
  selected: boolean;
  interactive: boolean;
  editing: boolean;
  autoFocus: boolean;
  revision: number;
  onSelect: (id: string) => void;
  /** Double-tap (touch) to enter edit mode on mobile. */
  onEdit?: (id: string) => void;
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
  y,
  text,
  color,
  scale,
  pageHeight,
  selected,
  interactive,
  editing,
  autoFocus,
  revision,
  onSelect,
  onEdit,
  onChangeText,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    if (ref.current.textContent !== text) ref.current.textContent = text;
    if (autoFocus) {
      ref.current.focus();
      const r = document.createRange();
      r.selectNodeContents(ref.current);
      r.collapse(false);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(r);
      ref.current.scrollIntoView({ block: "center", inline: "nearest" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision]);

  return (
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
        background: color,
        color: readableText(color),
        pointerEvents: interactive ? "auto" : "none",
      }}
      onPointerDown={(e) =>
        interactive &&
        elementTap(e, {
          onTap: () => onSelect(id),
          onDoubleTap: onEdit ? () => onEdit(id) : undefined,
        })
      }
      onInput={(e) => onChangeText(id, e.currentTarget.textContent ?? "")}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.preventDefault();
      }}
    />
  );
}

export const NoteItem = memo(NoteItemImpl);
