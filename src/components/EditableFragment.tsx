import { memo, useEffect, useRef } from "react";
import { CSS_FONT } from "../pdf/style";
import { elementTap, lastEditPoint } from "../hooks/useDrag";
import { focusEditable, placeCaretEnd } from "../caret";
import { baselineOffset, fontShorthand } from "../textBaseline";
import { EditDoneButton } from "./EditDoneButton";
import type { FragmentFont, TextFragment, TextStyle } from "../pdf/types";

/** A fragment is always one line, so its box is exactly its font size tall.
 * Shared with the baseline probe: the measured offset is only correct for the
 * line-height the element actually gets. */
const FRAGMENT_LINE_HEIGHT = 1;

interface Props {
  fragment: TextFragment;
  scale: number;
  pageHeight: number;
  /** Current text (edited value or original). Applied on mount only. */
  value: string;
  /** Resolved display style (used when the fragment is styled/selected). */
  style: TextStyle;
  /** The document's own font, when the edit keeps it: rendering with this is
   * what makes replaced text match the page instead of approximating it. */
  face: FragmentFont | null;
  /** The flat colour sampled from behind these glyphs, when there is one. The
   * cover is painted in it so an edit inside a coloured pill, cell, or banner
   * doesn't punch a white hole through the artwork. */
  backdrop?: string;
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
  onSelect: (id: string) => void;
  /** Double-tap (touch) to enter edit mode on mobile. */
  onEdit?: (id: string) => void;
  /** When set (mobile edit mode), a "done" checkmark is shown; commits the edit. */
  onDone?: () => void;
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
  face,
  backdrop,
  modified,
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

  // Keep the uncontrolled contentEditable in sync with external state changes
  // (undo/redo, style reset, OCR, a freshly opened document). Writing only
  // when the DOM's text actually differs from `value` means this is a no-op
  // while the user types — React's re-render already matches what they typed,
  // so the caret never jumps — but it re-seeds on any change that didn't come
  // from typing here.
  useEffect(() => {
    const el = ref.current;
    if (!el || el.textContent === value) return;
    el.textContent = value;
    if (document.activeElement === el) placeCaretEnd(el);
  }, [value]);

  // Enter edit: focus and drop the caret where the entering tap landed (or at
  // the end), then scroll into view above the keyboard.
  useEffect(() => {
    if (!autoFocus || !ref.current) return;
    focusEditable(ref.current, lastEditPoint);
  }, [autoFocus]);

  const [, , c, d, e, f] = fragment.transform;
  const show = modified || selected;
  const sizeUnits = show ? style.size : Math.hypot(c, d);
  const fontPx = sizeUnits * scale;
  const left = e * scale;

  // With the document's own face, take its weight and slant too: the face
  // already carries them, and asking for bold on top of a bold face makes the
  // browser synthesise a second helping of it.
  const fontFamily = face ? face.css : show ? CSS_FONT[style.font] : fragment.fontFamily;
  const fontWeight = face ? face.weight : show && style.bold ? "bold" : "normal";
  const fontStyle = face ? face.slant : show && style.italic ? "italic" : "normal";

  // `f` is the fragment's baseline, and the exporter draws the replacement on
  // it exactly — so the overlay has to land on it exactly too, or the preview
  // stops matching the file. Measured for this very font, because the offset
  // from the box's top edge to its baseline depends on the face's metrics (see
  // `textBaseline.ts`): a flat `- fontPx` sat every edit 0.15–0.24em too high.
  const shorthand = fontShorthand(fontStyle, fontWeight, fontPx, fontFamily);
  const top = (pageHeight - f) * scale - baselineOffset(shorthand, FRAGMENT_LINE_HEIGHT, fontPx);

  // Cover sized to the ORIGINAL glyph box so the rasterised original text is
  // fully hidden (no peeking / duplication), independent of the new text.
  // White only until the page has been sampled (or when no flat colour fits the
  // area): that's where this started, and it's right on white paper.
  const coverColor = backdrop ?? "#ffffff";
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
            background: coverColor,
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
          fontWeight,
          fontStyle,
          color: show ? style.color : "transparent",
          background: show ? coverColor : undefined,
          lineHeight: FRAGMENT_LINE_HEIGHT,
          pointerEvents: interactive ? "auto" : "none",
        }}
        onPointerDown={(e) => {
          if (!interactive) return;
          // While this element is the active mobile edit target, let the
          // browser handle the touch natively — tap positions the caret,
          // double-tap selects a word — instead of our select/enter-edit tap
          // logic. (`onDone` is only set for that element on a phone.)
          if (onDone && e.pointerType === "touch") return;
          elementTap(e, {
            id: fragment.id,
            onTap: () => onSelect(fragment.id),
            onDoubleTap: onEdit ? () => onEdit(fragment.id) : undefined,
          });
        }}
        onInput={(ev) => onChangeText(fragment.id, ev.currentTarget.textContent ?? "")}
        onKeyDown={(ev) => {
          if (ev.key === "Enter") ev.preventDefault();
        }}
      />
      {onDone && <EditDoneButton editableRef={ref} onDone={onDone} />}
    </>
  );
}

export const EditableFragment = memo(EditableFragmentImpl);
