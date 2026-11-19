import { joinPage } from "./find";
import { fitCrop } from "./pagePlan";
import { fragmentSize, isFragmentModified } from "./style";
import type { Edits, PageData, PageRef, Redaction } from "./types";
import { yieldToUI } from "./yield";

/**
 * Compare two documents' text: what was added, removed and replaced, word by
 * word, each change placed on its pages.
 *
 * The text is read the way Find and pattern redaction read it (`joinPage`):
 * runs on one line joined, a space where there's a gap. So two files that
 * split a line into different runs — one writer emits "Hel" "lo", another
 * "Hello" — still read the same.
 *
 * The diff runs in two passes. Lines first, which is cheap and anchors
 * everything that didn't move; then words, but only inside the stretches of
 * lines that differ. A paragraph that reflowed (one word added, every line
 * break after it moved) is a block of changed *lines* but one changed *word*,
 * and the second pass finds exactly that one.
 *
 * Both passes are Myers' O(ND) diff with a cap on D: past the cap a stretch is
 * reported as replaced whole (and the result says it's rough) rather than
 * spending seconds proving two unrelated pages unrelated.
 */

/** A rectangle in a page's view space, PDF units, origin bottom-left — the
 * space every overlay object uses. */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Word {
  /** As compared: Unicode-normalised, typographic quotes made plain. */
  text: string;
  /** As it reads on the page. */
  shown: string;
  page: number;
  /** One per text run the word spans. */
  boxes: Box[];
}

export interface DocText {
  words: Word[];
  /** Each line as a range of `words`, with the text that identifies it. */
  lines: { from: number; to: number; key: string }[];
}

export interface Change {
  id: number;
  kind: "added" | "removed" | "replaced";
  removed: Word[];
  added: Word[];
  /** The page each side of the change is on. For the side with no words (an
   * addition has nothing in Before), the page where it would be: the page of
   * the word just before it. */
  beforePage: number;
  afterPage: number;
}

export interface Comparison {
  changes: Change[];
  /** Some stretch differed too much to diff word by word, and was reported
   * as replaced whole. */
  rough: boolean;
}

/** How a word is compared: forms that look alike compare alike. */
export function normalWord(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[­​-‍﻿]/g, "");
}

/** Every word of a document, in reading order, with where it sits. A word
 * whose middle is under one of `hidden`'s boxes for its page is left out. */
export function docText(pages: PageData[], hidden?: Map<number, Box[]>): DocText {
  const words: Word[] = [];
  const lines: DocText["lines"] = [];
  for (const page of pages) {
    const { text, pieces } = joinPage(page, {});
    let lineFrom = words.length;
    const endLine = () => {
      if (words.length > lineFrom) {
        lines.push({ from: lineFrom, to: words.length, key: words.slice(lineFrom).map((w) => w.text).join(" ") });
      }
      lineFrom = words.length;
    };
    const re = /\S+|\n/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      if (m[0] === "\n") {
        endLine();
        continue;
      }
      const start = m.index;
      const end = start + m[0].length;
      const boxes: Box[] = [];
      for (const p of pieces) {
        const s = Math.max(start, p.at);
        const e = Math.min(end, p.at + p.length);
        if (s >= e) continue;
        boxes.push(spanBox(p.frag, (s - p.at) / p.length, (e - p.at) / p.length));
      }
      const t = normalWord(m[0]);
      if (!t) continue;
      const under = hidden?.get(page.pageIndex);
      if (under && boxes.some((b) => under.some((h) => inside(b, h)))) continue;
      words.push({ text: t, shown: m[0], page: page.pageIndex, boxes });
    }
    endLine();
  }
  return { words, lines };
}

/** Whether `b`'s middle is inside `h`. */
function inside(b: Box, h: Box): boolean {
  const x = b.x + b.width / 2;
  const y = b.y + b.height / 2;
  return x >= h.x && x <= h.x + h.width && y >= h.y && y <= h.y + h.height;
}

/**
 * The text of a document as it would download, from an export made with its
 * true redactions left out (`exported`, one page per entry of `plan`).
 *
 * Exporting with them would be simpler and wrong: the exporter turns a page
 * with a true redaction into a picture, so every word on it would read as
 * removed. Instead the words under each redaction are hidden here — the same
 * rectangles, moved into the exported page's view space, which starts at its
 * crop's corner.
 *
 * The OCR layer is added back the same way: it lives only in memory (the
 * exporter doesn't write it), but it's what a scan says, and the version
 * without edits is compared with it.
 */
export function textAsExported(
  exported: PageData[],
  source: PageData[],
  plan: PageRef[],
  state: { edits: Edits; redactions: Redaction[] },
): { pages: PageData[]; hidden: Map<number, Box[]> } {
  const hidden = new Map<number, Box[]>();
  const pages = exported.map((page, i) => {
    const ref = plan[i];
    const from = ref ? source[ref.index] : undefined;
    if (!ref || !from) return page;
    // Fitted as the exporter fits it: a stored crop can hang off the page.
    const crop = fitCrop(ref.crop, from.viewBox);
    const dx = crop?.x ?? 0;
    const dy = crop?.y ?? 0;
    const boxes = state.redactions
      .filter((r) => !r.cover && r.pageIndex === ref.index)
      .map((r) => ({ x: r.x - dx, y: r.y - dy, width: r.width, height: r.height }));
    if (boxes.length) hidden.set(page.pageIndex, boxes);
    // An edited OCR word is written into the file by the exporter already.
    const ocr = from.fragments
      .filter((f) => f.id.startsWith("ocr:") && !isFragmentModified(f, state.edits[f.id]))
      .map((f) => {
        const [a, b, c, d, e, g] = f.transform;
        return { ...f, pageIndex: page.pageIndex, transform: [a, b, c, d, e - dx, g - dy] };
      });
    return ocr.length ? { ...page, fragments: [...page.fragments, ...ocr] } : page;
  });
  return { pages, hidden };
}

/** The box round a share [s, e) of a run, from its baseline transform. Glyph
 * widths aren't known here, so the share is of the run's width — close enough
 * to show a reader where a word is, which is all a comparison needs. */
function spanBox(frag: PageData["fragments"][number], s: number, e: number): Box {
  const [a, b, c, d, tx, ty] = frag.transform;
  const len = Math.hypot(a, b) || 1;
  const ux = a / len;
  const uy = b / len;
  const size = Math.hypot(c, d) || fragmentSize(frag) || 1;
  const w = frag.width > 0 ? frag.width : frag.original.length * size * 0.5;
  // Right-to-left runs are laid out from the far end.
  const [p0, p1] = frag.rtl ? [w * (1 - e), w * (1 - s)] : [w * s, w * e];
  // Perpendicular to the baseline, towards the glyphs' tops.
  const vx = -uy;
  const vy = ux;
  const lo = -0.22 * size;
  const hi = 0.9 * size;
  const xs: number[] = [];
  const ys: number[] = [];
  for (const along of [p0, p1]) {
    for (const up of [lo, hi]) {
      xs.push(tx + ux * along + vx * up);
      ys.push(ty + uy * along + vy * up);
    }
  }
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/**
 * The longest run of matches between `a` and `b` (Myers, 1986), as pairs of
 * indices, in order — or null when the two differ in more than `maxD` places.
 * Memory grows with the number of differences, not the length: the trace
 * keeps only the 2d + 1 diagonals each step can reach.
 */
export function matchPairs(a: string[], b: string[], maxD: number): [number, number][] | null {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, maxD);
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
    if (found >= 0) break;
  }
  if (found < 0) return null;

  // Walk back from the end through the saved diagonals.
  const pairs: [number, number][] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const t = trace[d]; // v as it was before step d: t[i] = v[k] for k = i - d - 1
    const at = (k: number) => t[k + d + 1];
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const pk = down ? k + 1 : k - 1;
    const px = at(pk);
    const py = px - pk;
    const sx = down ? px : px + 1; // where the snake after the edit starts
    while (x > sx && y > sx - k) {
      x--;
      y--;
      pairs.push([x, y]);
    }
    x = px;
    y = py;
  }
  while (x > 0 && y > 0) {
    x--;
    y--;
    pairs.push([x, y]);
  }
  return pairs.reverse();
}

/** Differences allowed per pass before a stretch is reported whole. */
export const MAX_LINE_D = 4000;
export const MAX_WORD_D = 3000;

/** What changed from `before` to `after`. */
export async function compareText(before: DocText, after: DocText): Promise<Comparison> {
  const A = before.words;
  const B = after.words;
  const changes: Change[] = [];
  let rough = false;

  /** Report the words between matches as changes: a, b are the half-open
   * stretches of unmatched words. */
  const emit = (a0: number, a1: number, b0: number, b1: number) => {
    if (a0 === a1 && b0 === b1) return;
    const removed = A.slice(a0, a1);
    const added = B.slice(b0, b1);
    const pageOf = (words: Word[], at: number, fallback: Word[]) =>
      words[at]?.page ?? words[at - 1]?.page ?? fallback[0]?.page ?? 0;
    changes.push({
      id: changes.length,
      kind: removed.length && added.length ? "replaced" : removed.length ? "removed" : "added",
      removed,
      added,
      // An addition sits where the word *after* it in Before is; if it's at
      // the very end, on the last word's page.
      beforePage: removed[0]?.page ?? pageOf(A, a0, added),
      afterPage: added[0]?.page ?? pageOf(B, b0, removed),
    });
  };

  /** Diff two stretches word by word. */
  const words = async (a0: number, a1: number, b0: number, b1: number) => {
    // Trim what's the same at both ends first: most stretches are one line
    // with one word changed.
    while (a0 < a1 && b0 < b1 && A[a0].text === B[b0].text) a0++, b0++;
    while (a0 < a1 && b0 < b1 && A[a1 - 1].text === B[b1 - 1].text) a1--, b1--;
    if (a0 === a1 || b0 === b1) return emit(a0, a1, b0, b1);
    await yieldToUI();
    const pairs = matchPairs(
      A.slice(a0, a1).map((w) => w.text),
      B.slice(b0, b1).map((w) => w.text),
      MAX_WORD_D,
    );
    if (!pairs) {
      rough = true;
      return emit(a0, a1, b0, b1);
    }
    let i = a0;
    let j = b0;
    for (const [pa, pb] of pairs) {
      emit(i, a0 + pa, j, b0 + pb);
      i = a0 + pa + 1;
      j = b0 + pb + 1;
    }
    emit(i, a1, j, b1);
  };

  const LA = before.lines;
  const LB = after.lines;
  await yieldToUI();
  const linePairs = matchPairs(
    LA.map((l) => l.key),
    LB.map((l) => l.key),
    MAX_LINE_D,
  );
  // Too many changed lines to line up: diff the whole text by words, which
  // still finds what's common if it's a matter of reflow.
  if (!linePairs) {
    await words(0, A.length, 0, B.length);
    return { changes: renumber(changes), rough };
  }
  // Word index where line i starts, or the end.
  const startA = (i: number) => (i < LA.length ? LA[i].from : A.length);
  const startB = (i: number) => (i < LB.length ? LB[i].from : B.length);
  let i = 0;
  let j = 0;
  for (const [pa, pb] of linePairs) {
    await words(startA(i), startA(pa), startB(j), startB(pb));
    i = pa + 1;
    j = pb + 1;
  }
  await words(startA(i), A.length, startB(j), B.length);
  return { changes: renumber(changes), rough };
}

function renumber(changes: Change[]): Change[] {
  return changes.map((c, id) => ({ ...c, id }));
}

/** A change in a line, for the list: what it says, shortened. */
export function quote(words: Word[], max = 60): string {
  const s = words.map((w) => w.shown).join(" ");
  return s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s;
}
