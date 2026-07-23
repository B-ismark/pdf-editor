import { useState } from "react";
import { Icon } from "./Icon";
import type { CompressOptions } from "../pdf/finishOps";

interface Props {
  onApply: (opts: CompressOptions) => void;
  onClose: () => void;
}

const PRESETS: { key: string; label: string; hint: string; opts: CompressOptions }[] = [
  { key: "high", label: "High quality", hint: "Larger file · crisp", opts: { scale: 2, quality: 0.82 } },
  { key: "balanced", label: "Balanced", hint: "Good for sharing", opts: { scale: 1.5, quality: 0.7 } },
  { key: "small", label: "Smallest", hint: "Email-friendly · softer", opts: { scale: 1, quality: 0.6 } },
];

/** Pick a compression preset. Compression rasterises pages (text becomes an
 * image), which is called out so the trade-off is clear. */
export function CompressDialog({ onApply, onClose }: Props) {
  const [sel, setSel] = useState("balanced");

  return (
    <div className="dialog-scrim" onPointerDown={onClose}>
      <div
        className="dialog dialog--sm"
        role="dialog"
        aria-modal="true"
        aria-label="Compress PDF"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="dialog__head">
          <span className="title-medium">Compress PDF</span>
          <button className="icon-btn" onClick={onClose} aria-label="Close" data-tip="Close">
            <Icon name="close" size={20} />
          </button>
        </div>
        <div className="compress__presets">
          {PRESETS.map((p) => (
            <button
              key={p.key}
              className={`compress__preset${sel === p.key ? " compress__preset--on" : ""}`}
              onClick={() => setSel(p.key)}
              aria-pressed={sel === p.key}
            >
              <span className="compress__preset-label">{p.label}</span>
              <span className="compress__preset-hint body-small">{p.hint}</span>
            </button>
          ))}
        </div>
        <p className="confirm__msg body-small">
          Compression flattens each page to an image, so the exported copy won't be text-editable.
          Your working document is untouched.
        </p>
        <div className="dialog__actions">
          <button className="btn btn--text" onClick={onClose}>Cancel</button>
          <button
            className="btn btn--filled"
            onClick={() => onApply(PRESETS.find((p) => p.key === sel)!.opts)}
          >
            <Icon name="compress" size={16} /> Compress &amp; download
          </button>
        </div>
      </div>
    </div>
  );
}
