import { useRef } from "react";
import { startPointerDrag } from "../hooks/useDrag";

/** Screen-space box: centre, size (CSS px), and clockwise rotation (degrees). */
export interface Geom {
  cx: number;
  cy: number;
  w: number;
  h: number;
  rot: number;
}

type HKey = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

/** Which local axes a handle grows: [x, y] in {-1,0,1}. Screen y is down, so
 * the north edges are negative-y. */
const DIR: Record<HKey, [number, number]> = {
  nw: [-1, -1],
  n: [0, -1],
  ne: [1, -1],
  e: [1, 0],
  se: [1, 1],
  s: [0, 1],
  sw: [-1, 1],
  w: [-1, 0],
};

const POS: Record<HKey, { left: string; top: string }> = {
  nw: { left: "0%", top: "0%" },
  n: { left: "50%", top: "0%" },
  ne: { left: "100%", top: "0%" },
  e: { left: "100%", top: "50%" },
  se: { left: "100%", top: "100%" },
  s: { left: "50%", top: "100%" },
  sw: { left: "0%", top: "100%" },
  w: { left: "0%", top: "50%" },
};

const CURSOR: Record<HKey, string> = {
  nw: "nwse-resize",
  n: "ns-resize",
  ne: "nesw-resize",
  e: "ew-resize",
  se: "nwse-resize",
  s: "ns-resize",
  sw: "nesw-resize",
  w: "ew-resize",
};

const CORNERS: HKey[] = ["nw", "ne", "se", "sw"];
const ROT_SNAP = 15; // degrees
const ROT_SNAP_TOL = 4; // snap when within this many degrees of a multiple

interface Props {
  /** Current box geometry, in the overlay's CSS-pixel frame. */
  geom: Geom;
  /** The rotated element the handles belong to; used to find the rotation
   * pivot (its bounding-box centre equals the true centre). */
  containerRef: React.RefObject<HTMLElement | null>;
  /** Smallest allowed edge, CSS px. */
  minSize?: number;
  /** If set (height / width), corner drags keep this aspect ratio. */
  aspect?: number | null;
  rotatable?: boolean;
  /** Prefixed into the history-coalescing key so one drag = one undo step. */
  idPrefix: string;
  onTransform: (g: Geom, gesture: string) => void;
}

/**
 * Industry-standard transform chrome: eight directional resize handles (corners
 * scale two edges, sides scale one) plus a rotate ring just outside each corner.
 * All maths is done in screen space and projected onto the box's local axes, so
 * it stays correct while the box is rotated. Render it inside the rotated
 * element container so the handles ride along with the rotation.
 */
export function SelectionFrame({
  geom,
  containerRef,
  minSize = 8,
  aspect = null,
  rotatable = true,
  idPrefix,
  onTransform,
}: Props) {
  const gesture = useRef(0);

  const beginResize = (e: React.PointerEvent, key: HKey) => {
    const g0 = { ...geom };
    const th = (g0.rot * Math.PI) / 180;
    const cos = Math.cos(th);
    const sin = Math.sin(th);
    const [hx, hy] = DIR[key];
    const gk = `resize-${idPrefix}-${++gesture.current}`;
    startPointerDrag(e, {
      onMove: (ddx, ddy) => {
        // Project the screen delta onto the box's local axes.
        const du = ddx * cos + ddy * sin;
        const dv = -ddx * sin + ddy * cos;
        let newW: number;
        let newH: number;
        if (aspect && hx !== 0 && hy !== 0) {
          newW = Math.max(minSize, g0.w + hx * du);
          newH = Math.max(minSize, newW * aspect);
          newW = newH / aspect;
        } else {
          newW = Math.max(minSize, g0.w + hx * du);
          newH = Math.max(minSize, g0.h + hy * dv);
        }
        // Keep the opposite edge/corner pinned: shift the centre by half the
        // size change, along the local axes, in the drag direction.
        const adW = newW - g0.w;
        const adH = newH - g0.h;
        const sx = (hx * adW) / 2;
        const sy = (hy * adH) / 2;
        const cx = g0.cx + sx * cos - sy * sin;
        const cy = g0.cy + sx * sin + sy * cos;
        onTransform({ cx, cy, w: newW, h: newH, rot: g0.rot }, gk);
      },
    });
  };

  const beginRotate = (e: React.PointerEvent) => {
    const g0 = { ...geom };
    const rect = containerRef.current?.getBoundingClientRect();
    const ccx = rect ? rect.left + rect.width / 2 : e.clientX;
    const ccy = rect ? rect.top + rect.height / 2 : e.clientY;
    const startX = e.clientX;
    const startY = e.clientY;
    const a0 = Math.atan2(startY - ccy, startX - ccx);
    const gk = `rotate-${idPrefix}-${++gesture.current}`;
    startPointerDrag(e, {
      onMove: (ddx, ddy) => {
        const a1 = Math.atan2(startY + ddy - ccy, startX + ddx - ccx);
        let deg = g0.rot + ((a1 - a0) * 180) / Math.PI;
        const snapped = Math.round(deg / ROT_SNAP) * ROT_SNAP;
        if (Math.abs(snapped - deg) < ROT_SNAP_TOL) deg = snapped;
        onTransform({ ...g0, rot: deg }, gk);
      },
      // Measured as an angle about a centre read off the screen, so it needs
      // the pointer's screen positions; a turn of the page doesn't change an
      // angle *difference*, so nothing else here has to know about it.
      screen: true,
    });
  };

  return (
    <>
      {rotatable &&
        CORNERS.map((k) => (
          <div
            key={`rot-${k}`}
            className={k === "nw" ? "rotate-zone rotate-zone--hint" : "rotate-zone"}
            style={{ left: POS[k].left, top: POS[k].top }}
            aria-label="Rotate"
            data-tip="Drag to rotate"
            onPointerDown={beginRotate}
          />
        ))}
      {(Object.keys(DIR) as HKey[]).map((k) => (
        <div
          key={k}
          className="handle"
          style={{ left: POS[k].left, top: POS[k].top, cursor: CURSOR[k] }}
          aria-label="Resize"
          onPointerDown={(e) => beginResize(e, k)}
        />
      ))}
    </>
  );
}
