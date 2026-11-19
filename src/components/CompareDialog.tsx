import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Icon } from "./Icon";
import { useModal } from "../hooks/useModal";
import { staleBuildMessage } from "../staleBuild";
import { segmentKey } from "../segmentKey";
import { plural } from "../plural";
import { getCachedDoc, isRenderCancelled, releaseDoc } from "../pdf/loader";
import { compareText, docText, quote, type Box, type Change, type Comparison } from "../pdf/compare";
import type { LoadedPdf, PageData } from "../pdf/types";

/** An open document, as Compare can read it. */
export interface CompareDoc {
  id: string;
  name: string;
  /** The document as it would download: its edits baked in when it has any. */
  load: () => Promise<{ pdf: LoadedPdf; edited: boolean }>;
  /** The document in front, whose parse the editor behind is still drawing from. */
  front: boolean;
}

interface Props {
  docs: CompareDoc[];
  /** The two to start with. */
  before: string;
  after: string;
  onClose: () => void;
}

interface Side {
  doc: CompareDoc;
  pdf: LoadedPdf;
  edited: boolean;
}

type Mode = "side" | "overlay";

/**
 * Compare two open documents: what the text says differently, word by word,
 * marked on both sides; and an overlay of the pages themselves for what the
 * text can't show (a moved picture, a changed table rule, a scanned page).
 *
 * Each side is the document as it would download, so a tab's unsaved edits
 * are part of what's compared, and a redacted word is gone from it.
 */
export function CompareDialog({ docs, before, after, onClose }: Props) {
  const modalRef = useModal<HTMLDivElement>(onClose);
  const [ids, setIds] = useState({ before, after });
  const [mode, setMode] = useState<Mode>("side");
  const [sides, setSides] = useState<{ a: Side; b: Side } | null>(null);
  const [result, setResult] = useState<Comparison | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [cur, setCur] = useState<number | null>(null);
  const rowRefs = useRef(new Map<number, HTMLDivElement>());
  const listRefs = useRef(new Map<number, HTMLButtonElement>());

  // Each document is read once however often the sides are swapped; every
  // parse made here is let go on close (the front one's only if it was a
  // copy with edits baked in — the editor behind still draws the original).
  const loads = useRef(new Map<string, Promise<Side>>());
  useEffect(() => {
    const all = loads.current;
    return () => {
      for (const p of all.values()) {
        void p.then((s) => {
          if (!s.doc.front || s.edited) releaseDoc(s.pdf.bytes);
        }, () => {});
      }
    };
  }, []);
  const load = (id: string): Promise<Side> => {
    let p = loads.current.get(id);
    if (!p) {
      const doc = docs.find((d) => d.id === id)!;
      p = doc.load().then((r) => ({ doc, ...r }));
      loads.current.set(id, p);
    }
    return p;
  };

  useEffect(() => {
    let live = true;
    setSides(null);
    setResult(null);
    setFailed(null);
    setCur(null);
    Promise.all([load(ids.before), load(ids.after)])
      .then(async ([a, b]) => {
        if (!live) return;
        setSides({ a, b });
        const r = await compareText(docText(a.pdf.pages), docText(b.pdf.pages));
        if (live) setResult(r);
      })
      .catch((err) => {
        if (!live) return;
        setFailed(staleBuildMessage(err) ?? (err?.userFacing ? err.message : "Couldn't compare these documents. Please try again."));
      });
    return () => {
      live = false;
    };
    // `load` reads `docs`, which is fixed for the dialog's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids.before, ids.after]);

  const changes = result?.changes ?? [];
  const rows = sides ? Math.max(sides.a.pdf.pages.length, sides.b.pdf.pages.length) : 0;

  // Marks per page, per side.
  const marks = useMemo(() => {
    const before = new Map<number, Mark[]>();
    const after = new Map<number, Mark[]>();
    const add = (m: Map<number, Mark[]>, page: number, mark: Mark) => {
      const list = m.get(page);
      if (list) list.push(mark);
      else m.set(page, [mark]);
    };
    for (const c of changes) {
      for (const w of c.removed) for (const box of w.boxes) add(before, w.page, { box, change: c.id, kind: "removed" });
      for (const w of c.added) for (const box of w.boxes) add(after, w.page, { box, change: c.id, kind: "added" });
    }
    return { before, after };
  }, [changes]);

  const pagesChanged = useMemo(() => {
    const s = new Set<number>();
    for (const c of changes) s.add(c.kind === "removed" ? c.beforePage : c.afterPage);
    return s.size;
  }, [changes]);

  /** Show a change: select it, bring its page into view, and its row in the list. */
  const go = (id: number) => {
    setCur(id);
    const c = changes[id];
    if (!c) return;
    rowRefs.current.get(c.kind === "removed" ? c.beforePage : c.afterPage)?.scrollIntoView({ block: "center" });
    listRefs.current.get(id)?.scrollIntoView({ block: "nearest" });
  };
  const step = (by: number) => {
    if (!changes.length) return;
    go(cur == null ? (by > 0 ? 0 : changes.length - 1) : (cur + by + changes.length) % changes.length);
  };

  const nameOf = (id: string) => docs.find((d) => d.id === id)?.name ?? "";
  const many = docs.length > 2;

  /** The documents on one side: a choice when there are more than two. */
  const slot = (which: "before" | "after") => {
    const label = which === "before" ? "Before" : "After";
    const other = which === "before" ? ids.after : ids.before;
    const side = sides?.[which === "before" ? "a" : "b"];
    const edited = side?.doc.id === ids[which] && side.edited;
    if (!many) {
      return (
        <span className="compare__slot">
          <span className="label-medium compare__slotlabel">{label}</span>
          <span className="body-medium compare__name" data-side={which}>{nameOf(ids[which])}</span>
          {edited && (
            <span className="label-small compare__edited" data-tip="Compared as it would download, with the changes you've made">
              with your edits
            </span>
          )}
        </span>
      );
    }
    const choices = docs.filter((d) => d.id !== other);
    const at = choices.findIndex((d) => d.id === ids[which]);
    return (
      <span className="compare__slot">
        <span className="label-medium compare__slotlabel" id={`compare-${which}`}>{label}</span>
        <span
          className="segmented segmented--compact compare__choices"
          role="radiogroup"
          aria-labelledby={`compare-${which}`}
          onKeyDown={(e) => {
            const to = segmentKey(e.key, at, choices.length);
            if (to == null) return;
            e.preventDefault();
            setIds((v) => ({ ...v, [which]: choices[to].id }));
            (e.currentTarget.children[to] as HTMLElement | undefined)?.focus();
          }}
        >
          {choices.map((d) => (
            <button
              key={d.id}
              type="button"
              role="radio"
              aria-checked={d.id === ids[which]}
              tabIndex={d.id === ids[which] ? 0 : -1}
              className={`segmented__btn compare__name${d.id === ids[which] ? " segmented__btn--on" : ""}`}
              data-side={d.id === ids[which] ? which : undefined}
              onClick={() => setIds((v) => ({ ...v, [which]: d.id }))}
            >
              {d.name}
            </button>
          ))}
        </span>
        {edited && (
          <span className="label-small compare__edited" data-tip="Compared as it would download, with the changes you've made">
            with your edits
          </span>
        )}
      </span>
    );
  };

  let summary: string;
  if (failed) summary = failed;
  else if (!result) summary = "Comparing…";
  else if (!sides!.a.pdf.pages.some((p) => p.fragments.length) && !sides!.b.pdf.pages.some((p) => p.fragments.length))
    summary = "Neither document has text to compare. Overlay shows how the pages differ.";
  else if (!changes.length) summary = "The text is the same. Overlay shows any difference in pictures or layout.";
  else summary = `${plural(changes.length, "change")} on ${plural(pagesChanged, "page")}`;

  const current = cur != null ? changes[cur] : null;

  return (
    <div className="compare" ref={modalRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="compare-title">
      <header className="organize__bar compare__bar">
        <button className="icon-btn" onClick={onClose} aria-label="Close" data-tip="Close">
          <Icon name="close" size={20} />
        </button>
        <span className="title-large" id="compare-title">Compare</span>
        <div className="appbar__spacer" />
        <div
          className="segmented segmented--compact"
          role="radiogroup"
          aria-label="View"
          onKeyDown={(e) => {
            const views: Mode[] = ["side", "overlay"];
            const to = segmentKey(e.key, views.indexOf(mode), 2);
            if (to == null) return;
            e.preventDefault();
            setMode(views[to]);
            (e.currentTarget.children[to] as HTMLElement | undefined)?.focus();
          }}
        >
          {(["side", "overlay"] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              tabIndex={mode === m ? 0 : -1}
              className={`segmented__btn${mode === m ? " segmented__btn--on" : ""}`}
              onClick={() => setMode(m)}
            >
              {m === "side" ? "Side by side" : "Overlay"}
            </button>
          ))}
        </div>
      </header>

      <div className="compare__docs">
        {slot("before")}
        <button
          type="button"
          className="icon-btn compare__swap"
          aria-label="Swap before and after"
          data-tip="Swap"
          onClick={() => setIds((v) => ({ before: v.after, after: v.before }))}
        >
          <Icon name="swap_sides" size={18} />
        </button>
        {slot("after")}
      </div>

      <div className="compare__status">
        <span className={`body-medium compare__summary${failed ? " compare__summary--err" : ""}`} role="status">
          {!result && !failed && <span className="spinner spinner--sm" aria-hidden="true" />} {summary}
        </span>
        {result?.rough && (
          <span className="body-small compare__rough">Some passages differ too much to compare word by word, and are marked whole.</span>
        )}
        {changes.length > 0 && (
          <span className="compare__nav">
            <button type="button" className="icon-btn" aria-label="Previous change" data-tip="Previous change" onClick={() => step(-1)}>
              <Icon name="chevron_up" size={18} />
            </button>
            <span className="label-medium compare__count">{cur == null ? "" : `${cur + 1} of ${changes.length}`}</span>
            <button type="button" className="icon-btn" aria-label="Next change" data-tip="Next change" onClick={() => step(1)}>
              <Icon name="chevron_down" size={18} />
            </button>
          </span>
        )}
      </div>

      <div className="compare__body">
        {changes.length > 0 && (
          <ul className="compare__list" aria-label="Changes">
            {changes.map((c) => (
              <li key={c.id}>
                <ChangeRow c={c} on={c.id === cur} onPick={() => go(c.id)} refFn={(el) => (el ? listRefs.current.set(c.id, el) : listRefs.current.delete(c.id))} />
              </li>
            ))}
          </ul>
        )}

        <div className="compare__pages">
          {sides && mode === "side" && (
            <div className="compare__heads" aria-hidden="true">
              <span className="label-medium">{sides.a.doc.name}</span>
              <span className="label-medium">{sides.b.doc.name}</span>
            </div>
          )}
          {sides && mode === "overlay" && (
            <p className="body-small compare__legend">
              <span className="compare__key compare__key--removed" /> Only in {sides.a.doc.name}
              <span className="compare__key compare__key--added" /> Only in {sides.b.doc.name}
            </p>
          )}
          {sides &&
            Array.from({ length: rows }, (_, i) => (
              <div
                key={i}
                className="compare__row"
                data-row={i}
                ref={(el) => (el ? rowRefs.current.set(i, el) : rowRefs.current.delete(i))}
              >
                <span className="label-small compare__pagenum">Page {i + 1}</span>
                {mode === "side" ? (
                  <div className="compare__pair">
                    <PagePane side="before" bytes={sides.a.pdf.bytes} page={sides.a.pdf.pages[i]} marks={marks.before.get(i)} cur={cur} onPick={setCur} />
                    <PagePane side="after" bytes={sides.b.pdf.bytes} page={sides.b.pdf.pages[i]} marks={marks.after.get(i)} cur={cur} onPick={setCur} />
                  </div>
                ) : (
                  <OverlayPane a={sides.a.pdf} b={sides.b.pdf} index={i} />
                )}
              </div>
            ))}
        </div>
      </div>

      {current && (
        <div className="compare__now">
          <ChangeText c={current} />
        </div>
      )}
    </div>
  );
}

interface Mark {
  box: Box;
  change: number;
  kind: "added" | "removed";
}

const KIND = { added: "Added", removed: "Removed", replaced: "Replaced" } as const;

function ChangeText({ c }: { c: Change }) {
  return (
    <span className="compare__text">
      <span className="label-medium compare__kind" data-kind={c.kind}>
        {KIND[c.kind]} · page {(c.kind === "removed" ? c.beforePage : c.afterPage) + 1}
      </span>
      {c.removed.length > 0 && (
        <del className="body-small compare__del">{quote(c.removed)}</del>
      )}
      {c.added.length > 0 && <ins className="body-small compare__ins">{quote(c.added)}</ins>}
    </span>
  );
}

function ChangeRow({ c, on, onPick, refFn }: { c: Change; on: boolean; onPick: () => void; refFn: (el: HTMLButtonElement | null) => void }) {
  return (
    <button type="button" ref={refFn} className={`compare__item${on ? " compare__item--on" : ""}`} aria-current={on || undefined} data-change={c.id} onClick={onPick}>
      <ChangeText c={c} />
    </button>
  );
}

/** A page's size as shown (turned by its own rotation), in PDF units. */
function shownSize(p: PageData): { w: number; h: number } {
  const turned = p.rotation % 180 !== 0;
  return turned ? { w: p.viewBox.height, h: p.viewBox.width } : { w: p.viewBox.width, h: p.viewBox.height };
}

/** A view-space box (PDF units, bottom-left origin) as shares of the page as
 * shown, top-left origin — turned with the page. */
function shareOf(p: PageData, b: Box): { left: number; top: number; width: number; height: number } {
  const W = p.viewBox.width;
  const H = p.viewBox.height;
  const { w, h } = shownSize(p);
  const pts: [number, number][] = [
    [b.x, H - b.y],
    [b.x + b.width, H - b.y],
    [b.x, H - b.y - b.height],
    [b.x + b.width, H - b.y - b.height],
  ].map(([x, y]) => {
    switch (p.rotation) {
      case 90:
        return [H - y, x];
      case 180:
        return [W - x, H - y];
      case 270:
        return [y, W - x];
      default:
        return [x, y];
    }
  });
  const xs = pts.map((q) => q[0]);
  const ys = pts.map((q) => q[1]);
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  return { left: x0 / w, top: y0 / h, width: (Math.max(...xs) - x0) / w, height: (Math.max(...ys) - y0) / h };
}

/** Draw a page while it's near the screen, and let go of the pixels once it
 * isn't — a long document's every page at full size would not fit in memory. */
function useNearScreen<T extends Element>(): [RefObject<T>, boolean] {
  const ref = useRef<T>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setNear(e.isIntersecting), { rootMargin: "800px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return [ref, near];
}

/** Render one page of `bytes` at a CSS width, into `canvas`. Resolves once
 * drawn; the returned cancel stops it part way. */
function drawPage(bytes: ArrayBuffer, index: number, cssWidth: number, canvas: HTMLCanvasElement) {
  let task: { cancel(): void; promise: Promise<void> } | null = null;
  let stopped = false;
  const done = (async () => {
    const doc = await getCachedDoc(bytes);
    if (stopped) return;
    const page = await doc.getPage(index + 1);
    if (stopped) return;
    const v1 = page.getViewport({ scale: 1 });
    const scale = (cssWidth * (window.devicePixelRatio || 1)) / v1.width;
    const viewport = page.getViewport({ scale });
    const off = document.createElement("canvas");
    off.width = Math.ceil(viewport.width);
    off.height = Math.ceil(viewport.height);
    const ctx = off.getContext("2d");
    if (!ctx) return;
    task = page.render({ canvasContext: ctx, viewport });
    try {
      await task.promise;
    } catch (err) {
      off.width = off.height = 0;
      if (!isRenderCancelled(err)) throw err;
      return;
    }
    if (stopped) {
      off.width = off.height = 0;
      return;
    }
    canvas.width = off.width;
    canvas.height = off.height;
    canvas.getContext("2d")?.drawImage(off, 0, 0);
    off.width = off.height = 0;
  })();
  return {
    done,
    cancel: () => {
      stopped = true;
      task?.cancel();
    },
  };
}

/** Render a page offscreen at an exact scale (PDF unit → px). */
async function pagePixels(bytes: ArrayBuffer, index: number, scale: number, signal: { stopped: boolean }) {
  const doc = await getCachedDoc(bytes);
  const page = await doc.getPage(index + 1);
  const viewport = page.getViewport({ scale });
  const c = document.createElement("canvas");
  c.width = Math.ceil(viewport.width);
  c.height = Math.ceil(viewport.height);
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx || signal.stopped) return null;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  return c;
}

function PagePane({
  side,
  bytes,
  page,
  marks,
  cur,
  onPick,
}: {
  side: "before" | "after";
  bytes: ArrayBuffer;
  page: PageData | undefined;
  marks: Mark[] | undefined;
  cur: number | null;
  onPick: (id: number) => void;
}) {
  const [ref, near] = useNearScreen<HTMLDivElement>();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [drawn, setDrawn] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    const box = ref.current;
    if (!page || !canvas || !box) return;
    if (!near) {
      canvas.width = canvas.height = 0;
      setDrawn(false);
      return;
    }
    const job = drawPage(bytes, page.pageIndex, box.clientWidth || 400, canvas);
    job.done.then(() => setDrawn(true), () => {});
    return () => job.cancel();
  }, [near, bytes, page, ref]);

  if (!page) {
    return (
      <div ref={ref} className="compare__page compare__page--none" data-side={side}>
        <span className="body-small">No page here</span>
      </div>
    );
  }
  const { w, h } = shownSize(page);
  return (
    <div ref={ref} className="compare__page" data-side={side} data-drawn={drawn || undefined} style={{ aspectRatio: `${w} / ${h}` }}>
      <canvas ref={canvasRef} className="compare__canvas" aria-hidden="true" />
      {marks?.map((m, k) => {
        const s = shareOf(page, m.box);
        return (
          <span
            key={k}
            className={`compare__mark compare__mark--${m.kind}${m.change === cur ? " compare__mark--on" : ""}`}
            data-change={m.change}
            style={{ left: `${s.left * 100}%`, top: `${s.top * 100}%`, width: `${s.width * 100}%`, height: `${s.height * 100}%` }}
            onClick={() => onPick(m.change)}
          />
        );
      })}
    </div>
  );
}

/** Both pages drawn at one scale and laid over each other: ink only Before has
 * in the "removed" colour, ink only After has in the "added" colour, ink both
 * have faint. A picture that moved shows as one of each. */
function OverlayPane({ a, b, index }: { a: LoadedPdf; b: LoadedPdf; index: number }) {
  const [ref, near] = useNearScreen<HTMLDivElement>();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pa = a.pages[index];
  const pb = b.pages[index];
  const sa = pa ? shownSize(pa) : null;
  const sb = pb ? shownSize(pb) : null;
  const w = Math.max(sa?.w ?? 0, sb?.w ?? 0);
  const h = Math.max(sa?.h ?? 0, sb?.h ?? 0);

  useEffect(() => {
    const canvas = canvasRef.current;
    const box = ref.current;
    if (!canvas || !box) return;
    if (!near) {
      canvas.width = canvas.height = 0;
      return;
    }
    const signal = { stopped: false };
    const scale = ((box.clientWidth || 400) * (window.devicePixelRatio || 1)) / w;
    void (async () => {
      const [ca, cb] = await Promise.all([
        pa ? pagePixels(a.bytes, index, scale, signal) : null,
        pb ? pagePixels(b.bytes, index, scale, signal) : null,
      ]);
      if (signal.stopped) return;
      const W = Math.ceil(w * scale);
      const H = Math.ceil(h * scale);
      const read = (c: HTMLCanvasElement | null) => {
        if (!c) return null;
        // Top-left aligned on a white sheet the size of the larger page.
        const t = document.createElement("canvas");
        t.width = W;
        t.height = H;
        const x = t.getContext("2d", { willReadFrequently: true })!;
        x.fillStyle = "#fff";
        x.fillRect(0, 0, W, H);
        x.drawImage(c, 0, 0);
        c.width = c.height = 0;
        const d = x.getImageData(0, 0, W, H).data;
        t.width = t.height = 0;
        return d;
      };
      const da = read(ca);
      const db = read(cb);
      const css = getComputedStyle(box);
      const removed = rgb(css.getPropertyValue("--diff-removed")) ?? [179, 38, 30];
      const added = rgb(css.getPropertyValue("--diff-added")) ?? [20, 108, 46];
      canvas.width = W;
      canvas.height = H;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const out = ctx.createImageData(W, H);
      const o = out.data;
      const lum = (d: Uint8ClampedArray | null, i: number) => (d ? (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000 : 255);
      for (let i = 0; i < o.length; i += 4) {
        const la = lum(da, i);
        const lb = lum(db, i);
        const inkA = la < 160;
        const inkB = lb < 160;
        let c: number[];
        if (inkA && !inkB) c = removed;
        else if (inkB && !inkA) c = added;
        else {
          // Both or neither: After, faint, so the eye goes to the colour.
          const g = 255 - (255 - Math.min(la, lb)) * 0.3;
          c = [g, g, g];
        }
        o[i] = c[0];
        o[i + 1] = c[1];
        o[i + 2] = c[2];
        o[i + 3] = 255;
      }
      ctx.putImageData(out, 0, 0);
    })().catch(() => {});
    return () => {
      signal.stopped = true;
    };
  }, [near, a, b, index, pa, pb, w, h, ref]);

  return (
    <div ref={ref} className="compare__page compare__page--overlay" style={{ aspectRatio: `${w} / ${h}` }}>
      <canvas ref={canvasRef} className="compare__canvas" aria-hidden="true" />
      {(!pa || !pb) && <span className="body-small compare__only">Only in {pa ? "Before" : "After"}</span>}
    </div>
  );
}

/** A CSS colour token's value as [r, g, b], from "#rrggbb". */
function rgb(v: string): number[] | null {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(v.trim());
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : null;
}
