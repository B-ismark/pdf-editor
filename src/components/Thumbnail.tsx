import { useEffect, useRef, useState } from "react";
import { renderPageToCanvas } from "../pdf/loader";
import { useRenderWindow } from "../hooks/useRenderWindow";

interface Props {
  bytes: ArrayBuffer;
  index: number;
  /** Added rotation preview (deg). */
  rotation: number;
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
export function Thumbnail({ bytes, index, rotation }: Props) {
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

  useEffect(() => {
    if (!near) return;
    const ctrl = new AbortController();
    const settle = performance.now() - mountedAt.current < 100 ? 0 : SETTLE_MS;
    const timer = window.setTimeout(() => {
      renderPageToCanvas(bytes, index, 0.4, ctrl.signal)
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
        })
        .catch((err) => {
          if (!ctrl.signal.aborted && (err as Error)?.name !== "AbortError") setFailed(true);
        });
    }, settle);
    return () => {
      window.clearTimeout(timer);
      ctrl.abort();
    };
  }, [bytes, index, near]);

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
      style={{ transform: `rotate(${rotation}deg)` }}
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
