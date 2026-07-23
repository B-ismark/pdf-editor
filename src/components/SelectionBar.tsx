import { useEffect, useState } from "react";
import { Icon } from "./Icon";
import type { Selection } from "../pdf/types";

interface Props {
  selection: NonNullable<Selection>;
  /** Selected annotation kind, when the selection is an annotation. */
  annotationKind?: string;
  onEdit: () => void;
  onStyle: () => void;
  onDelete: () => void;
  onClose: () => void;
}

const TITLES: Record<string, string> = {
  fragment: "Text",
  textbox: "Text box",
  redaction: "Redaction",
  annotation: "Annotation",
  link: "Link",
};

/**
 * Compact contextual toolbar shown on phones when an element is selected —
 * instead of auto-opening the full properties sheet (which would cover the
 * element). Pinned at the top so the object stays visible and directly
 * draggable/resizable via its on-canvas handles. Styling is opened explicitly.
 */
export function SelectionBar({ selection, annotationKind, onEdit, onStyle, onDelete, onClose }: Props) {
  // Ignore input for a moment after appearing, so the "ghost click" the browser
  // synthesizes after the selecting tap can't land on a button here (the bar
  // renders right where you may have tapped). Re-armed per selection via `key`.
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setArmed(true), 350);
    return () => window.clearTimeout(t);
  }, []);

  const kind = selection.kind;
  const isNote = kind === "annotation" && annotationKind === "note";
  const editable = kind === "fragment" || kind === "textbox" || isNote;
  const styleLabel = kind === "redaction" ? "Colour" : kind === "link" ? "URL" : "Style";
  const title =
    kind === "annotation" ? (isNote ? "Note" : "Annotation") : TITLES[kind] ?? "Selected";

  return (
    <div
      className="selbar"
      role="toolbar"
      aria-label={`${title} actions`}
      style={{ pointerEvents: armed ? "auto" : "none" }}
    >
      <span className="selbar__title label-large">{title}</span>
      <span className="selbar__sep" />
      {editable && (
        <button className="selbar__btn" onClick={onEdit}>
          <Icon name="text_fields" size={18} /> Edit
        </button>
      )}
      <button className="selbar__btn" onClick={onStyle}>
        <Icon name="draw" size={18} /> {styleLabel}
      </button>
      <button className="selbar__btn selbar__btn--danger" onClick={onDelete} aria-label="Delete">
        <Icon name="delete" size={18} />
      </button>
      <button className="selbar__btn" onClick={onClose} aria-label="Deselect">
        <Icon name="close" size={18} />
      </button>
    </div>
  );
}
