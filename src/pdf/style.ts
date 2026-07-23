import { StandardFonts } from "pdf-lib";
import type { FontKey, TextFragment, TextStyle } from "./types";

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

/** Guess an abstract font key + weight/style from a PDF font-family string. */
export function guessStyleFromFontFamily(
  fontFamily: string,
): Pick<TextStyle, "font" | "bold" | "italic"> {
  const f = fontFamily.toLowerCase();
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

/** Build a CSS font shorthand for canvas/DOM from a style + pixel size. */
export function cssFont(style: TextStyle, sizePx: number): string {
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

/** Resolve a fragment's effective style (detected base + user overrides). */
export function resolveFragmentStyle(
  fragment: TextFragment,
  override: Partial<TextStyle>,
): TextStyle {
  const guessed = guessStyleFromFontFamily(fragment.fontFamily);
  return {
    font: override.font ?? guessed.font,
    bold: override.bold ?? guessed.bold,
    italic: override.italic ?? guessed.italic,
    size: override.size ?? fragmentSize(fragment),
    color: override.color ?? "#000000",
  };
}
