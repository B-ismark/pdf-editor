import { useRef } from "react";
import { startElementGesture, startPointerDrag } from "../hooks/useDrag";
import { isBoxAnnotation, type Annotation } from "../pdf/types";
import { markPolylines, markStroke } from "../pdf/marks";

interface Props {
  annotations: Annotation[];
  scale: number;
  pageHeight: number;
  selectedId: string | null;
  interactive: boolean;
  onSelect: (id: string) => void;
  /** Replace an annotation's geometry (used while dragging to move it). */
  onMove: (annot: Annotation, key: string) => void;
  /**
   * Which half of the layer to render.
   *
   * `shapes` is everything visible, plus the *box*-shaped hit targets, and sits
   * under the text overlay as it always has. `hits` is the transparent
   * stroke-shaped targets only, and PageView renders it *above* the editable
   * text: a pen line drawn across a paragraph was otherwise unselectable, since
   * the (invisible) text overlay above it took every click — which makes a
   * stroke over text impossible to recolour, move or restack, i.e. exactly the
   * strokes anyone would want to.
   *
   * The split is by hit *size*, and the reason is which click is more likely a
   * mistake. A stroke target is the width of the ink the user drew, so a click
   * on it means that ink. A box target is mostly empty space — a highlight over
   * a paragraph would blanket the text and make the document uneditable
   * underneath, so those stay below. Both halves read the same array in the same
   * order, so stacking order is unaffected.
   */
  variant?: "shapes" | "hits";
}

/** Shift an annotation by a delta in PDF units (origin bottom-left). */
export function translateAnnotation(a: Annotation, dx: number, dy: number): Annotation {
  switch (a.kind) {
    case "line":
    case "arrow":
      return { ...a, x1: a.x1 + dx, y1: a.y1 + dy, x2: a.x2 + dx, y2: a.y2 + dy };
    case "pen":
      return { ...a, pts: a.pts.map((p) => ({ x: p.x + dx, y: p.y + dy })) };
    default:
      return { ...a, x: a.x + dx, y: a.y + dy };
  }
}

/** Bounding box (screen px) of an annotation, for the selection outline. */
function bbox(a: Annotation, scale: number, H: number) {
  const toX = (x: number) => x * scale;
  const toY = (y: number) => (H - y) * scale;
  if (isBoxAnnotation(a)) {
    return { x: toX(a.x), y: toY(a.y + a.height), w: a.width * scale, h: a.height * scale };
  }
  if (a.kind === "line" || a.kind === "arrow") {
    const x1 = toX(a.x1), y1 = toY(a.y1), x2 = toX(a.x2), y2 = toY(a.y2);
    return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
  }
  if (a.kind === "pen") {
    const xs = a.pts.map((p) => toX(p.x)), ys = a.pts.map((p) => toY(p.y));
    const x = Math.min(...xs), y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
  }
  if (a.kind === "note") return { x: toX(a.x), y: toY(a.y), w: 80, h: 20 };
  return { x: 0, y: 0, w: 0, h: 0 };
}

/** SVG layer that renders vector annotations for one page. Visible shapes are
 * inert; transparent "hit" shapes (only in select mode) handle selection.
 * Selected lines/arrows get draggable endpoint handles; rect/highlight boxes
 * are resized/rotated by an HTML SelectionFrame rendered alongside (PageView).*/
export function AnnotationLayer({
  annotations,
  scale,
  pageHeight: H,
  selectedId,
  interactive,
  onSelect,
  onMove,
  variant = "shapes",
}: Props) {
  const shapes = variant === "shapes";
  const toX = (x: number) => x * scale;
  const toY = (y: number) => (H - y) * scale;
  const gestureRef = useRef(0);
  // Select on press and drag to move. Cumulative delta is applied to the
  // annotation snapshotted at drag start (screen-down = PDF-y-down = negative).
  const beginDrag = (a: Annotation, e: React.PointerEvent) => {
    const key = `move-an-${a.id}-${++gestureRef.current}`;
    const start = a;
    startElementGesture(e, {
      selected: selectedId === a.id,
      onSelect: () => onSelect(a.id),
      onMove: (dx, dy) => onMove(translateAnnotation(start, dx / scale, -dy / scale), key),
    });
  };
  // Drag one end of a line/arrow: it pivots and scales about the other end.
  const beginEndpoint = (a: Extract<Annotation, { kind: "line" | "arrow" }>, which: 1 | 2, e: React.PointerEvent) => {
    const key = `endpt-an-${a.id}-${which}-${++gestureRef.current}`;
    const start = a;
    startPointerDrag(e, {
      onMove: (dx, dy) => {
        const nx = dx / scale;
        const ny = -dy / scale;
        const next =
          which === 1
            ? { ...start, x1: start.x1 + nx, y1: start.y1 + ny }
            : { ...start, x2: start.x2 + nx, y2: start.y2 + ny };
        onMove(next, key);
      },
    });
  };
  const hitProps = (a: Annotation) =>
    interactive
      ? {
          style: { pointerEvents: "stroke" as const, cursor: "move" },
          onPointerDown: (e: React.PointerEvent) => beginDrag(a, e),
        }
      : { style: { pointerEvents: "none" as const } };
  const fillHit = (a: Annotation) =>
    interactive
      ? {
          style: { pointerEvents: "fill" as const, cursor: "move" },
          onPointerDown: (e: React.PointerEvent) => beginDrag(a, e),
        }
      : { style: { pointerEvents: "none" as const } };

  return (
    <svg
      className={`annot-svg${shapes ? "" : " annot-svg--hits"}`}
      width="100%"
      height="100%"
      style={{ pointerEvents: "none" }}
      aria-hidden={shapes ? undefined : true}
    >
      {annotations.map((a) => {
        const stroke = "strokeWidth" in a ? a.strokeWidth * scale : 1;
        const key = a.id;
        const els: React.ReactNode[] = [];
        // Box kinds carry an optional rotation about their centre.
        let groupTransform: string | undefined;
        if (isBoxAnnotation(a)) {
          const rot = a.rotation ?? 0;
          if (rot) {
            const cx = toX(a.x + a.width / 2);
            const cy = toY(a.y + a.height / 2);
            groupTransform = `rotate(${rot} ${cx} ${cy})`;
          }
        }
        if (a.kind === "highlight") {
          if (!shapes) return null;
          els.push(
            <rect key="v" x={toX(a.x)} y={toY(a.y + a.height)} width={a.width * scale} height={a.height * scale} fill={a.color} opacity={0.4} style={{ pointerEvents: "none" }} />,
            <rect key="h" x={toX(a.x)} y={toY(a.y + a.height)} width={a.width * scale} height={a.height * scale} fill="transparent" {...fillHit(a)} />,
          );
        } else if (a.kind === "rect") {
          if (!shapes) return null;
          els.push(
            <rect key="v" x={toX(a.x)} y={toY(a.y + a.height)} width={a.width * scale} height={a.height * scale} fill="none" stroke={a.color} strokeWidth={stroke} style={{ pointerEvents: "none" }} />,
            // Whole interior is grabbable so the box moves like a stamp.
            <rect key="h" x={toX(a.x)} y={toY(a.y + a.height)} width={a.width * scale} height={a.height * scale} fill="transparent" {...fillHit(a)} />,
          );
        } else if (a.kind === "line" || a.kind === "arrow") {
          const x1 = toX(a.x1), y1 = toY(a.y1), x2 = toX(a.x2), y2 = toY(a.y2);
          if (shapes) {
            els.push(
              <line key="v" x1={x1} y1={y1} x2={x2} y2={y2} stroke={a.color} strokeWidth={stroke} strokeLinecap="round" style={{ pointerEvents: "none" }} />,
            );
          } else {
            els.push(
              <line key="h" x1={x1} y1={y1} x2={x2} y2={y2} stroke="transparent" strokeWidth={Math.max(stroke, 16)} {...hitProps(a)} />,
            );
          }
          if (shapes && a.kind === "arrow") {
            const L = Math.max(8, a.strokeWidth * 4) * scale;
            const back = Math.atan2(y2 - y1, x2 - x1) + Math.PI;
            for (const off of [-Math.PI / 6, Math.PI / 6]) {
              els.push(
                <line key={`hd${off}`} x1={x2} y1={y2} x2={x2 + L * Math.cos(back + off)} y2={y2 + L * Math.sin(back + off)} stroke={a.color} strokeWidth={stroke} strokeLinecap="round" style={{ pointerEvents: "none" }} />,
              );
            }
          }
          // Draggable endpoints when selected: reshape length & direction. They
          // live in the hits layer with the line itself, or the text overlay
          // would swallow a handle that happens to land on a word.
          if (!shapes && selectedId === a.id && interactive) {
            for (const [k, cx, cy, w] of [["e1", x1, y1, 1] as const, ["e2", x2, y2, 2] as const]) {
              els.push(
                <circle key={`${k}hit`} className="endpoint-hit" cx={cx} cy={cy} r={14} onPointerDown={(e) => beginEndpoint(a, w, e)} />,
                <circle key={k} className="endpoint" cx={cx} cy={cy} r={6} onPointerDown={(e) => beginEndpoint(a, w, e)} />,
              );
            }
          }
        } else if (a.kind === "check" || a.kind === "cross") {
          if (!shapes) return null;
          // One glyph definition, three draw paths — see pdf/marks.ts.
          const sw = markStroke(a.strokeWidth, a) * scale;
          markPolylines(a.kind, a).forEach((line, i) => {
            const pts = line.map((p) => `${toX(p.x)},${toY(p.y)}`).join(" ");
            els.push(
              <polyline key={`v${i}`} points={pts} fill="none" stroke={a.color} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" style={{ pointerEvents: "none" }} />,
            );
          });
          // The whole box is grabbable, not just the strokes: a tick is mostly
          // empty space and chasing a 2pt diagonal with a finger is hopeless.
          els.push(
            <rect key="h" x={toX(a.x)} y={toY(a.y + a.height)} width={a.width * scale} height={a.height * scale} fill="transparent" {...fillHit(a)} />,
          );
        } else if (a.kind === "pen") {
          const pts = a.pts.map((p) => `${toX(p.x)},${toY(p.y)}`).join(" ");
          els.push(
            shapes ? (
              <polyline key="v" points={pts} fill="none" stroke={a.color} strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" style={{ pointerEvents: "none" }} />
            ) : (
              <polyline key="h" points={pts} fill="none" stroke="transparent" strokeWidth={Math.max(stroke, 16)} {...hitProps(a)} />
            ),
          );
        } else if (!shapes) {
          // Notes carry their own HTML element; nothing to put in this layer.
          return null;
        }
        // Dashed outline only for kinds without dedicated handles (pen/note);
        // line/arrow show endpoints, rect/highlight get the HTML frame.
        const showBox = shapes && selectedId === a.id && (a.kind === "pen" || a.kind === "note");
        const b = showBox ? bbox(a, scale, H) : null;
        return (
          <g key={key} transform={groupTransform}>
            {els}
            {b && (
              <rect x={b.x - 4} y={b.y - 4} width={b.w + 8} height={b.h + 8} fill="none" stroke="var(--primary)" strokeWidth={1.5} strokeDasharray="5 4" style={{ pointerEvents: "none" }} />
            )}
          </g>
        );
      })}
    </svg>
  );
}
