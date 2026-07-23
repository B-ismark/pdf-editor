import { useRef } from "react";
import { Icon } from "./Icon";
import { startElementGesture, startPointerDrag } from "../hooks/useDrag";
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

/** A placed image (signature / picture): draggable, corner-resizable (aspect
 * preserved), selectable. */
export function StampItem({ stamp, scale, pageHeight, selected, interactive, onSelect, onChange, onDelete }: Props) {
  const gesture = useRef(0);
  const H = pageHeight;
  const left = stamp.x * scale;
  const top = (H - (stamp.y + stamp.height)) * scale;
  const w = stamp.width * scale;
  const h = stamp.height * scale;

  const beginMove = (e: React.PointerEvent) => {
    const key = `move-st-${stamp.id}-${++gesture.current}`;
    const s = { x: stamp.x, y: stamp.y };
    startElementGesture(e, {
      selected,
      onSelect: () => onSelect(stamp.id),
      onMove: (dx, dy) => onChange(stamp.id, { x: s.x + dx / scale, y: s.y - dy / scale }, key),
    });
  };

  const beginResize = (e: React.PointerEvent) => {
    const key = `resize-st-${stamp.id}-${++gesture.current}`;
    const s = { w: stamp.width, h: stamp.height, top: stamp.y + stamp.height };
    const aspect = stamp.height / stamp.width;
    startPointerDrag(e, {
      onMove: (dx) => {
        const width = Math.max(MIN_W, s.w + dx / scale);
        const height = width * aspect;
        onChange(stamp.id, { width, height, y: s.top - height }, key);
      },
    });
  };

  return (
    <div
      className={`stamp${selected ? " stamp--sel" : ""}`}
      style={{ left: `${left}px`, top: `${top}px`, width: `${w}px`, height: `${h}px`, pointerEvents: interactive ? "auto" : "none" }}
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
            }}
            onClick={(e) => {
              e.stopPropagation();
              onDelete(stamp.id);
            }}
          >
            <Icon name="close" size={14} />
          </button>
          <div className="handle stamp__resize" onPointerDown={beginResize} />
        </>
      )}
    </div>
  );
}
