import {
  AlignHorizontalDistributeCenter,
  AlignHorizontalJustifyCenter,
  AlignHorizontalJustifyEnd,
  AlignHorizontalJustifyStart,
  AlignVerticalDistributeCenter,
  AlignVerticalJustifyCenter,
  AlignVerticalJustifyEnd,
  AlignVerticalJustifyStart,
  ArrowUpRight,
  BadgeCheck,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Command,
  Contrast,
  Copy,
  CopyPlus,
  Download,
  Eraser,
  FileDown,
  FilePlus,
  FileText,
  Highlighter,
  FileClock,
  Image as ImageIcon,
  Images,
  LayoutGrid,
  Link,
  ListOrdered,
  Maximize2,
  Minus,
  Monitor,
  Moon,
  MousePointer2,
  MoreVertical,
  Palette,
  PanelLeftClose,
  PanelLeftOpen,
  PenLine,
  Pencil,
  Plus,
  Redo2,
  RotateCcw,
  RotateCw,
  Save,
  ScanText,
  Search,
  Shrink,
  Signature,
  SlidersHorizontal,
  Slash,
  SquareCheckBig,
  SquareX,
  Square,
  SquarePen,
  Stamp,
  StickyNote,
  Sun,
  Trash2,
  Type,
  Undo2,
  Upload,
  X,
  type LucideIcon,
} from "lucide-react";

interface Props {
  name: string;
  size?: number;
  className?: string;
}

/**
 * Maps the app's semantic icon names to Lucide icon components.
 *
 * **One glyph, one meaning.** The map used to reuse a glyph across unrelated —
 * sometimes opposite — actions, which is worse than a merely plain icon: it
 * teaches the wrong thing. `RotateCw` stood for rotating a page *and* restoring
 * a session *and* saving one *and* resetting a text style; `Shrink` stood for
 * "compress the file" *and* for the switch that turns compression off; `Download`
 * for the PDF and for a .txt sidecar; `Image` for importing one and for exporting
 * the whole document as a set. Each pair now has its own glyph, and the key names
 * say what the icon *means* rather than which picture it happens to be — that's
 * what stopped `tag` (a hashtag) from standing in for "Page numbers".
 *
 * Adding a name here is the only way to get an icon: an unmapped name used to
 * fall back to a bare `Square`, which is how the properties-panel tab shipped
 * showing an empty box where its settings glyph belonged. `icons.spec.ts` now
 * fails the build's test run if any `name=` in `src/` isn't a key below.
 */
const MAP: Record<string, LucideIcon> = {
  // ---- brand ----
  /* `PenLine` is `Pencil` without the tip stroke, so the logo *is* another pencil.
     Left as it is on purpose: it renders inside a filled brand chip at the far
     left, never adjacent to the dock's Draw tool, and a pen is what this product
     is. Noted rather than pretended away. */
  brand: PenLine,

  // ---- tools (the dock) ----
  select_tool: MousePointer2,
  text_tool: Type,
  draw_tool: Pencil,
  sign_tool: Signature,
  /** Redaction is a solid black box — the one icon that reads better filled. */
  redact_tool: Square,
  whiteout_tool: Eraser,
  link_tool: Link,

  // ---- draw sub-tools ----
  highlighter: Highlighter,
  /* No `pen` key: the Pen sub-tool renders `draw_tool`. Lucide's `Pen` and
     `Pencil` are the *same* body path — `Pencil` is `Pen` plus a 4px tip stroke —
     so at 20px they are one picture, and the drawbar sits directly under the dock
     where both would show at once. One glyph for "freehand pen stroke", used for
     the family and for the member that is its default, says something true;
     two indistinguishable glyphs claim a difference that isn't there. */
  rectangle: Square,
  /** A diagonal stroke. `Minus` is the decrement/zoom-out glyph, not a shape. */
  line_tool: Slash,
  arrow_tool: ArrowUpRight,
  // Form-filling marks. Deliberately *not* `Check`/`X` — those already mean
  // "confirmed" and "close this", and a tool that stamps a tick into a
  // checkbox is a third meaning. The boxed glyphs say which one it is.
  check_tool: SquareCheckBig,
  cross_tool: SquareX,
  // The trailing mark on a row that opens a dialog rather than acting at once.
  opens_dialog: ChevronRight,
  sticky_note: StickyNote,

  // ---- history & editing ----
  undo: Undo2,
  redo: Redo2,
  /** Rotate a page clockwise. Distinct from `reset` and `restore`. */
  rotate: RotateCw,
  /** Revert a style to its default. */
  reset: RotateCcw,
  delete: Trash2,
  duplicate: CopyPlus,
  content_copy: Copy,
  /** Appearance (colour / font), as opposed to editing the content itself. */
  palette: Palette,
  /** Edit the content of the selected thing. A pencil *on a surface* — a bare
   * pencil is `draw_tool`, and `SelectionBar` sits over the canvas with the dock
   * still showing, so the two were on screen together as the same drawing. */
  edit: SquarePen,

  // ---- files in & out ----
  upload_file: Upload,
  /** The exported PDF — the primary output. */
  download: Download,
  /** A plain-text sidecar, not the PDF. */
  text_download: FileDown,
  picture_as_pdf: FileText,
  note_add: FilePlus,
  /** Bring one image in. */
  image: ImageIcon,
  /** Send every page out as an image. */
  images: Images,

  // ---- document actions ----
  organize: LayoutGrid,
  page_numbers: ListOrdered,
  watermark: Stamp,
  compress: Shrink,
  /** The inverse of `compress`: keep the redaction raster bit-exact. */
  lossless: Maximize2,
  scan_text: ScanText,
  /** A cryptographic signature, not a drawn one. */
  certificate: BadgeCheck,
  /** Session kept on this device. */
  save_local: Save,
  /** Bring a previous session back. `History` was the obvious pick and the wrong
   * one: it is `RotateCcw` — the `reset` glyph — with a clock hand added, same arc,
   * same arrowhead. A document with a clock says "the file you had, earlier". */
  restore: FileClock,

  // ---- chrome ----
  more_vert: MoreVertical,
  close: X,
  add: Plus,
  remove: Minus,
  chevron_left: ChevronLeft,
  chevron_right: ChevronRight,
  chevron_up: ChevronUp,
  chevron_down: ChevronDown,
  check: Check,
  contrast: Contrast,
  light_mode: Sun,
  dark_mode: Moon,
  system_mode: Monitor,
  search: Search,
  command: Command,
  /** The properties/inspector panel. */
  sliders: SlidersHorizontal,
  /** Stateful pair for the page rail toggle, so the icon reports the outcome. */
  panel_open: PanelLeftOpen,
  panel_close: PanelLeftClose,

  // ---- alignment (multi-select bar) ----
  align_left: AlignHorizontalJustifyStart,
  align_center_h: AlignHorizontalJustifyCenter,
  align_right: AlignHorizontalJustifyEnd,
  align_top: AlignVerticalJustifyStart,
  align_center_v: AlignVerticalJustifyCenter,
  align_bottom: AlignVerticalJustifyEnd,
  distribute_h: AlignHorizontalDistributeCenter,
  distribute_v: AlignVerticalDistributeCenter,
};

/** Icons that read best filled (e.g. the redaction "black box").
 *
 * There used to be a `filled` prop as well, declared in `Props`, passed by the
 * tool dock as `filled={tool === t.key}` — and silently dropped by the component,
 * which never destructured it. It is gone rather than wired up: Lucide glyphs are
 * open stroke paths, so filling `Signature` or `MousePointer2` yields a blob, and
 * the active tool is already stated twice over by the dock's `--on` background and
 * `aria-pressed`. A prop that can only make things worse is not worth honouring. */
const FILLED = new Set(["redact_tool"]);

/**
 * Semantic names that deliberately share one glyph, and why.
 *
 * Sharing is not automatically wrong — but it has to be a decision, not an
 * accident, which is why `icons.spec.ts` fails on any pair that isn't listed here.
 * That check exists because de-duplicating this map *introduced* a duplicate:
 * `edit` and `draw_tool` were both `Pencil`, on screen together, which is the
 * fault the whole exercise was about.
 */
export const SHARED_GLYPHS: Record<string, string> = {
  // A shape tool draws an outlined rectangle; a redaction is a solid black box.
  // Same rectangle, and the fill is the difference — which is the real semantics,
  // not a workaround. `FILLED` is what keeps them apart on screen.
  rectangle: "redact_tool",
  // "Go forward into something" is one meaning wearing two names: the panel's
  // collapse control points you out of it, a row that opens a dialog points you
  // into one. Same chevron, deliberately — the alternative is inventing a
  // second forward arrow, which is worse than sharing this one.
  opens_dialog: "chevron_right",
};

/** The map itself, for the integrity spec — names *and* the glyph each resolves to. */
export const ICON_MAP: Readonly<Record<string, LucideIcon>> = MAP;

/** Every semantic name this app can draw. */
export const ICON_NAMES = Object.keys(MAP);

/** Render a Lucide icon by the app's semantic name. */
export function Icon({ name, size = 24, className }: Props) {
  const C = MAP[name] ?? Square;
  const fill = FILLED.has(name);
  return (
    <C
      size={size}
      className={className}
      strokeWidth={1.75}
      absoluteStrokeWidth
      aria-hidden="true"
      style={{ display: "block", flex: "none", fill: fill ? "currentColor" : "none" }}
    />
  );
}
