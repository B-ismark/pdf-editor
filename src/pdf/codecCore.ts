/**
 * The image encoding behind the redaction raster, Compress, and "Keep text"
 * image optimisation. It runs in `codecWorker.ts`, off the page, so a redacted
 * page no longer freezes the tab for a second while it is squeezed; `codec.ts`
 * calls the same functions on the page when a worker can't be had. One
 * implementation, so the two can't drift apart.
 *
 * Nothing here touches pdf-lib or the DOM proper: canvases are `OffscreenCanvas`
 * where it exists, an `HTMLCanvasElement` only on the page fallback.
 */
import { inflate, rgbaToFlate, samplesToRgba, unpredict } from "./pixelCodec";

type AnyCanvas = OffscreenCanvas | HTMLCanvasElement;
type Ctx2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

function makeCanvas(w: number, h: number): AnyCanvas {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

function context(c: AnyCanvas): Ctx2D {
  const ctx = c.getContext("2d") as Ctx2D | null;
  if (!ctx) throw new Error("no 2d context");
  return ctx;
}

async function canvasBytes(c: AnyCanvas, type: string, quality?: number): Promise<Uint8Array> {
  const blob =
    "convertToBlob" in c
      ? await c.convertToBlob({ type, quality })
      : await new Promise<Blob | null>((resolve) => c.toBlob(resolve, type, quality));
  if (!blob) throw new Error("Could not encode the image");
  return new Uint8Array(await blob.arrayBuffer());
}

type MozEncode = (data: ImageData, opts: { quality: number }) => Promise<ArrayBuffer>;
let moz: Promise<MozEncode | null> | null = null;

/** MozJPEG (`@jsquash/jpeg`, self-hosted WASM), loaded once per thread on first
 *  use; null when it can't be. */
function loadMoz(): Promise<MozEncode | null> {
  return (moz ??= import("@jsquash/jpeg/encode")
    .then(async ({ default: encode, init }) => {
      await init();
      return encode as MozEncode;
    })
    .catch(() => null));
}

/**
 * JPEG via MozJPEG — meaningfully smaller than the browser's encoder at the same
 * quality — falling back to the browser's own if the codec can't load or fails
 * on this image. Either way the result is a baseline JPEG; only the size differs.
 */
async function encodeJpeg(c: AnyCanvas, data: ImageData, quality01: number): Promise<Uint8Array> {
  const encode = await loadMoz();
  if (encode) {
    try {
      const quality = Math.max(1, Math.min(100, Math.round(quality01 * 100)));
      return new Uint8Array(await encode(data, { quality }));
    } catch {
      /* fall through to the browser encoder */
    }
  }
  return canvasBytes(c, "image/jpeg", quality01);
}

/**
 * A page raster, as the exporter embeds it:
 *  - `flate`: DeviceRGB samples, `/Predictor 15`, deflated (see `rgbaToFlate`);
 *  - `jpeg`: a JPEG file;
 *  - `png`: a PNG file — only where `CompressionStream` is missing.
 */
export type RasterEncoding =
  | { kind: "flate"; bytes: Uint8Array; width: number; height: number }
  | { kind: "jpeg" | "png"; bytes: Uint8Array; width: number; height: number };

export interface RasterOptions {
  /** JPEG quality 0..1, or null for no JPEG (a lossless raster). */
  jpegQuality: number | null;
  /** Also produce the lossless encoding, and keep whichever is smaller. */
  lossless: boolean;
}

/**
 * Encode a page raster. With both encodings asked for, both are made and the
 * smaller kept: neither wins everywhere (lossless is hopeless on scanner noise,
 * JPEG an order of magnitude worse on a sparse vector page), so the comparison
 * is the design — see `embedPageRaster`. A failed JPEG falls back to the
 * lossless one; the page still exports, just larger.
 */
export async function encodeRasterCore(
  source: CanvasImageSource,
  width: number,
  height: number,
  opts: RasterOptions,
): Promise<RasterEncoding> {
  const c = makeCanvas(width, height);
  const ctx = context(c);
  // A page has a white ground; composite onto it so both encodings agree.
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(source, 0, 0, width, height);
  const data = ctx.getImageData(0, 0, width, height);

  let lossless: RasterEncoding | null = null;
  if (opts.lossless) {
    lossless =
      typeof CompressionStream !== "undefined"
        ? { kind: "flate", bytes: await rgbaToFlate(data.data, width, height), width, height }
        : { kind: "png", bytes: await canvasBytes(c, "image/png"), width, height };
  }
  if (opts.jpegQuality === null) {
    if (!lossless) throw new Error("No encoding asked for");
    return lossless;
  }
  let jpeg: Uint8Array | null = null;
  try {
    jpeg = await encodeJpeg(c, data, opts.jpegQuality);
  } catch (e) {
    if (!lossless) throw e;
  }
  if (jpeg && (!lossless || jpeg.length < lossless.bytes.length)) {
    return { kind: "jpeg", bytes: jpeg, width, height };
  }
  return lossless!;
}

/** One embedded image to downsample and re-encode as JPEG (`optimizeImages`). */
export interface RecodeRequest {
  filter: "DCTDecode" | "FlateDecode";
  /** The stream's encoded contents. */
  bytes: Uint8Array;
  width: number;
  height: number;
  /** Components per sample (flate only): 1 gray, 3 RGB. */
  comps: number;
  /** Resolved `/DecodeParms` (flate only), already checked against the image. */
  parms: { predictor: number; colors: number; bpc: number; columns: number } | null;
  targetWidth: number;
  targetHeight: number;
  quality: number;
}

/** Decode a flate image's samples to something drawable, or null if anything
 *  about it doesn't line up. */
async function decodeFlate(r: RecodeRequest): Promise<AnyCanvas | null> {
  const { width: w, height: h, comps, parms } = r;
  if (!parms) return null;
  const inflated = await inflate(r.bytes);
  if (!inflated) return null;
  const samples = unpredict(inflated, parms.predictor, parms.colors, parms.bpc, parms.columns);
  // Short data means we misread the layout somewhere — bail rather than
  // re-encode a half-decoded image over the original.
  if (!samples || samples.length < w * h * comps) return null;
  const c = makeCanvas(w, h);
  context(c).putImageData(new ImageData(samplesToRgba(samples, w, h, comps) as ImageDataArray, w, h), 0, 0);
  return c;
}

/**
 * Decode one embedded image, draw it at the target size and encode it as JPEG.
 * Null means "leave this image as it is" — it couldn't be decoded or encoded —
 * which is never wrong, only unhelpful. The caller applies the never-grow rule.
 */
export async function recodeImageCore(r: RecodeRequest): Promise<Uint8Array | null> {
  let source: CanvasImageSource | null = null;
  let release: (() => void) | null = null;
  try {
    if (r.filter === "DCTDecode") {
      const bitmap = await createImageBitmap(new Blob([r.bytes as BlobPart], { type: "image/jpeg" }));
      source = bitmap;
      release = () => bitmap.close?.();
    } else {
      source = await decodeFlate(r);
    }
  } catch {
    source = null; // undecodable, or out of memory on a huge image
  }
  if (!source) return null;
  try {
    const c = makeCanvas(r.targetWidth, r.targetHeight);
    const ctx = context(c);
    ctx.clearRect(0, 0, r.targetWidth, r.targetHeight);
    ctx.drawImage(source, 0, 0, r.targetWidth, r.targetHeight);
    release?.();
    release = null;
    const data = ctx.getImageData(0, 0, r.targetWidth, r.targetHeight);
    return await encodeJpeg(c, data, r.quality);
  } catch {
    return null;
  } finally {
    release?.();
  }
}
