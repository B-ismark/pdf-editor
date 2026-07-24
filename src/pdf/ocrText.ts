import type { PageData, TextFragment } from "./types";

/** One recognised word from Tesseract. `confidence` is 0..100 (may be absent
 *  on some result shapes). */
export interface OcrWord {
  text: string;
  confidence?: number;
  bbox: { x0: number; y0: number; x1: number; y1: number };
}

/** Words below this Tesseract confidence are dropped from the text layer —
 *  they're usually mis-reads / noise that would pollute Find and
 *  search-and-redact with garbage matches. */
export const MIN_OCR_CONFIDENCE = 60;

/** Pull the recognised words out of a Tesseract result, tolerating the
 *  different shapes across versions (flat `words`, or nested in `blocks`). */
export function collectWords(data: unknown): OcrWord[] {
  const d = data as { words?: OcrWord[]; blocks?: unknown[] };
  if (Array.isArray(d.words) && d.words.length) return d.words;
  const out: OcrWord[] = [];
  for (const block of (d.blocks ?? []) as { paragraphs?: unknown[] }[]) {
    for (const para of (block.paragraphs ?? []) as { lines?: unknown[] }[]) {
      for (const line of (para.lines ?? []) as { words?: OcrWord[] }[]) {
        for (const w of line.words ?? []) out.push(w);
      }
    }
  }
  return out;
}

/**
 * Map recognised words to page {@link TextFragment}s (PDF units, bottom-left
 * origin), dropping blank and low-confidence words. `scale` is the OCR render
 * scale used to rasterise the page (word coordinates are in that pixel space).
 */
export function wordsToFragments(
  words: OcrWord[],
  page: PageData,
  scale: number,
  minConfidence: number = MIN_OCR_CONFIDENCE,
): TextFragment[] {
  const H = page.viewBox.height;
  const frags: TextFragment[] = [];
  words.forEach((w, i) => {
    if (!w.text || !w.text.trim()) return;
    // Drop low-confidence reads (keep words whose confidence is unknown).
    if (typeof w.confidence === "number" && w.confidence < minConfidence) return;
    const x = w.bbox.x0 / scale;
    const wPdf = (w.bbox.x1 - w.bbox.x0) / scale;
    const hPdf = (w.bbox.y1 - w.bbox.y0) / scale;
    // Tesseract y is top-down; convert the baseline (word bottom) to y-up.
    const baseline = H - w.bbox.y1 / scale;
    const size = Math.max(6, hPdf);
    frags.push({
      id: `ocr:${page.pageIndex}:${i}`,
      pageIndex: page.pageIndex,
      itemIndex: 100000 + i,
      original: w.text,
      transform: [size, 0, 0, size, x, baseline],
      width: wPdf,
      height: hPdf,
      fontFamily: "sans-serif",
    });
  });
  return frags;
}
