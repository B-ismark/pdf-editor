import { useEffect, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { Icon } from "./Icon";
import { ColorField } from "./ColorField";
import { isRejectedUrl } from "../pdf/url";
import { segmentKey } from "../segmentKey";
import type { Annotation, FontKey, Selection, TextStyle } from "../pdf/types";

interface Props {
  selection: Selection;
  style: TextStyle | null;
  redactionColor: string | null;
  /** True when the selected redaction is a whiteout cover (not a real redaction). */
  redactionCover?: boolean;
  annotation: Annotation | null;
  /** True when the *actual* selection is a stamp. Stamps have no controls here
   * (they're edited on the canvas), but "nothing selected" is a lie when the
   * user just clicked their own signature — so the panel says which it is. */
  stampSelected?: boolean;
  /** Current URL of the selected link (when selection.kind === "link"). */
  linkUrl?: string | null;
  /** Where the selected link goes when it goes to a page: its position as
   * shown (0-based), or null when that page was deleted. Undefined when the
   * link goes to a web address. */
  linkPage?: number | null;
  /** Pages in the document as shown, for the link's page field. */
  pageCount?: number;
  /** Send the link to a page (its position as shown), or back to its web
   * address (undefined). */
  onChangeLinkPage?: (pos: number | undefined) => void;
  onChangeStyle: (patch: Partial<TextStyle>) => void;
  onChangeRedactionColor: (color: string) => void;
  onChangeLinkUrl?: (url: string) => void;
  onChangeAnnotation: (patch: { color?: string; strokeWidth?: number }) => void;
  /** Restack the selected annotation within the annotation layer. */
  onArrange?: (to: "front" | "back") => void;
  onDelete: () => void;
  /** Reset the selected text's style back to the default. */
  onReset?: () => void;
  /** Mobile bottom-sheet close affordance (omitted on desktop side panel). */
  onClose?: () => void;
  /** Replaces the close button at the end of the heading (the Inspector's "Hide panel"). */
  headerAction?: ReactNode;
}

const ANNOT_LABEL: Record<string, string> = {
  highlight: "Highlight",
  pen: "Drawing",
  rect: "Rectangle",
  line: "Line",
  arrow: "Arrow",
  // Named, not left to the generic fallback: "Annotation" told a user who just
  // placed a tick nothing about what they had selected.
  check: "Tick",
  cross: "Cross",
  note: "Sticky note",
};

const FONTS: { key: FontKey; label: string }[] = [
  { key: "sans", label: "Sans" },
  { key: "serif", label: "Serif" },
  { key: "mono", label: "Mono" },
];

/** Keep stepper nudges within the size slider's range. */
const clampSize = (size: number) => Math.min(96, Math.max(6, Math.round(size)));

/** Contextual controls for the selected element. */
export function PropertiesPanel({
  selection,
  style,
  redactionColor,
  redactionCover,
  annotation,
  stampSelected,
  linkUrl,
  linkPage,
  pageCount = 1,
  onChangeLinkPage,
  onChangeStyle,
  onChangeRedactionColor,
  onChangeLinkUrl,
  onChangeAnnotation,
  onArrange,
  onDelete,
  onReset,
  onClose,
  headerAction,
}: Props) {
  const linkRejected = isRejectedUrl(linkUrl ?? "");
  const title =
    selection?.kind === "redaction"
      ? redactionCover
        ? "Whiteout"
        : "Redaction"
      : selection?.kind === "link"
        ? "Link"
        : selection?.kind === "textbox"
        ? "Text box"
        : selection?.kind === "fragment"
          ? "Text"
          : selection?.kind === "annotation"
            ? (annotation ? ANNOT_LABEL[annotation.kind] : "Annotation")
            : stampSelected
              ? "Image"
              : "Properties";

  return (
    <div className="props">
      <div className="props__header">
        <h2 className="props__title title-medium">{title}</h2>
        {headerAction ??
          (onClose && (
            <button className="icon-btn" onClick={onClose} aria-label="Close" data-tip="Close">
              <Icon name="close" size={20} />
            </button>
          ))}
      </div>

      {/* Every gesture, not a sample of them: this paragraph is the only place
          the app explains how a stamp is edited, so leaving rotate out (or
          saying "the corner handle" of eight) sends the reader hunting. */}
      {!selection && stampSelected && (
        <p className="props__empty body-medium">
          This image is edited on the page: drag it to move, pull any handle to
          resize, twist just outside a corner to rotate, and use the badge to
          delete.
        </p>
      )}

      {selection?.kind === "redaction" && (
        <div className="props__section">
          <div className="field field--row">
            <span className="field__label label-medium">Fill colour</span>
            <ColorField value={redactionColor ?? "#000000"} onChange={onChangeRedactionColor} />
          </div>
          <button className="btn btn--danger" onClick={onDelete}>
            <Icon name="delete" size={16} /> Delete
          </button>
        </div>
      )}

      {selection?.kind === "link" && (
        <div className="props__section">
          <div className="field">
            <span className="field__label label-medium" id="link-target">
              Goes to
            </span>
            <div
              className="segmented segmented--compact"
              role="radiogroup"
              aria-labelledby="link-target"
              // A radio group is one tab stop; the arrows move the choice.
              onKeyDown={(e) => {
                const at = linkPage !== undefined ? 1 : 0;
                const to = segmentKey(e.key, at, 2);
                if (to == null) return;
                // Not also a nudge of the selected link on the canvas.
                e.preventDefault();
                e.stopPropagation();
                // Home/End on the choice already made changes nothing — not
                // even a deleted page's link, which stays flagged.
                if (to === at) return;
                onChangeLinkPage?.(to === 1 ? (linkPage ?? 0) : undefined);
                const btns = e.currentTarget.querySelectorAll<HTMLElement>("[role=radio]");
                requestAnimationFrame(() => btns[to]?.focus());
              }}
            >
              {(["url", "page"] as const).map((k) => {
                const on = (linkPage !== undefined) === (k === "page");
                return (
                  <button
                    key={k}
                    role="radio"
                    aria-checked={on}
                    tabIndex={on ? 0 : -1}
                    className={`segmented__btn${on ? " segmented__btn--on" : ""}`}
                    onClick={() => !on && onChangeLinkPage?.(k === "page" ? 0 : undefined)}
                  >
                    {k === "url" ? "Web address" : "Page"}
                  </button>
                );
              })}
            </div>
          </div>
          {linkPage !== undefined ? (
            <LinkPageField key={selection.id} pos={linkPage} count={pageCount} onChange={(p) => onChangeLinkPage?.(p)} />
          ) : (
          <>
          <div className="field">
            <label className="field__label label-medium" htmlFor="link-url">
              Link URL
            </label>
            <input
              id="link-url"
              className="numinput"
              style={{ width: "100%" }}
              type="url"
              inputMode="url"
              placeholder="https://example.com"
              value={linkUrl ?? ""}
              aria-invalid={linkRejected || undefined}
              aria-describedby="link-url-note"
              onChange={(e) => onChangeLinkUrl?.(e.target.value)}
            />
          </div>
          {/* Only http(s), mailto and tel are exportable — a `javascript:` or
              `data:` URI would be live active content in the recipient's
              reader, so it's refused rather than quietly dropped at export. */}
          <p
            id="link-url-note"
            className={`props__empty body-small${linkRejected ? " props__warn" : ""}`}
            role={linkRejected ? "alert" : undefined}
          >
            {linkRejected
              ? "That address can't be used in a PDF link. Use a web (https://), email (mailto:) or phone (tel:) address."
              : "Draw a box over anything to make it clickable in the exported PDF."}
          </p>
          </>
          )}
          <button className="btn btn--danger" onClick={onDelete}>
            <Icon name="delete" size={16} /> Delete
          </button>
        </div>
      )}

      {selection?.kind === "annotation" && annotation && (
        <div className="props__section">
          <div className="field field--row">
            <span className="field__label label-medium">Colour</span>
            <ColorField value={annotation.color} onChange={(c) => onChangeAnnotation({ color: c })} />
          </div>
          {"strokeWidth" in annotation && (
            <div className="field">
              <span className="field__label label-medium">
                Width <b>{annotation.strokeWidth}</b>
              </span>
              <input
                className="slider"
                type="range"
                min={1}
                max={12}
                value={annotation.strokeWidth}
                aria-label="Stroke width"
                onChange={(e) => onChangeAnnotation({ strokeWidth: Number(e.target.value) })}
              />
            </div>
          )}
          {annotation.kind === "note" && (
            <p className="props__empty body-small">Edit the note text directly on the page.</p>
          )}
          {/* Stacking order. Drawings paint in the order they were made, so
              anything drawn later buries what's under it — a highlight over a
              pen line used to be permanent. Not offered for a sticky note: a
              note is an HTML element above the whole shape layer (and, since
              `annotationPaintOrder`, above it in the file too), so "bring to
              front" would be a control with nothing to do. */}
          {onArrange && annotation.kind !== "note" && (
            <div className="field field--row">
              <span className="field__label label-medium">Order</span>
              <div className="props__arrange">
                <button
                  className="icon-btn icon-btn--sm"
                  onClick={() => onArrange("front")}
                  aria-label="Bring to front"
                  data-tip="Bring to front · ]"
                >
                  <Icon name="bring_front" size={18} />
                </button>
                <button
                  className="icon-btn icon-btn--sm"
                  onClick={() => onArrange("back")}
                  aria-label="Send to back"
                  data-tip="Send to back · ["
                >
                  <Icon name="send_back" size={18} />
                </button>
              </div>
            </div>
          )}
          <button className="btn btn--danger" onClick={onDelete}>
            <Icon name="delete" size={16} /> Delete
          </button>
        </div>
      )}

      {style && selection && selection.kind !== "redaction" && selection.kind !== "annotation" && (
        <div className="props__section">
          <div className="field">
            <span className="field__label label-medium">Font</span>
            <div className="segmented">
              {FONTS.map((f) => (
                <button
                  key={f.key}
                  className={`segmented__btn${style.font === f.key ? " segmented__btn--on" : ""}`}
                  onClick={() => onChangeStyle({ font: f.key })}
                  style={{
                    fontFamily:
                      f.key === "serif"
                        ? "Georgia, serif"
                        : f.key === "mono"
                          ? "ui-monospace, monospace"
                          : "inherit",
                  }}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          <div className="field field--row">
            <span className="field__label label-medium">Style</span>
            <div className="chip-row">
              <button
                className={`chip${style.bold ? " chip--on" : ""}`}
                onClick={() => onChangeStyle({ bold: !style.bold })}
                aria-pressed={style.bold}
                style={{ fontWeight: 700 }}
              >
                B
              </button>
              <button
                className={`chip${style.italic ? " chip--on" : ""}`}
                onClick={() => onChangeStyle({ italic: !style.italic })}
                aria-pressed={style.italic}
                style={{ fontStyle: "italic" }}
              >
                I
              </button>
            </div>
          </div>

          <div className="field">
            <span className="field__label label-medium">
              Size <b>{Math.round(style.size)}</b>
            </span>
            <div className="size-row">
              <button
                className="icon-btn size-step"
                onClick={() => onChangeStyle({ size: clampSize(style.size - 1) })}
                aria-label="Decrease text size"
                data-tip="Smaller"
              >
                <Icon name="remove" size={18} />
              </button>
              <input
                className="slider"
                type="range"
                min={6}
                max={96}
                value={Math.min(96, Math.max(6, Math.round(style.size)))}
                onChange={(e) => onChangeStyle({ size: Number(e.target.value) })}
                aria-label="Text size"
              />
              <button
                className="icon-btn size-step"
                onClick={() => onChangeStyle({ size: clampSize(style.size + 1) })}
                aria-label="Increase text size"
                data-tip="Larger"
              >
                <Icon name="add" size={18} />
              </button>
            </div>
          </div>

          <div className="field field--row">
            <span className="field__label label-medium">Colour</span>
            <ColorField value={style.color} onChange={(c) => onChangeStyle({ color: c })} />
          </div>

          <div className="props__row-actions">
            {onReset && (
              <button className="btn btn--text" onClick={onReset} data-tip="Reset style to default">
                <Icon name="reset" size={16} /> Reset style
              </button>
            )}
            {selection.kind === "textbox" && (
              <button className="btn btn--danger" onClick={onDelete}>
                <Icon name="delete" size={16} /> Delete
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** The page a link goes to, by its number as the reader sees it. A draft while
 * typing, taken on Enter or on leaving the field: "1" on the way to "12" (or
 * to an out-of-range number) mustn't move the link anywhere. */
function LinkPageField({ pos, count, onChange }: { pos: number | null; count: number; onChange: (pos: number) => void }) {
  const shown = pos == null ? "" : String(pos + 1);
  const [draft, setDraft] = useState(shown);
  useEffect(() => setDraft(shown), [shown]);
  const commit = (text: string) => {
    const n = Number(text);
    if (text !== shown && Number.isInteger(n) && n >= 1 && n <= count) onChange(n - 1);
  };
  // The field can go without a blur — a click on the page deselects the link
  // before focus moves, and React sends no blur to an input it removes. What
  // was typed is taken then too. (Keyed by the link, so it's that link's.)
  const latest = useRef(() => {});
  latest.current = () => commit(draft);
  useEffect(() => () => latest.current(), []);
  const out = draft !== "" && !(Number.isInteger(Number(draft)) && Number(draft) >= 1 && Number(draft) <= count);
  const gone = pos == null;
  return (
    <>
      <div className="field">
        <label className="field__label label-medium" htmlFor="link-page">
          Page
        </label>
        <span className="linkpage">
          <input
            id="link-page"
            className="numinput"
            inputMode="numeric"
            value={draft}
            aria-invalid={out || gone || undefined}
            aria-describedby="link-page-note"
            onChange={(e) => setDraft(e.target.value.replace(/[^0-9]/g, ""))}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit(draft);
              else if (e.key === "Escape") setDraft(shown);
              // Ctrl/⌘+S (or any shortcut) acts on the document with what was
              // typed in it: taken now, before the shortcut runs.
              else if (e.ctrlKey || e.metaKey) flushSync(() => commit(draft));
            }}
            onBlur={() => {
              commit(draft);
              // A number that didn't take goes back to the link's page.
              if (out || draft === "") setDraft(shown);
            }}
          />
          <span className="body-medium">of {count}</span>
        </span>
      </div>
      <p
        id="link-page-note"
        className={`props__empty body-small${out || gone ? " props__warn" : ""}`}
        role={out || gone ? "alert" : undefined}
      >
        {gone
          ? "The page this link went to was deleted, so the link is left out of the exported PDF. Pick another page."
          : out
            ? `Pick a page from 1 to ${count}.`
            : `Clicking the box opens page ${pos + 1} in the exported PDF. It follows the page if you move it.`}
      </p>
    </>
  );
}
