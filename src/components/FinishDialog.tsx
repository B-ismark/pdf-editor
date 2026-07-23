import { useState } from "react";
import { Icon } from "./Icon";
import { ColorField } from "./ColorField";
import type { NumberPosition, PageNumberOptions, WatermarkOptions } from "../pdf/finishOps";

interface Props {
  initialTab?: "numbers" | "watermark";
  onApplyNumbers: (opts: PageNumberOptions) => void;
  onApplyWatermark: (opts: WatermarkOptions) => void;
  onClose: () => void;
}

const POSITIONS: NumberPosition[] = [
  "top-left", "top-center", "top-right",
  "bottom-left", "bottom-center", "bottom-right",
];

export function FinishDialog({ initialTab = "numbers", onApplyNumbers, onApplyWatermark, onClose }: Props) {
  const [tab, setTab] = useState(initialTab);
  const [position, setPosition] = useState<NumberPosition>("bottom-center");
  const [start, setStart] = useState(1);
  const [numColor, setNumColor] = useState("#444444");
  const [text, setText] = useState("DRAFT");
  const [wmColor, setWmColor] = useState("#888888");
  const [opacity, setOpacity] = useState(0.2);
  const [angle, setAngle] = useState(45);
  const [wmSize, setWmSize] = useState(60);

  return (
    <div className="dialog-scrim" onPointerDown={onClose}>
      <div className="dialog" onPointerDown={(e) => e.stopPropagation()}>
        <div className="dialog__head">
          <span className="title-large">Finishing touches</span>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="close" size={22} />
          </button>
        </div>

        <div className="segmented dialog__tabs">
          <button className={`segmented__btn${tab === "numbers" ? " segmented__btn--on" : ""}`} onClick={() => setTab("numbers")}>
            Page numbers
          </button>
          <button className={`segmented__btn${tab === "watermark" ? " segmented__btn--on" : ""}`} onClick={() => setTab("watermark")}>
            Watermark
          </button>
        </div>

        <div className="dialog__body dialog__body--form">
          {tab === "numbers" ? (
            <div className="props__section">
              <div className="field">
                <span className="field__label label-medium">Position</span>
                <div className="posgrid">
                  {POSITIONS.map((p) => (
                    <button
                      key={p}
                      className={`posgrid__cell${position === p ? " posgrid__cell--on" : ""}`}
                      onClick={() => setPosition(p)}
                      aria-label={p}
                      aria-pressed={position === p}
                    />
                  ))}
                </div>
              </div>
              <div className="field field--row">
                <span className="field__label label-medium">Start at</span>
                <input className="numinput" type="number" min={0} value={start} onChange={(e) => setStart(Number(e.target.value) || 0)} />
              </div>
              <div className="field field--row">
                <span className="field__label label-medium">Colour</span>
                <ColorField value={numColor} onChange={setNumColor} />
              </div>
            </div>
          ) : (
            <div className="props__section">
              <div className="field">
                <span className="field__label label-medium">Text</span>
                <input className="sigtype__input" value={text} onChange={(e) => setText(e.target.value)} />
              </div>
              <div className="field field--row">
                <span className="field__label label-medium">Colour</span>
                <ColorField value={wmColor} onChange={setWmColor} />
              </div>
              <div className="field">
                <span className="field__label label-medium">Opacity <b>{Math.round(opacity * 100)}%</b></span>
                <input className="slider" type="range" min={5} max={80} value={opacity * 100} onChange={(e) => setOpacity(Number(e.target.value) / 100)} />
              </div>
              <div className="field">
                <span className="field__label label-medium">Angle <b>{angle}°</b></span>
                <input className="slider" type="range" min={-90} max={90} value={angle} onChange={(e) => setAngle(Number(e.target.value))} />
              </div>
              <div className="field">
                <span className="field__label label-medium">Size <b>{wmSize}</b></span>
                <input className="slider" type="range" min={16} max={140} value={wmSize} onChange={(e) => setWmSize(Number(e.target.value))} />
              </div>
            </div>
          )}
        </div>

        <div className="dialog__actions">
          <button className="btn" onClick={onClose}>Cancel</button>
          {tab === "numbers" ? (
            <button className="btn btn--filled" onClick={() => onApplyNumbers({ position, start, size: 11, color: numColor })}>
              Apply
            </button>
          ) : (
            <button className="btn btn--filled" disabled={!text.trim()} onClick={() => onApplyWatermark({ text, size: wmSize, color: wmColor, opacity, angle })}>
              Apply
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
