import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { acquireEscapeLayer } from "../hooks/useModal";
import { placeAnchored, type AnchorRect } from "../floating";

interface Props {
  value: string;
  onChange: (color: string) => void;
  /** Compact circular swatch (toolbar). */
  small?: boolean;
}

const PRESETS = [
  "#000000", "#5f6368", "#9aa0a6", "#ffffff",
  "#d93025", "#e8710a", "#f4c400", "#188038",
  "#12a4a4", "#1a73e8", "#4f378b", "#c026d3",
];

const isHex = (s: string) => /^#[0-9a-fA-F]{6}$/.test(s);
/** Width the popover is laid out at; the height is measured, not assumed. */
const POP_W = 196;

/** A custom colour control: a swatch that opens a preset palette + hex input
 * in a fixed-position popover (avoids the native OS colour picker and any
 * clipping by scrolling parents). */
export function ColorField({ value, onChange, small }: Props) {
  const [open, setOpen] = useState(false);
  /** The swatch's rect, captured when the popover opens. */
  const [anchor, setAnchor] = useState<AnchorRect | null>(null);
  /** The toolbar the swatch sits in, which the popover must not cover. */
  const [clear, setClear] = useState<AnchorRect | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [hex, setHex] = useState(value);
  const swatchRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  useEffect(() => setHex(value), [value]);

  /** The rect of the toolbar this swatch lives in, if any — the popover has to
   * clear the whole bar, not just the swatch inside it.
   *
   * A *toolbar* only. Clearing a container taller than the popover moves it far
   * from the swatch that opened it rather than off it: with `.panel` in this
   * list, a swatch at y=723 in the phone's properties sheet threw the palette to
   * y=205, most of a screen away from the control it belongs to. */
  const barRect = (): AnchorRect | null => {
    const bar = swatchRef.current?.closest('[role="toolbar"], .drawbar');
    if (!bar) return null;
    const r = bar.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
  };

  const openPop = () => {
    const r = swatchRef.current!.getBoundingClientRect();
    const a = { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    setAnchor(a);
    setClear(barRect());
    // A first guess from the width alone (the height isn't known until it's in
    // the document); corrected below, before paint.
    setPos(placeAnchored(a, POP_W, 0, { clear: barRect() }));
    setOpen(true);
  };

  // Position against the *measured* popover. The height used to be a hardcoded
  // 200 with no flip, which put the palette on top of the draw toolbar the
  // swatch lives in and the tool dock below it — see `placeAnchored`. Measured
  // after layout and before paint, so the correction never shows.
  useLayoutEffect(() => {
    if (!open || !anchor || !popRef.current) return;
    const el = popRef.current;
    const next = placeAnchored(anchor, el.offsetWidth, el.offsetHeight, { clear });
    setPos((prev) => (prev && prev.left === next.left && prev.top === next.top ? prev : next));
  }, [open, anchor, clear]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!swatchRef.current?.contains(t) && !popRef.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
        swatchRef.current?.focus();
      }
    };
    const releaseEscape = acquireEscapeLayer();
    document.addEventListener("pointerdown", onDoc);
    document.addEventListener("keydown", onKey, true);
    return () => {
      releaseEscape();
      document.removeEventListener("pointerdown", onDoc);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  return (
    <>
      <button
        ref={swatchRef}
        type="button"
        className={`colorfield__swatch${small ? " colorfield__swatch--sm" : ""}`}
        style={{ background: value }}
        onClick={() => (open ? setOpen(false) : openPop())}
        aria-label="Choose colour"
        aria-expanded={open}
      />
      {open &&
        pos &&
        /* Portal to <body>: rendered in place, a transformed ancestor (e.g. the
           centered draw toolbar) would otherwise become the containing block for
           this fixed popover and throw its position way off. */
        createPortal(
          <div
            ref={popRef}
            className="colorfield__pop"
            style={{ left: pos.left, top: pos.top }}
            role="dialog"
            aria-label="Choose colour"
          >
            <div className="colorfield__grid">
              {PRESETS.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={`colorfield__chip${c.toLowerCase() === value.toLowerCase() ? " colorfield__chip--on" : ""}`}
                  style={{ background: c }}
                  onClick={() => {
                    onChange(c);
                    setOpen(false);
                  }}
                  aria-label={c}
                />
              ))}
            </div>
            <div className="colorfield__hexrow">
              <span className="colorfield__preview" style={{ background: isHex(hex) ? hex : value }} />
              <input
                className="colorfield__hex"
                value={hex}
                spellCheck={false}
                maxLength={7}
                onChange={(e) => {
                  let v = e.target.value;
                  if (!v.startsWith("#")) v = "#" + v.replace(/#/g, "");
                  setHex(v);
                  if (isHex(v)) onChange(v);
                }}
              />
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
