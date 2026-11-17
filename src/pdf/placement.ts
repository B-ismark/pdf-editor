/**
 * Where a placed image or signature lands. One function for the ghost that
 * follows the pointer and for the stamp the click creates, so the preview can't
 * promise a spot the drop then misses.
 *
 * The stamp is centred on the point (a signature is aimed by its middle, not
 * its top-left corner) and kept wholly on the page: a box that hangs off the
 * edge is cut off in the exported file, which the overlay didn't show.
 */
export interface Placement {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Default placed size, in PDF units: at most 220pt wide, and never wider than
 * 90% of the page (a narrow receipt-sized page would otherwise overflow). */
export function placedSize(
  img: { w: number; h: number },
  pageW: number,
  pageH: number,
): { width: number; height: number } {
  let width = Math.min(220, img.w * 0.75, pageW * 0.9);
  let height = width * (img.h / img.w);
  if (height > pageH * 0.9) {
    height = pageH * 0.9;
    width = height * (img.w / img.h);
  }
  return { width, height };
}

/** Clamp a box (PDF units, origin bottom-left) so it lies inside the page. */
export function clampToPage(box: Placement, pageW: number, pageH: number): Placement {
  const width = Math.min(box.width, pageW);
  const height = Math.min(box.height, pageH);
  return {
    width,
    height,
    x: Math.max(0, Math.min(pageW - width, box.x)),
    y: Math.max(0, Math.min(pageH - height, box.y)),
  };
}

/** The stamp a click at (cx, cy) — PDF units — would place. */
export function placeAt(
  size: { width: number; height: number },
  cx: number,
  cy: number,
  pageW: number,
  pageH: number,
): Placement {
  return clampToPage({ x: cx - size.width / 2, y: cy - size.height / 2, ...size }, pageW, pageH);
}

/** The width and height a box occupies once rotated about its centre. */
export function rotatedExtent(width: number, height: number, rotationDeg = 0): { w: number; h: number } {
  const r = (rotationDeg * Math.PI) / 180;
  const c = Math.abs(Math.cos(r));
  const s = Math.abs(Math.sin(r));
  return { w: width * c + height * s, h: width * s + height * c };
}

type Rotated = Placement & { rotation?: number };

/** Whether a (possibly rotated) box lies wholly on the page, to half a point. */
export function onPage(b: Rotated, pageW: number, pageH: number): boolean {
  const e = rotatedExtent(b.width, b.height, b.rotation);
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  const tol = 0.5;
  return cx - e.w / 2 >= -tol && cx + e.w / 2 <= pageW + tol && cy - e.h / 2 >= -tol && cy + e.h / 2 <= pageH + tol;
}

/**
 * The position that keeps a (possibly rotated) box on the page: its centre is
 * pulled in until the rotated extent fits, and centred on an axis it can't fit
 * at all. Only x/y change, so a drag stops at the edge instead of the box
 * shrinking or jumping.
 */
export function keepOnPage(b: Rotated, pageW: number, pageH: number): { x: number; y: number } {
  const e = rotatedExtent(b.width, b.height, b.rotation);
  const pull = (c: number, ext: number, size: number) =>
    ext >= size ? size / 2 : Math.max(ext / 2, Math.min(size - ext / 2, c));
  const cx = pull(b.x + b.width / 2, e.w, pageW);
  const cy = pull(b.y + b.height / 2, e.h, pageH);
  return { x: cx - b.width / 2, y: cy - b.height / 2 };
}
