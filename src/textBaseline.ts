/**
 * Where a line of text actually sits inside its own box.
 *
 * The overlays are positioned from the *baseline*: a fragment's baseline is
 * `transform[5]`, a text box's is `box.y`, and that is the y the exporter draws
 * at (pdf-lib's `drawText` y and canvas `textBaseline: "alphabetic"` are both
 * baselines). To place a DOM element over those glyphs you need the distance
 * from the element's top edge down to the baseline of its first line.
 *
 * That distance is not the font size. CSS puts the baseline at
 * `(lineHeight - (ascent + descent)) / 2 + ascent` from the top of the line
 * box, so with `line-height: 1` it lands at ~0.76–0.85em depending on the
 * face's metrics — never at 1em. Subtracting a whole `fontPx` (which is what
 * this code did) therefore lifted every edited fragment 0.15–0.24em *above* the
 * text it was replacing, growing with zoom and differing per typeface. The
 * exported file was always correct, so the effect was to make the preview lie.
 *
 * Rather than reconstruct that sum from font metrics — `measureText` reports
 * `fontBoundingBoxAscent`/`Descent` rounded to whole pixels, which leaves up to
 * ~0.75px of error — this asks the layout engine the question directly and
 * caches the answer. A zero-size `inline-block` sits on the baseline of the line
 * it's in (its bottom margin edge *is* its baseline), so one hidden probe per
 * distinct font shorthand gives the exact offset the same engine will use for
 * the real element.
 *
 * Callers must not put vertical padding or a border on the measured element:
 * the probe measures from the box's top edge, and both `.fragment` and
 * `.textbox` are deliberately `padding: 0 1px`.
 */

/** Ascenders, descenders and a cap, so the probe line is a full-height one. */
const PROBE_TEXT = "Hxljgp";

/**
 * Keyed by `${font shorthand}|${lineHeight}` — the shorthand carries the size,
 * so every size is measured rather than scaled from one reference measurement.
 * That's deliberate: the browser rounds a face's ascent and descent to whole
 * pixels *per size*, so an offset scaled from a reference size misses the real
 * layout by up to ~0.9px, while measuring at the size in question reproduces it
 * including the rounding.
 *
 * The cost is that zooming mints a new key per distinct font size per step
 * (~4 sizes and ~5ms of probing on a body-text page), so the cap keeps a long
 * session of zooming from growing this without bound. Dropping the whole map is
 * fine — every entry is re-derivable, and the pages on screen re-probe on their
 * next render.
 */
const cache = new Map<string, number>();
const MAX_CACHE = 512;

let host: HTMLElement | null = null;

function probeHost(): HTMLElement {
  if (!host) {
    host = document.createElement("div");
    // Out of flow, unpainted, and zero-sized so it can never affect the page.
    host.style.cssText =
      "position:fixed;top:0;left:0;width:0;height:0;overflow:hidden;visibility:hidden;pointer-events:none";
    host.setAttribute("aria-hidden", "true");
    document.body.appendChild(host);
  }
  return host;
}

/**
 * Distance in px from an element's top edge to the baseline of its first line,
 * for text set in `font` (a CSS `font` shorthand) at `lineHeight` (a number, as
 * a multiple of the font size).
 *
 * `fallbackPx` is returned if the measurement can't be made (no document, or a
 * degenerate result) — pass the font size to keep the previous behaviour.
 */
export function baselineOffset(font: string, lineHeight: number, fallbackPx: number): number {
  const key = `${font}|${lineHeight}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  if (typeof document === "undefined") return fallbackPx;

  const el = document.createElement("div");
  el.style.cssText = "position:absolute;top:0;left:0;margin:0;padding:0;border:0;white-space:nowrap";
  // The `font` shorthand resets `line-height`, so it has to be set afterwards.
  el.style.font = font;
  el.style.lineHeight = String(lineHeight);
  el.textContent = PROBE_TEXT;
  const strut = document.createElement("span");
  strut.style.cssText = "display:inline-block;width:0;height:0";
  el.appendChild(strut);

  const h = probeHost();
  h.appendChild(el);
  const offset = strut.getBoundingClientRect().bottom - el.getBoundingClientRect().top;
  el.remove();

  if (!Number.isFinite(offset) || offset <= 0) return fallbackPx;
  if (cache.size >= MAX_CACHE) cache.clear();
  cache.set(key, offset);
  return offset;
}

/** Build the CSS `font` shorthand for an overlay from its resolved parts. This
 * mirrors what the element itself is given, so the probe measures the same
 * layout the browser is about to perform. */
export function fontShorthand(
  slant: string,
  weight: string,
  sizePx: number,
  family: string,
): string {
  return `${slant} ${weight} ${sizePx}px ${family}`;
}
