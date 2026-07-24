import { renderPageToCanvas } from "./loader";
import { collectWords, wordsToFragments } from "./ocrText";
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

/** Thrown when the caller aborts OCR via its AbortSignal. */
export class OcrCancelled extends Error {
  constructor() {
    super("OCR was cancelled.");
    this.name = "OcrCancelled";
  }
}

/** Reject if `p` doesn't settle within `ms` — so a wedged worker (asset fetch
 * that never resolves, wasm that never boots) surfaces an error instead of
 * spinning forever. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** Longest we'll wait for the Tesseract worker to boot (fetch wasm core +
 * language model over the app's own origin). */
const WORKER_INIT_TIMEOUT = 60_000;
/** Longest we'll wait to recognise a single page. */
const PAGE_TIMEOUT = 120_000;

/** Quick check that the language model is reachable on our own origin. A
 * single-page-app host may answer a missing path with a soft-200 that serves
 * index.html, so a bare `res.ok` can be a false positive — reject an HTML
 * content-type so we surface "not available" cleanly instead of handing the
 * worker an HTML page to choke on. */
async function assetsPresent(): Promise<boolean> {
  try {
    const res = await fetch(`${LANG_PATH}/eng.traineddata.gz`, { method: "HEAD" });
    if (!res.ok) return false;
    return !(res.headers.get("content-type") || "").toLowerCase().includes("text/html");
  } catch {
    return false;
  }
}

/** Preferred render scale for OCR — higher is more accurate but slower. */
const OCR_SCALE = 2;

/** Canvas safety limits. Browsers cap both the largest side and the total
 * pixel area of a canvas; mobile Safari is the tightest (~16.7M px area). A
 * page rasterised past the limit comes back blank or fails to allocate, which
 * looks like "OCR found nothing" or a hard error. We reduce the render scale
 * per page so the backing store always stays inside these bounds. */
const MAX_CANVAS_DIM = 8192;
const MAX_CANVAS_AREA = 16_777_216;

/** Largest render scale (≤ preferred) that keeps a page's canvas within the
 * browser's limits, given its size at scale 1 (PDF points). For ordinary
 * pages this returns the preferred scale unchanged; only unusually large page
 * boxes are scaled down — and since those are physically large, even a reduced
 * scale still yields thousands of pixels, so OCR stays legible rather than
 * failing outright. */
function safeOcrScale(widthPt: number, heightPt: number): number {
  let scale = Math.min(OCR_SCALE, MAX_CANVAS_DIM / widthPt, MAX_CANVAS_DIM / heightPt);
  if (widthPt * heightPt * scale * scale > MAX_CANVAS_AREA) {
    scale = Math.sqrt(MAX_CANVAS_AREA / (widthPt * heightPt));
  }
  return Math.max(0.1, scale);
}

/** Outcome of an OCR run: recognised words per page, plus how many pages the
 * engine couldn't read (so the caller can report partial success honestly). */
export interface OcrResult {
  perPage: Map<number, TextFragment[]>;
  pagesRead: number;
  pagesFailed: number;
  total: number;
}

/**
 * Recognise text on the given pages and return new TextFragments per page
 * (PDF units, bottom-left origin). Appending these to a page's fragments turns
 * a scanned image into a searchable, redactable, selectable text layer.
 *
 * Runs entirely on-device via a self-hosted Tesseract worker. A page that
 * times out or fails to render is skipped (and counted) rather than aborting
 * the whole document — so one pathological page can't discard every other
 * page's results.
 */
export async function ocrPages(
  bytes: ArrayBuffer,
  pages: PageData[],
  onProgress?: OcrProgress,
  signal?: AbortSignal,
): Promise<OcrResult> {
  if (signal?.aborted) throw new OcrCancelled();
  if (!(await assetsPresent())) throw new OcrAssetsMissing();

  const { createWorker } = await import("tesseract.js");
  onProgress?.(0, pages.length, "Starting");
  const worker = await withTimeout(
    createWorker("eng", 1, {
      workerPath: WORKER_PATH,
      corePath: CORE_PATH,
      langPath: LANG_PATH,
      gzip: true,
    }),
    WORKER_INIT_TIMEOUT,
    "Loading OCR engine",
  );

  const perPage = new Map<number, TextFragment[]>();
  let pagesFailed = 0;
  try {
    for (let p = 0; p < pages.length; p++) {
      if (signal?.aborted) throw new OcrCancelled();
      onProgress?.(p + 1, pages.length, "Reading text");
      const page = pages[p];
      let canvas: HTMLCanvasElement | null = null;
      try {
        const scale = safeOcrScale(page.viewBox.width, page.viewBox.height);
        canvas = await renderPageToCanvas(bytes, page.pageIndex, scale);
        const { data } = await withTimeout(
          worker.recognize(canvas, {}, { blocks: true }),
          PAGE_TIMEOUT,
          `Recognising page ${p + 1}`,
        );
        perPage.set(page.pageIndex, wordsToFragments(collectWords(data), page, scale));
      } catch (err) {
        // Cancellation must propagate; a per-page failure is isolated.
        if (signal?.aborted || (err as Error)?.name === "OcrCancelled") throw new OcrCancelled();
        pagesFailed++;
        console.warn(`OCR skipped page ${page.pageIndex + 1}:`, err);
      } finally {
        // Release the (potentially very large) backing store right away instead
        // of waiting for GC — matters when OCR-ing many pages on a phone.
        if (canvas) {
          canvas.width = 0;
          canvas.height = 0;
        }
      }
    }
  } finally {
    await worker.terminate();
  }

  // Every page failed → this isn't "no text found", it's a real failure.
  if (pagesFailed === pages.length && pages.length > 0) {
    throw new Error(`OCR failed on all ${pages.length} page(s).`);
  }
  return {
    perPage,
    pagesRead: pages.length - pagesFailed,
    pagesFailed,
    total: pages.length,
  };
}
