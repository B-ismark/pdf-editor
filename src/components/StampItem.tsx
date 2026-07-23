import { useRef } from "react";
import { Icon } from "./Icon";
import { startElementGesture } from "../hooks/useDrag";
import { SelectionFrame, type Geom } from "./SelectionFrame";
import type { Stamp } from "../pdf/types";

interface Props {
  stamp: Stamp;
  scale: number;
  pageHeight: number;
  selected: boolean;
  interactive: boolean;
  onSelect: (id: string) => void;
  onChange: (id: string, patch: Partial<Stamp>, key: string) => void;
  onDelete: (id: string) => void;
}

const MIN_W = 24;

/** A placed image (signature / picture): draggable, resizable from any edge or
 * corner (corners keep aspect), rotatable, selectable. */
export function StampItem({ stamp, scale, pageHeight, selected, interactive, onSelect, onChange, onDelete }: Props) {
  const gesture = useRef(0);
  const boxRef = useRef<HTMLDivElement>(null);
  // Guards the delete badge against the browser's synthesized "ghost click":
  // placing/selecting a stamp is a tap on the page, and the post-tap click is
  // dispatched to whatever is now under that point — often this freshly-shown
  // badge, which would instantly delete the just-placed signature. A real tap
  // on the badge fires pointerdown *on the badge* first; the ghost click does
  // not. So we only honour a click that a badge pointerdown armed.
  const delArmed = useRef(false);
  const H = pageHeight;
  const left = stamp.x * scale;
  const top = (H - (stamp.y + stamp.height)) * scale;
  const w = stamp.width * scale;
  const h = stamp.height * scale;
  const rot = stamp.rotation ?? 0;

  const beginMove = (e: React.PointerEvent) => {
    const key = `move-st-${stamp.id}-${++gesture.current}`;
    const s = { x: stamp.x, y: stamp.y };
    startElementGesture(e, {
      selected,
      onSelect: () => onSelect(stamp.id),
      onMove: (dx, dy) => onChange(stamp.id, { x: s.x + dx / scale, y: s.y - dy / scale }, key),
    });
  };

  // Screen geometry → PDF patch (bottom-left origin, y up).
  const applyGeom = (g: Geom, key: string) => {
    const nLeft = g.cx - g.w / 2;
    const nTop = g.cy - g.h / 2;
    onChange(
      stamp.id,
      {
        x: nLeft / scale,
        y: H - (nTop + g.h) / scale,
        width: g.w / scale,
        height: g.h / scale,
        rotation: g.rot,
      },
      key,
    );
  };

  const geom: Geom = { cx: left + w / 2, cy: top + h / 2, w, h, rot };

  return (
    <div
      ref={boxRef}
      className={`stamp${selected ? " stamp--sel" : ""}`}
      style={{
        left: `${left}px`,
        top: `${top}px`,
        width: `${w}px`,
        height: `${h}px`,
        transform: rot ? `rotate(${rot}deg)` : undefined,
        pointerEvents: interactive ? "auto" : "none",
      }}
      onPointerDown={beginMove}
    >
      <img src={stamp.dataUrl} alt="" draggable={false} />
      {selected && interactive && (
        <>
          <button
            type="button"
            className="stamp__del"
            aria-label="Delete"
            data-tip="Delete"
            onPointerDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
              delArmed.current = true;
            }}
            onPointerCancel={() => {
              delArmed.current = false;
            }}
            onClick={(e) => {
              e.stopPropagation();
              // Ignore a ghost click that no on-badge pointerdown armed.
              if (!delArmed.current) return;
              delArmed.current = false;
              onDelete(stamp.id);
            }}
          >
            <Icon name="close" size={14} />
          </button>
          <SelectionFrame
            geom={geom}
            containerRef={boxRef}
            minSize={MIN_W}
            aspect={stamp.height / stamp.width}
            idPrefix={`st-${stamp.id}`}
            onTransform={applyGeom}
          />
        </>
      )}
    </div>
  );
}
