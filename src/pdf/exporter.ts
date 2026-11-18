import { LineCapStyle, PDFArray, PDFCatalog,  PDFDict, PDFDocument, PDFHexString, PDFInvalidObject, PDFName, PDFPage, PDFPageLeaf, PDFPageTree, PDFRef, PDFStream, PDFString,  StandardFonts, concatTransformationMatrix, degrees, popGraphicsState, pushGraphicsState, rgb, type PDFFont } from "@cantoo/pdf-lib";
import { fitScale, roomAfter } from "./lineFit";
import { renderPageToCanvas } from "./loader";
import { sanitizeDocument } from "./sanitize";
import { preparePassword } from "./password";
import {
  assertNoStructureTree,
  collectGarbage,
  detachAnnotsOfPages,
  dropStructureTree,
  isolatePageResources,
  pruneFieldsOnPages,
  retargetPageRefs,
  retitleOutlinesInto,
  cutDeletedPages,
  remapPageLabels,
} from "./structure";
import { alignPageTree, setPageList } from "./pageTree";
import { fitCrop, isIdentityPlan, quarterTurn, resolvePlan } from "./pagePlan";
import { safeLinkUrl } from "./url";
import { markPolylines, markStroke } from "./marks";
import { createSourceFontEmbedder, type SourceFontEmbedder } from "./fontEmbed";
import { NO_FONTS, readPageFonts, type PageFonts } from "./fontInfo";
import {
  NO_COLORS,
  offerPageCanvas,
  peekPageColors,
  readPageColors,
  type PageColors,
} from "./fragmentColors";
import { loadJpegEncoder, type JpegEncoder } from "./jpeg";
import { yieldToUI } from "./yield";
import { applyForm, formFieldNames } from "./formFill";
import {
  DEFAULT_STYLE,
  TEXTBOX_LINE_HEIGHT,
  cssFont,
  hexToRgb,
  isFragmentModified,
  keepsSourceTypeface,
  resolveFragmentStyle,
  standardFontKey,
} from "./style";
import { chosenValues, fieldFontSize, fieldValue, shownLines } from "./formValue";
import { annotationPaintOrder, isBoxAnnotation } from "./types";
import type {
  Annotation,
  Edits,
  FormField,
  FormValue,
  FragmentFont,
  LinkAnnot,
  LoadedPdf,
  PageNumberOptions,
  PageRef,
  Redaction,
  Stamp,
  TextBox,
  TextStyle,
  WatermarkOptions,
} from "./types";

/**
 * The colour an edited fragment's cover is painted in.
 *
 * White is the fallback, not the rule: a non-redacted page is copied verbatim
 * and edits are drawn on top, so the cover rectangle was the only thing an edit
 * damaged — and hardcoding it white punched a hole through every coloured pill,
 * table cell, and banner it landed in. `pdf/fragmentColors.ts` samples the flat
 * colour behind the glyphs and says nothing when no flat colour fits, which is
 * exactly when white is as good an answer as any.
 */
function coverColor(colors: PageColors, itemIndex: number) {
  const c = hexToRgb(colors.get(itemIndex)?.fill ?? "#ffffff");
  return rgb(c.r, c.g, c.b);
}

/** Pixels per PDF unit used when rasterising redacted pages (≈216 dpi). */
const REDACT_SCALE = 3;

/**
 * JPEG quality for the redaction raster.
 *
 * High, because this raster *is* the page — there is no vector copy underneath
 * to fall back on, and a redacted document is often evidence. At 216 dpi this
 * shows no ringing around text at normal reading zoom while costing a fraction
 * of lossless: a scanned A4 page measures ~5100 KB as PNG against ~1050 KB
 * here. See `docs/RASTER-CODEC-EVAL.md` for the measurements.
 */
const REDACT_JPEG_QUALITY = 0.85;

export interface ExportInput {
  edits: Edits;
  textBoxes: TextBox[];
  redactions: Redaction[];
  annotations: Annotation[];
  stamps: Stamp[];
  links?: LinkAnnot[];
  /** Filled AcroForm values keyed by field name. */
  formValues?: Record<string, FormValue>;
  /** Flatten the form into the page instead of keeping it fillable. */
  formFlatten?: boolean;
  /** Told the fields that were to be flattened but had to stay fillable. */
  onFormKept?: (names: string[]) => void;
  /** Document-wide page numbering, drawn on every output page. */
  pageNumbers?: PageNumberOptions | null;
  /** Document-wide diagonal watermark, drawn on every output page. */
  watermark?: WatermarkOptions | null;
  /** Encode redacted pages losslessly (PNG only), never as JPEG. Costs several
   *  times the file size; for users who need the raster bit-exact. */
  losslessRaster?: boolean;
  /** The page plan: which source pages go out, in what order, turned how far
   *  beyond their own `/Rotate`. Absent means every page, as loaded. */
  pages?: PageRef[];
  /** Encrypt the download with this password (AES-256), needed to open it.
   *  Used for this one file and never kept. */
  password?: string;
}

/** The part of a finished page the reader sees, in the page's own user space:
 * the loaded view moved to where it sits in the file. A raster replacement is
 * the view itself, at 0,0. */
interface ViewFrame { x: number; y: number; width: number; height: number }

/** Draw a page number onto a finished page (vector or rasterised alike). */
function drawPageNumber(page: PDFPage, font: PDFFont, label: string, opts: PageNumberOptions, frame: ViewFrame): void {
  const c = hexToRgb(opts.color);
  const margin = 28;
  const { width, height } = frame;
  const tw = font.widthOfTextAtSize(label, opts.size);
  const top = opts.position.startsWith("top");
  const y = top ? height - margin - opts.size : margin;
  const x = opts.position.endsWith("left")
    ? margin
    : opts.position.endsWith("right")
      ? width - margin - tw
      : width / 2 - tw / 2;
  page.drawText(label, { x: frame.x + x, y: frame.y + y, size: opts.size, font, color: rgb(c.r, c.g, c.b) });
}

/** Stamp a diagonal text watermark centred on a finished page. */
function drawWatermark(page: PDFPage, font: PDFFont, opts: WatermarkOptions, frame: ViewFrame): void {
  if (!opts.text.trim()) return;
  const c = hexToRgb(opts.color);
  const rad = (opts.angle * Math.PI) / 180;
  const len = font.widthOfTextAtSize(opts.text, opts.size);
  const { width, height } = frame;
  // Start point so the text's midpoint lands at the page centre.
  const x = frame.x + width / 2 - (len / 2) * Math.cos(rad);
  const y = frame.y + height / 2 - (len / 2) * Math.sin(rad);
  page.drawText(opts.text, {
    x,
    y,
    size: opts.size,
    font,
    color: rgb(c.r, c.g, c.b),
    opacity: opts.opacity,
    rotate: degrees(opts.angle),
  });
}

/** Attach clickable URI link annotations to a page (works on vector and
 * rasterised pages alike — links sit above the content).
 *
 * URLs go through `safeLinkUrl` here as well as in the UI: this is the only
 * place a URI reaches the file, so it's where the allow-list has to hold even
 * if a value arrives from a restored session or a future call site. A rejected
 * scheme (`javascript:`, `data:`, `file:`, …) drops the annotation rather than
 * writing an active action into a document the user is about to share. */
function addLinkAnnots(out: PDFDocument, page: PDFPage, links: LinkAnnot[], origin: { x: number; y: number }): void {
  for (const l of links) {
    const url = safeLinkUrl(l.url);
    if (!url) continue;
    const x = origin.x + l.x;
    const y = origin.y + l.y;
    const dict = out.context.obj({
      Type: "Annot",
      Subtype: "Link",
      Rect: [x, y, x + l.width, y + l.height],
      Border: [0, 0, 0],
      A: { Type: "Action", S: "URI", URI: PDFString.of(url) },
    });
    page.node.addAnnot(out.context.register(dict));
  }
}

/** Embed a data-URL image into the document (PNG or JPEG). */
async function embedStamp(out: PDFDocument, dataUrl: string) {
  return dataUrl.startsWith("data:image/png")
    ? out.embedPng(dataUrl)
    : out.embedJpg(dataUrl);
}

/** Encode a canvas to PNG bytes without a base64 round-trip. Falls back to
 * `toDataURL` on the (rare) browser where `toBlob` isn't available. */
async function canvasPngBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  if (typeof canvas.toBlob !== "function") {
    return Uint8Array.from(atob(canvas.toDataURL("image/png").split(",")[1]), (c) =>
      c.charCodeAt(0),
    );
  }
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/png"),
  );
  if (!blob) throw new Error("Could not encode the page image");
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * Embed a finished page raster, choosing whichever of PNG and JPEG is smaller.
 *
 * PNG alone used to ship here, and it is the wrong default for the content that
 * most often gets redacted: lossless has no defence against scanner noise, so a
 * scanned A4 page cost ~5 MB where JPEG costs ~1 MB. But PNG still wins
 * outright on sparse vector pages — a mostly-blank page is a few KB flat and
 * would be an order of magnitude *larger* as JPEG — so neither codec can be
 * picked up front. Encoding both and keeping the smaller is the same
 * "never grow a stream" rule `optimizeImages.ts` follows, and it means turning
 * this on can't make any page bigger than it was before.
 *
 * `encodeJpeg` is null when the user asked for a lossless raster, which skips
 * the comparison entirely. A JPEG encode that throws also falls back to PNG:
 * the page still exports, just larger.
 */
async function embedPageRaster(
  out: PDFDocument,
  canvas: HTMLCanvasElement,
  encodeJpeg: JpegEncoder | null,
) {
  const png = await canvasPngBytes(canvas);
  if (!encodeJpeg) return out.embedPng(png);
  let jpeg: Uint8Array | null = null;
  try {
    jpeg = await encodeJpeg(canvas);
  } catch {
    jpeg = null; // codec unavailable or failed on this page — PNG is still correct
  }
  return jpeg && jpeg.length < png.length ? out.embedJpg(jpeg) : out.embedPng(png);
}

/** Load a data-URL image element (for the raster path). */
function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = dataUrl;
  });
}

const NOTE_SIZE = 12;
const NOTE_PAD = 4;

/**
 * Bottom-left origin of a box after rotating it about its centre. `rotDeg` is
 * the on-screen clockwise angle; PDF space is y-up, so the PDF angle is `-rot`.
 * pdf-lib's `rotate` pivots about the origin, so we pre-shift the origin to keep
 * the centre fixed. Returns the origin plus the matching pdf-lib angle.
 */
function rotatedBox(x: number, y: number, w: number, h: number, rotDeg: number) {
  const th = (-rotDeg * Math.PI) / 180;
  const cx = x + w / 2;
  const cy = y + h / 2;
  const cos = Math.cos(th);
  const sin = Math.sin(th);
  const ox = (-w / 2) * cos - (-h / 2) * sin;
  const oy = (-w / 2) * sin + (-h / 2) * cos;
  return { x: cx + ox, y: cy + oy, rotate: degrees(-rotDeg) };
}

/** Draw vector annotations onto a pdf-lib page (PDF coords, y up). */
function drawVectorAnnots(page: PDFPage, annots: Annotation[], helv: PDFFont): void {
  for (const a of annotationPaintOrder(annots)) {
    const c = hexToRgb(a.color);
    const color = rgb(c.r, c.g, c.b);
    if (a.kind === "highlight") {
      if (a.rotation) {
        const r = rotatedBox(a.x, a.y, a.width, a.height, a.rotation);
        page.drawRectangle({ x: r.x, y: r.y, width: a.width, height: a.height, color, opacity: 0.4, rotate: r.rotate });
      } else {
        page.drawRectangle({ x: a.x, y: a.y, width: a.width, height: a.height, color, opacity: 0.4 });
      }
    } else if (a.kind === "rect") {
      const t = a.strokeWidth;
      const { x, y, width: w, height: h } = a;
      if (a.rotation) {
        const r = rotatedBox(x, y, w, h, a.rotation);
        page.drawRectangle({ x: r.x, y: r.y, width: w, height: h, borderColor: color, borderWidth: t, rotate: r.rotate });
      } else {
        page.drawLine({ start: { x, y }, end: { x: x + w, y }, thickness: t, color });
        page.drawLine({ start: { x: x + w, y }, end: { x: x + w, y: y + h }, thickness: t, color });
        page.drawLine({ start: { x: x + w, y: y + h }, end: { x, y: y + h }, thickness: t, color });
        page.drawLine({ start: { x, y: y + h }, end: { x, y }, thickness: t, color });
      }
    } else if (a.kind === "check" || a.kind === "cross") {
      // Rotation is applied to the points here because, unlike `rect` and
      // `highlight`, there is no pdf-lib primitive to hand it to. Dropping it
      // is invisible until someone rotates a mark and the exported file does
      // not match what the overlay drew.
      const t = markStroke(a.strokeWidth, a);
      for (const line of markPolylines(a.kind, a, a.rotation ?? 0)) {
        for (let i = 1; i < line.length; i++) {
          page.drawLine({ start: line[i - 1], end: line[i], thickness: t, color, lineCap: LineCapStyle.Round });
        }
      }
    } else if (a.kind === "line" || a.kind === "arrow") {
      page.drawLine({ start: { x: a.x1, y: a.y1 }, end: { x: a.x2, y: a.y2 }, thickness: a.strokeWidth, color });
      if (a.kind === "arrow") {
        const len = Math.max(8, a.strokeWidth * 4);
        const back = Math.atan2(a.y2 - a.y1, a.x2 - a.x1) + Math.PI;
        for (const off of [-Math.PI / 6, Math.PI / 6]) {
          page.drawLine({
            start: { x: a.x2, y: a.y2 },
            end: { x: a.x2 + len * Math.cos(back + off), y: a.y2 + len * Math.sin(back + off) },
            thickness: a.strokeWidth,
            color,
          });
        }
      }
    } else if (a.kind === "pen") {
      for (let i = 1; i < a.pts.length; i++) {
        page.drawLine({ start: a.pts[i - 1], end: a.pts[i], thickness: a.strokeWidth, color });
      }
    } else if (a.kind === "note") {
      const text = sanitize(a.text || " ", helv);
      const w = helv.widthOfTextAtSize(text, NOTE_SIZE) + NOTE_PAD * 2;
      const h = NOTE_SIZE + NOTE_PAD * 2;
      // Turned about its top-left anchor, as the overlay is. pdf-lib turns each
      // primitive about its own origin, so place each origin by turning its
      // offset from the anchor.
      const rot = a.rotation ?? 0;
      const th = (-rot * Math.PI) / 180;
      const at = (dx: number, dy: number) => ({
        x: a.x + dx * Math.cos(th) - dy * Math.sin(th),
        y: a.y + dx * Math.sin(th) + dy * Math.cos(th),
      });
      const turn = rot ? { rotate: degrees(-rot) } : {};
      page.drawRectangle({
        ...at(0, -h),
        width: w,
        height: h,
        color,
        opacity: 0.92,
        borderColor: rgb(0, 0, 0),
        borderWidth: 0.5,
        ...turn,
      });
      page.drawText(text, { ...at(NOTE_PAD, -h + NOTE_PAD + 1), size: NOTE_SIZE, font: helv, color: rgb(0, 0, 0), ...turn });
    }
  }
}

/** Draw annotations onto the rasterisation canvas (screen coords, y down). */
function drawRasterAnnots(
  ctx: CanvasRenderingContext2D,
  annots: Annotation[],
  H: number,
  S: number,
): void {
  const X = (x: number) => x * S;
  const Y = (y: number) => (H - y) * S;
  for (const a of annotationPaintOrder(annots)) {
    ctx.strokeStyle = a.color;
    ctx.fillStyle = a.color;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    // Rotate the canvas about the box centre for rotated box kinds.
    const box = isBoxAnnotation(a) ? a : null;
    const rotate = box?.rotation ?? 0;
    if (box && rotate) {
      ctx.save();
      ctx.translate(X(box.x + box.width / 2), Y(box.y + box.height / 2));
      ctx.rotate((rotate * Math.PI) / 180);
    }
    if (a.kind === "highlight") {
      ctx.save();
      ctx.globalAlpha = 0.4;
      if (rotate) ctx.fillRect(-a.width * S / 2, -a.height * S / 2, a.width * S, a.height * S);
      else ctx.fillRect(X(a.x), Y(a.y + a.height), a.width * S, a.height * S);
      ctx.restore();
    } else if (a.kind === "rect") {
      ctx.lineWidth = a.strokeWidth * S;
      if (rotate) ctx.strokeRect(-a.width * S / 2, -a.height * S / 2, a.width * S, a.height * S);
      else ctx.strokeRect(X(a.x), Y(a.y + a.height), a.width * S, a.height * S);
    } else if (a.kind === "check" || a.kind === "cross") {
      ctx.lineWidth = markStroke(a.strokeWidth, a) * S;
      ctx.beginPath();
      // Unrotated on purpose: the canvas is already rotated about the box
      // centre above, as it is for every box kind. See `markPolylines`.
      for (const line of markPolylines(a.kind, a)) {
        // A rotated box has the canvas already translated to its centre, so
        // the glyph is drawn about the origin rather than in page coordinates.
        line.forEach((p, i) => {
          const px = rotate ? (p.x - a.x - a.width / 2) * S : X(p.x);
          const py = rotate ? (a.y + a.height / 2 - p.y) * S : Y(p.y);
          if (i) ctx.lineTo(px, py);
          else ctx.moveTo(px, py);
        });
      }
      ctx.stroke();
    } else if (a.kind === "line" || a.kind === "arrow") {
      ctx.lineWidth = a.strokeWidth * S;
      const sx1 = X(a.x1), sy1 = Y(a.y1), sx2 = X(a.x2), sy2 = Y(a.y2);
      ctx.beginPath();
      ctx.moveTo(sx1, sy1);
      ctx.lineTo(sx2, sy2);
      ctx.stroke();
      if (a.kind === "arrow") {
        const L = Math.max(8, a.strokeWidth * 4) * S;
        const back = Math.atan2(sy2 - sy1, sx2 - sx1) + Math.PI;
        ctx.beginPath();
        for (const off of [-Math.PI / 6, Math.PI / 6]) {
          ctx.moveTo(sx2, sy2);
          ctx.lineTo(sx2 + L * Math.cos(back + off), sy2 + L * Math.sin(back + off));
        }
        ctx.stroke();
      }
    } else if (a.kind === "pen") {
      ctx.lineWidth = a.strokeWidth * S;
      ctx.beginPath();
      a.pts.forEach((p, i) => (i ? ctx.lineTo(X(p.x), Y(p.y)) : ctx.moveTo(X(p.x), Y(p.y))));
      ctx.stroke();
    } else if (a.kind === "note") {
      const size = NOTE_SIZE * S;
      ctx.font = `${size}px sans-serif`;
      ctx.textBaseline = "top";
      const tw = ctx.measureText(a.text || " ").width;
      const pad = NOTE_PAD * S;
      ctx.save();
      ctx.translate(X(a.x), Y(a.y));
      if (a.rotation) ctx.rotate((a.rotation * Math.PI) / 180);
      ctx.save();
      ctx.globalAlpha = 0.92;
      ctx.fillStyle = a.color;
      ctx.fillRect(0, 0, tw + pad * 2, size + pad * 2);
      ctx.restore();
      ctx.fillStyle = "#000";
      ctx.fillText(a.text, pad, pad);
      ctx.restore();
    }
    if (rotate) ctx.restore();
  }
}

/** Drop characters the standard (WinAnsi) fonts cannot encode. */
function sanitize(text: string, font: PDFFont): string {
  let out = "";
  for (const ch of text) {
    try {
      font.encodeText(ch);
      out += ch;
    } catch {
      out += ch === "\t" ? "    " : "";
    }
  }
  return out;
}

/**
 * Produce a new PDF applying text edits, new text boxes, and redactions.
 *
 * Pages without redactions keep their original vector content and only get
 * edits/new text drawn on top. Pages with redactions are rasterised to an
 * image with every edit, text box, and redaction baked in — this genuinely
 * removes the redacted content from the output (no recoverable text layer).
 *
 * The source document is edited **in place** and saved, rather than rebuilt by
 * copying pages into a new one. A rebuild dropped everything at catalog level
 * (outline, page labels, tags and `/Lang`, named destinations, layers, the
 * form) and duplicated every shared font and image once per page; see
 * `pdf/structure.ts` for what editing in place has to do instead to keep a
 * redacted page from surviving by some other route.
 */
export async function exportPdf(
  loaded: LoadedPdf,
  input: ExportInput,
  onProgress?: (page: number, total: number) => void,
): Promise<Uint8Array> {
  const { edits, textBoxes, redactions, annotations, stamps, links = [], formValues = {}, pageNumbers, watermark, losslessRaster = false } = input;
  // Which source pages ship, where, and turned how far. Overlay objects keep
  // their *source* page index, so a page's markup is drawn on it wherever it
  // goes; pages left out of the plan were deleted and must not survive.
  const plan = resolvePlan(input.pages, loaded.pages.length);
  const planned = new Map(
    plan.map((p, pos) => [p.index, { pos, rotate: p.rotate, crop: fitCrop(p.crop, loaded.pages[p.index].viewBox) }] as const),
  );
  // updateMetadata: false stops pdf-lib stamping its own Producer / Creator /
  // CreationDate / ModDate on load; sanitizeDocument() then clears anything
  // else before save (see below).
  const out = await PDFDocument.load(loaded.bytes.slice(0), { updateMetadata: false });
  // Before anything asks pdf-lib for a page: make its page *i* the object the
  // preview showed at *i*. On a malformed tree they differ, and the raster
  // would replace the wrong page.
  alignPageTree(out, loaded.pages.map((p) => p.ref));
  // The finished page for each source page, by source index: the original, or
  // the raster that replaces it. Put in plan order once, at the end.
  const finished: PDFPage[] = out.getPages();
  // Pages replaced by a raster: old page ref → its replacement. Everything that
  // pointed at the old page is moved over, and nothing of the old one survives.
  const replaced = new Map<PDFRef, PDFRef>();
  const fontCache = new Map<string, PDFFont>();

  const getFont = async (key: keyof typeof StandardFonts): Promise<PDFFont> => {
    let font = fontCache.get(key);
    if (!font) {
      font = await out.embedFont(StandardFonts[key]);
      fontCache.set(key, font);
    }
    return font;
  };

  const helv = await getFont("Helvetica");
  // Before any page is copied or rasterised: a flattened field is page
  // content from here on.
  // The fields that stayed a form are reported once the pages are settled: one
  // on a redacted or deleted page didn't stay anything.
  const form = applyForm(out, formValues, !!input.formFlatten, helv);
  const wmFont = watermark ? await getFont("HelveticaBold") : null;

  // When any existing text is edited, spin up the source-font embedder so the
  // edits can be redrawn in the document's own typeface. Lazily built (and only
  // when there are edits) since it re-parses the file with PDF.js.
  const anyEdits = loaded.pages.some((pd) => pd.fragments.some((f) => isFragmentModified(f, edits[f.id])));
  let embedder: SourceFontEmbedder | null = null;
  if (anyEdits) embedder = await createSourceFontEmbedder(loaded.bytes, out);

  // Resolved once, on the first redacted page, and only when a lossy raster is
  // allowed — loading the codec costs a WASM init, and most documents never
  // take the raster path at all.
  let jpegEncoder: Promise<JpegEncoder> | null = null;
  const getJpegEncoder = () =>
    losslessRaster ? null : (jpegEncoder ??= loadJpegEncoder(REDACT_JPEG_QUALITY));

  let done = 0;
  for (const pageData of loaded.pages) {
    const slot = planned.get(pageData.pageIndex);
    if (!slot) continue; // deleted: removed (and scrubbed) below
    onProgress?.(++done, plan.length);
    // Let the browser paint progress / stay responsive between pages (the
    // per-page render + encode is the heavy, main-thread part).
    await yieldToUI();
    const i = pageData.pageIndex;
    const pageBoxes = textBoxes.filter((t) => t.pageIndex === i);
    const pageRedactions = redactions.filter((r) => r.pageIndex === i);
    const pageAnnots = annotations.filter((a) => a.pageIndex === i);
    const pageStamps = stamps.filter((s) => s.pageIndex === i);
    const pageLinks = links.filter((l) => l.pageIndex === i);
    // Only a *true* redaction forces the destructive raster path. Whiteout
    // covers stay vector.
    const pageCovers = pageRedactions.filter((r) => r.cover);
    const needsRaster = pageRedactions.some((r) => !r.cover);
    // The document's own fonts for this page, so a redrawn fragment falls back
    // to the *right* standard font (and, on the raster path, is drawn in the
    // page's actual face) instead of a generic guess.
    const pageEdited = pageData.fragments.some((f) => isFragmentModified(f, edits[f.id]));
    const sourceFonts: PageFonts = pageEdited ? await readPageFonts(loaded.bytes, i) : NO_FONTS;
    // ...and the colours around and of each edited fragment, so covering the
    // original glyphs doesn't cost the page its artwork and the replacement
    // isn't redrawn in a colour the document never used. Usually already
    // sampled from the raster the user was looking at; rasterises the page only
    // if they never scrolled to it (a restored session exported straight away).
    // The raster path renders this page itself and samples from that raster
    // (below), so only the vector path needs to ask for one here.
    const pageColors: PageColors =
      pageEdited && !needsRaster ? await readPageColors(loaded.bytes, pageData) : NO_COLORS;

    // Both paths produce a finished PDFPage; page numbers, watermark, and link
    // annotations are then applied uniformly on top. The page number is the
    // page's position in the plan, not its source index — after a reorder the
    // two differ, and the reader counts positions.
    // `frame` is what the reader sees (the crop, or the whole view) for the
    // page number and watermark; links are drawn in whole-view space, so they
    // move by the view's own corner only — never by the crop's.
    const applyPageLayers = (page: PDFPage, frame: ViewFrame, origin: { x: number; y: number }) => {
      if (pageNumbers) drawPageNumber(page, helv, String(pageNumbers.start + slot.pos), pageNumbers, frame);
      if (watermark && wmFont) drawWatermark(page, wmFont, watermark, frame);
      addLinkAnnots(out, page, pageLinks, origin);
    };
    // What the reader will see of the page, in view space: the plan's crop, or
    // the whole view. Page numbers and the watermark are placed against it.
    const seen = slot.crop ?? { x: 0, y: 0, ...pageData.viewBox };

    if (needsRaster) {
      const oldRef = finished[i].ref;
      const rasterPage = await rasterisePage(out, loaded, pageData.pageIndex, edits, sourceFonts, pageBoxes, pageRedactions, pageAnnots, pageStamps, pageEdited, await getJpegEncoder(), formValues);
      finished[i] = rasterPage;
      replaced.set(oldRef, rasterPage.ref);
      applyPageLayers(rasterPage, seen, { x: 0, y: 0 });
      // The raster is the view at 0,0, so the crop goes on as it is.
      if (slot.crop) rasterPage.setCropBox(seen.x, seen.y, seen.width, seen.height);
      continue;
    }

    // Vector path: draw edits + text boxes on top of the original page.
    const page = finished[i];
    // Everything below is in view space (see `PageData.origin`); one move puts
    // it back where the view sits in this page's own user space.
    const ox = pageData.origin?.x ?? 0;
    const oy = pageData.origin?.y ?? 0;
    const moved = ox !== 0 || oy !== 0;
    if (moved) page.pushOperators(pushGraphicsState(), concatTransformationMatrix(1, 0, 0, 1, ox, oy));

    for (const fragment of pageData.fragments) {
      const edit = edits[fragment.id];
      if (!isFragmentModified(fragment, edit)) continue;
      const style = resolveFragmentStyle(
        fragment,
        edit!.style,
        sourceFonts.get(fragment.itemIndex),
        pageColors.get(fragment.itemIndex)?.ink,
      );
      const x = fragment.transform[4];
      const y = fragment.transform[5];
      const descent = style.size * 0.22;

      // Prefer the document's own font when the user kept the original typeface
      // (changed only text / size / colour) and it has a glyph for every
      // character typed; otherwise fall back to a standard font.
      const keptTypeface = keepsSourceTypeface(edit!.style);
      let font: PDFFont | null = null;
      if (keptTypeface && embedder) {
        const src = await embedder.get(i, fragment.itemIndex);
        if (src && src.covers(edit!.text)) font = src.font;
      }
      if (!font) font = await getFont(standardFontKey(style.font, style.bold, style.italic));

      const text = sanitize(edit!.text, font);
      // Kept to the room before the next run on its line — see lineFit.ts.
      const k = fitScale(font.widthOfTextAtSize(text, style.size), fragment.width, roomAfter(fragment, pageData.fragments, edits));
      const textWidth = font.widthOfTextAtSize(text, style.size) * k;
      // Cover the original glyphs (and the new text if it's longer), then redraw.
      page.drawRectangle({
        x: x - style.size * 0.05,
        y: y - descent,
        width: Math.max(fragment.width, textWidth) + style.size * 0.1,
        height: style.size * 1.2,
        color: coverColor(pageColors, fragment.itemIndex),
      });
      const c = hexToRgb(style.color);
      // Condensed about the run's own start, so x stays where it was.
      if (k < 1) page.pushOperators(pushGraphicsState(), concatTransformationMatrix(k, 0, 0, 1, x * (1 - k), 0));
      page.drawText(text, { x, y, size: style.size, font, color: rgb(c.r, c.g, c.b) });
      if (k < 1) page.pushOperators(popGraphicsState());
    }

    for (const box of pageBoxes) {
      if (!box.text.trim()) continue;
      const font = await getFont(
        standardFontKey(box.style.font, box.style.bold, box.style.italic),
      );
      const c = hexToRgb(box.style.color);
      // Multi-line: the first line's baseline is at box.y; each subsequent line
      // steps down by the shared line height (matches the on-screen overlay).
      const lineStep = box.style.size * TEXTBOX_LINE_HEIGHT;
      // A turned box pivots about its first baseline's start (as the overlay
      // does); each later line steps "down" along the box's own turned axis.
      const rot = box.rotation ?? 0;
      const th = (-rot * Math.PI) / 180;
      box.text.split("\n").forEach((line, i) => {
        const d = i * lineStep;
        page.drawText(sanitize(line, font), {
          x: box.x + d * Math.sin(th),
          y: box.y - d * Math.cos(th),
          size: box.style.size,
          font,
          color: rgb(c.r, c.g, c.b),
          ...(rot ? { rotate: degrees(-rot) } : {}),
        });
      });
    }

    drawVectorAnnots(page, pageAnnots, helv);

    for (const s of pageStamps) {
      const img = await embedStamp(out, s.dataUrl);
      if (s.rotation) {
        const r = rotatedBox(s.x, s.y, s.width, s.height, s.rotation);
        page.drawImage(img, { x: r.x, y: r.y, width: s.width, height: s.height, rotate: r.rotate });
      } else {
        page.drawImage(img, { x: s.x, y: s.y, width: s.width, height: s.height });
      }
    }

    // Whiteout covers — vector filled rects on top (non-destructive).
    for (const cov of pageCovers) {
      const c = hexToRgb(cov.color);
      page.drawRectangle({ x: cov.x, y: cov.y, width: cov.width, height: cov.height, color: rgb(c.r, c.g, c.b) });
    }
    if (moved) page.pushOperators(popGraphicsState());

    const frame = { x: ox + seen.x, y: oy + seen.y, width: seen.width, height: seen.height };
    applyPageLayers(page, frame, { x: ox, y: oy });
    // Cropping is the page's CropBox: what's outside it stays in the file,
    // hidden, as every PDF crop leaves it (Redact is what removes things).
    if (slot.crop) page.setCropBox(frame.x, frame.y, frame.width, frame.height);
  }

  await embedder?.destroy();

  // Arrange the pages as planned: each turned by its own `/Rotate` plus the
  // plan's turn, in plan order. Deleted pages, and originals a raster
  // replaced, drop out of the page list here and are cut loose and swept below.
  const gone = new Set<PDFRef>();
  loaded.pages.forEach((pd, i) => {
    const slot = planned.get(pd.pageIndex);
    if (!slot) gone.add(finished[i].ref);
    else finished[i].setRotation(degrees(quarterTurn(pd.rotation + slot.rotate)));
  });
  setPageList(out, plan.map((p) => finished[p.index]));
  if (!isIdentityPlan(plan, finished.length)) remapPageLabels(out, plan.map((p) => p.index));

  // Order matters. Fields and annotations are found by the *old* page refs, so
  // they go before the refs move; bookmarks are matched to the *new* refs, so
  // after. The sanitiser unhooks things from the catalog, so it goes before the
  // sweep; and resource narrowing and the sweep need pdf-lib's lazily-embedded
  // fonts and images to exist as objects, so they go after `flush()`.
  // Deleted pages are treated like replaced ones with no replacement: their
  // fields and comment threads are cut, every reference to them is cut, and
  // the structure tree (which repeats their text) goes.
  const anyReplaced = replaced.size > 0 || gone.size > 0;
  if (anyReplaced) {
    const oldPages = new Set([...replaced.keys(), ...gone]);
    pruneFieldsOnPages(out, oldPages);
    detachAnnotsOfPages(out, oldPages);
    retargetPageRefs(out, replaced);
    cutDeletedPages(out, gone);
    retitleOutlinesInto(out, new Set(replaced.values()));
    dropStructureTree(out);
  }
  if (form.keptFillable.length > 0) {
    const left = formFieldNames(out);
    const kept = form.keptFillable.filter((n) => left.has(n));
    if (kept.length > 0) input.onFormKept?.(kept);
  }
  // Privacy: strip metadata / timestamps / active content before handing the
  // file back (the app never uploads, so the download is the only thing that
  // leaves the device — it should carry nothing identifying).
  sanitizeDocument(out);
  await out.flush();
  if (anyReplaced) isolatePageResources(out);
  collectGarbage(out);
  if (anyReplaced) assertNoStructureTree(out);
  // Last, so everything above is what gets encrypted. The password opens the
  // file and allows everything once open: permission flags only ask a viewer
  // to hold back, so offering them would promise protection a file can't
  // give. The owner password is random and thrown away, so it isn't a second
  // way in. Encrypting writes a fresh random file identifier (the sanitiser
  // removed the original's), which the cipher needs.
  if (input.password) {
    out.encrypt({
      userPassword: preparePassword(input.password),
      ownerPassword: randomSecret(),
      permissions: {
        printing: "highResolution",
        modifying: true,
        copying: true,
        annotating: true,
        fillingForms: true,
        contentAccessibility: true,
        documentAssembly: true,
      },
    });
    encryptLooseStrings(out);
  }
  // Appearances were generated when (and if) the form was flattened; asking
  // pdf-lib to regenerate every field's on save would rewrite the untouched
  // ones and throws on fields whose /DA it can't parse.
  return out.save({ updateFieldAppearances: false });
}

/** One line of a multi-line answer, broken at spaces (or inside a word too
 * long for a line) to fit `room` — as the preview's text box wraps it. Stops
 * after `max` lines: the box shows no more, and a huge unbroken value (a
 * pasted link, a malformed file) mustn't stall the export measuring it. */
function wrapLine(ctx: CanvasRenderingContext2D, text: string, room: number, max: number): string[] {
  const fits = (t: string) => ctx.measureText(t).width <= room;
  if (text === "" || fits(text)) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest !== "" && out.length < max) {
    if (fits(rest)) {
      out.push(rest);
      break;
    }
    // The longest start that fits, found by halving (at least one character).
    let lo = 1;
    let hi = rest.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (fits(rest.slice(0, mid).trimEnd())) lo = mid;
      else hi = mid - 1;
    }
    // Back to the last space in it, when there is one.
    const space = rest.slice(0, lo + 1).search(/\s\S*$/);
    const cut = space > 0 ? space + 1 : lo;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).replace(/^\s+/, "");
  }
  return out;
}

/**
 * A redacted page becomes a picture and loses its fields; their answers are
 * drawn into it as the preview shows them, in the preview's Helvetica-like
 * face, so the page still says what the form said. Redaction covers are
 * painted after, over whatever they cover. A field pdf.js paints into the
 * canvas itself (`painted`: read-only text, a locked widget) isn't drawn again.
 */
function drawRasterForm(
  ctx: CanvasRenderingContext2D,
  fields: FormField[],
  values: Record<string, FormValue>,
  H: number,
  S: number,
): void {
  for (const f of fields) {
    const v = fieldValue(f, values);
    const { x, y, width, height } = f.rect;
    const top = (H - (y + height)) * S;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x * S, top, width * S, height * S);
    ctx.clip();
    ctx.fillStyle = "#000000";
    ctx.strokeStyle = "#000000";
    if (f.type === "checkbox" || f.type === "radio") {
      const on = f.type === "checkbox" ? v === true : typeof v === "string" && v !== "" && v === f.onValue;
      if (on) {
        const side = Math.min(width, height) * S;
        const cx = (x + width / 2) * S;
        const cy = top + (height * S) / 2;
        if (f.type === "radio") {
          ctx.beginPath();
          ctx.arc(cx, cy, side * 0.25, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.lineWidth = Math.max(1, side * 0.12);
          ctx.beginPath();
          ctx.moveTo(cx - side * 0.3, cy);
          ctx.lineTo(cx - side * 0.08, cy + side * 0.25);
          ctx.lineTo(cx + side * 0.32, cy - side * 0.28);
          ctx.stroke();
        }
      }
    } else if (!f.painted) {
      // pdf.js already painted the ones it paints itself (read-only text, a
      // locked widget) — with a value that can't have changed.
      const size = fieldFontSize(height);
      const lineH = size * 1.15;
      ctx.font = `${size * S}px Helvetica, Arial, sans-serif`;
      ctx.textBaseline = "alphabetic";
      const left = (x + 2) * S;
      if (f.type === "choice" && !f.combo) {
        // A list shows every option, the chosen ones marked — as the preview
        // and pdf-lib's own look do. A value no option holds is listed last.
        const chosen = chosenValues(v);
        const options = f.options ?? [];
        const extra = chosen.filter((c) => !options.some((o) => o.value === c)).map((c) => ({ value: c, label: c }));
        const all = [...options, ...extra];
        // Scrolled, as the preview's list is, so the first chosen option shows.
        const rows = Math.max(1, Math.floor((height - 2) / lineH));
        const first = all.findIndex((o) => chosen.includes(o.value));
        const start = first >= rows ? first : 0;
        all.slice(start, start + rows + 1).forEach((o, i) => {
          const rowTop = top + (2 + lineH * i) * S;
          if (chosen.includes(o.value)) {
            ctx.fillStyle = "#99c1da";
            ctx.fillRect(x * S, rowTop, width * S, lineH * S);
            ctx.fillStyle = "#000000";
          }
          ctx.fillText(o.label, left, rowTop + size * S);
        });
      } else {
        const room = (width - 4) * S;
        const rows = Math.max(1, Math.ceil(height / lineH));
        // A dropdown shows its first chosen option, as the preview does.
        const lines = f.multiline
          ? shownLines(f, v).flatMap((l) => wrapLine(ctx, l, room, rows)).slice(0, rows)
          : shownLines(f, v).slice(0, 1);
        lines.forEach((line, i) => {
          const base = f.multiline ? top + (2 + size + lineH * i) * S : top + ((height + size * 0.7) / 2) * S;
          ctx.fillText(line, left, base);
        });
      }
    }
    ctx.restore();
  }
}

/** Render a page to an image with edits, text boxes, and redactions baked in,
 * then add it to the output document as a full-page image. */
async function rasterisePage(
  out: PDFDocument,
  loaded: LoadedPdf,
  pageIndex: number,
  edits: Edits,
  sourceFonts: PageFonts,
  boxes: TextBox[],
  redactions: Redaction[],
  annots: Annotation[],
  stamps: Stamp[],
  /** Whether any fragment on this page was edited. Passed in rather than
   * recomputed: it decides both the font harvest and the colour sample, and two
   * copies of the same predicate is how one of them ends up out of date. */
  pageEdited: boolean,
  encodeJpeg: JpegEncoder | null,
  /** The form's answers: the page is drawn without its fields, and they go
   * back on as the preview shows them — under the redactions. */
  formValues: Record<string, FormValue> = {},
): Promise<PDFPage> {
  const pageData = loaded.pages[pageIndex];
  const H = pageData.viewBox.height;
  // In user space (no turn): every overlay object is stored there, and the
  // page's turn is put back on the replacement as `/Rotate` below.
  const canvas = await renderPageToCanvas(loaded.bytes, pageIndex, REDACT_SCALE, undefined, 0, true);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not get 2D canvas context");
  const S = REDACT_SCALE;

  // Read this page's colours off this raster, while it's still clean — it's
  // about to be drawn on, and it's a better one than `readPageColors` would
  // rasterise for itself. A no-op if the page was already sampled on screen,
  // which keeps the on-screen and exported covers identical.
  //
  // Only when this page actually has an edited fragment. Nothing else reads the
  // sample, and it costs a full-page `getImageData` plus the per-fragment
  // tallies (63ms median, 146ms worst on a 4.6M px canvas) — which on a
  // redacted-but-unedited document is the whole bill for data no one reads.
  if (pageEdited) offerPageCanvas(loaded.bytes, pageData, canvas, 0);
  const pageColors = pageEdited ? peekPageColors(loaded.bytes, pageIndex) : NO_COLORS;

  const drawText = (
    text: string,
    x: number,
    yBaseline: number,
    style: TextStyle,
    face?: FragmentFont | null,
    rotation = 0,
    /** Horizontal condensing, about the text's start — see lineFit.ts. */
    scaleX = 1,
  ) => {
    if (!text) return;
    ctx.font = cssFont(style, style.size * S, face);
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = style.color;
    // Multi-line (text boxes): step each line down by the shared line height.
    // Single-line callers (edited fragments) have no "\n", so this is a no-op
    // for them.
    const lineStep = style.size * TEXTBOX_LINE_HEIGHT;
    // Turned text boxes pivot about the first baseline's start, as on screen.
    ctx.save();
    ctx.translate(x * S, (H - yBaseline) * S);
    if (rotation) ctx.rotate((rotation * Math.PI) / 180);
    if (scaleX !== 1) ctx.scale(scaleX, 1);
    text.split("\n").forEach((line, i) => {
      ctx.fillText(line, 0, i * lineStep * S);
    });
    ctx.restore();
  };

  // Edited fragments: cover original glyphs in white, then redraw.
  for (const fragment of pageData.fragments) {
    const edit = edits[fragment.id];
    if (!isFragmentModified(fragment, edit)) continue;
    const source = sourceFonts.get(fragment.itemIndex) ?? null;
    const colors = pageColors.get(fragment.itemIndex);
    const style = resolveFragmentStyle(fragment, edit!.style, source, colors?.ink);
    // The page's own face, on the same terms as the vector path: only while
    // the edit keeps it. `renderPageToCanvas` above has already loaded it.
    const face = keepsSourceTypeface(edit!.style) ? source : null;
    const x = fragment.transform[4];
    const y = fragment.transform[5];
    // Measure the replacement text instead of estimating it. The old estimate
    // (`text.length * size * 0.2`) under-reports badly for anything wider than
    // narrow lowercase — wide glyphs, capitals, most non-Latin scripts — so the
    // cover fell short of the replacement and the *original* text stayed visible
    // beyond it. On this path that's a redaction failure, not a cosmetic one:
    // the raster is all that survives into the output, so whatever it shows is
    // permanent and whatever the user thought they had overwritten is not.
    ctx.font = cssFont(style, style.size * S, face);
    const lines = edit!.text.split("\n");
    // Kept to the room before the next run on its line, as on screen and on the
    // vector path — see lineFit.ts.
    const k = fitScale(
      Math.max(...lines.map((line) => ctx.measureText(line).width / S)),
      fragment.width,
      roomAfter(fragment, pageData.fragments, edits),
    );
    const widest = Math.max(...lines.map((line) => ctx.measureText(line).width / S)) * k;
    // Extra lines step downward from the baseline, so the cover has to grow with
    // them or the replacement text lands on top of un-covered original glyphs.
    const coverHeight = style.size * 1.2 + (lines.length - 1) * style.size * TEXTBOX_LINE_HEIGHT;
    ctx.fillStyle = colors?.fill ?? "#ffffff";
    ctx.fillRect(
      (x - style.size * 0.05) * S,
      (H - (y + style.size * 0.98)) * S,
      (Math.max(fragment.width, widest) + style.size * 0.1) * S,
      coverHeight * S,
    );
    drawText(edit!.text, x, y, style, face, 0, k);
  }

  // New text boxes.
  for (const box of boxes) drawText(box.text, box.x, box.y, box.style, null, box.rotation ?? 0);

  // The form's answers, as they are now (the raster was drawn without them).
  drawRasterForm(ctx, pageData.fields, formValues, H, S);

  // Annotations sit above content but below redactions.
  drawRasterAnnots(ctx, annots, H, S);

  // Stamps (signatures / images).
  for (const s of stamps) {
    const img = await loadImage(s.dataUrl);
    if (s.rotation) {
      ctx.save();
      ctx.translate((s.x + s.width / 2) * S, (H - (s.y + s.height / 2)) * S);
      ctx.rotate((s.rotation * Math.PI) / 180);
      ctx.drawImage(img, -s.width * S / 2, -s.height * S / 2, s.width * S, s.height * S);
      ctx.restore();
    } else {
      ctx.drawImage(img, s.x * S, (H - (s.y + s.height)) * S, s.width * S, s.height * S);
    }
  }

  // Redactions painted solid — this is what actually removes the content,
  // since only the raster survives into the output page.
  for (const r of redactions) {
    ctx.fillStyle = r.color;
    ctx.fillRect(r.x * S, (H - (r.y + r.height)) * S, r.width * S, r.height * S);
  }

  // Encoded via a Blob, not `toDataURL()`. A redacted A4 page at 3× is ~7 MP,
  // whose PNG becomes a ~10-30 MB base64 *string* that pdf-lib then decodes back
  // to bytes — two large copies plus the base64 33% overhead, all on the main
  // thread and all held at once. `toBlob` hands over the encoded bytes directly,
  // which on a document with several redacted pages is the difference between
  // exporting and an out-of-memory tab.
  const image = await embedPageRaster(out, canvas, encodeJpeg);
  const wPt = pageData.viewBox.width;
  const hPt = pageData.viewBox.height;
  // Not in the page tree yet: the exporter swaps it in for the original when
  // it sets the final page list. Pin what a page could otherwise inherit from
  // a parent node; the raster is the page unturned, and its turn is set after.
  const page = PDFPage.create(out);
  page.setSize(wPt, hPt);
  page.setRotation(degrees(0));
  page.setCropBox(0, 0, wPt, hPt);
  page.drawImage(image, { x: 0, y: 0, width: wPt, height: hPt });
  return page;
}

export { DEFAULT_STYLE };

/** 32 random bytes as hex. */
/**
 * `@cantoo/pdf-lib` encrypts streams only. Everything packed into an object
 * stream is covered by that stream's encryption, but the writer keeps some
 * objects outside one — the catalog, the page tree and pages, signature
 * dictionaries, non-zero generations and every stream's own dictionary — and
 * their strings went out in the clear: readable without the password, and
 * scrambled for the person who has it (a reader decrypts them anyway). So the
 * strings in exactly those objects are encrypted here, with the file key, as
 * the writer would have. The predicate mirrors `PDFStreamWriter`'s; a spec
 * holds it to the bytes.
 */
function encryptLooseStrings(doc: PDFDocument) {
  const ctx = doc.context;
  const security = ctx.security;
  if (!security) return;
  const encryptRef = ctx.trailerInfo.Encrypt;
  const Sig = PDFName.of("Sig");
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (ref === encryptRef || obj instanceof PDFInvalidObject) continue;
    const isSig = obj instanceof PDFDict && obj.lookup(PDFName.of("Type")) === Sig;
    const loose =
      obj instanceof PDFStream ||
      obj instanceof PDFCatalog ||
      obj instanceof PDFPageTree ||
      obj instanceof PDFPageLeaf ||
      ref.generationNumber !== 0 ||
      isSig;
    if (!loose) continue;
    const encrypt = security.getEncryptFn(ref.objectNumber, ref.generationNumber);
    const seal = (v: unknown): unknown =>
      v instanceof PDFString || v instanceof PDFHexString ? PDFHexString.of(toHex(encrypt(v.asBytes()))) : undefined;
    const walk = (node: PDFDict | PDFArray, skipContents: boolean) => {
      if (node instanceof PDFArray) {
        for (let i = 0; i < node.size(); i++) {
          const v = node.get(i);
          const sealed = seal(v);
          if (sealed) node.set(i, sealed as PDFHexString);
          else if (v instanceof PDFDict || v instanceof PDFArray) walk(v, false);
        }
        return;
      }
      for (const [key, v] of node.entries()) {
        // A signature's /Contents is never encrypted (ISO 32000-2, 7.6.2).
        if (skipContents && key.asString() === "/Contents") continue;
        const sealed = seal(v);
        if (sealed) node.set(key, sealed as PDFHexString);
        else if (v instanceof PDFDict || v instanceof PDFArray) walk(v, false);
      }
    };
    const top = obj instanceof PDFStream ? obj.dict : obj;
    const sealedTop = seal(top);
    if (sealedTop) ctx.assign(ref, sealedTop as PDFHexString);
    else if (top instanceof PDFDict || top instanceof PDFArray) walk(top, isSig);
  }
}

function toHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

function randomSecret(): string {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}
