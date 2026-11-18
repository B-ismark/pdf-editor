/**
 * The matching half of "Redact patterns": where, in a page's joined text, each
 * pattern hits. Pure string work with no DOM and no imports, so the same code
 * runs on the page (presets) and in `patternWorker.ts` (a custom pattern, which
 * the person writes and which can take exponential time, so it runs where it
 * can be stopped).
 *
 * The boxing half — turning a range of joined text into rectangles on the
 * page — is `findPatternMatches` in `find.ts`.
 */

/** A pattern to look for: a regular expression, and an optional check on each
 * hit (a checksum) that weeds out look-alikes. */
export interface PatternMatcher {
  kind: string;
  re: RegExp;
  accept?: (hit: string) => boolean;
  /** When `accept` refuses a run: may a leading piece of it stand as a hit on
   * its own? (Default: any piece that matches and passes `accept`.) */
  piece?: (piece: string) => boolean;
  /** When `accept` refuses a run and no piece of it passes, look again from
   * inside it rather than after it. Right where the pattern can't start in
   * the middle of a number anyway (a card, an IBAN); wrong where it can
   * (a phone number, which would find "1111 1111 1112" inside a refused
   * "4111 1111 1111 1112"). */
  resumeInside?: boolean;
}

/** A hit as a half-open range of the joined text. */
export type Span = [start: number, end: number];

/** More hits than this across the document and the search stops: a review
 * list that long can't be reviewed, and a pattern that broad (a single letter,
 * typed on the way to a longer one) is rarely what was meant. */
export const MAX_PATTERN_HITS = 2000;

const ALNUM = /[\p{L}\p{N}]/u;

/**
 * Every hit of `m` in `text`.
 *
 * A regular expression takes the longest run it can, which is often a real hit
 * plus its neighbour: a card number and the security code after it, an IBAN
 * and the "BIC" after it, two phone numbers side by side. The checksum then
 * turns the whole run away — and the real hit inside it with it. So a run the
 * check refuses is cut back at a word boundary, shortest first, until a piece
 * passes; the rest is searched again from there. Shortest first, because the
 * piece left over is searched again but a piece swallowed into a longer
 * "hit" is never looked at twice.
 *
 * Stops after `limit` hits (the caller reports "too many").
 */
export function scanText(text: string, m: PatternMatcher, limit = Infinity): Span[] {
  const flags = m.re.flags.includes("g") ? m.re.flags : m.re.flags + "g";
  const re = new RegExp(m.re.source, flags);
  // The same pattern, anchored where the refused run started, for its pieces.
  const sticky = m.accept ? new RegExp(m.re.source, flags.replace("g", "") + "y") : null;
  const out: Span[] = [];
  let r: RegExpExecArray | null;
  while ((r = re.exec(text))) {
    const s = r.index;
    const hit = r[0];
    if (hit.length === 0) {
      re.lastIndex = s + 1;
      continue;
    }
    if (!hit.trim()) continue;
    let e = s + hit.length;
    if (m.accept && !m.accept(hit)) {
      const ok = m.accept;
      const fits = m.piece;
      e = piece(text, s, e, sticky!, fits ? (x) => fits(x) && ok(x) : ok);
      if (e < 0) {
        // Nothing in it passes: look again, from inside it where a hit can
        // start there, otherwise after it.
        re.lastIndex = m.resumeInside ? s + 1 : s + hit.length;
        continue;
      }
      re.lastIndex = e;
    }
    out.push([s, e]);
    if (out.length >= limit) break;
  }
  return out;
}

/** The end of the shortest leading piece of `text[s, e)` that ends at a word
 * boundary, still matches, and passes `accept`; -1 if none does. */
function piece(text: string, s: number, e: number, sticky: RegExp, accept: (hit: string) => boolean): number {
  for (let cut = s + 1; cut < e; cut++) {
    if (!ALNUM.test(text[cut - 1]) || ALNUM.test(text[cut])) continue;
    sticky.lastIndex = s;
    const r = sticky.exec(text.slice(0, cut));
    if (r && r[0].length === cut - s && accept(r[0])) return cut;
  }
  return -1;
}

/**
 * The hits of every matcher in one page's text, in the order the matchers are
 * listed. Where two claim the same text the earlier keeps it — that decides
 * only the *label*: whatever a later matcher found beyond the overlap is kept
 * as hits of its own, so nothing anyone asked for is dropped. (A custom
 * "Patient: .+" over a line that also holds an email used to lose the
 * patient's name to the email.)
 *
 * `extra` adds hits found elsewhere (a custom pattern, run in the worker),
 * after the matchers'.
 */
export function pageSpans(
  text: string,
  matchers: PatternMatcher[],
  extra: { kind: string; spans: Span[] } | null = null,
  limit = Infinity,
): Array<{ kind: string; s: number; e: number }> {
  const taken: Span[] = []; // sorted, disjoint
  const out: Array<{ kind: string; s: number; e: number }> = [];
  const claim = (kind: string, s: number, e: number) => {
    for (const [a, b] of uncovered(taken, s, e)) {
      // Trim the gap's edges; a sliver with nothing readable in it (the "<"
      // before an email) isn't worth a row.
      let a2 = a;
      let b2 = b;
      while (a2 < b2 && /\s/.test(text[a2])) a2++;
      while (b2 > a2 && /\s/.test(text[b2 - 1])) b2--;
      if (!ALNUM.test(text.slice(a2, b2))) continue;
      out.push({ kind, s: a2, e: b2 });
      insert(taken, a2, b2);
    }
  };
  for (const m of matchers) {
    for (const [s, e] of scanText(text, m, limit - out.length)) {
      claim(m.kind, s, e);
      if (out.length >= limit) break;
    }
    if (out.length >= limit) break;
  }
  if (extra) for (const [s, e] of extra.spans) claim(extra.kind, s, e);
  return out.sort((x, y) => x.s - y.s);
}

/** The parts of [s, e) no span in sorted, disjoint `taken` covers. */
function uncovered(taken: Span[], s: number, e: number): Span[] {
  const gaps: Span[] = [];
  let at = s;
  for (let i = firstEndingAfter(taken, s); i < taken.length && taken[i][0] < e; i++) {
    if (taken[i][0] > at) gaps.push([at, taken[i][0]]);
    at = Math.max(at, taken[i][1]);
  }
  if (at < e) gaps.push([at, e]);
  return gaps;
}

/** Index of the first span whose end is after `x` (binary search). */
function firstEndingAfter(taken: Span[], x: number): number {
  let lo = 0;
  let hi = taken.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (taken[mid][1] <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function insert(taken: Span[], s: number, e: number) {
  taken.splice(firstEndingAfter(taken, s), 0, [s, e]);
}
