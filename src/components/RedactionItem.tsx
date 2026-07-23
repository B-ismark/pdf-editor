import type { Redaction } from "../pdf/types";

interface Props {
  redaction: Redaction;
  scale: number;
  pageHeight: number;
  selected: boolean;
  interactive: boolean;
  onSelect: (id: string) => void;
}

/** A redaction rectangle drawn over the page. */
export function RedactionItem({
  redaction,
  scale,
  pageHeight,
  selected,
  interactive,
  onSelect,
}: Props) {
  const left = redaction.x * scale;
  const width = redaction.width * scale;
  const height = redaction.height * scale;
  // Convert PDF bottom-left origin to CSS top-left.
  const top = (pageHeight - (redaction.y + redaction.height)) * scale;

  return (
    <div
      className={`redaction${selected ? " redaction--selected" : ""}`}
      style={{
        left: `${left}px`,
        top: `${top}px`,
        width: `${width}px`,
        height: `${height}px`,
        background: redaction.color,
        pointerEvents: interactive ? "auto" : "none",
      }}
      onMouseDown={(ev) => {
        if (!interactive) return;
        ev.stopPropagation();
        onSelect(redaction.id);
      }}
    />
  );
}
