import { PDFDocument, PDFName, PDFRawStream, PDFRef, StandardFonts, rgb } from "pdf-lib";
import { chromium } from "@playwright/test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

/**
 * Test PDFs, generated on demand rather than committed as binaries.
 *
 * Generated so the specs can depend on knowing exactly what text is on which
 * page — that's what makes "a redacted page no longer has this text, its
 * neighbour still does" assertable — and so the long document is long enough
 * that unbounded page rendering would show up.
 */
export interface Fixtures {
  /** 12 pages of known text. */
  sample: string;
  /** 150 pages: rendering them all would allocate hundreds of MB of canvas. */
  long: string;
  /** One page, image only, no text layer at all — the input OCR exists for. */
  scanned: string;
  /** One page: a large photographic (flate-compressed) image plus real text. */
  photo: string;
  /** One page: a transparent image, so the file carries a soft-mask stream. */
  masked: string;
  /** HTML pretending to be a PDF. */
  fake: string;
}

/** Text repeated on every page of `sample`/`long`. */
export const MARKER = "the quick brown fox jumps over the lazy dog";
/** Words the `scanned` fixture renders as pixels, for OCR to recover. */
export const SCANNED_WORDS = ["INVOICE", "Total", "Amount", "Due"];
/** Caption under the `photo` fixture's image — must survive "Keep text". */
export const PHOTO_CAPTION = "Figure 1 — site survey photograph";

let cached: Promise<Fixtures> | null = null;

/** Build the fixtures once per test run (workers: 1, so one cache suffices). */
export function fixtures(): Promise<Fixtures> {
  cached ??= build();
  return cached;
}

async function build(): Promise<Fixtures> {
  const dir = mkdtempSync(join(tmpdir(), "pdf-editor-fixtures-"));
  const write = (name: string, bytes: Uint8Array | string) => {
    const path = join(dir, name);
    writeFileSync(path, bytes);
    return path;
  };
  return {
    sample: write("sample.pdf", await textPdf(12)),
    long: write("long.pdf", await textPdf(150)),
    scanned: write("scanned.pdf", await scannedPdf()),
    photo: write("photo.pdf", await photoPdf()),
    masked: write("masked.pdf", await maskedPdf()),
    fake: write("not-a-pdf.pdf", "<!doctype html><html><body><h1>Not a PDF</h1></body></html>"),
  };
}

async function textPdf(pageCount: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const body = await doc.embedFont(StandardFonts.Helvetica);
  const heading = await doc.embedFont(StandardFonts.HelveticaBold);
  for (let p = 0; p < pageCount; p++) {
    const page = doc.addPage([595, 842]);
    page.drawText(`Confidential Report — Page ${p + 1}`, { x: 60, y: 760, size: 20, font: heading });
    for (let line = 0; line < 24; line++) {
      page.drawText(`Line ${line + 1}: ${MARKER}. Account 4111-1111-1111-1111.`, {
        x: 60,
        y: 700 - line * 24,
        size: 10,
        font: body,
        color: rgb(0.1, 0.1, 0.1),
      });
    }
  }
  return doc.save();
}

/**
 * A "scan": one page whose only content is a bitmap of rendered text.
 *
 * The bitmap is drawn on a canvas in a real browser, in a real typeface, at a
 * size and weight a scanner would produce. A hand-rolled pixel font was tried
 * first and is a poor target — Tesseract is trained on actual type and read 1 of
 * 3 words from blocky 1px-stroke glyphs. A fixture a working feature fails is
 * worse than no fixture.
 */
async function scannedPdf(): Promise<Uint8Array> {
  const exec = [
    "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
    process.env.PW_EXECUTABLE_PATH ?? "",
  ].find((p) => p && existsSync(p));

  const browser = await chromium.launch(exec ? { executablePath: exec } : {});
  try {
    const page = await browser.newPage();
    const dataUrl = await page.evaluate((words) => {
      // 1240x1754 ≈ A4 at 150 dpi, a typical scan resolution.
      const canvas = document.createElement("canvas");
      canvas.width = 1240;
      canvas.height = 1754;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#111";
      ctx.textBaseline = "top";
      ctx.font = "bold 96px Helvetica, Arial, sans-serif";
      ctx.fillText(words[0], 120, 200);
      ctx.font = "64px Helvetica, Arial, sans-serif";
      words.slice(1).forEach((w, i) => ctx.fillText(w, 120, 400 + i * 110));
      return canvas.toDataURL("image/png");
    }, SCANNED_WORDS);

    const doc = await PDFDocument.create();
    const png = await doc.embedPng(dataUrl);
    doc.addPage([595, 842]).drawImage(png, { x: 0, y: 0, width: 595, height: 842 });
    return doc.save();
  } finally {
    await browser.close();
  }
}

/**
 * A page carrying a large photographic image and a caption.
 *
 * The image is written as a colour-type-2 (no alpha) PNG, so pdf-lib embeds it
 * as a plain `FlateDecode` DeviceRGB stream with no soft mask — the shape scans,
 * screenshots, and anything that arrived as a PNG actually take, and the one the
 * image optimiser used to skip entirely.
 *
 * The pixels are a gradient plus noise from a seeded generator. Noise is the
 * point: it is what lossless compression cannot do anything with, so it's what
 * makes both "flate is a bad fit for this" and "JPEG is dramatically smaller"
 * true here the way they're true of a real scan. The seed keeps the size
 * assertions stable from run to run.
 */
async function photoPdf(): Promise<Uint8Array> {
  const w = 800;
  const h = 1000;
  const px = new Uint8Array(w * h * 3);
  let seed = 0x2f6e2b1;
  const rand = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return (seed >>> 24) & 0xff;
  };
  const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i += 3) {
      const base = 60 + (x / w) * 120 + (y / h) * 60;
      const n = (rand() % 80) - 40;
      px[i] = clamp(base + n);
      px[i + 1] = clamp(base * 0.85 + n);
      px[i + 2] = clamp(base * 0.7 + n);
    }
  }

  const doc = await PDFDocument.create();
  const img = await doc.embedPng(encodePng(px, w, h));
  const page = doc.addPage([595, 842]);
  page.drawImage(img, { x: 47, y: 220, width: 500, height: 560 });
  page.drawText(PHOTO_CAPTION, {
    x: 47,
    y: 180,
    size: 12,
    font: await doc.embedFont(StandardFonts.Helvetica),
  });
  return doc.save();
}

/**
 * A page whose image is transparent, so the PDF carries a **soft-mask stream**.
 *
 * A soft mask is an image XObject in its own right — DeviceGray, 8-bit, flate —
 * so from the inside it looks exactly like something the optimiser should
 * shrink, and nothing on the stream says "I am a mask". Re-encoding one as a
 * DeviceRGB JPEG makes it an invalid mask and makes the transparency lossy.
 *
 * pdf-lib happens to write `/Decode [0 1]` on its masks, which the optimiser's
 * `/Decode` guard would refuse for the wrong reason — so the fixture strips it
 * afterwards. That's not making the test easier; it's making it *representative*,
 * since most producers emit a mask with no `/Decode` at all.
 */
async function maskedPdf(): Promise<Uint8Array> {
  const w = 700;
  const h = 900;
  const px = new Uint8Array(w * h * 4);
  let seed = 0x51f3a7c;
  const rand = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return (seed >>> 24) & 0xff;
  };
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    px[o] = rand();
    px[o + 1] = rand();
    px[o + 2] = rand();
    // Noisy alpha, so the mask stream is too big for flate to shrink and lands
    // well over the optimiser's size threshold.
    px[o + 3] = rand();
  }

  const doc = await PDFDocument.create();
  const img = await doc.embedPng(encodePng(px, w, h, 4));
  doc.addPage([595, 842]).drawImage(img, { x: 47, y: 120, width: 500, height: 600 });
  return stripMaskDecode(await doc.save());
}

/** Remove `/Decode` from every soft-mask stream, so the fixture matches the
 *  shape a typical PDF producer emits rather than pdf-lib's own. */
async function stripMaskDecode(bytes: Uint8Array): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes);
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    const smask = obj.dict.get(PDFName.of("SMask"));
    if (!(smask instanceof PDFRef)) continue;
    const mask = doc.context.lookup(smask);
    if (mask instanceof PDFRawStream) mask.dict.delete(PDFName.of("Decode"));
  }
  return doc.save();
}

/** Minimal PNG encoder (8-bit, no interlacing), truecolour with or without an
 *  alpha channel. Hand-rolled so a fixture can guarantee which of the two it
 *  gets: a canvas `toDataURL` always emits RGBA, and whether an alpha channel
 *  is present decides whether pdf-lib writes a soft mask — which is the
 *  difference between the two images these fixtures need. */
function encodePng(pixels: Uint8Array, w: number, h: number, channels: 3 | 4 = 3): Uint8Array {
  const rowBytes = w * channels;
  const stride = rowBytes + 1;
  const raw = new Uint8Array(stride * h);
  for (let y = 0; y < h; y++) {
    raw[y * stride] = 0; // per-row filter: none
    raw.set(pixels.subarray(y * rowBytes, (y + 1) * rowBytes), y * stride + 1);
  }
  const ihdr = new Uint8Array(13);
  const head = new DataView(ihdr.buffer);
  head.setUint32(0, w);
  head.setUint32(4, h);
  ihdr[8] = 8; // bit depth
  ihdr[9] = channels === 4 ? 6 : 2; // truecolour, with or without alpha
  return concatBytes([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", new Uint8Array(deflateSync(raw))),
    pngChunk("IEND", new Uint8Array(0)),
  ]);
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
