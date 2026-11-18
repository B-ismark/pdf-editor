import type { BatesOptions, NumberPosition, PageNumberOptions } from "./types";

/**
 * Header & footer: text in up to six places on every page, with tokens filled
 * in per page. One resolver for the on-page preview and the exporter, so what
 * the page shows is what the file gets.
 *
 * Stored as `DocState.pageNumbers` (it began as page numbers alone): a session
 * from before has no `slots`, and reads as "{page}" at its `position`.
 */

export const POSITIONS: NumberPosition[] = [
  "top-left", "top-center", "top-right",
  "bottom-left", "bottom-center", "bottom-right",
];

/** The tokens, as typed in a slot and as offered by the dialog's Insert row. */
export const TOKENS = [
  { token: "{page}", label: "Page number" },
  { token: "{pages}", label: "Page count" },
  { token: "{date}", label: "Date" },
  { token: "{file}", label: "File name" },
  { token: "{bates}", label: "Bates number" },
] as const;

export const DEFAULT_BATES: BatesOptions = { prefix: "", start: 1, digits: 6 };

/** Longest Bates number, in digits: past this a number is just long. */
export const MAX_BATES_DIGITS = 12;

/** The places that have text, in reading order, with their template. */
export function slotsOf(o: PageNumberOptions): [NumberPosition, string][] {
  if (!o.slots || typeof o.slots !== "object") {
    return [[POSITIONS.includes(o.position) ? o.position : "bottom-center", "{page}"]];
  }
  // A stored value that isn't text (a damaged or future session) is no place,
  // rather than a page that can't render.
  return POSITIONS.flatMap((p) => {
    const t = o.slots?.[p];
    return typeof t === "string" && t.trim() ? [[p, t] as [NumberPosition, string]] : [];
  });
}

/** Whether any place uses a token. */
export function uses(o: PageNumberOptions, token: string): boolean {
  return slotsOf(o).some(([, t]) => t.toLowerCase().includes(token));
}

/** The Bates number of the page at `pos` (0-based, as arranged). */
export function batesNumber(b: BatesOptions, pos: number): string {
  const { prefix, start, digits } = normalBates(b);
  return `${prefix}${String(start + pos).padStart(digits, "0")}`;
}

/** A stored Bates setting read safely — the one reading the page, the
 * Inspector and the dialog all use, so none of them disagrees with another. */
export function normalBates(b: BatesOptions): BatesOptions {
  return {
    prefix: typeof b.prefix === "string" ? b.prefix : "",
    // Finite, whole and within what a number field holds — the same range the
    // dialog clamps to, so opening it and pressing Update renumbers nothing.
    start: Number.isFinite(b.start) ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.round(b.start))) : 0,
    digits: Math.max(1, Math.min(MAX_BATES_DIGITS, Math.round(b.digits) || 1)),
  };
}

/** The text size and colour, read safely from a stored setting. */
export function textSize(o: PageNumberOptions): number {
  return Number.isFinite(o.size) && o.size > 0 ? Math.min(o.size, 200) : 11;
}
export function textColor(o: PageNumberOptions): string {
  return typeof o.color === "string" && /^#[0-9a-f]{6}$/i.test(o.color) ? o.color : "#444444";
}

/** The first page's number, read safely from a stored setting. */
export function firstNumber(o: PageNumberOptions): number {
  return Number.isFinite(o.start) ? Math.max(0, Math.round(o.start)) : 1;
}

/** Characters the header & footer font (Helvetica, WinAnsi) can write. */
const WIN_ANSI = /^[\x20-\x7e\xa0-\xff\u0152\u0153\u0160\u0161\u0178\u017d\u017e\u0192\u02c6\u02dc\u2013\u2014\u2018-\u201a\u201c-\u201e\u2020-\u2022\u2026\u2030\u2039\u203a\u20ac\u2122]*$/;

/** A date as `{date}` writes it: in the reader's language when the font can
 * draw it ("18 novembre 2026"), otherwise in English ("18 November 2026") —
 * never a date the file would get only fragments of. */
export function dateLabel(d: Date, locale?: string): string {
  const opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "long", year: "numeric", numberingSystem: "latn", calendar: "gregory" };
  try {
    const local = d.toLocaleDateString(locale, opts).replace(/[\u200e\u200f]/g, "");
    if (WIN_ANSI.test(local)) return local;
  } catch {
    // An unknown locale: fall through to English.
  }
  return d.toLocaleDateString("en-GB", opts);
}

/** One template filled in for the page at `pos` of `total`. A brace that
 * isn't a token is left as typed. */
export function fill(template: string, o: PageNumberOptions, pos: number, total: number): string {
  const start = firstNumber(o);
  return template.replace(/\{(page|pages|date|file|bates)\}/gi, (_, name: string) => {
    switch (name.toLowerCase()) {
      case "page":
        return String(start + pos);
      case "pages":
        // The last page's number, so "Page 3 of 7" holds when numbering
        // starts somewhere other than 1.
        return String(start + total - 1);
      case "date":
        return typeof o.date === "string" ? o.date : "";
      case "file":
        return typeof o.file === "string" ? o.file : "";
      default:
        return batesNumber(o.bates ?? DEFAULT_BATES, pos);
    }
  });
}

/** Every place's text on the page at `pos` of `total`. A place whose text
 * fills in to nothing is left out. */
export function labelsFor(o: PageNumberOptions, pos: number, total: number): { position: NumberPosition; text: string }[] {
  return slotsOf(o).flatMap(([position, t]) => {
    const text = fill(t, o, pos, total).replace(/\s+/g, " ").trim();
    return text ? [{ position, text }] : [];
  });
}

/** The margin from the page edge to the text, in PDF units. */
export const HF_MARGIN = 28;
