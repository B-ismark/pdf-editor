import { useEffect, useState } from "react";
import { renderPageToCanvas } from "../pdf/loader";
import { useRenderWindow } from "../hooks/useRenderWindow";

interface Props {
  bytes: ArrayBuffer;
  index: number;
  /** Added rotation preview (deg). */
  rotation: number;
}

/** Small page preview for the Organize grid and the page rail.
 *
 * Rendering is gated on proximity to the viewport: both surfaces mount one of
 * these per page, and firing every `renderPageToCanvas` at once meant opening
 * the rail on a long document queued hundreds of rasterisations behind each
 * other — the app stalled until the last one finished, for thumbnails nobody
 * had scrolled to. */
export function Thumbnail({ bytes, index, rotation }: Props) {
  const [failed, setFailed] = useState(false);
  // A modest margin: thumbnails are cheap and these rails scroll fast.
  const { ref, near } = useRenderWindow<HTMLDivElement>(600);

  useEffect(() => {
    if (!near) return;
    let cancelled = false;
    renderPageToCanvas(bytes, index, 0.4)
      .then((canvas) => {
        if (cancelled || !ref.current) return;
        canvas.className = "thumb__canvas";
        ref.current.replaceChildren(canvas);
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
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
