import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { staleBuildMessage } from "../staleBuild";
import { Icon } from "./Icon";
import { plural } from "../plural";
import { Thumbnail } from "./Thumbnail";
import { ConfirmDialog } from "./ConfirmDialog";
import { useModal } from "../hooks/useModal";
import { buildFromPlan, pageCount, shownPageSize, type PlanEntry } from "../pdf/pageOps";
import { looksLikePdf } from "../pdf/loader";
import { IMAGE_ACCEPT, sniffImage } from "../pdf/images";
import { blankPage, imagesToPdf } from "../pdf/imagesToPdf";
import { makeZip } from "../pdf/zip";
import { SplitDialog, rangeLabel } from "./SplitDialog";
import type { PageRef } from "../pdf/types";

interface Props {
  mainBytes: ArrayBuffer;
  fileName: string;
  hasEdits: boolean;
  /** The document's current page plan (source index + extra turn, in order). */
  pages: PageRef[];
  /** Apply a plan that only rearranges this document's own pages: an ordinary,
   *  undoable edit that keeps every overlay with its page. */
  onArrange: (pages: PageRef[]) => void;
  /** This document as shown: its edits drawn in and its page plan applied
   *  (deleted pages cut out, not just unlisted). Page numbers and the
   *  watermark are drawn too only when `finishing`; a merge leaves them live,
   *  to number the merged document. Rejects (user-facing) on whiteout over
   *  live text, as Download does. */
  bakeMain: (finishing: boolean) => Promise<ArrayBuffer>;
  /** Apply a merged plan as the new working document. */
  onApply: (bytes: ArrayBuffer, note: string) => void;
  /** Download the given bytes without changing the working document. */
  onExtract: (bytes: Uint8Array) => void;
  /** Download the split files, zipped, without changing the working document. */
  onSplit: (zip: Uint8Array) => void;
  /** Open straight into Split (from the Export menu); closing it closes this. */
  startWithSplit?: boolean;
  onClose: () => void;
  /** The other documents open in tabs. Their pages can be merged in without
   * going back to the file system — with their edits baked in, since what you
   * see in that tab is what you mean by "that document". */
  otherDocs?: { id: string; name: string; bake: () => Promise<ArrayBuffer> }[];
}

/** Full-screen page organizer: reorder, rotate, delete, insert, merge,
 * extract, split. */
function toAB(bytes: Uint8Array): ArrayBuffer {
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  return ab;
}

export function Organize({
  mainBytes,
  fileName,
  hasEdits,
  pages,
  onArrange,
  bakeMain,
  onApply,
  onExtract,
  onSplit,
  startWithSplit = false,
  onClose,
  otherDocs = [],
}: Props) {
  const [sources, setSources] = useState<Map<string, ArrayBuffer>>(
    () => new Map([["main", mainBytes]]),
  );
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [confirmApply, setConfirmApply] = useState(false);
  // Opened after Organise has mounted, never in the same commit: the dialog's
  // focus trap has to stack *above* Organise's, and child effects run first.
  const [splitOpen, setSplitOpen] = useState(false);
  useEffect(() => {
    if (startWithSplit) setSplitOpen(true);
  }, []);
  const [splitErr, setSplitErr] = useState<string | null>(null);
  // Opened for Split alone: leaving Split leaves Organise too, back to where
  // it was asked for.
  const splitOnly = useRef(startWithSplit);
  const fileRef = useRef<HTMLInputElement>(null);
  // Locked while pages are being added or split: the insert point was worked
  // out from this plan, and must still mean the same place. Set by hand —
  // React 18 doesn't know `inert` — and in the same commit as the busy label.
  const gridRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    gridRef.current?.toggleAttribute("inert", !!busy);
  }, [busy]);
  const addCounter = useRef(0);
  const modalRef = useModal<HTMLDivElement>(onClose);

  // Seed from the document's current plan: what Organise shows is what the
  // viewer shows, in the same order and turned the same way.
  const [plan, setPlan] = useState<PlanEntry[] | null>(() =>
    pages.map((p) => ({ sourceKey: "main", index: p.index, rotation: p.rotate, ...(p.crop ? { crop: p.crop } : {}) })),
  );

  // Where the last pages added went: the next ones follow them, until a page
  // is picked or the plan changes. Kept apart from the picked pages so adding
  // never picks anything — that would change what Extract and Split do.
  const [after, setAfter] = useState<number | null>(null);

  const update = (next: PlanEntry[]) => {
    setPlan(next);
    setSelected(new Set());
    setAfter(null);
  };

  // Where the keyboard goes once a move or a delete has re-laid the grid: the
  // moved card remounts (its key holds its place) and a deleted one is gone,
  // so focus fell to the page — and the controls it was showing went with it.
  const refocus = useRef<{ at: number; label?: string } | null>(null);
  const keepFocus = (at: number, label?: string) => {
    if (gridRef.current?.contains(document.activeElement)) refocus.current = { at, label };
  };
  useEffect(() => {
    const want = refocus.current;
    refocus.current = null;
    const card = want && gridRef.current?.querySelectorAll<HTMLElement>(".pcard")[want.at];
    if (!card) return;
    const btn = want.label ? card.querySelector<HTMLButtonElement>(`[aria-label="${want.label}"]`) : null;
    (btn && !btn.disabled ? btn : card.querySelector<HTMLElement>(".pcard__thumb"))?.focus();
  }, [plan]);

  const move = (i: number, dir: -1 | 1) => {
    if (!plan) return;
    const j = i + dir;
    if (j < 0 || j >= plan.length) return;
    const next = plan.slice();
    [next[i], next[j]] = [next[j], next[i]];
    keepFocus(j, dir < 0 ? "Move earlier" : "Move later");
    update(next);
  };
  const rotate = (i: number) => {
    if (!plan) return;
    const next = plan.slice();
    next[i] = { ...next[i], rotation: (next[i].rotation + 90) % 360 };
    setPlan(next);
    setAfter(null);
  };
  const del = (i: number) => {
    if (!plan) return;
    keepFocus(Math.min(i, plan.length - 2));
    update(plan.filter((_, k) => k !== i));
  };
  const toggleSel = (i: number) => {
    const s = new Set(selected);
    s.has(i) ? s.delete(i) : s.add(i);
    setSelected(s);
    setAfter(null);
  };

  /** Where new pages go: after the last picked page, else after the pages
   * added last, else at the end. */
  const insertAt = plan
    ? selected.size > 0
      ? Math.max(...selected) + 1
      : after != null
        ? Math.min(after, plan.length)
        : plan.length
    : 0;

  /** A document's bytes, checked and counted, ready to go into the plan. */
  const prepare = async (bytes: ArrayBuffer | Uint8Array) => {
    const ab = bytes instanceof Uint8Array ? toAB(bytes) : bytes;
    return { key: `add-${addCounter.current++}`, ab, n: await pageCount(ab) };
  };

  /** Put every page of the prepared documents into the plan at `at`, in
   * order, in one step. The grid is locked while anything is being added, so
   * the plan `at` was worked out from is the plan this changes. */
  const insert = (docs: { key: string; ab: ArrayBuffer; n: number }[], at: number) => {
    if (!plan) return;
    const pos = Math.max(0, Math.min(at, plan.length));
    const added = docs.flatMap((d) => Array.from({ length: d.n }, (_, i) => ({ sourceKey: d.key, index: i, rotation: 0 })));
    setSources((prev) => {
      const next = new Map(prev);
      for (const d of docs) next.set(d.key, d.ab);
      return next;
    });
    setPlan([...plan.slice(0, pos), ...added, ...plan.slice(pos)]);
    setSelected(new Set());
    setAfter(pos + added.length);
  };

  const addOpenDoc = async (d: { name: string; bake: () => Promise<ArrayBuffer> }) => {
    setErr(null);
    setBusy("Adding pages…");
    try {
      insert([await prepare(await d.bake())], insertAt);
    } catch (e) {
      setErr(staleBuildMessage(e) ?? ((e as { userFacing?: boolean })?.userFacing ? (e as Error).message : `Couldn't add the pages of "${d.name}".`));
    } finally {
      setBusy(null);
    }
  };

  /**
   * Add the files picked, in order, at the insert point: each PDF's pages, and
   * each run of pictures as pages of their own (metadata taken out, as when a
   * picture is opened). All or nothing: every file is read and checked first,
   * so one that can't be added leaves the plan as it was, and says which.
   */
  const addFiles = async (files: File[]) => {
    setErr(null);
    setBusy("Adding pages…");
    let current = "";
    try {
      const read = await Promise.all(files.map(async (f) => ({ name: f.name, bytes: await f.arrayBuffer() })));
      const notOurs = read.filter((f) => !sniffImage(f.bytes.slice(0, 8)) && !looksLikePdf(f.bytes));
      if (notOurs.length > 0) {
        // Sniffed by content — HTML or a renamed file is refused here rather
        // than deep in the merge.
        const names = notOurs.map((f) => `"${f.name}"`).join(", ");
        setErr(`${names} ${notOurs.length === 1 ? "isn't a PDF or a picture" : "aren't PDFs or pictures"} (JPEG, PNG). Nothing was added.`);
        return;
      }
      const docs = [];
      let pictures: { name: string; bytes: ArrayBuffer }[] = [];
      const flush = async () => {
        if (pictures.length === 0) return;
        current = pictures[0].name;
        const batch = pictures;
        pictures = [];
        docs.push(await prepare(await imagesToPdf(batch)));
      };
      for (const file of read) {
        if (sniffImage(file.bytes.slice(0, 8))) {
          pictures.push(file);
          continue;
        }
        await flush();
        current = file.name;
        docs.push(await prepare(file.bytes));
      }
      await flush();
      insert(docs, insertAt);
    } catch (e) {
      setErr(
        staleBuildMessage(e) ??
          ((e as { fileName?: string })?.fileName != null
            ? `${(e as Error).message} Nothing was added.`
            : `Couldn't add "${current}". It may be damaged or password-protected. Nothing was added.`),
      );
    } finally {
      setBusy(null);
    }
  };

  /** An empty page at the insert point, the size of the page before it as
   * shown (or the first page's, at the very start). */
  const addBlank = async () => {
    if (!plan || plan.length === 0) return;
    setErr(null);
    setBusy("Adding a page…");
    try {
      const like = plan[insertAt - 1] ?? plan[0];
      const size = await shownPageSize(sources.get(like.sourceKey)!, like.index, like.rotation, like.crop);
      insert([await prepare(await blankPage(size.width, size.height))], insertAt);
    } catch (e) {
      setErr(staleBuildMessage(e) ?? "Couldn't add a blank page. Please try again.");
    } finally {
      setBusy(null);
    }
  };

  /** True when the plan only uses this document's own pages — the common case,
   *  applied as an undoable edit rather than a rebuild. */
  const ownPagesOnly = !!plan && plan.every((e) => e.sourceKey === "main");

  /**
   * This document's pages for a rebuild: the original bytes when it has no
   * edits, otherwise the baked copy, with the plan's entries moved onto it.
   * The baked copy has the plan applied, so a card's source page becomes its
   * position in `pages`, and the turn the plan already drew is taken off.
   */
  const mainAsShown = async (entries: PlanEntry[], finishing: boolean) => {
    if (!hasEdits) return { entries, bytes: mainBytes };
    const bytes = await bakeMain(finishing);
    const at = new Map(pages.map((p, i) => [p.index, { pos: i, rotate: p.rotate }]));
    return {
      bytes,
      entries: entries.map((e) => {
        if (e.sourceKey !== "main") return e;
        const was = at.get(e.index);
        if (!was) throw new Error("A page isn't in the document any more.");
        // The baked copy has the crop drawn in, as its CropBox.
        return { sourceKey: e.sourceKey, index: was.pos, rotation: (((e.rotation - was.rotate) % 360) + 360) % 360 };
      }),
    };
  };
  const failure = (e: unknown, fallback: string) =>
    (e as { userFacing?: boolean })?.userFacing ? (e as Error).message : fallback;

  const doApply = async () => {
    if (!plan || plan.length === 0) return;
    setConfirmApply(false);
    setErr(null);
    if (ownPagesOnly) {
      onArrange(plan.map((e) => ({ index: e.index, rotate: e.rotation, ...(e.crop ? { crop: e.crop } : {}) })));
      return;
    }
    setBusy("Applying…");
    try {
      // Merging rebuilds the file, so this document's edits are drawn into its
      // pages first.
      const main = await mainAsShown(plan, false);
      const bytes = await buildFromPlan(main.entries, new Map(sources).set("main", main.bytes));
      const ab = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(ab).set(bytes);
      onApply(ab, `${plural(plan.length, "page")} after organising`);
    } catch (e) {
      setErr(staleBuildMessage(e) ?? failure(e, "Couldn't rebuild the document. Please try again."));
    } finally {
      setBusy(null);
    }
  };

  const apply = () => {
    if (!plan || plan.length === 0) return;
    if (hasEdits && !ownPagesOnly) setConfirmApply(true);
    else void doApply();
  };

  const extract = async () => {
    if (!plan) return;
    const subset = plan.filter((_, i) => selected.has(i));
    if (subset.length === 0) return;
    setErr(null);
    setBusy("Extracting…");
    try {
      // The pages as you see them: an extract of the original bytes would hand
      // back text you redacted.
      const main = await mainAsShown(subset, true);
      onExtract(await buildFromPlan(main.entries, new Map(sources).set("main", main.bytes), { forDownload: true }));
    } catch (e) {
      setErr(staleBuildMessage(e) ?? failure(e, "Couldn't extract those pages. Please try again."));
    } finally {
      setBusy(null);
    }
  };

  const closeSplit = () => {
    setSplitOpen(false);
    setSplitErr(null);
    if (splitOnly.current) onClose();
  };

  /** One file per part, from this document as shown — never the original
   * bytes, which would hand back what was redacted. */
  const split = async (parts: number[][]) => {
    if (!plan) return;
    setSplitErr(null);
    setBusy("Splitting…");
    try {
      const main = await mainAsShown(plan, true);
      const all = new Map(sources).set("main", main.bytes);
      const base = fileName.replace(/\.pdf$/i, "");
      const files = [];
      for (const part of parts) {
        const data = await buildFromPlan(part.map((pos) => main.entries[pos]), all, { forDownload: true });
        files.push({ name: `${base}-pages-${rangeLabel(part).replace("–", "-")}.pdf`, data });
      }
      onSplit(makeZip(files));
      setBusy(null);
      closeSplit();
    } catch (e) {
      setSplitErr(staleBuildMessage(e) ?? failure(e, "Couldn't split the document. Please try again."));
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
      aria-label="Organise pages"
    >
      <header className="organize__bar">
        <button className="icon-btn" onClick={onClose} aria-label="Close" data-tip="Close">
          <Icon name="close" size={20} />
        </button>
        <span className="title-large">Organise pages</span>
        <div className="appbar__spacer" />
        <button
          className="btn"
          onClick={() => fileRef.current?.click()}
          disabled={!!busy}
          aria-label="Add file: a PDF or pictures"
          data-tip="Add a PDF's pages, or pictures as pages"
        >
          <Icon name="note_add" size={16} /> <span className="organize__btnlabel" aria-hidden="true">Add file</span>
        </button>
        <button
          className="btn"
          onClick={() => void addBlank()}
          disabled={!!busy || !plan || plan.length === 0}
          aria-label="Add blank page"
          data-tip="Add a blank page"
        >
          <Icon name="blank_page" size={16} /> <span className="organize__btnlabel" aria-hidden="true">Blank page</span>
        </button>
        <button
          className="btn"
          onClick={() => {
            splitOnly.current = false;
            setSplitErr(null);
            setSplitOpen(true);
          }}
          disabled={!!busy || !plan || plan.length < 2}
          aria-label="Split into files"
          data-tip="Split into files"
        >
          <Icon name="split_pdf" size={16} /> <span className="organize__btnlabel" aria-hidden="true">Split</span>
        </button>
        {selected.size > 0 && (
          <button className="btn" onClick={extract} disabled={!!busy} aria-label={`Extract ${plural(selected.size, "page")}`}>
            <Icon name="download" size={16} /> <span className="organize__btnlabel" aria-hidden="true">Extract {selected.size}</span>
          </button>
        )}
        <button className="btn btn--filled" onClick={apply} disabled={!plan || plan.length === 0 || !!busy}>
          {busy && <span className="spinner spinner--sm spinner--on-primary" aria-hidden="true" />}
          {busy ?? "Apply"}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept={`application/pdf,.pdf,${IMAGE_ACCEPT}`}
          multiple
          hidden
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = "";
            if (files.length > 0) void addFiles(files);
          }}
        />
      </header>

      <p className="organize__hint body-small">
        {/* The cards show reorder, rotate and delete themselves; the one
            thing the grid can't show is where an added page will land. */}
        {fileName} ·{" "}
        <span className="organize__at">
          {plan && insertAt < plan.length
            ? `new pages go after page ${insertAt}`
            : "new pages go at the end"}
        </span>
      </p>

      {otherDocs.length > 0 && (
        <div className="organize__docs" role="group" aria-label="Add pages from an open document">
          <span className="label-medium organize__docslabel">From open tabs</span>
          {otherDocs.map((d) => (
            <button
              key={d.id}
              className="chip"
              onClick={() => void addOpenDoc(d)}
              disabled={!!busy}
              data-tip={`Add every page of ${d.name}, with its edits`}
            >
              <Icon name="add" size={14} /> <span className="organize__docname">{d.name}</span>
            </button>
          ))}
        </div>
      )}

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
        <div className="organize__grid" ref={gridRef} aria-busy={busy ? true : undefined}>
          {plan.map((entry, i) => (
            <div
              key={`${entry.sourceKey}-${entry.index}-${i}`}
              className={`pcard${selected.has(i) ? " pcard--sel" : ""}`}
            >
              <button
                className="pcard__thumb"
                onClick={() => toggleSel(i)}
                aria-pressed={selected.has(i)}
                aria-label={`Page ${i + 1}`}
              >
                <Thumbnail bytes={sources.get(entry.sourceKey)!} index={entry.index} rotation={entry.rotation} crop={entry.crop} />
                {/* Every card carries its pick ring, empty until picked: that a
                    page can be picked is shown, not written in the hint. */}
                <span className={`pcard__check${selected.has(i) ? "" : " pcard__check--off"}`} aria-hidden="true">
                  {selected.has(i) && <Icon name="check" size={15} />}
                </span>
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

      {splitOpen && plan && (
        <SplitDialog
          count={plan.length}
          picked={[...selected]}
          busy={busy}
          error={splitErr}
          onSplit={(parts) => void split(parts)}
          onClose={closeSplit}
        />
      )}

      {confirmApply && (
        <ConfirmDialog
          title="Apply page changes?"
          message="Adding pages rebuilds this document: your text edits, annotations and redactions are drawn into the pages and can no longer be changed, and undo starts over."
          confirmLabel="Apply"
          danger
          onConfirm={doApply}
          onCancel={() => setConfirmApply(false)}
        />
      )}
    </div>
  );
}
