import type { PatternMatcher } from "./patternScan";

/**
 * The patterns "Redact patterns" offers.
 *
 * Each is a regular expression over a page's joined text (`findPatternMatches`
 * joins the runs of a line, so a number split across runs still matches), and,
 * where the format carries one, a checksum that turns away look-alikes: an
 * invoice number isn't a card number unless its Luhn digit says so.
 *
 * The order matters: when two presets claim the same text, the earlier one
 * keeps it, so the most specific formats come first.
 *
 * None of them match across a line break (they use a literal space, never
 * `\s`), because the joined text puts one between lines and a hit that ran on
 * into the next line would cover text that isn't part of it.
 */
export interface PatternPreset {
  id: string;
  label: string;
  /** What it looks like, for the row under the label. */
  example: string;
  matcher: PatternMatcher;
}

const digits = (s: string) => s.replace(/\D/g, "");

/** Luhn check, as every payment card number carries. */
export function luhn(s: string): boolean {
  const d = digits(s);
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let n = d.charCodeAt(d.length - 1 - i) - 48;
    if (i % 2 === 1) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  return sum % 10 === 0;
}

/** ISO 13616 mod-97 check, as every IBAN carries. */
export function ibanValid(s: string): boolean {
  const v = s.replace(/ /g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(v)) return false;
  const moved = v.slice(4) + v.slice(0, 4);
  let rem = 0;
  for (const ch of moved) {
    const n = ch >= "A" ? String(ch.charCodeAt(0) - 55) : ch;
    for (const c of n) rem = (rem * 10 + (c.charCodeAt(0) - 48)) % 97;
  }
  return rem === 1;
}

const MONTHS =
  "Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?";

export const PATTERN_PRESETS: PatternPreset[] = [
  {
    id: "email",
    label: "Email addresses",
    example: "name@example.com",
    matcher: {
      kind: "email",
      re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g,
    },
  },
  {
    id: "iban",
    label: "IBANs",
    example: "GB82 WEST 1234 5698 7654 32",
    matcher: {
      kind: "iban",
      // Any case: "gb82 west …" is still an IBAN (the check upper-cases it).
      re: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b/gi,
      accept: ibanValid,
      resumeInside: true,
    },
  },
  {
    id: "card",
    label: "Card numbers",
    example: "4111 1111 1111 1111",
    matcher: {
      kind: "card",
      re: /(?<![\d-])\d(?:[ -]?\d){12,18}(?![\d-])/g,
      accept: luhn,
      resumeInside: true,
    },
  },
  {
    id: "ssn",
    label: "US Social Security numbers",
    example: "123-45-6789",
    matcher: {
      kind: "ssn",
      re: /(?<![\d-])(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}(?![\d-])/g,
    },
  },
  {
    id: "date",
    label: "Dates",
    example: "31/01/2024 · 2024-01-31 · 31 Jan 2024",
    matcher: {
      kind: "date",
      re: new RegExp(
        [
          // Not the middle of a longer dotted or dashed run of numbers: a
          // phone number written 01.23.45.67.89 is not a date and a phone.
          String.raw`(?<![\d./-])\d{4}-\d{1,2}-\d{1,2}(?![./-]?\d)`,
          String.raw`(?<![\d./-])\d{1,2}[./-]\d{1,2}[./-](?:\d{4}|\d{2})(?![./-]?\d)`,
          String.raw`\b\d{1,2}(?:st|nd|rd|th)? (?:${MONTHS})\.?,? \d{4}\b`,
          String.raw`\b(?:${MONTHS})\.? \d{1,2}(?:st|nd|rd|th)?,? \d{4}\b`,
        ].join("|"),
        "gi",
      ),
    },
  },
  {
    id: "phone",
    label: "Phone numbers",
    example: "+44 20 7946 0958 · (555) 123-4567",
    matcher: {
      kind: "phone",
      re: new RegExp(
        [
          // The first group: after a country code or an area code in brackets
          // it can be one digit ("+33 1 23 45 67 89", "+31 6 12345678"); a
          // North American number can open with its "1-"; otherwise two or
          // more, so "1 000 000" isn't a phone number.
          String.raw`(?<![\w+])(?:(?:\+\d{1,3}[ .-]?(?:\(\d{1,5}\)[ .-]?)?|\(\d{1,5}\)[ .-]?)\d{1,5}|1[ .-]\d{3}|\d{2,5})(?:[ .-]?\d{2,5}){1,4}(?!\w)`,
          // Digits drawn one to a box, as on a form's comb field: the page
          // joins them with spaces.
          String.raw`(?<![\w+.-])\d(?: \d){6,14}(?![\w.-])`,
        ].join("|"),
        "g",
      ),
      // Seven to fifteen digits (E.164's ceiling): fewer is a reference
      // number or a price, more is something else.
      accept: (s) => {
        const n = digits(s).length;
        if (n < 7 || n > 15) return false;
        // A span of years (2019-2024) has the shape of a number but isn't one.
        return !/^(?:1[89]|20)\d\d ?[-–] ?(?:1[89]|20)\d\d$/.test(s);
      },
      // Two numbers side by side read as one too long to be a phone number.
      // Split them only where the first could stand alone *as a phone
      // number*: from a "+", a "(" or a trunk "0". Any 16-digit reference
      // would split into two "phone numbers" otherwise.
      piece: (s) => /^[+(0]/.test(s),
    },
  },
];

/** A custom pattern as typed: a regular expression, matched ignoring case.
 * Returns an error message instead when it doesn't compile or would match
 * nothing but empty text. */
export function customMatcher(source: string): PatternMatcher | { error: string } | null {
  const src = source.trim();
  if (!src) return null;
  let re: RegExp | null = null;
  // Unicode mode first (so \p{L} and astral characters work), then without
  // it: it refuses escapes people type out of habit, like "INV\-\d+".
  for (const flags of ["giu", "gi"]) {
    try {
      re = new RegExp(src, flags);
      break;
    } catch {
      /* try the next */
    }
  }
  if (!re) return { error: "That isn't a pattern this browser can read." };
  if (re.test("")) return { error: "That pattern also matches empty text. Make it match at least one character." };
  return { kind: "custom", re };
}
