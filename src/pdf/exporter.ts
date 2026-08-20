import { LineCapStyle, PDFCheckBox, PDFDocument, PDFString, PDFTextField, StandardFonts, degrees, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { renderPageToCanvas } from "./loader";
import { sanitizeDocument } from "./sanitize";
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
import { isBoxAnnotation } from "./types";
import type {
  Annotation,
  Edits,
  FragmentFont,
  LinkAnnot,
  LoadedPdf,
  PageNumberOptions,
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
  formValues?: Record<string, string | boolean>;
  /** Document-wide page numbering, drawn on every output page. */
  pageNumbers?: PageNumberOptions | null;
  /** Document-wide diagonal watermark, drawn on every output page. */
  watermark?: WatermarkOptions | null;
  /** Encode redacted pages losslessly (PNG only), never as JPEG. Costs several
   *  times the file size; for users who need the raster bit-exact. */
  losslessRaster?: boolean;
}

/** Draw a page number onto a finished page (vector or rasterised alike). */
function drawPageNumber(page: PDFPage, font: PDFFont, label: string, opts: PageNumberOptions): void {
  const c = hexToRgb(opts.color);
  const margin = 28;
  const { width, height } = page.getSize();
  const tw = font.widthOfTextAtSize(label, opts.size);
  const top = opts.position.startsWith("top");
  const y = top ? height - margin - opts.size : margin;
  const x = opts.position.endsWith("left")
    ? margin
    : opts.position.endsWith("right")
      ? width - margin - tw
      : width / 2 - tw / 2;
  page.drawText(label, { x, y, size: opts.size, font, color: rgb(c.r, c.g, c.b) });
}

/** Stamp a diagonal text watermark centred on a finished page. */
function drawWatermark(page: PDFPage, font: PDFFont, opts: WatermarkOptions): void {
  if (!opts.text.trim()) return;
  const c = hexToRgb(opts.color);
  const rad = (opts.angle * Math.PI) / 180;
  const len = font.widthOfTextAtSize(opts.text, opts.size);
  const { width, height } = page.getSize();
  // Start point so the text's midpoint lands at the page centre.
  const x = width / 2 - (len / 2) * Math.cos(rad);
  const y = height / 2 - (len / 2) * Math.sin(rad);
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

/** Fill the source document's AcroForm from user values and flatten it, so the
 * filled appearances bake into the page content that gets copied out. */
function fillAndFlattenForm(src: PDFDocument, formValues: Record<string, string | boolean>): void {
  if (Object.keys(formValues).length === 0) return;
  try {
    const form = src.getForm();
    for (const field of form.getFields()) {
      const name = field.getName();
      if (!(name in formValues)) continue;
      const v = formValues[name];
      if (field instanceof PDFTextField) field.setText(typeof v === "string" ? v : "");
      else if (field instanceof PDFCheckBox) (v ? field.check() : field.uncheck());
    }
    form.flatten();
  } catch {
    /* No form, or a field type/font we can't flatten — leave as-is. */
  }
}

/** Attach clickable URI link annotations to a page (works on vector and
 * rasterised pages alike — links sit above the content).
 *
 * URLs go through `safeLinkUrl` here as well as in the UI: this is the only
 * place a URI reaches the file, so it's where the allow-list has to hold even
 * if a value arrives from a restored session or a future call site. A rejected
 * scheme (`javascript:`, `data:`, `file:`, …) drops the annotation rather than
 * writing an active action into a document the user is about to share. */
function addLinkAnnots(out: PDFDocument, page: PDFPage, links: LinkAnnot[]): void {
  for (const l of links) {
    const url = safeLinkUrl(l.url);
    if (!url) continue;
    const dict = out.context.obj({
      Type: "Annot",
      Subtype: "Link",
      Rect: [l.x, l.y, l.x + l.width, l.y + l.height],
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
  for (const a of annots) {
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
      page.drawRectangle({
        x: a.x,
        y: a.y - h,
        width: w,
        height: h,
        color,
        opacity: 0.92,
        borderColor: rgb(0, 0, 0),
        borderWidth: 0.5,
      });
      page.drawText(text, { x: a.x + NOTE_PAD, y: a.y - h + NOTE_PAD + 1, size: NOTE_SIZE, font: helv, color: rgb(0, 0, 0) });
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
  for (const a of annots) {
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
      ctx.globalAlpha = 0.92;
      ctx.fillStyle = a.color;
      ctx.fillRect(X(a.x), Y(a.y), tw + pad * 2, size + pad * 2);
      ctx.restore();
      ctx.fillStyle = "#000";
      ctx.fillText(a.text, X(a.x) + pad, Y(a.y) + pad);
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
 */
export async function exportPdf(
  loaded: LoadedPdf,
  input: ExportInput,
  onProgress?: (page: number, total: number) => void,
): Promise<Uint8Array> {
  const { edits, textBoxes, redactions, annotations, stamps, links = [], formValues = {}, pageNumbers, watermark, losslessRaster = false } = input;
  const src = await PDFDocument.load(loaded.bytes.slice(0));
  fillAndFlattenForm(src, formValues);
  // updateMetadata: false stops pdf-lib stamping its own Producer / Creator /
  // CreationDate / ModDate into the new document; sanitizeDocument() then
  // clears anything else before save (see below).
  const out = await PDFDocument.create({ updateMetadata: false });
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
    onProgress?.(++done, loaded.pages.length);
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
    // annotations are then applied uniformly on top. `done` is the 1-based
    // output position, so the page-number label follows the (possibly
    // reordered) export order rather than the original page index.
    const applyPageLayers = (page: PDFPage) => {
      if (pageNumbers) drawPageNumber(page, helv, String(pageNumbers.start + done - 1), pageNumbers);
      if (watermark && wmFont) drawWatermark(page, wmFont, watermark);
      addLinkAnnots(out, page, pageLinks);
    };

    if (needsRaster) {
      const rasterPage = await rasterisePage(out, loaded, pageData.pageIndex, edits, sourceFonts, pageBoxes, pageRedactions, pageAnnots, pageStamps, await getJpegEncoder());
      applyPageLayers(rasterPage);
      continue;
    }

    // Vector path: copy the original page and draw edits + text boxes on top.
    const [page] = await out.copyPages(src, [i]);
    out.addPage(page);

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
      const textWidth = font.widthOfTextAtSize(text, style.size);
      // Cover the original glyphs (and the new text if it's longer), then redraw.
      page.drawRectangle({
        x: x - style.size * 0.05,
        y: y - descent,
        width: Math.max(fragment.width, textWidth) + style.size * 0.1,
        height: style.size * 1.2,
        color: coverColor(pageColors, fragment.itemIndex),
      });
      const c = hexToRgb(style.color);
      page.drawText(text, { x, y, size: style.size, font, color: rgb(c.r, c.g, c.b) });
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
      box.text.split("\n").forEach((line, i) => {
        page.drawText(sanitize(line, font), {
          x: box.x,
          y: box.y - i * lineStep,
          size: box.style.size,
          font,
          color: rgb(c.r, c.g, c.b),
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

    applyPageLayers(page);
  }

  await embedder?.destroy();

  // Privacy: strip metadata / timestamps / active content before handing the
  // file back (the app never uploads, so the download is the only thing that
  // leaves the device — it should carry nothing identifying).
  sanitizeDocument(out);
  return out.save();
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
  encodeJpeg: JpegEncoder | null,
): Promise<PDFPage> {
  const pageData = loaded.pages[pageIndex];
  const H = pageData.viewBox.height;
  const canvas = await renderPageToCanvas(loaded.bytes, pageIndex, REDACT_SCALE);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not get 2D canvas context");
  const S = REDACT_SCALE;

  // Read this page's colours off this raster, while it's still clean — it's
  // about to be drawn on, and it's a better one than `readPageColors` would
  // rasterise for itself. A no-op if the page was already sampled on screen,
  // which keeps the on-screen and exported covers identical.
  offerPageCanvas(loaded.bytes, pageData, canvas);
  const pageColors = peekPageColors(loaded.bytes, pageIndex);

  const drawText = (
    text: string,
    x: number,
    yBaseline: number,
    style: TextStyle,
    face?: FragmentFont | null,
  ) => {
    if (!text) return;
    ctx.font = cssFont(style, style.size * S, face);
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = style.color;
    // Multi-line (text boxes): step each line down by the shared line height.
    // Single-line callers (edited fragments) have no "\n", so this is a no-op
    // for them.
    const lineStep = style.size * TEXTBOX_LINE_HEIGHT;
    text.split("\n").forEach((line, i) => {
      ctx.fillText(line, x * S, (H - (yBaseline - i * lineStep)) * S);
    });
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
    const widest = Math.max(...lines.map((line) => ctx.measureText(line).width / S));
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
    drawText(edit!.text, x, y, style, face);
  }

  // New text boxes.
  for (const box of boxes) drawText(box.text, box.x, box.y, box.style);

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
  const page = out.addPage([wPt, hPt]);
  page.drawImage(image, { x: 0, y: 0, width: wPt, height: hPt });
  return page;
}

export { DEFAULT_STYLE };
