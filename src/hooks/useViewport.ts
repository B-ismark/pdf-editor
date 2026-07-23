import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { dragState } from "./useDrag";

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 6;
const PAD = 24; // px of breathing room around the page at fit-width

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
  const viewportRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [pageWidthPts, setPageWidthPts] = useState(0);
  const [zoom, setZoom] = useState(1);

  const fitScale =
    pageWidthPts > 0 && containerWidth > 0
      ? (containerWidth - PAD * 2) / pageWidthPts
      : 1;
  const scale = Math.max(0.05, fitScale * zoom);

  // Track the container's width.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const update = () => setContainerWidth(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Pending scroll anchor applied after a zoom-driven relayout.
  const anchor = useRef<{ cx: number; cy: number; ax: number; ay: number } | null>(
    null,
  );
  useLayoutEffect(() => {
    const el = viewportRef.current;
    const a = anchor.current;
    if (!el || !a) return;
    el.scrollLeft = a.cx * scale - a.ax;
    el.scrollTop = a.cy * scale - a.ay;
    anchor.current = null;
  }, [scale]);

  /** Apply a zoom factor keeping the given screen point stationary. */
  const zoomBy = useCallback(
    (factor: number, clientX?: number, clientY?: number) => {
      const el = viewportRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const ax =
        clientX !== undefined ? clientX - rect.left : el.clientWidth / 2;
      const ay =
        clientY !== undefined ? clientY - rect.top : el.clientHeight / 2;
      // Content point (in unscaled units) currently under the anchor.
      const cx = (el.scrollLeft + ax) / scale;
      const cy = (el.scrollTop + ay) / scale;
      setZoom((z) => {
        const target = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z * factor));
        if (target !== z) anchor.current = { cx, cy, ax, ay };
        return target;
      });
    },
    [scale],
  );

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

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.pointerType !== "touch") return;
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
  }, [zoom]);

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
        const el = viewportRef.current;
        if (el) {
          el.scrollLeft -= e.clientX - prev.x;
          el.scrollTop -= e.clientY - prev.y;
        }
      }
      if (pointers.current.size === 2 && pinchStart.current) {
        const [p1, p2] = [...pointers.current.values()];
        const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
        const midX = (p1.x + p2.x) / 2;
        const midY = (p1.y + p2.y) / 2;
        const target = pinchStart.current.zoom * (dist / pinchStart.current.dist);
        const el = viewportRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const ax = midX - rect.left;
        const ay = midY - rect.top;
        const cx = (el.scrollLeft + ax) / scale;
        const cy = (el.scrollTop + ay) / scale;
        setZoom(() => {
          const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, target));
          anchor.current = { cx, cy, ax, ay };
          return z;
        });
      }
    },
    [scale],
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
            zoomBy(zoom > 1.2 ? 1 / zoom : 2, x, y);
          } else {
            lastTap.current = { t: performance.now(), x, y };
          }
        }
      }
      tap.current = null;
    },
    [zoom, zoomBy],
  );

  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        zoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX, e.clientY);
      }
    },
    [zoomBy],
  );

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
      onWheel,
    },
  };
}
