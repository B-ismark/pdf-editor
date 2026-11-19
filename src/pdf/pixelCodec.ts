/**
 * Pixel-level codec helpers with no DOM, canvas or pdf-lib in them, so they run
 * the same in `codecWorker.ts` and, as the fallback, on the page. See
 * `codecCore.ts` for what uses them.
 */

/** Inflate a FlateDecode stream. PDF writes zlib-wrapped deflate, but raw
 *  deflate turns up in the wild, so try both before giving up. Returns null if
 *  neither works or the platform has no DecompressionStream. */
export async function inflate(bytes: Uint8Array): Promise<Uint8Array | null> {
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

/** zlib-wrapped deflate — what a PDF `/FlateDecode` stream holds. */
export async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Undo the row predictor a Flate stream may have been filtered with.
 *
 * Predictors are what make flate worth applying to images at all, so most real
 * image streams carry one — ignoring `/Predictor` wouldn't produce a slightly
 * wrong image, it would produce noise. Returns null for anything unsupported so
 * the caller leaves the image untouched.
 */
export function unpredict(
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
        case 4: v += paeth(a, b, c); break;
        default:
          return null; // unknown filter type — don't guess
      }
      cur[i] = v & 0xff;
    }
    prev = cur;
  }
  return out;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Unpack 8-bit gray or RGB samples into RGBA pixels, opaque. */
export function samplesToRgba(samples: Uint8Array, w: number, h: number, comps: number): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
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
  return d;
}

/**
 * RGBA pixels → the body of a `/FlateDecode` DeviceRGB image with
 * `/Predictor 15`: each row prefixed with the PNG filter that suits it best,
 * then deflated. That is byte-for-byte the layout inside a PNG's IDAT, so it
 * compresses like one — but it goes into the PDF as it is. Handing pdf-lib a
 * PNG instead costs it a full decode on the page, and a second deflate of the
 * raw samples when the file is saved: measured at about a second for one
 * redacted A4 page, longer than encoding it ever took.
 *
 * Alpha is composited onto white (a page has a white ground) and dropped.
 */
export async function rgbaToFlate(rgba: Uint8ClampedArray, w: number, h: number): Promise<Uint8Array> {
  const rowLen = w * 3;
  const out = new Uint8Array(h * (rowLen + 1));
  let prev = new Uint8Array(rowLen);
  let cur = new Uint8Array(rowLen);
  const trial = new Uint8Array(rowLen);
  const best = new Uint8Array(rowLen);
  for (let y = 0; y < h; y++) {
    for (let x = 0, s = y * w * 4, o = 0; x < w; x++, s += 4, o += 3) {
      const a = rgba[s + 3];
      if (a === 255) {
        cur[o] = rgba[s];
        cur[o + 1] = rgba[s + 1];
        cur[o + 2] = rgba[s + 2];
      } else {
        const k = 255 - a;
        cur[o] = (rgba[s] * a + 255 * k + 127) / 255;
        cur[o + 1] = (rgba[s + 1] * a + 255 * k + 127) / 255;
        cur[o + 2] = (rgba[s + 2] * a + 255 * k + 127) / 255;
      }
    }
    // Pick the filter whose output has the smallest sum of absolute signed
    // bytes — the heuristic libpng uses, and a good proxy for what deflates best.
    let bestType = 0;
    let bestScore = Infinity;
    for (let type = 0; type <= 4; type++) {
      let score = 0;
      for (let i = 0; i < rowLen; i++) {
        const a = i >= 3 ? cur[i - 3] : 0;
        const b = prev[i];
        const c = i >= 3 ? prev[i - 3] : 0;
        const pred =
          type === 0 ? 0 : type === 1 ? a : type === 2 ? b : type === 3 ? (a + b) >> 1 : paeth(a, b, c);
        const v = (cur[i] - pred) & 0xff;
        trial[i] = v;
        score += v < 128 ? v : 256 - v;
        if (score >= bestScore) break;
      }
      if (score < bestScore) {
        bestScore = score;
        bestType = type;
        best.set(trial);
      }
    }
    const head = y * (rowLen + 1);
    out[head] = bestType;
    out.set(best, head + 1);
    [prev, cur] = [cur, prev];
  }
  return deflate(out);
}
