import { StandardFonts } from "pdf-lib";
import type { FontKey, FragmentFont, TextFragment, TextStyle } from "./types";

/** CSS font stacks for each abstract font key, used in the DOM overlay. */
export const CSS_FONT: Record<FontKey, string> = {
  sans: "Helvetica, Arial, sans-serif",
  serif: '"Times New Roman", Times, serif',
  mono: '"Courier New", Courier, monospace',
};

export const DEFAULT_STYLE: TextStyle = {
  font: "sans",
  bold: false,
  italic: false,
  size: 16,
  color: "#000000",
};

/** Line advance (as a multiple of font size) for multi-line text boxes. The
 * on-screen overlay and the exporter share this so wrapped/broken lines land
 * in the same place on screen and in the downloaded file. */
export const TEXTBOX_LINE_HEIGHT = 1.2;

/** Map an abstract font + weight/style to a pdf-lib standard font. */
export function standardFontKey(
  font: FontKey,
  bold: boolean,
  italic: boolean,
): keyof typeof StandardFonts {
  if (font === "mono") {
    if (bold && italic) return "CourierBoldOblique";
    if (bold) return "CourierBold";
    if (italic) return "CourierOblique";
    return "Courier";
  }
  if (font === "serif") {
    if (bold && italic) return "TimesRomanBoldItalic";
    if (bold) return "TimesRomanBold";
    if (italic) return "TimesRomanItalic";
    return "TimesRoman";
  }
  if (bold && italic) return "HelveticaBoldOblique";
  if (bold) return "HelveticaBold";
  if (italic) return "HelveticaOblique";
  return "Helvetica";
}

/** Guess an abstract font key + weight/style from a PDF font name or CSS
 * font-family string (e.g. "ABCDEE+Calibri-Bold", "sans-serif").
 *
 * The `sans-serif` collapse on the first line is load-bearing: the only family
 * string pdf.js gives a fragment is the generic `fallbackName`, and a bare
 * `/serif/` matched *inside* "sans-serif" — so every sans document's edited
 * text came back as Times, on screen and in the exported file. */
export function guessStyleFromFontFamily(
  fontFamily: string,
): Pick<TextStyle, "font" | "bold" | "italic"> {
  const f = fontFamily.toLowerCase().replace(/sans[-_ ]?serif/g, "sans");
  const bold = /bold|black|heavy|semibold/.test(f);
  const italic = /italic|oblique/.test(f);
  let font: FontKey = "sans";
  if (/mono|courier|consol/.test(f)) font = "mono";
  else if (/serif|times|georgia|roman|garamond|minion/.test(f)) font = "serif";
  return { font, bold, italic };
}

/** #rrggbb -> {r,g,b} in the 0..1 range pdf-lib expects. */
export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const n = parseInt(hex.replace("#", ""), 16);
  return {
    r: ((n >> 16) & 255) / 255,
    g: ((n >> 8) & 255) / 255,
    b: (n & 255) / 255,
  };
}

/** Build a CSS font shorthand for canvas/DOM from a style + pixel size.
 *
 * With a `face` (the document's own font, see {@link FragmentFont}) the family
 * *and* its weight/slant come from the face: the loaded face already carries
 * them, and asking for bold on top of a bold face gets it synthesised twice. */
export function cssFont(style: TextStyle, sizePx: number, face?: FragmentFont | null): string {
  if (face) return `${face.slant} ${face.weight} ${sizePx}px ${face.css}`;
  const weight = style.bold ? "bold " : "";
  const slant = style.italic ? "italic " : "";
  return `${slant}${weight}${sizePx}px ${CSS_FONT[style.font]}`;
}

/** Font size baked into a PDF text transform matrix. */
export function fragmentSize(fragment: TextFragment): number {
  const [a, b] = fragment.transform;
  const size = Math.hypot(a, b);
  return size > 0.1 ? size : fragment.height || 12;
}

/** Is this fragment edit meaningful (changed text or any style override)?
 * Kept here (a pdf-lib-free module) so the render path can import it without
 * pulling the heavy exporter/pdf-lib into the initial bundle. */
export function isFragmentModified(
  fragment: TextFragment,
  edit: { text: string; style: Partial<TextStyle> } | undefined,
): boolean {
  if (!edit) return false;
  return edit.text !== fragment.original || Object.keys(edit.style).length > 0;
}

/**
 * True while an edit keeps the fragment's original typeface — i.e. the user
 * changed only the text, size or colour.
 *
 * The exporter re-embeds the document's own font in exactly this case, and the
 * on-screen overlay previews that font, so both have to agree on the test:
 * whenever they disagree, what you edit stops looking like what you download.
 */
export function keepsSourceTypeface(override: Partial<TextStyle>): boolean {
  return override.font === undefined && override.bold === undefined && override.italic === undefined;
}

/** Resolve a fragment's effective style (detected base + user overrides).
 *
 * `source` is the document's own font once it's known (see `pdf/fontInfo.ts`);
 * without it all we have is pdf.js's generic family, which carries no weight or
 * slant at all — so a bold heading came back regular. */
export function resolveFragmentStyle(
  fragment: TextFragment,
  override: Partial<TextStyle>,
  source?: FragmentFont | null,
): TextStyle {
  const base = source ?? guessStyleFromFontFamily(fragment.fontFamily);
  return {
    font: override.font ?? base.font,
    bold: override.bold ?? base.bold,
    italic: override.italic ?? base.italic,
    size: override.size ?? fragmentSize(fragment),
    color: override.color ?? "#000000",
  };
}
