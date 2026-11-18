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
export function cropFromMargins(page: PageData, m: Margins): CropRect | undefined {
  const s = sheetSize(page);
  const a = sheetToView(m.left, m.top, page);
  const b = sheetToView(s.width - m.right, s.height - m.bottom, page);
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return fitCrop({ x, y, width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) }, page.viewBox);
}

/** Keep margins to a page: none negative, and at least `MIN_CROP` left each way. */
function holdMargins(m: Margins, w: number, h: number, moved: keyof Margins | "all"): Margins {
  const out = { ...m };
  for (const k of ["top", "right", "bottom", "left"] as const) out[k] = Math.max(0, out[k]);
  const fix = (a: "left" | "top", b: "right" | "bottom", size: number) => {
    const room = size - Math.min(MIN_CROP, size);
    if (out[a] + out[b] <= room) return;
    if (moved === "all") {
      // A drag of the whole frame: keep its size, stop it at the edge.
      const over = out[a] + out[b] - room;
      if (out[a] >= over) out[a] -= over;
      else out[b] -= over;
    } else if (moved === a) out[a] = room - out[b];
    else if (moved === b) out[b] = room - out[a];
    else {
      out[a] = Math.min(out[a], room);
      out[b] = room - out[a];
    }
  };
  fix("left", "right", w);
  fix("top", "bottom", h);
  return out;
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

  // The page, rendered once at a size that stays sharp at the stage's scale.
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const ctrl = new AbortController();
    renderPageToCanvas(bytes, page.pageIndex, 1.5, ctrl.signal, page.rotation)
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
    return () => ctrl.abort();
  }, [bytes, page.pageIndex, page.rotation]);

  const set = (next: Margins, moved: keyof Margins | "all") => setM(holdMargins(next, sheet.width, sheet.height, moved));

  // Dragging a grip or the frame. Pointer moves are in screen pixels; margins
  // are in PDF units, so divide by the preview's scale.
  const drag = useRef<{ grip: Grip | "frame"; x: number; y: number; start: Margins } | null>(null);
  const begin = (grip: Grip | "frame") => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { grip, x: e.clientX, y: e.clientY, start: m };
  };
  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || !k) return;
    const dx = (e.clientX - d.x) / k;
    const dy = (e.clientY - d.y) / k;
    const s = d.start;
    if (d.grip === "frame") {
      set({ top: s.top + dy, bottom: s.bottom - dy, left: s.left + dx, right: s.right - dx }, "all");
      return;
    }
    const next = { ...s };
    let moved: keyof Margins = "top";
    if (d.grip.includes("n")) (next.top = s.top + dy), (moved = "top");
    if (d.grip.includes("s")) (next.bottom = s.bottom - dy), (moved = "bottom");
    if (d.grip.includes("w")) (next.left = s.left + dx), (moved = "left");
    if (d.grip.includes("e")) (next.right = s.right - dx), (moved = "right");
    // A corner moves two sides; hold each against its opposite.
    let held = holdMargins(next, sheet.width, sheet.height, moved);
    if (d.grip.length === 2) held = holdMargins(held, sheet.width, sheet.height, d.grip.includes("n") ? "top" : "bottom");
    setM(held);
  };
  const end = () => {
    drag.current = null;
  };

  // Arrow keys on a focused grip: a point at a time, ten with Shift.
  const nudge = (grip: Grip | "frame") => (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 10 : 1;
    const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
    const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
    if (!dx && !dy) return;
    e.preventDefault();
    if (grip === "frame") {
      set({ top: m.top + dy, bottom: m.bottom - dy, left: m.left + dx, right: m.right - dx }, "all");
      return;
    }
    const next = { ...m };
    let moved: keyof Margins = "top";
    if (dy && grip.includes("n")) (next.top += dy), (moved = "top");
    if (dy && grip.includes("s")) (next.bottom -= dy), (moved = "bottom");
    if (dx && grip.includes("w")) (next.left += dx), (moved = "left");
    if (dx && grip.includes("e")) (next.right -= dx), (moved = "right");
    set(next, moved);
  };

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
          value={Math.round(m[side] * MM * 10) / 10}
          aria-label={`${label} margin, millimetres`}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (e.target.value.trim() === "" || !Number.isFinite(v)) return;
            set({ ...m, [side]: v / MM }, side);
          }}
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
        <span className="title-large" id={`${id}-title`}>Crop page {position + 1}</span>
        <div className="crop__stage" ref={stage}>
          <div className="crop__page" style={{ width: sheet.width * k, height: sheet.height * k }}>
            <div ref={host} className="crop__host" />
            {failed && <span className="crop__err body-small">This page couldn't be shown.</span>}
            <div
              className="crop__frame"
              style={frame}
              role="group"
              aria-label="Crop frame"
              tabIndex={0}
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
          <button type="button" className="btn" disabled={keepsAll} onClick={() => setM(NONE)}>
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
