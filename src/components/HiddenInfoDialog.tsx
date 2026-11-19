import { useEffect, useState } from "react";
import { staleBuildMessage } from "../staleBuild";
import { Icon } from "./Icon";
import { useModal } from "../hooks/useModal";
import type { HiddenRow } from "../pdf/hiddenInfo";

interface Props {
  /** Read the document's hidden information (loads pdf-lib). */
  onInspect: () => Promise<{ removed: HiddenRow[]; kept: HiddenRow[] }>;
  onDownload: () => void;
  onClose: () => void;
  /** Download is in progress or not possible right now. */
  busy: boolean;
}

/**
 * "Hidden information": what this file carries that you can't see on the page,
 * in two lists. First what stays in the file, with what to do about it: that's
 * the list that needs attention. Then what export removes, which comes from the
 * export's own clean-up pass run on a copy, so it describes exactly what the
 * download leaves out.
 */
export function HiddenInfoDialog({ onInspect, onDownload, onClose, busy }: Props) {
  const [rows, setRows] = useState<{ removed: HiddenRow[]; kept: HiddenRow[] } | null>(null);
  const [failed, setFailed] = useState(false);
  const modalRef = useModal<HTMLDivElement>(onClose);

  useEffect(() => {
    let live = true;
    onInspect().then(
      (r) => live && setRows(r),
      (err) => {
        staleBuildMessage(err);
        if (live) setFailed(true);
      },
    );
    return () => {
      live = false;
    };
    // Once, on open: the dialog describes the document as it was opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const list = (items: HiddenRow[], kept: boolean) => (
    <ul className="hidden__list">
      {items.map((r) => (
        <li key={r.id} className="hidden__row" data-row={r.id}>
          {kept ? <Icon name="hidden_kept" size={18} /> : <Icon name="hidden_removed" size={18} />}
          <span className="hidden__text">
            <span className="body-medium">{r.title}</span>
            {r.detail && <span className="hidden__detail body-small">{r.detail}</span>}
            {r.facts && (
              <dl className="hidden__facts body-small">
                {r.facts.map((f, i) => (
                  <div key={i} className="hidden__fact">
                    <dt>{f.label}</dt>
                    <dd>{f.value}</dd>
                  </div>
                ))}
              </dl>
            )}
          </span>
        </li>
      ))}
    </ul>
  );

  return (
    <div className="dialog-scrim" onPointerDown={onClose}>
      <div
        ref={modalRef}
        tabIndex={-1}
        className="dialog dialog--sm hidden"
        role="dialog"
        aria-modal="true"
        aria-labelledby="hidden-title"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="dialog__head">
          <h2 className="headline-small dialog__title" id="hidden-title">Hidden information</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close" data-tip="Close">
            <Icon name="close" size={20} />
          </button>
        </div>
        <div className="hidden__body" aria-live="polite" aria-busy={!rows && !failed}>
          {failed ? (
            <p className="body-medium hidden__status">Couldn't read this file's hidden information. Close and reopen to try again.</p>
          ) : !rows ? (
            <p className="body-medium hidden__status">
              <span className="spinner spinner--sm" aria-hidden="true" /> Looking through the file…
            </p>
          ) : (
            <>
              {rows.kept.length > 0 && (
                <section aria-labelledby="hidden-kept">
                  <h3 className="hidden__label label-medium" id="hidden-kept">Stays in the file</h3>
                  {list(rows.kept, true)}
                </section>
              )}
              <section aria-labelledby="hidden-removed">
                <h3 className="hidden__label label-medium" id="hidden-removed">Removed when you export</h3>
                {rows.removed.length ? (
                  list(rows.removed, false)
                ) : (
                  <p className="hidden__detail body-small hidden__none">
                    Nothing found. Exports from here never carry properties, scripts or attachments.
                  </p>
                )}
              </section>
            </>
          )}
        </div>
        <div className="dialog__actions">
          <button className="btn btn--text" onClick={onClose}>Close</button>
          <button className="btn btn--filled" onClick={onDownload} disabled={busy}>
            <Icon name="download" size={16} /> Download PDF
          </button>
        </div>
      </div>
    </div>
  );
}
