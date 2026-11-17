import { useEffect, useState } from "react";
import { staleBuildMessage } from "../staleBuild";
import { Icon } from "./Icon";
import { useModal } from "../hooks/useModal";
import type { CompressOptions } from "../pdf/finishOps";

/** A chosen compression strategy. */
export type CompressPreset = { kind: "lossless" } | { kind: "raster"; opts: CompressOptions };

/** The measured result of a strategy (no download yet). */
export type CompressEstimate =
  | { kind: "lossless"; size: number }
  | { kind: "raster"; before: number; after: number; helped: boolean };

interface Props {
  /** Apply the strategy and report the resulting size (no download). */
  onEstimate: (preset: CompressPreset) => Promise<CompressEstimate>;
  /** Download the most recently estimated result. */
  onDownload: () => void;
  onClose: () => void;
}

interface Choice {
  key: string;
  label: string;
  hint: string;
  preset: CompressPreset;
}

const CHOICES: Choice[] = [
  { key: "lossless", label: "Keep text", hint: "Stays selectable · shrinks large images", preset: { kind: "lossless" } },
  { key: "high", label: "High quality", hint: "≈150 dpi · crisp images", preset: { kind: "raster", opts: { scale: 2, quality: 0.82 } } },
  { key: "balanced", label: "Balanced", hint: "≈110 dpi · good for sharing", preset: { kind: "raster", opts: { scale: 1.5, quality: 0.7 } } },
  { key: "small", label: "Smallest", hint: "≈72 dpi · email-friendly", preset: { kind: "raster", opts: { scale: 1, quality: 0.6 } } },
];

const fmt = (n: number) => (n < 1_000_000 ? Math.round(n / 1000) + " KB" : (n / 1_000_000).toFixed(2) + " MB");
const dpiOf = (scale: number) => Math.round(scale * 72); // 1 PDF point = 1/72 inch

/** Pick a compression strategy and preview the resulting size before
 * downloading. Rasterising presets flatten pages to images (smaller, but text
 * is no longer selectable); "Keep text" losslessly re-optimises the document;
 * "Custom" exposes the raster resolution + JPEG quality directly. */
export function CompressDialog({ onEstimate, onDownload, onClose }: Props) {
  const [sel, setSel] = useState("balanced");
  const [busy, setBusy] = useState(false);
  const [est, setEst] = useState<CompressEstimate | null>(null);
  const [errored, setErrored] = useState(false);
  const [scale, setScale] = useState(1.5);
  const [quality, setQuality] = useState(0.7);
  const modalRef = useModal<HTMLDivElement>(onClose);

  const presetFor = (key: string): CompressPreset =>
    key === "custom" ? { kind: "raster", opts: { scale, quality } } : CHOICES.find((c) => c.key === key)!.preset;

  const estimate = async (key: string, preset: CompressPreset) => {
    setSel(key);
    setEst(null);
    setErrored(false);
    setBusy(true);
    try {
      setEst(await onEstimate(preset));
    } catch (err) {
      // A missing code file raises the app's "updated" banner as well.
      staleBuildMessage(err);
      setErrored(true);
    } finally {
      setBusy(false);
    }
  };

  const pick = (key: string) => void estimate(key, presetFor(key));
  // Re-estimate the custom result after a slider is released (not on every tick).
  const reestimateCustom = () => void estimate("custom", { kind: "raster", opts: { scale, quality } });

  // Preview the default choice as soon as the dialog opens.
  useEffect(() => {
    void estimate("balanced", CHOICES.find((c) => c.key === "balanced")!.preset);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const rasterPct = est?.kind === "raster" && est.before > 0 ? Math.round((1 - est.after / est.before) * 100) : 0;
  const isLossless = sel === "lossless";

  return (
    <div className="dialog-scrim" onPointerDown={onClose}>
      <div
        ref={modalRef}
        tabIndex={-1}
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
          {CHOICES.map((c) => (
            <button
              key={c.key}
              className={`compress__preset${sel === c.key ? " compress__preset--on" : ""}`}
              onClick={() => pick(c.key)}
              aria-pressed={sel === c.key}
              disabled={busy}
            >
              <span className="compress__preset-label">{c.label}</span>
              <span className="compress__preset-hint body-small">{c.hint}</span>
            </button>
          ))}
          <button
            className={`compress__preset${sel === "custom" ? " compress__preset--on" : ""}`}
            onClick={() => pick("custom")}
            aria-pressed={sel === "custom"}
            disabled={busy}
          >
            <span className="compress__preset-label">Custom</span>
            <span className="compress__preset-hint body-small">Set resolution &amp; quality</span>
          </button>
        </div>

        {sel === "custom" && (
          <div className="compress__sliders">
            <label className="compress__slider">
              <span className="compress__slider-head body-small">
                <span>Resolution</span>
                <span>{dpiOf(scale)} dpi</span>
              </span>
              <input
                type="range"
                min={0.75}
                max={2.5}
                step={0.25}
                value={scale}
                disabled={busy}
                onChange={(e) => setScale(Number(e.target.value))}
                onPointerUp={reestimateCustom}
                onKeyUp={reestimateCustom}
                aria-label="Resolution in dpi"
              />
            </label>
            <label className="compress__slider">
              <span className="compress__slider-head body-small">
                <span>Quality</span>
                <span>{Math.round(quality * 100)}%</span>
              </span>
              <input
                type="range"
                min={0.3}
                max={0.95}
                step={0.05}
                value={quality}
                disabled={busy}
                onChange={(e) => setQuality(Number(e.target.value))}
                onPointerUp={reestimateCustom}
                onKeyUp={reestimateCustom}
                aria-label="JPEG quality percent"
              />
            </label>
          </div>
        )}

        {/* Live size preview for the selected choice. */}
        <div className="compress__estimate body-medium" aria-live="polite">
          {busy ? (
            <><span className="spinner spinner--sm" aria-hidden="true" /> Estimating size…</>
          ) : errored ? (
            <span className="compress__estimate-err">Couldn't estimate — try again.</span>
          ) : est?.kind === "lossless" ? (
            <><Icon name="check" size={15} /> <strong>{fmt(est.size)}</strong> · text stays selectable</>
          ) : est?.kind === "raster" ? (
            est.helped ? (
              <><Icon name="compress" size={15} /> {fmt(est.before)} → <strong>{fmt(est.after)}</strong> · {rasterPct}% smaller</>
            ) : (
              <>Rasterising wouldn't help ({fmt(est.after)}); the text version at {fmt(est.before)} will be used.</>
            )
          ) : (
            <>Pick an option to preview the size.</>
          )}
        </div>

        <p className="confirm__msg body-small">
          {isLossless
            ? "Keeps every page selectable and searchable, re-optimised and stripped of hidden metadata; oversized photos/scans are downsampled."
            : "Rasterising flattens each page to an image, so the exported copy won't be text-editable."}{" "}
          Your working document is untouched.
        </p>
        <div className="dialog__actions">
          <button className="btn btn--text" onClick={onClose}>Cancel</button>
          <button className="btn btn--filled" onClick={onDownload} disabled={busy || !est}>
            <Icon name="download" size={16} /> Download
          </button>
        </div>
      </div>
    </div>
  );
}
