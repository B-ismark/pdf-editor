import { useEffect, useRef, useState } from "react";

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
  // Start visible: on first mount there is nothing to scroll and the observer
  // hasn't reported yet, so assuming "visible" avoids a blank first paint. The
  // observer corrects it within a frame for pages that are actually far away.
  const [near, setNear] = useState(true);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // No IntersectionObserver (very old browser) — degrade to rendering
    // everything, which is what the app did before.
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
