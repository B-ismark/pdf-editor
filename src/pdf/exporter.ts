import { PDFDocument, StandardFonts, rgb, type PDFFont } from "pdf-lib";
import { renderPageToCanvas } from "./loader";
import {
  DEFAULT_STYLE,
  cssFont,
  hexToRgb,
  resolveFragmentStyle,
  standardFontKey,
} from "./style";
import type {
  Edits,
  LoadedPdf,
  Redaction,
  TextBox,
  TextFragment,
  TextStyle,
} from "./types";

/** Pixels per PDF unit used when rasterising redacted pages (≈216 dpi). */
const REDACT_SCALE = 3;

export interface ExportInput {
  edits: Edits;
  textBoxes: TextBox[];
  redactions: Redaction[];
}

/** Is this fragment edit meaningful (changed text or any style override)? */
export function isFragmentModified(
  fragment: TextFragment,
  edit: { text: string; style: Partial<TextStyle> } | undefined,
): boolean {
  if (!edit) return false;
  return edit.text !== fragment.original || Object.keys(edit.style).length > 0;
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
  const { edits, textBoxes, redactions } = input;
  const src = await PDFDocument.load(loaded.bytes.slice(0));
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

  for (const pageData of loaded.pages) {
    const i = pageData.pageIndex;
    const pageBoxes = textBoxes.filter((t) => t.pageIndex === i);
    const pageRedactions = redactions.filter((r) => r.pageIndex === i);

    if (pageRedactions.length > 0) {
      await rasterisePage(out, loaded, pageData.pageIndex, edits, pageBoxes, pageRedactions);
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
): Promise<void> {
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
}

export { DEFAULT_STYLE };
