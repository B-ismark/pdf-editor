import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { chromium } from "@playwright/test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  /** HTML pretending to be a PDF. */
  fake: string;
}

/** Text repeated on every page of `sample`/`long`. */
export const MARKER = "the quick brown fox jumps over the lazy dog";
/** Words the `scanned` fixture renders as pixels, for OCR to recover. */
export const SCANNED_WORDS = ["INVOICE", "Total", "Amount", "Due"];

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
