import * as pdfjsLib from "pdfjs-dist";
// Vite resolves this to a hashed URL for the worker bundle.
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { TextItem, TextStyle } from "pdfjs-dist/types/src/display/api";
import type { FormField, LoadedPdf, PageData, TextFragment } from "./types";

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
    const viewport = page.getViewport({ scale: 1 });
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
        transform: item.transform,
        width: item.width,
        height: item.height,
        fontFamily: style?.fontFamily ?? "sans-serif",
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
        const x = Math.min(rect[0], rect[2]);
        const y = Math.min(rect[1], rect[3]);
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
      fragments,
      fields,
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
export function renderPage(
  bytes: ArrayBuffer,
  pageIndex: number,
  canvas: HTMLCanvasElement,
  scale: number,
): RenderHandle {
  let cancelled = false;
  let task: { cancel: () => void } | null = null;

  const promise = (async () => {
    const doc = await getCachedDoc(bytes);
    if (cancelled) return;
    const page = await doc.getPage(pageIndex + 1);
    if (cancelled) return;
    const viewport = page.getViewport({ scale });
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Could not get 2D canvas context");

    // Backing store at scale × devicePixelRatio; the element's display size is
    // controlled by CSS (the page container), so we don't touch canvas.style.
    const dpr = window.devicePixelRatio || 1;
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

function getCachedDoc(bytes: ArrayBuffer): Promise<pdfjsLib.PDFDocumentProxy> {
  let doc = docCache.get(bytes);
  if (!doc) {
    doc = pdfjsLib.getDocument({ data: bytes.slice(0) }).promise;
    docCache.set(bytes, doc);
  }
  return doc;
}

/**
 * Render a page to a fresh canvas at an exact pixel scale (no devicePixelRatio
 * fiddling). Used at export time to rasterise pages that contain redactions.
 */
export async function renderPageToCanvas(
  bytes: ArrayBuffer,
  pageIndex: number,
  scale: number,
): Promise<HTMLCanvasElement> {
  const doc = await pdfjsLib.getDocument({ data: bytes.slice(0) }).promise;
  const page = await doc.getPage(pageIndex + 1);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not get 2D canvas context");
  await page.render({ canvasContext: ctx, viewport }).promise;
  await doc.destroy();
  return canvas;
}
