import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { dragState, tapSuppress } from "./useDrag";

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 6;
const PAD = 24; // px of breathing room around the page at fit-width
/** A page is never fitted larger than it is: one PDF point is 1/72 inch, one
 * CSS pixel 1/96. On a wide window the page sits at its printed size, centred,
 * with the room around it as margin — a reading width, as a viewer shows paper —
 * instead of stretching to the window (an A4 page was 1052px wide at 1440).
 * Narrower than that, it fits the room it has. Zoom goes past it either way. */
export const ACTUAL_SIZE = 96 / 72;

/**
 * Viewport zoom controller (research "Model B": native scroll + app-managed
 * pinch/zoom). Measures the scroll container, derives a fit-to-width base
 * scale from the widest page, and exposes a `zoom` multiplier on top of it.
 *
 * All zoom changes are anchored to a screen point (pinch midpoint, cursor, or
 * viewport centre) so the content under that point stays put across the
 * relayout.
 */
/** The fit-to-width measurement: the scroll surface's width and the page width
 * it was fitted to. It belongs to the workspace, not to a document — the old
 * single shell kept one for its whole life — so it is carried from the editor
 * going into the background to the one coming forward ({@link useViewport}'s
 * `seed`). Measured afresh, each switch drew one frame at the unmeasured scale
 * (and restored the scroll position against it). */
export interface Fit {
  fitWidth: number;
  pageWidthPts: number;
}

/** The fit-to-width scale for a page this wide in a surface this wide. */
export function fitFor(surfaceWidth: number, pageWidthPts: number) {
  return Math.min(ACTUAL_SIZE, (surfaceWidth - PAD * 2) / pageWidthPts);
}

export function useViewport(seed?: Fit | null, carried?: () => Fit | null) {
  // The scroll container is rendered conditionally (only once a PDF is open),
  // so it mounts *after* this hook first runs. A callback ref stores the node
  // in state the moment it attaches, which lets the effects below (resize
  // observer, wheel listener) run against a real element instead of silently
  // no-op'ing on a null ref that never updates.
  const elRef = useRef<HTMLDivElement | null>(null);
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const viewportRef = useCallback((node: HTMLDivElement | null) => {
    elRef.current = node;
    setEl(node);
  }, []);

  const [fitWidth, setFitWidth] = useState(seed?.fitWidth ?? 0);
  const [pageWidthPts, setPageWidthPts] = useState(seed?.pageWidthPts ?? 0);
  // Seeded, the surface and this page width are already measured: neither
  // the surface mounting nor the same page width arriving re-fits.
  const seeded = useRef(!!seed && seed.fitWidth > 0);
  const [zoom, setZoom] = useState(1);

  const fitScale =
    pageWidthPts > 0 && fitWidth > 0 ? fitFor(fitWidth, pageWidthPts) : 1;
  const scale = Math.max(0.05, fitScale * zoom);

  // The fit follows the room the page has: the scroll surface's width, measured
  // when it mounts, when a new document loads, and whenever it changes — a
  // window resize, or a panel (Pages, the Inspector) opening or closing beside
  // it. Measuring only on window resizes kept the scale steady when a panel
  // opened, but a page that had fitted the wider room then ran under the panel,
  // its right edge out of reach. The page is capped at its printed size
  // (`ACTUAL_SIZE`), so on a wide window a panel only moves the margin and
  // nothing rescales; it shrinks only when it would otherwise be cut off.
  const measure = useCallback(() => {
    const node = elRef.current;
    if (node && node.clientWidth > 0) setFitWidth(node.clientWidth);
  }, []);
  // The surface's width as last measured, and the page width, for the
  // observer below, which outlives any one render.
  const lastWidth = useRef(fitWidth);
  lastWidth.current = fitWidth;
  const across = useRef<number | null>(null);
  const pageWidthRef = useRef(pageWidthPts);
  pageWidthRef.current = pageWidthPts;
  // Re-fit when a new document sets its page width (panel is closed then).
  const fittedTo = useRef(seed?.pageWidthPts ?? null);
  /** The surface this effect last ran on: running again on the same one means
   * the document was hidden (kept warm behind another, see `App.tsx`) and is
   * back. It then takes the workspace's fit, as a fresh editor is seeded with
   * it — the window may have been resized meanwhile, or the panel hidden, and
   * the document in front set the fit for both. */
  const ranOn = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!el) return;
    const back = ranOn.current === el ? carried?.() : null;
    ranOn.current = el;
    if (back && back.fitWidth > 0) {
      seeded.current = true;
      fittedTo.current = back.pageWidthPts;
      setFitWidth(back.fitWidth);
    } else if (!seeded.current) measure();
    // A change in the room the page has refits it, keeping the reader's place:
    // the same point of the document stays at the top-left of the view.
    // (Held off the page behind another document, the surface measures 0 and
    // is left alone; coming back, it is measured again.)
    const ro = new ResizeObserver(() => {
      const width = el.clientWidth;
      if (width <= 0 || width === lastWidth.current) return;
      const pts = pageWidthRef.current;
      if (pts > 0 && lastWidth.current > 0 && fitFor(width, pts) !== fitFor(lastWidth.current, pts)) {
        captureAnchor(0, 0);
        // Sideways, the browser has already clamped the scroll to the new
        // width by now (a narrower page leaves less to scroll): anchor to
        // where the reader had it before the room changed.
        if (anchor.current && across.current !== null) anchor.current.rx = across.current;
      }
      setFitWidth(width);
    });
    ro.observe(el);
    // Where the reader is across the document, recorded only from scrolls at
    // the measured width — not the browser's clamp when the room changes.
    const onScroll = () => {
      if (el.clientWidth === lastWidth.current && el.scrollWidth > 0)
        across.current = el.scrollLeft / el.scrollWidth;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      ro.disconnect();
      el.removeEventListener("scroll", onScroll);
    };
    // `carried` is read when the effect runs, not tracked.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [el, measure]);
  useEffect(() => {
    if (seeded.current && pageWidthPts === fittedTo.current) return;
    seeded.current = false;
    fittedTo.current = pageWidthPts;
    measure();
  }, [pageWidthPts, measure]);

  // Pending scroll anchor applied after a zoom-driven relayout. We store the
  // fraction of the scrollable extent under the anchor point (rather than a
  // scale-multiplied coordinate) so fixed padding/gaps don't skew it.
  const anchor = useRef<{ rx: number; ry: number; ax: number; ay: number } | null>(
    null,
  );
  useLayoutEffect(() => {
    const node = elRef.current;
    const a = anchor.current;
    if (!node || !a) return;
    node.scrollLeft = a.rx * node.scrollWidth - a.ax;
    node.scrollTop = a.ry * node.scrollHeight - a.ay;
    anchor.current = null;
  }, [scale]);

  const captureAnchor = (ax: number, ay: number) => {
    const node = elRef.current;
    if (!node) return;
    anchor.current = {
      rx: node.scrollWidth ? (node.scrollLeft + ax) / node.scrollWidth : 0,
      ry: node.scrollHeight ? (node.scrollTop + ay) / node.scrollHeight : 0,
      ax,
      ay,
    };
  };

  /** Apply a zoom factor keeping the given screen point stationary. */
  const zoomBy = useCallback((factor: number, clientX?: number, clientY?: number) => {
    const node = elRef.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    const ax = clientX !== undefined ? clientX - rect.left : node.clientWidth / 2;
    const ay = clientY !== undefined ? clientY - rect.top : node.clientHeight / 2;
    setZoom((z) => {
      const target = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z * factor));
      if (target !== z) captureAnchor(ax, ay);
      return target;
    });
  }, []);

  const zoomIn = useCallback(() => zoomBy(1.25), [zoomBy]);
  const zoomOut = useCallback(() => zoomBy(1 / 1.25), [zoomBy]);
  const resetZoom = useCallback(() => setZoom(1), []);

  /** Where a document was left — its zoom, and how far down it was scrolled as
   * a fraction of the scroll extent. A fraction, not pixels, because the fit
   * scale can be different by the time the document comes back (a resize while
   * another tab was on screen), and "a third of the way through" survives that
   * where "1840px" does not. */
  const captureView = useCallback(() => {
    const node = elRef.current;
    return {
      zoom,
      ry: node && node.scrollHeight ? node.scrollTop / node.scrollHeight : 0,
    };
  }, [zoom]);

  // A restored position is re-applied for a few frames rather than once: the
  // incoming document lays out, then its fit-width is measured, then (perhaps)
  // its zoom changes — three commits, any of which moves the scroll extent.
  const pendingView = useRef<{ ry: number; until: number } | null>(null);
  const restoreView = useCallback((view: { zoom: number; ry: number }) => {
    setZoom(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.zoom)));
    pendingView.current = { ry: view.ry, until: performance.now() + 250 };
  }, []);
  useLayoutEffect(() => {
    const p = pendingView.current;
    const node = elRef.current;
    if (!p || !node) return;
    // Not against an unmeasured page: that scroll extent is about to change.
    if (fitWidth === 0 || pageWidthPts === 0) return;
    if (performance.now() > p.until) {
      pendingView.current = null;
      return;
    }
    node.scrollTop = p.ry * node.scrollHeight;
    const settle = requestAnimationFrame(() => {
      if (pendingView.current !== p) return;
      node.scrollTop = p.ry * node.scrollHeight;
      pendingView.current = null;
    });
    return () => cancelAnimationFrame(settle);
  });

  // --- Pinch + double-tap (touch) and ctrl/⌘+wheel (desktop) ---
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinchStart = useRef<{ dist: number; zoom: number } | null>(null);
  const lastTap = useRef<{ t: number; x: number; y: number } | null>(null);
  const tap = useRef<{ x: number; y: number; t: number; moved: boolean } | null>(
    null,
  );

  // --- Inertial momentum for one-finger panning (native-feeling flick) ---
  // Velocity is tracked in CSS px/ms during a pan; on release the scroll
  // continues with exponential friction until it falls below a threshold.
  const velocity = useRef({ x: 0, y: 0 });
  const lastPan = useRef<number | null>(null);
  const momentumRaf = useRef<number | null>(null);

  const stopMomentum = useCallback(() => {
    if (momentumRaf.current != null) {
      cancelAnimationFrame(momentumRaf.current);
      momentumRaf.current = null;
    }
  }, []);

  const startMomentum = useCallback(() => {
    stopMomentum();
    let vx = velocity.current.x;
    let vy = velocity.current.y;
    const step = () => {
      vx *= 0.94;
      vy *= 0.94;
      const node = elRef.current;
      if (!node || dragState.active || Math.hypot(vx, vy) < 0.02) {
        momentumRaf.current = null;
        return;
      }
      node.scrollLeft -= vx * 16;
      node.scrollTop -= vy * 16;
      momentumRaf.current = requestAnimationFrame(step);
    };
    momentumRaf.current = requestAnimationFrame(step);
  }, [stopMomentum]);

  useEffect(() => stopMomentum, [stopMomentum]);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.pointerType !== "touch") return;
    // A new touch interrupts any in-flight momentum glide.
    stopMomentum();
    velocity.current = { x: 0, y: 0 };
    lastPan.current = null;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 1) {
      tap.current = { x: e.clientX, y: e.clientY, t: performance.now(), moved: false };
    } else {
      tap.current = null; // multi-touch is never a tap
    }
    if (pointers.current.size === 2) {
      const [p1, p2] = [...pointers.current.values()];
      pinchStart.current = {
        dist: Math.hypot(p2.x - p1.x, p2.y - p1.y),
        zoom,
      };
    }
  }, [zoom, stopMomentum]);

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const prev = pointers.current.get(e.pointerId);
      if (!prev) return;
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (tap.current && Math.hypot(e.clientX - tap.current.x, e.clientY - tap.current.y) > 10) {
        tap.current.moved = true;
      }
      // An element drag / redaction draw owns the gesture — don't also pan.
      if (dragState.active) return;
      if (pointers.current.size === 1) {
        // One-finger pan (touch-action:none means we scroll the viewport).
        const node = elRef.current;
        if (node) {
          const dx = e.clientX - prev.x;
          const dy = e.clientY - prev.y;
          node.scrollLeft -= dx;
          node.scrollTop -= dy;
          // Track velocity (px/ms) for the release-time momentum glide.
          const now = performance.now();
          if (lastPan.current != null) {
            const dt = Math.max(1, now - lastPan.current);
            velocity.current = {
              x: 0.8 * (dx / dt) + 0.2 * velocity.current.x,
              y: 0.8 * (dy / dt) + 0.2 * velocity.current.y,
            };
          }
          lastPan.current = now;
        }
      }
      if (pointers.current.size === 2 && pinchStart.current) {
        const [p1, p2] = [...pointers.current.values()];
        const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
        const midX = (p1.x + p2.x) / 2;
        const midY = (p1.y + p2.y) / 2;
        const target = pinchStart.current.zoom * (dist / pinchStart.current.dist);
        const node = elRef.current;
        if (!node) return;
        const rect = node.getBoundingClientRect();
        captureAnchor(midX - rect.left, midY - rect.top);
        setZoom(() => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, target)));
      }
    },
    [],
  );

  const endPointer = useCallback(
    (e: React.PointerEvent) => {
      if (e.pointerType !== "touch") return;
      pointers.current.delete(e.pointerId);
      if (pointers.current.size < 2) pinchStart.current = null;
      // Detect a clean tap → double-tap toggles fit ⇄ 2×.
      if (pointers.current.size === 0 && tap.current && !tap.current.moved) {
        const { x, y, t } = tap.current;
        if (performance.now() - t < 250) {
          const prev = lastTap.current;
          if (prev && performance.now() - prev.t < 300 && Math.hypot(x - prev.x, y - prev.y) < 30) {
            lastTap.current = null;
            // A text element claimed this double-tap to enter edit mode — don't
            // also zoom the page.
            if (performance.now() < tapSuppress.zoomUntil) return;
            // While a text overlay is being edited, let the browser handle the
            // double-tap (select the word) instead of zooming the page.
            const active = document.activeElement;
            if (active instanceof HTMLElement && active.isContentEditable) return;
            zoomBy(zoom > 1.2 ? 1 / zoom : 2, x, y);
          } else {
            lastTap.current = { t: performance.now(), x, y };
          }
        }
      }
      // A one-finger pan just ended → glide with the tracked velocity.
      if (pointers.current.size === 0 && tap.current?.moved) {
        const v = velocity.current;
        const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        if (!reduce && Math.hypot(v.x, v.y) > 0.05) startMomentum();
      }
      tap.current = null;
    },
    [zoom, zoomBy, startMomentum],
  );

  // Ctrl/⌘ + wheel = zoom the document (and stop the browser page-zoom).
  // Must be a native, non-passive listener — a React onWheel can be passive,
  // so preventDefault() there is ignored and the whole page zooms instead.
  useEffect(() => {
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX, e.clientY);
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [el, zoomBy]);

  return {
    viewportRef,
    scale,
    zoom,
    isFit: Math.abs(zoom - 1) < 0.01,
    setPageWidth: setPageWidthPts,
    zoomIn,
    zoomOut,
    resetZoom,
    captureView,
    restoreView,
    fit: { fitWidth, pageWidthPts },
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: endPointer,
      onPointerCancel: endPointer,
    },
  };
}
