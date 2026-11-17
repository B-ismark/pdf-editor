import { useEffect, useState } from "react";
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

  useEffect(() => {
    if (!near) return;
    const ctrl = new AbortController();
    let canvas: HTMLCanvasElement | null = null;
    const timer = window.setTimeout(() => {
      renderPageToCanvas(bytes, index, 0.4, ctrl.signal)
        .then((c) => {
          if (ctrl.signal.aborted || !ref.current) {
            c.width = c.height = 0;
            return;
          }
          canvas = c;
          c.className = "thumb__canvas";
          ref.current.replaceChildren(c);
          setFailed(false);
        })
        .catch((err) => {
          if (!ctrl.signal.aborted && (err as Error)?.name !== "AbortError") setFailed(true);
        });
    }, SETTLE_MS);
    return () => {
      window.clearTimeout(timer);
      ctrl.abort();
      if (canvas) {
        canvas.remove();
        canvas.width = canvas.height = 0;
      }
    };
  }, [bytes, index, near, ref]);

  return (
    <div
      ref={ref}
      className="thumb__frame"
      style={{ transform: `rotate(${rotation}deg)` }}
    >
      {failed && <span className="thumb__err">!</span>}
    </div>
  );
}
