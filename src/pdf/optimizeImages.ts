import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRawStream, PDFRef, type PDFDocument } from "@cantoo/pdf-lib";
import { recodeImage } from "./codec";
import { yieldToUI } from "./yield";

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

/**
 * Pixel ceiling for the *flate* path only, where we hold the decoded image
 * ourselves. Decoding costs roughly four copies at once — inflated bytes, the
 * un-predicted samples, the ImageData, and the canvas backing it — so 16 MP of
 * RGB is already on the order of 200 MB. JPEG has no equivalent limit here
 * because `createImageBitmap` decodes off our heap; capping it would only stop
 * the optimiser working on the largest photos, which are the whole point.
 */
const MAX_FLATE_PIXELS = 16_000_000;

/** A PDFName's bare name without the leading slash (pdf-lib's asString keeps
 *  it, e.g. "/Image" → "Image"), or null if the value isn't a name. */
const nameOf = (v: unknown): string | null =>
  v instanceof PDFName ? v.asString().replace(/^\//, "") : null;

/** Read a PDFNumber entry, or null. */
function num(dict: { get: (k: PDFName) => unknown }, key: string): number | null {
  const v = dict.get(PDFName.of(key));
  return v instanceof PDFNumber ? v.asNumber() : null;
}

/**
 * Every object referenced as some other image's `/SMask` or `/Mask`.
 *
 * A soft mask is itself an image XObject — usually DeviceGray, 8-bit, flate —
 * so it looks exactly like a candidate from the inside, and nothing on the mask
 * stream says "I am a mask". Re-encoding one as a DeviceRGB JPEG produces an
 * invalid soft mask (they must be a single component) and quietly makes the
 * transparency lossy. Masks were never *reachable* while only `DCTDecode` was
 * accepted, since masks are essentially always flate; accepting flate is what
 * put them in range, so they have to be excluded by name.
 */
function maskedRefs(doc: PDFDocument): Set<string> {
  const refs = new Set<string>();
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    const dict = obj instanceof PDFRawStream ? obj.dict : obj instanceof PDFDict ? obj : null;
    if (!dict) continue;
    for (const key of ["SMask", "Mask"]) {
      const v = dict.get(PDFName.of(key));
      if (v instanceof PDFRef) refs.add(v.tag);
    }
  }
  return refs;
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

/** Resolved `/DecodeParms` values, in the units `unpredict` needs. */
interface FlateParms {
  predictor: number;
  colors: number;
  bpc: number;
  columns: number;
}

/**
 * Read `/DecodeParms` into concrete numbers, or null if we can't be certain
 * what they are.
 *
 * "Can't be certain" has to mean *stop*, not *assume the default*. Getting the
 * predictor wrong doesn't produce a slightly-off image, it produces a sheared
 * noise field — and the short-data guard downstream can't catch it, because
 * predictor-filtered data is *larger* than the samples it encodes, never
 * smaller. So an entry that is present but not a plain number (an indirect
 * reference, say), or a multi-entry parms array, bails out here rather than
 * quietly falling back to "unfiltered".
 *
 * Defaults follow the PDF spec (`Colors` 1, `Columns` 1, `BitsPerComponent` 8),
 * not what an image "obviously" means — the caller cross-checks them against
 * the image's own dimensions and rejects a mismatch.
 */
function flateParms(stream: PDFRawStream): FlateParms | null {
  const ctx = stream.dict.context;
  const raw = stream.dict.get(PDFName.of("DecodeParms")) ?? stream.dict.get(PDFName.of("DP"));
  // Absent entirely is the only case that means "no prediction". An entry that
  // is *present* but doesn't resolve — a dangling reference, a shape we don't
  // model — is not the same thing, and must not collapse into the same answer:
  // that's the silent default this function exists to refuse.
  if (raw === undefined || raw === null) return { predictor: 1, colors: 1, bpc: 8, columns: 1 };

  let dp: unknown = raw instanceof PDFRef ? ctx.lookup(raw) : raw;
  if (dp instanceof PDFArray) {
    if (dp.size() !== 1) return null; // one filter, so anything else is a shape we don't model
    const first = dp.get(0);
    dp = first instanceof PDFRef ? ctx.lookup(first) : first;
  }
  // Must be an actual dictionary. Duck-typing on `.get` is not enough: PDFArray
  // has one too, so a nested array would sail through and then answer every
  // lookup with its fallback — arriving right back at "predictor 1" by a
  // different route. Anything else here (unresolved ref, null, array, number)
  // leaves the image untouched, which is never wrong, only unhelpful.
  if (!(dp instanceof PDFDict)) return null;
  const dict = dp;

  const read = (key: string, fallback: number): number | null => {
    const present = dict.get(PDFName.of(key));
    if (present === undefined || present === null) return fallback;
    const v = present instanceof PDFRef ? ctx.lookup(present) : present;
    return v instanceof PDFNumber ? v.asNumber() : null; // present but unreadable → bail
  };
  const predictor = read("Predictor", 1);
  const colors = read("Colors", 1);
  const bpc = read("BitsPerComponent", 8);
  const columns = read("Columns", 1);
  if (predictor === null || colors === null || bpc === null || columns === null) return null;
  return { predictor, colors, bpc, columns };
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
  let changed = 0;
  let saved = 0;

  const masks = maskedRefs(doc);
  const entries = doc.context.enumerateIndirectObjects();
  for (const [ref, obj] of entries as [PDFRef, unknown][]) {
    if (!(obj instanceof PDFRawStream)) continue;
    if (masks.has(ref.tag)) continue;
    const kind = classify(obj);
    if (!kind) continue;

    const d = obj.dict;
    const w = num(d, "Width");
    const h = num(d, "Height");
    if (!w || !h) continue;
    if (kind.filter === "FlateDecode" && w * h > MAX_FLATE_PIXELS) continue;
    const longest = Math.max(w, h);
    // Only bother when the image is large enough that downsampling helps.
    if (longest <= opts.maxDim && obj.contents.length < 40_000) continue;

    // With prediction in play the parms describe the exact sample layout, so
    // they have to agree with the image dictionary. A disagreement means one of
    // the two isn't what we think it is — skip rather than unfilter against a
    // guess. (Read here because it needs pdf-lib's objects; the decode itself
    // runs in the codec worker.)
    let parms: FlateParms | null = null;
    if (kind.filter === "FlateDecode") {
      parms = flateParms(obj);
      if (!parms) continue;
      if (parms.predictor > 1 && (parms.colors !== kind.comps || parms.bpc !== 8 || parms.columns !== w)) continue;
    }

    const factor = longest > opts.maxDim ? opts.maxDim / longest : 1;
    const nw = Math.max(1, Math.round(w * factor));
    const nh = Math.max(1, Math.round(h * factor));

    // Decode, downsample and re-encode, off the page (`codec.ts`). Null means
    // it couldn't be read or written, which just leaves the original in place.
    // Still yield between images: the page side of each is small, but a
    // document with hundreds of them shouldn't hold the tab for all of them.
    await yieldToUI();
    const encoded = await recodeImage({
      filter: kind.filter,
      bytes: obj.contents,
      width: w,
      height: h,
      comps: kind.comps,
      parms,
      targetWidth: nw,
      targetHeight: nh,
      quality: opts.quality,
    });
    if (!encoded) continue;
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
    // The rebuilt dict is a fresh minimal one, so every key that outlives the
    // pixels has to be carried over by name: /Interpolate and /Intent are
    // rendering hints, /OC binds the image to an optional-content group (drop it
    // and an image on a hidden layer becomes permanently visible), and
    // /StructParent is what ties it to the tagged-PDF tree that carries its
    // alt text — losing that quietly costs the document its accessibility.
    for (const key of ["Interpolate", "Intent", "OC", "StructParent"]) {
      const v = d.get(PDFName.of(key));
      if (v !== undefined) newDict.set(PDFName.of(key), v);
    }

    const newStream = PDFRawStream.of(newDict as never, encoded);
    ctxObj.assign(ref, newStream);
    changed++;
    saved += obj.contents.length - encoded.length;
  }

  return { changed, saved };
}
