import { useEffect, useRef, useState } from "react";
import { renderPageToCanvas } from "../pdf/loader";

interface Props {
  bytes: ArrayBuffer;
  index: number;
  /** Added rotation preview (deg). */
  rotation: number;
}

/** Small page preview for the Organize grid. */
export function Thumbnail({ bytes, index, rotation }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
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
  }, [bytes, index]);

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
