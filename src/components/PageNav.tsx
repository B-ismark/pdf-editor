import { useEffect, useState } from "react";
import { Thumbnail } from "./Thumbnail";
import { Icon } from "./Icon";

interface Props {
  bytes: ArrayBuffer;
  pageCount: number;
  /** Close affordance (mobile overlay). Omitted on the desktop rail. */
  onClose?: () => void;
}

/** Track which page is most visible in the scroll surface, for highlighting. */
function useActivePage(pageCount: number): number {
  const [active, setActive] = useState(0);
  useEffect(() => {
    const els = Array.from(document.querySelectorAll<HTMLElement>("[data-page-index]"));
    if (els.length === 0) return;
    const ratios = new Map<number, number>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const idx = Number((e.target as HTMLElement).dataset.pageIndex);
          ratios.set(idx, e.intersectionRatio);
        }
        let best = 0;
        let bestR = -1;
        ratios.forEach((r, idx) => {
          if (r > bestR) {
            bestR = r;
            best = idx;
          }
        });
        setActive(best);
      },
      { threshold: [0.1, 0.25, 0.5, 0.75, 1] },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [pageCount]);
  return active;
}

/** Thumbnail rail for jumping around a multi-page document. */
export function PageNav({ bytes, pageCount, onClose }: Props) {
  const active = useActivePage(pageCount);

  const jump = (index: number) => {
    document
      .querySelector<HTMLElement>(`[data-page-index="${index}"]`)
      ?.scrollIntoView({ block: "start", behavior: "smooth" });
    onClose?.();
  };

  return (
    <nav className="pagenav" aria-label="Pages">
      <div className="pagenav__head">
        <span className="pagenav__title label-medium">Pages</span>
        {onClose && (
          <button className="icon-btn icon-btn--sm" onClick={onClose} aria-label="Close pages" data-tip="Close">
            <Icon name="close" size={18} />
          </button>
        )}
      </div>
      <div className="pagenav__list">
        {Array.from({ length: pageCount }, (_, i) => (
          <button
            key={i}
            className={`pagenav__item${i === active ? " pagenav__item--on" : ""}`}
            onClick={() => jump(i)}
            aria-current={i === active ? "page" : undefined}
            aria-label={`Go to page ${i + 1}`}
          >
            <span className="pagenav__thumb">
              <Thumbnail bytes={bytes} index={i} rotation={0} />
            </span>
            <span className="pagenav__num label-medium">{i + 1}</span>
          </button>
        ))}
      </div>
    </nav>
  );
}
