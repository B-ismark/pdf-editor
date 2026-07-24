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

/** Render scale for OCR — higher is more accurate but slower. */
const OCR_SCALE = 2;

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
  signal?: AbortSignal,
): Promise<Map<number, TextFragment[]>> {
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

  const result = new Map<number, TextFragment[]>();
  try {
    for (let p = 0; p < pages.length; p++) {
      if (signal?.aborted) throw new OcrCancelled();
      onProgress?.(p + 1, pages.length, "Reading text");
      const page = pages[p];
      const canvas = await renderPageToCanvas(bytes, page.pageIndex, OCR_SCALE);
      const { data } = await withTimeout(
        worker.recognize(canvas, {}, { blocks: true }),
        PAGE_TIMEOUT,
        `Recognising page ${p + 1}`,
      );
      const frags = wordsToFragments(collectWords(data), page, OCR_SCALE);
      result.set(page.pageIndex, frags);
    }
  } finally {
    await worker.terminate();
  }
  return result;
}
