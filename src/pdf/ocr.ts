import { renderPageToCanvas } from "./loader";
import type { PageData, TextFragment } from "./types";

/** Progress callback: 1-based page, total pages, and a coarse status. */
export type OcrProgress = (page: number, total: number, status: string) => void;

/** OCR assets are served from the app's own origin (no CDN — privacy first).
 * `npm run setup-ocr` copies the worker + wasm core into public/tesseract and
 * the language model into public/tessdata. */
const BASE = import.meta.env.BASE_URL;
const WORKER_PATH = `${BASE}tesseract/worker.min.js`;
const CORE_PATH = `${BASE}tesseract/`;
const LANG_PATH = `${BASE}tessdata`;

/** Thrown when the self-hosted OCR assets aren't present. */
export class OcrAssetsMissing extends Error {
  constructor() {
    super("OCR assets are not installed. Run `npm run setup-ocr` to enable on-device OCR.");
    this.name = "OcrAssetsMissing";
  }
}

/** Quick check that the language model is reachable on our own origin. */
async function assetsPresent(): Promise<boolean> {
  try {
    const res = await fetch(`${LANG_PATH}/eng.traineddata.gz`, { method: "HEAD" });
    return res.ok;
  } catch {
    return false;
  }
}

/** Render scale for OCR — higher is more accurate but slower. */
const OCR_SCALE = 2;

interface OcrWord {
  text: string;
  bbox: { x0: number; y0: number; x1: number; y1: number };
}

/** Pull the recognised words out of a Tesseract result, tolerating the
 * different shapes across versions (flat `words`, or nested in `blocks`). */
function collectWords(data: unknown): OcrWord[] {
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
 * Recognise text on the given pages and return new TextFragments per page
 * (PDF units, bottom-left origin). Appending these to a page's fragments turns
 * a scanned image into a searchable, redactable, selectable text layer.
 *
 * Runs entirely on-device via a self-hosted Tesseract worker.
 */
export async function ocrPages(
  bytes: ArrayBuffer,
  pages: PageData[],
  onProgress?: OcrProgress,
): Promise<Map<number, TextFragment[]>> {
  if (!(await assetsPresent())) throw new OcrAssetsMissing();

  const { createWorker } = await import("tesseract.js");
  const worker = await createWorker("eng", 1, {
    workerPath: WORKER_PATH,
    corePath: CORE_PATH,
    langPath: LANG_PATH,
    gzip: true,
  });

  const result = new Map<number, TextFragment[]>();
  try {
    for (let p = 0; p < pages.length; p++) {
      onProgress?.(p + 1, pages.length, "Reading text");
      const page = pages[p];
      const canvas = await renderPageToCanvas(bytes, page.pageIndex, OCR_SCALE);
      const { data } = await worker.recognize(canvas, {}, { blocks: true });
      const H = page.viewBox.height;
      const frags: TextFragment[] = [];
      const words = collectWords(data);
      words.forEach((w, i) => {
        if (!w.text || !w.text.trim()) return;
        const x = w.bbox.x0 / OCR_SCALE;
        const wPdf = (w.bbox.x1 - w.bbox.x0) / OCR_SCALE;
        const hPdf = (w.bbox.y1 - w.bbox.y0) / OCR_SCALE;
        // Tesseract y is top-down; convert the baseline (word bottom) to y-up.
        const baseline = H - w.bbox.y1 / OCR_SCALE;
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
      result.set(page.pageIndex, frags);
    }
  } finally {
    await worker.terminate();
  }
  return result;
}
