import { useEffect, useRef, type ReactNode } from "react";
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
  /** OCR has already read this page; offering it again would find nothing new. */
  ocrRead?: boolean;
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

const findPaper = (width: number, height: number) => {
  const short = Math.min(width, height);
  const long = Math.max(width, height);
  return PAPER.find((p) => Math.abs(p.w - short) < 2.5 && Math.abs(p.h - long) < 2.5);
};

/** "A4 · 210 × 297 mm", "Letter, landscape · 11 × 8.5 in", "200 × 300 mm".
 * With `turned: "mixed"` the orientation is left out and the dimensions are
 * given portrait — the label for a run of pages that are one size, some of
 * them turned. */
export function paperLabel(width: number, height: number, turned?: "mixed"): string {
  const named = findPaper(width, height);
  if (turned === "mixed") [width, height] = [Math.min(width, height), Math.max(width, height)];
  const landscape = width > height + 0.5;
  const dims = (unit: "mm" | "in") =>
    unit === "mm" ? `${mm(width)} × ${mm(height)} mm` : `${inch(width)} × ${inch(height)} in`;
  const orient = turned === "mixed" ? ", portrait and landscape" : landscape ? ", landscape" : "";
  if (!named) return turned === "mixed" ? `${dims("mm")}${orient}` : dims("mm");
  return `${named.name}${orient} · ${dims(named.unit)}`;
}

/** One label for the document's pages. Pages that differ only in which way
 * round they are are the same paper, so they don't count as "Mixed". */
export function sizeSummary(pages: { width: number; height: number }[]): string {
  if (pages.length === 0) return "—";
  const exact = new Set(pages.map((p) => paperLabel(p.width, p.height)));
  if (exact.size === 1) return [...exact][0];
  // The same paper ignoring orientation: compare the short and long sides.
  const key = (p: { width: number; height: number }) => {
    const named = findPaper(p.width, p.height);
    return named ? named.name : `${mm(Math.min(p.width, p.height))}x${mm(Math.max(p.width, p.height))}`;
  };
  const papers = new Set(pages.map(key));
  if (papers.size === 1) return paperLabel(pages[0].width, pages[0].height, "mixed");
  return `Mixed · ${papers.size} sizes`;
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
  const size = sizeSummary(pages);
  const withText = pages.filter((p) => p.text + p.ocr > 0).length;
  const recognised = pages.some((p) => p.ocr > 0);
  // Pages OCR could still help: no text, and not already read.
  const unread = pages.filter((p) => p.text + p.ocr === 0 && !p.ocrRead).length;
  const one = count === 1;
  const textStatus =
    count === 0
      ? "—"
      : withText === count
        ? one
          ? "Searchable"
          : "Searchable on every page"
        : withText === 0
          ? one
            ? "No text layer — the page looks scanned"
            : "No text layer — the pages look scanned"
          : `Searchable on ${withText} of ${count} pages`;

  return (
    <div className="props docpanel">
      <div className="props__header">
        <h2 className="props__title title-medium">Document</h2>
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
