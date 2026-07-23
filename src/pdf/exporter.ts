import { PDFCheckBox, PDFDocument, PDFString, PDFTextField, StandardFonts, degrees, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { renderPageToCanvas } from "./loader";
import {
  DEFAULT_STYLE,
  cssFont,
  hexToRgb,
  isFragmentModified,
  resolveFragmentStyle,
  standardFontKey,
} from "./style";
import type {
  Annotation,
  Edits,
  LinkAnnot,
  LoadedPdf,
  Redaction,
  Stamp,
  TextBox,
  TextStyle,
} from "./types";

/** Pixels per PDF unit used when rasterising redacted pages (≈216 dpi). */
const REDACT_SCALE = 3;

export interface ExportInput {
  edits: Edits;
  textBoxes: TextBox[];
  redactions: Redaction[];
  annotations: Annotation[];
  stamps: Stamp[];
  links?: LinkAnnot[];
  /** Filled AcroForm values keyed by field name. */
  formValues?: Record<string, string | boolean>;
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
 * rasterised pages alike — links sit above the content). */
function addLinkAnnots(out: PDFDocument, page: PDFPage, links: LinkAnnot[]): void {
  for (const l of links) {
    const url = l.url.trim();
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
    const box = a.kind === "highlight" || a.kind === "rect" ? a : null;
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
): Promise<Uint8Array> {
  const { edits, textBoxes, redactions, annotations, stamps, links = [], formValues = {} } = input;
  const src = await PDFDocument.load(loaded.bytes.slice(0));
  fillAndFlattenForm(src, formValues);
  const out = await PDFDocument.create();
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

  for (const pageData of loaded.pages) {
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

    if (needsRaster) {
      const rasterPage = await rasterisePage(out, loaded, pageData.pageIndex, edits, pageBoxes, pageRedactions, pageAnnots, pageStamps);
      addLinkAnnots(out, rasterPage, pageLinks);
      continue;
    }

    // Vector path: copy the original page and draw edits + text boxes on top.
    const [page] = await out.copyPages(src, [i]);
    out.addPage(page);

    for (const fragment of pageData.fragments) {
      const edit = edits[fragment.id];
      if (!isFragmentModified(fragment, edit)) continue;
      const style = resolveFragmentStyle(fragment, edit!.style);
      const x = fragment.transform[4];
      const y = fragment.transform[5];
      const descent = style.size * 0.22;

      // Cover the original glyphs, then redraw.
      page.drawRectangle({
        x: x - style.size * 0.05,
        y: y - descent,
        width:
          Math.max(fragment.width, edit!.text.length * style.size * 0.2) +
          style.size * 0.1,
        height: style.size * 1.2,
        color: rgb(1, 1, 1),
      });
      const font = await getFont(
        standardFontKey(style.font, style.bold, style.italic),
      );
      const c = hexToRgb(style.color);
      page.drawText(sanitize(edit!.text, font), {
        x,
        y,
        size: style.size,
        font,
        color: rgb(c.r, c.g, c.b),
      });
    }

    for (const box of pageBoxes) {
      if (!box.text.trim()) continue;
      const font = await getFont(
        standardFontKey(box.style.font, box.style.bold, box.style.italic),
      );
      const c = hexToRgb(box.style.color);
      page.drawText(sanitize(box.text, font), {
        x: box.x,
        y: box.y,
        size: box.style.size,
        font,
        color: rgb(c.r, c.g, c.b),
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

    addLinkAnnots(out, page, pageLinks);
  }

  return out.save();
}

/** Render a page to an image with edits, text boxes, and redactions baked in,
 * then add it to the output document as a full-page image. */
async function rasterisePage(
  out: PDFDocument,
  loaded: LoadedPdf,
  pageIndex: number,
  edits: Edits,
  boxes: TextBox[],
  redactions: Redaction[],
  annots: Annotation[],
  stamps: Stamp[],
): Promise<PDFPage> {
  const pageData = loaded.pages[pageIndex];
  const H = pageData.viewBox.height;
  const canvas = await renderPageToCanvas(loaded.bytes, pageIndex, REDACT_SCALE);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not get 2D canvas context");
  const S = REDACT_SCALE;

  const drawText = (
    text: string,
    x: number,
    yBaseline: number,
    style: TextStyle,
  ) => {
    if (!text) return;
    ctx.font = cssFont(style, style.size * S);
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = style.color;
    ctx.fillText(text, x * S, (H - yBaseline) * S);
  };

  // Edited fragments: cover original glyphs in white, then redraw.
  for (const fragment of pageData.fragments) {
    const edit = edits[fragment.id];
    if (!isFragmentModified(fragment, edit)) continue;
    const style = resolveFragmentStyle(fragment, edit!.style);
    const x = fragment.transform[4];
    const y = fragment.transform[5];
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(
      (x - style.size * 0.05) * S,
      (H - (y + style.size * 0.98)) * S,
      (Math.max(fragment.width, edit!.text.length * style.size * 0.2) +
        style.size * 0.1) * S,
      style.size * 1.2 * S,
    );
    drawText(edit!.text, x, y, style);
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

  const png = await out.embedPng(canvas.toDataURL("image/png"));
  const wPt = pageData.viewBox.width;
  const hPt = pageData.viewBox.height;
  const page = out.addPage([wPt, hPt]);
  page.drawImage(png, { x: 0, y: 0, width: wPt, height: hPt });
  return page;
}

export { DEFAULT_STYLE };
