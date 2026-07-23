import type { FontKey, Selection, TextStyle } from "../pdf/types";

interface Props {
  selection: Selection;
  /** Effective style of the selected text element (fragment or text box). */
  style: TextStyle | null;
  /** Colour of the selected redaction. */
  redactionColor: string | null;
  onChangeStyle: (patch: Partial<TextStyle>) => void;
  onChangeRedactionColor: (color: string) => void;
  onDelete: () => void;
}

const FONTS: { key: FontKey; label: string }[] = [
  { key: "sans", label: "Sans" },
  { key: "serif", label: "Serif" },
  { key: "mono", label: "Mono" },
];

/** Contextual controls for the currently selected element. */
export function PropertiesPanel({
  selection,
  style,
  redactionColor,
  onChangeStyle,
  onChangeRedactionColor,
  onDelete,
}: Props) {
  if (!selection) {
    return (
      <div className="props props--empty">
        Select text to restyle it, or use the tools above to add text and
        redactions.
      </div>
    );
  }

  if (selection.kind === "redaction") {
    return (
      <div className="props">
        <span className="props__label">Redaction</span>
        <label className="props__color">
          Fill
          <input
            type="color"
            value={redactionColor ?? "#000000"}
            onChange={(e) => onChangeRedactionColor(e.target.value)}
          />
        </label>
        <div className="props__spacer" />
        <button className="btn btn--danger" onClick={onDelete}>
          Delete
        </button>
      </div>
    );
  }

  if (!style) return null;

  return (
    <div className="props">
      <span className="props__label">
        {selection.kind === "textbox" ? "Text box" : "Text"}
      </span>

      <div className="props__group">
        {FONTS.map((f) => (
          <button
            key={f.key}
            className={`chip${style.font === f.key ? " chip--on" : ""}`}
            onClick={() => onChangeStyle({ font: f.key })}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="props__group">
        <button
          className={`chip chip--icon${style.bold ? " chip--on" : ""}`}
          style={{ fontWeight: 700 }}
          onClick={() => onChangeStyle({ bold: !style.bold })}
        >
          B
        </button>
        <button
          className={`chip chip--icon${style.italic ? " chip--on" : ""}`}
          style={{ fontStyle: "italic" }}
          onClick={() => onChangeStyle({ italic: !style.italic })}
        >
          I
        </button>
      </div>

      <label className="props__size">
        Size
        <input
          type="number"
          min={4}
          max={200}
          value={Math.round(style.size)}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v) && v > 0) onChangeStyle({ size: v });
          }}
        />
      </label>

      <label className="props__color">
        Colour
        <input
          type="color"
          value={style.color}
          onChange={(e) => onChangeStyle({ color: e.target.value })}
        />
      </label>

      {selection.kind === "textbox" && (
        <>
          <div className="props__spacer" />
          <button className="btn btn--danger" onClick={onDelete}>
            Delete
          </button>
        </>
      )}
    </div>
  );
}
