/** Abstract font families that map cleanly to PDF standard fonts. */
export type FontKey = "sans" | "serif" | "mono";

/** A resolved text style for a fragment, text box, or new text. */
export interface TextStyle {
  font: FontKey;
  bold: boolean;
  italic: boolean;
  /** Font size in PDF units. */
  size: number;
  /** Hex colour `#rrggbb`. */
  color: string;
}

/** A single editable text fragment extracted from a PDF page. */
export interface TextFragment {
  /** Stable id: `${pageIndex}:${itemIndex}`. */
  id: string;
  pageIndex: number;
  itemIndex: number;
  /** Original text as extracted from the PDF. */
  original: string;
  /** PDF-space transform matrix [a, b, c, d, e, f] (origin bottom-left). */
  transform: number[];
  /** Advance width of the fragment in PDF units (unscaled). */
  width: number;
  /** Glyph height in PDF units (unscaled). */
  height: number;
  /** CSS font-family resolved from the PDF font, used for the overlay. */
  fontFamily: string;
}

/** An interactive AcroForm field detected on a page (text or checkbox). */
export interface FormField {
  /** Unique per widget: `${pageIndex}:field:${i}`. */
  id: string;
  /** AcroForm field name (the export key). */
  name: string;
  pageIndex: number;
  type: "text" | "checkbox";
  /** Widget rect in PDF units (bottom-left origin). */
  rect: { x: number; y: number; width: number; height: number };
  /** Initial value from the source PDF. */
  defaultValue: string | boolean;
  readOnly?: boolean;
  /** Text fields only: single-line comb/limit hints. */
  multiline?: boolean;
}

/** Everything needed to render and edit one page. */
export interface PageData {
  pageIndex: number;
  /** Unscaled page dimensions in PDF units (== points). */
  viewBox: { width: number; height: number };
  fragments: TextFragment[];
  /** Interactive form fields on this page (empty if none). */
  fields: FormField[];
}

/** The parsed document plus its original bytes (needed to re-export). */
export interface LoadedPdf {
  bytes: ArrayBuffer;
  pages: PageData[];
}

/** An edit to an existing fragment: changed text and/or style overrides. */
export interface FragmentEdit {
  /** Current text (may equal the original). */
  text: string;
  /** Style overrides layered on top of the fragment's detected style. */
  style: Partial<TextStyle>;
}

/** Map of fragment id -> edit. */
export type Edits = Record<string, FragmentEdit>;

/** A brand-new text box added by the user. */
export interface TextBox {
  id: string;
  pageIndex: number;
  /** Baseline position in PDF units (origin bottom-left). */
  x: number;
  y: number;
  text: string;
  style: TextStyle;
}

/** A redaction region. On export the whole page is rasterised and this area
 * is painted solid, so the underlying content is genuinely removed.
 *
 * When `cover` is true it's a *whiteout* instead: a plain filled rectangle
 * drawn on top as vector content, WITHOUT rasterising the page. That keeps the
 * rest of the page crisp/selectable, but note the covered content is only
 * hidden, not removed — use a real redaction (cover falsey) to remove data. */
export interface Redaction {
  id: string;
  pageIndex: number;
  /** Rect in PDF units, (x, y) is the bottom-left corner. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Fill colour, hex `#rrggbb`. */
  color: string;
  /** True = whiteout cover (vector, non-destructive); falsey = true redaction. */
  cover?: boolean;
}

/** Freehand / vector annotation sub-tools (under the Draw tool). */
export type AnnotationTool =
  | "highlight"
  | "pen"
  | "rect"
  | "line"
  | "arrow"
  | "note";

/** Style used when drawing new annotations. */
export interface DrawStyle {
  color: string;
  /** Stroke width in PDF units. */
  width: number;
}

interface AnnotBase {
  id: string;
  pageIndex: number;
}

/** A drawn annotation. Coordinates are in PDF units (origin bottom-left).
 * `rotation` (degrees, clockwise in screen space, about the box centre) is
 * optional on the box-shaped kinds; absent/0 means axis-aligned. */
export type Annotation =
  | (AnnotBase & { kind: "highlight"; x: number; y: number; width: number; height: number; color: string; rotation?: number })
  | (AnnotBase & { kind: "rect"; x: number; y: number; width: number; height: number; color: string; strokeWidth: number; rotation?: number })
  | (AnnotBase & { kind: "line" | "arrow"; x1: number; y1: number; x2: number; y2: number; color: string; strokeWidth: number })
  | (AnnotBase & { kind: "pen"; pts: { x: number; y: number }[]; color: string; strokeWidth: number })
  | (AnnotBase & { kind: "note"; x: number; y: number; text: string; color: string });

/** A placed image (signature or picture). Rect is bottom-left in PDF units. */
export interface Stamp {
  id: string;
  pageIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Rotation in degrees, clockwise in screen space, about the box centre. */
  rotation?: number;
  /** PNG/JPEG data URL. */
  dataUrl: string;
}

/** A clickable hyperlink region. Rect is bottom-left in PDF units. */
export interface LinkAnnot {
  id: string;
  pageIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Target URL (http/https/mailto). */
  url: string;
}

/** The full editable document state tracked by the undo/redo history. */
export interface DocState {
  edits: Edits;
  textBoxes: TextBox[];
  redactions: Redaction[];
  annotations: Annotation[];
  stamps: Stamp[];
  /** Optional — absent in older persisted sessions. */
  links?: LinkAnnot[];
  /** Filled AcroForm values, keyed by field name. */
  formValues?: Record<string, string | boolean>;
}

/** Active editing tool. */
export type Tool = "select" | "text" | "redact" | "whiteout" | "draw" | "link";

/** What the properties panel is currently targeting. */
export type Selection =
  | { kind: "fragment"; id: string }
  | { kind: "textbox"; id: string }
  | { kind: "redaction"; id: string }
  | { kind: "annotation"; id: string }
  | { kind: "stamp"; id: string }
  | { kind: "link"; id: string }
  | null;
