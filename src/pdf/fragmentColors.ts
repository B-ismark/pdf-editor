import { renderPageToCanvas } from "./loader";
import { fragmentSize } from "./style";
import type { PageData, TextFragment } from "./types";

/**
 * What colours a text fragment sits in and is drawn with, per page, keyed by
 * text-item index.
 *
 * Editing a fragment means covering the original glyphs and redrawing the
 * replacement, and both halves of that used a constant where the document's own
 * value belonged. The cover was hardcoded white, which punches a hole through
 * any coloured pill, cell, or banner the text sits in; the replacement was drawn
 * in hardcoded black, so white text on a dark panel came back black and
 * unreadable. Neither colour is in `PageData` — `getTextContent()` reports no
 * fill colour at all — so, exactly as with fonts (`fontInfo.ts`), the real
 * answer only exists once the page has been rasterised.
 *
 * Read from the raster rather than the content stream deliberately. The operator
 * list does carry the fill-colour operators, but nothing joins them to text
 * items: pdf.js splits and merges runs on its own terms, so matching them up
 * means re-running its text-state machine (Tm/Td/TL/Tf/TJ advances) to recover
 * each run's position. The rendered pixels are the same truth, already computed,
 * and at a resolution where reading them is unambiguous — so the estimate is
 * gated on that resolution and declines rather than guesses (see
 * {@link MIN_INK_EM_PX} and {@link inkColor}).
 */
export interface FragmentColors {
  /** The flat colour behind the glyphs, when a flat colour fits the area. */
  fill?: string;
  /** The glyphs' own colour, when the raster resolves it confidently. */
  ink?: string;
}

export type PageColors = ReadonlyMap<number, FragmentColors>;

/** Shared empty result, so `peekPageColors` is referentially stable for pages
 * that haven't been sampled (React's `useSyncExternalStore` compares
 * snapshots). */
export const NO_COLORS: PageColors = new Map();

/**
 * Pixels per PDF unit for the exporter's own sampling raster.
 *
 * Only used when a page was never on screen (a restored session exported
 * without scrolling to it) — normally the app offers the raster it already
 * painted. Generous enough that {@link MIN_INK_EM_PX} admits even small type on
 * that path (6pt at this scale is an 18px em), for the same reason
 * `REDACT_SCALE` is: the raster is transient, and being short of resolution
 * costs fidelity that nothing downstream can recover.
 */
const SAMPLE_SCALE = 3;

/**
 * How many pixels tall a fragment's em box must be before its ink is read.
 *
 * Ink is the colour furthest from the background, which is the glyph interior —
 * *if* any pixel is fully covered by a glyph. A stem is around a tenth of an em
 * wide, so below some resolution every pixel in the box is a blend and the
 * furthest one is a washed-out grey. Measured on Helvetica, black on white,
 * with this gate off:
 *
 *   px per unit │  6pt      8pt      10pt     14pt   24pt
 *   ────────────┼───────────────────────────────────────────
 *   0.76        │ #9d9d9d  #7b7b7b  #5c5c5c  exact  exact
 *   1.95        │ exact    exact    exact    exact  exact
 *   5.85        │ exact    exact    exact    exact  exact
 *
 * So the threshold is the em box, not the page scale — 14pt at 0.76 (a 10.6px
 * em) reads exactly while 10pt at the same scale (7.6px) does not. 12px sits
 * above every washed reading with margin and admits every exact one. Getting
 * this wrong in the permissive direction is the expensive way: it redraws
 * ordinary black text in grey, a regression on the overwhelmingly common
 * document in service of the rare one. Declining just leaves black, which is
 * where this started.
 */
const MIN_INK_EM_PX = 12;

/**
 * How much of the corner samples one colour must own to count as the background.
 *
 * High, because the alternative is white and white is right on paper. A fragment
 * straddling the edge of a panel splits its corners roughly evenly, which lands
 * well under this and is declined — filling half of a boundary with the wrong
 * colour is worse than the white it replaces.
 */
const MIN_BG_SHARE = 0.7;

/** Smallest share of the glyph box a colour must own to be taken for ink, and
 * how far from the background it must sit. Together they reject a thin or faint
 * reading instead of guessing at it. */
const MIN_INK_SHARE = 0.02;
const MIN_INK_DISTANCE = 60;

/** Corner patch size, as a fraction of the glyph box. Small enough to stay in
 * the ascender/descender space at the ends of a line — which is background on
 * all but the most crowded text — and large enough to out-vote a stem that
 * happens to clip one. */
const CORNER = 0.18;

interface DocColors {
  ready: Map<number, PageColors>;
  pending: Map<number, Promise<PageColors>>;
}

const docs = new WeakMap<ArrayBuffer, DocColors>();
const listeners = new Set<() => void>();

function entry(bytes: ArrayBuffer): DocColors {
  let d = docs.get(bytes);
  if (!d) {
    d = { ready: new Map(), pending: new Map() };
    docs.set(bytes, d);
  }
  return d;
}

/** Subscribe to "a page's colours just became known". */
export function subscribeColors(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Synchronous read; `NO_COLORS` until the page has been sampled. */
export function peekPageColors(bytes: ArrayBuffer, pageIndex: number): PageColors {
  return docs.get(bytes)?.ready.get(pageIndex) ?? NO_COLORS;
}

function publish(bytes: ArrayBuffer, pageIndex: number, found: PageColors): PageColors {
  entry(bytes).ready.set(pageIndex, found);
  for (const fn of listeners) fn();
  return found;
}

/**
 * Sample from a canvas the app has *already* painted.
 *
 * This is what keeps the overlay and the exported file in agreement. Both read
 * this one cache, and a page the user has looked at fills it from the very
 * raster they were looking at — so for every page where a disagreement could be
 * noticed, there is only one measurement to disagree with.
 *
 * Not free, and therefore not called on every paint: one full-page
 * `getImageData` plus the per-fragment tallies measured 18ms median on a 1.1M px
 * canvas and 63ms median (146ms worst) on a 4.6M px one — per page, on the main
 * thread. Paying that while scrolling, for pages nobody edits, is several
 * dropped frames each to serve a case that may never arrive, so `PageView` calls
 * this only once a fragment on the page is actually shown. Callers may call it
 * freely: it returns immediately if the page is already sampled.
 */
export function offerPageCanvas(
  bytes: ArrayBuffer,
  pageData: PageData,
  canvas: HTMLCanvasElement,
): void {
  const d = entry(bytes);
  if (d.ready.has(pageData.pageIndex) || !canvas.width) return;
  const scale = canvas.width / pageData.viewBox.width;
  const found = sampleColors(canvas, pageData, scale);
  if (found) publish(bytes, pageData.pageIndex, found);
}

/**
 * A page's fragment colours, rasterising the page if nothing has offered one.
 *
 * Safe to call repeatedly and from anywhere: concurrent callers share one
 * in-flight sample, and any failure resolves to `NO_COLORS` so callers fall back
 * to white and black. A failure is deliberately not cached — like the font
 * harvest, it depends on a render that a teardown can cancel.
 */
export function readPageColors(bytes: ArrayBuffer, pageData: PageData): Promise<PageColors> {
  const d = entry(bytes);
  const done = d.ready.get(pageData.pageIndex);
  if (done) return Promise.resolve(done);
  let p = d.pending.get(pageData.pageIndex);
  if (!p) {
    p = renderPageToCanvas(bytes, pageData.pageIndex, SAMPLE_SCALE)
      .then((canvas) => {
        const found = sampleColors(canvas, pageData, SAMPLE_SCALE) ?? NO_COLORS;
        // Hand the backing store back; this raster is never shown.
        canvas.width = 0;
        canvas.height = 0;
        return publish(bytes, pageData.pageIndex, found);
      })
      .catch(() => NO_COLORS)
      .finally(() => d.pending.delete(pageData.pageIndex));
    d.pending.set(pageData.pageIndex, p);
  }
  return p;
}

/**
 * Read the background and ink colour of every fragment on a rendered page.
 *
 * The background is taken from the four corners of the glyph box, not the box as
 * a whole and not a ring around it. The box as a whole answers with the *text's*
 * colour on any fragment whose ink covers more than half of it — and a cover
 * painted in the text colour makes the replacement invisible, which is worse
 * than a white box. A ring outside the box escapes a tightly-fitting pill and
 * comes back with whatever surrounds the pill. The corners are inside the box
 * (so inside the pill) and in the ascender/descender space at the ends of the
 * line, which is background on all but the most crowded text.
 *
 * Ink is then the colour furthest from that background with a real presence in
 * the box — the glyph interiors, since antialiased edges are blends that lie
 * between the two and can never be the extreme.
 *
 * `scale` is pixels per PDF unit for this canvas. Returns null if the pixels
 * can't be read at all.
 */
export function sampleColors(
  canvas: HTMLCanvasElement,
  pageData: PageData,
  scale: number,
): PageColors | null {
  // A rotated page's raster is rotated but its fragment transforms are not, and
  // nothing in this app reconciles the two. Sampling one reads whatever happens
  // to be at the mis-mapped coordinates and reports it with full confidence: on
  // a /Rotate 90 or 180 test page, black text on white paper came back with a
  // *black* background, so an edit would have painted a black rectangle over
  // white paper and drawn black text on it. Declining leaves white and black,
  // which is wrong in the same way the overlay position is already wrong there,
  // and no worse.
  if (pageData.rotation !== 0) return null;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx || !canvas.width || !canvas.height) return null;
  let image: ImageData;
  try {
    image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  } catch {
    return null;
  }

  const H = pageData.viewBox.height;
  const found = new Map<number, FragmentColors>();
  for (const fragment of pageData.fragments) {
    const size = fragmentSize(fragment);
    const box = toPixels(glyphBox(fragment, size), H, scale);
    const background = dominant(image, cornersOf(box));
    if (!background || background.share < MIN_BG_SHARE) continue;
    const ink = inkColor(image, box, background.key, size * scale);
    found.set(fragment.itemIndex, { fill: hex(background.key), ...(ink ? { ink } : {}) });
  }
  return found;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A fragment's glyph box in PDF units — the area its cover has to hide. Kept
 * in step with the cover the exporter draws (0.98em up, 0.22em down). */
function glyphBox(fragment: TextFragment, size: number): Box {
  return {
    x: fragment.transform[4],
    y: fragment.transform[5] - size * 0.22,
    w: Math.max(fragment.width, size * 0.5),
    h: size * 1.2,
  };
}

/** PDF units (origin bottom-left) → canvas pixels (origin top-left). */
function toPixels(box: Box, pageHeight: number, scale: number): Box {
  return {
    x: box.x * scale,
    y: (pageHeight - (box.y + box.h)) * scale,
    w: box.w * scale,
    h: box.h * scale,
  };
}

/** The four corner patches of a box. */
function cornersOf(box: Box): Box[] {
  const w = Math.max(1, box.w * CORNER);
  const h = Math.max(1, box.h * CORNER);
  return [
    { x: box.x, y: box.y, w, h },
    { x: box.x + box.w - w, y: box.y, w, h },
    { x: box.x, y: box.y + box.h - h, w, h },
    { x: box.x + box.w - w, y: box.y + box.h - h, w, h },
  ];
}

/** The most common opaque colour across some regions, and the share of them it
 * owns. Regions are clamped to the canvas; null if they all fall outside it. */
function dominant(image: ImageData, boxes: Box[]): { key: number; share: number } | null {
  const counts = new Map<number, number>();
  let total = 0;
  for (const box of boxes) total += tally(image, box, counts);
  if (!total) return null;

  let best = -1;
  let bestCount = 0;
  for (const [key, n] of counts) {
    if (n > bestCount) {
      best = key;
      bestCount = n;
    }
  }
  return best < 0 ? null : { key: best, share: bestCount / total };
}

/**
 * The colour in `box` furthest from `bgKey`, if the raster can be trusted to
 * carry it: enough resolution for solid glyph interiors (`emPx`, see
 * {@link MIN_INK_EM_PX}), enough pixels of that colour to be a glyph rather than
 * an artefact, and far enough from the background to be a deliberate choice
 * rather than a blend.
 */
function inkColor(
  image: ImageData,
  box: Box,
  bgKey: number,
  emPx: number,
): string | undefined {
  if (emPx < MIN_INK_EM_PX) return undefined;
  const counts = new Map<number, number>();
  const total = tally(image, box, counts);
  if (!total) return undefined;

  const floor = total * MIN_INK_SHARE;
  let best = -1;
  let bestDistance = 0;
  for (const [key, n] of counts) {
    if (n < floor) continue;
    const d = distance(key, bgKey);
    if (d > bestDistance) {
      best = key;
      bestDistance = d;
    }
  }
  return best >= 0 && bestDistance >= MIN_INK_DISTANCE ? hex(best) : undefined;
}

/** Count opaque colours in a region into `counts`; returns how many it added. */
function tally(image: ImageData, box: Box, counts: Map<number, number>): number {
  const x0 = Math.max(0, Math.floor(box.x));
  const y0 = Math.max(0, Math.floor(box.y));
  const x1 = Math.min(image.width, Math.ceil(box.x + box.w));
  const y1 = Math.min(image.height, Math.ceil(box.y + box.h));
  if (x1 <= x0 || y1 <= y0) return 0;

  const data = image.data;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    let i = (y * image.width + x0) * 4;
    for (let x = x0; x < x1; x++, i += 4) {
      // A transparent pixel is not a colour anything can be matched against.
      if (data[i + 3] < 255) continue;
      const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
      counts.set(key, (counts.get(key) ?? 0) + 1);
      n++;
    }
  }
  return n;
}

/** Euclidean RGB distance (black to white is ~441). */
function distance(a: number, b: number): number {
  const dr = ((a >> 16) & 255) - ((b >> 16) & 255);
  const dg = ((a >> 8) & 255) - ((b >> 8) & 255);
  const db = (a & 255) - (b & 255);
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

function hex(key: number): string {
  return `#${key.toString(16).padStart(6, "0")}`;
}
