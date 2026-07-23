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

/** Everything needed to render and edit one page. */
export interface PageData {
  pageIndex: number;
  /** Unscaled page dimensions in PDF units (== points). */
  viewBox: { width: number; height: number };
  fragments: TextFragment[];
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
 * is painted solid, so the underlying content is genuinely removed. */
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
}

/** The full editable document state tracked by the undo/redo history. */
export interface DocState {
  edits: Edits;
  textBoxes: TextBox[];
  redactions: Redaction[];
}

/** Active editing tool. */
export type Tool = "select" | "text" | "redact";

/** What the properties panel is currently targeting. */
export type Selection =
  | { kind: "fragment"; id: string }
  | { kind: "textbox"; id: string }
  | { kind: "redaction"; id: string }
  | null;
