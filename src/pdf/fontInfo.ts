import type { TextItem } from "pdfjs-dist/types/src/display/api";
import { getCachedDoc } from "./loader";
import { guessStyleFromFontFamily } from "./style";
import type { FragmentFont } from "./types";

/**
 * The document's own fonts, per page, keyed by text-item index.
 *
 * `loadPdf` can't provide this. The only font information `getTextContent()`
 * carries is pdf.js's `fallbackName` — "sans-serif", "serif" or "monospace" and
 * nothing else — so an edited fragment lost its typeface *and* its weight the
 * moment it was redrawn. The real font object (with the loaded CSS face pdf.js
 * paints with, plus the descriptor's bold/italic flags) only exists on the main
 * thread once the page has actually rendered, which is why this is a lazy,
 * per-page side channel rather than part of the initial parse: rendering 150
 * pages up front to learn their fonts would cost more than the whole load.
 */
export type PageFonts = ReadonlyMap<number, FragmentFont>;

/** Shared empty result, so `peekPageFonts` is referentially stable for pages
 * that have no fonts yet (React's `useSyncExternalStore` compares snapshots). */
export const NO_FONTS: PageFonts = new Map();

interface DocFonts {
  ready: Map<number, PageFonts>;
  pending: Map<number, Promise<PageFonts>>;
}

const docs = new WeakMap<ArrayBuffer, DocFonts>();
const listeners = new Set<() => void>();

function entry(bytes: ArrayBuffer): DocFonts {
  let d = docs.get(bytes);
  if (!d) {
    d = { ready: new Map(), pending: new Map() };
    docs.set(bytes, d);
  }
  return d;
}

/** Subscribe to "a page's fonts just became known". */
export function subscribeFonts(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Synchronous read; `NO_FONTS` until the page has been harvested. */
export function peekPageFonts(bytes: ArrayBuffer, pageIndex: number): PageFonts {
  return docs.get(bytes)?.ready.get(pageIndex) ?? NO_FONTS;
}

/**
 * Harvest a page's fonts (once). Safe to call repeatedly and from anywhere:
 * concurrent callers share one in-flight read, and any failure resolves to
 * `NO_FONTS` so callers just fall back to the generic family.
 */
export function readPageFonts(bytes: ArrayBuffer, pageIndex: number): Promise<PageFonts> {
  const d = entry(bytes);
  const done = d.ready.get(pageIndex);
  if (done) return Promise.resolve(done);
  let p = d.pending.get(pageIndex);
  if (!p) {
    p = harvest(bytes, pageIndex)
      .catch(() => NO_FONTS)
      .then((fonts) => {
        d.pending.delete(pageIndex);
        d.ready.set(pageIndex, fonts);
        for (const fn of listeners) fn();
        return fonts;
      });
    d.pending.set(pageIndex, p);
  }
  return p;
}

async function harvest(bytes: ArrayBuffer, pageIndex: number): Promise<PageFonts> {
  const doc = await getCachedDoc(bytes);
  const page = await doc.getPage(pageIndex + 1);
  const content = await page.getTextContent();

  // Item index -> pdf.js font id. Indices line up with `loadPdf`'s: both walk
  // the same `getTextContent()` array with the same options, and `loadPdf`
  // records the raw index even for the whitespace items it drops.
  const names = new Map<number, string>();
  content.items.forEach((raw, i) => {
    const name = (raw as TextItem).fontName;
    if (typeof name === "string") names.set(i, name);
  });

  await ensureFontsLoaded(page, new Set(names.values()));

  const byName = new Map<string, FragmentFont | null>();
  const fonts = new Map<number, FragmentFont>();
  for (const [i, name] of names) {
    if (!byName.has(name)) byName.set(name, describe(page, name));
    const info = byName.get(name);
    if (info) fonts.set(i, info);
  }
  return fonts;
}

/**
 * Make sure this page's fonts have reached the main thread.
 *
 * They arrive as a side effect of rendering, so normally the caller (a page
 * that just painted) finds them already there. The exporter can't assume that,
 * hence the tiny throwaway render — font loading is scale-independent, and
 * `getOperatorList()` alone doesn't populate `commonObjs` in the worker build.
 */
async function ensureFontsLoaded(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  page: any,
  names: Set<string>,
): Promise<void> {
  if ([...names].every((n) => page.commonObjs.has(n))) return;
  const viewport = page.getViewport({ scale: 0.2 });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(viewport.width));
  canvas.height = Math.max(1, Math.ceil(viewport.height));
  const ctx = canvas.getContext("2d");
  if (ctx) await page.render({ canvasContext: ctx, viewport }).promise;
  // Hand the backing store straight back; this raster is never shown.
  canvas.width = 0;
  canvas.height = 0;
}

/**
 * Describe one loaded font.
 *
 * The `css`/`weight`/`slant` triple mirrors what pdf.js's own canvas renderer
 * builds for `ctx.font`, so text drawn with it lands on the page looking like
 * the text beside it. Embedded faces are registered under `loadedName`;
 * substituted ones come with a ready-made `systemFontInfo.css`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function describe(page: any, name: string): FragmentFont | null {
  if (!page.commonObjs.has(name)) return null;
  // A font that failed to load resolves to an error string.
  const f = page.commonObjs.get(name);
  if (!f || typeof f !== "object") return null;

  const fallback: string = f.fallbackName || "sans-serif";
  // pdf.js sets bold/italic only for fonts it had to substitute; an embedded
  // face carries its weight itself. The name is the fallback for the abstract
  // style so a bold *embedded* heading still maps to a bold standard font when
  // the original can't be used.
  const guessed = guessStyleFromFontFamily(`${f.name ?? ""} ${fallback}`);
  return {
    css: f.systemFontInfo?.css || `"${f.loadedName}", ${fallback}`,
    weight: f.black ? "900" : f.bold ? "bold" : "normal",
    slant: f.italic ? "italic" : "normal",
    font: guessed.font,
    bold: !!f.bold || !!f.black || guessed.bold,
    italic: !!f.italic || guessed.italic,
  };
}
