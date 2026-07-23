import { memo, useEffect, useRef } from "react";
import { CSS_FONT } from "../pdf/style";
import { elementTap } from "../hooks/useDrag";
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
  /** Whether typing is allowed now (always on desktop; only in edit mode on
   * mobile, so a select-tap doesn't pop the keyboard). */
  editing: boolean;
  /** Focus + place caret + scroll into view (e.g. mobile "Edit" pressed). */
  autoFocus: boolean;
  /** Bumps on undo/redo so the editable text is re-seeded from state. */
  revision: number;
  onSelect: (id: string) => void;
  /** Double-tap (touch) to enter edit mode on mobile. */
  onEdit?: (id: string) => void;
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
  editing,
  autoFocus,
  revision,
  onSelect,
  onEdit,
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

  // Enter edit: focus, put the caret at the end, and scroll into view above
  // the keyboard.
  useEffect(() => {
    if (!autoFocus || !ref.current) return;
    const el = ref.current;
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    el.scrollIntoView({ block: "center", inline: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoFocus, revision]);

  const [, , c, d, e, f] = fragment.transform;
  const show = modified || selected;
  const sizeUnits = show ? style.size : Math.hypot(c, d);
  const fontPx = sizeUnits * scale;
  const left = e * scale;
  const top = (pageHeight - f) * scale - fontPx;

  const fontFamily = show ? CSS_FONT[style.font] : fragment.fontFamily;

  // Cover sized to the ORIGINAL glyph box so the rasterised original text is
  // fully hidden (no peeking / duplication), independent of the new text.
  const origFontPx = Math.hypot(c, d) * scale;
  const cover = {
    left: e * scale - 1.5,
    top: (pageHeight - f) * scale - origFontPx * 1.02,
    width: fragment.width * scale + 3,
    height: origFontPx * 1.35,
  };

  return (
    <>
      {show && (
        <div
          className={`fragment__cover${selected ? " fragment__cover--sel" : ""}`}
          aria-hidden="true"
          style={{
            left: `${cover.left}px`,
            top: `${cover.top}px`,
            width: `${cover.width}px`,
            height: `${cover.height}px`,
          }}
        />
      )}
      <div
        ref={ref}
        className="fragment"
        contentEditable={interactive && editing}
        suppressContentEditableWarning
        spellCheck={false}
        data-id={fragment.id}
        data-el-id={fragment.id}
        title={fragment.original}
        role={interactive ? "textbox" : undefined}
        aria-multiline="false"
        aria-label={interactive ? `Editable text: ${fragment.original}` : undefined}
        style={{
          left: `${left}px`,
          top: `${top}px`,
          fontSize: `${fontPx}px`,
          fontFamily,
          fontWeight: show && style.bold ? "bold" : "normal",
          fontStyle: show && style.italic ? "italic" : "normal",
          color: show ? style.color : "transparent",
          background: show ? "#fff" : undefined,
          lineHeight: 1,
          pointerEvents: interactive ? "auto" : "none",
        }}
        onPointerDown={(e) =>
          interactive &&
          elementTap(e, {
            onTap: () => onSelect(fragment.id),
            onDoubleTap: onEdit ? () => onEdit(fragment.id) : undefined,
          })
        }
        onInput={(ev) => onChangeText(fragment.id, ev.currentTarget.textContent ?? "")}
        onKeyDown={(ev) => {
          if (ev.key === "Enter") ev.preventDefault();
        }}
      />
    </>
  );
}

export const EditableFragment = memo(EditableFragmentImpl);
