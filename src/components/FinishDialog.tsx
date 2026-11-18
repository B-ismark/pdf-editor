import { useMemo, useRef, useState } from "react";
import { Icon } from "./Icon";
import { ColorField } from "./ColorField";
import { useModal } from "../hooks/useModal";
import { DEFAULT_BATES, MAX_BATES_DIGITS, POSITIONS, TOKENS, batesNumber, labelsFor, slotsOf } from "../pdf/headerFooter";
import type { BatesOptions, NumberPosition, PageNumberOptions, WatermarkOptions } from "../pdf/types";

interface Props {
  initialTab?: "numbers" | "watermark";
  /** Current settings, so re-opening the dialog reflects what's applied. */
  currentNumbers?: PageNumberOptions | null;
  currentWatermark?: WatermarkOptions | null;
  onApplyNumbers: (opts: PageNumberOptions) => void;
  onApplyWatermark: (opts: WatermarkOptions) => void;
  onClearNumbers: () => void;
  onClearWatermark: () => void;
  onClose: () => void;
  /** The document's name and page count as shown, for `{file}` and `{pages}`
   * (and the Bates range) — fixed into the setting when it's applied. */
  fileName: string;
  pageTotal: number;
}

type Slots = Partial<Record<NumberPosition, string>>;

const PLACE: Record<NumberPosition, string> = {
  "top-left": "Header, left",
  "top-center": "Header, centre",
  "top-right": "Header, right",
  "bottom-left": "Footer, left",
  "bottom-center": "Footer, centre",
  "bottom-right": "Footer, right",
};

/** Today, as a reader would write it: fixed into the setting at Apply, so the
 * preview, every page and every later export agree. */
function today(): string {
  return new Date().toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
}

export function FinishDialog({
  initialTab = "numbers",
  currentNumbers,
  currentWatermark,
  onApplyNumbers,
  onApplyWatermark,
  onClearNumbers,
  onClearWatermark,
  onClose,
  fileName,
  pageTotal,
}: Props) {
  const [tab, setTab] = useState(initialTab);
  // A setting from before header & footer (no `slots`) opens as its one
  // "{page}" place; a new one starts as a page number, bottom centre.
  const [slots, setSlots] = useState<Slots>(() =>
    Object.fromEntries(currentNumbers ? slotsOf(currentNumbers) : [["bottom-center", "{page}"]]),
  );
  const [start, setStart] = useState(currentNumbers?.start ?? 1);
  const [bates, setBates] = useState<BatesOptions>(currentNumbers?.bates ?? DEFAULT_BATES);
  const [numColor, setNumColor] = useState(currentNumbers?.color ?? "#444444");
  const [text, setText] = useState(currentWatermark?.text ?? "DRAFT");
  const [wmColor, setWmColor] = useState(currentWatermark?.color ?? "#888888");
  const [opacity, setOpacity] = useState(currentWatermark?.opacity ?? 0.2);
  const [angle, setAngle] = useState(currentWatermark?.angle ?? 45);
  const [wmSize, setWmSize] = useState(currentWatermark?.size ?? 60);
  const modalRef = useModal<HTMLDivElement>(onClose);

  // The place a token chip types into: the last one focused.
  const inputs = useRef<Partial<Record<NumberPosition, HTMLInputElement | null>>>({});
  const lastPlace = useRef<NumberPosition>("bottom-center");
  const insert = (token: string) => {
    const at = lastPlace.current;
    const el = inputs.current[at];
    const value = slots[at] ?? "";
    const from = el?.selectionStart ?? value.length;
    const to = el?.selectionEnd ?? value.length;
    setSlots((s) => ({ ...s, [at]: value.slice(0, from) + token + value.slice(to) }));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(from + token.length, from + token.length);
    });
  };

  // What Apply stores, and so what the preview line, the page and the file read.
  const draft = useMemo<PageNumberOptions>(() => {
    const filled = slotsOf({ position: "bottom-center", start, size: 11, color: numColor, slots });
    return {
      position: filled[0]?.[0] ?? "bottom-center",
      start,
      size: 11,
      color: numColor,
      slots: Object.fromEntries(filled),
      bates,
      date: today(),
      file: fileName,
    };
  }, [slots, start, numColor, bates, fileName]);
  const empty = slotsOf(draft).length === 0;
  const usesBates = slotsOf(draft).some(([, t]) => /\{bates\}/i.test(t));
  const firstPage = labelsFor(draft, 0, Math.max(1, pageTotal));

  return (
    <div className="dialog-scrim" onPointerDown={onClose}>
      <div
        ref={modalRef}
        tabIndex={-1}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Finishing touches"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="dialog__head">
          <span className="title-large">Finishing touches</span>
          <button className="icon-btn" onClick={onClose} aria-label="Close" data-tip="Close">
            <Icon name="close" size={20} />
          </button>
        </div>

        <div className="segmented dialog__tabs">
          <button className={`segmented__btn${tab === "numbers" ? " segmented__btn--on" : ""}`} onClick={() => setTab("numbers")}>
            Header &amp; footer
          </button>
          <button className={`segmented__btn${tab === "watermark" ? " segmented__btn--on" : ""}`} onClick={() => setTab("watermark")}>
            Watermark
          </button>
        </div>

        <div className="dialog__body dialog__body--form">
          {tab === "numbers" ? (
            <div className="props__section">
              {(["Header", "Footer"] as const).map((band) => (
                <div className="field" key={band}>
                  <span className="field__label label-medium">{band}</span>
                  <div className="hf__band">
                    {POSITIONS.filter((p) => p.startsWith(band === "Header" ? "top" : "bottom")).map((p) => (
                      <input
                        key={p}
                        ref={(el) => {
                          inputs.current[p] = el;
                        }}
                        className="hf__slot"
                        aria-label={PLACE[p]}
                        placeholder={p.endsWith("left") ? "Left" : p.endsWith("right") ? "Right" : "Centre"}
                        value={slots[p] ?? ""}
                        onFocus={() => {
                          lastPlace.current = p;
                        }}
                        onChange={(e) => {
                          const v = e.target.value;
                          setSlots((s) => ({ ...s, [p]: v }));
                        }}
                      />
                    ))}
                  </div>
                </div>
              ))}
              <div className="field">
                <span className="field__label label-medium">Insert</span>
                <div className="chip-row hf__tokens">
                  {TOKENS.map((t) => (
                    <button
                      key={t.token}
                      type="button"
                      className="chip hf__token"
                      // Keep the caret where it is: the chip types into the
                      // place last focused, at its cursor.
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => insert(t.token)}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              </div>
              <p className="hf__preview body-medium" aria-live="polite">
                {empty
                  ? "Nothing to add yet — type in a place above."
                  : <>Page 1 reads: {firstPage.map((l, i) => <span key={l.position}>{i > 0 && " · "}<b>{l.text}</b></span>)}</>}
              </p>
              <div className="field field--row">
                <span className="field__label label-medium">Number pages from</span>
                <input className="numinput" type="number" min={0} aria-label="Number pages from" value={start} onChange={(e) => setStart(Math.max(0, Math.round(Number(e.target.value)) || 0))} />
              </div>
              {usesBates && (
                <fieldset className="hf__bates">
                  <legend className="field__label label-medium">Bates number</legend>
                  <div className="field field--row">
                    <span className="field__label label-medium">Prefix</span>
                    <input className="numinput hf__prefix" aria-label="Bates prefix" value={bates.prefix} onChange={(e) => setBates((b) => ({ ...b, prefix: e.target.value }))} />
                  </div>
                  <div className="field field--row">
                    <span className="field__label label-medium">Start at</span>
                    <input className="numinput" type="number" min={0} aria-label="Bates start" value={bates.start} onChange={(e) => setBates((b) => ({ ...b, start: Math.max(0, Math.round(Number(e.target.value)) || 0) }))} />
                  </div>
                  <div className="field field--row">
                    <span className="field__label label-medium">Digits</span>
                    <input className="numinput" type="number" min={1} max={MAX_BATES_DIGITS} aria-label="Bates digits" value={bates.digits} onChange={(e) => setBates((b) => ({ ...b, digits: Math.max(1, Math.min(MAX_BATES_DIGITS, Math.round(Number(e.target.value)) || 1)) }))} />
                  </div>
                  <p className="hf__range body-medium">
                    {batesNumber(bates, 0)} – {batesNumber(bates, Math.max(1, pageTotal) - 1)}
                  </p>
                </fieldset>
              )}
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
            <>
              {currentNumbers && (
                <button className="btn" onClick={onClearNumbers}>Remove</button>
              )}
              <button className="btn btn--filled" disabled={empty} onClick={() => onApplyNumbers({ ...draft, bates: usesBates ? bates : undefined })}>
                {currentNumbers ? "Update" : "Apply"}
              </button>
            </>
          ) : (
            <>
              {currentWatermark && (
                <button className="btn" onClick={onClearWatermark}>Remove</button>
              )}
              <button className="btn btn--filled" disabled={!text.trim()} onClick={() => onApplyWatermark({ text, size: wmSize, color: wmColor, opacity, angle })}>
                {currentWatermark ? "Update" : "Apply"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
