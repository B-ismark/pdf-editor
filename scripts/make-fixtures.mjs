/**
 * Generate the PDFs used by `npm run check` into `.fixtures/` (git-ignored).
 *
 * Kept as generated rather than committed binaries so the fixtures stay
 * readable and adjustable: the checks depend on knowing exactly what text is on
 * which page (to prove a redacted page really lost it), and on having a document
 * long enough that unbounded page rendering would be obvious.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const OUT = new URL("../.fixtures/", import.meta.url);
mkdirSync(OUT, { recursive: true });

/** Text repeated on every page, so "is it still extractable?" has one answer. */
export const MARKER = "the quick brown fox jumps over the lazy dog";

async function build(pageCount) {
  const doc = await PDFDocument.create();
  const body = await doc.embedFont(StandardFonts.Helvetica);
  const heading = await doc.embedFont(StandardFonts.HelveticaBold);
  for (let p = 0; p < pageCount; p++) {
    const page = doc.addPage([595, 842]);
    page.drawText(`Confidential Report — Page ${p + 1}`, {
      x: 60,
      y: 760,
      size: 20,
      font: heading,
    });
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

for (const [name, pages] of [
  ["sample.pdf", 12],
  // Long enough that rendering every page would allocate hundreds of megabytes
  // of canvas — the regression the render-window check guards against.
  ["long.pdf", 150],
]) {
  writeFileSync(new URL(name, OUT), await build(pages));
  console.log(`wrote .fixtures/${name} (${pages} pages)`);
}

/** Words the scanned fixture renders as pixels, for the OCR check to recover. */
export const SCANNED_WORDS = ["INVOICE", "Total", "Amount", "Due"];

writeFileSync(new URL("scanned.pdf", OUT), await buildScanned());
console.log("wrote .fixtures/scanned.pdf (1 page, image only)");

/**
 * A "scan": one page whose only content is a bitmap of rendered text, with no
 * text layer at all. This is the input OCR exists for, and the only way to prove
 * OCR did something is to start from a page where extraction returns nothing.
 *
 * The bitmap is produced by drawing the words onto a canvas in a real browser,
 * in a real typeface, at a size and weight a scanner would produce. A
 * hand-rolled pixel font was tried first and is a poor target — Tesseract is
 * trained on actual type, and read 1 of 3 words from blocky 1px-stroke glyphs.
 * Using the browser that `npm run check` already needs costs nothing extra and
 * makes the OCR assertion meaningful rather than a coin flip.
 */
async function buildScanned() {
  const { chromium } = await import("playwright");
  const exec = [
    "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
    "/opt/pw-browsers/chromium/chrome-linux/chrome",
  ].find((p) => existsSync(p));

  const browser = await chromium.launch(exec ? { executablePath: exec } : {});
  const page = await browser.newPage();
  const dataUrl = await page.evaluate((words) => {
    // 1240x1754 ≈ A4 at 150 dpi, a typical scan resolution.
    const canvas = document.createElement("canvas");
    canvas.width = 1240;
    canvas.height = 1754;
    const ctx = canvas.getContext("2d");
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
  await browser.close();

  const doc = await PDFDocument.create();
  const png = await doc.embedPng(dataUrl);
  const pdfPage = doc.addPage([595, 842]);
  pdfPage.drawImage(png, { x: 0, y: 0, width: 595, height: 842 });
  return doc.save();
}
