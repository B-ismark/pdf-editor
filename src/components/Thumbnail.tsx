import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { cutToCrop, renderPageToCanvas } from "../pdf/loader";
import type { CropRect } from "../pdf/types";
import { useRenderWindow } from "../hooks/useRenderWindow";

interface Props {
  bytes: ArrayBuffer;
  index: number;
  /** Added rotation preview (deg). */
  rotation: number;
  /** The part of the page the plan keeps (view space); the thumbnail shows
   * only that, as the page does. */
  crop?: CropRect;
}

/** How long a thumbnail must stay in the window before it starts rendering. A
 * rail flung from page 1 to page 600 passes every thumbnail in between; without
 * this each one would queue a rasterisation on the way past. */
const SETTLE_MS = 120;

/** Small page preview for the Organize grid and the page rail.
 *
 * Rendering is gated on proximity to the viewport: both surfaces mount one of
 * these per page, and firing every `renderPageToCanvas` at once meant opening
 * the rail on a long document queued hundreds of rasterisations behind each
 * other — the app stalled until the last one finished, for thumbnails nobody
 * had scrolled to.
 *
 * A thumbnail that leaves the window gives everything back: a render still in
 * flight is cancelled (pdf.js stops painting), and a finished canvas is removed
 * and its backing store zeroed, so a long scroll through the rail costs the
 * band on screen, not every page visited. Its slot has a fixed aspect ratio, so
 * emptying it doesn't move anything. */
export function Thumbnail({ bytes, index, rotation, crop }: Props) {
  // A stable key for the effect: a crop arrives as a fresh object each render.
  const cropKey = crop ? `${crop.x},${crop.y},${crop.width},${crop.height}` : "";
  const [failed, setFailed] = useState(false);
  // A modest margin: thumbnails are cheap and these rails scroll fast.
  const { ref, near } = useRenderWindow<HTMLDivElement>(600);
  // The canvas lives in a host React never gives children to. Swapping it into
  // a node React also renders into (the error mark) desyncs React's view of the
  // DOM, and the next commit's `removeChild` throws and unmounts the app.
  const host = useRef<HTMLSpanElement>(null);
  // Thumbnails visible on arrival (opening the rail, an Organize card remounted
  // by a move) render at once; only ones reached by scrolling wait to settle.
  const mountedAt = useRef(performance.now());
  // A quarter turn swaps the image's width and height, but the canvas is sized
  // to fit its slot unturned, so turned it would spill over the sides (and be
  // cropped where the slot clips). Scaled down until the turned image fits.
  const [painted, setPainted] = useState(0);
  const [fit, setFit] = useState(1);
  useLayoutEffect(() => {
    const c = host.current?.querySelector("canvas");
    const slot = host.current?.parentElement?.parentElement;
    if (!c || !slot || ((rotation % 180) + 180) % 180 === 0 || !c.offsetWidth || !c.offsetHeight) {
      setFit(1);
      return;
    }
    // A couple of pixels spare: the frame centres to the half pixel.
    setFit(Math.min(1, (slot.clientWidth - 2) / c.offsetHeight, (slot.clientHeight - 2) / c.offsetWidth));
  }, [rotation, painted]);

  useEffect(() => {
    if (!near) return;
    const ctrl = new AbortController();
    const settle = performance.now() - mountedAt.current < 100 ? 0 : SETTLE_MS;
    const timer = window.setTimeout(() => {
      renderPageToCanvas(bytes, index, 0.4, ctrl.signal)
        .then((c) => (crop ? cutToCrop(bytes, index, c, 0.4, crop) : c))
        .then((c) => {
          if (ctrl.signal.aborted || !host.current) {
            c.width = c.height = 0;
            return;
          }
          c.className = "thumb__canvas";
          // Replaces the previous page image only now, so a new file or index
          // swaps image for image instead of flashing an empty slot.
          releaseCanvases(host.current);
          host.current.append(c);
          setFailed(false);
          setPainted((n) => n + 1);
        })
        .catch((err) => {
          if (!ctrl.signal.aborted && (err as Error)?.name !== "AbortError") setFailed(true);
        });
    }, settle);
    return () => {
      window.clearTimeout(timer);
      ctrl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `crop` is read through `cropKey`
  }, [bytes, index, near, cropKey]);

  // Leaving the window (or unmounting) gives the backing store back.
  useEffect(() => {
    const el = host.current;
    if (!near) {
      if (el) releaseCanvases(el);
      return;
    }
    return () => {
      if (el) releaseCanvases(el);
    };
  }, [near]);

  return (
    <div
      ref={ref}
      className="thumb__frame"
      style={{ transform: `rotate(${rotation}deg)${fit < 1 ? ` scale(${fit})` : ""}` }}
    >
      <span ref={host} className="thumb__host" />
      {failed && <span className="thumb__err">!</span>}
    </div>
  );
}

function releaseCanvases(el: HTMLElement) {
  for (const c of el.querySelectorAll("canvas")) {
    c.width = c.height = 0;
    c.remove();
  }
}
