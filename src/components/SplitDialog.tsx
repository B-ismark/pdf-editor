import { useId, useState } from "react";
import { useModal } from "../hooks/useModal";
import { plural } from "../plural";
import { Icon } from "./Icon";

interface Props {
  /** Pages in the document as Organise shows it. */
  count: number;
  /** Positions (0-based) of the picked pages, if any. */
  picked: number[];
  busy: string | null;
  error: string | null;
  /** Download one file per part; each part is a run of positions. */
  onSplit: (parts: number[][]) => void;
  onClose: () => void;
}

/** Runs of `size` pages: [0,1], [2,3], [4]. */
export function everyN(count: number, size: number): number[][] {
  const n = Math.max(1, Math.floor(size) || 1);
  const parts: number[][] = [];
  for (let at = 0; at < count; at += n) parts.push(Array.from({ length: Math.min(n, count - at) }, (_, k) => at + k));
  return parts;
}

/** A new part starts at each picked page (and at the first page). */
export function atPicked(count: number, picked: number[]): number[][] {
  const starts = [...new Set([0, ...picked.filter((p) => p > 0 && p < count)])].sort((a, b) => a - b);
  return starts.map((s, i) => {
    const end = i + 1 < starts.length ? starts[i + 1] : count;
    return Array.from({ length: end - s }, (_, k) => s + k);
  });
}

/** "1–2" or "5", 1-based. */
export function rangeLabel(part: number[]): string {
  const a = part[0] + 1;
  const b = part[part.length - 1] + 1;
  return a === b ? `${a}` : `${a}–${b}`;
}

/**
 * Split: cut the document as Organise shows it into several files, either
 * every N pages or before each picked page. The files come down together as
 * one .zip — a browser lets a page start one download, not twenty.
 */
export function SplitDialog({ count, picked, busy, error, onSplit, onClose }: Props) {
  // Not while it's splitting: closing then would hide the work without
  // stopping it — the files would still download, from a dialog that's gone.
  const close = () => {
    if (!busy) onClose();
  };
  const ref = useModal<HTMLDivElement>(close);
  const id = useId();
  const canPick = picked.some((p) => p > 0);
  const [mode, setMode] = useState<"every" | "picked">(canPick ? "picked" : "every");
  const [size, setSize] = useState(String(Math.max(1, Math.ceil(count / 2))));
  const n = Number(size);
  const sizeOk = size.trim() !== "" && Number.isInteger(n) && n >= 1;
  const parts = mode === "picked" ? atPicked(count, picked) : sizeOk ? everyN(count, n) : [];
  const shown = parts.slice(0, 6).map(rangeLabel).join(", ") + (parts.length > 6 ? ", …" : "");
  const ready = parts.length >= 2 && !busy;

  return (
    <div className="dialog-scrim" onPointerDown={close}>
      <div
        ref={ref}
        tabIndex={-1}
        className="dialog dialog--sm"
        onPointerDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
      >
        <h2 className="headline-small dialog__title" id={`${id}-title`}>Split into files</h2>
        <div className="split" role="radiogroup" aria-label="Where to split">
          <label className="split__row">
            <input type="radio" name={`${id}-mode`} checked={mode === "every"} onChange={() => setMode("every")} />
            <span className="body-medium">Every</span>
            <input
              className="sigtype__input split__size"
              type="number"
              inputMode="numeric"
              min={1}
              max={count}
              value={size}
              aria-label="Pages per file"
              aria-invalid={mode === "every" && !sizeOk ? true : undefined}
              onFocus={() => setMode("every")}
              onChange={(e) => setSize(e.target.value)}
            />
            <span className="body-medium">{n === 1 ? "page" : "pages"}</span>
          </label>
          <label className={`split__row${canPick ? "" : " split__row--off"}`}>
            <input
              type="radio"
              name={`${id}-mode`}
              checked={mode === "picked"}
              disabled={!canPick}
              onChange={() => setMode("picked")}
            />
            <span className="body-medium">Before each picked page</span>
          </label>
          {!canPick && (
            <p className="body-small split__hint">
              {picked.length > 0
                ? "Each picked page starts a new file, and page 1 already does — pick a later page."
                : "To split at pages of your choosing, pick them in the grid first."}
            </p>
          )}
        </div>
        <p className="body-small split__summary" aria-live="polite">
          {parts.length >= 2
            ? `${plural(parts.length, "file")}: pages ${shown}.`
            : mode === "every" && !sizeOk
              ? "Type a whole number of pages for each file."
              : "That makes one file — nothing to split."}
        </p>
        {error && (
          <p className="pwform__error body-small" role="alert">{error}</p>
        )}
        <div className="dialog__actions">
          <button type="button" className="btn" onClick={close} disabled={!!busy}>Cancel</button>
          <button type="button" className="btn btn--filled" disabled={!ready} onClick={() => onSplit(parts)}>
            {busy ? <span className="spinner spinner--sm spinner--on-primary" aria-hidden="true" /> : <Icon name="split_pdf" size={16} />}
            {busy ?? (parts.length >= 2 ? `Download ${plural(parts.length, "file")}` : "Download")}
          </button>
        </div>
      </div>
    </div>
  );
}
