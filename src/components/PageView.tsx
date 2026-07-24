import { useEffect, useRef, useState } from "react";
import { renderPage, isRenderCancelled } from "../pdf/loader";
import { isFragmentModified, resolveFragmentStyle } from "../pdf/style";
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
import { dragState } from "../hooks/useDrag";
import { useGuides } from "../hooks/useSnap";
import { annotationBox, intersects, linkBox, redactionBox, stampBox, textBoxBox, type Box } from "../pdf/bbox";
import type { LinkAnnot, PageNumberOptions, Stamp, WatermarkOptions } from "../pdf/types";
import type { FindMatch } from "../pdf/find";
import { LinkItem } from "./LinkItem";
import { FormFieldLayer } from "./FormFieldLayer";

/** Annotation spec minus the fields the App assigns (id, pageIndex). */
export type AnnotSpec = Omit<Annotation, "id" | "pageIndex">;

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

export function PageView(props: Props) {
  const {
    bytes, page, scale, tool, drawTool, drawStyle, edits, textBoxes, redactions,
    annotations, stamps, links, formValues, pageNumbers, watermark, multiIds, placing, findMatches, activeFindId, selection, autoFocusId, editingId, compact, onSelect, onEditText,
    onChangeFragmentText, onChangeTextBoxText, onChangeTextBox, onChangeRedaction, onChangeLink,
    onChangeNoteText, onMoveAnnotation, onChangeStamp, onDeleteStamp, onAddTextBox, onAddRedaction, onAddLink, onChangeFormValue, onMarquee, onAddAnnotation,
    onPlaceStamp,
  } = props;

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [painted, setPainted] = useState(false);
  const [g, setG] = useState<Gesture | null>(null);

  useEffect(() => {
    let cancelled = false;
    const canvas = canvasRef.current;
    if (!canvas) return;
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
  }, [bytes, page.pageIndex, scale]);

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

  const onMove = (ev: React.PointerEvent) => {
    if (!g) return;
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
    } else if (cur.mode === "line" || cur.mode === "arrow") {
      if (Math.hypot(w, h) < MIN_DRAG) return;
      const p0 = toPdf(cur.x0, cur.y0), p1 = toPdf(cur.x1, cur.y1);
      onAddAnnotation(page.pageIndex, { kind: cur.mode, x1: p0.x, y1: p0.y, x2: p1.x, y2: p1.y, color, strokeWidth: width } as AnnotSpec);
    } else if (cur.mode === "pen") {
      if (cur.pts.length < 2) return;
      onAddAnnotation(page.pageIndex, { kind: "pen", pts: cur.pts.map((p) => toPdf(p.x, p.y)), color, strokeWidth: width } as AnnotSpec);
    }
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
    <div className="page" data-page-index={page.pageIndex} style={{ width: W, height: Hpx }} aria-busy={!painted && !error}>
      <canvas ref={canvasRef} className="page__canvas" />
      {!painted && !error && <div className="page__skeleton" aria-hidden="true" />}
      {error ? (
        <div className="page__error">Failed to render page: {error}</div>
      ) : (
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

          {/* Resize/rotate chrome for a selected rect or highlight box. */}
          {tool === "select" &&
            selection?.kind === "annotation" &&
            (() => {
              const sel = nonNote.find((a) => a.id === selection.id);
              if (!sel || (sel.kind !== "rect" && sel.kind !== "highlight")) return null;
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
            const style = resolveFragmentStyle(fragment, edit?.style ?? {});
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
                modified={modified}
                selected={selected}
                interactive={tool === "select"}
                editing={!compact || editingId === fragment.id}
                autoFocus={autoFocusId === fragment.id}
                onSelect={(id) => onSelect({ kind: "fragment", id })}
                onEdit={(id) => onEditText({ kind: "fragment", id })}
                onChangeText={onChangeFragmentText}
              />
            );
          })}

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

          {/* Multi-selection highlights (marquee result). */}
          {multiIds.size > 0 &&
            [
              ...textBoxes.filter((b) => multiIds.has(b.id)).map((b) => ({ id: b.id, box: textBoxBox(b) })),
              ...redactions.filter((r) => multiIds.has(r.id)).map((r) => ({ id: r.id, box: redactionBox(r) })),
              ...annotations.filter((a) => multiIds.has(a.id)).map((a) => ({ id: a.id, box: annotationBox(a) })),
              ...stamps.filter((s) => multiIds.has(s.id)).map((s) => ({ id: s.id, box: stampBox(s) })),
              ...links.filter((l) => multiIds.has(l.id)).map((l) => ({ id: l.id, box: linkBox(l) })),
            ].map(({ id, box }) => (
              <div
                key={`multi-${id}`}
                className="multisel"
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
      {(g.mode === "line" || g.mode === "arrow") && (
        <line x1={g.x0} y1={g.y0} x2={g.x1} y2={g.y1} stroke={color} strokeWidth={sw} strokeLinecap="round" />
      )}
      {g.mode === "pen" && (
        <polyline points={g.pts.map((p) => `${p.x},${p.y}`).join(" ")} fill="none" stroke={color} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" />
      )}
    </svg>
  );
}
