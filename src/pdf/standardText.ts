import type { PDFFont } from "@cantoo/pdf-lib";

/**
 * Text for the standard (WinAnsi) fonts: Helvetica, Times, Courier.
 *
 * Those fonts can only draw WinAnsi characters. Upstream pdf-lib threw on the
 * rest, and the exporter relied on that to drop them; `@cantoo/pdf-lib`'s
 * `StandardFontEmbedder` catches the error itself and encodes a "?" instead,
 * so a note, text box, edit or watermark typed in Greek or Chinese exported
 * as "????". Nothing throws any more, so the only test left is the encoding:
 * a character that encodes exactly as "?" does, and isn't "?", was replaced.
 *
 * Standard fonts only. In an embedded font a missing glyph encodes as glyph
 * 0, and so may "?", so the test would take out whatever the subset lacks.
 *
 * Type-only import: this module adds nothing to the render path.
 */

const QUESTION = new WeakMap<PDFFont, string>();

function encoded(font: PDFFont, s: string): string | null {
  try {
    return font.encodeText(s).toString();
  } catch {
    // Upstream pdf-lib (and any embedder that still throws) lands here.
    return null;
  }
}

/** Whether `font` draws `ch` (one code point) as itself, not as a stand-in. */
export function drawable(ch: string, font: PDFFont): boolean {
  if (ch === "?") return true;
  const code = encoded(font, ch);
  if (code === null) return false;
  let q = QUESTION.get(font);
  if (q === undefined) {
    q = encoded(font, "?") ?? "";
    QUESTION.set(font, q);
  }
  return code !== q;
}

/** Letters NFKD leaves alone because they aren't a base letter plus a mark. */
const PLAIN: Record<string, string> = {
  "ł": "l", "Ł": "L", "đ": "d", "Đ": "D", "ħ": "h", "Ħ": "H", "ı": "i",
  "ŀ": "l", "Ŀ": "L", "ŧ": "t", "Ŧ": "T", "ĸ": "k",
  "‐": "-", "‑": "-", "‒": "-", "−": "-",
};

/**
 * The nearest thing `font` can draw for `ch`: itself; else its plain form
 * (ő → o, Ł → L, ﬁ → fi, full-width Ａ → A, a thin space → a space); else
 * nothing. Only a plain form drawn entirely in the font is used.
 */
function fold(ch: string, font: PDFFont, dropped?: Set<string>): string {
  if (drawable(ch, font)) return ch;
  if (ch === "\t") return "    ";
  const plain = PLAIN[ch] ?? ch.normalize("NFKD").replace(/\p{M}/gu, "");
  if (plain && plain !== ch && [...plain].every((c) => drawable(c, font))) return plain;
  // Only what a reader would miss: not a lone accent, a variation selector, a
  // joiner or a control character.
  if (dropped && !/^[\p{M}\p{C}]$/u.test(ch)) dropped.add(ch);
  return "";
}

/**
 * `text` as `font` can draw it. Characters with no WinAnsi form (Greek,
 * Cyrillic, CJK, emoji…) are left out rather than written as "?": a missing
 * letter is a gap, a "?" is a different word. README "Limitations" says
 * standard-font text supports only WinAnsi characters. What's left out is
 * added to `dropped`, so the user can be told.
 */
export function sanitize(text: string, font: PDFFont, dropped?: Set<string>): string {
  let out = "";
  // Composed first: "e" + U+0301 is "é", which WinAnsi has; taken a code
  // point at a time, the lone accent would be dropped and the "é" lost.
  for (const ch of text.normalize("NFC")) out += fold(ch, font, dropped);
  return out;
}

/**
 * The sentence an export adds when a standard font left characters out: the
 * page showed them, the file doesn't, and the user should hear it from us.
 * `where` names the files, when there's more than one (Download all).
 */
export function leftOutNote(chars: Iterable<string>, where: string[] = []): string {
  const all = [...new Set(chars)];
  if (all.length === 0) return "";
  const shown = all.slice(0, 8).join(" ") + (all.length > 8 ? " …" : "");
  const from = where.length > 0 ? ` from ${where.join(", ")}` : "";
  return ` Left out ${shown}${from} — the built-in fonts can't write ${all.length === 1 ? "it" : "them"}.`;
}
