import { cssFont, fragmentSize, isFragmentModified, keepsSourceTypeface, resolveFragmentStyle } from "./style";
import type { Edits, FragmentFont, PageData, TextFragment } from "./types";

/** A single search hit, positioned in PDF units (origin bottom-left). */
export interface FindMatch {
  /** Stable id: `${fragmentId}#${start}`. */
  id: string;
  pageIndex: number;
  fragmentId: string;
  /** Rect in PDF units (bottom-left origin). */
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Current text of a fragment (edited value if any, else the original). */
function fragmentText(fragmentId: string, original: string, edits: Edits): string {
  return edits[fragmentId]?.text ?? original;
}

/**
 * How far a match's box reaches past the glyphs it covers, in ems.
 *
 * These boxes become redactions ("Redact all matches"), and on the raster path
 * anything a redaction doesn't cover is permanent. So the box is sized to the
 * *ink*, not the em box, and errs large: `ASCENT` clears accented capitals
 * (Å, É reach ~0.95em in Helvetica), `DESCENT` clears g/j/p/y, and `SIDE` absorbs
 * the residual error of measuring with a stand-in face when the document's own
 * hasn't been harvested yet, plus overhang on italics. Covering a sliver of the
 * neighbouring space is the cheap direction to be wrong in.
 */
const ASCENT = 1.0;
const DESCENT = 0.25;
const SIDE = 0.1;

/**
 * Relative error allowed for a measured position inside a fragment.
 *
 * pdf.js places each glyph by the PDF font's own advance widths, which aren't
 * exposed; the measuring face is a stand-in whose widths are *distributed*
 * slightly differently along the run. Scaling to the fragment's real width
 * makes both ends exact, so the error is zero at the ends and largest in the
 * middle — measured at 0.55% of the distance on a 66-character Helvetica line
 * (1.8pt). Each edge is padded by this share of its distance to the nearer
 * end, on top of `SIDE`.
 */
const REL_ERR = 0.02;

/** Width of `text` in CSS px when set in the CSS font shorthand `font`. */
export type MeasureText = (text: string, font: string) => number;

let measureCtx: CanvasRenderingContext2D | null | undefined;
/** Canvas-backed measurer; `null` where there's no canvas (never in the app). */
function canvasMeasure(): MeasureText | null {
  if (measureCtx === undefined) {
    measureCtx = typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
  }
  const ctx = measureCtx;
  if (!ctx) return null;
  return (text, font) => {
    ctx.font = font;
    return ctx.measureText(text).width;
  };
}

/**
 * Horizontal extent of `text.slice(at, at + len)` within a fragment, in PDF
 * units from the fragment's origin.
 *
 * Measured, not counted. The old estimate gave every character the fragment's
 * *average* advance, so a match preceded by narrow glyphs (i, l, t, spaces,
 * punctuation) landed to the right of the real text — about two characters on
 * an ordinary line — and "Redact all" left the match's leading characters in
 * the exported raster.
 *
 * An unedited fragment is measured *proportionally*: prefix/whole in the best
 * face we know, scaled to the fragment's real advance width from the PDF. That
 * keeps the document's own spacing (Tc/Tw/Tz, kerning) out of the error term —
 * only the *shape* of the width distribution comes from the stand-in. An edited
 * fragment has no original width to scale to; its text is drawn at the
 * resolved style's size, so it is measured absolutely in that face.
 */
function span(
  frag: TextFragment,
  text: string,
  edited: boolean,
  font: string,
  at: number,
  len: number,
  measure: MeasureText | null,
): { x0: number; x1: number; slack0: number; slack1: number } {
  let pre: number;
  let end: number;
  let whole: number;
  const n = Math.max(1, text.length);
  const proportional = () => {
    const per = frag.width / n;
    return { pre: per * at, end: per * (at + len), whole: frag.width };
  };
  if (!measure) {
    ({ pre, end, whole } = proportional());
  } else {
    const p = measure(text.slice(0, at), font);
    const e = p + measure(text.slice(at, at + len), font);
    const w = measure(text, font);
    // `font` is set at `size` px, so one px is one PDF unit at the fragment's
    // size. An edited fragment is drawn in exactly this face and size.
    if (edited) ({ pre, end, whole } = { pre: p, end: e, whole: w });
    else if (w > 0 && frag.width > 0) {
      const k = frag.width / w;
      ({ pre, end, whole } = { pre: p * k, end: e * k, whole: frag.width });
    } else ({ pre, end, whole } = proportional());
  }
  const slack = (x: number) => REL_ERR * Math.max(0, Math.min(x, whole - x));
  return { x0: pre, x1: end, slack0: slack(pre), slack1: slack(end) };
}

/**
 * Find every occurrence of `query` across all pages' fragments.
 *
 * Matches are case-insensitive and searched against the *current* text (so
 * edits are searchable too). Each match's rectangle is measured from glyph
 * advances (see {@link span}) and padded to the ink, because "Redact all
 * matches" turns these rectangles into redactions verbatim.
 *
 * `fontFor` supplies the document's own face for a fragment once it has been
 * harvested (`pdf/fontInfo.ts`); without it the generic family stands in.
 * `measure` is injectable for tests and defaults to a canvas.
 */
export function findMatches(
  pages: PageData[],
  edits: Edits,
  query: string,
  fontFor: (frag: TextFragment) => FragmentFont | null = () => null,
  measure: MeasureText | null = canvasMeasure(),
): FindMatch[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const out: FindMatch[] = [];

  for (const page of pages) {
    for (const frag of page.fragments) {
      const text = fragmentText(frag.id, frag.original, edits);
      const hay = text.toLowerCase();
      if (!hay.includes(q)) continue;
      // Lower-casing can change a string's length (e.g. "İ" → "i̇"), which
      // would shift every index after it. Fall back to the unmeasured
      // proportion rather than measure the wrong substring.
      const sameLength = hay.length === text.length;

      const edit = edits[frag.id];
      const edited = isFragmentModified(frag, edit);
      const source = fontFor(frag);
      const style = resolveFragmentStyle(frag, edit?.style ?? {}, source);
      const face = !edit || keepsSourceTypeface(edit.style) ? source : null;
      const size = edited ? style.size : fragmentSize(frag);
      const font = cssFont(style, size, face);
      const baseX = frag.transform[4];
      const baseY = frag.transform[5];

      let from = 0;
      for (;;) {
        const at = hay.indexOf(q, from);
        if (at === -1) break;
        const s = span(frag, text, edited, font, at, q.length, sameLength ? measure : null);
        out.push({
          id: `${frag.id}#${at}`,
          pageIndex: page.pageIndex,
          fragmentId: frag.id,
          x: baseX + s.x0 - size * SIDE - s.slack0,
          y: baseY - size * DESCENT,
          width: s.x1 - s.x0 + size * SIDE * 2 + s.slack0 + s.slack1,
          height: size * (ASCENT + DESCENT),
        });
        from = at + q.length;
      }
    }
  }
  return out;
}

/** Concatenate all page text into a plain-text string (one blank line between
 * pages), using current (edited) text. */
export function extractText(pages: PageData[], edits: Edits): string {
  return pages
    .map((page) =>
      page.fragments
        .map((f) => fragmentText(f.id, f.original, edits))
        .join(" "),
    )
    .join("\n\n");
}
