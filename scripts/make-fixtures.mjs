/**
 * Generate the PDFs used by `npm run check` into `.fixtures/` (git-ignored).
 *
 * Kept as generated rather than committed binaries so the fixtures stay
 * readable and adjustable: the checks depend on knowing exactly what text is on
 * which page (to prove a redacted page really lost it), and on having a document
 * long enough that unbounded page rendering would be obvious.
 */
import { mkdirSync, writeFileSync } from "node:fs";
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
