import { memo, useEffect, useRef } from "react";
import { CSS_FONT } from "../pdf/style";
import type { TextBox } from "../pdf/types";

interface Props {
  box: TextBox;
  scale: number;
  pageHeight: number;
  selected: boolean;
  interactive: boolean;
  autoFocus: boolean;
  onSelect: (id: string) => void;
  onChangeText: (id: string, text: string) => void;
}

/** A user-added text box, editable in place. */
function TextBoxItemImpl({
  box,
  scale,
  pageHeight,
  selected,
  interactive,
  autoFocus,
  onSelect,
  onChangeText,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (ref.current) {
      ref.current.textContent = box.text;
      if (autoFocus) {
        ref.current.focus();
        const range = document.createRange();
        range.selectNodeContents(ref.current);
        range.collapse(false);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fontPx = box.style.size * scale;
  const left = box.x * scale;
  const top = (pageHeight - box.y) * scale - fontPx;

  return (
    <div
      ref={ref}
      className={`textbox${selected ? " textbox--selected" : ""}`}
      contentEditable={interactive}
      suppressContentEditableWarning
      spellCheck={false}
      data-placeholder="Type…"
      style={{
        left: `${left}px`,
        top: `${top}px`,
        fontSize: `${fontPx}px`,
        fontFamily: CSS_FONT[box.style.font],
        fontWeight: box.style.bold ? "bold" : "normal",
        fontStyle: box.style.italic ? "italic" : "normal",
        color: box.style.color,
        lineHeight: 1,
        pointerEvents: interactive ? "auto" : "none",
      }}
      onMouseDown={() => interactive && onSelect(box.id)}
      onInput={(ev) => onChangeText(box.id, ev.currentTarget.textContent ?? "")}
      onKeyDown={(ev) => {
        if (ev.key === "Enter") ev.preventDefault();
      }}
    />
  );
}

export const TextBoxItem = memo(TextBoxItemImpl);
