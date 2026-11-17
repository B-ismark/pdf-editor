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
const advances = new Map<string, Map<string, number>>();
/**
 * Canvas-backed measurer; `null` where there's no canvas (never in the app).
 *
 * Sums cached per-character advances rather than measuring every string: find
 * runs on every keystroke, and a one-letter query on a long document is tens of
 * thousands of matches, each measuring its prefix (measured at ~0.4 s per pass
 * on 500 pages). Summing drops kerning, which the padding below absorbs.
 */
function canvasMeasure(): MeasureText | null {
  if (measureCtx === undefined) {
    measureCtx = typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
  }
  const ctx = measureCtx;
  if (!ctx) return null;
  return (text, font) => {
    let table = advances.get(font);
    if (!table) advances.set(font, (table = new Map()));
    let w = 0;
    for (const ch of text) {
      let a = table.get(ch);
      if (a === undefined) {
        ctx.font = font;
        a = ctx.measureText(ch).width;
        table.set(ch, a);
      }
      w += a;
    }
    return w;
  };
}

/**
 * Lower-case `text` one character at a time, remembering where each output
 * unit came from.
 *
 * Lower-casing can change length ("İ" becomes "i" plus a combining dot), so an
 * index into the lower-cased text is not an index into the original — and
 * using it as one put the box past the match entirely. Per character rather
 * than per string so the query and the text agree (whole-string lower-casing
 * is context-sensitive: Greek final sigma).
 */
function foldCase(text: string): { hay: string; start: number[]; end: number[] } {
  let hay = "";
  const start: number[] = [];
  const end: number[] = [];
  let i = 0;
  for (const ch of text) {
    const lower = ch.toLowerCase();
    for (let k = 0; k < lower.length; k++) {
      start.push(i);
      end.push(i + ch.length);
    }
    hay += lower;
    i += ch.length;
  }
  return { hay, start, end };
}

const fold = (s: string) => foldCase(s).hay;

/**
 * Horizontal extent of `text.slice(at, at + len)` within a fragment, in PDF
 * units from the fragment's origin, as the *widest* of several estimates.
 *
 * Measured, not counted: the old estimate gave every character the fragment's
 * average advance, so a match after narrow glyphs (i, l, t, spaces) landed to
 * the right of the real text and "Redact all" left its first letters behind.
 *
 * But a measurement is in a stand-in face (pdf.js doesn't expose the PDF's own
 * advance widths) and without the document's spacing, so the gap between the
 * measured width `w` and the fragment's real width `W` has to be put back
 * somewhere, and where depends on why it's there:
 * - the face's widths differ: spread in proportion to width (`m·W/w`);
 * - letter-spacing (`Tc`): the same amount after every character (`m + E·j/n`);
 * - word-spacing (`Tw`): the same amount after every space (`m + E·s_j/s`).
 * The truth is a mix of these, so it lies between them, and the box spans all
 * of them. An edited fragment is drawn by us, in exactly the measured face and
 * size, so its measurement stands alone.
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
  const n = Math.max(1, text.length);
  const W = frag.width;
  const whole = (): { x0: number; x1: number; slack0: number; slack1: number } => {
    // Nothing to measure against: cover the fragment (generously, if pdf.js
    // gave it no width at all).
    const w = W > 0 ? W : n * fragmentSize(frag);
    return { x0: 0, x1: w, slack0: 0, slack1: 0 };
  };
  const count = (j: number) => (W * j) / n;
  if (!measure) {
    if (!(W > 0)) return whole();
    const slack = (x: number) => REL_ERR * Math.max(0, Math.min(x, W - x));
    return { x0: count(at), x1: count(at + len), slack0: slack(count(at)), slack1: slack(count(at + len)) };
  }
  const m0 = measure(text.slice(0, at), font);
  const m1 = m0 + measure(text.slice(at, at + len), font);
  const w = measure(text, font);
  if (![m0, m1, w].every(Number.isFinite)) return whole();

  let x0: number;
  let x1: number;
  let full: number;
  if (edited) {
    // `font` is set at `size` px, so one px is one PDF unit.
    [x0, x1, full] = [m0, m1, w];
  } else {
    if (!(W > 0) || !(w > 0)) return whole();
    const E = W - w;
    const spaces = (s: string) => s.split(" ").length - 1;
    const sAll = spaces(text);
    const sAt = spaces(text.slice(0, at));
    const sEnd = sAt + spaces(text.slice(at, at + len));
    const at0 = [m0 * (W / w), m0 + (E * at) / n];
    const at1 = [m1 * (W / w), m1 + (E * (at + len)) / n];
    if (sAll > 0) {
      at0.push(m0 + (E * sAt) / sAll);
      at1.push(m1 + (E * sEnd) / sAll);
    }
    [x0, x1, full] = [Math.max(0, Math.min(...at0)), Math.min(W, Math.max(...at1)), W];
  }
  const slack = (x: number) => REL_ERR * Math.max(0, Math.min(x, full - x));
  return { x0, x1, slack0: slack(x0), slack1: slack(x1) };
}

/** A rectangle in PDF units (bottom-left origin). */
type Rect = { x: number; y: number; width: number; height: number };

/**
 * Map a box from the page's unrotated space (where pdf.js reports text) into
 * the space the page is displayed — and redacted — in, which `/Rotate` turns.
 * `view` is the *displayed* size.
 */
function toDisplay(r: Rect, rotation: number, view: { width: number; height: number }): Rect {
  const corners = [
    [r.x, r.y],
    [r.x + r.width, r.y],
    [r.x, r.y + r.height],
    [r.x + r.width, r.y + r.height],
  ].map(([x, y]) => {
    switch (rotation) {
      case 90:
        return [y, view.height - x];
      case 180:
        return [view.width - x, view.height - y];
      case 270:
        return [view.width - y, x];
      default:
        return [x, y];
    }
  });
  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/**
 * The whole fragment's padded box, through its own transform — for text whose
 * glyph positions this module can't reason about: rotated or skewed by its
 * matrix (`Tm`), mirrored, or right-to-left. Covering the whole run is
 * the price of not leaving part of a match readable.
 */
function wholeFragmentBox(frag: TextFragment, size: number): Rect {
  const [a, b, c, d, e, f] = frag.transform;
  const along = Math.hypot(a, b) || 1;
  const up = Math.hypot(c, d) || 1;
  const ux = [a / along, b / along];
  const uy = [c / up, d / up];
  const width = frag.width > 0 ? frag.width : Math.max(1, frag.original.length) * size;
  const us = [-size * SIDE, width + size * SIDE];
  const vs = [-size * DESCENT, size * ASCENT];
  const pts = us.flatMap((u) => vs.map((v) => [e + u * ux[0] + v * uy[0], f + u * ux[1] + v * uy[1]]));
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/**
 * Find every occurrence of `query` across all pages' fragments.
 *
 * Matches are case-insensitive and searched against the *current* text (so
 * edits are searchable too). Each match's rectangle is measured from glyph
 * advances (see {@link span}) and padded to the ink, because "Redact all
 * matches" turns these rectangles into redactions verbatim — and returned in
 * the page's *displayed* orientation, which is where redactions live.
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
  const q = fold(query.trim());
  if (!q) return [];
  const out: FindMatch[] = [];

  for (const page of pages) {
    const rotation = ((page.rotation % 360) + 360) % 360;
    for (const frag of page.fragments) {
      const text = fragmentText(frag.id, frag.original, edits);
      const { hay, start, end } = foldCase(text);
      if (!hay.includes(q)) continue;

      const edit = edits[frag.id];
      const edited = isFragmentModified(frag, edit);
      const source = fontFor(frag);
      const style = resolveFragmentStyle(frag, edit?.style ?? {}, source);
      const face = !edit || keepsSourceTypeface(edit.style) ? source : null;
      const [a, b, c, d, e, f] = frag.transform;
      const size = edited ? style.size : fragmentSize(frag);
      // Horizontal scaling (Tz) shrinks the size read off the baseline vector
      // but not the glyphs' height; take the tallest reading.
      const tall = Math.max(size, Math.hypot(c, d), frag.height || 0);
      const font = cssFont(style, size, face);
      // Only an upright, left-to-right run can be measured along x.
      const upright = a > 0 && d > 0 && Math.abs(b) <= a * 1e-3 && Math.abs(c) <= d * 1e-3;
      const simple = upright && !frag.rtl;

      let from = 0;
      for (;;) {
        const at = hay.indexOf(q, from);
        if (at === -1) break;
        let box: Rect;
        if (simple) {
          const o0 = start[at];
          const o1 = end[at + q.length - 1];
          const s = span(frag, text, edited, font, o0, o1 - o0, measure);
          box = {
            x: e + s.x0 - size * SIDE - s.slack0,
            y: f - tall * DESCENT,
            width: s.x1 - s.x0 + size * SIDE * 2 + s.slack0 + s.slack1,
            height: tall * (ASCENT + DESCENT),
          };
        } else {
          box = wholeFragmentBox(frag, tall);
        }
        if (rotation) box = toDisplay(box, rotation, page.viewBox);
        out.push({ id: `${frag.id}#${at}`, pageIndex: page.pageIndex, fragmentId: frag.id, ...box });
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
