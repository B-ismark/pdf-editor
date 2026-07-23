import type { Annotation } from "../pdf/types";

interface Props {
  annotations: Annotation[];
  scale: number;
  pageHeight: number;
  selectedId: string | null;
  interactive: boolean;
  onSelect: (id: string) => void;
}

/** Bounding box (screen px) of an annotation, for the selection outline. */
function bbox(a: Annotation, scale: number, H: number) {
  const toX = (x: number) => x * scale;
  const toY = (y: number) => (H - y) * scale;
  if (a.kind === "highlight" || a.kind === "rect") {
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
 * inert; transparent "hit" shapes (only in select mode) handle selection. */
export function AnnotationLayer({
  annotations,
  scale,
  pageHeight: H,
  selectedId,
  interactive,
  onSelect,
}: Props) {
  const toX = (x: number) => x * scale;
  const toY = (y: number) => (H - y) * scale;
  const hitProps = (id: string) =>
    interactive
      ? {
          style: { pointerEvents: "stroke" as const, cursor: "pointer" },
          onPointerDown: (e: React.PointerEvent) => {
            e.stopPropagation();
            onSelect(id);
          },
        }
      : { style: { pointerEvents: "none" as const } };
  const fillHit = (id: string) =>
    interactive
      ? {
          style: { pointerEvents: "fill" as const, cursor: "pointer" },
          onPointerDown: (e: React.PointerEvent) => {
            e.stopPropagation();
            onSelect(id);
          },
        }
      : { style: { pointerEvents: "none" as const } };

  return (
    <svg className="annot-svg" width="100%" height="100%" style={{ pointerEvents: "none" }}>
      {annotations.map((a) => {
        const stroke = "strokeWidth" in a ? a.strokeWidth * scale : 1;
        const key = a.id;
        const els: React.ReactNode[] = [];
        if (a.kind === "highlight") {
          els.push(
            <rect key="v" x={toX(a.x)} y={toY(a.y + a.height)} width={a.width * scale} height={a.height * scale} fill={a.color} opacity={0.4} style={{ pointerEvents: "none" }} />,
            <rect key="h" x={toX(a.x)} y={toY(a.y + a.height)} width={a.width * scale} height={a.height * scale} fill="transparent" {...fillHit(a.id)} />,
          );
        } else if (a.kind === "rect") {
          els.push(
            <rect key="v" x={toX(a.x)} y={toY(a.y + a.height)} width={a.width * scale} height={a.height * scale} fill="none" stroke={a.color} strokeWidth={stroke} style={{ pointerEvents: "none" }} />,
            <rect key="h" x={toX(a.x)} y={toY(a.y + a.height)} width={a.width * scale} height={a.height * scale} fill="transparent" stroke="transparent" strokeWidth={Math.max(stroke, 16)} {...hitProps(a.id)} />,
          );
        } else if (a.kind === "line" || a.kind === "arrow") {
          const x1 = toX(a.x1), y1 = toY(a.y1), x2 = toX(a.x2), y2 = toY(a.y2);
          els.push(
            <line key="v" x1={x1} y1={y1} x2={x2} y2={y2} stroke={a.color} strokeWidth={stroke} strokeLinecap="round" style={{ pointerEvents: "none" }} />,
            <line key="h" x1={x1} y1={y1} x2={x2} y2={y2} stroke="transparent" strokeWidth={Math.max(stroke, 16)} {...hitProps(a.id)} />,
          );
          if (a.kind === "arrow") {
            const L = Math.max(8, a.strokeWidth * 4) * scale;
            const back = Math.atan2(y2 - y1, x2 - x1) + Math.PI;
            for (const off of [-Math.PI / 6, Math.PI / 6]) {
              els.push(
                <line key={`hd${off}`} x1={x2} y1={y2} x2={x2 + L * Math.cos(back + off)} y2={y2 + L * Math.sin(back + off)} stroke={a.color} strokeWidth={stroke} strokeLinecap="round" style={{ pointerEvents: "none" }} />,
              );
            }
          }
        } else if (a.kind === "pen") {
          const pts = a.pts.map((p) => `${toX(p.x)},${toY(p.y)}`).join(" ");
          els.push(
            <polyline key="v" points={pts} fill="none" stroke={a.color} strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" style={{ pointerEvents: "none" }} />,
            <polyline key="h" points={pts} fill="none" stroke="transparent" strokeWidth={Math.max(stroke, 16)} {...hitProps(a.id)} />,
          );
        }
        const b = selectedId === a.id ? bbox(a, scale, H) : null;
        return (
          <g key={key}>
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
