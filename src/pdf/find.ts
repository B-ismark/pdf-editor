import { fragmentSize } from "./style";
import type { Edits, PageData } from "./types";

/** A single search hit, positioned in PDF units (origin bottom-left). */
export interface FindMatch {
  /** Stable id: `${fragmentId}#${start}`. */
  id: string;
  pageIndex: number;
  fragmentId: string;
  /** Rect in PDF units (bottom-left origin). */
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Current text of a fragment (edited value if any, else the original). */
function fragmentText(fragmentId: string, original: string, edits: Edits): string {
  return edits[fragmentId]?.text ?? original;
}

/**
 * Find every occurrence of `query` across all pages' fragments.
 *
 * Matches are case-insensitive and searched against the *current* text (so
 * edits are searchable too). Sub-fragment position is approximated by
 * proportion of characters — precise enough for a highlight box without
 * per-glyph metrics.
 */
export function findMatches(
  pages: PageData[],
  edits: Edits,
  query: string,
): FindMatch[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const out: FindMatch[] = [];

  for (const page of pages) {
    for (const frag of page.fragments) {
      const text = fragmentText(frag.id, frag.original, edits);
      const hay = text.toLowerCase();
      if (!hay.includes(q)) continue;

      const size = fragmentSize(frag);
      const baseX = frag.transform[4];
      const baseY = frag.transform[5];
      const len = Math.max(1, text.length);
      const perChar = frag.width / len;

      let from = 0;
      for (;;) {
        const at = hay.indexOf(q, from);
        if (at === -1) break;
        out.push({
          id: `${frag.id}#${at}`,
          pageIndex: page.pageIndex,
          fragmentId: frag.id,
          x: baseX + perChar * at,
          y: baseY - size * 0.2,
          width: perChar * q.length,
          height: size,
        });
        from = at + q.length;
      }
    }
  }
  return out;
}

/** Concatenate all page text into a plain-text string (one blank line between
 * pages), using current (edited) text. */
export function extractText(pages: PageData[], edits: Edits): string {
  return pages
    .map((page) =>
      page.fragments
        .map((f) => fragmentText(f.id, f.original, edits))
        .join(" "),
    )
    .join("\n\n");
}
