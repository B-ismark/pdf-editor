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
// On Expanded (>=840dp) windows, cap the fit-to-width page column so a single
// page doesn't balloon to an awkward size on a wide monitor; the extra room
// becomes centred margin instead. (audit #9 / M-2)
const MAX_FIT_WIDTH = 1100;

/**
 * Viewport zoom controller (research "Model B": native scroll + app-managed
 * pinch/zoom). Measures the scroll container, derives a fit-to-width base
 * scale from the widest page, and exposes a `zoom` multiplier on top of it.
 *
 * All zoom changes are anchored to a screen point (pinch midpoint, cursor, or
 * viewport centre) so the content under that point stays put across the
 * relayout.
 */
export function useViewport() {
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

  const [fitWidth, setFitWidth] = useState(0);
  const [pageWidthPts, setPageWidthPts] = useState(0);
  const [zoom, setZoom] = useState(1);

  const effectiveWidth = Math.min(fitWidth, MAX_FIT_WIDTH);
  const fitScale =
    pageWidthPts > 0 && fitWidth > 0 ? (effectiveWidth - PAD * 2) / pageWidthPts : 1;
  const scale = Math.max(0.05, fitScale * zoom);

  // The fit-to-width base is measured only when the scroll surface first
  // mounts, when a new document loads, and on genuine window resizes — NOT on
  // every container-width change. Opening the properties panel narrows the
  // scroll surface, and we deliberately keep the current scale then so the
  // page doesn't rescale-jump; it simply gains a little scroll room.
  const measure = useCallback(() => {
    const node = elRef.current;
    if (node && node.clientWidth > 0) setFitWidth(node.clientWidth);
  }, []);
  useEffect(() => {
    if (!el) return;
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [el, measure]);
  // Re-fit when a new document sets its page width (panel is closed then).
  useEffect(() => {
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
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: endPointer,
      onPointerCancel: endPointer,
    },
  };
}
