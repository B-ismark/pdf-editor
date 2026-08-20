/**
 * Placement maths for floating chrome (tooltips, popovers).
 *
 * Every floating surface in this app has to stay inside the window: a control
 * at a screen edge would otherwise get a bubble half off it (the collapsed
 * Inspector tab, the ⋯ button on a phone), and a popover anchored near the
 * bottom would get a magic-number "top" that sat it on top of the very toolbar
 * it belongs to. Both are the same sum, so it lives here once rather than
 * twice.
 */

/** Breathing room kept between a floating surface and the window edge. */
export const FLOAT_MARGIN = 8;

/**
 * Clamp the *centre* of a box that is positioned with `translateX(-50%)`, so
 * the box itself stays on screen. A box wider than the window can't satisfy
 * both edges — prefer the left one, which is where reading starts.
 */
export function clampCentre(
  centre: number,
  width: number,
  viewportWidth: number = window.innerWidth,
  margin: number = FLOAT_MARGIN,
): number {
  const half = width / 2;
  const lo = half + margin;
  const hi = viewportWidth - half - margin;
  return hi < lo ? lo : Math.min(Math.max(centre, lo), hi);
}

export interface AnchorRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface Placement {
  left: number;
  top: number;
  /** Which side of the anchor the surface ended up on. */
  side: "below" | "above";
}

export interface PlaceOptions {
  gap?: number;
  margin?: number;
  viewport?: { width: number; height: number };
  /**
   * A rect the surface must also clear — the toolbar the anchor sits *inside*.
   * Clearing the anchor alone isn't enough: the colour swatch has 6px of
   * toolbar padding around it, so a popover flipped to the swatch's top edge
   * still landed inside the bar it belongs to.
   */
  clear?: AnchorRect | null;
}

/**
 * Place a surface of `width` × `height` against an anchor: below it when it
 * fits, above it otherwise, right edges aligned, clamped to the window.
 *
 * Flipping is what keeps a popover off its own toolbar. The colour swatch lives
 * in the draw toolbar, ~76px off the bottom of the window, so "below, and if
 * that overflows just shove it up the screen" put the palette squarely over the
 * toolbar *and* the tool dock beneath it — 20k px² of the two controls a user
 * reaches for next. Flipping to the toolbar's top edge instead lands it above
 * the bar the swatch sits in, which is the only free space there is.
 */
export function placeAnchored(
  anchor: AnchorRect,
  width: number,
  height: number,
  { gap = 6, margin = FLOAT_MARGIN, viewport, clear }: PlaceOptions = {},
): Placement {
  const vp = viewport ?? { width: window.innerWidth, height: window.innerHeight };
  const left = Math.min(
    Math.max(margin, anchor.right - width),
    Math.max(margin, vp.width - width - margin),
  );

  const lowerEdge = Math.max(anchor.bottom, clear?.bottom ?? anchor.bottom);
  const upperEdge = Math.min(anchor.top, clear?.top ?? anchor.top);
  const belowTop = lowerEdge + gap;
  const aboveTop = upperEdge - gap - height;
  if (belowTop + height <= vp.height - margin) return { left, top: belowTop, side: "below" };
  if (aboveTop >= margin) return { left, top: aboveTop, side: "above" };

  // Neither side fits (a surface taller than the room around the anchor):
  // take the roomier side and clamp, so at least it's fully on screen.
  const roomBelow = vp.height - lowerEdge;
  const roomAbove = upperEdge;
  const below = roomBelow >= roomAbove;
  return {
    left,
    top: below ? Math.max(margin, vp.height - height - margin) : margin,
    side: below ? "below" : "above",
  };
}
