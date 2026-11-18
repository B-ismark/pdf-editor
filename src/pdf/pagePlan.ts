import type { CropRect, PageData, PageRef } from "./types";

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
    if (p.crop !== undefined && !isCropShape(p.crop)) return false;
    seen.add(p.index);
  }
  return true;
}

/** True when the plan changes nothing — the document as loaded. */
export function isIdentityPlan(plan: PageRef[] | undefined, count: number): boolean {
  if (!plan) return true;
  if (plan.length !== count) return false;
  return plan.every((p, i) => p.index === i && quarterTurn(p.rotate) === 0 && !p.crop);
}

/** The smallest side a crop may have, in PDF units (a few millimetres): a
 * frame dragged to nothing would make a page no one can see or click. */
export const MIN_CROP = 18;

function isCropShape(c: unknown): c is CropRect {
  if (!c || typeof c !== "object") return false;
  const { x, y, width, height } = c as CropRect;
  return [x, y, width, height].every((n) => typeof n === "number" && Number.isFinite(n)) && width > 0 && height > 0;
}

/**
 * A crop held to the page it's on: inside the view, at least `MIN_CROP` a
 * side. `undefined` when it keeps the whole page (or isn't a crop at all), so
 * a frame dragged back out to the edges reads as no crop.
 */
export function fitCrop(crop: CropRect | undefined, viewBox: { width: number; height: number }): CropRect | undefined {
  if (!crop || !isCropShape(crop)) return undefined;
  const W = viewBox.width;
  const H = viewBox.height;
  const minW = Math.min(MIN_CROP, W);
  const minH = Math.min(MIN_CROP, H);
  const x0 = Math.min(Math.max(0, crop.x), W - minW);
  const y0 = Math.min(Math.max(0, crop.y), H - minH);
  const x1 = Math.max(Math.min(W, crop.x + crop.width), x0 + minW);
  const y1 = Math.max(Math.min(H, crop.y + crop.height), y0 + minH);
  // Within a hundredth of a point of every edge is the whole page.
  const e = 0.01;
  if (x0 <= e && y0 <= e && x1 >= W - e && y1 >= H - e) return undefined;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

function sameCrop(a: CropRect | undefined, b: CropRect | undefined): boolean {
  if (!a || !b) return !a && !b;
  const e = 0.001;
  return Math.abs(a.x - b.x) < e && Math.abs(a.y - b.y) < e && Math.abs(a.width - b.width) < e && Math.abs(a.height - b.height) < e;
}

/**
 * A source page as shown: the same object while it isn't turned any further,
 * otherwise one derived copy per (page, turn), cached so `PageView`'s memo sees
 * the same reference render after render.
 */
const turned = new WeakMap<PageData, Map<string, PageData>>();
export function turnPage(page: PageData, extra: number, crop?: CropRect): PageData {
  const add = quarterTurn(extra);
  const kept = fitCrop(crop, page.viewBox);
  if (add === 0 && !kept) return page;
  let byTurn = turned.get(page);
  if (!byTurn) turned.set(page, (byTurn = new Map()));
  const key = kept ? `${add}|${kept.x}|${kept.y}|${kept.width}|${kept.height}` : `${add}`;
  let out = byTurn.get(key);
  if (!out) {
    out = { ...page, rotation: quarterTurn(page.rotation + add), ...(kept ? { crop: kept } : {}) };
    byTurn.set(key, out);
  }
  return out;
}

/** The pages in shown order, each carrying its total turn and its crop. */
export function shownPages(pages: PageData[], plan: PageRef[] | undefined): PageData[] {
  const resolved = resolvePlan(plan, pages.length);
  return resolved.map((p) => turnPage(pages[p.index], p.rotate, p.crop));
}

type Shape = { viewBox: { width: number; height: number }; rotation: number; crop?: CropRect };

/** Width and height of the whole page turned as shown, crop or no crop. */
export function sheetSize(page: Shape): { width: number; height: number } {
  const { width, height } = page.viewBox;
  return page.rotation % 180 === 0 ? { width, height } : { width: height, height: width };
}

/** Width and height of a page as shown: its crop, if any, turned (swapped for
 * a quarter turn). */
export function shownSize(page: Shape): { width: number; height: number } {
  const { width, height } = page.crop ?? page.viewBox;
  return page.rotation % 180 === 0 ? { width, height } : { width: height, height: width };
}

/** Where the crop window's top-left sits on the whole turned page, in PDF
 * units from the turned page's top-left (y down). 0,0 without a crop. */
export function cropOffset(page: Shape): { x: number; y: number } {
  const c = page.crop;
  if (!c) return { x: 0, y: 0 };
  const a = sheetPoint(c.x, c.y, page);
  const b = sheetPoint(c.x + c.width, c.y + c.height, page);
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) };
}

/** A view-space point on the whole turned page, top-left origin, y down. */
function sheetPoint(x: number, y: number, page: Shape): { x: number; y: number } {
  const { width: W, height: H } = page.viewBox;
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

/** The inverse of `sheetPoint`: a point on the whole turned page (top-left
 * origin, y down) back in view space. */
export function sheetToView(sx: number, sy: number, page: Shape): { x: number; y: number } {
  const { width: W, height: H } = page.viewBox;
  let u: number;
  let v: number;
  switch (quarterTurn(page.rotation)) {
    case 90:
      u = sy;
      v = H - sx;
      break;
    case 180:
      u = W - sx;
      v = H - sy;
      break;
    case 270:
      u = W - sy;
      v = sx;
      break;
    default:
      u = sx;
      v = sy;
  }
  return { x: u, y: H - v };
}

/**
 * Map a point in a page's user space (PDF units, y up) to where it shows on
 * the turned page, as distances from the shown page's top-left (PDF units,
 * y down). Used to scroll to something on a turned page.
 */
export function userToShown(x: number, y: number, page: Shape): { x: number; y: number } {
  const p = sheetPoint(x, y, page);
  const o = cropOffset(page);
  return { x: p.x - o.x, y: p.y - o.y };
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

/**
 * Move the pages whose source index is in `keys` to the gap before shown
 * position `gap` (0 = the top, `plan.length` = the end), keeping their order.
 * The gap counts positions in the plan *before* the move, so a drop indicator
 * drawn between two thumbnails means exactly that slot.
 */
export function movePages(plan: PageRef[], keys: ReadonlySet<number>, gap: number): PageRef[] {
  const moving = plan.filter((p) => keys.has(p.index));
  if (moving.length === 0) return plan;
  const at = Math.max(0, Math.min(plan.length, gap));
  const before = plan.slice(0, at).filter((p) => !keys.has(p.index));
  const after = plan.slice(at).filter((p) => !keys.has(p.index));
  return [...before, ...moving, ...after];
}

/** Turn the pages in `keys` a quarter clockwise. */
export function turnPages(plan: PageRef[], keys: ReadonlySet<number>): PageRef[] {
  return plan.map((p) => (keys.has(p.index) ? { ...p, rotate: quarterTurn(p.rotate + 90) } : p));
}

/** Drop the pages in `keys`. Never every page: a document keeps at least one,
 * so this returns the plan unchanged when asked to. */
export function dropPages(plan: PageRef[], keys: ReadonlySet<number>): PageRef[] {
  const kept = plan.filter((p) => !keys.has(p.index));
  return kept.length === 0 ? plan : kept;
}

/** Same pages, same order, same turns. */
export function samePlan(a: PageRef[], b: PageRef[]): boolean {
  return a.length === b.length && a.every((p, i) => p.index === b[i].index && quarterTurn(p.rotate) === quarterTurn(b[i].rotate) && sameCrop(p.crop, b[i].crop));
}
