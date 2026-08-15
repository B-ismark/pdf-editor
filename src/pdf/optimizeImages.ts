import { PDFArray, PDFName, PDFNumber, PDFRawStream, type PDFDocument, type PDFRef } from "pdf-lib";
import { loadJpegEncoder } from "./jpeg";

export interface OptimizeImagesResult {
  /** Number of image streams downsampled + re-encoded. */
  changed: number;
  /** Bytes saved across all replaced images (encoded-stream sizes). */
  saved: number;
}

export interface OptimizeImagesOptions {
  /** Downsample only when an image's larger side exceeds this many pixels. */
  maxDim: number;
  /** JPEG quality 0..1 for re-encoding. */
  quality: number;
}

/** Supported source encodings. `DCTDecode` is handed to the browser's JPEG
 *  decoder; `FlateDecode` carries raw samples we unpack ourselves. */
type ImageFilter = "DCTDecode" | "FlateDecode";

/** Guard against inflating a stream that would blow the tab's memory. A 40 MP
 *  RGB image is already ~120 MB of samples; past that, leave it alone. */
const MAX_PIXELS = 40_000_000;

/** A PDFName's bare name without the leading slash (pdf-lib's asString keeps
 *  it, e.g. "/Image" → "Image"), or null if the value isn't a name. */
const nameOf = (v: unknown): string | null =>
  v instanceof PDFName ? v.asString().replace(/^\//, "") : null;

/** Read a PDFNumber entry, or null. */
function num(dict: { get: (k: PDFName) => unknown }, key: string): number | null {
  const v = dict.get(PDFName.of(key));
  return v instanceof PDFNumber ? v.asNumber() : null;
}

/** The stream's single filter name, or null if it has none / more than one
 *  (a chained filter isn't something we're set up to undo). */
function singleFilter(stream: PDFRawStream): string | null {
  const filter = stream.dict.get(PDFName.of("Filter"));
  if (filter instanceof PDFArray) return filter.size() === 1 ? nameOf(filter.get(0)) : null;
  return nameOf(filter);
}

/** Component count for a colour space we can reproduce faithfully, or null.
 *  DeviceRGB, DeviceGray, and ICCBased with 1 or 3 components only — CMYK,
 *  Indexed, Separation and friends are skipped rather than guessed at. */
function componentCount(stream: PDFRawStream): number | null {
  const cs = stream.dict.get(PDFName.of("ColorSpace"));
  const csName = nameOf(cs);
  if (csName === "DeviceRGB") return 3;
  if (csName === "DeviceGray") return 1;
  if (cs instanceof PDFArray && cs.size() >= 2 && nameOf(cs.get(0)) === "ICCBased") {
    // ICCBased profile is a stream carrying /N (component count).
    const icc = stream.dict.context.lookup(cs.get(1)) as unknown as
      | { dict?: { get: (k: PDFName) => unknown } }
      | undefined;
    const iccDict = icc?.dict;
    if (!iccDict) return null;
    const n = num(iccDict, "N");
    return n === 1 || n === 3 ? n : null;
  }
  return null;
}

/**
 * Classify an image stream we can re-encode as a DeviceRGB JPEG without
 * changing how it renders, or null to leave it untouched.
 *
 * We deliberately skip anything where our decode might not match the PDF's
 * intended output: chained or unsupported filters, exotic colour spaces, a
 * /Decode array, soft/stencil masks, or image masks. Skipping just leaves the
 * image as it was — it never corrupts one.
 */
function classify(stream: PDFRawStream): { filter: ImageFilter; comps: number } | null {
  const d = stream.dict;
  if (nameOf(d.get(PDFName.of("Subtype"))) !== "Image") return null;

  const filter = singleFilter(stream);
  if (filter !== "DCTDecode" && filter !== "FlateDecode") return null;

  // No masks / stencil (JPEG can't carry alpha; dropping it would change output).
  if (d.get(PDFName.of("SMask")) || d.get(PDFName.of("Mask"))) return null;
  const imageMask = d.get(PDFName.of("ImageMask"));
  if (imageMask && nameOf(imageMask) !== "false") return null;
  // A /Decode array can invert/remap samples — skip so we don't ignore it.
  if (d.get(PDFName.of("Decode"))) return null;

  const comps = componentCount(stream);
  if (comps == null) return null;

  // Flate carries raw samples, so we have to unpack them at the declared depth.
  // Only 8 bits per component is supported; 1-bit bilevel scans and 16-bit
  // images are left alone. (DCTDecode is always 8, decoded by the browser.)
  if (filter === "FlateDecode" && num(d, "BitsPerComponent") !== 8) return null;

  return { filter, comps };
}

/** Inflate a FlateDecode stream. PDF writes zlib-wrapped deflate, but raw
 *  deflate turns up in the wild, so try both before giving up. Returns null if
 *  neither works or the platform has no DecompressionStream. */
async function inflate(bytes: Uint8Array): Promise<Uint8Array | null> {
  if (typeof DecompressionStream === "undefined") return null;
  for (const format of ["deflate", "deflate-raw"] as const) {
    try {
      const stream = new Blob([bytes.slice() as BlobPart])
        .stream()
        .pipeThrough(new DecompressionStream(format));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch {
      /* try the next format */
    }
  }
  return null;
}

/**
 * Undo the row predictor a Flate stream may have been filtered with.
 *
 * Predictors are what make flate worth applying to images at all, so most real
 * image streams carry one — ignoring `/Predictor` wouldn't produce a slightly
 * wrong image, it would produce noise. Returns null for anything unsupported so
 * the caller leaves the image untouched.
 */
function unpredict(
  raw: Uint8Array,
  predictor: number,
  colors: number,
  bpc: number,
  columns: number,
): Uint8Array | null {
  if (predictor <= 1) return raw;
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  const rowLen = Math.ceil((colors * bpc * columns) / 8);
  if (rowLen <= 0) return null;

  // TIFF predictor: horizontal differencing, no per-row prefix byte.
  if (predictor === 2) {
    if (bpc !== 8) return null;
    const out = raw.slice();
    const rows = Math.floor(out.length / rowLen);
    for (let r = 0; r < rows; r++) {
      const off = r * rowLen;
      for (let i = colors; i < rowLen; i++) out[off + i] = (out[off + i] + out[off + i - colors]) & 0xff;
    }
    return out;
  }

  // PNG predictors (10..15): each row is prefixed with its filter type.
  const rows = Math.floor(raw.length / (rowLen + 1));
  const out = new Uint8Array(rows * rowLen);
  let prev = new Uint8Array(rowLen);
  for (let r = 0; r < rows; r++) {
    const head = r * (rowLen + 1);
    const type = raw[head];
    const src = raw.subarray(head + 1, head + 1 + rowLen);
    // A view into `out`, so writing through it fills the output directly.
    const cur = out.subarray(r * rowLen, (r + 1) * rowLen);
    for (let i = 0; i < rowLen; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v = src[i];
      switch (type) {
        case 0: break;
        case 1: v += a; break;
        case 2: v += b; break;
        case 3: v += (a + b) >> 1; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          break;
        }
        default:
          return null; // unknown filter type — don't guess
      }
      cur[i] = v & 0xff;
    }
    prev = cur;
  }
  return out;
}

/** The /DecodeParms dictionary for a stream (unwrapping a single-element
 *  array), or null. */
function decodeParms(stream: PDFRawStream): { get: (k: PDFName) => unknown } | null {
  const ctx = stream.dict.context;
  let dp: unknown = stream.dict.get(PDFName.of("DecodeParms")) ?? stream.dict.get(PDFName.of("DP"));
  dp = ctx.lookup(dp as never) ?? dp;
  if (dp instanceof PDFArray) dp = dp.size() === 1 ? ctx.lookup(dp.get(0)) : null;
  return dp && typeof (dp as { get?: unknown }).get === "function"
    ? (dp as { get: (k: PDFName) => unknown })
    : null;
}

/** Decode a FlateDecode image stream to a canvas we can draw from, or null if
 *  anything about it doesn't line up. */
async function decodeFlate(
  stream: PDFRawStream,
  w: number,
  h: number,
  comps: number,
): Promise<HTMLCanvasElement | null> {
  const inflated = await inflate(stream.contents);
  if (!inflated) return null;

  const parms = decodeParms(stream);
  const predictor = parms ? (num(parms, "Predictor") ?? 1) : 1;
  const samples = unpredict(
    inflated,
    predictor,
    parms ? (num(parms, "Colors") ?? comps) : comps,
    parms ? (num(parms, "BitsPerComponent") ?? 8) : 8,
    parms ? (num(parms, "Columns") ?? w) : w,
  );
  // Short data means we misread the layout somewhere — bail rather than
  // re-encode a half-decoded image over the original.
  if (!samples || samples.length < w * h * comps) return null;

  const img = new ImageData(w, h);
  const d = img.data;
  for (let px = 0, s = 0, o = 0; px < w * h; px++, s += comps, o += 4) {
    if (comps === 1) {
      d[o] = d[o + 1] = d[o + 2] = samples[s];
    } else {
      d[o] = samples[s];
      d[o + 1] = samples[s + 1];
      d[o + 2] = samples[s + 2];
    }
    d[o + 3] = 255;
  }

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/**
 * Shrink a PDF by downsampling and re-encoding its oversized images in place,
 * leaving all vector/text content — and every image we can't safely touch —
 * exactly as it was. This keeps the document selectable/searchable while
 * cutting the bulk that dominates most large PDFs (embedded photos and scans).
 *
 * Both JPEG (`DCTDecode`) and flate-compressed images are handled. Flate is
 * where scans exported from most scanning software and anything that came in as
 * a PNG end up, and skipping it used to mean exactly those documents — the
 * heaviest ones — got nothing out of "Keep text". Re-encoding them as JPEG is a
 * lossy step on content that may be crisp line art, which is why it stays
 * behind the size thresholds below and the never-grow rule: an image only
 * changes if it is genuinely large *and* the result is genuinely smaller.
 */
export async function optimizeImages(
  doc: PDFDocument,
  opts: OptimizeImagesOptions,
): Promise<OptimizeImagesResult> {
  const encode = await loadJpegEncoder(opts.quality);
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return { changed: 0, saved: 0 };

  let changed = 0;
  let saved = 0;

  const entries = doc.context.enumerateIndirectObjects();
  for (const [ref, obj] of entries as [PDFRef, unknown][]) {
    if (!(obj instanceof PDFRawStream)) continue;
    const kind = classify(obj);
    if (!kind) continue;

    const d = obj.dict;
    const w = num(d, "Width");
    const h = num(d, "Height");
    if (!w || !h || w * h > MAX_PIXELS) continue;
    const longest = Math.max(w, h);
    // Only bother when the image is large enough that downsampling helps.
    if (longest <= opts.maxDim && obj.contents.length < 40_000) continue;

    // Decode to something drawable. Either step can bail on an image it can't
    // read; that just leaves the original in place.
    let source: CanvasImageSource;
    let release: (() => void) | null = null;
    if (kind.filter === "DCTDecode") {
      try {
        const bitmap = await createImageBitmap(
          new Blob([obj.contents.slice() as BlobPart], { type: "image/jpeg" }),
        );
        source = bitmap;
        release = () => bitmap.close?.();
      } catch {
        continue; // undecodable → leave untouched
      }
    } else {
      const decoded = await decodeFlate(obj, w, h, kind.comps);
      if (!decoded) continue;
      source = decoded;
    }

    const factor = longest > opts.maxDim ? opts.maxDim / longest : 1;
    const nw = Math.max(1, Math.round(w * factor));
    const nh = Math.max(1, Math.round(h * factor));
    canvas.width = nw;
    canvas.height = nh;
    ctx.clearRect(0, 0, nw, nh);
    ctx.drawImage(source, 0, 0, nw, nh);
    release?.();

    let encoded: Uint8Array;
    try {
      encoded = await encode(canvas);
    } catch {
      continue;
    }
    // Never grow a stream: keep the original if re-encoding didn't help.
    if (encoded.length >= obj.contents.length) continue;

    const ctxObj = doc.context;
    const newDict = ctxObj.obj({}) as unknown as { set: (k: PDFName, v: unknown) => void };
    newDict.set(PDFName.of("Type"), PDFName.of("XObject"));
    newDict.set(PDFName.of("Subtype"), PDFName.of("Image"));
    newDict.set(PDFName.of("Width"), PDFNumber.of(nw));
    newDict.set(PDFName.of("Height"), PDFNumber.of(nh));
    newDict.set(PDFName.of("ColorSpace"), PDFName.of("DeviceRGB"));
    newDict.set(PDFName.of("BitsPerComponent"), PDFNumber.of(8));
    newDict.set(PDFName.of("Filter"), PDFName.of("DCTDecode"));
    newDict.set(PDFName.of("Length"), PDFNumber.of(encoded.length));
    // Carry /Interpolate over — it's a rendering hint, and a downsampled image
    // is if anything more likely to want the smoothing it asks for.
    const interpolate = d.get(PDFName.of("Interpolate"));
    if (interpolate) newDict.set(PDFName.of("Interpolate"), interpolate);

    const newStream = PDFRawStream.of(newDict as never, encoded);
    ctxObj.assign(ref, newStream);
    changed++;
    saved += obj.contents.length - encoded.length;
  }

  return { changed, saved };
}
