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
  if (!o.slots) return [[o.position, "{page}"]];
  return POSITIONS.flatMap((p) => {
    const t = o.slots?.[p];
    return t && t.trim() ? [[p, t] as [NumberPosition, string]] : [];
  });
}

/** Whether any place uses a token. */
export function uses(o: PageNumberOptions, token: string): boolean {
  return slotsOf(o).some(([, t]) => t.toLowerCase().includes(token));
}

/** The Bates number of the page at `pos` (0-based, as arranged). */
export function batesNumber(b: BatesOptions, pos: number): string {
  const digits = Math.max(1, Math.min(MAX_BATES_DIGITS, Math.round(b.digits) || 1));
  const n = Math.max(0, Math.round(b.start) || 0) + pos;
  return `${b.prefix}${String(n).padStart(digits, "0")}`;
}

/** One template filled in for the page at `pos` of `total`. A brace that
 * isn't a token is left as typed. */
export function fill(template: string, o: PageNumberOptions, pos: number, total: number): string {
  return template.replace(/\{(page|pages|date|file|bates)\}/gi, (_, name: string) => {
    switch (name.toLowerCase()) {
      case "page":
        return String(o.start + pos);
      case "pages":
        // The last page's number, so "Page 3 of 7" holds when numbering
        // starts somewhere other than 1.
        return String(o.start + total - 1);
      case "date":
        return o.date ?? "";
      case "file":
        return o.file ?? "";
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
