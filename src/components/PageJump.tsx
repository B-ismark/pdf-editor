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
  /** `byKey`: closed with Enter or Esc, so focus should land somewhere. */
  onEditingChange: (editing: boolean, byKey?: boolean) => void;
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
    onEditingChange(false, true);
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

/**
 * Where you are, on a phone: the pill (and its "3 / 12") gives the page's top
 * corner back there, so while you scroll a quiet "70 / 150" shows near the top
 * edge and fades once you stop. It's a readout, not a control — it never takes
 * a tap (Go to page… is in ⋯) — and it's hidden from assistive tech, which
 * would otherwise announce every page passed.
 */
export function PageHint({ pageCount, docKey }: { pageCount: number; docKey: unknown }) {
  const active = useActivePage(pageCount, docKey);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const el = document.querySelector<HTMLElement>(".viewer__scroll");
    if (!el) return;
    let timer = 0;
    const onScroll = () => {
      setShown(true);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setShown(false), 1200);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      window.clearTimeout(timer);
    };
  }, [docKey]);
  return (
    <div className={`pagehint label-medium${shown ? " pagehint--shown" : ""}`} aria-hidden="true">
      {active + 1} / {pageCount}
    </div>
  );
}
