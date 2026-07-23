import type { Annotation, LinkAnnot, Redaction, Stamp, TextBox } from "./types";

/** An axis-aligned bounding box in PDF units (bottom-left origin; t > b). */
export interface Box {
  l: number;
  r: number;
  b: number;
  t: number;
}

export const boxW = (x: Box) => x.r - x.l;
export const boxH = (x: Box) => x.t - x.b;
export const boxCX = (x: Box) => (x.l + x.r) / 2;
export const boxCY = (x: Box) => (x.b + x.t) / 2;

/** Do two boxes overlap at all? */
export function intersects(a: Box, b: Box): boolean {
  return !(a.r < b.l || a.l > b.r || a.t < b.b || a.b > b.t);
}

const rectBox = (o: { x: number; y: number; width: number; height: number }): Box => ({
  l: o.x,
  r: o.x + o.width,
  b: o.y,
  t: o.y + o.height,
});

export const redactionBox = (r: Redaction): Box => rectBox(r);
export const linkBox = (l: LinkAnnot): Box => rectBox(l);
export const stampBox = (s: Stamp): Box => rectBox(s);

/** Text boxes have no stored width; approximate a point box at the baseline. */
export function textBoxBox(b: TextBox): Box {
  const h = b.style.size;
  return { l: b.x, r: b.x + h * 0.5, b: b.y, t: b.y + h };
}

export function annotationBox(a: Annotation): Box {
  switch (a.kind) {
    case "highlight":
    case "rect":
      return rectBox(a);
    case "line":
    case "arrow":
      return { l: Math.min(a.x1, a.x2), r: Math.max(a.x1, a.x2), b: Math.min(a.y1, a.y2), t: Math.max(a.y1, a.y2) };
    case "pen": {
      const xs = a.pts.map((p) => p.x);
      const ys = a.pts.map((p) => p.y);
      return { l: Math.min(...xs), r: Math.max(...xs), b: Math.min(...ys), t: Math.max(...ys) };
    }
    case "note":
      return { l: a.x, r: a.x, b: a.y, t: a.y };
  }
}
