import { memo, useEffect, useRef } from "react";
import { CSS_FONT } from "../pdf/style";
import type { TextFragment, TextStyle } from "../pdf/types";

interface Props {
  fragment: TextFragment;
  scale: number;
  pageHeight: number;
  /** Current text (edited value or original). Applied on mount only. */
  value: string;
  /** Resolved display style (used when the fragment is styled/selected). */
  style: TextStyle;
  /** Whether the fragment differs from its original (text or style). */
  modified: boolean;
  selected: boolean;
  /** Only interactive (clickable/editable) in the Select tool. */
  interactive: boolean;
  /** Bumps on undo/redo so the editable text is re-seeded from state. */
  revision: number;
  onSelect: (id: string) => void;
  onChangeText: (id: string, text: string) => void;
}

/**
 * A contentEditable overlay positioned over its glyphs. Invisible until it is
 * styled, edited, or selected — at which point it paints an opaque box over
 * the original text so the on-screen preview matches the exported file.
 */
function EditableFragmentImpl({
  fragment,
  scale,
  pageHeight,
  value,
  style,
  modified,
  selected,
  interactive,
  revision,
  onSelect,
  onChangeText,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);

  // Seed on mount, and re-seed when an undo/redo changes the stored text.
  useEffect(() => {
    if (ref.current && ref.current.textContent !== value) {
      ref.current.textContent = value;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision]);

  const [, , c, d, e, f] = fragment.transform;
  const show = modified || selected;
  const sizeUnits = show ? style.size : Math.hypot(c, d);
  const fontPx = sizeUnits * scale;
  const left = e * scale;
  const top = (pageHeight - f) * scale - fontPx;

  const fontFamily = show ? CSS_FONT[style.font] : fragment.fontFamily;

  return (
    <div
      ref={ref}
      className={`fragment${show ? " fragment--shown" : ""}${selected ? " fragment--selected" : ""}`}
      contentEditable={interactive}
      suppressContentEditableWarning
      spellCheck={false}
      data-id={fragment.id}
      title={fragment.original}
      style={{
        left: `${left}px`,
        top: `${top}px`,
        fontSize: `${fontPx}px`,
        fontFamily,
        fontWeight: show && style.bold ? "bold" : "normal",
        fontStyle: show && style.italic ? "italic" : "normal",
        color: show ? style.color : "transparent",
        lineHeight: 1,
        pointerEvents: interactive ? "auto" : "none",
      }}
      onPointerDown={() => interactive && onSelect(fragment.id)}
      onInput={(ev) =>
        onChangeText(fragment.id, ev.currentTarget.textContent ?? "")
      }
      onKeyDown={(ev) => {
        if (ev.key === "Enter") ev.preventDefault();
      }}
    />
  );
}

export const EditableFragment = memo(EditableFragmentImpl);
