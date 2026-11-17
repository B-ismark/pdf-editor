import type { ReactNode } from "react";
import { Icon } from "./Icon";
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
}

interface Props {
  fileName: string;
  pages: PageFacts[];
  pageNumbers: PageNumberOptions | null;
  watermark: WatermarkOptions | null;
  lossless: boolean;
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

const mm = (pt: number) => Math.round((pt / 72) * 25.4);
const inch = (pt: number) => Math.round((pt / 72) * 100) / 100;

/** "A4 · 210 × 297 mm", "Letter, landscape · 11 × 8.5 in", "200 × 300 mm". */
export function paperLabel(width: number, height: number): string {
  const short = Math.min(width, height);
  const long = Math.max(width, height);
  const named = PAPER.find((p) => Math.abs(p.w - short) < 2.5 && Math.abs(p.h - long) < 2.5);
  const landscape = width > height + 0.5;
  const dims = (unit: "mm" | "in") =>
    unit === "mm" ? `${mm(width)} × ${mm(height)} mm` : `${inch(width)} × ${inch(height)} in`;
  if (!named) return dims("mm");
  return `${named.name}${landscape ? ", landscape" : ""} · ${dims(named.unit)}`;
}

const POSITION: Record<NumberPosition, string> = {
  "top-left": "Top left",
  "top-center": "Top centre",
  "top-right": "Top right",
  "bottom-left": "Bottom left",
  "bottom-center": "Bottom centre",
  "bottom-right": "Bottom right",
};

/**
 * The Inspector with nothing selected: the document's own properties.
 *
 * Facts first (what this file is), then the settings that apply to every page
 * and travel with the document (page numbers, watermark), then the one export
 * setting. Commands that make a file live in Export; commands that change the
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
  const sizes = new Set(pages.map((p) => paperLabel(p.width, p.height)));
  const size = sizes.size === 1 ? [...sizes][0] : sizes.size > 1 ? `Mixed · ${sizes.size} sizes` : "—";
  const withText = pages.filter((p) => p.text + p.ocr > 0).length;
  const recognised = pages.some((p) => p.ocr > 0);
  const textStatus =
    count === 0
      ? "—"
      : withText === count
        ? "Searchable on every page"
        : withText === 0
          ? "No text layer — the pages look scanned"
          : `Searchable on ${withText} of ${count} pages`;

  return (
    <div className="props docpanel">
      <div className="props__header">
        <span className="props__title title-medium">Document</span>
        {headerAction}
      </div>

      <dl className="docpanel__facts">
        <div className="docpanel__fact">
          <dt className="label-medium">File</dt>
          <dd className="body-medium docpanel__file" title={fileName}>{fileName}</dd>
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
      {count > 0 && withText < count && (
        <button className="btn btn--tonal docpanel__ocr" onClick={onOcr} disabled={busy}>
          <Icon name="scan_text" size={16} /> Recognise text (OCR)
        </button>
      )}

      <section className="docpanel__group" aria-labelledby="docpanel-every">
        <h3 className="docpanel__label label-medium" id="docpanel-every">On every page</h3>
        <Layer
          icon="page_numbers"
          name="Page numbers"
          value={pageNumbers ? `${POSITION[pageNumbers.position]} · from ${pageNumbers.start}` : null}
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

      <section className="docpanel__group" aria-labelledby="docpanel-export">
        <h3 className="docpanel__label label-medium" id="docpanel-export">When exported</h3>
        <label className="docpanel__toggle">
          <input type="checkbox" checked={lossless} onChange={(e) => onLossless(e.target.checked)} />
          <span>
            <span className="body-medium">Lossless redacted pages</span>
            <span className="docpanel__sub body-small">
              Redacted pages are saved bit-exact, at several times the file size.
            </span>
          </span>
        </label>
      </section>

      {/* The product's one real claim, somewhere calm and permanent. */}
      <p className="doclist__note body-small">
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
  return (
    <div className="docpanel__layer">
      <Icon name={icon} size={18} />
      <span className="docpanel__layertext">
        <span className="body-medium">{name}</span>
        <span className="docpanel__sub body-small">{value ?? "Off"}</span>
      </span>
      <button
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
          onClick={onClear}
          aria-label={`Remove ${name.toLowerCase()}`}
          data-tip={`Remove ${name.toLowerCase()}`}
        >
          <Icon name="delete" size={16} />
        </button>
      )}
    </div>
  );
}
