import * as pdfjsLib from "pdfjs-dist";
// Vite resolves this to a hashed URL for the worker bundle.
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { TextItem, TextStyle } from "pdfjs-dist/types/src/display/api";
import { cropOffset, shownSize } from "./pagePlan";
import type { CropRect, FormField, LoadedPdf, PageData, TextFragment } from "./types";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

/**
 * True if the bytes look like a PDF. The MIME type a browser reports is
 * unreliable (empty for many drag-drops, and trivially wrong for a renamed
 * file), so we sniff the actual content: a PDF begins with the `%PDF-`
 * signature. The spec allows a little leading junk, so scan the first 1 KB.
 */
export function looksLikePdf(bytes: ArrayBuffer): boolean {
  const head = new Uint8Array(bytes.slice(0, 1024));
  const sig = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"
  outer: for (let i = 0; i + sig.length <= head.length; i++) {
    for (let j = 0; j < sig.length; j++) {
      if (head[i + j] !== sig[j]) continue outer;
    }
    return true;
  }
  return false;
}

/**
 * Parse a PDF into per-page editable text fragments.
 *
 * We keep the raw bytes around: unedited content is preserved by exporting
 * from the original file and only redrawing fragments the user changed.
 */
export async function loadPdf(bytes: ArrayBuffer): Promise<LoadedPdf> {
  // pdf.js transfers/detaches the buffer it parses, so hand it a copy and
  // keep the pristine original for export.
  const parseCopy = bytes.slice(0);
  const doc = await pdfjsLib.getDocument({ data: parseCopy }).promise;
  const pages: PageData[] = [];

  for (let p = 0; p < doc.numPages; p++) {
    const page = await doc.getPage(p + 1);
    // Unturned: the page's own user space, which is what text transforms and
    // every overlay object are measured in. The turn is applied at render.
    const viewport = page.getViewport({ scale: 1, rotation: 0 });
    // The view need not start at the user-space origin (a CropBox of
    // [100 200 …]). Everything read off the page is moved into view space
    // here, once, so nothing downstream has to know; the exporter moves it back.
    const ox = page.view[0] ?? 0;
    const oy = page.view[1] ?? 0;
    const content = await page.getTextContent();
    const fragments: TextFragment[] = [];

    content.items.forEach((raw, itemIndex) => {
      const item = raw as TextItem;
      // Skip whitespace-only fragments; they carry no editable glyphs and
      // clutter the overlay.
      if (!item.str || item.str.trim() === "") return;

      const style: TextStyle | undefined = content.styles[item.fontName];
      fragments.push({
        id: `${p}:${itemIndex}`,
        pageIndex: p,
        itemIndex,
        original: item.str,
        transform: ox || oy ? [...item.transform.slice(0, 4), item.transform[4] - ox, item.transform[5] - oy] : item.transform,
        width: item.width,
        height: item.height,
        fontFamily: style?.fontFamily ?? "sans-serif",
        ...(item.dir === "rtl" ? { rtl: true } : {}),
      });
    });

    // AcroForm widgets → editable form fields (text + checkbox only).
    const fields: FormField[] = [];
    try {
      const annots = await page.getAnnotations();
      annots.forEach((a: Record<string, unknown>, k: number) => {
        if (a.subtype !== "Widget") return;
        const ft = a.fieldType as string | undefined;
        const rect = a.rect as number[] | undefined;
        if (!rect || rect.length < 4) return;
        const x = Math.min(rect[0], rect[2]) - ox;
        const y = Math.min(rect[1], rect[3]) - oy;
        const width = Math.abs(rect[2] - rect[0]);
        const height = Math.abs(rect[3] - rect[1]);
        const name = (a.fieldName as string) || `field-${p}-${k}`;
        const base = { id: `${p}:field:${k}`, name, pageIndex: p, rect: { x, y, width, height }, readOnly: !!a.readOnly };
        if (ft === "Tx") {
          fields.push({ ...base, type: "text", defaultValue: String(a.fieldValue ?? ""), multiline: !!a.multiLine });
        } else if (ft === "Btn" && a.checkBox) {
          const on = a.fieldValue != null && a.fieldValue !== "Off" && a.fieldValue !== false;
          fields.push({ ...base, type: "checkbox", defaultValue: on });
        }
      });
    } catch {
      /* Annotation parsing is best-effort; ignore malformed forms. */
    }

    pages.push({
      pageIndex: p,
      viewBox: { width: viewport.width, height: viewport.height },
      ...(ox || oy ? { origin: { x: ox, y: oy } } : {}),
      rotation: ((page.rotate % 360) + 360) % 360,
      fragments,
      fields,
      ref: page.ref ? { num: page.ref.num, gen: page.ref.gen } : null,
    });
  }

  await doc.destroy();
  return { bytes, pages };
}

/** A page render in progress, with a way to abort it. */
export interface RenderHandle {
  /** Resolves when the page has painted; rejects on error or cancellation. */
  promise: Promise<void>;
  /** Abort the render. Safe to call at any point (before or during paint). */
  cancel: () => void;
}

/** True if an error is pdf.js's benign "this render was cancelled" signal. */
export function isRenderCancelled(err: unknown): boolean {
  return !!err && typeof err === "object" && (err as { name?: string }).name === "RenderingCancelledException";
}

/**
 * Render one page to a canvas at the given scale.
 *
 * Returns a {@link RenderHandle} rather than a bare promise: pdf.js throws
 * "Cannot use the same canvas during multiple render() operations" if a second
 * `render()` starts on a canvas whose previous render is still in flight. That
 * happens whenever the inputs change mid-render — e.g. merging in another PDF
 * swaps `bytes` while pages are still painting. Callers must `cancel()` the
 * previous handle before starting a new render on the same canvas so the
 * in-flight pdf.js task is torn down first.
 */
/** The most pixels a page canvas gets: 256 MB of RGBA, well under Chrome's
 * limit and above anything an uncropped page asked for at the deepest zoom. */
const MAX_CANVAS_PX = 2 ** 26;

export function renderPage(
  bytes: ArrayBuffer,
  pageIndex: number,
  canvas: HTMLCanvasElement,
  scale: number,
  /** Clockwise degrees to show the page at — absolute, not added to the
   * page's own `/Rotate` (`PageData.rotation` already includes it). */
  rotation: number,
): RenderHandle {
  let cancelled = false;
  let task: { cancel: () => void } | null = null;

  const promise = (async () => {
    const doc = await getCachedDoc(bytes);
    if (cancelled) return;
    const page = await doc.getPage(pageIndex + 1);
    if (cancelled) return;
    const viewport = page.getViewport({ scale, rotation });
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Could not get 2D canvas context");

    // Backing store at scale × devicePixelRatio; the element's display size is
    // controlled by CSS (the page container), so we don't touch canvas.style.
    // Capped in area: a narrow crop fits its *window* to the screen, so the
    // whole sheet behind it can ask for more pixels than a canvas may hold —
    // past that the browser paints nothing at all. Fewer pixels only soften
    // an extreme zoom; everything else reads the canvas by its own size.
    const want = viewport.width * viewport.height * (window.devicePixelRatio || 1) ** 2;
    const dpr = (window.devicePixelRatio || 1) * Math.min(1, Math.sqrt(MAX_CANVAS_PX / want));
    canvas.width = Math.max(1, Math.floor(viewport.width * dpr));
    canvas.height = Math.max(1, Math.floor(viewport.height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const renderTask = page.render({ canvasContext: ctx, viewport });
    task = renderTask;
    await renderTask.promise;
  })();

  return {
    promise,
    cancel: () => {
      cancelled = true;
      task?.cancel();
    },
  };
}

/** Cache of parsed pdf.js documents keyed by the original byte buffer, so
 * repeated re-renders (e.g. during zoom) don't reparse the whole file. */
const docCache = new WeakMap<ArrayBuffer, Promise<pdfjsLib.PDFDocumentProxy>>();

/** The parsed document behind the on-screen rendering of `bytes`.
 *
 * Exported for `fontInfo.ts`, which must read fonts back out of *this* parse:
 * pdf.js registers each embedded font under a `loadedName` that is only valid
 * within the `getDocument()` call that produced it, and only that call's faces
 * are the ones painted on the canvas the overlay sits on. */
export function getCachedDoc(bytes: ArrayBuffer): Promise<pdfjsLib.PDFDocumentProxy> {
  let doc = docCache.get(bytes);
  if (!doc) {
    doc = pdfjsLib.getDocument({ data: bytes.slice(0) }).promise;
    docCache.set(bytes, doc);
  }
  return doc;
}

/** Free the parse behind `bytes` — its worker-side document, fonts and page
 * caches. Called when a tab closes: the cache is a WeakMap, but the pdf.js
 * *worker* holds its own copy of every document it has opened until it is told
 * to let go, so without this each closed tab stayed resident for the life of
 * the page. A later `getCachedDoc` for the same bytes simply parses again. */
export function releaseDoc(bytes: ArrayBuffer): void {
  const doc = docCache.get(bytes);
  if (!doc) return;
  docCache.delete(bytes);
  void doc.then((d) => d.destroy()).catch(() => {});
}

/**
 * Render a page to a fresh canvas at an exact pixel scale (no devicePixelRatio
 * fiddling). Used at export time to rasterise pages that contain redactions.
 */
export async function renderPageToCanvas(
  bytes: ArrayBuffer,
  pageIndex: number,
  scale: number,
  /** Abandon the render: a thumbnail scrolled out of the window before its
   * turn came. Rejects with an `AbortError`, stops pdf.js mid-paint, and frees
   * the half-drawn canvas. */
  signal?: AbortSignal,
  /** Clockwise degrees, absolute. Omitted: the page as the file shows it (its
   * own `/Rotate`). Pass 0 for the page's unturned user space — what anything
   * drawing overlay objects onto the raster needs. */
  rotation?: number,
): Promise<HTMLCanvasElement> {
  const aborted = () => new DOMException("Render abandoned", "AbortError");
  if (signal?.aborted) throw aborted();
  // Reuse the cached parse instead of re-reading (and re-cloning) the whole
  // file on every call. OCR and redaction-rasterisation call this once per
  // page; a fresh getDocument()+slice per page turned an N-page document into
  // N full parses and N buffer copies — the dominant cost (and a common
  // out-of-memory / timeout cause) on large or image-heavy PDFs.
  const doc = await getCachedDoc(bytes);
  if (signal?.aborted) throw aborted();
  const page = await doc.getPage(pageIndex + 1);
  if (signal?.aborted) throw aborted();
  const viewport = page.getViewport(rotation === undefined ? { scale } : { scale, rotation });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not get 2D canvas context");
  const task = page.render({ canvasContext: ctx, viewport });
  const stop = () => task.cancel();
  signal?.addEventListener("abort", stop, { once: true });
  try {
    await task.promise;
  } catch (err) {
    canvas.width = canvas.height = 0;
    throw signal?.aborted ? aborted() : err;
  } finally {
    signal?.removeEventListener("abort", stop);
  }
  if (signal?.aborted) {
    canvas.width = canvas.height = 0;
    throw aborted();
  }
  return canvas;
}

/** "/Encrypt" — appears in the trailer (or xref-stream dictionary) of every
 * encrypted file. Those dictionaries are never compressed, so a byte scan finds
 * it; a stray match in some uncompressed content only costs a needless parse. */
const MARK = [0x2f, 0x45, 0x6e, 0x63, 0x72, 0x79, 0x70, 0x74];

/** Whether a file may be encrypted, and so must go through `unlockPdf`
 * (`pdf/decrypt.ts`) before anything else reads it. */
export function mayBeEncrypted(bytes: ArrayBuffer): boolean {
  const b = new Uint8Array(bytes);
  const last = b.length - MARK.length;
  outer: for (let i = 0; i <= last; i++) {
    if (b[i] !== 0x2f) continue;
    for (let k = 1; k < MARK.length; k++) if (b[i + k] !== MARK[k]) continue outer;
    return true;
  }
  return false;
}

/**
 * A page render cut down to a crop (`PageRef.crop`, view space). The render is
 * the page as the file turns it, so the crop is turned the same way before it's
 * cut out. The full render's backing store is given back.
 */
export async function cutToCrop(
  bytes: ArrayBuffer,
  pageIndex: number,
  full: HTMLCanvasElement,
  scale: number,
  crop: CropRect,
): Promise<HTMLCanvasElement> {
  const page = await (await getCachedDoc(bytes)).getPage(pageIndex + 1);
  const unturned = page.getViewport({ scale: 1, rotation: 0 });
  const shape = { viewBox: { width: unturned.width, height: unturned.height }, rotation: ((page.rotate % 360) + 360) % 360, crop };
  const o = cropOffset(shape);
  const size = shownSize(shape);
  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.round(size.width * scale));
  out.height = Math.max(1, Math.round(size.height * scale));
  out.getContext("2d")?.drawImage(full, o.x * scale, o.y * scale, size.width * scale, size.height * scale, 0, 0, out.width, out.height);
  full.width = full.height = 0;
  return out;
}
