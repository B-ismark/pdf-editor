import { useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Icon } from "./Icon";
import { ColorField } from "./ColorField";
import { useModal } from "../hooks/useModal";
import { DEFAULT_BATES, MAX_BATES_DIGITS, MAX_START, POSITIONS, TOKENS, batesNumber, dateLabel, firstNumber, labelsFor, normalBates, slotsOf, textColor, textSize, uses } from "../pdf/headerFooter";
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

/** A whole number typed into a field, clamped to its range; what was typed is
 * kept as typed (so it can be cleared and retyped) and only read through this. */
function whole(text: string, min: number, max: number, fallback: number): number {
  const n = Math.round(Number(text));
  return text.trim() === "" || !Number.isFinite(n) ? fallback : Math.max(min, Math.min(max, n));
}

/** A number field that lets the person clear it and type: it holds the text,
 * and settles on the clamped number when focus leaves. */
function NumberField({ label, value, onChange, min, max }: { label: string; value: string; onChange: (v: string) => void; min: number; max?: number }) {
  return (
    <input
      className="numinput"
      type="number"
      inputMode="numeric"
      min={min}
      max={max}
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={() => onChange(String(whole(value, min, max ?? MAX_START, min)))}
    />
  );
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
  const [startText, setStartText] = useState(String(currentNumbers ? firstNumber(currentNumbers) : 1));
  // Read as the page reads it, so opening and pressing Update changes nothing.
  const storedBates = normalBates(currentNumbers?.bates ?? DEFAULT_BATES);
  const [prefix, setPrefix] = useState(storedBates.prefix);
  const [batesStartText, setBatesStartText] = useState(String(storedBates.start));
  const [digitsText, setDigitsText] = useState(String(storedBates.digits));
  const start = whole(startText, 0, MAX_START, 0);
  const bates = useMemo<BatesOptions>(
    () => ({ prefix, start: whole(batesStartText, 0, MAX_START, 0), digits: whole(digitsText, 1, MAX_BATES_DIGITS, 1) }),
    [prefix, batesStartText, digitsText],
  );
  // The date and file name were fixed when the setting was applied; Update
  // keeps them unless the person asks for today's and this file's.
  const today = useMemo(() => dateLabel(new Date()), []);
  // Only a value that was on the pages is worth keeping: one stored but never
  // shown (a "{page}" setting applied months ago) gives way to today's.
  const storedDate = currentNumbers && uses(currentNumbers, "{date}") && typeof currentNumbers.date === "string" ? currentNumbers.date : null;
  const storedFile = currentNumbers && uses(currentNumbers, "{file}") && typeof currentNumbers.file === "string" ? currentNumbers.file : null;
  const [refresh, setRefresh] = useState(false);
  const [numColor, setNumColor] = useState(currentNumbers ? textColor(currentNumbers) : "#444444");
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
    // Commit the new text and put the caret after the token in the same task:
    // waiting a frame lets a fast next keystroke land at the end instead.
    flushSync(() => setSlots((s) => ({ ...s, [at]: value.slice(0, from) + token + value.slice(to) })));
    el?.focus();
    el?.setSelectionRange(from + token.length, from + token.length);
  };

  // The size has no control here; keep what the setting has (11 for a new one).
  const size = currentNumbers ? textSize(currentNumbers) : 11;

  // What Apply stores, and so what the preview line, the page and the file read.
  const draft = useMemo<PageNumberOptions>(() => {
    const filled = slotsOf({ position: "bottom-center", start, size, color: numColor, slots });
    return {
      position: filled[0]?.[0] ?? "bottom-center",
      start,
      size,
      color: numColor,
      slots: Object.fromEntries(filled),
      bates,
      date: refresh || storedDate == null ? today : storedDate,
      file: refresh || storedFile == null ? fileName : storedFile,
    };
  }, [slots, start, size, numColor, bates, fileName, refresh, today, storedDate, storedFile]);
  const empty = slotsOf(draft).length === 0;
  const usesBates = slotsOf(draft).some(([, t]) => /\{bates\}/i.test(t));
  const firstPage = labelsFor(draft, 0, Math.max(1, pageTotal));
  // Offer a refresh only where it would change something the pages show.
  const usesDate = slotsOf(draft).some(([, t]) => /\{date\}/i.test(t));
  const usesFile = slotsOf(draft).some(([, t]) => /\{file\}/i.test(t));
  const stale = (usesDate && storedDate != null && storedDate !== today) || (usesFile && storedFile != null && storedFile !== fileName);

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
              <p className="hf__preview body-medium">
                {empty
                  ? "Nothing to add yet — type in a place above."
                  : <>Page 1 reads: {firstPage.map((l, i) => <span key={l.position}>{i > 0 && " · "}<b>{l.text}</b></span>)}</>}
              </p>
              <div className="field field--row">
                <span className="field__label label-medium">Number pages from</span>
                <NumberField label="Number pages from" min={0} value={startText} onChange={setStartText} />
              </div>
              {usesBates && (
                <fieldset className="hf__bates">
                  <legend className="field__label label-medium">Bates number</legend>
                  <div className="field field--row">
                    <span className="field__label label-medium">Prefix</span>
                    <input className="numinput hf__prefix" aria-label="Bates prefix" value={prefix} onChange={(e) => setPrefix(e.target.value)} />
                  </div>
                  <div className="field field--row">
                    <span className="field__label label-medium">Start at</span>
                    <NumberField label="Bates start" min={0} value={batesStartText} onChange={setBatesStartText} />
                  </div>
                  <div className="field field--row">
                    <span className="field__label label-medium">Digits</span>
                    <NumberField label="Bates digits" min={1} max={MAX_BATES_DIGITS} value={digitsText} onChange={setDigitsText} />
                  </div>
                  <p className="hf__range body-medium">
                    {batesNumber(bates, 0)} – {batesNumber(bates, Math.max(1, pageTotal) - 1)}
                  </p>
                </fieldset>
              )}
              {stale && (
                <label className="hf__refresh body-medium">
                  <input type="checkbox" checked={refresh} onChange={(e) => setRefresh(e.target.checked)} />
                  Use today’s date and this file’s name
                </label>
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
