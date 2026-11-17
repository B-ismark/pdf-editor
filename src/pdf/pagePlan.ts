import type { PageData, PageRef } from "./types";

/**
 * The page plan: which source pages the document has, in what order, turned
 * how far. Kept in `DocState.pages` so reorder / rotate / delete are ordinary
 * undoable edits that leave every overlay object where it was.
 *
 * Overlay objects keep their *source* page index, and a source page appears at
 * most once in a plan (Organise has no duplicate), so a page's markup follows
 * it wherever it moves and comes back with it on undo.
 */

/** Normalise any angle to 0/90/180/270 (anything else rounds to the nearest). */
export function quarterTurn(deg: number): number {
  const q = Math.round((((deg % 360) + 360) % 360) / 90) % 4;
  return q * 90;
}

/** The plan as stored, or every source page in order when there is none — or
 * when the stored one doesn't fit this file (a session restored against a
 * different document, an index out of range, a page listed twice). */
export function resolvePlan(plan: PageRef[] | undefined, count: number): PageRef[] {
  if (plan && isValidPlan(plan, count)) return plan;
  return identityPlan(count);
}

export function identityPlan(count: number): PageRef[] {
  return Array.from({ length: count }, (_, index) => ({ index, rotate: 0 }));
}

export function isValidPlan(plan: PageRef[], count: number): boolean {
  if (!Array.isArray(plan) || plan.length === 0) return false;
  const seen = new Set<number>();
  for (const p of plan) {
    if (!p || !Number.isInteger(p.index) || p.index < 0 || p.index >= count) return false;
    if (seen.has(p.index)) return false;
    if (typeof p.rotate !== "number" || !Number.isFinite(p.rotate)) return false;
    seen.add(p.index);
  }
  return true;
}

/** True when the plan changes nothing — the document as loaded. */
export function isIdentityPlan(plan: PageRef[] | undefined, count: number): boolean {
  if (!plan) return true;
  if (plan.length !== count) return false;
  return plan.every((p, i) => p.index === i && quarterTurn(p.rotate) === 0);
}

/**
 * A source page as shown: the same object while it isn't turned any further,
 * otherwise one derived copy per (page, turn), cached so `PageView`'s memo sees
 * the same reference render after render.
 */
const turned = new WeakMap<PageData, Map<number, PageData>>();
export function turnPage(page: PageData, extra: number): PageData {
  const add = quarterTurn(extra);
  if (add === 0) return page;
  let byTurn = turned.get(page);
  if (!byTurn) turned.set(page, (byTurn = new Map()));
  let out = byTurn.get(add);
  if (!out) {
    out = { ...page, rotation: quarterTurn(page.rotation + add) };
    byTurn.set(add, out);
  }
  return out;
}

/** The pages in shown order, each carrying its total turn. */
export function shownPages(pages: PageData[], plan: PageRef[] | undefined): PageData[] {
  const resolved = resolvePlan(plan, pages.length);
  return resolved.map((p) => turnPage(pages[p.index], p.rotate));
}

/** Width and height of a page as shown (swapped for a quarter turn). */
export function shownSize(page: { viewBox: { width: number; height: number }; rotation: number }): {
  width: number;
  height: number;
} {
  const { width, height } = page.viewBox;
  return page.rotation % 180 === 0 ? { width, height } : { width: height, height: width };
}

/**
 * Map a point in a page's user space (PDF units, y up) to where it shows on
 * the turned page, as distances from the shown page's top-left (PDF units,
 * y down). Used to scroll to something on a turned page.
 */
export function userToShown(
  x: number,
  y: number,
  page: { viewBox: { width: number; height: number }; rotation: number },
): { x: number; y: number } {
  const { width: W, height: H } = page.viewBox;
  // Unrotated, top-left origin, y down:
  const u = x;
  const v = H - y;
  switch (quarterTurn(page.rotation)) {
    case 90:
      return { x: H - v, y: u };
    case 180:
      return { x: W - u, y: H - v };
    case 270:
      return { x: v, y: W - u };
    default:
      return { x: u, y: v };
  }
}

/**
 * The clockwise turn, in screen degrees, that makes something drawn on a page
 * turned by `rotation` read upright — the turn new stamps, marks and text
 * boxes are given on a turned page.
 */
export function uprightFor(rotation: number): number {
  return (360 - quarterTurn(rotation)) % 360;
}

/**
 * A move on the page as shown (`dx` right, `dy` up, PDF units) as a move in
 * the page's user space — what an arrow-key nudge has to store so the object
 * goes the way the arrow points on a turned page.
 */
export function shownToUserDelta(dx: number, dy: number, rotation: number): { dx: number; dy: number } {
  switch (quarterTurn(rotation)) {
    case 90:
      return { dx: -dy, dy: dx };
    case 180:
      return { dx: -dx, dy: -dy };
    case 270:
      return { dx: dy, dy: -dx };
    default:
      return { dx, dy };
  }
}

/**
 * A box in a page's user space (y up) as it lies on the page as shown, in the
 * same units and still y up — for aligning and distributing on a turned page,
 * where "left" on screen is another side of the box in user space. Only the
 * directions matter there, so the turn is taken about the origin.
 */
export function userToShownBox(
  box: { l: number; r: number; b: number; t: number },
  rotation: number,
): { l: number; r: number; b: number; t: number } {
  const back = (360 - quarterTurn(rotation)) % 360;
  const p = shownToUserDelta(box.l, box.b, back);
  const q = shownToUserDelta(box.r, box.t, back);
  return { l: Math.min(p.dx, q.dx), r: Math.max(p.dx, q.dx), b: Math.min(p.dy, q.dy), t: Math.max(p.dy, q.dy) };
}
