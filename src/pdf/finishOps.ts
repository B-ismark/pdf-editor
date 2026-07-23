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

/** Render each page to a PNG data URL for image export. */
export async function renderImages(
  bytes: ArrayBuffer,
  pageCount: number,
  scale = 2,
): Promise<string[]> {
  const urls: string[] = [];
  for (let i = 0; i < pageCount; i++) {
    const canvas = await renderPageToCanvas(bytes, i, scale);
    urls.push(canvas.toDataURL("image/png"));
  }
  return urls;
}
