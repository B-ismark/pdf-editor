import { PDFDocument } from "pdf-lib";
import { renderPageToCanvas } from "./loader";
import { sanitizeDocument } from "./sanitize";
import { loadJpegEncoder } from "./jpeg";
import { yieldToUI } from "./yield";

// Page numbering and watermark are no longer separate document-rebuild passes;
// they live in DocState and are drawn on every page at export time (see
// exporter.ts). Their option types live in ./types.

export interface CompressOptions {
  /** Raster scale (pixels per PDF point). Lower = smaller file, softer text. */
  scale: number;
  /** JPEG quality 0..1. */
  quality: number;
}

/**
 * Shrink a PDF by rasterising every page to a JPEG and rebuilding. This throws
 * away the vector/text layer (so it's best for sharing/printing, not further
 * editing) but reliably cuts size on image-heavy or bloated PDFs. Runs entirely
 * on-device, encoding with MozJPEG when available (smaller files at the same
 * quality) and the browser's JPEG encoder otherwise.
 */
export async function compressPdf(
  bytes: ArrayBuffer,
  pageSizes: { width: number; height: number }[],
  opts: CompressOptions,
  onProgress?: (page: number, total: number) => void,
): Promise<Uint8Array> {
  const out = await PDFDocument.create({ updateMetadata: false });
  const encodeJpeg = await loadJpegEncoder(opts.quality);
  for (let i = 0; i < pageSizes.length; i++) {
    onProgress?.(i + 1, pageSizes.length);
    await yieldToUI();
    const canvas = await renderPageToCanvas(bytes, i, opts.scale);
    const jpg = await encodeJpeg(canvas);
    const img = await out.embedJpg(jpg);
    const { width, height } = pageSizes[i];
    const page = out.addPage([width, height]);
    page.drawImage(img, { x: 0, y: 0, width, height });
  }
  sanitizeDocument(out);
  return out.save();
}

/** Render each page to a PNG data URL for image export. */
export async function renderImages(
  bytes: ArrayBuffer,
  pageCount: number,
  scale = 2,
  onProgress?: (page: number, total: number) => void,
): Promise<string[]> {
  const urls: string[] = [];
  for (let i = 0; i < pageCount; i++) {
    onProgress?.(i + 1, pageCount);
    await yieldToUI();
    const canvas = await renderPageToCanvas(bytes, i, scale);
    urls.push(canvas.toDataURL("image/png"));
  }
  return urls;
}
