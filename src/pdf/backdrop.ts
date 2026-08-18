import { renderPageToCanvas } from "./loader";
import { fragmentSize } from "./style";
import type { PageData, TextFragment } from "./types";

/**
 * The colour behind each text fragment, per page, keyed by text-item index.
 *
 * Editing a fragment means covering the original glyphs before redrawing, and
 * that cover used to be hardcoded white. On white paper it is invisible; inside
 * a coloured pill, a table cell, or a banner it punches a white hole through the
 * artwork — the rest of the page survives an edit untouched (a non-redacted page
 * is copied verbatim and the edit drawn on top), so the cover was the only thing
 * damaging it.
 *
 * A single flat colour is the honest ceiling for a rectangular cover, so this
 * samples one and reports nothing at all when one wouldn't do — see
 * {@link sampleBackdrops}. Callers fall back to white, which is where they
 * started.
 *
 * Lazy and per page, like `fontInfo.ts`, and for the same reason: the pixels
 * only exist once a page has been rasterised, and rasterising a 150-page
 * document up front to learn its colours would cost more than the load.
 */
export type PageBackdrops = ReadonlyMap<number, string>;

/** Shared empty result, so `peekPageBackdrops` is referentially stable for
 * pages that haven't been sampled (React's `useSyncExternalStore` compares
 * snapshots). */
export const NO_BACKDROPS: PageBackdrops = new Map();

/**
 * Pixels per PDF unit for the exporter's own sampling raster.
 *
 * Only used when a page was never on screen (a restored session exported
 * without scrolling to the page). Colours don't need detail: the flat fill this
 * looks for is exact in every unblended pixel, and there are far more of those
 * than antialiased edge ones at any scale.
 */
const SAMPLE_SCALE = 1;

/**
 * How much of the wider area one colour must own before it counts as "the
 * background". Below this the region is busy — a photo, a gradient, a border
 * running through it — and no single colour can stand in for it.
 */
const MIN_SHARE = 0.5;

/** How far outside the glyph box the second sample reaches, in em. */
const INFLATE = 0.3;

interface DocBackdrops {
  ready: Map<number, PageBackdrops>;
  pending: Map<number, Promise<PageBackdrops>>;
}

const docs = new WeakMap<ArrayBuffer, DocBackdrops>();
const listeners = new Set<() => void>();

function entry(bytes: ArrayBuffer): DocBackdrops {
  let d = docs.get(bytes);
  if (!d) {
    d = { ready: new Map(), pending: new Map() };
    docs.set(bytes, d);
  }
  return d;
}

/** Subscribe to "a page's backdrop colours just became known". */
export function subscribeBackdrops(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Synchronous read; `NO_BACKDROPS` until the page has been sampled. */
export function peekPageBackdrops(bytes: ArrayBuffer, pageIndex: number): PageBackdrops {
  return docs.get(bytes)?.ready.get(pageIndex) ?? NO_BACKDROPS;
}

function publish(bytes: ArrayBuffer, pageIndex: number, found: PageBackdrops): PageBackdrops {
  entry(bytes).ready.set(pageIndex, found);
  for (const fn of listeners) fn();
  return found;
}

/**
 * Sample from a canvas the app has *already* painted.
 *
 * This is what keeps the overlay and the exported file the same colour. Both
 * read this one cache, and a page the user has looked at fills it from the very
 * raster they were looking at — so for every page where a disagreement could be
 * noticed, there is only one measurement to disagree with. Cheap enough to be
 * unconditional: no extra render, one `getImageData`, once per page.
 */
export function offerPageCanvas(
  bytes: ArrayBuffer,
  pageData: PageData,
  canvas: HTMLCanvasElement,
): void {
  const d = entry(bytes);
  if (d.ready.has(pageData.pageIndex) || !canvas.width) return;
  const scale = canvas.width / pageData.viewBox.width;
  const found = sampleBackdrops(canvas, pageData, scale);
  if (found) publish(bytes, pageData.pageIndex, found);
}

/**
 * A page's backdrop colours, rasterising the page if nothing has offered one.
 *
 * Safe to call repeatedly and from anywhere: concurrent callers share one
 * in-flight sample, and any failure resolves to `NO_BACKDROPS` so callers fall
 * back to white. A failure is deliberately not cached — like the font harvest,
 * it depends on a render that a teardown can cancel.
 */
export function readPageBackdrops(
  bytes: ArrayBuffer,
  pageData: PageData,
): Promise<PageBackdrops> {
  const d = entry(bytes);
  const done = d.ready.get(pageData.pageIndex);
  if (done) return Promise.resolve(done);
  let p = d.pending.get(pageData.pageIndex);
  if (!p) {
    p = renderPageToCanvas(bytes, pageData.pageIndex, SAMPLE_SCALE)
      .then((canvas) => {
        const found = sampleBackdrops(canvas, pageData, SAMPLE_SCALE) ?? NO_BACKDROPS;
        // Hand the backing store back; this raster is never shown.
        canvas.width = 0;
        canvas.height = 0;
        return publish(bytes, pageData.pageIndex, found);
      })
      .catch(() => NO_BACKDROPS)
      .finally(() => d.pending.delete(pageData.pageIndex));
    d.pending.set(pageData.pageIndex, p);
  }
  return p;
}

/**
 * Find the flat colour behind each fragment on a rendered page, or leave the
 * fragment out when there isn't one.
 *
 * Each fragment is measured twice: over its own glyph box, and over a box
 * inflated by {@link INFLATE}em. Taking the most common colour of the glyph box
 * alone would happily return the *text's* colour on any fragment whose ink
 * covers more than half of it — and filling the cover with the text colour makes
 * the replacement invisible, which is worse than a white box. The wider sample
 * contains strictly more background and no more ink, so requiring the two to
 * agree is what tells ink and background apart. The wider one must also be
 * clearly dominated by that colour, or the area is busy and no flat fill will do.
 *
 * `scale` is pixels per PDF unit for this canvas. Returns null if the pixels
 * can't be read at all.
 */
export function sampleBackdrops(
  canvas: HTMLCanvasElement,
  pageData: PageData,
  scale: number,
): PageBackdrops | null {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx || !canvas.width || !canvas.height) return null;
  let image: ImageData;
  try {
    image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  } catch {
    return null;
  }

  const H = pageData.viewBox.height;
  const found = new Map<number, string>();
  for (const fragment of pageData.fragments) {
    const size = fragmentSize(fragment);
    const inner = glyphBox(fragment, size);
    const outer = {
      x: inner.x - size * INFLATE,
      y: inner.y - size * INFLATE,
      w: inner.w + size * INFLATE * 2,
      h: inner.h + size * INFLATE * 2,
    };
    const near = dominant(image, toPixels(inner, H, scale));
    const wide = dominant(image, toPixels(outer, H, scale));
    if (!near || !wide) continue;
    if (near.key !== wide.key || wide.share < MIN_SHARE) continue;
    found.set(fragment.itemIndex, hex(wide.key));
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

/** The most common opaque colour in a region, and the share of the region it
 * owns. Clamped to the canvas; null if the region falls outside it. */
function dominant(
  image: ImageData,
  box: Box,
): { key: number; share: number } | null {
  const x0 = Math.max(0, Math.floor(box.x));
  const y0 = Math.max(0, Math.floor(box.y));
  const x1 = Math.min(image.width, Math.ceil(box.x + box.w));
  const y1 = Math.min(image.height, Math.ceil(box.y + box.h));
  if (x1 <= x0 || y1 <= y0) return null;

  const counts = new Map<number, number>();
  const data = image.data;
  let total = 0;
  for (let y = y0; y < y1; y++) {
    let i = (y * image.width + x0) * 4;
    for (let x = x0; x < x1; x++, i += 4) {
      // A transparent pixel is not a colour anything can be matched against.
      if (data[i + 3] < 255) continue;
      const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
      counts.set(key, (counts.get(key) ?? 0) + 1);
      total++;
    }
  }
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

function hex(key: number): string {
  return `#${key.toString(16).padStart(6, "0")}`;
}
