/**
 * The page side of the image codec: sends work to `codecWorker.ts` and, when a
 * worker can't be had or dies under it, does the same work here with the same
 * code (`codecCore.ts`) — slower to the eye, identical in the file.
 *
 * One worker, made on first use and let go after {@link IDLE_MS} without work,
 * since MozJPEG's WASM heap grows with the largest image it has seen and has no
 * reason to outlive an export.
 */
import {
  encodeRasterCore,
  recodeImageCore,
  type RasterEncoding,
  type RasterOptions,
  type RecodeRequest,
} from "./codecCore";
import type { CodecReply, CodecRequest } from "./codecWorker";

export type { RasterEncoding, RasterOptions, RecodeRequest };

const IDLE_MS = 20_000;

type Pending = { resolve: (r: CodecReply & { ok: true }) => void; reject: (e: Error) => void };

let worker: Worker | null = null;
/** Whether the current worker has ever answered. One that fails before its
 *  first reply couldn't load (a blocked script, a browser without module
 *  workers); asking again would only fetch and fail again, once per image. */
let answered = false;
/** Set once a worker failed to load: from then on everything runs on the page. */
let unavailable = false;
let nextId = 1;
const pending = new Map<number, Pending>();
let idle: ReturnType<typeof setTimeout> | null = null;

function canUseWorker(): boolean {
  return (
    typeof Worker !== "undefined" &&
    typeof OffscreenCanvas !== "undefined" &&
    typeof createImageBitmap === "function"
  );
}

/** Drop the worker and fail whatever was waiting on it; callers fall back. */
function discard(reason: string) {
  if (worker && !answered && reason !== "idle") unavailable = true;
  worker?.terminate();
  worker = null;
  if (idle) clearTimeout(idle);
  idle = null;
  const waiting = [...pending.values()];
  pending.clear();
  for (const p of waiting) p.reject(new Error(reason));
}

/** Let the worker go once nothing has been asked of it for {@link IDLE_MS}. */
function armIdle() {
  if (pending.size > 0) return;
  if (idle) clearTimeout(idle);
  idle = setTimeout(() => {
    if (pending.size === 0) discard("idle");
  }, IDLE_MS);
}

function getWorker(): Worker | null {
  if (unavailable || !canUseWorker()) return null;
  if (worker) return worker;
  answered = false;
  try {
    worker = new Worker(new URL("./codecWorker.ts", import.meta.url), { type: "module" });
  } catch {
    worker = null;
    return null;
  }
  worker.onmessage = (e: MessageEvent<CodecReply>) => {
    const reply = e.data;
    answered = true;
    const p = pending.get(reply.id);
    if (!p) return;
    pending.delete(reply.id);
    if (reply.ok) p.resolve(reply);
    else p.reject(new Error(reply.error));
    armIdle();
  };
  // A worker that fails to load, or dies (out of memory on a huge image), says
  // so here and nowhere else: without this its callers would wait for ever.
  worker.onerror = (e) => {
    e.preventDefault();
    discard("codec worker failed");
  };
  worker.onmessageerror = () => discard("codec worker message failed");
  return worker;
}

function call(msg: CodecRequest, transfer: Transferable[]): Promise<CodecReply & { ok: true }> {
  const w = getWorker();
  if (!w) return Promise.reject(new Error("no codec worker"));
  if (idle) clearTimeout(idle);
  idle = null;
  return new Promise((resolve, reject) => {
    pending.set(msg.id, { resolve, reject });
    try {
      w.postMessage(msg, transfer);
    } catch (e) {
      pending.delete(msg.id);
      armIdle();
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}

/**
 * Encode a finished page raster (see `encodeRasterCore`). The canvas is copied
 * to an `ImageBitmap` and handed to the worker, so the page only pays for that
 * copy, not for the encode.
 */
export async function encodeRaster(canvas: HTMLCanvasElement, opts: RasterOptions): Promise<RasterEncoding> {
  if (canUseWorker()) {
    let bitmap: ImageBitmap | null = null;
    try {
      bitmap = await createImageBitmap(canvas);
      const reply = await call({ id: nextId++, op: "raster", bitmap, opts }, [bitmap]);
      bitmap = null; // transferred
      if (reply.raster) return reply.raster;
    } catch {
      bitmap?.close();
      /* fall back to the page */
    }
  }
  return encodeRasterCore(canvas, canvas.width, canvas.height, opts);
}

/** Downsample and re-encode one embedded image (see `recodeImageCore`); null
 *  leaves it as it is. `req.bytes` is copied, so the caller's stays intact. */
export async function recodeImage(req: RecodeRequest): Promise<Uint8Array | null> {
  if (canUseWorker()) {
    try {
      const bytes = req.bytes.slice();
      const reply = await call({ id: nextId++, op: "recode", req: { ...req, bytes } }, [bytes.buffer]);
      return reply.recoded ?? null;
    } catch {
      /* fall back to the page */
    }
  }
  return recodeImageCore(req);
}
