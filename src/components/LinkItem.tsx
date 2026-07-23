import { useRef } from "react";
import { startElementGesture, startPointerDrag } from "../hooks/useDrag";
import { clearGuides, setGuides, snapBox } from "../hooks/useSnap";
import { Icon } from "./Icon";
import type { LinkAnnot } from "../pdf/types";

interface Props {
  link: LinkAnnot;
  scale: number;
  pageHeight: number;
  pageWidth: number;
  selected: boolean;
  interactive: boolean;
  onSelect: (id: string) => void;
  onChange: (id: string, patch: Partial<LinkAnnot>, key: string) => void;
}

type Edge = "l" | "t" | "r" | "b";
const HANDLES: { name: string; edges: Edge[]; cursor: string }[] = [
  { name: "nw", edges: ["l", "t"], cursor: "nwse-resize" },
  { name: "ne", edges: ["r", "t"], cursor: "nesw-resize" },
  { name: "se", edges: ["r", "b"], cursor: "nwse-resize" },
  { name: "sw", edges: ["l", "b"], cursor: "nesw-resize" },
];
const POS: Record<string, { left: string; top: string }> = {
  nw: { left: "0%", top: "0%" },
  ne: { left: "100%", top: "0%" },
  se: { left: "100%", top: "100%" },
  sw: { left: "0%", top: "100%" },
};
const MIN = 8;

/** A clickable-link region: a translucent box, draggable and resizable, whose
 * URL is edited in the properties panel. */
export function LinkItem({ link, scale, pageHeight, pageWidth, selected, interactive, onSelect, onChange }: Props) {
  const gesture = useRef(0);
  const H = pageHeight;
  const left = link.x * scale;
  const width = link.width * scale;
  const height = link.height * scale;
  const top = (H - (link.y + link.height)) * scale;

  const cssToPdf = (l: number, t: number, w: number, h: number) => ({
    x: l / scale,
    y: H - t / scale - h / scale,
    width: w / scale,
    height: h / scale,
  });

  const beginMove = (e: React.PointerEvent) => {
    if (!interactive) return;
    const key = `move-ln-${link.id}-${++gesture.current}`;
    const s = { left, top };
    startElementGesture(e, {
      selected,
      onSelect: () => onSelect(link.id),
      onMove: (dx, dy) => {
        const g = cssToPdf(s.left + dx, s.top + dy, width, height);
        const sn = snapBox(g.x, g.y, g.width, g.height, pageWidth, H, 6 / scale);
        onChange(link.id, { x: sn.x, y: sn.y, width: g.width, height: g.height }, key);
        setGuides(sn.gx, sn.gy);
      },
      onEnd: clearGuides,
    });
  };

  const beginResize = (e: React.PointerEvent, edges: Edge[]) => {
    const key = `resize-ln-${link.id}-${++gesture.current}`;
    const s = { l: left, t: top, r: left + width, b: top + height };
    startPointerDrag(e, {
      onMove: (dx, dy) => {
        let { l, t, r, b } = s;
        if (edges.includes("l")) l = Math.min(l + dx, r - MIN);
        if (edges.includes("r")) r = Math.max(r + dx, l + MIN);
        if (edges.includes("t")) t = Math.min(t + dy, b - MIN);
        if (edges.includes("b")) b = Math.max(b + dy, t + MIN);
        onChange(link.id, cssToPdf(l, t, r - l, b - t), key);
      },
    });
  };

  return (
    <div
      className={`linkbox${selected ? " linkbox--selected" : ""}${link.url ? "" : " linkbox--empty"}`}
      style={{
        left: `${left}px`,
        top: `${top}px`,
        width: `${width}px`,
        height: `${height}px`,
        pointerEvents: interactive ? "auto" : "none",
        cursor: interactive ? "move" : "default",
      }}
      onPointerDown={beginMove}
      title={link.url || "No URL yet"}
    >
      <span className="linkbox__chip">
        <Icon name="link" size={12} />
      </span>
      {selected &&
        interactive &&
        HANDLES.map((h) => (
          <div
            key={h.name}
            className="handle"
            style={{ left: POS[h.name].left, top: POS[h.name].top, cursor: h.cursor }}
            onPointerDown={(e) => beginResize(e, h.edges)}
          />
        ))}
    </div>
  );
}
