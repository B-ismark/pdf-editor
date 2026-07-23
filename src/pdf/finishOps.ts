import { PDFDocument, StandardFonts, degrees, rgb } from "pdf-lib";
import { renderPageToCanvas } from "./loader";
import { hexToRgb } from "./style";

export type NumberPosition =
  | "top-left" | "top-center" | "top-right"
  | "bottom-left" | "bottom-center" | "bottom-right";

export interface PageNumberOptions {
  position: NumberPosition;
  start: number;
  size: number;
  color: string;
}

/** Draw page numbers onto every page. */
export async function addPageNumbers(
  bytes: ArrayBuffer,
  opts: PageNumberOptions,
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes.slice(0));
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const c = hexToRgb(opts.color);
  const margin = 28;
  doc.getPages().forEach((page, i) => {
    const label = String(opts.start + i);
    const { width, height } = page.getSize();
    const tw = font.widthOfTextAtSize(label, opts.size);
    const top = opts.position.startsWith("top");
    const y = top ? height - margin - opts.size : margin;
    const x = opts.position.endsWith("left")
      ? margin
      : opts.position.endsWith("right")
        ? width - margin - tw
        : width / 2 - tw / 2;
    page.drawText(label, { x, y, size: opts.size, font, color: rgb(c.r, c.g, c.b) });
  });
  return doc.save();
}

export interface WatermarkOptions {
  text: string;
  size: number;
  color: string;
  opacity: number;
  angle: number;
}

/** Stamp a diagonal text watermark centred on every page. */
export async function addWatermark(
  bytes: ArrayBuffer,
  opts: WatermarkOptions,
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes.slice(0));
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const c = hexToRgb(opts.color);
  const rad = (opts.angle * Math.PI) / 180;
  const len = font.widthOfTextAtSize(opts.text, opts.size);
  doc.getPages().forEach((page) => {
    const { width, height } = page.getSize();
    // Start point so the text's midpoint lands at the page centre.
    const x = width / 2 - (len / 2) * Math.cos(rad);
    const y = height / 2 - (len / 2) * Math.sin(rad);
    page.drawText(opts.text, {
      x,
      y,
      size: opts.size,
      font,
      color: rgb(c.r, c.g, c.b),
      opacity: opts.opacity,
      rotate: degrees(opts.angle),
    });
  });
  return doc.save();
}

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
 * on-device.
 */
export async function compressPdf(
  bytes: ArrayBuffer,
  pageSizes: { width: number; height: number }[],
  opts: CompressOptions,
  onProgress?: (page: number, total: number) => void,
): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  for (let i = 0; i < pageSizes.length; i++) {
    onProgress?.(i + 1, pageSizes.length);
    const canvas = await renderPageToCanvas(bytes, i, opts.scale);
    const jpg = canvas.toDataURL("image/jpeg", opts.quality);
    const img = await out.embedJpg(jpg);
    const { width, height } = pageSizes[i];
    const page = out.addPage([width, height]);
    page.drawImage(img, { x: 0, y: 0, width, height });
  }
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
    const canvas = await renderPageToCanvas(bytes, i, scale);
    urls.push(canvas.toDataURL("image/png"));
  }
  return urls;
}
