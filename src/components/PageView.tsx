import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { renderPage, isRenderCancelled } from "../pdf/loader";
import { useRenderWindow } from "../hooks/useRenderWindow";
import { isFragmentModified, keepsSourceTypeface, resolveFragmentStyle } from "../pdf/style";
import { usePageFonts } from "../hooks/usePageFonts";
import { usePageColors } from "../hooks/usePageColors";
import { offerPageCanvas } from "../pdf/fragmentColors";
import { isBoxAnnotation } from "../pdf/types";
import { DEFAULT_MARK_SIZE, MARK_PATHS } from "../pdf/marks";
import type {
  Annotation,
  AnnotationTool,
  DrawStyle,
  Edits,
  PageData,
  Redaction,
  Selection,
  TextBox,
  Tool,
} from "../pdf/types";
import { EditableFragment } from "./EditableFragment";
import { TextBoxItem } from "./TextBoxItem";
import { RedactionItem } from "./RedactionItem";
import { AnnotationLayer } from "./AnnotationLayer";
import { NoteItem } from "./NoteItem";
import { StampItem } from "./StampItem";
import { AnnotationFrame } from "./AnnotationFrame";
import { dragState, startPointerDrag } from "../hooks/useDrag";
import { isMarkTool } from "./DrawToolbar";
import { useGuides } from "../hooks/useSnap";
import { annotationBox, intersects, linkBox, redactionBox, stampBox, textBoxBox, type Box } from "../pdf/bbox";
import type { LinkAnnot, PageNumberOptions, Stamp, WatermarkOptions } from "../pdf/types";
import type { FindMatch } from "../pdf/find";
import { LinkItem } from "./LinkItem";
import { FormFieldLayer } from "./FormFieldLayer";

/** Annotation spec minus the fields the App assigns (id, pageIndex). */
export type AnnotSpec = Omit<Annotation, "id" | "pageIndex">;

/** What a selection can point at — used to turn a multi-selection member back
 * into a single selection when its highlight is clicked rather than dragged. */
type SelKind = NonNullable<Selection>["kind"];

interface Props {
  bytes: ArrayBuffer;
  page: PageData;
  scale: number;
  tool: Tool;
  drawTool: AnnotationTool;
  drawStyle: DrawStyle;
  edits: Edits;
  textBoxes: TextBox[];
  redactions: Redaction[];
  annotations: Annotation[];
  stamps: Stamp[];
  links: LinkAnnot[];
  formValues: Record<string, string | boolean>;
  /** Document-wide finishing layers, previewed live (drawn for real at export). */
  pageNumbers: PageNumberOptions | null;
  watermark: WatermarkOptions | null;
  /** Ids currently in a multi-selection (highlighted, not individually chromed). */
  multiIds: Set<string>;
  placing: boolean;
  /** Search hits on this page (PDF units), and the id of the active one. */
  findMatches?: FindMatch[];
  activeFindId?: string | null;
  selection: Selection;
  autoFocusId: string | null;
  /** Id of the element currently in text-edit mode (mobile), or null. */
  editingId: string | null;
  /** Compact (phone) layout — gates mobile-only edit behaviour. */
  compact: boolean;
  onSelect: (selection: Selection) => void;
  /** Enter text-edit mode for a text element (double-tap on touch). */
  onEditText: (selection: NonNullable<Selection>) => void;
  /** Commit and exit the current mobile text-edit (the on-canvas "done" tick). */
  onFinishEdit: () => void;
  onChangeFragmentText: (id: string, text: string) => void;
  onChangeTextBoxText: (id: string, text: string) => void;
  onChangeTextBox: (id: string, patch: Partial<TextBox>, key: string) => void;
  onChangeRedaction: (id: string, patch: Partial<Redaction>, key: string) => void;
  onChangeLink: (id: string, patch: Partial<LinkAnnot>, key: string) => void;
  onChangeNoteText: (id: string, text: string) => void;
  onMoveAnnotation: (annot: Annotation, key: string) => void;
  onChangeStamp: (id: string, patch: Partial<Stamp>, key: string) => void;
  onDeleteStamp: (id: string) => void;
  onAddTextBox: (pageIndex: number, x: number, y: number) => void;
  onAddRedaction: (pageIndex: number, x: number, y: number, width: number, height: number, cover?: boolean) => void;
  onAddLink: (pageIndex: number, x: number, y: number, width: number, height: number) => void;
  onChangeFormValue: (name: string, value: string | boolean) => void;
  /** Report the ids enclosed by a marquee drag on this page. */
  onMarquee: (ids: string[], additive: boolean) => void;
  /** Shift every object in the multi-selection by (dx, dy) in PDF units. The
   * key coalesces a whole drag into one undo step. */
  onMoveMulti: (dx: number, dy: number, key: string) => void;
  onAddAnnotation: (pageIndex: number, spec: AnnotSpec) => void;
  onPlaceStamp: (pageIndex: number, xLeft: number, yTop: number) => void;
}

const MIN_DRAG = 6;

interface Gesture {
  mode: "redact" | "whiteout" | "link" | "marquee" | AnnotationTool;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  pts: { x: number; y: number }[];
}

export const PageView = memo(PageViewInner);

function PageViewInner(props: Props) {
  const {
    bytes, page, scale, tool, drawTool, drawStyle, edits, textBoxes, redactions,
    annotations, stamps, links, formValues, pageNumbers, watermark, multiIds, placing, findMatches, activeFindId, selection, autoFocusId, editingId, compact, onSelect, onEditText, onFinishEdit,
    onChangeFragmentText, onChangeTextBoxText, onChangeTextBox, onChangeRedaction, onChangeLink,
    onChangeNoteText, onMoveAnnotation, onChangeStamp, onDeleteStamp, onAddTextBox, onAddRedaction, onAddLink, onChangeFormValue, onMarquee, onMoveMulti, onAddAnnotation,
    onPlaceStamp,
  } = props;

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [painted, setPainted] = useState(false);
  const [g, setG] = useState<Gesture | null>(null);
  // Where a mark would land if you tapped now. A tick is the one tool here
  // placed by a tap rather than a drag, so nothing on the page showed its size
  // or position until it already existed; this shows both before you commit.
  // Hover only — a finger has no hover, and the drawbar's hint carries it there.
  const [ghost, setGhost] = useState<{ x: number; y: number } | null>(null);
  const groupGesture = useRef(0);
  // Only pages within a band around the viewport are rasterised and get their
  // overlay mounted; the wrapper below always keeps its full size so scroll
  // position, page anchors, and the scrollbar are unaffected.
  const { ref: frameRef, near } = useRenderWindow<HTMLDivElement>();

  useEffect(() => {
    let cancelled = false;
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (!near) {
      // Scrolled well away: hand the canvas' backing store back to the browser.
      // Leaving it allocated is what made memory grow with document length —
      // a full-page raster is several megabytes, times every page ever visited.
      canvas.width = 0;
      canvas.height = 0;
      setPainted(false);
      return;
    }
    let handle: ReturnType<typeof renderPage> | null = null;
    const timer = setTimeout(() => {
      if (cancelled) return;
      handle = renderPage(bytes, page.pageIndex, canvas, scale);
      handle.promise
        .then(() => {
          if (!cancelled) {
            setPainted(true);
            setError(null);
          }
        })
        .catch((err) => {
          // Cancellation is expected when inputs change mid-render (e.g. merge);
          // it's not a failure to surface.
          if (!cancelled && !isRenderCancelled(err)) setError(String(err));
        });
    }, 90);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      // Tear down the in-flight pdf.js render so the next effect run can reuse
      // this canvas without colliding with a live render() operation.
      handle?.cancel();
    };
  }, [bytes, page.pageIndex, scale, near]);

  // The document's own fonts, readable only after the page has painted. Until
  // then fragments fall back to pdf.js's generic family — the overlay for an
  // unedited fragment is transparent anyway, so nothing visibly changes when
  // this lands.
  const pageFonts = usePageFonts(bytes, page.pageIndex, painted);
  // What each fragment sits on and is drawn in, once the page has been sampled.
  const pageColors = usePageColors(bytes, page.pageIndex);

  // Only a *shown* fragment (selected or edited) needs those colours, and
  // sampling costs a full-page `getImageData` — 18ms on a 1.1M px canvas, 63ms
  // on a 4.6M px one. Doing it as each page painted spent that on every page
  // scrolled past, for a case most of them never reach; doing it here spends it
  // once, on the page being edited. In a layout effect so it lands before the
  // frame that first paints the overlay, rather than a frame of white-and-black
  // followed by a correction.
  const anyShown = page.fragments.some(
    (f) =>
      isFragmentModified(f, edits[f.id]) ||
      (selection?.kind === "fragment" && selection.id === f.id),
  );
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (anyShown && painted && canvas) offerPageCanvas(bytes, page, canvas);
  }, [anyShown, painted, bytes, page]);

  const W = page.viewBox.width * scale;
  const Hpx = page.viewBox.height * scale;
  const H = page.viewBox.height;
  const Wpdf = page.viewBox.width;
  const guides = useGuides();

  const local = (cx: number, cy: number) => {
    const r = overlayRef.current!.getBoundingClientRect();
    return { x: cx - r.left, y: cy - r.top };
  };

  const onDown = (ev: React.PointerEvent) => {
    if (ev.target !== overlayRef.current) return;
    const { x, y } = local(ev.clientX, ev.clientY);

    if (placing) {
      ev.preventDefault();
      onPlaceStamp(page.pageIndex, x / scale, H - y / scale);
      return;
    }
    if (tool === "select") {
      onSelect(null);
      // Mouse: rubber-band select. Touch keeps deselect + page-pan behaviour.
      if (ev.pointerType === "mouse") {
        ev.preventDefault();
        (ev.target as HTMLElement).setPointerCapture(ev.pointerId);
        dragState.active = true;
        setG({ mode: "marquee", x0: x, y0: y, x1: x, y1: y, pts: [] });
      }
      return;
    }
    if (tool === "text") {
      ev.preventDefault();
      onAddTextBox(page.pageIndex, x / scale, H - y / scale - 16);
      return;
    }
    if (tool === "draw" && drawTool === "note") {
      ev.preventDefault();
      onAddAnnotation(page.pageIndex, { kind: "note", x: x / scale, y: H - y / scale, text: "", color: drawStyle.color } as AnnotSpec);
      return;
    }
    // Gesture-based: redact, highlight, rect, line, arrow, pen
    ev.preventDefault();
    ev.stopPropagation();
    (ev.target as HTMLElement).setPointerCapture(ev.pointerId);
    dragState.active = true;
    const mode =
      tool === "redact" ? "redact" : tool === "whiteout" ? "whiteout" : tool === "link" ? "link" : drawTool;
    setG({ mode, x0: x, y0: y, x1: x, y1: y, pts: [{ x, y }] });
  };

  const markTool = tool === "draw" && isMarkTool(drawTool) && !placing;

  const onMove = (ev: React.PointerEvent) => {
    if (!g) {
      if (markTool && ev.pointerType !== "touch") {
        const { x, y } = local(ev.clientX, ev.clientY);
        setGhost({ x, y });
      }
      return;
    }
    const { x, y } = local(ev.clientX, ev.clientY);
    setG({ ...g, x1: x, y1: y, pts: g.mode === "pen" ? [...g.pts, { x, y }] : g.pts });
  };

  const onUp = () => {
    dragState.active = false;
    if (!g) return;
    const cur = g;
    setG(null);
    const toPdf = (px: number, py: number) => ({ x: px / scale, y: H - py / scale });
    const left = Math.min(cur.x0, cur.x1), top = Math.min(cur.y0, cur.y1);
    const w = Math.abs(cur.x1 - cur.x0), h = Math.abs(cur.y1 - cur.y0);
    const { color, width } = drawStyle;

    if (cur.mode === "marquee") {
      if (w < MIN_DRAG && h < MIN_DRAG) return;
      const rect: Box = {
        l: left / scale,
        r: (left + w) / scale,
        b: H - (top + h) / scale,
        t: H - top / scale,
      };
      const ids: string[] = [];
      for (const b of textBoxes) if (intersects(rect, textBoxBox(b))) ids.push(b.id);
      for (const r of redactions) if (intersects(rect, redactionBox(r))) ids.push(r.id);
      for (const a of annotations) if (intersects(rect, annotationBox(a))) ids.push(a.id);
      for (const s of stamps) if (intersects(rect, stampBox(s))) ids.push(s.id);
      for (const l of links) if (intersects(rect, linkBox(l))) ids.push(l.id);
      onMarquee(ids, false);
      return;
    }
    if (cur.mode === "redact" || cur.mode === "whiteout") {
      if (w < MIN_DRAG || h < MIN_DRAG) return;
      onAddRedaction(page.pageIndex, left / scale, H - (top + h) / scale, w / scale, h / scale, cur.mode === "whiteout");
    } else if (cur.mode === "link") {
      if (w < MIN_DRAG || h < MIN_DRAG) return;
      onAddLink(page.pageIndex, left / scale, H - (top + h) / scale, w / scale, h / scale);
    } else if (cur.mode === "highlight" || cur.mode === "rect") {
      if (w < MIN_DRAG || h < MIN_DRAG) return;
      const base = { x: left / scale, y: H - (top + h) / scale, width: w / scale, height: h / scale, color };
      onAddAnnotation(
        page.pageIndex,
        (cur.mode === "highlight" ? { kind: "highlight", ...base } : { kind: "rect", ...base, strokeWidth: width }) as AnnotSpec,
      );
    } else if (cur.mode === "check" || cur.mode === "cross") {
      // A click drops one mark; a drag sizes it. Requiring a drag would make
      // filling a thirty-field form thirty drags, and a checkbox is smaller
      // than MIN_DRAG anyway — the gesture that fits the task is the tap.
      const drag = w >= MIN_DRAG && h >= MIN_DRAG;
      const centre = toPdf(cur.x0, cur.y0);
      const box = drag
        ? { x: left / scale, y: H - (top + h) / scale, width: w / scale, height: h / scale }
        : {
            x: centre.x - DEFAULT_MARK_SIZE / 2,
            y: centre.y - DEFAULT_MARK_SIZE / 2,
            width: DEFAULT_MARK_SIZE,
            height: DEFAULT_MARK_SIZE,
          };
      onAddAnnotation(page.pageIndex, { kind: cur.mode, ...box, color, strokeWidth: width } as AnnotSpec);
    } else if (cur.mode === "line" || cur.mode === "arrow") {
      if (Math.hypot(w, h) < MIN_DRAG) return;
      const p0 = toPdf(cur.x0, cur.y0), p1 = toPdf(cur.x1, cur.y1);
      onAddAnnotation(page.pageIndex, { kind: cur.mode, x1: p0.x, y1: p0.y, x2: p1.x, y2: p1.y, color, strokeWidth: width } as AnnotSpec);
    } else if (cur.mode === "pen") {
      if (cur.pts.length < 2) return;
      onAddAnnotation(page.pageIndex, { kind: "pen", pts: cur.pts.map((p) => toPdf(p.x, p.y)), color, strokeWidth: width } as AnnotSpec);
    }
  };

  // A ghost outlives its reason otherwise: switch tools with the pointer parked
  // over a page and it would sit there until the next move event.
  useEffect(() => {
    if (!markTool) setGhost(null);
  }, [markTool]);

  /** Drag every object in the multi-selection together. The highlights render
   * above the objects, so this catches a drag that starts on any member — and
   * `startPointerDrag` reports the delta from the start, which has to be fed in
   * as increments because each commit applies to the state it finds. */
  const beginGroupDrag = (ev: React.PointerEvent, id: string, kind: SelKind) => {
    const key = `move-multi-${++groupGesture.current}`;
    let lastX = 0;
    let lastY = 0;
    let moved = false;
    startPointerDrag(ev, {
      onMove: (dx, dy) => {
        if (Math.hypot(dx, dy) > 3) moved = true;
        onMoveMulti((dx - lastX) / scale, -(dy - lastY) / scale, key);
        lastX = dx;
        lastY = dy;
      },
      // A press that didn't travel is a click on the object underneath, which
      // in a group means "just this one" — the highlight must not swallow it.
      onEnd: () => {
        if (!moved) onSelect({ kind, id } as NonNullable<Selection>);
      },
    });
  };

  const cursor = placing
    ? "copy"
    : tool === "text"
      ? "text"
      : tool === "redact" || tool === "whiteout" || tool === "link" || tool === "draw"
        ? "crosshair"
        : "default";
  const nonNote = annotations.filter((a) => a.kind !== "note");
  const notes = annotations.filter((a) => a.kind === "note") as Extract<Annotation, { kind: "note" }>[];

  return (
    <div
      ref={frameRef}
      className="page"
      data-page-index={page.pageIndex}
      style={{ width: W, height: Hpx }}
      aria-busy={!painted && !error}
    >
      <canvas ref={canvasRef} className="page__canvas" />
      {!painted && !error && <div className="page__skeleton" aria-hidden="true" />}
      {error ? (
        <div className="page__error">Failed to render page: {error}</div>
      ) : !near ? null : (
        <div
          ref={overlayRef}
          className="page__overlay"
          style={{ cursor, touchAction: tool === "select" ? undefined : "none" }}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={() => {
            dragState.active = false;
            setG(null);
          }}
          onPointerLeave={() => setGhost(null)}
        >
          {findMatches && findMatches.length > 0 && (
            <div className="findlayer" aria-hidden="true">
              {findMatches.map((m) => (
                <span
                  key={m.id}
                  className={`findhit${m.id === activeFindId ? " findhit--active" : ""}`}
                  style={{
                    left: m.x * scale,
                    top: (H - (m.y + m.height)) * scale,
                    width: m.width * scale,
                    height: m.height * scale,
                  }}
                />
              ))}
            </div>
          )}

          {/* Live preview of the document-wide finishing layers. Purely
              informational — the real thing is drawn by the exporter. */}
          <FinishPreview
            pageNumbers={pageNumbers}
            watermark={watermark}
            pageNumber={(pageNumbers?.start ?? 1) + page.pageIndex}
            scale={scale}
          />

          <AnnotationLayer
            annotations={nonNote}
            scale={scale}
            pageHeight={H}
            selectedId={selection?.kind === "annotation" ? selection.id : null}
            interactive={tool === "select"}
            onSelect={(id) => onSelect({ kind: "annotation", id })}
            onMove={onMoveAnnotation}
          />

          {/* Resize/rotate chrome for a selected box annotation. */}
          {tool === "select" &&
            selection?.kind === "annotation" &&
            (() => {
              const sel = nonNote.find((a) => a.id === selection.id);
              if (!sel || !isBoxAnnotation(sel)) return null;
              return (
                <AnnotationFrame
                  annot={sel}
                  scale={scale}
                  pageHeight={H}
                  onMove={onMoveAnnotation}
                />
              );
            })()}

          {page.fragments.map((fragment) => {
            const edit = edits[fragment.id];
            const value = edit?.text ?? fragment.original;
            const source = pageFonts.get(fragment.itemIndex) ?? null;
            const colors = pageColors.get(fragment.itemIndex);
            const style = resolveFragmentStyle(fragment, edit?.style ?? {}, source, colors?.ink);
            const modified = isFragmentModified(fragment, edit);
            const selected = selection?.kind === "fragment" && selection.id === fragment.id;
            return (
              <EditableFragment
                key={fragment.id}
                fragment={fragment}
                scale={scale}
                pageHeight={H}
                value={value}
                style={style}
                // Only preview the document's face while the edit keeps it —
                // the same test the exporter uses to decide whether to
                // re-embed it.
                face={keepsSourceTypeface(edit?.style ?? {}) ? source : null}
                backdrop={colors?.fill}
                modified={modified}
                selected={selected}
                interactive={tool === "select"}
                editing={!compact || editingId === fragment.id}
                autoFocus={autoFocusId === fragment.id}
                onSelect={(id) => onSelect({ kind: "fragment", id })}
                onEdit={(id) => onEditText({ kind: "fragment", id })}
                onDone={compact && editingId === fragment.id ? onFinishEdit : undefined}
                onChangeText={onChangeFragmentText}
              />
            );
          })}

          {/* Stroke-shaped hit targets, above the editable text — see
              `AnnotationLayer`'s `variant`. Nothing here paints, so stacking
              order is entirely decided by the layer above. */}
          <AnnotationLayer
            variant="hits"
            annotations={nonNote}
            scale={scale}
            pageHeight={H}
            selectedId={selection?.kind === "annotation" ? selection.id : null}
            interactive={tool === "select"}
            onSelect={(id) => onSelect({ kind: "annotation", id })}
            onMove={onMoveAnnotation}
          />

          {notes.map((n) => (
            <NoteItem
              key={n.id}
              id={n.id}
              x={n.x}
              y={n.y}
              text={n.text}
              color={n.color}
              scale={scale}
              pageHeight={H}
              selected={selection?.kind === "annotation" && selection.id === n.id}
              interactive={tool === "select"}
              editing={!compact || editingId === n.id}
              autoFocus={autoFocusId === n.id}
              onSelect={(id) => onSelect({ kind: "annotation", id })}
              onEdit={(id) => onEditText({ kind: "annotation", id })}
              onDone={compact && editingId === n.id ? onFinishEdit : undefined}
              onChangeText={onChangeNoteText}
            />
          ))}

          {textBoxes.map((box) => (
            <TextBoxItem
              key={box.id}
              box={box}
              scale={scale}
              pageHeight={H}
              pageWidth={Wpdf}
              selected={selection?.kind === "textbox" && selection.id === box.id}
              interactive={tool === "select"}
              editing={!compact || editingId === box.id}
              autoFocus={autoFocusId === box.id}
              onSelect={(id) => onSelect({ kind: "textbox", id })}
              onEdit={(id) => onEditText({ kind: "textbox", id })}
              onDone={compact && editingId === box.id ? onFinishEdit : undefined}
              onChangeText={onChangeTextBoxText}
              onChange={onChangeTextBox}
            />
          ))}

          {redactions.map((r) => (
            <RedactionItem
              key={r.id}
              redaction={r}
              scale={scale}
              pageHeight={H}
              pageWidth={Wpdf}
              selected={selection?.kind === "redaction" && selection.id === r.id}
              interactive={tool === "select"}
              onSelect={(id) => onSelect({ kind: "redaction", id })}
              onChange={onChangeRedaction}
            />
          ))}

          {stamps.map((s) => (
            <StampItem
              key={s.id}
              stamp={s}
              scale={scale}
              pageHeight={H}
              pageWidth={Wpdf}
              selected={selection?.kind === "stamp" && selection.id === s.id}
              interactive={tool === "select"}
              onSelect={(id) => onSelect({ kind: "stamp", id })}
              onChange={onChangeStamp}
              onDelete={onDeleteStamp}
            />
          ))}

          {links.map((l) => (
            <LinkItem
              key={l.id}
              link={l}
              scale={scale}
              pageHeight={H}
              pageWidth={Wpdf}
              selected={selection?.kind === "link" && selection.id === l.id}
              interactive={tool === "select"}
              onSelect={(id) => onSelect({ kind: "link", id })}
              onChange={onChangeLink}
            />
          ))}

          <FormFieldLayer
            fields={page.fields}
            scale={scale}
            pageHeight={H}
            values={formValues}
            active={tool === "select" && !placing}
            onChange={onChangeFormValue}
          />

          {/* Multi-selection highlights (marquee result) — and the group's drag
              surface. They sit above the objects they outline, so a drag that
              starts on any member is a drag of the whole group; align and
              distribute were the only things a group could do before, and
              "move these five together" is the obvious one. */}
          {multiIds.size > 0 &&
            [
              ...textBoxes.filter((b) => multiIds.has(b.id)).map((b) => ({ id: b.id, kind: "textbox" as SelKind, box: textBoxBox(b) })),
              ...redactions.filter((r) => multiIds.has(r.id)).map((r) => ({ id: r.id, kind: "redaction" as SelKind, box: redactionBox(r) })),
              ...annotations.filter((a) => multiIds.has(a.id)).map((a) => ({ id: a.id, kind: "annotation" as SelKind, box: annotationBox(a) })),
              ...stamps.filter((s) => multiIds.has(s.id)).map((s) => ({ id: s.id, kind: "stamp" as SelKind, box: stampBox(s) })),
              ...links.filter((l) => multiIds.has(l.id)).map((l) => ({ id: l.id, kind: "link" as SelKind, box: linkBox(l) })),
            ].map(({ id, kind, box }) => (
              <div
                key={`multi-${id}`}
                className="multisel"
                onPointerDown={(ev) => beginGroupDrag(ev, id, kind)}
                style={{
                  left: box.l * scale,
                  top: (H - box.t) * scale,
                  width: Math.max(4, (box.r - box.l) * scale),
                  height: Math.max(4, (box.t - box.b) * scale),
                }}
              />
            ))}

          {/* Snap guide lines (shown while dragging an element near a page
              edge or centre line). */}
          {guides.gx != null && (
            <div className="snapguide snapguide--v" style={{ left: guides.gx * scale }} />
          )}
          {guides.gy != null && (
            <div className="snapguide snapguide--h" style={{ top: (H - guides.gy) * scale }} />
          )}

          {/* Live draw preview */}
          {g && <DrawPreview g={g} color={drawStyle.color} width={drawStyle.width} scale={scale} />}

          {/* Where a tap would drop a mark, at the size it would be. */}
          {markTool && ghost && !g && (
            <MarkGhost
              kind={drawTool === "cross" ? "cross" : "check"}
              x={ghost.x}
              y={ghost.y}
              size={DEFAULT_MARK_SIZE * scale}
              color={drawStyle.color}
              width={drawStyle.width * scale}
            />
          )}
        </div>
      )}
    </div>
  );
}

/** Non-interactive on-canvas preview of page numbers + watermark. Positions
 * mirror the exporter (28pt margins, centred watermark). Screen y is down, so
 * the watermark rotates by the negated PDF angle. */
function FinishPreview({
  pageNumbers,
  watermark,
  pageNumber,
  scale,
}: {
  pageNumbers: PageNumberOptions | null;
  watermark: WatermarkOptions | null;
  pageNumber: number;
  scale: number;
}) {
  if (!pageNumbers && !(watermark && watermark.text.trim())) return null;
  const m = 28 * scale;
  const numStyle: React.CSSProperties = { position: "absolute", lineHeight: 1 };
  if (pageNumbers) {
    if (pageNumbers.position.startsWith("top")) numStyle.top = m;
    else numStyle.bottom = m;
    if (pageNumbers.position.endsWith("left")) numStyle.left = m;
    else if (pageNumbers.position.endsWith("right")) numStyle.right = m;
    else {
      numStyle.left = 0;
      numStyle.right = 0;
      numStyle.textAlign = "center";
    }
  }
  return (
    <div className="finishlayer" aria-hidden="true">
      {watermark && watermark.text.trim() && (
        <span
          className="finishlayer__wm"
          style={{
            color: watermark.color,
            opacity: watermark.opacity,
            fontSize: watermark.size * scale,
            transform: `translate(-50%, -50%) rotate(${-watermark.angle}deg)`,
          }}
        >
          {watermark.text}
        </span>
      )}
      {pageNumbers && (
        <span className="finishlayer__num" style={{ ...numStyle, color: pageNumbers.color, fontSize: pageNumbers.size * scale }}>
          {pageNumber}
        </span>
      )}
    </div>
  );
}

/**
 * The mark a tap would place: same glyph, same default size, at the cursor.
 *
 * Drawn from `MARK_PATHS` like the drag preview, the SVG overlay, the pdf-lib
 * export and the redaction raster — one definition of the glyph, five call
 * sites mapping it into their own space. A hand-drawn tick here would be a
 * preview that lies about the mark you get.
 */
function MarkGhost({
  kind,
  x,
  y,
  size,
  color,
  width,
}: {
  kind: "check" | "cross";
  x: number;
  y: number;
  size: number;
  color: string;
  width: number;
}) {
  const left = x - size / 2;
  const top = y - size / 2;
  return (
    // Deliberately not `annot-svg`: that class means "the annotation layer", and
    // the specs count its shapes. A preview that answered those counts would
    // make every mark assertion off by the ghost.
    <svg className="markghost" width="100%" height="100%" aria-hidden="true">
      <rect x={left} y={top} width={size} height={size} className="markghost__box" />
      {MARK_PATHS[kind].map((line, i) => (
        <polyline
          key={i}
          points={line.map(([ux, uy]) => `${left + ux * size},${top + (1 - uy) * size}`).join(" ")}
          fill="none"
          stroke={color}
          strokeWidth={Math.max(width, size * 0.12)}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
    </svg>
  );
}

function DrawPreview({ g, color, width, scale }: { g: Gesture; color: string; width: number; scale: number }) {
  const left = Math.min(g.x0, g.x1), top = Math.min(g.y0, g.y1);
  const w = Math.abs(g.x1 - g.x0), h = Math.abs(g.y1 - g.y0);
  if (g.mode === "redact") {
    return <div className="redaction redaction--preview" style={{ left, top, width: w, height: h }} />;
  }
  if (g.mode === "whiteout") {
    return <div className="whiteout whiteout--preview" style={{ left, top, width: w, height: h }} />;
  }
  if (g.mode === "link") {
    return <div className="linkbox linkbox--preview" style={{ left, top, width: w, height: h }} />;
  }
  if (g.mode === "marquee") {
    return <div className="marquee" style={{ left, top, width: w, height: h }} />;
  }
  const sw = width * scale;
  return (
    <svg className="annot-svg" width="100%" height="100%" style={{ pointerEvents: "none" }}>
      {g.mode === "highlight" && <rect x={left} y={top} width={w} height={h} fill={color} opacity={0.4} />}
      {g.mode === "rect" && <rect x={left} y={top} width={w} height={h} fill="none" stroke={color} strokeWidth={sw} />}
      {(g.mode === "check" || g.mode === "cross") &&
        MARK_PATHS[g.mode].map((line, i) => (
          <polyline
            key={i}
            points={line.map(([ux, uy]) => `${left + ux * w},${top + (1 - uy) * h}`).join(" ")}
            fill="none"
            stroke={color}
            strokeWidth={Math.max(sw, Math.min(w, h) * 0.12)}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}
      {(g.mode === "line" || g.mode === "arrow") && (
        <line x1={g.x0} y1={g.y0} x2={g.x1} y2={g.y1} stroke={color} strokeWidth={sw} strokeLinecap="round" />
      )}
      {g.mode === "pen" && (
        <polyline points={g.pts.map((p) => `${p.x},${p.y}`).join(" ")} fill="none" stroke={color} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" />
      )}
    </svg>
  );
}
