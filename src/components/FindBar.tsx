import { useEffect, useRef } from "react";
import { Icon } from "./Icon";

interface Props {
  query: string;
  count: number;
  /** 1-based index of the active match, or 0 when none. */
  active: number;
  /** The document's text is still being read: the count can grow, and
   * redacting "every" match would miss the pages not read yet. */
  reading?: boolean;
  onQuery: (q: string) => void;
  onNext: () => void;
  onPrev: () => void;
  onRedactAll: () => void;
  /** Switch to looking for kinds of information instead of one word. */
  onPatterns: () => void;
  onClose: () => void;
}

/** Floating find bar — Ctrl/⌘+F. Searches the extracted text layer, steps
 * through matches, and can redact every match in one action. */
export function FindBar({ query, count, active, reading = false, onQuery, onNext, onPrev, onRedactAll, onPatterns, onClose }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  return (
    <div className="findbar" role="search">
      <Icon name="search" size={18} className="findbar__icon" />
      <input
        ref={inputRef}
        className="findbar__input"
        type="text"
        placeholder="Find in document"
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            e.shiftKey ? onPrev() : onNext();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
        aria-label="Find in document"
      />
      <span className="findbar__count label-medium" aria-live="polite">
        {query ? (count ? `${active}/${count}` : "0/0") + (reading ? "…" : "") : ""}
      </span>
      <span className="findbar__sep" />
      <button className="icon-btn icon-btn--sm" onClick={onPrev} disabled={!count} aria-label="Previous match" data-tip="Previous · ⇧⏎">
        <Icon name="chevron_up" size={18} />
      </button>
      <button className="icon-btn icon-btn--sm" onClick={onNext} disabled={!count} aria-label="Next match" data-tip="Next · ⏎">
        <Icon name="chevron_down" size={18} />
      </button>
      <button
        className="findbar__redact"
        onClick={onRedactAll}
        disabled={!count || reading}
        data-tip={reading ? "Still reading the document's text" : "Redact every match"}
      >
        <Icon name="redact_tool" size={16} /> Redact all
      </button>
      <button className="icon-btn icon-btn--sm" onClick={onPatterns} aria-label="Redact patterns" aria-haspopup="dialog" data-tip="Find emails, card numbers and more to redact">
        <Icon name="redact_patterns" size={18} />
      </button>
      <button className="icon-btn icon-btn--sm" onClick={onClose} aria-label="Close find" data-tip="Close · Esc">
        <Icon name="close" size={18} />
      </button>
    </div>
  );
}
