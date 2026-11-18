import { useEffect, useRef, type ReactNode } from "react";
import { Icon } from "./Icon";
import { plural } from "../plural";
import { DEFAULT_BATES, batesNumber, slotsOf, uses } from "../pdf/headerFooter";
import type { NumberPosition, PageNumberOptions, WatermarkOptions } from "../pdf/types";

/** One shown page, as far as this panel cares: its size as displayed (points,
 * turn applied) and how much of its text came from the file vs from OCR. */
export interface PageFacts {
  width: number;
  height: number;
  /** Text fragments that came with the file. */
  text: number;
  /** Text fragments recognised by OCR. */
  ocr: number;
  /** OCR has already read this page; offering it again would find nothing new. */
  ocrRead?: boolean;
}

interface Props {
  fileName: string;
  pages: PageFacts[];
  pageNumbers: PageNumberOptions | null;
  watermark: WatermarkOptions | null;
  lossless: boolean;
  /** The document's form, when it has one: fields by name, how many are
   * filled, and whether export flattens it. */
  form: { fields: number; filled: number; flatten: boolean } | null;
  onFormFlatten: (flatten: boolean) => void;
  busy: boolean;
  onEditNumbers: () => void;
  onEditWatermark: () => void;
  onClearNumbers: () => void;
  onClearWatermark: () => void;
  onOcr: () => void;
  onLossless: (on: boolean) => void;
  /** The control that sits at the end of the heading (the Inspector's "Hide panel"). */
  headerAction?: ReactNode;
}

/** Named paper sizes, in points, portrait. Matched within a couple of points:
 * files written by different tools round A4 to 595 or 595.28 × 841.89. */
const PAPER: { name: string; w: number; h: number; unit: "mm" | "in" }[] = [
  { name: "A3", w: 841.89, h: 1190.55, unit: "mm" },
  { name: "A4", w: 595.28, h: 841.89, unit: "mm" },
  { name: "A5", w: 419.53, h: 595.28, unit: "mm" },
  { name: "Letter", w: 612, h: 792, unit: "in" },
  { name: "Legal", w: 612, h: 1008, unit: "in" },
  { name: "Tabloid", w: 792, h: 1224, unit: "in" },
];

/** Millimetres, whole above 10 mm and to a tenth below (a 1 pt page isn't "0 mm"). */
const mm = (pt: number) => {
  const v = (pt / 72) * 25.4;
  return v >= 10 ? Math.round(v) : Math.round(v * 10) / 10;
};
const inch = (pt: number) => Math.round((pt / 72) * 100) / 100;

/** Two sides this close are the same paper: files written by different tools
 * round A4 to 595 or 595.28 × 841.89. */
const SAME = 2.5;

const findPaper = (width: number, height: number) => {
  const short = Math.min(width, height);
  const long = Math.max(width, height);
  return PAPER.find((p) => Math.abs(p.w - short) < SAME && Math.abs(p.h - long) < SAME);
};

type Orientation = "portrait" | "landscape" | "mixed";
const orientationOf = (width: number, height: number): Orientation =>
  width > height + 0.5 ? "landscape" : "portrait";

/** "A4 · 210 × 297 mm", "Letter, landscape · 11 × 8.5 in", "200 × 300 mm".
 * A named paper is given at its nominal size, so a page a point or two off
 * still reads as the A4 it is. With `orientation: "mixed"` the dimensions are
 * given portrait and the label says both. */
export function paperLabel(width: number, height: number, orientation = orientationOf(width, height)): string {
  const named = findPaper(width, height);
  let [w, h] = named ? [named.w, named.h] : [Math.min(width, height), Math.max(width, height)];
  if (orientation === "landscape") [w, h] = [h, w];
  const dims = (unit: "mm" | "in") => (unit === "mm" ? `${mm(w)} × ${mm(h)} mm` : `${inch(w)} × ${inch(h)} in`);
  const orient = orientation === "mixed" ? ", portrait and landscape" : orientation === "landscape" ? ", landscape" : "";
  if (!named) return `${dims("mm")}${orient}`;
  return `${named.name}${orient} · ${dims(named.unit)}`;
}

/** One label for the document's pages. Pages are the same size when they are
 * the same named paper, or (unnamed) their short and long sides each agree
 * within {@link SAME} — whichever way round they are; orientation is then
 * reported separately. */
export function sizeSummary(pages: { width: number; height: number }[]): string {
  if (pages.length === 0) return "—";
  // A named paper is its own group (two pages can each be within SAME of A4
  // and still a little further than that from each other); other sizes group
  // by nearness.
  const groups: { name?: string; short: number; long: number }[] = [];
  for (const p of pages) {
    const short = Math.min(p.width, p.height);
    const long = Math.max(p.width, p.height);
    const name = findPaper(p.width, p.height)?.name;
    const same = (g: (typeof groups)[number]) =>
      name || g.name ? g.name === name : Math.abs(g.short - short) < SAME && Math.abs(g.long - long) < SAME;
    if (!groups.some(same)) groups.push({ name, short, long });
  }
  if (groups.length > 1) return `Mixed · ${groups.length} sizes`;
  const turns = new Set(pages.map((p) => orientationOf(p.width, p.height)));
  const first = pages[0];
  return paperLabel(first.width, first.height, turns.size > 1 ? "mixed" : [...turns][0]);
}

const POSITION: Record<NumberPosition, string> = {
  "top-left": "Top left",
  "top-center": "Top centre",
  "top-right": "Top right",
  "bottom-left": "Bottom left",
  "bottom-center": "Bottom centre",
  "bottom-right": "Bottom right",
};

/** One line for the header & footer: where text sits, and where numbering
 * starts. A plain page number reads as it always has. */
function headerFooterSummary(o: PageNumberOptions): string {
  const slots = slotsOf(o);
  if (slots.length === 1 && slots[0][1].trim().toLowerCase() === "{page}") {
    return `${POSITION[slots[0][0]]} · from ${o.start}`;
  }
  const where = slots.map(([p]) => POSITION[p]).join(", ");
  return uses(o, "{bates}") ? `${where} · Bates ${batesNumber(o.bates ?? DEFAULT_BATES, 0)}` : where;
}

/**
 * The Inspector with nothing selected: the document's own properties.
 *
 * Facts first (what this file is), then the settings that apply to every page
 * and travel with the document (header & footer, watermark), then the one export
 * setting (an app preference, shown here too because it changes what this file
 * exports). Commands that make a file live in Export; commands that change the
 * pages live in the Pages sidebar and the ⋯ menu. This panel only *describes*,
 * and edits what it describes, which is why it can be the panel's resting state
 * without the old problem of controls vanishing the moment you click the page.
 */
export function DocumentPanel({
  fileName,
  pages,
  pageNumbers,
  watermark,
  lossless,
  form,
  onFormFlatten,
  busy,
  onEditNumbers,
  onEditWatermark,
  onClearNumbers,
  onClearWatermark,
  onOcr,
  onLossless,
  headerAction,
}: Props) {
  const count = pages.length;
  const size = sizeSummary(pages);
  const withText = pages.filter((p) => p.text + p.ocr > 0).length;
  const recognised = pages.some((p) => p.ocr > 0);
  // Pages OCR could still help: no text, and not already read.
  const unread = pages.filter((p) => p.text + p.ocr === 0 && !p.ocrRead).length;
  const one = count === 1;
  // No claim that a page is a scan: a blank page, or one drawn only in
  // vector shapes, has no text either (the same rule as the picture hint).
  const textStatus =
    count === 0
      ? "—"
      : withText === count
        ? one
          ? "Searchable"
          : "Searchable on every page"
        : withText === 0
          ? unread === 0
            ? "No text found, even by OCR"
            : one
              ? "No text layer"
              : "No text layer on any page"
          : `Searchable on ${withText} of ${count} pages`;
  // Running OCR from here takes away the button that had focus (it goes once
  // nothing is left to read); the heading takes focus instead of <body>.
  const headingRef = useRef<HTMLHeadingElement>(null);
  const ocrFrom = useRef(false);
  const busyNow = useRef(busy);
  busyNow.current = busy;
  useEffect(() => {
    if (ocrFrom.current && unread === 0) {
      ocrFrom.current = false;
      headingRef.current?.focus();
    }
  }, [unread]);
  // OCR finished with pages still unread (some failed): the button stayed, and
  // so did focus on it — nothing to move.
  useEffect(() => {
    if (!busy && unread > 0) ocrFrom.current = false;
  }, [busy, unread]);

  return (
    <div className="props docpanel">
      <div className="props__header">
        <h2 className="props__title title-medium" ref={headingRef} tabIndex={-1}>
          Document
        </h2>
        {headerAction}
      </div>

      <dl className="docpanel__facts">
        <div className="docpanel__fact">
          <dt className="label-medium">File</dt>
          <dd className="body-medium docpanel__file" data-tip={fileName}>
            {fileName}
          </dd>
        </div>
        <div className="docpanel__fact">
          <dt className="label-medium">Pages</dt>
          <dd className="body-medium">{count}</dd>
        </div>
        <div className="docpanel__fact">
          <dt className="label-medium">Page size</dt>
          <dd className="body-medium">{size}</dd>
        </div>
        <div className="docpanel__fact">
          <dt className="label-medium">Text</dt>
          <dd className="body-medium">
            {textStatus}
            {recognised && <span className="docpanel__sub body-small">Includes text recognised by OCR</span>}
          </dd>
        </div>
      </dl>
      {unread > 0 && (
        // aria-disabled, not disabled: disabling the focused button would
        // drop focus to <body> while OCR runs.
        <button
          className="btn btn--tonal docpanel__ocr"
          aria-disabled={busy || undefined}
          onClick={() => {
            if (busyNow.current) return;
            ocrFrom.current = true;
            onOcr();
          }}
        >
          <Icon name="scan_text" size={16} /> Recognise text (OCR)
        </button>
      )}

      <section className="docpanel__group" aria-labelledby="docpanel-every">
        <h3 className="docpanel__label label-medium" id="docpanel-every">On every page</h3>
        <Layer
          icon="page_numbers"
          name="Header & footer"
          value={pageNumbers && slotsOf(pageNumbers).length ? headerFooterSummary(pageNumbers) : null}
          onEdit={onEditNumbers}
          onClear={onClearNumbers}
        />
        <Layer
          icon="watermark"
          name="Watermark"
          value={watermark ? `“${watermark.text}” · ${Math.round(watermark.opacity * 100)}%` : null}
          onEdit={onEditWatermark}
          onClear={onClearWatermark}
        />
      </section>

      {/* How the form leaves: still a form, or what was typed, printed into
          the page. Stored with the document, so it undoes and travels. */}
      {form && (
        <section className="docpanel__group" aria-labelledby="docpanel-form">
          <h3 className="docpanel__label label-medium" id="docpanel-form">Form</h3>
          <p className="body-medium docpanel__formcount">
            {form.filled} of {plural(form.fields, "field")} filled
          </p>
          <div role="radiogroup" aria-labelledby="docpanel-form">
            <label className="docpanel__toggle">
              <input
                type="radio"
                name="docpanel-form"
                checked={!form.flatten}
                onChange={() => onFormFlatten(false)}
                aria-describedby="docpanel-keep-hint"
              />
              <span>
                <span className="body-medium">Keep fillable</span>
                <span className="docpanel__sub body-small" id="docpanel-keep-hint">
                  The fields stay a form, with your answers in them. Anyone can still change them.
                </span>
              </span>
            </label>
            <label className="docpanel__toggle">
              <input
                type="radio"
                name="docpanel-form"
                checked={form.flatten}
                onChange={() => onFormFlatten(true)}
                aria-describedby="docpanel-flatten-hint"
              />
              <span>
                <span className="body-medium">Flatten into the page</span>
                <span className="docpanel__sub body-small" id="docpanel-flatten-hint">
                  Your answers become part of the page, like print. Nobody can change them as a form.
                </span>
              </span>
            </label>
          </div>
        </section>
      )}

      {/* An app setting, not this document's: it is the same switch as the
          one in the ⋯ menu, and applies to every file exported here. */}
      <section className="docpanel__group" aria-labelledby="docpanel-device">
        <h3 className="docpanel__label label-medium" id="docpanel-device">Export setting · this device</h3>
        <label className="docpanel__toggle">
          <input
            type="checkbox"
            checked={lossless}
            onChange={(e) => onLossless(e.target.checked)}
            aria-describedby="docpanel-lossless-hint"
          />
          <span>
            <span className="body-medium">Lossless redacted pages</span>
            <span className="docpanel__sub body-small" id="docpanel-lossless-hint">
              Redacted pages are saved bit-exact, at several times the file size. Applies to every document you
              export on this device.
            </span>
          </span>
        </label>
      </section>

      {/* The product's one real claim, somewhere calm and permanent. */}
      <p className="docpanel__note body-small">
        Everything here runs in this browser. Your file is never uploaded.
      </p>
    </div>
  );
}

function Layer({
  icon,
  name,
  value,
  onEdit,
  onClear,
}: {
  icon: string;
  name: string;
  value: string | null;
  onEdit: () => void;
  onClear: () => void;
}) {
  // After Remove, the button that had focus is gone; put focus on the one
  // that takes its place (Add) rather than letting it fall to the page.
  const editRef = useRef<HTMLButtonElement>(null);
  const cleared = useRef(false);
  useEffect(() => {
    if (!value && cleared.current) {
      cleared.current = false;
      editRef.current?.focus();
    }
  }, [value]);
  return (
    <div className="docpanel__layer">
      <Icon name={icon} size={18} />
      <span className="docpanel__layertext">
        <span className="body-medium">{name}</span>
        <span className="docpanel__sub body-small">{value ?? "Off"}</span>
      </span>
      <button
        ref={editRef}
        className="btn btn--text docpanel__edit"
        onClick={onEdit}
        aria-haspopup="dialog"
        aria-label={`${value ? "Edit" : "Add"} ${name.toLowerCase()}`}
      >
        {value ? "Edit" : "Add"}
        <Icon name="opens_dialog" size={14} className="opens-mark" />
      </button>
      {value && (
        <button
          className="icon-btn icon-btn--sm"
          onClick={() => {
            cleared.current = true;
            onClear();
          }}
          aria-label={`Remove ${name.toLowerCase()}`}
          data-tip={`Remove ${name.toLowerCase()}`}
        >
          <Icon name="delete" size={16} />
        </button>
      )}
    </div>
  );
}
