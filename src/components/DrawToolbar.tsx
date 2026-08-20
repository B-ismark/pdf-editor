import { Icon } from "./Icon";
import { ColorField } from "./ColorField";
import type { AnnotationTool, DrawStyle } from "../pdf/types";

interface Props {
  drawTool: AnnotationTool;
  setDrawTool: (t: AnnotationTool) => void;
  drawStyle: DrawStyle;
  setDrawStyle: (s: DrawStyle) => void;
}

const SUBTOOLS: { key: AnnotationTool; icon: string; label: string }[] = [
  { key: "highlight", icon: "highlighter", label: "Highlight" },
  { key: "pen", icon: "draw_tool", label: "Pen" },
  { key: "rect", icon: "rectangle", label: "Rectangle" },
  { key: "line", icon: "line_tool", label: "Line" },
  { key: "arrow", icon: "arrow_tool", label: "Arrow" },
  { key: "check", icon: "check_tool", label: "Tick" },
  { key: "cross", icon: "cross_tool", label: "Cross" },
  { key: "note", icon: "sticky_note", label: "Note" },
];

/** Contextual floating toolbar shown while the Draw tool is active. */
export function DrawToolbar({ drawTool, setDrawTool, drawStyle, setDrawStyle }: Props) {
  const showWidth = drawTool !== "highlight" && drawTool !== "note";
  const isMark = drawTool === "check" || drawTool === "cross";
  return (
    <div className="drawbar" id="drawbar" role="toolbar" aria-label="Draw options">
      <div className="drawbar__tools">
        {SUBTOOLS.map((t) => (
          <button
            key={t.key}
            className={`icon-btn${drawTool === t.key ? " icon-btn--on" : ""}`}
            onClick={() => setDrawTool(t.key)}
            data-tip={t.label}
            aria-label={t.label}
            aria-pressed={drawTool === t.key}
          >
            <Icon name={t.icon} size={20} />
          </button>
        ))}
      </div>
      <span className="drawbar__sep" />
      <ColorField small value={drawStyle.color} onChange={(c) => setDrawStyle({ ...drawStyle, color: c })} />
      {/* Marks are placed by tapping, everything else by dragging, and nothing
          on screen said so — so the one tool people reach for to fill a form
          was the one whose gesture they had to guess. */}
      {isMark && <span className="drawbar__hint label-medium">Tap a box · drag to size</span>}
      {showWidth && (
        <label className="drawbar__width" data-tip="Stroke width">
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
