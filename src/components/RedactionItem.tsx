import { useRef } from "react";
import { startElementGesture, startPointerDrag } from "../hooks/useDrag";
import type { Redaction } from "../pdf/types";

interface Props {
  redaction: Redaction;
  scale: number;
  pageHeight: number;
  selected: boolean;
  interactive: boolean;
  onSelect: (id: string) => void;
  onChange: (id: string, patch: Partial<Redaction>, key: string) => void;
}

type Edge = "l" | "t" | "r" | "b";
const HANDLES: { name: string; edges: Edge[]; cursor: string }[] = [
  { name: "nw", edges: ["l", "t"], cursor: "nwse-resize" },
  { name: "n", edges: ["t"], cursor: "ns-resize" },
  { name: "ne", edges: ["r", "t"], cursor: "nesw-resize" },
  { name: "e", edges: ["r"], cursor: "ew-resize" },
  { name: "se", edges: ["r", "b"], cursor: "nwse-resize" },
  { name: "s", edges: ["b"], cursor: "ns-resize" },
  { name: "sw", edges: ["l", "b"], cursor: "nesw-resize" },
  { name: "w", edges: ["l"], cursor: "ew-resize" },
];

const HANDLE_POS: Record<string, { left: string; top: string }> = {
  nw: { left: "0%", top: "0%" },
  n: { left: "50%", top: "0%" },
  ne: { left: "100%", top: "0%" },
  e: { left: "100%", top: "50%" },
  se: { left: "100%", top: "100%" },
  s: { left: "50%", top: "100%" },
  sw: { left: "0%", top: "100%" },
  w: { left: "0%", top: "50%" },
};

const MIN = 4; // minimum CSS size while resizing

/** A redaction rectangle: draggable to move, with 8 resize handles. */
export function RedactionItem({
  redaction,
  scale,
  pageHeight,
  selected,
  interactive,
  onSelect,
  onChange,
}: Props) {
  const gesture = useRef(0);
  const H = pageHeight;

  const left = redaction.x * scale;
  const width = redaction.width * scale;
  const height = redaction.height * scale;
  const top = (H - (redaction.y + redaction.height)) * scale;

  const cssToPdf = (l: number, t: number, w: number, h: number) => ({
    x: l / scale,
    y: H - t / scale - h / scale,
    width: w / scale,
    height: h / scale,
  });

  const beginMove = (e: React.PointerEvent) => {
    if (!interactive) return;
    const key = `move-rd-${redaction.id}-${++gesture.current}`;
    const s = { left, top };
    startElementGesture(e, {
      selected,
      onSelect: () => onSelect(redaction.id),
      onMove: (dx, dy) =>
        onChange(redaction.id, cssToPdf(s.left + dx, s.top + dy, width, height), key),
    });
  };

  const beginResize = (e: React.PointerEvent, edges: Edge[]) => {
    const key = `resize-rd-${redaction.id}-${++gesture.current}`;
    const s = { l: left, t: top, r: left + width, b: top + height };
    startPointerDrag(e, {
      onMove: (dx, dy) => {
        let { l, t, r, b } = s;
        if (edges.includes("l")) l = Math.min(l + dx, r - MIN);
        if (edges.includes("r")) r = Math.max(r + dx, l + MIN);
        if (edges.includes("t")) t = Math.min(t + dy, b - MIN);
        if (edges.includes("b")) b = Math.max(b + dy, t + MIN);
        onChange(redaction.id, cssToPdf(l, t, r - l, b - t), key);
      },
    });
  };

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
        cursor: interactive ? "move" : "default",
      }}
      onPointerDown={beginMove}
    >
      {selected &&
        interactive &&
        HANDLES.map((h) => (
          <div
            key={h.name}
            className="handle"
            style={{
              left: HANDLE_POS[h.name].left,
              top: HANDLE_POS[h.name].top,
              cursor: h.cursor,
            }}
            onPointerDown={(e) => beginResize(e, h.edges)}
          />
        ))}
    </div>
  );
}
