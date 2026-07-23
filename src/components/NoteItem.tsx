import { memo, useEffect, useRef } from "react";

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
  autoFocus: boolean;
  revision: number;
  onSelect: (id: string) => void;
  onChangeText: (id: string, text: string) => void;
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
  autoFocus,
  revision,
  onSelect,
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
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision]);

  return (
    <div
      ref={ref}
      className={`note${selected ? " note--sel" : ""}`}
      contentEditable={interactive}
      suppressContentEditableWarning
      spellCheck={false}
      data-placeholder="Note…"
      style={{
        left: `${x * scale}px`,
        top: `${(pageHeight - y) * scale}px`,
        background: color,
        pointerEvents: interactive ? "auto" : "none",
      }}
      onPointerDown={() => interactive && onSelect(id)}
      onInput={(e) => onChangeText(id, e.currentTarget.textContent ?? "")}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.preventDefault();
      }}
    />
  );
}

export const NoteItem = memo(NoteItemImpl);
