import { useRef, useState } from "react";
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
  const [splitOpen, setSplitOpen] = useState(startWithSplit);
  const [splitErr, setSplitErr] = useState<string | null>(null);
  // Opened for Split alone: leaving Split leaves Organise too, back to where
  // it was asked for.
  const splitOnly = useRef(startWithSplit);
  const fileRef = useRef<HTMLInputElement>(null);
  const addCounter = useRef(0);
  const modalRef = useModal<HTMLDivElement>(onClose);

  // Seed from the document's current plan: what Organise shows is what the
  // viewer shows, in the same order and turned the same way.
  const [plan, setPlan] = useState<PlanEntry[] | null>(() =>
    pages.map((p) => ({ sourceKey: "main", index: p.index, rotation: p.rotate })),
  );

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

  /** Where new pages go: after the last picked page, or at the end. */
  const insertAt = plan ? (selected.size > 0 ? Math.max(...selected) + 1 : plan.length) : 0;

  /** Put every page of `bytes` into the plan at position `at`, and pick them,
   * so they show where they landed and the next insert follows them. Returns
   * the position after them. */
  const addBytes = async (bytes: ArrayBuffer | Uint8Array, at: number) => {
    const ab = bytes instanceof Uint8Array ? toAB(bytes) : bytes;
    const key = `add-${addCounter.current++}`;
    const n = await pageCount(ab);
    setSources((prev) => new Map(prev).set(key, ab));
    setPlan((prev) => {
      const list = prev ?? [];
      const pos = Math.max(0, Math.min(at, list.length));
      const added = Array.from({ length: n }, (_, i) => ({ sourceKey: key, index: i, rotation: 0 }));
      return [...list.slice(0, pos), ...added, ...list.slice(pos)];
    });
    setSelected(new Set(Array.from({ length: n }, (_, i) => at + i)));
    return at + n;
  };

  const addOpenDoc = async (d: { name: string; bake: () => Promise<ArrayBuffer> }) => {
    setErr(null);
    setBusy("Adding pages…");
    try {
      await addBytes(await d.bake(), insertAt);
    } catch (e) {
      setErr(staleBuildMessage(e) ?? ((e as { userFacing?: boolean })?.userFacing ? (e as Error).message : `Couldn't add the pages of "${d.name}".`));
    } finally {
      setBusy(null);
    }
  };

  /**
   * Add the files picked, in order, at the insert point: each PDF's pages, and
   * each run of pictures as pages of their own (metadata taken out, as when a
   * picture is opened).
   */
  const addFiles = async (files: File[]) => {
    setErr(null);
    setBusy("Adding pages…");
    let at = insertAt;
    let current = "";
    try {
      let pictures: { name: string; bytes: ArrayBuffer }[] = [];
      const flush = async () => {
        if (pictures.length === 0) return;
        current = pictures[0].name;
        const batch = pictures;
        pictures = [];
        at = await addBytes(await imagesToPdf(batch), at);
      };
      for (const file of files) {
        current = file.name;
        const bytes = await file.arrayBuffer();
        if (sniffImage(bytes.slice(0, 8))) {
          pictures.push({ name: file.name, bytes });
          continue;
        }
        await flush();
        current = file.name;
        // Sniff the content — reject HTML or a renamed file before pdf-lib
        // chokes on it deep in the merge.
        if (!looksLikePdf(bytes)) {
          setErr(`"${file.name}" isn't a PDF or a picture (JPEG, PNG).`);
          return;
        }
        at = await addBytes(bytes, at);
      }
      await flush();
    } catch (e) {
      setErr(
        staleBuildMessage(e) ??
          ((e as { fileName?: string })?.fileName != null
            ? (e as Error).message
            : `Couldn't add "${current}". It may be damaged or password-protected.`),
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
      const size = await shownPageSize(sources.get(like.sourceKey)!, like.index, like.rotation);
      await addBytes(await blankPage(size.width, size.height), insertAt);
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
        return { ...e, index: was.pos, rotation: (((e.rotation - was.rotate) % 360) + 360) % 360 };
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
      onArrange(plan.map((e) => ({ index: e.index, rotate: e.rotation })));
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
      onExtract(await buildFromPlan(main.entries, new Map(sources).set("main", main.bytes)));
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
        const data = await buildFromPlan(part.map((pos) => main.entries[pos]), all);
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
          aria-label="Add PDF or pictures"
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
        Reorder, rotate, or delete pages · tap a page to pick it ·{" "}
        <span className="organize__at">
          {plan && selected.size > 0 && insertAt < plan.length
            ? `new pages go after page ${insertAt}`
            : "new pages go at the end"}
        </span>
        . {fileName}
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
