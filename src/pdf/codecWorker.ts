/// <reference lib="webworker" />
/**
 * Runs `codecCore.ts` off the page: the redaction raster's PNG/JPEG encode and
 * comparison, Compress's per-page JPEG, and "Keep text"'s per-image decode,
 * downsample and re-encode. On the page these were a ~1 s freeze per redacted
 * page (TECH-PERFORMANCE §2.7). See `codec.ts` for the page side.
 */
import { encodeRasterCore, recodeImageCore, type RasterEncoding, type RasterOptions, type RecodeRequest } from "./codecCore";

export type CodecRequest =
  | { id: number; op: "raster"; bitmap: ImageBitmap; opts: RasterOptions }
  | { id: number; op: "recode"; req: RecodeRequest };

export type CodecReply =
  | { id: number; ok: true; raster?: RasterEncoding; recoded?: Uint8Array | null }
  | { id: number; ok: false; error: string };

const post = (reply: CodecReply, transfer: Transferable[] = []) =>
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(reply, transfer);

self.onmessage = async (e: MessageEvent<CodecRequest>) => {
  const msg = e.data;
  try {
    if (msg.op === "raster") {
      const { bitmap, opts } = msg;
      let raster: RasterEncoding;
      try {
        raster = await encodeRasterCore(bitmap, bitmap.width, bitmap.height, opts);
      } finally {
        bitmap.close();
      }
      post({ id: msg.id, ok: true, raster }, [raster.bytes.buffer]);
    } else {
      const recoded = await recodeImageCore(msg.req);
      post({ id: msg.id, ok: true, recoded }, recoded ? [recoded.buffer] : []);
    }
  } catch (err) {
    post({ id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
