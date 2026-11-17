import { scrollToPage, useActivePage } from "../hooks/useActivePage";
import { Thumbnail } from "./Thumbnail";
import { Icon } from "./Icon";

interface Props {
  bytes: ArrayBuffer;
  /** The pages in shown order: source index and the turn the plan adds. */
  pages: { index: number; rotate: number }[];
  /** Close affordance (mobile overlay). Omitted on the desktop rail. */
  onClose?: () => void;
}

/** Thumbnail rail for jumping around a multi-page document. */
export function PageNav({ bytes, pages, onClose }: Props) {
  const pageCount = pages.length;
  // Keyed on the list itself: a reorder keeps the count but moves every position.
  const active = useActivePage(pageCount, pages);

  const jump = (index: number) => {
    scrollToPage(index);
    onClose?.();
  };

  return (
    <nav id="page-rail" className="pagenav" aria-label="Pages">
      <div className="pagenav__head">
        <span className="pagenav__title title-small">Pages</span>
        <span className="pagenav__count label-medium">{pageCount}</span>
        {onClose && (
          <button className="icon-btn icon-btn--sm" onClick={onClose} aria-label="Close pages" data-tip="Close">
            <Icon name="close" size={18} />
          </button>
        )}
      </div>
      <div className="pagenav__list">
        {pages.map((p, i) => (
          <button
            key={p.index}
            className={`pagenav__item${i === active ? " pagenav__item--on" : ""}`}
            onClick={() => jump(i)}
            aria-current={i === active ? "page" : undefined}
            // The page number is drawn as a chip on the thumbnail, so it is
            // decorative here — the accessible name has to carry it, and say
            // which page is the one you're on.
            aria-label={`Page ${i + 1} of ${pageCount}${i === active ? " (current)" : ""}`}
          >
            <span className="pagenav__thumb">
              <Thumbnail bytes={bytes} index={p.index} rotation={p.rotate} />
              <span className="pagenav__num label-small" aria-hidden="true">
                {i + 1}
              </span>
            </span>
          </button>
        ))}
      </div>
    </nav>
  );
}
