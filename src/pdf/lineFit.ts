import type { TextFragment } from "./types";

/**
 * How an edited run fits on its line — shared by the overlay and both export
 * paths, so the preview and the file condense a long edit the same way.
 *
 * A line of a typeset PDF is rarely one text run. Word, Google Docs and most
 * other writers position each run separately ("…another ", "50% from both",
 * " employer and…"), and pdf.js reports each as its own fragment at its own x.
 * Editing one run grows it in place while the next keeps its x, so the
 * replacement — and the opaque box that hides the original glyphs under it —
 * ran over the start of the next run: "both" → "bothy" printed "bothymployer",
 * on screen and in the file.
 *
 * Moving the rest of the line along instead (reflow) is not done here: it means
 * redrawing text the user never touched, and a search-redaction box measured on
 * a word's original place would no longer cover it. So the edit keeps to the
 * room it has — up to where the next run on its line starts — and is condensed
 * horizontally when it needs more. A run with nothing after it on its line
 * keeps growing as before.
 */

/** Is this run set horizontally (no rotation or skew)? */
const upright = (t: number[]) => Math.abs(t[1]) < 1e-3 && Math.abs(t[2]) < 1e-3 && t[0] > 0 && t[3] > 0;

/**
 * The room an edited run has on its line, in PDF units, measured from its own
 * x: up to the nearest run that starts after it on the same baseline, less the
 * word space between them.
 * `null` when nothing follows it on the line (or it isn't set upright, where
 * "the next run along" has no simple meaning) — it can grow freely.
 */
export function roomAfter(fragment: TextFragment, fragments: readonly TextFragment[]): number | null {
  const t = fragment.transform;
  if (!upright(t)) return null;
  const x = t[4];
  const y = t[5];
  const size = Math.abs(t[3]);
  let room: number | null = null;
  for (const o of fragments) {
    if (o === fragment || o.id === fragment.id) continue;
    const u = o.transform;
    if (!upright(u)) continue;
    // Same line: baselines within a fraction of the smaller size, so a
    // superscript or a run on the next line never counts.
    const tol = 0.3 * Math.min(size, Math.abs(u[3]));
    if (Math.abs(u[5] - y) > tol) continue;
    const gap = u[4] - x;
    // Starts after this run's own start (a run at the same x is an overprint,
    // not the next one along).
    if (gap <= 0.5) continue;
    if (room === null || gap < room) room = gap;
  }
  if (room === null) return null;
  // Keep the space the document left before the next run, up to a word space.
  // pdf.js reports the space between two runs as an item of its own, which the
  // loader drops, so "the next run's x" is where its first *glyph* starts:
  // using all of it ran the edit straight into the next word ("bothyemployer").
  // A wider gap — a tab stop, the next table column — is still room to grow.
  const spacing = Math.max(0, room - fragment.width);
  return room - Math.min(spacing, WORD_SPACE * size);
}

/** A word space, as a fraction of the font size (most text faces: 0.25–0.33em). */
const WORD_SPACE = 0.3;

/**
 * The horizontal scale to draw `textWidth` of replacement at: 1 when it fits in
 * the run's own width or in the room before the next run, less when it would
 * run into it. Never above 1 — a short edit isn't stretched.
 */
export function fitScale(textWidth: number, fragmentWidth: number, room: number | null): number {
  if (room === null || !(textWidth > 0)) return 1;
  // Runs can overlap a little (kerning across a split): the run's own width is
  // always available, since the original glyphs already occupied it.
  const avail = Math.max(room, fragmentWidth);
  return textWidth > avail ? avail / textWidth : 1;
}
