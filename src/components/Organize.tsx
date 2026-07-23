import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import { Thumbnail } from "./Thumbnail";
import { ConfirmDialog } from "./ConfirmDialog";
import { useModal } from "../hooks/useModal";
import { buildFromPlan, pageCount, type PlanEntry } from "../pdf/pageOps";
import { looksLikePdf } from "../pdf/loader";

interface Props {
  mainBytes: ArrayBuffer;
  fileName: string;
  hasEdits: boolean;
  /** Apply the plan as the new working document. */
  onApply: (bytes: ArrayBuffer, note: string) => void;
  /** Download the given bytes without changing the working document. */
  onExtract: (bytes: Uint8Array) => void;
  onClose: () => void;
}

/** Full-screen page organizer: reorder, rotate, delete, merge, extract. */
export function Organize({
  mainBytes,
  fileName,
  hasEdits,
  onApply,
  onExtract,
  onClose,
}: Props) {
  const [sources, setSources] = useState<Map<string, ArrayBuffer>>(
    () => new Map([["main", mainBytes]]),
  );
  const [plan, setPlan] = useState<PlanEntry[] | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [confirmApply, setConfirmApply] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const addCounter = useRef(0);
  const modalRef = useModal<HTMLDivElement>(onClose);

  // Seed the plan from the main document's page count.
  useEffect(() => {
    let cancelled = false;
    pageCount(mainBytes).then((n) => {
      if (cancelled) return;
      setPlan(
        Array.from({ length: n }, (_, i) => ({ sourceKey: "main", index: i, rotation: 0 })),
      );
    });
    return () => {
      cancelled = true;
    };
  }, [mainBytes]);

  const update = (next: PlanEntry[]) => {
    setPlan(next);
    setSelected(new Set());
  };

  const move = (i: number, dir: -1 | 1) => {
    if (!plan) return;
    const j = i + dir;
    if (j < 0 || j >= plan.length) return;
    const next = plan.slice();
    [next[i], next[j]] = [next[j], next[i]];
    update(next);
  };
  const rotate = (i: number) => {
    if (!plan) return;
    const next = plan.slice();
    next[i] = { ...next[i], rotation: (next[i].rotation + 90) % 360 };
    setPlan(next);
  };
  const del = (i: number) => {
    if (!plan) return;
    update(plan.filter((_, k) => k !== i));
  };
  const toggleSel = (i: number) => {
    const s = new Set(selected);
    s.has(i) ? s.delete(i) : s.add(i);
    setSelected(s);
  };

  const addFile = async (file: File) => {
    setErr(null);
    setBusy("Adding pages…");
    try {
      const bytes = await file.arrayBuffer();
      // Sniff the content — reject an image/HTML/renamed file before pdf-lib
      // chokes on it deep in the merge.
      if (!looksLikePdf(bytes)) {
        setErr(`"${file.name}" isn't a PDF file.`);
        return;
      }
      const key = `add-${addCounter.current++}`;
      const n = await pageCount(bytes);
      setSources((prev) => new Map(prev).set(key, bytes));
      setPlan((prev) => [
        ...(prev ?? []),
        ...Array.from({ length: n }, (_, i) => ({ sourceKey: key, index: i, rotation: 0 })),
      ]);
    } catch {
      setErr(`Couldn't add "${file.name}". It may be damaged or password-protected.`);
    } finally {
      setBusy(null);
    }
  };

  const doApply = async () => {
    if (!plan || plan.length === 0) return;
    setConfirmApply(false);
    setErr(null);
    setBusy("Applying…");
    try {
      const bytes = await buildFromPlan(plan, sources);
      const ab = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(ab).set(bytes);
      onApply(ab, `${plan.length} page(s) after organizing`);
    } catch {
      setErr("Couldn't rebuild the document. Please try again.");
    } finally {
      setBusy(null);
    }
  };

  const apply = () => {
    if (!plan || plan.length === 0) return;
    if (hasEdits) setConfirmApply(true);
    else void doApply();
  };

  const extract = async () => {
    if (!plan) return;
    const subset = plan.filter((_, i) => selected.has(i));
    if (subset.length === 0) return;
    setErr(null);
    setBusy("Extracting…");
    try {
      onExtract(await buildFromPlan(subset, sources));
    } catch {
      setErr("Couldn't extract those pages. Please try again.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      className="organize"
      ref={modalRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label="Organize pages"
    >
      <header className="organize__bar">
        <button className="icon-btn" onClick={onClose} aria-label="Close" data-tip="Close">
          <Icon name="close" size={20} />
        </button>
        <span className="title-large">Organize pages</span>
        <div className="appbar__spacer" />
        <button className="btn" onClick={() => fileRef.current?.click()}>
          <Icon name="note_add" size={16} /> <span className="organize__btnlabel">Add PDF</span>
        </button>
        {selected.size > 0 && (
          <button className="btn" onClick={extract}>
            <Icon name="download" size={16} /> <span className="organize__btnlabel">Extract {selected.size}</span>
          </button>
        )}
        <button className="btn btn--filled" onClick={apply} disabled={!plan || plan.length === 0 || !!busy}>
          {busy && <span className="spinner spinner--sm spinner--on-primary" aria-hidden="true" />}
          {busy ?? "Apply"}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/pdf,.pdf"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void addFile(f);
            e.target.value = "";
          }}
        />
      </header>

      <p className="organize__hint body-small">
        Reorder, rotate, or delete pages · tap a page to select it for extract ·
        add another PDF to merge. {fileName}
      </p>

      {err && (
        <p className="organize__err body-small" role="alert">
          <Icon name="close" size={15} /> {err}
        </p>
      )}

      {!plan ? (
        <div className="organize__loading body-medium">
          <span className="spinner spinner--sm" aria-hidden="true" /> Loading pages…
        </div>
      ) : (
        <div className="organize__grid">
          {plan.map((entry, i) => (
            <div
              key={`${entry.sourceKey}-${entry.index}-${i}`}
              className={`pcard${selected.has(i) ? " pcard--sel" : ""}`}
            >
              <button className="pcard__thumb" onClick={() => toggleSel(i)} aria-pressed={selected.has(i)}>
                <Thumbnail bytes={sources.get(entry.sourceKey)!} index={entry.index} rotation={entry.rotation} />
                {selected.has(i) && (
                  <span className="pcard__check"><Icon name="add" size={15} /></span>
                )}
              </button>
              <div className="pcard__no label-medium">{i + 1}</div>
              <div className="pcard__actions">
                <button className="icon-btn icon-btn--sm" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move earlier" data-tip="Move earlier">
                  <Icon name="chevron_left" size={16} />
                </button>
                <button className="icon-btn icon-btn--sm" onClick={() => rotate(i)} aria-label="Rotate" data-tip="Rotate">
                  <Icon name="rotate" size={16} />
                </button>
                <button className="icon-btn icon-btn--sm" onClick={() => del(i)} aria-label="Delete page" data-tip="Delete page">
                  <Icon name="delete" size={16} />
                </button>
                <button className="icon-btn icon-btn--sm" onClick={() => move(i, 1)} disabled={i === plan.length - 1} aria-label="Move later" data-tip="Move later">
                  <Icon name="chevron_right" size={16} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {confirmApply && (
        <ConfirmDialog
          title="Apply page changes?"
          message="This rebuilds the document and discards your current text edits, annotations, and redactions."
          confirmLabel="Apply"
          danger
          onConfirm={doApply}
          onCancel={() => setConfirmApply(false)}
        />
      )}
    </div>
  );
}
