import { intersects, redactionBox, type Box } from "./bbox";
import type { LoadedPdf, PageRef, Redaction, TextFragment } from "./types";
import { resolvePlan } from "./pagePlan";

/** Approximate glyph box for a text fragment in PDF units (bottom-left origin).
 * The transform's translation is the baseline; text rises ~one glyph-height
 * above it and dips a little below for descenders. */
function fragmentBox(f: TextFragment): Box {
  const x = f.transform[4];
  const y = f.transform[5];
  const h = f.height || 10;
  return { l: x, r: x + f.width, b: y - h * 0.2, t: y + h };
}

export interface CoverWarning {
  /** 1-based page numbers that have a whiteout cover sitting over live text. */
  pages: number[];
  /** How many covers overlap real text across the document. */
  count: number;
}

/**
 * A *whiteout cover* only paints a filled rectangle on top of the content — the
 * text beneath survives in the exported file and is recoverable by copy/paste
 * or text search. Flag covers that overlap real text so the user can convert
 * them to true (destructive) redactions before sharing.
 *
 * True redactions are NOT flagged: the exporter rasterises any page carrying
 * one, so the underlying text is genuinely removed.
 */
export function findUnsafeCovers(loaded: LoadedPdf, redactions: Redaction[], plan?: PageRef[]): CoverWarning {
  const pages = new Set<number>();
  let count = 0;
  // A page not read yet has no fragments *yet*: a cover over its text would
  // pass. Callers read the whole text first (`completeText`).
  if (loaded.pages.some((p) => p.textPending)) throw new Error("findUnsafeCovers needs every page's text read");
  const byPage = new Map<number, TextFragment[]>();
  const unreadable = new Set<number>();
  for (const p of loaded.pages) {
    byPage.set(p.pageIndex, p.fragments);
    if (p.textUnreadable) unreadable.add(p.pageIndex);
  }
  // Pages are named by where they now sit, and a deleted page's cover doesn't
  // ship, so it can't leak.
  const position = new Map(resolvePlan(plan, loaded.pages.length).map((p, pos) => [p.index, pos] as const));

  for (const r of redactions) {
    if (!r.cover) continue; // true redaction → destructive → safe
    const pos = position.get(r.pageIndex);
    if (pos === undefined) continue;
    const frags = byPage.get(r.pageIndex);
    // A page whose text couldn't be read may hold anything under the cover.
    const unknown = unreadable.has(r.pageIndex);
    if (!unknown && (!frags || frags.length === 0)) continue;
    const rb = redactionBox(r);
    if (unknown || frags!.some((f) => intersects(rb, fragmentBox(f)))) {
      count++;
      pages.add(pos + 1);
    }
  }
  return { pages: [...pages].sort((a, b) => a - b), count };
}
