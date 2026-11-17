import { useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * "Is this element close enough to the viewport to be worth rendering?"
 *
 * The viewer lays out every page at its true size so the scrollbar and page
 * anchors are exact — that part must stay eager. What must *not* be eager is
 * the expensive content inside each page: a rasterised canvas and one DOM node
 * per text run. Rendering all of it for the whole document meant an N-page file
 * cost N full-page rasters at all times, so memory and the cost of every zoom
 * step scaled with document length rather than with what's on screen. A 300-page
 * report would allocate several gigabytes of canvas backing store and re-render
 * all 300 pages on each pinch.
 *
 * An IntersectionObserver with a generous margin keeps a band of pages around
 * the viewport live, so scrolling and zooming cost the same on page 1 of 4 as on
 * page 190 of 300. The margin is deliberately large (a couple of screens in
 * either direction) so pages are ready before they're reached — the user should
 * never watch a skeleton resolve during ordinary scrolling.
 *
 * @param margin  Extra band around the viewport to treat as visible, in CSS px.
 */
export function useRenderWindow<T extends HTMLElement>(margin = 1200) {
  const ref = useRef<T | null>(null);
  // Start *not* near, and seed the truth synchronously below. Starting every
  // element as near looked harmless ("the observer corrects it within a frame")
  // but that first frame mounted the content of every page in the document: on
  // a 600-page file, 600 overlays and ~15k text nodes in one long task, all torn
  // down again a frame later (TECH 2.4).
  const [near, setNear] = useState(false);

  // The seed: one geometry check before the first paint, so pages already on
  // screen paint in the first frame instead of flashing a skeleton while the
  // observer gets round to its first report. Layout is already eager (page
  // frames have their true size), so only the first read forces a layout.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }
    const root = nearestScrollParent(el);
    // Not rendered at all (inside a `display: none` panel): its rect is 0×0 at
    // the origin, which would read as "on screen" for every one of them.
    if (el.getClientRects().length === 0) return;
    const box = el.getBoundingClientRect();
    const top = root ? root.getBoundingClientRect().top : 0;
    const bottom = root ? root.getBoundingClientRect().bottom : window.innerHeight;
    if (box.bottom >= top - margin && box.top <= bottom + margin) setNear(true);
    // Mount-only: later changes are the observer's job.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // No IntersectionObserver (very old browser) — the seed above already
    // degraded to rendering everything, which is what the app did before.
    if (typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) setNear(e.isIntersecting);
      },
      // The root must be the element that actually clips these pages, not the
      // default (the browser viewport). `rootMargin` only expands the *root*
      // rect — a clipping ancestor in between still cuts the observed area down
      // to what's literally on screen, which would make the margin a no-op and
      // leave the user watching skeletons resolve as they scroll.
      { root: nearestScrollParent(el), rootMargin: `${margin}px 0px`, threshold: 0 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [margin]);

  return { ref, near };
}

/** The closest ancestor that scrolls its overflow, or `null` for the viewport.
 * Found by computed style rather than hard-coded to `.viewer__scroll` so the
 * same hook works for the page rail and the Organize grid inside a modal. */
function nearestScrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const { overflowY, overflowX } = getComputedStyle(p);
    if (/(auto|scroll|overlay)/.test(overflowY) || /(auto|scroll|overlay)/.test(overflowX)) {
      return p;
    }
  }
  return null;
}
