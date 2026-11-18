import { useEffect, useMemo, useRef } from "react";
import { Icon } from "./Icon";
import { PATTERN_PRESETS } from "../pdf/patterns";
import type { PatternHit } from "../pdf/find";

interface Props {
  /** In the right-hand column rather than floating over the page. */
  docked?: boolean;
  /** Preset ids switched on. */
  kinds: string[];
  custom: string;
  customError: string | null;
  /** The custom pattern's hits are still being looked for. */
  pending: boolean;
  /** More hits than can be reviewed: none are listed. */
  tooMany: boolean;
  hits: PatternHit[];
  /** Keys of hits the person has unticked: found, but left alone. */
  excluded: ReadonlySet<string>;
  activeId: string | null;
  /** Page labels as shown (the page plan can reorder and drop pages). */
  pageLabel: (pageIndex: number) => string;
  onToggleKind: (id: string) => void;
  onCustom: (source: string) => void;
  onToggleHit: (key: string) => void;
  onSetAll: (on: boolean) => void;
  onShow: (hit: PatternHit) => void;
  onRedact: () => void;
  onClose: () => void;
}

/** What a single hit is, beside it in the list. */
const KIND_LABEL: Record<string, string> = {
  email: "Email",
  iban: "IBAN",
  card: "Card",
  ssn: "SSN",
  date: "Date",
  phone: "Phone",
  custom: "Custom",
};

/**
 * "Redact patterns": find kinds of information (emails, card numbers, IBANs…)
 * and review every hit before any of it is covered.
 *
 * Not modal, so the page stays in view and readable while the list is
 * checked: each hit is highlighted where it is, a row shows it, and a hit
 * that isn't what it looks like is unticked and left alone. Nothing is
 * redacted until "Redact", and then in one undo step.
 */
export function PatternPanel({
  docked,
  kinds,
  custom,
  customError,
  pending,
  tooMany,
  hits,
  excluded,
  activeId,
  pageLabel,
  onToggleKind,
  onCustom,
  onToggleHit,
  onSetAll,
  onShow,
  onRedact,
  onClose,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>("input")?.focus();
  }, []);

  const chosen = hits.filter((h) => !excluded.has(h.key)).length;
  const byPage = useMemo(() => {
    const m = new Map<number, PatternHit[]>();
    for (const h of hits) m.set(h.pageIndex, [...(m.get(h.pageIndex) ?? []), h]);
    return [...m.entries()];
  }, [hits]);

  const anyKind = kinds.length > 0 || (custom.trim() !== "" && !customError);

  return (
    <div
      ref={ref}
      className={`patterns${docked ? " patterns--docked" : ""}`}
      role="dialog"
      aria-label="Redact patterns"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="patterns__head">
        <Icon name="redact_patterns" size={20} />
        <h2 className="patterns__title title-medium">Redact patterns</h2>
        <button className="icon-btn icon-btn--sm" onClick={onClose} aria-label="Close redact patterns" data-tip="Close · Esc">
          <Icon name="close" size={18} />
        </button>
      </div>

      <fieldset className="patterns__kinds">
        <legend className="patterns__legend label-medium">Look for</legend>
        {PATTERN_PRESETS.map((p) => (
          <label key={p.id} className="patterns__kind" data-tip={p.example}>
            <input type="checkbox" checked={kinds.includes(p.id)} onChange={() => onToggleKind(p.id)} />
            <span>{p.label}</span>
          </label>
        ))}
        <label className="patterns__custom">
          <span className="label-medium">Custom pattern</span>
          <input
            type="text"
            className="patterns__input"
            value={custom}
            spellCheck={false}
            placeholder="e.g. INV-\d{6}"
            aria-invalid={customError ? true : undefined}
            aria-describedby={customError ? "patterns-error" : undefined}
            onChange={(e) => onCustom(e.target.value)}
          />
        </label>
        {customError && (
          <p id="patterns-error" className="patterns__error body-small" role="alert">
            {customError}
          </p>
        )}
      </fieldset>

      <div className="patterns__summary">
        <span className="label-large" aria-live="polite">
          {!anyKind
            ? "Choose what to look for"
            : tooMany
              ? "Too many matches to review. Make the pattern more specific."
              : hits.length === 0
                ? pending
                  ? "Searching…"
                  : "Nothing found"
                : `${chosen} of ${hits.length} selected${pending ? " · searching…" : ""}`}
        </span>
        {hits.length > 0 && (
          <button className="patterns__all" onClick={() => onSetAll(chosen < hits.length)}>
            {chosen < hits.length ? "Select all" : "Select none"}
          </button>
        )}
      </div>

      <div className="patterns__list" role="list" aria-label="Found">
        {byPage.map(([pageIndex, list]) => (
          <div key={pageIndex} role="listitem" className="patterns__page">
            <h3 className="patterns__pagehead label-medium">{pageLabel(pageIndex)}</h3>
            {list.map((h) => (
              <div
                key={h.id}
                className={`patterns__hit${h.id === activeId ? " patterns__hit--on" : ""}${excluded.has(h.key) ? " patterns__hit--off" : ""}`}
                data-hit={h.id}
                data-kind={h.kind}
              >
                <input
                  type="checkbox"
                  checked={!excluded.has(h.key)}
                  onChange={() => onToggleHit(h.key)}
                  aria-label={`Redact ${KIND_LABEL[h.kind] ?? h.kind}: ${h.text}`}
                />
                <button className="patterns__show" onClick={() => onShow(h)} data-tip="Show on the page">
                  <span className="patterns__text">{h.text}</span>
                  <span className="patterns__kindtag label-medium">{KIND_LABEL[h.kind] ?? h.kind}</span>
                </button>
              </div>
            ))}
          </div>
        ))}
      </div>

      <p className="patterns__note body-small">
        Searches the page's own text, including recognised text. Form fields, notes and text you've added
        aren't searched, and a scanned page needs Recognise text first.
      </p>

      <div className="patterns__foot">
        <button className="btn btn--text" onClick={onClose}>
          Cancel
        </button>
        <button className="btn btn--filled" onClick={onRedact} disabled={chosen === 0 || pending}>
          {chosen === 0 ? "Redact" : `Redact ${chosen}`}
        </button>
      </div>
    </div>
  );
}
