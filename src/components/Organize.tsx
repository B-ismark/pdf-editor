import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import { Thumbnail } from "./Thumbnail";
import { buildFromPlan, pageCount, type PlanEntry } from "../pdf/pageOps";

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
  const fileRef = useRef<HTMLInputElement>(null);
  const addCounter = useRef(0);

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
    if (file.type && file.type !== "application/pdf") return;
    setBusy("Adding pages…");
    try {
      const bytes = await file.arrayBuffer();
      const key = `add-${addCounter.current++}`;
      const n = await pageCount(bytes);
      setSources((prev) => new Map(prev).set(key, bytes));
      setPlan((prev) => [
        ...(prev ?? []),
        ...Array.from({ length: n }, (_, i) => ({ sourceKey: key, index: i, rotation: 0 })),
      ]);
    } finally {
      setBusy(null);
    }
  };

  const apply = async () => {
    if (!plan || plan.length === 0) return;
    if (hasEdits && !confirm("Applying page changes will discard your current text edits and redactions. Continue?")) return;
    setBusy("Applying…");
    try {
      const bytes = await buildFromPlan(plan, sources);
      const ab = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(ab).set(bytes);
      onApply(ab, `${plan.length} page(s) after organizing`);
    } finally {
      setBusy(null);
    }
  };

  const extract = async () => {
    if (!plan) return;
    const subset = plan.filter((_, i) => selected.has(i));
    if (subset.length === 0) return;
    setBusy("Extracting…");
    try {
      onExtract(await buildFromPlan(subset, sources));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="organize">
      <header className="organize__bar">
        <button className="icon-btn" onClick={onClose} aria-label="Close">
          <Icon name="close" size={24} />
        </button>
        <span className="title-large">Organize pages</span>
        <div className="appbar__spacer" />
        <button className="btn" onClick={() => fileRef.current?.click()}>
          <Icon name="note_add" size={18} /> <span className="organize__btnlabel">Add PDF</span>
        </button>
        {selected.size > 0 && (
          <button className="btn" onClick={extract}>
            <Icon name="download" size={18} /> <span className="organize__btnlabel">Extract {selected.size}</span>
          </button>
        )}
        <button className="btn btn--filled" onClick={apply} disabled={!plan || plan.length === 0 || !!busy}>
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

      {!plan ? (
        <div className="organize__loading body-medium">Loading pages…</div>
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
                  <span className="pcard__check"><Icon name="add" size={16} /></span>
                )}
              </button>
              <div className="pcard__no label-medium">{i + 1}</div>
              <div className="pcard__actions">
                <button className="icon-btn icon-btn--sm" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move earlier">
                  <Icon name="chevron_left" size={18} />
                </button>
                <button className="icon-btn icon-btn--sm" onClick={() => rotate(i)} aria-label="Rotate">
                  <Icon name="rotate" size={18} />
                </button>
                <button className="icon-btn icon-btn--sm" onClick={() => del(i)} aria-label="Delete page">
                  <Icon name="delete" size={18} />
                </button>
                <button className="icon-btn icon-btn--sm" onClick={() => move(i, 1)} disabled={i === plan.length - 1} aria-label="Move later">
                  <Icon name="chevron_right" size={18} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
