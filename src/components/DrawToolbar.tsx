import { Icon } from "./Icon";
import { ColorField } from "./ColorField";
import type { AnnotationTool, DrawStyle } from "../pdf/types";

interface Props {
  drawTool: AnnotationTool;
  setDrawTool: (t: AnnotationTool) => void;
  drawStyle: DrawStyle;
  setDrawStyle: (s: DrawStyle) => void;
  /** Expanded (the full sub-tool strip) or collapsed to its handle. */
  open: boolean;
  setOpen: (open: boolean) => void;
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

/** True for the two sub-tools placed by a tap rather than a drag. */
export const isMarkTool = (t: AnnotationTool) => t === "check" || t === "cross";

/** What a mark tool's gesture is — the one thing about it nobody can guess. */
const MARK_HINT = "Tap a box · drag to size";

/** Contextual floating toolbar shown while the Draw tool is active.
 *
 * It collapses to a handle once a sub-tool is chosen. Expanded it is 60px of
 * chrome across the bottom of the page, directly above the tool dock, and it
 * has nothing left to say after you've picked what to draw with — so it gets
 * out of the way of the thing you picked it for, and the handle (which shows
 * the active sub-tool) brings it back. */
export function DrawToolbar({ drawTool, setDrawTool, drawStyle, setDrawStyle, open, setOpen }: Props) {
  const showWidth = drawTool !== "highlight" && drawTool !== "note";
  const isMark = isMarkTool(drawTool);
  const active = SUBTOOLS.find((t) => t.key === drawTool) ?? SUBTOOLS[0];

  if (!open) {
    return (
      <div className="drawbar drawbar--closed" id="drawbar">
        <button
          className="drawbar__handle"
          onClick={() => setOpen(true)}
          aria-label={`Draw options — ${active.label} selected`}
          aria-expanded={false}
          data-tip="Draw options"
        >
          <Icon name={active.icon} size={20} />
          <span className="drawbar__handlelabel label-medium">{active.label}</span>
          <Icon name="chevron_up" size={16} />
        </button>
        {/* The hint travels with the collapsed bar: a mark's gesture is the one
            thing the tool can't show you, and collapsing must not take it. */}
        {isMark && <span className="drawbar__hint label-medium">{MARK_HINT}</span>}
      </div>
    );
  }

  return (
    <div className="drawbar" id="drawbar" role="toolbar" aria-label="Draw options">
      <div className="drawbar__tools">
        {SUBTOOLS.map((t) => (
          <button
            key={t.key}
            className={`icon-btn${drawTool === t.key ? " icon-btn--on" : ""}`}
            // Picking a sub-tool is the end of this toolbar's job, so it stands
            // down — the page you're about to draw on is what you need to see.
            onClick={() => {
              setDrawTool(t.key);
              setOpen(false);
            }}
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
      {isMark && <span className="drawbar__hint label-medium">{MARK_HINT}</span>}
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
      <button
        className="icon-btn icon-btn--sm drawbar__collapse"
        onClick={() => setOpen(false)}
        aria-label="Hide draw options"
        aria-expanded
        data-tip="Hide draw options"
      >
        <Icon name="chevron_down" size={18} />
      </button>
    </div>
  );
}
