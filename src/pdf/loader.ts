import * as pdfjsLib from "pdfjs-dist";
// Vite resolves this to a hashed URL for the worker bundle.
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { TextItem, TextStyle } from "pdfjs-dist/types/src/display/api";
import type { LoadedPdf, PageData, TextFragment } from "./types";

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

    pages.push({
      pageIndex: p,
      viewBox: { width: viewport.width, height: viewport.height },
      fragments,
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
  const doc = await pdfjsLib.getDocument({ data: bytes.slice(0) }).promise;
  const page = await doc.getPage(pageIndex + 1);
  const viewport = page.getViewport({ scale });
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not get 2D canvas context");

  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.floor(viewport.width * dpr);
  canvas.height = Math.floor(viewport.height * dpr);
  canvas.style.width = `${viewport.width}px`;
  canvas.style.height = `${viewport.height}px`;
  ctx.scale(dpr, dpr);

  await page.render({ canvasContext: ctx, viewport }).promise;
  await doc.destroy();
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
