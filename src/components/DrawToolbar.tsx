import { Icon } from "./Icon";
import type { AnnotationTool, DrawStyle } from "../pdf/types";

interface Props {
  drawTool: AnnotationTool;
  setDrawTool: (t: AnnotationTool) => void;
  drawStyle: DrawStyle;
  setDrawStyle: (s: DrawStyle) => void;
}

const SUBTOOLS: { key: AnnotationTool; icon: string; label: string }[] = [
  { key: "highlight", icon: "highlighter", label: "Highlight" },
  { key: "pen", icon: "draw", label: "Pen" },
  { key: "rect", icon: "rectangle", label: "Rectangle" },
  { key: "line", icon: "line_tool", label: "Line" },
  { key: "arrow", icon: "arrow_tool", label: "Arrow" },
  { key: "note", icon: "sticky_note", label: "Note" },
];

/** Contextual floating toolbar shown while the Draw tool is active. */
export function DrawToolbar({ drawTool, setDrawTool, drawStyle, setDrawStyle }: Props) {
  const showWidth = drawTool !== "highlight" && drawTool !== "note";
  return (
    <div className="drawbar" role="toolbar" aria-label="Draw options">
      <div className="drawbar__tools">
        {SUBTOOLS.map((t) => (
          <button
            key={t.key}
            className={`icon-btn${drawTool === t.key ? " icon-btn--on" : ""}`}
            onClick={() => setDrawTool(t.key)}
            title={t.label}
            aria-label={t.label}
            aria-pressed={drawTool === t.key}
          >
            <Icon name={t.icon} size={22} />
          </button>
        ))}
      </div>
      <span className="drawbar__sep" />
      <label className="swatch swatch--sm" title="Colour">
        <input
          type="color"
          value={drawStyle.color}
          onChange={(e) => setDrawStyle({ ...drawStyle, color: e.target.value })}
        />
        <span style={{ background: drawStyle.color }} />
      </label>
      {showWidth && (
        <label className="drawbar__width" title="Stroke width">
          <input
            type="range"
            className="slider slider--sm"
            min={1}
            max={12}
            value={drawStyle.width}
            onChange={(e) => setDrawStyle({ ...drawStyle, width: Number(e.target.value) })}
          />
        </label>
      )}
    </div>
  );
}
