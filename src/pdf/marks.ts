/**
 * Tick and cross glyphs, defined once.
 *
 * These are drawn three times over — by the SVG overlay, by the pdf-lib vector
 * exporter, and by the canvas that rasterises a redacted page — and a mark that
 * previews at one shape and exports at another is the same class of bug as an
 * overlay that sits off its baseline: the screen lies about the file. So the
 * geometry lives here as unit polylines and every draw path maps the same
 * numbers into its own coordinate space.
 *
 * Coordinates are a 0..1 square with the origin bottom-left, matching PDF
 * orientation rather than screen orientation. The canvas path is the one that
 * has to flip.
 */

export type MarkKind = "check" | "cross";

/** Unit-square polylines. A cross is two strokes; a tick is one. */
export const MARK_PATHS: Record<MarkKind, readonly (readonly (readonly [number, number])[])[]> = {
  // Weighted so the long arm reads as the dominant stroke at checkbox sizes —
  // a symmetric tick looks like a "v" once it is 12pt tall.
  check: [[[0.14, 0.5], [0.4, 0.2], [0.86, 0.78]]],
  cross: [
    [[0.2, 0.2], [0.8, 0.8]],
    [[0.2, 0.8], [0.8, 0.2]],
  ],
};

/** Side of a mark placed by a click rather than a drag, in PDF units. Sized for
 * a typical form checkbox (10–12pt) with a little room around the glyph. */
export const DEFAULT_MARK_SIZE = 15;

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Map the unit polylines onto a box, in the box's own coordinate space. */
export function markPolylines(kind: MarkKind, box: Box): { x: number; y: number }[][] {
  return MARK_PATHS[kind].map((line) =>
    line.map(([ux, uy]) => ({
      x: box.x + ux * box.width,
      y: box.y + uy * box.height,
    })),
  );
}

/** A mark's stroke scales with the box so a large tick isn't hairline, but
 * never below the width the user chose — at checkbox sizes the chosen width is
 * already the whole glyph. */
export function markStroke(strokeWidth: number, box: Box): number {
  return Math.max(strokeWidth, Math.min(box.width, box.height) * 0.12);
}
