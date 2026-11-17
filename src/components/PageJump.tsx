import { useEffect, useRef, useState } from "react";
import { scrollToPage, useActivePage } from "../hooks/useActivePage";

/**
 * "3 / 12" in the zoom pill: where you are, and the way to go somewhere else.
 *
 * The chip reads the most visible page. Pressing it (or "Go to page…" in the
 * command palette, which sets `editing`) turns it into a number field in
 * place: Enter jumps, Esc or leaving it puts the chip back. Out-of-range input
 * is clamped to the document rather than refused — 99 in a 12-page file means
 * "the end".
 */
export function PageJump({
  pageCount,
  docKey,
  editing,
  onEditingChange,
}: {
  pageCount: number;
  docKey: unknown;
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
}) {
  const active = useActivePage(pageCount, docKey);
  const [draft, setDraft] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const chip = useRef<HTMLButtonElement>(null);
  // Closing with Enter or Esc hands focus back to the chip — the field unmounts,
  // and focus would otherwise fall to <body> and the next Tab restart at the
  // app bar. Closing by leaving the field (blur) must not pull focus back.
  const refocus = useRef(false);
  useEffect(() => {
    if (!editing && refocus.current) {
      refocus.current = false;
      chip.current?.focus();
    }
  }, [editing]);
  const close = () => {
    refocus.current = true;
    onEditingChange(false);
  };

  // The field opens empty, with the page you're on as its placeholder: typing
  // is the whole interaction, so there's nothing to select or delete first.
  useEffect(() => {
    if (editing) setDraft("");
  }, [editing]);

  if (!editing) {
    return (
      <button
        ref={chip}
        className="zoombar__label zoombar__page label-medium"
        onClick={() => onEditingChange(true)}
        aria-label={`Page ${active + 1} of ${pageCount}. Go to page`}
        data-tip="Go to page"
      >
        {active + 1} / {pageCount}
      </button>
    );
  }

  const go = () => {
    const n = parseInt(draft, 10);
    if (Number.isFinite(n)) scrollToPage(Math.min(pageCount, Math.max(1, n)) - 1, false);
    close();
  };

  return (
    <form
      className="zoombar__jump"
      onSubmit={(e) => {
        e.preventDefault();
        go();
      }}
    >
      <input
        ref={input}
        autoFocus
        placeholder={String(active + 1)}
        className="zoombar__input label-medium"
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        enterKeyHint="go"
        aria-label={`Go to page, 1 to ${pageCount}`}
        value={draft}
        onChange={(e) => setDraft(e.target.value.replace(/\D/g, "").slice(0, 6))}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            close();
          }
        }}
        onBlur={() => onEditingChange(false)}
      />
      <span className="zoombar__of label-medium" aria-hidden="true">/ {pageCount}</span>
    </form>
  );
}
