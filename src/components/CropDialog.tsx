import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useModal } from "../hooks/useModal";
import { renderPageToCanvas } from "../pdf/loader";
import { MIN_CROP, cropOffset, fitCrop, sheetSize, sheetToView, shownSize } from "../pdf/pagePlan";
import type { CropRect, PageData } from "../pdf/types";
import { Icon } from "./Icon";

/** Points to millimetres and back. */
const MM = 25.4 / 72;

/** Distances in from each side of the page as shown, in PDF units. */
export interface Margins {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** The preview's longest side, in canvas pixels, at most. */
const PREVIEW_PX = 1600;

const NONE: Margins = { top: 0, right: 0, bottom: 0, left: 0 };

/** A page's crop as margins from the sides it's shown with. */
export function marginsOf(page: PageData): Margins {
  if (!page.crop) return NONE;
  const s = sheetSize(page);
  const o = cropOffset(page);
  const c = shownSize(page);
  return { top: o.y, left: o.x, right: s.width - o.x - c.width, bottom: s.height - o.y - c.height };
}

/**
 * Margins from the sides a page is shown with, as that page's crop (view
 * space). The same margins suit pages of any size or turn, which is what
 * "All pages" applies. `undefined` keeps the whole page.
 */
export function cropFromMargins(page: PageData, margins: Margins): CropRect | undefined {
  const s = sheetSize(page);
  // Held against *this* page: "All pages" brings margins set on another.
  const m = holdMargins(margins, s.width, s.height);
  const a = sheetToView(m.left, m.top, page);
  const b = sheetToView(s.width - m.right, s.height - m.bottom, page);
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return fitCrop({ x, y, width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) }, page.viewBox);
}

type Axis = "start" | "end" | "both";

/**
 * Keep margins to a page: none negative, and at least `MIN_CROP` left each
 * way. `x` / `y` say what moved on each axis — its start side (left, top), its
 * end side (right, bottom), or both, a drag of the whole frame, which keeps
 * its size and stops at the edge. An axis that didn't move is only kept in.
 */
function holdMargins(m: Margins, w: number, h: number, x?: Axis, y?: Axis): Margins {
  const out = { ...m };
  const fix = (a: "left" | "top", b: "right" | "bottom", size: number, moved?: Axis) => {
    const room = size - Math.min(MIN_CROP, size);
    if (moved === "both") {
      // Slid past a side: give the overshoot back to the other, so the
      // frame's size holds.
      if (out[a] < 0) (out[b] += out[a]), (out[a] = 0);
      if (out[b] < 0) (out[a] += out[b]), (out[b] = 0);
    }
    out[a] = Math.max(0, out[a]);
    out[b] = Math.max(0, out[b]);
    if (out[a] + out[b] <= room) return;
    if (moved === "both") {
      const over = out[a] + out[b] - room;
      if (out[a] >= over) out[a] -= over;
      else out[b] -= over;
    } else if (moved === "start") out[a] = Math.min(room - out[b], room);
    else if (moved === "end") out[b] = Math.min(room - out[a], room);
    else {
      // Neither side moved — margins meant for a bigger page: shrink both
      // alike, so what's kept stays where it was meant to be.
      const k = room / (out[a] + out[b]);
      out[a] *= k;
      out[b] *= k;
    }
  };
  fix("left", "right", w, x);
  fix("top", "bottom", h, y);
  return out;
}

/** What a grip moves on each axis. */
function axes(grip: Grip | "frame"): { x?: Axis; y?: Axis } {
  if (grip === "frame") return { x: "both", y: "both" };
  return {
    x: grip.includes("w") ? "start" : grip.includes("e") ? "end" : undefined,
    y: grip.includes("n") ? "start" : grip.includes("s") ? "end" : undefined,
  };
}

/** Margins after moving a grip (or the frame) by dx, dy points. */
function shift(s: Margins, grip: Grip | "frame", dx: number, dy: number): Margins {
  const { x, y } = axes(grip);
  const next = { ...s };
  if (x === "both" || x === "start") next.left += dx;
  if (x === "both" || x === "end") next.right -= dx;
  if (y === "both" || y === "start") next.top += dy;
  if (y === "both" || y === "end") next.bottom -= dy;
  return next;
}

type Grip = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
const GRIPS: Grip[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const GRIP_LABEL: Record<Grip, string> = {
  n: "Top edge",
  s: "Bottom edge",
  e: "Right edge",
  w: "Left edge",
  ne: "Top-right corner",
  nw: "Top-left corner",
  se: "Bottom-right corner",
  sw: "Bottom-left corner",
};

interface Props {
  bytes: ArrayBuffer;
  /** The page being cropped, as shown (turned, with its current crop). */
  page: PageData;
  /** Its position in the document, 0-based, for the title. */
  position: number;
  /** Pages in the document. "All pages" is offered only when there's more than one. */
  count: number;
  /** Apply: this page's new crop, or margins for every page. */
  onCrop: (scope: "page" | "all", margins: Margins, fromMargins: typeof cropFromMargins) => void;
  onClose: () => void;
}

/**
 * Crop: drag the frame (or type the margins) to keep part of a page. The page
 * is shown as it is in the document — turned the same way — with what's cut
 * away dimmed, so the frame means the same sides the reader will see.
 */
export function CropDialog({ bytes, page, position, count, onCrop, onClose }: Props) {
  const ref = useModal<HTMLDivElement>(onClose);
  const id = useId();
  const sheet = sheetSize(page);
  const [m, setM] = useState<Margins>(() => marginsOf(page));
  const [scope, setScope] = useState<"page" | "all">("page");
  // The preview's scale: the page fitted to the stage.
  const stage = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const [k, setK] = useState(0);

  useLayoutEffect(() => {
    const el = stage.current;
    if (!el) return;
    // The stage's content box: its padding is the page's breathing room.
    const fit = () => {
      const cs = getComputedStyle(el);
      const w = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      const h = el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
      setK(Math.max(0, Math.min(w / sheet.width, h / sheet.height)));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [sheet.width, sheet.height]);

  // The page, rendered once at a size that stays sharp at the stage's scale —
  // and no bigger, however large the sheet (a poster would otherwise ask for
  // more pixels than a phone's canvas allows).
  const [failed, setFailed] = useState(false);
  const longest = Math.max(page.viewBox.width, page.viewBox.height);
  useEffect(() => {
    const ctrl = new AbortController();
    const el = host.current;
    renderPageToCanvas(bytes, page.pageIndex, Math.min(1.5, PREVIEW_PX / longest), ctrl.signal, page.rotation)
      .then((c) => {
        if (ctrl.signal.aborted || !host.current) {
          c.width = c.height = 0;
          return;
        }
        c.className = "crop__canvas";
        host.current.replaceChildren(c);
      })
      .catch((e) => {
        if (!ctrl.signal.aborted && (e as Error)?.name !== "AbortError") setFailed(true);
      });
    return () => {
      ctrl.abort();
      // Give the preview's pixels back now, not when the canvas is collected.
      for (const c of el?.querySelectorAll("canvas") ?? []) c.width = c.height = 0;
    };
  }, [bytes, page.pageIndex, page.rotation, longest]);

  const hold = (next: Margins, grip: Grip | "frame") => {
    const { x, y } = axes(grip);
    return holdMargins(next, sheet.width, sheet.height, x, y);
  };

  // Dragging a grip or the frame. Pointer moves are in screen pixels; margins
  // are in PDF units, so divide by the preview's scale.
  const drag = useRef<{ grip: Grip | "frame"; x: number; y: number; start: Margins } | null>(null);
  const begin = (grip: Grip | "frame") => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { grip, x: e.clientX, y: e.clientY, start: m };
    setDraft({});
  };
  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || !k) return;
    setM(hold(shift(d.start, d.grip, (e.clientX - d.x) / k, (e.clientY - d.y) / k), d.grip));
  };
  const end = () => {
    drag.current = null;
  };

  // Arrow keys on a focused grip: a point at a time, ten with Shift. A grip's
  // keys are its own — they don't also reach the frame around it.
  const nudge = (grip: Grip | "frame") => (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 10 : 1;
    const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
    const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
    if (!dx && !dy) return;
    e.preventDefault();
    e.stopPropagation();
    setDraft({});
    setM(hold(shift(m, grip, dx, dy), grip));
  };

  // What's typed in a field, while it's being typed: an empty or half-typed
  // number is kept as text, so it can be cleared and retyped.
  const [draft, setDraft] = useState<Partial<Record<keyof Margins, string>>>({});
  const sideGrip: Record<keyof Margins, Grip> = { top: "n", bottom: "s", left: "w", right: "e" };

  const field = (side: keyof Margins, label: string) => (
    <label className="crop__field">
      <span className="body-small">{label}</span>
      <span className="crop__input">
        <input
          className="sigtype__input"
          type="number"
          inputMode="decimal"
          min={0}
          step={1}
          value={draft[side] ?? Math.round(m[side] * MM * 10) / 10}
          aria-label={`${label} margin, millimetres`}
          onChange={(e) => {
            const text = e.target.value;
            setDraft((d) => ({ ...d, [side]: text }));
            const v = Number(text);
            if (text.trim() === "" || !Number.isFinite(v)) return;
            setM(hold({ ...m, [side]: v / MM }, sideGrip[side]));
          }}
          onBlur={() => setDraft((d) => {
            const { [side]: _gone, ...rest } = d;
            return rest;
          })}
        />
        <span className="body-small" aria-hidden="true">mm</span>
      </span>
    </label>
  );

  const keepsAll = m.top < 0.01 && m.right < 0.01 && m.bottom < 0.01 && m.left < 0.01;
  const frame = {
    left: m.left * k,
    top: m.top * k,
    width: (sheet.width - m.left - m.right) * k,
    height: (sheet.height - m.top - m.bottom) * k,
  };

  return (
    <div className="dialog-scrim" onPointerDown={onClose}>
      <div
        ref={ref}
        tabIndex={-1}
        className="dialog crop"
        onPointerDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-note`}
      >
        <h2 className="headline-small dialog__title" id={`${id}-title`}>Crop page {position + 1}</h2>
        <div className="crop__stage" ref={stage}>
          <div className="crop__page" style={{ width: sheet.width * k, height: sheet.height * k }}>
            <div ref={host} className="crop__host" />
            {failed && <span className="crop__err body-small">This page couldn't be shown.</span>}
            <div
              className="crop__frame"
              style={frame}
              role="group"
              aria-label="Crop frame"
              aria-describedby={`${id}-keys`}
              tabIndex={0}
              data-autofocus
              data-tip="Drag to move the frame"
              onPointerDown={begin("frame")}
              onPointerMove={move}
              onPointerUp={end}
              onPointerCancel={end}
              onKeyDown={nudge("frame")}
            >
              {GRIPS.map((g) => (
                <button
                  key={g}
                  type="button"
                  className={`crop__grip crop__grip--${g}`}
                  aria-label={GRIP_LABEL[g]}
                  aria-describedby={`${id}-keys`}
                  onPointerDown={begin(g)}
                  onPointerMove={move}
                  onPointerUp={end}
                  onPointerCancel={end}
                  onKeyDown={nudge(g)}
                />
              ))}
            </div>
          </div>
        </div>
        <span className="sr-only" id={`${id}-keys`}>
          Arrow keys move the frame, or a focused edge or corner; Shift moves ten points. Or type the margins below.
        </span>
        <div className="crop__fields" role="group" aria-label="Margins to cut">
          {field("top", "Top")}
          {field("bottom", "Bottom")}
          {field("left", "Left")}
          {field("right", "Right")}
        </div>
        {count > 1 && (
          <div className="crop__scope" role="radiogroup" aria-label="Pages to crop">
            <label className="split__row">
              <input type="radio" name={`${id}-scope`} checked={scope === "page"} onChange={() => setScope("page")} />
              <span className="body-medium">This page</span>
            </label>
            <label className="split__row">
              <input type="radio" name={`${id}-scope`} checked={scope === "all"} onChange={() => setScope("all")} />
              <span className="body-medium">All {count} pages, same margins</span>
            </label>
          </div>
        )}
        <p className="body-small crop__note" id={`${id}-note`}>
          Cropping hides the edges; what's under them stays in the file. To remove something, redact it.
        </p>
        <div className="dialog__actions">
          <button type="button" className="btn" disabled={keepsAll} onClick={() => (setM(NONE), setDraft({}))}>
            <Icon name="reset" size={16} />
            Whole page
          </button>
          <span className="dialog__spacer" />
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn--filled" onClick={() => onCrop(scope, m, cropFromMargins)}>
            <Icon name="crop" size={16} />
            {keepsAll ? (page.crop || scope === "all" ? "Uncrop" : "Done") : "Crop"}
          </button>
        </div>
      </div>
    </div>
  );
}
