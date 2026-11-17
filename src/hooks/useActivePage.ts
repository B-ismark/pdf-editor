import { useEffect, useState } from "react";

/**
 * Which page is most visible in the scroll surface: the rail highlights it and
 * the zoom pill's page chip reads it out.
 *
 * `docKey` is the document's identity. Pages are observed once per document,
 * so two files with the same page count (two tabs) must still re-observe —
 * otherwise the observer holds the previous document's detached pages and the
 * number freezes.
 */
export function useActivePage(pageCount: number, docKey: unknown): number {
  const [active, setActive] = useState(0);
  useEffect(() => {
    setActive(0);
    // By position in the shown order, not source page: after a reorder the
    // two differ, and the rail and page chip count positions.
    const els = Array.from(document.querySelectorAll<HTMLElement>(".page[data-page-pos]"));
    if (els.length === 0) return;
    const ratios = new Map<number, number>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const idx = Number((e.target as HTMLElement).dataset.pagePos);
          ratios.set(idx, e.intersectionRatio);
        }
        let best = 0;
        let bestR = -1;
        ratios.forEach((r, idx) => {
          if (r > bestR) {
            bestR = r;
            best = idx;
          }
        });
        setActive(best);
      },
      { threshold: [0, 0.1, 0.25, 0.5, 0.75, 1] },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [pageCount, docKey]);
  return active;
}

/** Bring the page at position `index` (0-based, shown order) to the top of
 * the scroll surface. */
export function scrollToPage(index: number, smooth = true): void {
  document
    .querySelector<HTMLElement>(`.page[data-page-pos="${index}"]`)
    ?.scrollIntoView({ block: "start", behavior: smooth ? "smooth" : "auto" });
}
