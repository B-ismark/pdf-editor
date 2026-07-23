import { useEffect, useRef, useState } from "react";
import { acquireEscapeLayer } from "../hooks/useModal";

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
const POP_W = 196;

/** A custom colour control: a swatch that opens a preset palette + hex input
 * in a fixed-position popover (avoids the native OS colour picker and any
 * clipping by scrolling parents). */
export function ColorField({ value, onChange, small }: Props) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [hex, setHex] = useState(value);
  const swatchRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  useEffect(() => setHex(value), [value]);

  const openPop = () => {
    const r = swatchRef.current!.getBoundingClientRect();
    const left = Math.min(Math.max(8, r.right - POP_W), window.innerWidth - POP_W - 8);
    const top = Math.min(r.bottom + 6, window.innerHeight - 200);
    setPos({ left, top });
    setOpen(true);
  };

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
      {open && pos && (
        <div ref={popRef} className="colorfield__pop" style={{ left: pos.left, top: pos.top }} role="dialog" aria-label="Choose colour">
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
        </div>
      )}
    </>
  );
}
