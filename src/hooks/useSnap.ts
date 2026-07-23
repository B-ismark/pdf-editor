import { useSyncExternalStore } from "react";

/**
 * Lightweight snapping to the page's edges and centre lines, with a small
 * pub-sub so the active guide lines can be drawn by PageView while any element
 * is being dragged. Coordinates are PDF units (origin bottom-left).
 */

export interface SnapResult {
  x: number;
  y: number;
  /** PDF x of the active vertical guide, or null. */
  gx: number | null;
  /** PDF y of the active horizontal guide, or null. */
  gy: number | null;
}

/** Snap a box's bottom-left (x, y) to page edges/centre within `thr` PDF units. */
export function snapBox(
  x: number,
  y: number,
  w: number,
  h: number,
  pageW: number,
  pageH: number,
  thr: number,
): SnapResult {
  let nx = x;
  let gx: number | null = null;
  let ny = y;
  let gy: number | null = null;

  // X: box-left→0, box-centre→pageW/2, box-right→pageW.
  const xCands: { pos: number; guide: number; set: number }[] = [
    { pos: x, guide: 0, set: 0 },
    { pos: x + w / 2, guide: pageW / 2, set: pageW / 2 - w / 2 },
    { pos: x + w, guide: pageW, set: pageW - w },
  ];
  let bestX = thr;
  for (const c of xCands) {
    const d = Math.abs(c.pos - c.guide);
    if (d < bestX) {
      bestX = d;
      nx = c.set;
      gx = c.guide;
    }
  }

  // Y: box-bottom→0, box-centre→pageH/2, box-top→pageH.
  const yCands: { pos: number; guide: number; set: number }[] = [
    { pos: y, guide: 0, set: 0 },
    { pos: y + h / 2, guide: pageH / 2, set: pageH / 2 - h / 2 },
    { pos: y + h, guide: pageH, set: pageH - h },
  ];
  let bestY = thr;
  for (const c of yCands) {
    const d = Math.abs(c.pos - c.guide);
    if (d < bestY) {
      bestY = d;
      ny = c.set;
      gy = c.guide;
    }
  }

  return { x: nx, y: ny, gx, gy };
}

// --- Guide pub-sub (one drag at a time) ---
const guides: { gx: number | null; gy: number | null } = { gx: null, gy: null };
let version = 0;
const subs = new Set<() => void>();

export function setGuides(gx: number | null, gy: number | null): void {
  if (guides.gx === gx && guides.gy === gy) return;
  guides.gx = gx;
  guides.gy = gy;
  version++;
  subs.forEach((f) => f());
}
export function clearGuides(): void {
  setGuides(null, null);
}
function subscribe(f: () => void): () => void {
  subs.add(f);
  return () => {
    subs.delete(f);
  };
}

/** Read the current guides (re-renders when they change). */
export function useGuides(): { gx: number | null; gy: number | null } {
  useSyncExternalStore(subscribe, () => version, () => version);
  return guides;
}
