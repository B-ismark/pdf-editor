import { useRef } from "react";
import { SelectionFrame, type Geom } from "./SelectionFrame";
import type { Annotation, BoxAnnotation } from "../pdf/types";

interface Props {
  /** A box-shaped annotation — rect, highlight, tick or cross. */
  annot: BoxAnnotation;
  scale: number;
  pageHeight: number;
  onMove: (annot: Annotation, key: string) => void;
}

const MIN = 6;

/** Transparent HTML overlay that hosts the resize/rotate handles for a selected
 * box annotation. The shape itself is drawn in the SVG layer; this only carries
 * the chrome, so its body is click-through (handles capture). */
export function AnnotationFrame({ annot: a, scale, pageHeight: H, onMove }: Props) {
  const boxRef = useRef<HTMLDivElement>(null);
  const left = a.x * scale;
  const top = (H - (a.y + a.height)) * scale;
  const w = a.width * scale;
  const h = a.height * scale;
  const rot = a.rotation ?? 0;

  const geom: Geom = { cx: left + w / 2, cy: top + h / 2, w, h, rot };

  const applyGeom = (g: Geom, key: string) => {
    const nLeft = g.cx - g.w / 2;
    const nTop = g.cy - g.h / 2;
    onMove(
      {
        ...a,
        x: nLeft / scale,
        y: H - (nTop + g.h) / scale,
        width: g.w / scale,
        height: g.h / scale,
        rotation: g.rot,
      },
      key,
    );
  };

  return (
    <div
      ref={boxRef}
      className="annot-frame"
      style={{
        left: `${left}px`,
        top: `${top}px`,
        width: `${w}px`,
        height: `${h}px`,
        transform: rot ? `rotate(${rot}deg)` : undefined,
      }}
    >
      <SelectionFrame
        geom={geom}
        containerRef={boxRef}
        minSize={MIN}
        idPrefix={`an-${a.id}`}
        onTransform={applyGeom}
      />
    </div>
  );
}
