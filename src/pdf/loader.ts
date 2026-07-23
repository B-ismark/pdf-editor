import * as pdfjsLib from "pdfjs-dist";
// Vite resolves this to a hashed URL for the worker bundle.
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { TextItem, TextStyle } from "pdfjs-dist/types/src/display/api";
import type { FormField, LoadedPdf, PageData, TextFragment } from "./types";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

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

/** Render one page to a canvas at the given scale. */
export async function renderPage(
  bytes: ArrayBuffer,
  pageIndex: number,
  canvas: HTMLCanvasElement,
  scale: number,
): Promise<void> {
  const doc = await getCachedDoc(bytes);
  const page = await doc.getPage(pageIndex + 1);
  const viewport = page.getViewport({ scale });
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not get 2D canvas context");

  // Backing store at scale × devicePixelRatio; the element's display size is
  // controlled by CSS (the page container), so we don't touch canvas.style.
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(viewport.width * dpr));
  canvas.height = Math.max(1, Math.floor(viewport.height * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  await page.render({ canvasContext: ctx, viewport }).promise;
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
