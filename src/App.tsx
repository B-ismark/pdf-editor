import { Fragment, Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { PageView, type AnnotSpec } from "./components/PageView";
import { translateAnnotation } from "./components/AnnotationLayer";
import { PropertiesPanel } from "./components/PropertiesPanel";
import { DrawToolbar } from "./components/DrawToolbar";
import { SelectionBar } from "./components/SelectionBar";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { TooltipHost } from "./components/TooltipHost";
import { FindBar } from "./components/FindBar";
import { PageNav } from "./components/PageNav";
import { PageJump } from "./components/PageJump";
import { CommandPalette, type Command } from "./components/CommandPalette";
import { Icon } from "./components/Icon";
import { findMatches, extractText, type FindMatch } from "./pdf/find";
import { boxCX, boxCY } from "./pdf/bbox";
import { findUnsafeCovers, type CoverWarning } from "./pdf/redactionSafety";
import { useAutosave } from "./hooks/useAutosave";
import { downloadBytes, downloadText } from "./download";
import { plural } from "./plural";
import type { PageNumberOptions, WatermarkOptions } from "./pdf/types";
import { useHistory, type HistorySnapshot } from "./hooks/useHistory";
import { usePageArrays, usePageRecords, usePageSets } from "./hooks/usePageBuckets";
import { DocTabs } from "./components/DocTabs";
import { useMediaQuery } from "./hooks/useMediaQuery";
import { useFragmentFont } from "./hooks/usePageFonts";
import { peekPageFonts, subscribeFonts } from "./pdf/fontInfo";
import { useFragmentColors } from "./hooks/usePageColors";
import { usePersistentState, usePersistentFlag } from "./hooks/usePrefs";
import { useTheme } from "./hooks/useTheme";
import { useViewport } from "./hooks/useViewport";
import { loadPdf, looksLikePdf, mayBeEncrypted, releaseDoc } from "./pdf/loader";
import { clearEngineCache } from "./pdf/engineCache";
import { prepareImageStamp } from "./pdf/imageStamp";
import {
  OVERLAYS,
  OVERLAY_LIST,
  addOverlay,
  applyOverlayDeltas,
  reorderAnnotations,
  findOverlay,
  overlayExists,
  overlaysInSet,
  removeOverlay,
  removeOverlaysByIds,
  type OverlayKind,
} from "./overlays";
import { DEFAULT_STYLE, isFragmentModified, resolveFragmentStyle } from "./pdf/style";
import { keepOnPage, onPage, placeAt, placedSize, rotatedExtent } from "./pdf/placement";

// On-demand modals — each pulls in heavy code (pdf-lib, canvas rendering) that
// isn't needed until the user opens it, so they're code-split out of the
// initial bundle.
const Organize = lazy(() =>
  import("./components/Organize").then((m) => ({ default: m.Organize })),
);
const SignatureDialog = lazy(() =>
  import("./components/SignatureDialog").then((m) => ({ default: m.SignatureDialog })),
);
const FinishDialog = lazy(() =>
  import("./components/FinishDialog").then((m) => ({ default: m.FinishDialog })),
);
const CompressDialog = lazy(() =>
  import("./components/CompressDialog").then((m) => ({ default: m.CompressDialog })),
);
const PasswordDialog = lazy(() =>
  import("./components/PasswordDialog").then((m) => ({ default: m.PasswordDialog })),
);
const SignCertDialog = lazy(() =>
  import("./components/SignCertDialog").then((m) => ({ default: m.SignCertDialog })),
);
import type {
  Annotation,
  AnnotationTool,
  DocState,
  Edits,
  DrawStyle,
  LinkAnnot,
  LoadedPdf,
  Redaction,
  Selection,
  Stamp,
  TextBox,
  TextFragment,
  TextStyle,
  Tool,
} from "./pdf/types";

// "exporting" is reserved for the primary Download action (drives the Download
// button's label); "working" is every other long op (OCR, compress, watermark,
// page numbers, image export) so they show the busy indicator without hijacking
// the Download button.
type Status = "idle" | "loading" | "ready" | "exporting" | "working" | "error";
type NavKey = Tool | "sign";

const EMPTY_DOC: DocState = { edits: {}, textBoxes: [], redactions: [], annotations: [], stamps: [] };

// Stable identities for the "field absent from an older DocState" case. Fresh
// `[]` / `{}` literals here would be a new object on every render, which defeats
// the memo on PageView and re-renders every page of the document per keystroke.
const NO_LINKS: LinkAnnot[] = [];
const NO_FORM_VALUES: Record<string, string | boolean> = {};

/** What a page with nothing of a kind on it gets: one shared identity each, so
 * its props stay referentially equal and the memo'd `PageView` skips it. */
const NO_ITEMS: never[] = [];
const NO_EDITS: Edits = {};
const NO_IDS: Set<string> = new Set();
const pageItems = <T,>(map: Map<number, T[]>, pageIndex: number): T[] =>
  map.get(pageIndex) ?? NO_ITEMS;

/** Turn a raw thrown error into plain-language guidance (audit #12). */
function pdfOpenError(err: unknown): string {
  const s = String(err).toLowerCase();
  if (s.includes("password") || s.includes("encrypt"))
    return "This PDF is encrypted in a way this app can't open.";
  if (
    s.includes("invalid") ||
    s.includes("corrupt") ||
    s.includes("structure") ||
    s.includes("xref") ||
    s.includes("not a pdf")
  )
    return "This file doesn't look like a valid PDF, or it may be damaged.";
  return "Something went wrong opening this PDF. Try another file.";
}

/** A document/finishing action rendered identically across the overflow menu,
 * the Inspector's document panel, and the command palette — one definition, so
 * the three surfaces can't drift apart. */
interface DocAction {
  id: string;
  group: "organise" | "text" | "finish";
  label: string;
  icon: string;
  keywords?: string;
  /** Set when running this opens something rather than doing it. Declared on
   * the action so every surface that lists it — the Inspector, the ⋯ menu, the
   * command palette — marks it the same way; the alternative is three call
   * sites deciding independently, which is how the menu and the panel drifted
   * apart the first time. */
  opens?: "dialog";
  run: () => void;
}

const DOC_GROUPS: { key: DocAction["group"]; label: string }[] = [
  { key: "organise", label: "Organise" },
  { key: "text", label: "Text" },
  { key: "finish", label: "Finish" },
];

/** The Inspector's two jobs, each with its own tab. */
type PanelTab = "document" | "properties";
const PANEL_TABS: { key: PanelTab; label: string; icon: string }[] = [
  { key: "document", label: "Document", icon: "picture_as_pdf" },
  { key: "properties", label: "Properties", icon: "sliders" },
];

const TOOLS: { key: NavKey; label: string; icon: string; opens?: "toolbar" | "dialog" }[] = [
  { key: "select", label: "Select", icon: "select_tool" },
  { key: "text", label: "Add text", icon: "text_tool" },
  { key: "draw", label: "Draw", icon: "draw_tool", opens: "toolbar" },
  { key: "sign", label: "Sign", icon: "sign_tool", opens: "dialog" },
  { key: "redact", label: "Redact", icon: "redact_tool" },
  { key: "whiteout", label: "Whiteout", icon: "whiteout_tool" },
  { key: "link", label: "Link", icon: "link_tool" },
];

// Single-key tool shortcuts (ignored while typing or when a modal is open).
const TOOL_KEYS: Record<string, NavKey> = {
  v: "select",
  t: "text",
  d: "draw",
  s: "sign",
  r: "redact",
  w: "whiteout",
  l: "link",
};
const TOOL_SHORTCUT: Record<NavKey, string> = {
  select: "V",
  text: "T",
  draw: "D",
  sign: "S",
  redact: "R",
  whiteout: "W",
  link: "L",
};

/** True when focus is in a text-entry context, so single-key shortcuts and
 * arrow-nudge must not hijack the keystroke. */
function isTypingTarget(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  return (
    el.isContentEditable ||
    el.tagName === "INPUT" ||
    el.tagName === "TEXTAREA" ||
    el.tagName === "SELECT"
  );
}

/** A document open in the workspace. For the one in front, `history`,
 * `view` and `changeCount` are stale — the live values are in `App`'s state —
 * and are refreshed whenever it is parked. */
interface OpenDoc {
  id: string;
  fileName: string;
  pdf: LoadedPdf;
  /** Its whole undo history, or null for a document that was never edited. */
  history: HistorySnapshot<DocState> | null;
  /** Where it was scrolled to and zoomed, so coming back lands in place. */
  view: { zoom: number; ry: number } | null;
  changeCount: number;
  /** Changes already baked into `pdf.bytes` (an Organise, a merge) that the
   * doc state can't see. They still make the document unsaved work. */
  baked: number;
  /** What was last downloaded, if anything (see {@link SavedMark}). */
  saved: SavedMark | null;
  /** Opened with a password. Its unlocked copy is never stored on the device:
   * the user locked that file for a reason, and a plain copy in the browser's
   * storage would undo it. */
  locked: boolean;
  /** Has changes since its last download (or ever, if never downloaded).
   * Stale for the tab in front, like `changeCount`. */
  unsaved: boolean;
}

/**
 * The state a document was in when it was last downloaded. The document is
 * saved while its live state *is* this one — the same object, since every edit
 * makes a new one — so an edit after downloading makes it unsaved again, and
 * undoing back to what was downloaded makes it saved again. Without this the
 * change counter survived a download, and the leave and close prompts warned
 * that changes already in the downloaded file would be lost.
 */
interface SavedMark {
  doc: DocState;
  baked: number;
}

/** Open documents at once. Each holds its source bytes and a pdf.js parse in
 * memory; past a handful, a phone runs out before the user runs out of tabs.
 * Ten is generous for real work and keeps the worst case bounded. */
const MAX_TABS = 10;

/** True when a modal dialog (Organize, Finish, Compress, Command Palette, …)
 * is open. Global editing shortcuts must not act on the hidden canvas beneath
 * it. */
function aModalIsOpen(): boolean {
  return !!document.querySelector('[aria-modal="true"]');
}

/**
 * A stamp the page can hold. The page's MediaBox cuts off whatever hangs past
 * it in the downloaded file, which the overlay used to show in full. A move
 * stops at the edge; a resize or rotation that would grow it off the page is
 * refused (the handle stops), while one that shrinks it always goes through, so
 * a stamp already over the edge from an older session can still be fixed.
 */
function keepStampOnPage(prev: Stamp, next: Stamp, page: { width: number; height: number } | undefined): Stamp {
  if (!page) return next;
  const { width: pw, height: ph } = page;
  const sized = next.width !== prev.width || next.height !== prev.height || (next.rotation ?? 0) !== (prev.rotation ?? 0);
  if (sized) {
    if (onPage(next, pw, ph)) return next;
    const a = rotatedExtent(prev.width, prev.height, prev.rotation);
    const b = rotatedExtent(next.width, next.height, next.rotation);
    return b.w > a.w + 0.01 || b.h > a.h + 0.01 ? prev : next;
  }
  return { ...next, ...keepOnPage(next, pw, ph) };
}

/** Pull the given stamps back onto their page. The paths that move overlays
 * in bulk (paste/duplicate, align, distribute) shift them by a delta without
 * going through `onChangeStamp`, so this is their page-edge guard. */
function keepStampsOnPage(
  d: DocState,
  ids: Iterable<string>,
  pages: { viewBox: { width: number; height: number } }[] | undefined,
): DocState {
  const want = new Set(ids);
  if (!pages || !d.stamps.some((s) => want.has(s.id))) return d;
  return {
    ...d,
    stamps: d.stamps.map((s) => {
      const vb = want.has(s.id) ? pages[s.pageIndex]?.viewBox : undefined;
      return vb ? { ...s, ...keepOnPage(s, vb.width, vb.height) } : s;
    }),
  };
}

/** Shrink one shared move so every stamp in the group stays on its page — the
 * group moves as a block and stops when its first stamp reaches an edge,
 * rather than each stamp stopping on its own and the layout shearing. */
function limitGroupMove(
  d: DocState,
  ids: Set<string>,
  dx: number,
  dy: number,
  pages: { viewBox: { width: number; height: number } }[] | undefined,
): { dx: number; dy: number } {
  if (!pages) return { dx, dy };
  let ax = dx;
  let ay = dy;
  for (const s of d.stamps) {
    const vb = ids.has(s.id) ? pages[s.pageIndex]?.viewBox : undefined;
    if (!vb) continue;
    const k = keepOnPage({ ...s, x: s.x + dx, y: s.y + dy }, vb.width, vb.height);
    const cx = k.x - s.x;
    const cy = k.y - s.y;
    if (dx > 0) ax = Math.min(ax, Math.max(0, cx));
    else if (dx < 0) ax = Math.max(ax, Math.min(0, cx));
    if (dy > 0) ay = Math.min(ay, Math.max(0, cy));
    else if (dy < 0) ay = Math.max(ay, Math.min(0, cy));
  }
  return { dx: ax, dy: ay };
}

/** The prompt while an image or signature waits to be placed. A finger taps and
 * has no Esc key; a pointer clicks, and can back out with Esc. */
function placeHint(what: string): string {
  const touch = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
  return touch ? `Tap where ${what} goes.` : `Click where ${what} goes. Esc cancels.`;
}

export function App() {
  const [pdf, setPdf] = useState<LoadedPdf | null>(null);
  const [fileName, setFileName] = useState("document.pdf");
  // ---- Workspace: every open document, one tab each ----
  // The document in front lives in `pdf` / `fileName` / `doc` exactly as it did
  // when there was only ever one, so nothing that edits it had to change. The
  // others are *parked* here: their bytes, their whole undo history, and where
  // they were scrolled to. Switching parks the front one and unparks another, so
  // opening a second PDF no longer costs the first one its edits.
  const [tabs, setTabs] = useState<OpenDoc[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  /** The front document's {@link OpenDoc.baked}. */
  const [baked, setBaked] = useState(0);
  const [savedMark, setSavedMark] = useState<SavedMark | null>(null);
  const [locked, setLocked] = useState(false);
  /** Organise pulled pages from a password-opened tab (see its `onApply`). */
  const organizeTookLocked = useRef(false);
  const [pwAsk, setPwAsk] = useState<{
    name: string;
    wrong: boolean;
    checking: boolean;
    answer: (pw: string | null) => void;
  } | null>(null);
  const tabCounter = useRef(0);
  /** Ids of tabs being opened whose `setTabs` hasn't rendered yet, so the tab
   * cap counts them: a loop of opens (a restore, a multi-file drop) reads the
   * tab list faster than React re-renders it. */
  const pendingTabs = useRef(new Set<string>());
  const [confirmCloseId, setConfirmCloseId] = useState<string | null>(null);
  const [tool, setTool] = useState<Tool>("select");
  const docHistory = useHistory<DocState>(EMPTY_DOC);
  // The history's verbs, as one object whose identity never changes. Every
  // method is a stable `useCallback`, so the dozens of callbacks that only *write*
  // the document can depend on `[doc]` and stay stable across keystrokes — which
  // is what lets the memo'd `PageView`s skip re-rendering. Anything that *reads*
  // the document goes through `docHistory.state` and must list it as a dependency.
  const doc = useMemo(
    () => ({ set: docHistory.set, undo: docHistory.undo, redo: docHistory.redo, reset: docHistory.reset, snapshot: docHistory.snapshot, restore: docHistory.restore }),
    [docHistory.set, docHistory.undo, docHistory.redo, docHistory.reset, docHistory.snapshot, docHistory.restore],
  );
  const { edits, textBoxes, redactions, annotations, stamps } = docHistory.state;
  const links = docHistory.state.links ?? NO_LINKS;
  const formValues = docHistory.state.formValues ?? NO_FORM_VALUES;
  const pageNumbers = docHistory.state.pageNumbers ?? null;
  const watermark = docHistory.state.watermark ?? null;
  // Remembered across sessions so the user's choices aren't reset each time.
  const [drawTool, setDrawTool] = usePersistentState("pref.drawTool", "highlight") as [
    AnnotationTool,
    React.Dispatch<React.SetStateAction<AnnotationTool>>,
  ];
  const [drawStyle, setDrawStyle] = usePersistentState<DrawStyle>("pref.drawStyle", {
    color: "#f4c400",
    width: 3,
  });
  // Last text style the user picked — new text boxes inherit it.
  const [lastTextStyle, setLastTextStyle] = usePersistentState<TextStyle>(
    "pref.textStyle",
    DEFAULT_STYLE,
  );
  // Dim the (always-white) page canvas to cut glare, esp. in dark mode.
  // Preview-only — never affects the exported PDF.
  const [dimPages, setDimPages] = usePersistentFlag("pref.dimPages", false);
  // Autosave keeps a copy of the open document in IndexedDB so a crash or an
  // accidental reload doesn't lose the work. That is a real copy of a possibly
  // sensitive file sitting on the device, so it has to be the user's call — and
  // switching it off has to actually erase what's already stored, not just stop
  // adding to it.
  const [autosaveOn, setAutosaveOn] = usePersistentFlag("pref.autosave", true);
  // Redacted pages are flattened to an image, and that image is the whole page.
  // It ships as JPEG-or-PNG-whichever-is-smaller, which is several times
  // smaller on scans; this makes the raster bit-exact instead, for anyone who
  // needs the output to survive later analysis unaltered.
  const [losslessRaster, setLosslessRaster] = usePersistentFlag("pref.losslessRaster", false);
  const [sigOpen, setSigOpen] = useState(false);
  const [finishTab, setFinishTab] = useState<"numbers" | "watermark" | null>(null);
  const [pendingStamp, setPendingStamp] = useState<{ dataUrl: string; w: number; h: number } | null>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  // Always-mounted picker for "Open another PDF" (the dropzone's own input only
  // exists on the empty state), so the action opens a file dialog directly
  // rather than first clearing to the empty screen.
  const openInputRef = useRef<HTMLInputElement>(null);
  const [selection, setSelection] = useState<Selection>(null);
  // Mobile: the full properties sheet only opens on demand (via the selection
  // bar), and text elements only become editable in an explicit edit mode —
  // so a single tap selects without a sheet covering the object or the
  // keyboard popping up. (`compact`/`sheetOpen` defined below, after isWide.)
  const [sheetOpen, setSheetOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [autoFocusId, setAutoFocusId] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState("");
  // When a long, cancellable operation is running (OCR), this holds its
  // cancel handler so the busy indicator can offer a Cancel button.
  const [onCancel, setOnCancel] = useState<null | (() => void)>(null);
  const [dragging, setDragging] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [organizeOpen, setOrganizeOpen] = useState(false);
  const [coverWarn, setCoverWarn] = useState<CoverWarning | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findActive, setFindActive] = useState(0);
  const [navOpen, setNavOpen] = useState(false);
  // The draw sub-toolbar is a disclosure, not a fixture: it opens with the Draw
  // tool, collapses to its handle once a sub-tool is picked, and the dock's Draw
  // button toggles it. 60px of chrome across the bottom of the page has to be
  // dismissible without leaving the tool.
  const [drawbarOpen, setDrawbarOpen] = useState(true);
  const [cmdOpen, setCmdOpen] = useState(false);
  // The zoom pill's page chip is a number field (go to page).
  const [pageJumpOpen, setPageJumpOpen] = useState(false);
  const [multi, setMulti] = useState<string[]>([]);
  // Adaptive Workspace: the right Inspector collapses to an edge tab (desktop)
  // to hand the canvas maximum room; it's never empty (properties when
  // something is selected, document/finishing actions otherwise).
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [panelTab, setPanelTab] = useState<PanelTab>("document");
  const [compressOpen, setCompressOpen] = useState(false);
  const [signCertOpen, setSignCertOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  const menuListRef = useRef<HTMLDivElement>(null);
  const counter = useRef(0);
  const nextId = (prefix: string) => `${prefix}-${counter.current++}`;

  const vp = useViewport();
  const theme = useTheme();
  const { restorable, save: saveSession, clear: clearSession, discard: discardSession, dismissRestore, adopt: adoptSession } = useAutosave();
  /** Set by closing a tab: the next autosave runs at once, so a discarded
   * document's stored copy is gone before a reload can bring it back. */
  const flushSave = useRef(false);
  // >=600px gets the persistent side panel + tool rail (Material Medium+);
  // <600px is the compact phone layout (contextual selection bar + on-demand
  // sheet, `sheetOpen` state above).
  const isWide = useMediaQuery("(min-width: 600px)");
  const compact = !isWide;
  // Stamps have no properties panel (edited directly on the canvas), so they
  // don't drive the sheet/side panel.
  const panelSelection = selection && selection.kind !== "stamp" ? selection : null;
  const themeIcon =
    theme.mode === "light" ? "light_mode" : theme.mode === "dark" ? "dark_mode" : "system_mode";
  const themeName =
    theme.mode === "light" ? "Light" : theme.mode === "dark" ? "Dark" : "System";
  const themeLabel = `${themeName} theme`;

  // Selecting something moves the panel to Properties — that is what you asked
  // for by selecting. Deselecting does *not* move it back: the panel would then
  // flip on every click into empty space, and Properties has a real empty state
  // for exactly this. One tab switch per intent, none per accident.
  //
  // This covers the paths that don't go through `onSelect` above — adding a text
  // box, a redaction or a link all select the new object so it can be styled
  // straight away, and Find selects its match. `onSelect` handles the one case
  // this can't see: re-clicking what is already selected.
  const selectedKey = panelSelection ? `${panelSelection.kind}-${panelSelection.id}` : null;
  useEffect(() => {
    if (selectedKey) setPanelTab("properties");
  }, [selectedKey]);

  /** Roving focus across the panel tabs (WAI-ARIA tabs pattern).
   *
   * "Roving" is the whole point: the unselected tabs are `tabIndex={-1}`, so
   * moving the selection without moving focus leaves the keyboard on a button
   * that is no longer in the tab order — the next Tab jumps somewhere
   * unrelated, and Space/Enter act on a tab that isn't the selected one. The
   * focus call is what makes this the pattern rather than a lookalike. */
  const onPanelTabKeyDown = useCallback((e: ReactKeyboardEvent<HTMLElement>) => {
    const delta = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!delta && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    const list = e.currentTarget.closest("[role=tablist]") ?? document;
    const i = PANEL_TABS.findIndex((t) => t.key === panelTab);
    const next =
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? PANEL_TABS.length - 1
          : (i + delta + PANEL_TABS.length) % PANEL_TABS.length;
    const key = PANEL_TABS[next].key;
    setPanelTab(key);
    // Now, not after a frame: the next keystroke has to land on the tab this one
    // moved to. Focusing it while React has yet to flip `tabIndex` to 0 is fine
    // — `focus()` doesn't consult the tab order, and the attribute lands in the
    // same commit as `aria-selected`.
    list.querySelector<HTMLElement>(`#panel-tab-${key}`)?.focus();
  }, [panelTab]);

  // Per-page buckets. Each page keeps the same bucket object until something on
  // *that* page changes, so typing on one page re-renders only that page.
  const boxesByPage = usePageArrays(textBoxes);
  const redactionsByPage = usePageArrays(redactions);
  const annotationsByPage = usePageArrays(annotations);
  const stampsByPage = usePageArrays(stamps);
  const linksByPage = usePageArrays(links);

  const fragmentById = useMemo(() => {
    const map = new Map<string, TextFragment>();
    pdf?.pages.forEach((p) => p.fragments.forEach((f) => map.set(f.id, f)));
    return map;
  }, [pdf]);

  // Which page an id (fragment or overlay) lives on — for handing each page
  // only its own edits, selection, focus and multi-selection.
  const overlayPage = useMemo(() => {
    const map = new Map<string, number>();
    for (const list of [textBoxes, redactions, annotations, stamps, links])
      for (const o of list as { id: string; pageIndex: number }[]) map.set(o.id, o.pageIndex);
    return map;
  }, [textBoxes, redactions, annotations, stamps, links]);
  const pageOf = useCallback(
    (id: string) => fragmentById.get(id)?.pageIndex ?? overlayPage.get(id),
    [fragmentById, overlayPage],
  );
  // Fragment edits only need the fragment map, so a text-box keystroke (which
  // changes `overlayPage`) doesn't re-bucket every fragment edit.
  const fragmentPageOf = useCallback((id: string) => fragmentById.get(id)?.pageIndex, [fragmentById]);
  const editsByPage = usePageRecords(edits, fragmentPageOf);

  const editedFragmentCount = useMemo(
    () =>
      pdf
        ? [...fragmentById.values()].filter((f) =>
            isFragmentModified(f, edits[f.id]),
          ).length
        : 0,
    [pdf, fragmentById, edits],
  );
  const changeCount =
    editedFragmentCount + textBoxes.length + redactions.length + annotations.length + stamps.length + links.length + Object.keys(formValues).length +
    (pageNumbers ? 1 : 0) + (watermark ? 1 : 0) + baked;
  const isSaved = savedMark != null && savedMark.doc === docHistory.state && savedMark.baked === baked;
  /** Work that only exists in this window: what the leave/close prompts guard. */
  const unsaved = changeCount > 0 && !isSaved;
  /** The current state as a saved mark — read when a download *starts*, so an
   * edit made while the file builds isn't counted as downloaded. */
  const markNow = useRef<SavedMark>({ doc: docHistory.state, baked });
  markNow.current = { doc: docHistory.state, baked };

  // A long-running operation is in flight (opening a file, exporting, OCR,
  // finishing ops). Drives the busy spinner + prevents overlapping actions.
  const busy = status === "loading" || status === "exporting" || status === "working";
  const busyRef = useRef(busy);
  busyRef.current = busy;

  // ---- Find in document (Ctrl/⌘+F) ----
  // The document's own face for a fragment, when its page has been harvested —
  // match boxes are measured in it (see `findMatches`).
  // Pages are harvested as they paint, so the faces change under the find bar;
  // re-measure when they do (only while it's open — every page paint would
  // otherwise re-render the app), so the highlight is the box "Redact all"
  // will draw.
  const [fontsVersion, setFontsVersion] = useState(0);
  useEffect(() => {
    if (!findOpen) return;
    return subscribeFonts(() => setFontsVersion((v) => v + 1));
  }, [findOpen]);
  const fontFor = useCallback(
    (f: TextFragment) => (pdf ? peekPageFonts(pdf.bytes, f.pageIndex).get(f.itemIndex) ?? null : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fontsVersion is the store's version
    [pdf, fontsVersion],
  );
  const matches: FindMatch[] = useMemo(
    () => (pdf && findOpen && findQuery ? findMatches(pdf.pages, edits, findQuery, fontFor) : []),
    [pdf, findOpen, findQuery, edits, fontFor],
  );
  const matchesByPage = useMemo(() => {
    const m = new Map<number, FindMatch[]>();
    for (const hit of matches) {
      const arr = m.get(hit.pageIndex) ?? [];
      arr.push(hit);
      m.set(hit.pageIndex, arr);
    }
    return m;
  }, [matches]);
  const activeMatch = matches[findActive] ?? null;

  // Keep the active index in range as the result set changes.
  useEffect(() => {
    if (findActive > matches.length - 1) setFindActive(matches.length ? matches.length - 1 : 0);
  }, [matches.length, findActive]);

  // Scroll the active match into view.
  //
  // This used to centre the *page* the match is on, which is only right when a
  // page is shorter than the viewport. At fit-width an A4 page is taller than
  // most viewports, so a match near its top or bottom stayed off screen — and
  // stepping through several matches on one page looked like Next doing nothing.
  // Position the match itself instead, a third of the way down, which also keeps
  // it clear of the find bar pinned across the top of the viewer.
  //
  // Computed from the match's PDF coordinates rather than by querying the
  // highlight element, because the overlay for a far-off page isn't mounted
  // (rendering is windowed) — but the page *frame* always is, since layout stays
  // eager, so its rect is reliable.
  useEffect(() => {
    if (!activeMatch || !pdf) return;
    const scroller = document.querySelector<HTMLElement>(".viewer__scroll");
    const pageEl = document.querySelector<HTMLElement>(
      `[data-page-index="${activeMatch.pageIndex}"]`,
    );
    const page = pdf.pages[activeMatch.pageIndex];
    if (!scroller || !pageEl || !page) return;
    const yInPage = (page.viewBox.height - (activeMatch.y + activeMatch.height)) * vp.scale;
    const offsetFromScrollTop =
      pageEl.getBoundingClientRect().top - scroller.getBoundingClientRect().top + yInPage;
    scroller.scrollTo({
      top: scroller.scrollTop + offsetFromScrollTop - scroller.clientHeight / 3,
      behavior: "smooth",
    });
  }, [activeMatch, pdf, vp.scale]);

  const nextMatch = useCallback(() => {
    setFindActive((i) => (matches.length ? (i + 1) % matches.length : 0));
  }, [matches.length]);
  const prevMatch = useCallback(() => {
    setFindActive((i) => (matches.length ? (i - 1 + matches.length) % matches.length : 0));
  }, [matches.length]);
  const openFind = useCallback(() => {
    setSelection(null);
    setFindActive(0);
    setFindOpen(true);
  }, []);
  const closeFind = useCallback(() => {
    setFindOpen(false);
    setFindQuery("");
  }, []);

  /** Redact every current search match (one undo step). */
  const redactAllMatches = useCallback(() => {
    if (matches.length === 0 || !pdf) return;
    // Exactly the boxes on screen: `matches` re-measures as the document's
    // fonts are harvested, so what's highlighted is what gets redacted.
    const hits = matches;
    doc.set((d) => ({
      ...d,
      redactions: [
        ...d.redactions,
        ...hits.map((m) => ({
          id: nextId("rd"),
          pageIndex: m.pageIndex,
          x: m.x,
          y: m.y,
          width: m.width,
          height: m.height,
          color: "#000000",
        })),
      ],
    }));
    const n = hits.length;
    setMessage(`Redacted ${n} match${n === 1 ? "" : "es"} of “${findQuery}”.`);
    setStatus("ready");
    closeFind();
  }, [matches, pdf, doc, findQuery, closeFind]);

  /** Copy all document text to the clipboard. */
  const copyAllText = useCallback(async () => {
    if (!pdf) return;
    setMenuOpen(false);
    try {
      await navigator.clipboard.writeText(extractText(pdf.pages, edits));
      setStatus("ready");
      setMessage("Document text copied to clipboard.");
    } catch {
      setStatus("error");
      setMessage("Couldn't copy — your browser blocked clipboard access.");
    }
  }, [pdf, edits]);

  /** Download all document text as a .txt file. */
  const exportTextFile = useCallback(() => {
    if (!pdf) return;
    setMenuOpen(false);
    downloadText(extractText(pdf.pages, edits), fileName.replace(/\.pdf$/i, "") + ".txt");
    setStatus("ready");
    setMessage("Text exported.");
  }, [pdf, edits, fileName]);

  // ---- Autosave to IndexedDB (debounced) + one-time restore ----
  // Every tab is saved, not just the one in front: a parked tab's state comes
  // from its parked history, the front one's from the live one.
  useEffect(() => {
    if (!autosaveOn) return;
    const entries = tabs.map((t) =>
      t.id === activeId && pdf
        ? { id: t.id, fileName, bytes: pdf.bytes, doc: docHistory.state, hasChanges: changeCount > 0 && !locked, baked }
        : {
            id: t.id,
            fileName: t.fileName,
            bytes: t.pdf.bytes,
            doc: t.history ? t.history.entries[t.history.index] : EMPTY_DOC,
            // A clean tab is never stored; a password-opened one is treated as clean.
            hasChanges: t.changeCount > 0 && !t.locked,
            baked: t.baked,
          },
    );
    saveSession(entries, activeId, flushSave.current);
    flushSave.current = false;
  }, [tabs, activeId, pdf, fileName, docHistory.state, changeCount, baked, locked, saveSession, autosaveOn]);

  /** Toggle the on-device session copy. Turning it off erases whatever is
   * already stored — the point of the switch is that no copy remains. That
   * includes the cached OCR engine: it holds no document of the user's, but a
   * switch that left 1.4 MB of wasm behind would be a switch that lies. */
  const toggleAutosave = useCallback(() => {
    setAutosaveOn((on) => {
      if (on) {
        void clearSession();
        void clearEngineCache();
        setStatus("ready");
        setMessage("Stopped saving a copy on this device, and deleted the stored one.");
      } else {
        setStatus("ready");
        setMessage("Saving a copy on this device so a reload can't lose your work.");
      }
      return !on;
    });
  }, [setAutosaveOn, clearSession]);

  /** Erase the offered previous session without opening it. */
  const discardRestorable = useCallback(() => {
    void discardSession();
    setStatus("ready");
    setMessage("Deleted the saved session.");
  }, [discardSession]);

  /** Clear everything that belongs to the document in front rather than to the
   * app — selection, find, an armed tool — before another document takes its
   * place. A selection id from one file means nothing (or something else) in
   * the next. */
  const resetDocUi = useCallback(() => {
    setSelection(null);
    setMulti([]);
    setEditingId(null);
    setAutoFocusId(null);
    setPendingStamp(null);
    setPageJumpOpen(false);
    setFindOpen(false);
    setFindQuery("");
    setSheetOpen(false);
    // A fresh document has nothing selected, so leaving the panel on
    // Properties would greet it with an empty state while the actions it can
    // actually use sit one unmentioned click away. The tab is per-document.
    setPanelTab("document");
    setTool("select");
  }, []);

  /** The document in front, packed up to go into the background. */
  const parkActive = useCallback(
    (list: OpenDoc[]): OpenDoc[] =>
      list.map((t) =>
        t.id === activeId && pdf
          ? {
              ...t,
              pdf,
              fileName,
              history: doc.snapshot(),
              view: vp.captureView(),
              changeCount,
              baked,
              saved: savedMark,
              unsaved,
              locked,
            }
          : t,
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeId, pdf, fileName, doc.snapshot, vp.captureView, changeCount, baked, savedMark, unsaved, locked],
  );

  /** Bring a parked document to the front. */
  const showDoc = useCallback(
    (t: OpenDoc) => {
      resetDocUi();
      setPdf(t.pdf);
      setFileName(t.fileName);
      setActiveId(t.id);
      setBaked(t.baked);
      setSavedMark(t.saved);
      setLocked(t.locked);
      if (t.history) doc.restore(t.history);
      else doc.reset(EMPTY_DOC);
      vp.setPageWidth(Math.max(...t.pdf.pages.map((p) => p.viewBox.width), 1));
      // A document seen for the first time starts at its first page, not at
      // whatever scroll position the one before it was left at.
      vp.restoreView(t.view ?? { zoom: 1, ry: 0 });
    },
    [resetDocUi, doc, vp],
  );

  const switchTo = useCallback(
    (id: string) => {
      if (id === activeId || busy) return;
      const target = tabs.find((t) => t.id === id);
      if (!target) return;
      setTabs(parkActive(tabs));
      showDoc(target);
    },
    [activeId, busy, tabs, parkActive, showDoc],
  );

  /**
   * Load bytes as a document.
   *
   * By default it opens in a **new tab** beside the current one, which keeps
   * everything the current one has. `replace` is for the operations that
   * rebuild *this* document (organise, page numbers, watermark): their output
   * is the same document with its edits baked in, so it takes the tab's place.
   */
  // `openBytes` is called in loops — several dropped files, a restored
  // workspace — and each call has to see the tab the *previous* call opened, not
  // the one that was in front when the loop began. A stale closure there parked
  // nothing, so a restored document went into the background counted as clean
  // and its stored copy was then deleted as unneeded.
  const liveTabs = useRef({ tabs, activeId, pdf, parkActive, showDoc });
  liveTabs.current = { tabs, activeId, pdf, parkActive, showDoc };
  for (const t of tabs) pendingTabs.current.delete(t.id);

  const openBytes = useCallback(
    async (
      bytes: ArrayBuffer,
      name: string,
      note?: string,
      seedDoc?: DocState,
      opts: { replace?: boolean; id?: string; quiet?: boolean; baked?: number; locked?: boolean } = {},
    ): Promise<OpenDoc | null> => {
      const { tabs, activeId } = liveTabs.current;
      const replacing = opts.replace && activeId != null;
      const id = replacing ? activeId! : opts.id ?? `doc-${Date.now().toString(36)}-${tabCounter.current++}`;
      if (!replacing) {
        // Tabs already rendered, plus opens still on their way into the list.
        const counted = new Set([...tabs.map((t) => t.id), ...pendingTabs.current]);
        if (counted.size >= MAX_TABS) {
          setStatus("error");
          setMessage(`${MAX_TABS} documents are open — close one to open another.`);
          return null;
        }
        pendingTabs.current.add(id);
      }
      setStatus("loading");
      setMessage(`Loading ${name}…`);
      try {
        const loaded = await loadPdf(bytes);
        // Re-read after the await: renders have happened since.
        const { activeId, pdf, parkActive, showDoc } = liveTabs.current;
        const fresh: OpenDoc = {
          id,
          fileName: name,
          pdf: loaded,
          history: seedDoc ? { entries: [seedDoc], index: 0, lastKey: null } : null,
          view: null,
          changeCount: 0,
          baked: opts.baked ?? 0,
          saved: null,
          unsaved: false,
          // A rebuild of a password-opened document is still that document.
          locked: opts.locked ?? (replacing ? tabs.find((t) => t.id === id)?.locked ?? false : false),
        };
        if (replacing) {
          const old = pdf;
          setTabs((list) => list.map((t) => (t.id === id ? fresh : t)));
          showDoc(fresh);
          // The superseded parse is unreachable now; let the worker drop it.
          if (old && old.bytes !== loaded.bytes) releaseDoc(old.bytes);
        } else {
          setTabs((list) => {
            const parked = parkActive(list);
            const at = parked.findIndex((t) => t.id === activeId);
            const next = parked.slice();
            next.splice(at < 0 ? next.length : at + 1, 0, fresh);
            return next;
          });
          showDoc(fresh);
        }
        setStatus("ready");
        if (!opts.quiet) {
          const total = loaded.pages.reduce((n, p) => n + p.fragments.length, 0);
          setMessage(note ?? `${plural(loaded.pages.length, "page")} · ${plural(total, "text fragment")}`);
        }
        return fresh;
      } catch (err) {
        pendingTabs.current.delete(id);
        setStatus("error");
        setMessage(pdfOpenError(err));
        return null;
      }
    },
    [],
  );

  /**
   * Decrypt an encrypted file once, before anything else sees it — asking for
   * its password if it has one, and again after a wrong one. Null means the
   * user cancelled. A file with only an owner password opens without asking:
   * it's decrypted all the same, or its download would come out unreadable.
   */
  const unlock = useCallback(
    async (bytes: ArrayBuffer, name: string): Promise<{ bytes: ArrayBuffer; locked: boolean } | null> => {
      const { unlockPdf } = await import("./pdf/decrypt");
      let password = "";
      // Cancel pressed while a try is "Checking…": the attempt can't be
      // interrupted, so its result is thrown away instead of opened.
      let cancelled = false;
      try {
        for (;;) {
          const r = await unlockPdf(bytes, password);
          if (cancelled) return null;
          if (r.kind === "unlocked") return { bytes: r.bytes, locked: r.password };
          // Not encrypted after all, or encrypted beyond what the decrypter
          // reads: open the original and let pdf.js say what it can.
          if (r.kind !== "needs-password") return { bytes, locked: false };
          setStatus("loading");
          setMessage(`"${name}" is password-protected.`);
          // The dialog stays up between tries (it shows "checking", then the
          // wrong-password state), so what was typed is still there to fix.
          const wrong = password !== "";
          const next = await new Promise<string | null>((answer) =>
            setPwAsk({ name, wrong, checking: false, answer }),
          );
          if (next == null) return null;
          setPwAsk((a) =>
            a && {
              ...a,
              checking: true,
              answer: (pw) => {
                if (pw != null) return;
                cancelled = true;
                setPwAsk(null);
              },
            },
          );
          password = next;
        }
      } finally {
        setPwAsk(null);
      }
    },
    [],
  );

  const openFile = useCallback(
    async (file: File): Promise<boolean> => {
      // Show feedback immediately — reading a large file into memory and
      // sniffing it can take a beat, and a drag-drop gives no other signal.
      setStatus("loading");
      setMessage(`Opening ${file.name}…`);
      let bytes: ArrayBuffer;
      try {
        bytes = await file.arrayBuffer();
      } catch {
        setStatus("error");
        setMessage(`Couldn't read "${file.name}".`);
        return false;
      }
      // Trust the content, not the extension or MIME type: an HTML page or
      // image renamed to .pdf (or dropped with an empty MIME type) must be
      // rejected here rather than failing deep inside pdf.js.
      if (!looksLikePdf(bytes)) {
        setStatus("error");
        setMessage(`"${file.name}" isn't a PDF file. Please choose a .pdf document.`);
        return false;
      }
      let locked = false;
      if (mayBeEncrypted(bytes)) {
        let opened: Awaited<ReturnType<typeof unlock>>;
        try {
          opened = await unlock(bytes, file.name);
        } catch {
          // Whatever went wrong inside the decrypter, the app mustn't be left
          // on a spinner that ignores every later open.
          opened = { bytes, locked: false };
        }
        if (!opened) {
          setStatus(liveTabs.current.pdf ? "ready" : "idle");
          setMessage(`Didn't open "${file.name}".`);
          return false;
        }
        ({ bytes, locked } = opened);
      }
      return (await openBytes(bytes, file.name, undefined, undefined, { locked })) != null;
    },
    [openBytes, unlock],
  );

  // Open the OS file picker. What's picked opens in new tabs, so this no longer
  // needs a "discard your changes?" gate — it used to replace the document, and
  // the only way to work on two files was to finish one first.
  const openAnother = useCallback(() => {
    setMenuOpen(false);
    openInputRef.current?.click();
  }, []);

  /** Open several files, each in its own tab (a multi-select pick or a drop). */
  const openFiles = useCallback(
    async (files: FileList | File[] | null | undefined) => {
      // A dialog (Organise, Compress, Finish…) acts on whatever document is in
      // front when it's confirmed, and so does an operation still running (OCR,
      // export). A file dropped then opens a tab that comes to the front *behind*
      // it — and the dialog's result lands in, or is named after, the wrong
      // document. So nothing opens until they're done.
      if (aModalIsOpen() || busyRef.current) {
        setMessage("Finish what's open first, then drop the file again.");
        return;
      }
      const list = [...(files ?? [])];
      const failed: string[] = [];
      for (const f of list) if (!(await openFile(f))) failed.push(f.name);
      if (list.length > 1) {
        // Each open writes its own status over the last, so a failure early in
        // the list was being covered by the next file's success — "Opened 2
        // documents" with one tab on screen. Report the whole batch instead.
        const opened = list.length - failed.length;
        if (failed.length === 0) {
          setStatus("ready");
          setMessage(`Opened ${plural(opened, "document")} in tabs.`);
        } else {
          setStatus("error");
          const names = failed.map((n) => `"${n}"`).join(", ");
          setMessage(
            opened > 0
              ? `Opened ${plural(opened, "document")}; couldn't open ${names}.`
              : `Couldn't open ${names}.`,
          );
        }
      }
    },
    [openFile],
  );

  const restoreSession = useCallback(async () => {
    if (!restorable) return;
    const s = restorable;
    // Bump the id counter past any restored ids so new objects don't collide.
    // Object ids are unique across the whole workspace, not per document, so
    // every restored document counts.
    for (const d of s.docs) {
      const ids = [
        ...d.doc.textBoxes.map((b) => b.id),
        ...d.doc.redactions.map((r) => r.id),
        ...d.doc.annotations.map((a) => a.id),
        ...d.doc.stamps.map((st) => st.id),
        ...(d.doc.links ?? []).map((l) => l.id),
      ];
      for (const id of ids) {
        const n = Number(id.split("-").pop());
        if (Number.isFinite(n) && n + 1 > counter.current) counter.current = n + 1;
      }
    }
    dismissRestore();
    const opened: OpenDoc[] = [];
    for (const d of s.docs) {
      // Same ids as before, so their stored copies are updated in place rather
      // than duplicated alongside.
      const t = await openBytes(d.bytes, d.fileName, undefined, d.doc, { id: d.id, quiet: true, baked: d.baked });
      // Adopt only what actually opened. A slot adopted but not open looks
      // like a closed tab to the next save, which deletes it — so a document
      // past the tab cap, or one that failed to parse, was erased for good.
      if (t) {
        opened.push(t);
        adoptSession([t.id]);
      }
    }
    const left = s.docs.length - opened.length;
    if (opened.length === 0) return;
    if (left > 0) {
      setStatus("error");
      setMessage(
        `Restored ${plural(opened.length, "document")}; ${plural(left, "other")} couldn't be opened and ${left === 1 ? "is" : "are"} still saved on this device.`,
      );
    } else {
      setStatus("ready");
      setMessage(
        opened.length === 1 ? "Session restored." : `Session restored · ${plural(opened.length, "document")}.`,
      );
    }
    pendingActivate.current = s.activeId;
  }, [restorable, dismissRestore, adoptSession, openBytes]);

  // Restoring opens every document in turn, which leaves the *last* one in
  // front; the one that was in front when the session was saved should be. The
  // switch waits a commit so it parks the last-opened tab with its real state.
  const pendingActivate = useRef<string | null>(null);
  useEffect(() => {
    const id = pendingActivate.current;
    if (!id || busy) return;
    pendingActivate.current = null;
    if (id !== activeId && tabs.some((t) => t.id === id)) switchTo(id);
  }, [tabs, activeId, busy, switchTo]);

  const toAB = (u8: Uint8Array): ArrayBuffer => {
    const ab = new ArrayBuffer(u8.byteLength);
    new Uint8Array(ab).set(u8);
    return ab;
  };

  /** Export the current edits to fresh bytes so finishing ops build on them. */
  const bakeCurrent = useCallback(async (): Promise<ArrayBuffer> => {
    const { exportPdf } = await import("./pdf/exporter");
    const out = await exportPdf(pdf!, { edits, textBoxes, redactions, annotations, stamps, links, formValues, pageNumbers, watermark, losslessRaster });
    return toAB(out);
    // `losslessRaster` is read for the export, so it has to be a dependency —
    // otherwise this captures whatever it was when `pdf` last changed.
  }, [pdf, edits, textBoxes, redactions, annotations, stamps, links, formValues, pageNumbers, watermark, losslessRaster]);

  // Page numbers and watermark are document-wide layers stored in DocState and
  // drawn at export time (see exporter.ts). Setting them is a normal, undoable
  // edit — no document rebuild, no lost history, and they preview live.
  const applyNumbers = useCallback(
    (opts: PageNumberOptions) => {
      setFinishTab(null);
      doc.set((d) => ({ ...d, pageNumbers: opts }));
      setStatus("ready");
      setMessage("Page numbers added.");
    },
    [doc],
  );

  const clearNumbers = useCallback(() => {
    setFinishTab(null);
    doc.set((d) => ({ ...d, pageNumbers: null }));
    setStatus("ready");
    setMessage("Page numbers removed.");
  }, [doc]);

  const applyWatermark = useCallback(
    (opts: WatermarkOptions) => {
      setFinishTab(null);
      doc.set((d) => ({ ...d, watermark: opts }));
      setStatus("ready");
      setMessage("Watermark applied.");
    },
    [doc],
  );

  const clearWatermark = useCallback(() => {
    setFinishTab(null);
    doc.set((d) => ({ ...d, watermark: null }));
    setStatus("ready");
    setMessage("Watermark removed.");
  }, [doc]);

  // Compression is a two-step flow so the user can see the resulting size
  // before committing: estimate (bake once, then compress at the chosen preset)
  // then download the previewed bytes. The baked bytes don't depend on the
  // preset, so they're cached across estimates for the life of the dialog.
  const compressBaked = useRef<{ buf: ArrayBuffer; sizes: { width: number; height: number }[]; before: number } | null>(null);
  const compressOut = useRef<{ bytes: Uint8Array; lossless: boolean; helped: boolean; before: number; after: number } | null>(null);
  // Cached text-preserving (image-optimised) result — computing it decodes and
  // re-encodes images, so don't redo it each time "Keep text" is re-selected.
  const compressLossless = useRef<{ bytes: Uint8Array; size: number } | null>(null);

  /** The file the compress dialog was opened on: the download is named after
   * the document it baked, not whatever is in front when it's clicked. */
  const compressName = useRef("document.pdf");
  const openCompress = useCallback(() => {
    setSelection(null);
    compressName.current = fileName;
    compressBaked.current = null;
    compressOut.current = null;
    compressLossless.current = null;
    setCompressOpen(true);
  }, [fileName]);

  const estimateCompress = useCallback(
    async (preset: import("./components/CompressDialog").CompressPreset): Promise<import("./components/CompressDialog").CompressEstimate> => {
      if (!pdf) throw new Error("No document");
      if (!compressBaked.current) {
        // The baked document already re-serialises through pdf-lib with object
        // streams and stripped metadata, keeping selectable text — that IS the
        // lossless result, and the size to beat for the rasterising presets.
        const baked = await bakeCurrent();
        const sizes = pdf.pages.map((p) => ({ width: p.viewBox.width, height: p.viewBox.height }));
        compressBaked.current = { buf: baked, sizes, before: baked.byteLength };
      }
      const { buf, sizes, before } = compressBaked.current;
      if (preset.kind === "lossless") {
        // Text stays selectable; oversized images (JPEG or flate) are
        // downsampled and re-encoded in place.
        if (!compressLossless.current) {
          const { optimizeKeepingText } = await import("./pdf/finishOps");
          const { bytes: optimized } = await optimizeKeepingText(buf, { maxDim: 1600, quality: 0.8 });
          // Never hand back something larger than the plain baked version.
          const best = optimized.byteLength < before ? optimized : new Uint8Array(buf);
          compressLossless.current = { bytes: best, size: best.byteLength };
        }
        const { bytes, size } = compressLossless.current;
        compressOut.current = { bytes, lossless: true, helped: size < before, before, after: size };
        return { kind: "lossless", size };
      }
      const { compressPdf } = await import("./pdf/finishOps");
      const compressed = await compressPdf(buf, sizes, preset.opts);
      const after = compressed.byteLength;
      // Rasterising a text/vector PDF can produce a *larger* file. Keep whichever
      // is smaller so "compress" never hands back a bigger download.
      const helped = after < before;
      compressOut.current = { bytes: helped ? compressed : new Uint8Array(buf), lossless: false, helped, before, after };
      return { kind: "raster", before, after, helped };
    },
    [pdf, bakeCurrent],
  );

  const downloadCompress = useCallback(() => {
    const out = compressOut.current;
    if (!out) return;
    setCompressOpen(false);
    const base = compressName.current.replace(/\.pdf$/i, "");
    const suffix = out.lossless ? "-optimized.pdf" : out.helped ? "-compressed.pdf" : ".pdf";
    downloadBytes(out.bytes, base + suffix);
    // A smaller copy is still a copy of everything: the dialog is modal, so
    // nothing has changed since it was built.
    setSavedMark(markNow.current);
    setStatus("ready");
    const fmt = (n: number) => (n < 1_000_000 ? Math.round(n / 1000) + " KB" : (n / 1_000_000).toFixed(2) + " MB");
    setMessage(
      out.lossless
        ? `Optimized, text kept — ${fmt(out.before)}.`
        : out.helped
          ? `Compressed — ${fmt(out.before)} → ${fmt(out.after)} (${Math.round((1 - out.after / out.before) * 100)}% smaller).`
          : `Already compact — kept the text version at ${fmt(out.before)}.`,
    );
    compressBaked.current = null;
    compressOut.current = null;
    compressLossless.current = null;
  }, [downloadBytes]);

  // Digitally sign the finished document (adbe.pkcs7.detached). Bakes current
  // edits first — signing is the last step, since any later change invalidates
  // the signature. Errors propagate to the dialog so it can show them.
  const signWithCert = useCallback(
    async (
      identity: import("./pdf/sign").SignIdentity,
      meta: import("./pdf/sign").SignMeta,
    ): Promise<void> => {
      if (!pdf) throw new Error("No document");
      const mark = markNow.current;
      const baked = await bakeCurrent();
      const { signPdf } = await import("./pdf/sign");
      const signed = await signPdf(baked, identity, meta);
      downloadBytes(signed, fileName.replace(/\.pdf$/i, "") + "-signed.pdf");
      setSavedMark(mark);
      setStatus("ready");
      setMessage("Signed the document and downloaded it.");
    },
    [pdf, bakeCurrent, fileName, downloadBytes],
  );

  const runOcr = useCallback(async () => {
    if (!pdf) return;
    setMenuOpen(false);
    const ctrl = new AbortController();
    setOnCancel(() => () => ctrl.abort());
    setStatus("working");
    setMessage("Reading text (OCR)…");
    try {
      const { ocrPages } = await import("./pdf/ocr");
      const { perPage, pagesFailed } = await ocrPages(
        pdf.bytes,
        pdf.pages,
        (p, t) =>
          setMessage(p === 0 ? "Starting OCR engine…" : `Reading text… page ${p}/${t}`),
        ctrl.signal,
        // Keeping the wasm engine on the device is on-device storage, so it
        // follows the same switch as the session copy.
        { cacheEngine: autosaveOn },
      );
      let added = 0;
      const pages = pdf.pages.map((pg) => {
        const extra = perPage.get(pg.pageIndex) ?? [];
        added += extra.length;
        // Replace any prior OCR layer so re-running doesn't duplicate words.
        const kept = pg.fragments.filter((f) => !f.id.startsWith("ocr:"));
        return { ...pg, fragments: [...kept, ...extra] };
      });
      // Into the document that was read, even if another is in front by now:
      // the pages are that file's, not whichever tab finished first.
      setPdf((cur) => (cur && cur.bytes === pdf.bytes ? { ...cur, pages } : cur));
      setTabs((list) => list.map((t) => (t.pdf.bytes === pdf.bytes && t.id !== liveTabs.current.activeId ? { ...t, pdf: { ...t.pdf, pages } } : t)));
      setStatus("ready");
      const partial = pagesFailed > 0 ? ` (${plural(pagesFailed, "page")} couldn't be read)` : "";
      setMessage(
        added > 0
          ? `OCR added ${added} words — now searchable and redactable.${partial}`
          : `No recognisable text found.${partial}`,
      );
    } catch (err) {
      const name = (err as Error)?.name;
      if (name === "OcrCancelled") {
        setStatus("idle");
        setMessage("OCR cancelled.");
      } else if (name === "OcrAssetsMissing") {
        console.warn("OCR assets missing — run `npm run setup-ocr` to enable on-device text recognition.");
        setStatus("error");
        setMessage("Text recognition isn't available in this version.");
      } else {
        // Surface the real cause in the console — the UI message is deliberately
        // generic, but we need the underlying error to diagnose field reports.
        console.error("OCR failed:", err);
        const timedOut = /timed out/i.test((err as Error)?.message ?? "");
        setStatus("error");
        setMessage(
          timedOut
            ? "OCR timed out on this document — it may be very large or image-heavy. Try again, or split it into fewer pages."
            : "OCR couldn't finish on this document. It may be very large or image-heavy — try again.",
        );
      }
    } finally {
      setOnCancel(null);
    }
    // `autosaveOn` is read for `cacheEngine`, so it has to be a dependency —
    // without it the callback keeps whatever value was current when `pdf` last
    // changed, and OCR goes on caching the engine after the switch is off.
  }, [pdf, autosaveOn]);

  const exportImages = useCallback(async () => {
    if (!pdf) return;
    setMenuOpen(false);
    setStatus("working");
    setMessage("Rendering images…");
    try {
      const baked = await bakeCurrent();
      const { renderImages } = await import("./pdf/finishOps");
      const urls = await renderImages(baked, pdf.pages.length, 2, (p, t) =>
        setMessage(`Rendering images… page ${p}/${t}`),
      );
      const base = fileName.replace(/\.pdf$/i, "");
      const { makeZip, dataUrlToBytes } = await import("./pdf/zip");
      if (urls.length === 1) {
        // A single page downloads as a plain PNG — friendlier than a one-file zip.
        downloadBytes(dataUrlToBytes(urls[0]), `${base}.png`, "image/png");
        setStatus("ready");
        setMessage("Exported 1 image.");
      } else {
        // Bundle every page into one ZIP so no download is blocked and the
        // success message is honest (browsers block the 2nd+ auto-download).
        setMessage("Packaging images…");
        const zip = makeZip(urls.map((u, i) => ({ name: `${base}-p${i + 1}.png`, data: dataUrlToBytes(u) })));
        downloadBytes(zip, `${base}-images.zip`, "application/zip");
        setStatus("ready");
        setMessage(`Exported ${urls.length} images as a ZIP.`);
      }
    } catch {
      setStatus("error");
      setMessage("Couldn't export images. Please try again.");
    }
  }, [pdf, bakeCurrent, fileName, downloadBytes]);

  // Single source of truth for the document/finishing actions. The overflow
  // menu, the document panel, and the command palette all render from this —
  // add an action once and every surface picks it up.
  const docActions = useMemo<DocAction[]>(
    () => [
      { id: "organize", group: "organise", label: "Organise pages", icon: "organize", keywords: "reorder rotate merge split extract", opens: "dialog", run: () => { setSelection(null); setOrganizeOpen(true); } },
      { id: "image", group: "organise", label: "Add image", icon: "image", keywords: "picture photo stamp", opens: "dialog", run: () => imageInputRef.current?.click() },
      { id: "ocr", group: "text", label: "Recognise text (OCR)", icon: "scan_text", keywords: "scan searchable image ocr", run: runOcr },
      { id: "copytext", group: "text", label: "Copy all text", icon: "content_copy", keywords: "clipboard", run: copyAllText },
      { id: "exporttext", group: "text", label: "Export text (.txt)", icon: "text_download", keywords: "save txt plain", run: exportTextFile },
      { id: "numbers", group: "finish", label: "Page numbers", icon: "page_numbers", keywords: "pagination folio", opens: "dialog", run: () => { setSelection(null); setFinishTab("numbers"); } },
      { id: "watermark", group: "finish", label: "Watermark", icon: "watermark", keywords: "draft stamp", opens: "dialog", run: () => { setSelection(null); setFinishTab("watermark"); } },
      { id: "eximg", group: "finish", label: "Export as images", icon: "images", keywords: "png zip export", run: exportImages },
      { id: "compress", group: "finish", label: "Compress PDF", icon: "compress", keywords: "shrink reduce size optimise", opens: "dialog", run: openCompress },
      { id: "sign-cert", group: "finish", label: "Sign with certificate", icon: "certificate", keywords: "digital signature pades certificate p12 sign", opens: "dialog", run: () => { setSelection(null); setSignCertOpen(true); } },
    ],
    [runOcr, copyAllText, exportTextFile, exportImages, openCompress],
  );

  const onChangeFragmentText = useCallback(
    (id: string, text: string) => {
      doc.set(
        (d) => ({
          ...d,
          edits: { ...d.edits, [id]: { text, style: d.edits[id]?.style ?? {} } },
        }),
        `ftext-${id}`,
      );
    },
    [doc],
  );

  const onChangeTextBoxText = useCallback(
    (id: string, text: string) => {
      doc.set(
        (d) => ({
          ...d,
          textBoxes: d.textBoxes.map((b) => (b.id === id ? { ...b, text } : b)),
        }),
        `btext-${id}`,
      );
    },
    [doc],
  );

  const onChangeTextBox = useCallback(
    (id: string, patch: Partial<TextBox>, key: string) => {
      doc.set(
        (d) => ({
          ...d,
          textBoxes: d.textBoxes.map((b) => (b.id === id ? { ...b, ...patch } : b)),
        }),
        key,
      );
    },
    [doc],
  );

  const onChangeRedaction = useCallback(
    (id: string, patch: Partial<Redaction>, key: string) => {
      doc.set(
        (d) => ({
          ...d,
          redactions: d.redactions.map((r) => (r.id === id ? { ...r, ...patch } : r)),
        }),
        key,
      );
    },
    [doc],
  );

  const onAddTextBox = useCallback(
    (pageIndex: number, x: number, y: number) => {
      const id = nextId("tb");
      const box: TextBox = { id, pageIndex, x, y, text: "", style: { ...lastTextStyle } };
      doc.set((d) => ({ ...d, textBoxes: [...d.textBoxes, box] }));
      setTool("select");
      setSelection({ kind: "textbox", id });
      setEditingId(id); // immediately editable (mobile edit mode)
      setAutoFocusId(id);
    },
    [doc, lastTextStyle],
  );

  const onAddRedaction = useCallback(
    (pageIndex: number, x: number, y: number, width: number, height: number, cover?: boolean) => {
      const id = nextId("rd");
      doc.set((d) => ({
        ...d,
        redactions: [
          ...d.redactions,
          { id, pageIndex, x, y, width, height, color: cover ? "#ffffff" : "#000000", cover },
        ],
      }));
      // Switch to Select so the new redaction can be moved/resized/recoloured
      // right away (in Redact mode it wouldn't be interactive).
      setTool("select");
      setSelection({ kind: "redaction", id });
    },
    [doc],
  );

  const onAddLink = useCallback(
    (pageIndex: number, x: number, y: number, width: number, height: number) => {
      const id = nextId("ln");
      doc.set((d) => ({
        ...d,
        links: [...(d.links ?? []), { id, pageIndex, x, y, width, height, url: "" }],
      }));
      setTool("select");
      setSelection({ kind: "link", id });
    },
    [doc],
  );

  const onChangeLink = useCallback(
    (id: string, patch: Partial<LinkAnnot>, key: string) => {
      doc.set(
        (d) => ({
          ...d,
          links: (d.links ?? []).map((l) => (l.id === id ? { ...l, ...patch } : l)),
        }),
        key,
      );
    },
    [doc],
  );

  const onChangeFormValue = useCallback(
    (name: string, value: string | boolean) => {
      doc.set(
        (d) => ({ ...d, formValues: { ...(d.formValues ?? {}), [name]: value } }),
        `form-${name}`,
      );
    },
    [doc],
  );

  const onAddAnnotation = useCallback(
    (pageIndex: number, spec: AnnotSpec) => {
      const id = nextId("an");
      const annot = { ...spec, id, pageIndex } as Annotation;
      doc.set((d) => ({ ...d, annotations: [...d.annotations, annot] }));
      if (spec.kind === "note") {
        setTool("select");
        setSelection({ kind: "annotation", id });
        setEditingId(id); // immediately editable (mobile edit mode)
        setAutoFocusId(id);
      }
    },
    [doc],
  );

  const onChangeNoteText = useCallback(
    (id: string, text: string) => {
      doc.set(
        (d) => ({
          ...d,
          annotations: d.annotations.map((a) =>
            a.id === id && a.kind === "note" ? { ...a, text } : a,
          ),
        }),
        `note-${id}`,
      );
    },
    [doc],
  );

  const onMoveAnnotation = useCallback(
    (annot: Annotation, key: string) => {
      doc.set(
        (d) => ({
          ...d,
          annotations: d.annotations.map((a) => (a.id === annot.id ? annot : a)),
        }),
        key,
      );
    },
    [doc],
  );

  const onChangeAnnotation = useCallback(
    (patch: { color?: string; strokeWidth?: number }) => {
      if (selection?.kind !== "annotation") return;
      const id = selection.id;
      const onlyColour = Object.keys(patch).length === 1 && patch.color !== undefined;
      doc.set(
        (d) => ({
          ...d,
          annotations: d.annotations.map((a) =>
            a.id === id ? ({ ...a, ...patch } as Annotation) : a,
          ),
        }),
        onlyColour ? `acolor-${id}` : `awidth-${id}`,
      );
    },
    [selection, doc],
  );

  // Said once each time a piece of text first crosses the edge, not per key.
  const onSpill = useCallback(() => {
    setMessage("Text runs past the page edge. The download cuts it off there.");
  }, []);

  const onPlaceStamp = useCallback(
    (pageIndex: number, cx: number, cy: number) => {
      const page = pdf?.pages[pageIndex];
      if (!pendingStamp || !page) return;
      // Centred on the click and kept on the page — the same `placeAt` the
      // page's ghost preview draws with, so what you aimed is what you get.
      const { width: pw, height: ph } = page.viewBox;
      const box = placeAt(placedSize(pendingStamp, pw, ph), cx, cy, pw, ph);
      const id = nextId("st");
      const stamp: Stamp = { id, pageIndex, ...box, dataUrl: pendingStamp.dataUrl };
      doc.set((d) => ({ ...d, stamps: [...d.stamps, stamp] }));
      setPendingStamp(null);
      // Switch to Select so the just-placed stamp is immediately movable/
      // resizable, regardless of which tool was active before signing.
      setTool("select");
      setSelection({ kind: "stamp", id });
      setMessage("");
    },
    [pendingStamp, doc, pdf],
  );

  const onChangeStamp = useCallback(
    (id: string, patch: Partial<Stamp>, key: string) => {
      doc.set(
        (d) => ({
          ...d,
          stamps: d.stamps.map((s) => (s.id === id ? keepStampOnPage(s, { ...s, ...patch }, pdf?.pages[s.pageIndex]?.viewBox) : s)),
        }),
        key,
      );
    },
    [doc, pdf],
  );

  const onDeleteStamp = useCallback(
    (id: string) => {
      doc.set((d) => ({ ...d, stamps: d.stamps.filter((s) => s.id !== id) }));
      setSelection((sel) => (sel?.kind === "stamp" && sel.id === id ? null : sel));
    },
    [doc],
  );

  const startImagePlacement = useCallback(async (file: File) => {
    setStatus("working");
    setMessage(`Reading ${file.name}…`);
    try {
      const stamp = await prepareImageStamp(file);
      setPendingStamp(stamp);
      setStatus("ready");
      setMessage(placeHint("the image"));
    } catch (err) {
      // Previously an unreadable or unsupported file (HEIC, SVG, a renamed
      // non-image) fell through `img.onerror` with no handler at all: no stamp,
      // no message, nothing to distinguish it from a mis-tap.
      setStatus("error");
      setMessage(
        (err as Error)?.message ??
          "Couldn't read that image. Try a PNG or JPEG instead.",
      );
    }
  }, []);

  const onSelect = useCallback((sel: Selection) => {
    setAutoFocusId(null);
    setEditingId(null);
    setSheetOpen(false);
    setSelection(sel);
    // Clicking a thing on the page asks to see that thing — including when it is
    // already the selection. The effect below can't cover that case, because the
    // selection didn't change; without this, re-clicking the selected element
    // while reading the Document tab did nothing at all. `onSelect(null)`
    // (clicking empty space) deliberately doesn't move the panel.
    //
    // A stamp is the exception, and the effect below already knows it: stamps
    // are edited on the canvas and have no panel controls, so moving to
    // Properties for one replaced every document action with an empty state —
    // clicking your own signature made Compress/Watermark/OCR vanish and showed
    // nothing in their place.
    if (sel && sel.kind !== "stamp") setPanelTab("properties");
  }, []);

  /** Enter text-edit mode for the current selection (mobile): make it editable,
   * focus it, and scroll it into view above the keyboard. */
  const editSelection = useCallback(() => {
    if (!selection) return;
    setEditingId(selection.id);
    setAutoFocusId(selection.id);
  }, [selection]);

  /** Select a text element and immediately enter edit mode (double-tap on
   * touch). Unlike `editSelection`, this takes the target directly so it
   * doesn't depend on the selection state settling first. */
  const enterEdit = useCallback((sel: NonNullable<Selection>) => {
    setSelection(sel);
    setSheetOpen(false);
    setEditingId(sel.id);
    setAutoFocusId(sel.id);
  }, []);

  /** Commit and leave text-edit mode (the on-canvas "done" tick / back gesture):
   * stop editing and blur the focused overlay so the keyboard retracts. The
   * element stays selected so the selection bar remains available. */
  const finishEdit = useCallback(() => {
    setEditingId(null);
    setAutoFocusId(null);
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
  }, []);

  // Deselecting also exits edit mode and closes the on-demand sheet.
  useEffect(() => {
    if (!selection) {
      setEditingId(null);
      setSheetOpen(false);
    }
  }, [selection]);

  // Android/iOS "back" while editing a document should peel back the current
  // in-app layer (exit edit mode → close the sheet → deselect) instead of
  // navigating away from the app (which would drop you on whatever page you
  // arrived from). We keep a single sentinel history entry present whenever
  // there's a layer to dismiss, and pop it to close one layer at a time.
  // Phones only — desktop keeps the browser's normal Back semantics (and its
  // text elements are always editable, so there's no "edit mode" to leave).
  const backGuard = useRef(false);
  const consumingGuard = useRef(false);
  const dismissable = compact && (editingId != null || sheetOpen || selection != null);
  // On a phone the zoom pill yields to the top-centre contextual bar (find,
  // multi-select, a selection). The page field lives in it, so a hidden pill
  // closes the field — otherwise it would reopen, focused, keyboard up, the
  // moment the pill came back.
  const zoomHidden =
    compact && (findOpen || multi.length >= 2 || (selection != null && selection.kind !== "stamp" && !sheetOpen));
  useEffect(() => {
    if (zoomHidden) setPageJumpOpen(false);
  }, [zoomHidden]);
  /** "Go to page…": on a phone, first put away whatever is hiding the pill. */
  const openPageJump = useCallback(() => {
    if (compact) {
      setSelection(null);
      setMulti([]);
      closeFind();
    }
    setPageJumpOpen(true);
  }, [compact, closeFind]);
  useEffect(() => {
    if (dismissable && !backGuard.current) {
      backGuard.current = true;
      try {
        history.pushState({ pdfEditorLayer: true }, "");
      } catch {
        backGuard.current = false;
      }
    } else if (!dismissable && backGuard.current) {
      // The layer was dismissed via the UI — remove our sentinel without
      // leaving the app. The resulting popstate is swallowed below.
      backGuard.current = false;
      consumingGuard.current = true;
      history.back();
    }
  }, [dismissable]);
  useEffect(() => {
    const onPopState = () => {
      if (consumingGuard.current) {
        consumingGuard.current = false;
        return;
      }
      backGuard.current = false;
      if (editingId != null) {
        setEditingId(null);
        setAutoFocusId(null);
      } else if (sheetOpen) {
        setSheetOpen(false);
      } else if (selection != null) {
        setSelection(null);
      }
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [editingId, sheetOpen, selection]);

  // When the properties sheet opens on a phone, the fixed bottom sheet can
  // cover the selected object — so you can't see your style/colour edits land.
  // Scroll the selection up into the strip that stays visible above the sheet.
  // Only intervene when it's actually clipped or covered, to avoid a needless
  // jump; keyed on the id so live restyle re-renders don't re-scroll.
  const sheetSelId = sheetOpen && compact ? panelSelection?.id ?? null : null;
  useEffect(() => {
    if (!sheetSelId) return;
    const raf = requestAnimationFrame(() => {
      const scroller = document.querySelector<HTMLElement>(".viewer__scroll");
      const el = document.querySelector<HTMLElement>(`[data-el-id="${CSS.escape(sheetSelId)}"]`);
      if (!scroller || !el) return;
      const sheet = document.querySelector<HTMLElement>(".panel");
      const scRect = scroller.getBoundingClientRect();
      // Sheet is bottom-anchored: derive its top from its height so the number
      // is right even mid slide-up (its transformed rect would read too low).
      const sheetTop = sheet ? window.innerHeight - sheet.offsetHeight : scRect.bottom;
      const elRect = el.getBoundingClientRect();
      const visTop = scRect.top + 8;
      const visBottom = sheetTop - 12;
      if (elRect.top >= visTop && elRect.bottom <= visBottom) return; // already clear
      const target = scRect.top + (sheetTop - scRect.top) * 0.32;
      scroller.scrollTop += elRect.top - target;
    });
    return () => cancelAnimationFrame(raf);
  }, [sheetSelId]);

  const selectedAnnotation =
    selection?.kind === "annotation"
      ? annotations.find((a) => a.id === selection.id) ?? null
      : null;

  // The selected fragment's own font, so the properties panel shows the
  // document's actual weight/family rather than a generic guess.
  const selectedFragment =
    selection?.kind === "fragment" ? fragmentById.get(selection.id) ?? null : null;
  const selectedFragmentFont = useFragmentFont(pdf?.bytes ?? null, selectedFragment);
  // ...and its own ink, so the colour swatch shows what the text actually is
  // rather than the black it used to default to.
  const selectedFragmentColors = useFragmentColors(pdf?.bytes ?? null, selectedFragment);

  const activeStyle: TextStyle | null = useMemo(() => {
    if (selection?.kind === "fragment") {
      const f = fragmentById.get(selection.id);
      return f
        ? resolveFragmentStyle(
            f,
            edits[f.id]?.style ?? {},
            selectedFragmentFont,
            selectedFragmentColors?.ink,
          )
        : null;
    }
    if (selection?.kind === "textbox") {
      return textBoxes.find((b) => b.id === selection.id)?.style ?? null;
    }
    return null;
    // `selectedFragmentColors` belongs in here: it arrives after the page is
    // sampled, so a memo that didn't list it would keep showing the fragment's
    // colour as black for as long as the selection stood.
  }, [selection, fragmentById, edits, textBoxes, selectedFragmentFont, selectedFragmentColors]);

  const selectedRedaction =
    selection?.kind === "redaction" ? redactions.find((r) => r.id === selection.id) ?? null : null;
  const redactionColor = selectedRedaction?.color ?? null;
  const selectedLink =
    selection?.kind === "link" ? links.find((l) => l.id === selection.id) ?? null : null;

  const onChangeLinkUrl = useCallback(
    (url: string) => {
      if (selection?.kind !== "link") return;
      onChangeLink(selection.id, { url }, `lurl-${selection.id}`);
    },
    [selection, onChangeLink],
  );

  const onChangeStyle = useCallback(
    (patch: Partial<TextStyle>) => {
      if (!selection) return;
      // Remember the latest choices so the next new text box inherits them.
      setLastTextStyle((s) => ({ ...s, ...patch }));
      const onlyColour = Object.keys(patch).length === 1 && patch.color !== undefined;
      const key = onlyColour ? `color-${selection.kind}-${selection.id}` : undefined;
      if (selection.kind === "fragment") {
        const id = selection.id;
        doc.set((d) => {
          const f = fragmentById.get(id);
          const prev = d.edits[id] ?? { text: f?.original ?? "", style: {} };
          return { ...d, edits: { ...d.edits, [id]: { ...prev, style: { ...prev.style, ...patch } } } };
        }, key);
      } else if (selection.kind === "textbox") {
        const id = selection.id;
        doc.set(
          (d) => ({
            ...d,
            textBoxes: d.textBoxes.map((b) => (b.id === id ? { ...b, style: { ...b.style, ...patch } } : b)),
          }),
          key,
        );
      }
    },
    [selection, fragmentById, doc],
  );

  /** Reset the selected text's style to the app default (and clear the
   * remembered style so future new boxes start clean too). */
  const onResetStyle = useCallback(() => {
    if (selection?.kind === "fragment") {
      const id = selection.id;
      doc.set((d) => {
        const e = d.edits[id];
        if (!e) return d;
        return { ...d, edits: { ...d.edits, [id]: { ...e, style: {} } } };
      }, `reset-${id}`);
    } else if (selection?.kind === "textbox") {
      const id = selection.id;
      doc.set((d) => ({
        ...d,
        textBoxes: d.textBoxes.map((b) => (b.id === id ? { ...b, style: { ...DEFAULT_STYLE } } : b)),
      }));
    }
    setLastTextStyle(DEFAULT_STYLE);
  }, [selection, doc, setLastTextStyle]);

  const onChangeRedactionColor = useCallback(
    (color: string) => {
      if (selection?.kind !== "redaction") return;
      const id = selection.id;
      doc.set(
        (d) => ({ ...d, redactions: d.redactions.map((r) => (r.id === id ? { ...r, color } : r)) }),
        `rcolor-${id}`,
      );
    },
    [selection, doc],
  );

  const onDelete = useCallback(() => {
    if (!selection || selection.kind === "fragment") return;
    const { kind, id } = selection;
    doc.set((d) => removeOverlay(d, kind, id));
    setSelection(null);
  }, [selection, doc]);

  // Command palette (Ctrl/⌘+K) — a global toggle independent of focus.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        // Don't stack the palette over another modal; still allow closing it.
        setCmdOpen((v) => (v ? false : !aModalIsOpen()));
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  // ---- Duplicate / copy-paste of overlay objects ----
  // Paste offset — a slight down-right nudge so the copy doesn't sit exactly
  // on top of the original.
  const PASTE_DX = 12;
  const PASTE_DY = -12;
  type ClipItem = { kind: OverlayKind; obj: { id: string } };
  const clipboard = useRef<ClipItem | null>(null);

  const selectedClip = useCallback((): ClipItem | null => {
    if (!selection || selection.kind === "fragment") return null;
    const obj = findOverlay(docHistory.state, selection.kind, selection.id);
    return obj ? { kind: selection.kind, obj } : null;
  }, [selection, docHistory.state]);

  /** Add a copy of a clipboard item, offset slightly, and select it. */
  const pasteItem = useCallback(
    (item: ClipItem) => {
      const def = OVERLAYS[item.kind];
      const id = nextId(def.idPrefix);
      const copy = { ...def.translate(item.obj, PASTE_DX, PASTE_DY), id };
      doc.set((d) => keepStampsOnPage(addOverlay(d, item.kind, copy), [id], pdf?.pages));
      setSelection({ kind: item.kind, id });
    },
    [doc, pdf],
  );

  const duplicateSelection = useCallback(() => {
    const item = selectedClip();
    if (item) pasteItem(item);
  }, [selectedClip, pasteItem]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || isTypingTarget() || aModalIsOpen()) return;
      const key = e.key.toLowerCase();
      if (key === "d") {
        if (!selection) return;
        e.preventDefault();
        duplicateSelection();
      } else if (key === "c") {
        const item = selectedClip();
        if (!item) return;
        e.preventDefault();
        clipboard.current = structuredClone(item);
      } else if (key === "v") {
        if (!clipboard.current) return;
        e.preventDefault();
        pasteItem(clipboard.current);
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [selection, selectedClip, pasteItem, duplicateSelection]);

  // ---- Multi-select (marquee) + align / distribute ----
  const multiIds = useMemo(() => new Set(multi), [multi]);
  const multiByPage = usePageSets(multi, pageOf);
  const selectionPage = selection ? pageOf(selection.id) : undefined;
  const clearMulti = useCallback(() => setMulti([]), []);

  const onMarquee = useCallback((ids: string[]) => {
    setMulti(ids.length >= 2 ? ids : []);
  }, []);

  // A single selection or a tool change ends a multi-selection.
  useEffect(() => {
    if (selection) setMulti([]);
  }, [selection]);

  const multiItems = useMemo(
    () => overlaysInSet(docHistory.state, new Set(multi)),
    [multi, docHistory.state],
  );

  /** Apply per-id {dx,dy} deltas to every overlay object in one undo step. */
  const applyDeltas = useCallback(
    (deltas: Map<string, { dx: number; dy: number }>) => {
      doc.set((d) => keepStampsOnPage(applyOverlayDeltas(d, deltas), deltas.keys(), pdf?.pages));
    },
    [doc, pdf],
  );

  /** Shift the whole multi-selection by one delta, as a single undo step. */
  // Read at drag time rather than closed over: every selection change resets
  // `multi` to a fresh `[]`, and a callback that depended on it would hand every
  // memo'd PageView a new prop and re-render the whole document per click.
  const multiRef = useRef(multi);
  multiRef.current = multi;
  const moveMulti = useCallback(
    (dx: number, dy: number, key: string) => {
      if (!dx && !dy) return;
      const ids = multiRef.current;
      doc.set((d) => {
        const m = limitGroupMove(d, new Set(ids), dx, dy, pdf?.pages);
        if (!m.dx && !m.dy) return d;
        return applyOverlayDeltas(d, new Map(ids.map((id) => [id, m] as const)));
      }, key);
    },
    [doc, pdf],
  );

  /** Restack the selected annotation(s) within the annotation layer. Strokes
   * were unreachable once anything landed on top of them — a highlight drawn
   * after a pen line buries it, and there was no way back. */
  const arrangeSelection = useCallback(
    (to: "front" | "back") => {
      const ids = new Set(
        multi.length > 0 ? multi : selection?.kind === "annotation" ? [selection.id] : [],
      );
      if (ids.size === 0) return;
      doc.set((d) => reorderAnnotations(d, ids, to));
    },
    [multi, selection, doc],
  );

  /** True when the current selection has something the arrange controls can
   * act on — the multibar covers every overlay kind, and only annotations are
   * stacked (see `reorderAnnotations`). */
  const canArrange =
    multi.length > 0
      ? annotations.some((a) => multiIds.has(a.id))
      : selection?.kind === "annotation" && selectedAnnotation?.kind !== "note";

  type AlignOp = "left" | "center-h" | "right" | "top" | "middle" | "bottom";
  const alignMulti = useCallback(
    (op: AlignOp) => {
      if (multiItems.length < 2) return;
      const ls = multiItems.map((i) => i.box.l);
      const rs = multiItems.map((i) => i.box.r);
      const bs = multiItems.map((i) => i.box.b);
      const ts = multiItems.map((i) => i.box.t);
      const minL = Math.min(...ls), maxR = Math.max(...rs), minB = Math.min(...bs), maxT = Math.max(...ts);
      const cH = (minL + maxR) / 2, cV = (minB + maxT) / 2;
      const deltas = new Map<string, { dx: number; dy: number }>();
      for (const it of multiItems) {
        let dx = 0, dy = 0;
        if (op === "left") dx = minL - it.box.l;
        else if (op === "right") dx = maxR - it.box.r;
        else if (op === "center-h") dx = cH - boxCX(it.box);
        else if (op === "top") dy = maxT - it.box.t;
        else if (op === "bottom") dy = minB - it.box.b;
        else if (op === "middle") dy = cV - boxCY(it.box);
        deltas.set(it.id, { dx, dy });
      }
      applyDeltas(deltas);
    },
    [multiItems, applyDeltas],
  );

  const distributeMulti = useCallback(
    (axis: "h" | "v") => {
      if (multiItems.length < 3) return;
      const sorted = [...multiItems].sort((a, b) =>
        axis === "h" ? boxCX(a.box) - boxCX(b.box) : boxCY(a.box) - boxCY(b.box),
      );
      const first = axis === "h" ? boxCX(sorted[0].box) : boxCY(sorted[0].box);
      const last =
        axis === "h" ? boxCX(sorted[sorted.length - 1].box) : boxCY(sorted[sorted.length - 1].box);
      const step = (last - first) / (sorted.length - 1);
      const deltas = new Map<string, { dx: number; dy: number }>();
      sorted.forEach((it, i) => {
        const target = first + step * i;
        const cur = axis === "h" ? boxCX(it.box) : boxCY(it.box);
        deltas.set(it.id, axis === "h" ? { dx: target - cur, dy: 0 } : { dx: 0, dy: target - cur });
      });
      applyDeltas(deltas);
    },
    [multiItems, applyDeltas],
  );

  const deleteMulti = useCallback(() => {
    const set = new Set(multi);
    if (set.size === 0) return;
    doc.set((d) => removeOverlaysByIds(d, set));
    setMulti([]);
  }, [multi, doc]);

  const duplicateMulti = useCallback(() => {
    if (multiItems.length === 0) return;
    const set = new Set(multi);
    const newIds: string[] = [];
    doc.set((d) => {
      let next = d;
      for (const def of OVERLAY_LIST) {
        for (const item of def.get(d)) {
          if (!set.has(item.id)) continue;
          const id = nextId(def.idPrefix);
          newIds.push(id);
          next = addOverlay(next, def.kind, { ...def.translate(item, PASTE_DX, PASTE_DY), id });
        }
      }
      return next;
    });
    setMulti(newIds);
  }, [multi, multiItems, doc]);

  // Move focus into the overflow menu when it opens (ARIA menu pattern).
  useEffect(() => {
    if (!menuOpen) return;
    menuListRef.current
      ?.querySelector<HTMLElement>('[role^="menuitem"]')
      ?.focus();
  }, [menuOpen]);

  const onMenuKeyDown = useCallback((e: React.KeyboardEvent) => {
    const items = Array.from(
      menuListRef.current?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]') ?? [],
    );
    if (items.length === 0) return;
    const idx = items.indexOf(document.activeElement as HTMLButtonElement);
    const focusAt = (n: number) => {
      e.preventDefault();
      items[(n + items.length) % items.length].focus();
    };
    if (e.key === "ArrowDown") focusAt(idx + 1);
    else if (e.key === "ArrowUp") focusAt(idx - 1);
    else if (e.key === "Home") focusAt(0);
    else if (e.key === "End") focusAt(items.length - 1);
    else if (e.key === "Escape") {
      e.preventDefault();
      setMenuOpen(false);
      menuBtnRef.current?.focus();
    } else if (e.key === "Tab") {
      setMenuOpen(false);
    }
  }, []);

  const undo = useCallback(() => {
    doc.undo();
  }, [doc]);
  const redo = useCallback(() => {
    doc.redo();
  }, [doc]);

  useEffect(() => {
    if (
      selection &&
      selection.kind !== "fragment" &&
      !overlayExists(docHistory.state, selection.kind, selection.id)
    ) {
      setSelection(null);
    }
  }, [docHistory.state, selection]);

  // Warn before leaving/reloading the tab while there are unsaved changes.
  // Everything lives in memory (no server, no autosave), so an accidental
  // refresh or back-navigation would otherwise silently discard all edits.
  // Downloaded work is let go without the browser's prompt only when the
  // session copy holds it too: the download itself can't be confirmed.
  const atRisk = (edited: boolean, unsaved: boolean, locked: boolean) =>
    unsaved || (edited && (!autosaveOn || locked));
  const anyBackgroundChanges = tabs.some((t) => t.id !== activeId && atRisk(t.changeCount > 0, t.unsaved, t.locked));
  const frontAtRisk = atRisk(changeCount > 0, unsaved, locked);
  useEffect(() => {
    if (!frontAtRisk && !anyBackgroundChanges) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [frontAtRisk, anyBackgroundChanges]);

  // Auto-dismiss transient status messages (keep errors and in-progress
  // messages until superseded).
  useEffect(() => {
    if (!message || status === "error" || busy) return;
    const t = setTimeout(() => setMessage(""), 4000);
    return () => clearTimeout(t);
  }, [message, status, busy]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // A modal (Organize / Finish / Compress / Command Palette) owns the
      // keyboard while it's open — don't undo/redo/find/delete on the canvas
      // hidden beneath it. Modals manage their own Escape via useModal.
      if (aModalIsOpen()) return;
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      if (mod && key === "z") {
        e.preventDefault();
        e.shiftKey ? redo() : undo();
        return;
      }
      // Ctrl/⌘+O opens files into new tabs (the browser's own "open file" would
      // navigate away from everything open here).
      if (mod && key === "o" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        openAnother();
        return;
      }
      if (mod && key === "y") {
        e.preventDefault();
        redo();
        return;
      }
      if (mod && key === "f") {
        e.preventDefault();
        openFind();
        return;
      }
      if (e.key === "Escape" && pendingStamp) {
        e.preventDefault();
        setPendingStamp(null);
        setMessage("");
        return;
      }
      if (e.key === "Escape" && findOpen) {
        e.preventDefault();
        closeFind();
        return;
      }
      if (multi.length > 0 && !isTypingTarget()) {
        if (e.key === "Escape") {
          e.preventDefault();
          clearMulti();
          return;
        }
        if (e.key === "Delete" || e.key === "Backspace") {
          e.preventDefault();
          deleteMulti();
          return;
        }
        // Nudge the group, same steps as a single object. Held keys coalesce
        // into one undo entry via the shared key.
        const step = e.shiftKey ? 10 : 1;
        const move =
          e.key === "ArrowLeft" ? ([-step, 0] as const)
          : e.key === "ArrowRight" ? ([step, 0] as const)
          : e.key === "ArrowUp" ? ([0, step] as const)
          : e.key === "ArrowDown" ? ([0, -step] as const)
          : null;
        if (move && !mod) {
          e.preventDefault();
          moveMulti(move[0], move[1], "nudge-multi");
          return;
        }
      }
      // Escape clears the current selection (and closes the mobile sheet /
      // desktop panel, which is driven by selection). Modals stop Escape from
      // reaching here via their own capture-phase handler.
      if (e.key === "Escape" && selection) {
        e.preventDefault();
        setSelection(null);
        return;
      }
      if (
        (selection?.kind === "redaction" || selection?.kind === "stamp" || selection?.kind === "link") &&
        (e.key === "Delete" || e.key === "Backspace")
      ) {
        e.preventDefault();
        onDelete();
        return;
      }
      // Delete a selected annotation (but not while editing a sticky note).
      if (
        selection?.kind === "annotation" &&
        e.key === "Delete" &&
        selectedAnnotation?.kind !== "note"
      ) {
        e.preventDefault();
        onDelete();
        return;
      }

      // Arrow-key nudge for a selected non-text element. Text boxes/notes keep
      // their native caret movement, so they're intentionally excluded.
      // Shift = a larger step. PDF's y-axis points up.
      const arrow =
        e.key === "ArrowLeft" ? ([-1, 0] as const)
        : e.key === "ArrowRight" ? ([1, 0] as const)
        : e.key === "ArrowUp" ? ([0, 1] as const)
        : e.key === "ArrowDown" ? ([0, -1] as const)
        : null;
      if (arrow && selection && !mod && !isTypingTarget()) {
        const step = e.shiftKey ? 10 : 1;
        const dx = arrow[0] * step;
        const dy = arrow[1] * step;
        if (selection.kind === "redaction") {
          const r = redactions.find((x) => x.id === selection.id);
          if (r) {
            e.preventDefault();
            onChangeRedaction(r.id, { x: r.x + dx, y: r.y + dy }, `nudge-rd-${r.id}`);
          }
          return;
        }
        if (selection.kind === "stamp") {
          const s = stamps.find((x) => x.id === selection.id);
          if (s) {
            e.preventDefault();
            onChangeStamp(s.id, { x: s.x + dx, y: s.y + dy }, `nudge-st-${s.id}`);
          }
          return;
        }
        if (selection.kind === "link") {
          const l = links.find((x) => x.id === selection.id);
          if (l) {
            e.preventDefault();
            onChangeLink(l.id, { x: l.x + dx, y: l.y + dy }, `nudge-ln-${l.id}`);
          }
          return;
        }
        if (
          selection.kind === "annotation" &&
          selectedAnnotation &&
          selectedAnnotation.kind !== "note"
        ) {
          e.preventDefault();
          onMoveAnnotation(
            translateAnnotation(selectedAnnotation, dx, dy),
            `nudge-an-${selectedAnnotation.id}`,
          );
          return;
        }
      }

      // Restack the selection. `[`/`]` are the shortcut every editor uses for
      // this and collide with nothing here (the tool keys are letters).
      if ((e.key === "]" || e.key === "[") && !mod && canArrange && !isTypingTarget()) {
        e.preventDefault();
        arrangeSelection(e.key === "]" ? "front" : "back");
        return;
      }

      // Single-key tool shortcuts — only when not typing and no modal is open.
      if (
        !mod &&
        !e.shiftKey &&
        !isTypingTarget() &&
        !document.querySelector('[aria-modal="true"]')
      ) {
        const t = TOOL_KEYS[key];
        if (t) {
          e.preventDefault();
          setPendingStamp(null);
          if (t === "sign") {
            setSelection(null);
            setSigOpen(true);
          } else {
            // Reaching Draw by shortcut is the same arrival as clicking it:
            // the sub-toolbar comes up (see `pickTool`).
            if (t === "draw") setDrawbarOpen(true);
            setTool(t);
            if (t !== "select") setSelection(null);
          }
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    openAnother,
    selection,
    selectedAnnotation,
    onDelete,
    undo,
    redo,
    redactions,
    stamps,
    onChangeRedaction,
    onChangeStamp,
    onMoveAnnotation,
    openFind,
    closeFind,
    findOpen,
    links,
    onChangeLink,
    multi,
    clearMulti,
    deleteMulti,
    moveMulti,
    arrangeSelection,
    canArrange,
    pendingStamp,
  ]);

  const runExport = useCallback(async () => {
    if (!pdf) return;
    const mark = markNow.current;
    setStatus("exporting");
    setMessage("Building edited PDF…");
    try {
      const { exportPdf } = await import("./pdf/exporter");
      const out = await exportPdf(
        pdf,
        { edits, textBoxes, redactions, annotations, stamps, links, formValues, pageNumbers, watermark, losslessRaster },
        (p, t) => setMessage(`Building edited PDF… page ${p}/${t}`),
      );
      downloadBytes(out, fileName.replace(/\.pdf$/i, "") + "-edited.pdf");
      setSavedMark(mark);
      setStatus("ready");
      setMessage(
        (redactions.length > 0
          ? "Downloaded — redacted pages were flattened to images."
          : "Downloaded edited PDF.") + (locked ? " This copy has no password." : ""),
      );
    } catch {
      setStatus("error");
      setMessage("Couldn't build the edited PDF. Please try again.");
    }
  }, [pdf, edits, textBoxes, redactions, annotations, stamps, links, formValues, pageNumbers, watermark, losslessRaster, fileName, locked]);

  // Guard the download: a whiteout cover only paints over content — the text
  // beneath stays recoverable. If any cover sits over live text, warn before
  // handing back a file that looks redacted but isn't. True redactions
  // rasterise the page and are safe, so they never trip this.
  const download = useCallback(async () => {
    if (!pdf) return;
    const warn = findUnsafeCovers(pdf, redactions);
    if (warn.count > 0) {
      setCoverWarn(warn);
      return;
    }
    await runExport();
  }, [pdf, redactions, runExport]);

  /** Back to the start screen, with nothing open. */
  const closeAll = useCallback(() => {
    setMenuOpen(false);
    flushSave.current = true;
    for (const t of tabs) releaseDoc(t.pdf.bytes);
    if (pdf) releaseDoc(pdf.bytes);
    setTabs([]);
    setActiveId(null);
    setPdf(null);
    setFileName("document.pdf");
    setBaked(0);
    setSavedMark(null);
    setLocked(false);
    doc.reset(EMPTY_DOC);
    resetDocUi();
    setNavOpen(false);
    setDrawbarOpen(true);
    setInspectorOpen(true);
    setStatus("idle");
    setMessage("");
  }, [tabs, pdf, doc, resetDocUi]);

  /** Close one document. Its neighbour (right, else left) comes to the front;
   * closing the last one returns to the start screen. */
  const closeTab = useCallback(
    (id: string) => {
      setConfirmCloseId(null);
      setMenuOpen(false);
      const i = tabs.findIndex((t) => t.id === id);
      if (i < 0) return;
      if (tabs.length === 1) {
        closeAll();
        return;
      }
      const closing = tabs[i];
      const rest = tabs.filter((t) => t.id !== id);
      flushSave.current = true;
      if (id === activeId) {
        if (pdf) releaseDoc(pdf.bytes);
        setTabs(rest);
        showDoc(rest[Math.min(i, rest.length - 1)]);
      } else {
        releaseDoc(closing.pdf.bytes);
        setTabs(rest);
      }
    },
    [tabs, activeId, pdf, closeAll, showDoc],
  );

  /** Close a document, asking first if that would lose work. */
  const requestCloseTab = useCallback(
    (id: string) => {
      if (busy) return;
      // A downloaded document still asks, more gently: the page can't know the
      // download finished (a cancelled "Save as…" looks the same from here),
      // and closing deletes the session copy that would otherwise hold the work.
      const edited = id === activeId ? changeCount > 0 : (tabs.find((t) => t.id === id)?.changeCount ?? 0) > 0;
      if (edited) setConfirmCloseId(id);
      else closeTab(id);
    },
    [busy, activeId, changeCount, tabs, closeTab],
  );

  const goHome = useCallback(() => {
    if (activeId) requestCloseTab(activeId);
  }, [activeId, requestCloseTab]);

  /** Every open document, exported and bundled into one ZIP. */
  const downloadAll = useCallback(async () => {
    setMenuOpen(false);
    if (tabs.length === 0 || busy) return;
    // The single-file Download's whiteout check, for every document: a ZIP is
    // no less a file someone else will read.
    const unsafe = tabs.flatMap((t) => {
      const live = t.id === activeId && pdf;
      const state = live ? docHistory.state : t.history ? t.history.entries[t.history.index] : EMPTY_DOC;
      const w = findUnsafeCovers(live ? pdf : t.pdf, state.redactions);
      return w.count > 0 ? [`${live ? fileName : t.fileName} (page ${w.pages.join(", ")})`] : [];
    });
    if (unsafe.length > 0) {
      setStatus("error");
      setMessage(
        `Whiteout sits over live text that stays readable in ${unsafe.join("; ")}. Redact it instead, or download that document on its own.`,
      );
      return;
    }
    // What each document is as the ZIP starts: what it will be marked saved as.
    const liveMark = markNow.current;
    const marks = new Map(
      tabs.map((t) => [
        t.id,
        t.id === activeId ? liveMark : { doc: t.history ? t.history.entries[t.history.index] : EMPTY_DOC, baked: t.baked },
      ]),
    );
    setStatus("exporting");
    try {
      const { exportPdf } = await import("./pdf/exporter");
      const { makeZip } = await import("./pdf/zip");
      const entries: { name: string; data: Uint8Array }[] = [];
      const used = new Set<string>();
      for (const [n, t] of tabs.entries()) {
        const live = t.id === activeId && pdf;
        const state = live ? docHistory.state : t.history ? t.history.entries[t.history.index] : EMPTY_DOC;
        const source = live ? pdf : t.pdf;
        const name = live ? fileName : t.fileName;
        setMessage(`Building ${n + 1} of ${tabs.length} · ${name}`);
        const out = await exportPdf(source, { ...EMPTY_DOC, ...state, losslessRaster });
        // Two tabs can share a file name (the same file opened twice); a ZIP
        // with duplicate entries silently loses one on extraction.
        const base = name.replace(/\.pdf$/i, "") + "-edited";
        // Case-blind: macOS and Windows extract "A.pdf" over "a.pdf".
        let entry = `${base}.pdf`;
        for (let k = 2; used.has(entry.toLowerCase()); k++) entry = `${base}-${k}.pdf`;
        used.add(entry.toLowerCase());
        entries.push({ name: entry, data: out });
      }
      downloadBytes(makeZip(entries), "documents-edited.zip", "application/zip");
      if (marks.has(activeId ?? "")) setSavedMark(liveMark);
      setTabs((list) =>
        list.map((t) => {
          const m = marks.get(t.id);
          if (!m || t.id === activeId) return t;
          const now = t.history ? t.history.entries[t.history.index] : EMPTY_DOC;
          return now === m.doc && t.baked === m.baked ? { ...t, saved: m, unsaved: false } : t;
        }),
      );
      setStatus("ready");
      setMessage(`Downloaded ${plural(entries.length, "document")} as a ZIP.`);
    } catch {
      setStatus("error");
      setMessage("Couldn't build every document. Please try again.");
    }
  }, [tabs, busy, activeId, pdf, docHistory.state, fileName, losslessRaster]);

  const pickTool = (t: NavKey) => {
    setPendingStamp(null);
    setMulti([]);
    if (t === "sign") {
      setSelection(null);
      setSigOpen(true);
      return;
    }
    // Draw is a disclosure: pressing it while already drawing folds the
    // sub-toolbar away and pressing it again brings it back. Arriving from
    // another tool always opens it — that's the point of choosing Draw.
    if (t === "draw") setDrawbarOpen(tool === "draw" ? (v) => !v : true);
    setTool(t);
    if (t !== "select") setSelection(null);
  };

  const appBar = (
    <header className={`appbar${menuOpen ? " appbar--menu" : ""}`}>
      {/* With a document open the brand is the way back to the start screen —
          it looks like a home link, so it has to behave like one. With nothing
          open it's already home, and stays inert text. */}
      {pdf ? (
        <button
          type="button"
          className="appbar__brand appbar__brand--link"
          onClick={goHome}
          // The visible label is "PDF Editor", so the accessible name has to
          // start with it (WCAG 2.5.3 Label in Name) — speech-input users say
          // what they see.
          aria-label={
            tabs.length > 1
              ? "PDF Editor — close this PDF"
              : "PDF Editor — close this PDF and return to the start screen"
          }
          data-tip="Close document"
        >
          <span className="appbar__logo">
            <Icon name="brand" size={18} />
          </span>
          <span className="title-large appbar__name">PDF Editor</span>
        </button>
      ) : (
        <div className="appbar__brand">
          <span className="appbar__logo">
            <Icon name="brand" size={18} />
          </span>
          <span className="title-large appbar__name">PDF Editor</span>
        </div>
      )}
      {pdf && (
        <button
          className={`icon-btn${navOpen ? " icon-btn--on" : ""}`}
          onClick={() => setNavOpen((v) => !v)}
          // A toggle should say what it will do, not what it is: "Toggle page
          // thumbnails" left the user to guess the current state, and the
          // tooltip read "Pages" — the same word as the rail's own heading,
          // which it then covered.
          aria-label={navOpen ? "Hide pages" : "Show pages"}
          aria-expanded={navOpen}
          // Only while it exists: the rail is unmounted when closed, and an
          // `aria-controls` pointing at an absent id is a dangling reference.
          aria-controls={navOpen ? "page-rail" : undefined}
          data-tip={navOpen ? "Hide pages" : "Show pages"}
        >
          <Icon name={navOpen ? "panel_close" : "panel_open"} size={18} />
        </button>
      )}
      {!pdf && <div className="appbar__spacer" />}
      {pdf && (
        <>
          <div className="appbar__spacer" />
          <button className="icon-btn" onClick={undo} disabled={!docHistory.canUndo} aria-label="Undo" data-tip="Undo · Ctrl+Z">
            <Icon name="undo" size={18} />
          </button>
          <button className="icon-btn" onClick={redo} disabled={!docHistory.canRedo} aria-label="Redo" data-tip="Redo · Ctrl+Shift+Z">
            <Icon name="redo" size={18} />
          </button>
          <button className="icon-btn" onClick={() => (findOpen ? closeFind() : openFind())} aria-label="Find" aria-pressed={findOpen} data-tip="Find · Ctrl+F">
            <Icon name="search" size={18} />
          </button>
          <span className="appbar__changes label-medium" role="status">
            {unsaved ? `${changeCount} change${changeCount === 1 ? "" : "s"}` : changeCount > 0 ? "Downloaded" : ""}
          </span>
          <button
            className="btn btn--filled appbar__download"
            onClick={download}
            disabled={busy}
            // On a phone the label is hidden and only the icon shows; without
            // this the button is announced as just "button".
            aria-label={status === "exporting" ? "Exporting…" : "Download"}
          >
            {status === "exporting" ? (
              <span className="spinner spinner--sm spinner--on-primary" aria-hidden="true" />
            ) : (
              <Icon name="download" size={16} />
            )}
            <span>{status === "exporting" ? "Exporting…" : "Download"}</span>
          </button>
          <div className="menu">
            <button ref={menuBtnRef} className="icon-btn appbar__more" onClick={() => setMenuOpen((v) => !v)} aria-label="More actions" aria-haspopup="menu" aria-expanded={menuOpen} data-tip="More actions">
              <Icon name="more_vert" size={18} />
            </button>
            {menuOpen && (
              <>
                <div className="menu__scrim" onClick={() => setMenuOpen(false)} />
                <div className="menu__list" role="menu" ref={menuListRef} onKeyDown={onMenuKeyDown}>
                  {/* Same groups, same order, same names as the Inspector's
                      Document tab. They were only separated by hairlines here,
                      so the menu read as one 13-item wall while the panel showed
                      three short lists — the same commands, twice, filed
                      differently. */}
                  {DOC_GROUPS.map((grp, gi) => (
                    <Fragment key={grp.key}>
                      {gi > 0 && <div className="menu__divider" />}
                      {/* `role="group"` with a labelled heading, not a bare span:
                          a `role="menu"` may only contain menuitems, groups and
                          separators, so a loose label is either ignored or
                          reported as a stray item. This way the grouping reaches
                          assistive tech too, instead of being purely visual. */}
                      <div role="group" aria-labelledby={`menu-grp-${grp.key}`}>
                        <span className="menu__label label-small" id={`menu-grp-${grp.key}`}>
                          {grp.label}
                        </span>
                        {docActions
                          .filter((a) => a.group === grp.key)
                          .map((a) => (
                            <button
                              key={a.id}
                              className="menu__item"
                              role="menuitem"
                              aria-haspopup={a.opens ? "dialog" : undefined}
                              onClick={() => { setMenuOpen(false); a.run(); }}
                            >
                              <Icon name={a.icon} size={18} />
                              <span className="menu__itemlabel">{a.label}</span>
                              {a.opens && <Icon name="opens_dialog" size={16} className="opens-mark" />}
                            </button>
                          ))}
                      </div>
                    </Fragment>
                  ))}
                  <div className="menu__divider" />
                  <div role="group" aria-labelledby="menu-grp-view">
                    <span className="menu__label label-small" id="menu-grp-view">
                      View
                    </span>
                    {/* Cycles system → light → dark in place, and deliberately
                        leaves the menu open so the value can be seen changing.
                        The visible row is "Theme … Dark", which reads as a
                        setting rather than a control, so the accessible name has
                        to say it can be operated — and it has to still contain
                        the visible words (WCAG 2.5.3). */}
                    <button
                      className="menu__item"
                      onClick={theme.cycle}
                      role="menuitem"
                      aria-label={`Theme: ${themeName}. Activate to change.`}
                    >
                      <Icon name={themeIcon} size={18} /> Theme
                      <span className="menu__value label-medium">{themeName}</span>
                    </button>
                  <button
                    className="menu__item"
                    onClick={() => setDimPages((v) => !v)}
                    role="menuitemcheckbox"
                    aria-checked={dimPages}
                  >
                    <Icon name="contrast" size={18} /> Dim pages
                    {dimPages && <Icon name="check" size={16} className="menu__check" />}
                  </button>
                  <button
                    className="menu__item"
                    onClick={() => { setMenuOpen(false); toggleAutosave(); }}
                    role="menuitemcheckbox"
                    aria-checked={autosaveOn}
                  >
                    <Icon name="save_local" size={18} /> Save session on this device
                    {autosaveOn && <Icon name="check" size={16} className="menu__check" />}
                  </button>
                  <button
                    className="menu__item"
                    onClick={() => { setMenuOpen(false); setLosslessRaster((v) => !v); }}
                    role="menuitemcheckbox"
                    aria-checked={losslessRaster}
                    data-tip="Redacted pages export bit-exact, at several times the file size"
                  >
                    <Icon name="lossless" size={18} /> Lossless redacted pages
                    {losslessRaster && <Icon name="check" size={16} className="menu__check" />}
                  </button>
                  </div>
                  <div className="menu__divider" />
                  <div role="group" aria-labelledby="menu-grp-file">
                    <span className="menu__label label-small" id="menu-grp-file">
                      File
                    </span>
                    <button className="menu__item" onClick={openAnother} role="menuitem">
                      <Icon name="note_add" size={18} /> Open another PDF
                    </button>
                    {tabs.length > 1 && (
                      <button className="menu__item" onClick={() => void downloadAll()} role="menuitem" disabled={busy}>
                        <Icon name="download_all" size={18} /> Download all ({tabs.length}) as ZIP
                      </button>
                    )}
                    <button className="menu__item" onClick={goHome} role="menuitem">
                      <Icon name="close" size={18} /> Close document
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </>
      )}
      {/* No theme button here. It used to sit permanently in the app bar — at the
          same weight as the document actions, and *after* the overflow menu, so
          the one control that is conventionally last no longer was. It's a
          once-in-a-while preference, so it lives with the other preferences in
          that menu; on a phone the 48px it was holding is also the difference
          between the bar fitting and the primary action being crushed. On the
          start screen, where there is no menu, it stays. */}
      {!pdf && (
        <button
          className="icon-btn"
          onClick={theme.cycle}
          aria-label={`Theme: ${themeLabel}. Click to change.`}
          data-tip={themeLabel}
        >
          <Icon name={themeIcon} size={20} />
        </button>
      )}
    </header>
  );

  const propertiesPanel = (
    <PropertiesPanel
      selection={panelSelection}
      style={activeStyle}
      redactionColor={redactionColor}
      redactionCover={!!selectedRedaction?.cover}
      annotation={selectedAnnotation}
      stampSelected={selection?.kind === "stamp"}
      linkUrl={selectedLink?.url ?? null}
      onChangeStyle={onChangeStyle}
      onChangeRedactionColor={onChangeRedactionColor}
      onChangeLinkUrl={onChangeLinkUrl}
      onChangeAnnotation={onChangeAnnotation}
      onArrange={arrangeSelection}
      onDelete={onDelete}
      onReset={onResetStyle}
      onClose={() => (compact ? setSheetOpen(false) : setSelection(null))}
    />
  );

  // Document-wide actions. No heading of its own — the panel's "Document" tab
  // names it, and a tab plus an identical title underneath is the same word
  // twice.
  const documentPanel = (
    <div className="props">
      <div className="doclist">
        {DOC_GROUPS.map((grp) => (
          <Fragment key={grp.key}>
            <span className="doclist__label label-medium">{grp.label}</span>
            {docActions
              .filter((a) => a.group === grp.key)
              .map((a) => (
                <button
                  key={a.id}
                  className="doclist__item"
                  aria-haspopup={a.opens ? "dialog" : undefined}
                  onClick={a.run}
                >
                  <Icon name={a.icon} size={18} />
                  <span className="doclist__itemlabel">{a.label}</span>
                  {a.opens && <Icon name="opens_dialog" size={16} className="opens-mark" />}
                </button>
              ))}
          </Fragment>
        ))}
      </div>
      {/* The tab's tail was ~300px of empty surface on any normal window. The
          product's one real claim belongs somewhere calm and permanent, and this
          is the only place in the editor that had room for it. */}
      <p className="doclist__note body-small">
        Every action here runs in this browser. Your file is never uploaded.
      </p>
    </div>
  );

  // Asked for from the start screen as often as from an open document, so
  // both views render it.
  const passwordDialog = pwAsk && (
    <Suspense fallback={null}>
      <PasswordDialog
        key={pwAsk.name}
        fileName={pwAsk.name}
        wrong={pwAsk.wrong}
        checking={pwAsk.checking}
        onSubmit={(pw) => pwAsk.answer(pw)}
        onCancel={() => pwAsk.answer(null)}
      />
    </Suspense>
  );

  if (!pdf) {
    return (
      <div className="app">
        <TooltipHost />
        {passwordDialog}
        {appBar}
        <div
          className={`dropzone${dragging ? " dropzone--active" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            void openFiles(e.dataTransfer.files);
          }}
        >
          {restorable && (
            <div className="restore-banner">
              <span className="restore-banner__icon"><Icon name="restore" size={22} /></span>
              <div className="restore-banner__text">
                <b className="title-small">Restore your last session?</b>
                <span className="body-small restore-banner__files">
                  {restorable.docs.length === 1
                    ? restorable.docs[0].fileName
                    : `${plural(restorable.docs.length, "document")} · ${restorable.docs.map((d) => d.fileName).join(", ")}`}
                </span>
              </div>
              <button className="btn btn--tonal" onClick={restoreSession}>Restore</button>
              {/* "Dismiss" only hides this prompt — the copy stays on the device
                  so it can still be restored later. "Delete" is the way to
                  actually get rid of it, which previously had no UI at all. */}
              <button className="btn btn--text" onClick={dismissRestore}>Not now</button>
              <button className="btn btn--text" onClick={discardRestorable}>Delete</button>
            </div>
          )}
          <div className="dropzone__card">
            <div className="dropzone__icon">
              <Icon name="picture_as_pdf" size={30} />
            </div>
            <h1 className="headline-small">Open a PDF to start editing</h1>
            <p className="body-medium dropzone__sub">
              Edit text, add notes, redact, and export — all on your device.
              Nothing is uploaded.
            </p>
            <button className="btn btn--filled btn--lg" onClick={() => inputRef.current?.click()}>
              <Icon name="upload_file" size={18} /> Choose PDF
            </button>
            <p className="body-small dropzone__hint">or drag &amp; drop files here · several open as tabs</p>
            {status === "loading" && (
              <p className="body-small dropzone__note">
                <span className="spinner spinner--sm" aria-hidden="true" /> {message}
              </p>
            )}
            {status === "error" && <p className="body-small dropzone__err">{message}</p>}
          </div>
          <input
            ref={inputRef}
            type="file"
            accept="application/pdf,.pdf"
            multiple
            hidden
            onChange={(e) => {
              const files = [...(e.target.files ?? [])];
              e.target.value = "";
              void openFiles(files);
            }}
          />
        </div>
      </div>
    );
  }

  const hasFiles = (e: React.DragEvent) => [...e.dataTransfer.types].includes("Files");
  return (
    <div
      className={`app${dimPages ? " app--dim" : ""}${dragging ? " app--dropping" : ""}${isWide || tabs.length > 1 ? " app--tabs" : ""}`}
      // Dropping files on an open document opens them in new tabs. Only real
      // files: an in-app drag (a page, an overlay) carries no "Files" type and
      // must never be swallowed here.
      onDragOver={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        if (!dragging) setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target || !e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
      }}
      onDrop={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        setDragging(false);
        void openFiles(e.dataTransfer.files);
      }}
    >
      <TooltipHost />
      {/* The document is one Tab stop per page, but a long file is still many
          pages between the app bar and the tools; this jumps straight there.
          Hidden until focused, and the first Tab stop on the page. */}
      <button
        type="button"
        className="skiplink"
        onClick={() =>
          // The active tool, else the first: one selector list would return
          // whichever comes first in the DOM, which is always "Select".
          (
            document.querySelector<HTMLElement>(".tooldock .tooldock__btn--on") ??
            document.querySelector<HTMLElement>(".tooldock .tooldock__btn")
          )?.focus()
        }
      >
        Skip to tools
      </button>
      {appBar}
      {(isWide || tabs.length > 1) && (
        <DocTabs
          tabs={tabs.map((t) =>
            t.id === activeId
              ? { id: t.id, name: fileName, dirty: unsaved }
              : { id: t.id, name: t.fileName, dirty: t.unsaved },
          )}
          activeId={activeId}
          disabled={busy}
          onSelect={switchTo}
          onClose={requestCloseTab}
          onOpen={openAnother}
        />
      )}
      {dragging && (
        <div className="dropveil" aria-hidden="true">
          <span className="dropveil__card title-medium">
            <Icon name="note_add" size={20} /> Drop to open in a new tab
          </span>
        </div>
      )}

      <div className="workspace">
        {navOpen && (
          <>
            {compact && <div className="pagenav__scrim" onClick={() => setNavOpen(false)} />}
            <PageNav
              bytes={pdf.bytes}
              pageCount={pdf.pages.length}
              onClose={compact ? () => setNavOpen(false) : undefined}
            />
          </>
        )}
        <div className="viewer">
          <div
            className={`viewer__scroll${sheetOpen && compact ? " viewer__scroll--sheet" : ""}`}
            ref={vp.viewportRef}
            {...vp.handlers}
          >
            <div className="doc">
            {pdf.pages.map((page) => (
              <PageView
                key={page.pageIndex}
                bytes={pdf.bytes}
                page={page}
                scale={vp.scale}
                tool={tool}
                drawTool={drawTool}
                drawStyle={drawStyle}
                edits={editsByPage.get(page.pageIndex) ?? NO_EDITS}
                textBoxes={pageItems(boxesByPage, page.pageIndex)}
                redactions={pageItems(redactionsByPage, page.pageIndex)}
                annotations={pageItems(annotationsByPage, page.pageIndex)}
                stamps={pageItems(stampsByPage, page.pageIndex)}
                links={pageItems(linksByPage, page.pageIndex)}
                formValues={formValues}
                pageNumbers={pageNumbers}
                watermark={watermark}
                multiIds={multiByPage.get(page.pageIndex) ?? NO_IDS}
                placing={pendingStamp}
                findMatches={matchesByPage.get(page.pageIndex)}
                activeFindId={activeMatch?.pageIndex === page.pageIndex ? activeMatch.id : null}
                selection={selectionPage === page.pageIndex ? selection : null}
                autoFocusId={autoFocusId != null && pageOf(autoFocusId) === page.pageIndex ? autoFocusId : null}
                editingId={editingId != null && pageOf(editingId) === page.pageIndex ? editingId : null}
                compact={compact}
                onSelect={onSelect}
                onEditText={enterEdit}
                onFinishEdit={finishEdit}
                onChangeFragmentText={onChangeFragmentText}
                onChangeTextBoxText={onChangeTextBoxText}
                onChangeTextBox={onChangeTextBox}
                onChangeRedaction={onChangeRedaction}
                onChangeLink={onChangeLink}
                onChangeNoteText={onChangeNoteText}
                onMoveAnnotation={onMoveAnnotation}
                onChangeStamp={onChangeStamp}
                onDeleteStamp={onDeleteStamp}
                onAddTextBox={onAddTextBox}
                onAddRedaction={onAddRedaction}
                onAddLink={onAddLink}
                onChangeFormValue={onChangeFormValue}
                onMarquee={onMarquee}
                onMoveMulti={moveMulti}
                onAddAnnotation={onAddAnnotation}
                onPlaceStamp={onPlaceStamp}
                onSpill={onSpill}
              />
            ))}
            </div>
          </div>

          {/* Pinned zoom control (top-right, does not scroll). On phones it
              yields to whichever top-centre contextual bar is showing (find /
              multi-select / selection) so the two never overlap on a narrow
              screen; the bottom tool cluster never reaches it. */}
          {!zoomHidden && (
          <div className="zoombar" role="group" aria-label="Zoom">
            <button className="icon-btn" onClick={vp.zoomOut} aria-label="Zoom out" data-tip="Zoom out">
              <Icon name="remove" size={18} />
            </button>
            {pdf.pages.length > 1 && (
              <>
                <PageJump pageCount={pdf.pages.length} docKey={pdf} editing={pageJumpOpen} onEditingChange={setPageJumpOpen} />
                <span className="zoombar__sep" aria-hidden="true" />
              </>
            )}
            <button className="zoombar__label label-medium" onClick={vp.resetZoom} data-tip="Fit to width">
              {Math.round(vp.zoom * 100)}%
            </button>
            <button className="icon-btn" onClick={vp.zoomIn} aria-label="Zoom in" data-tip="Zoom in">
              <Icon name="add" size={18} />
            </button>
          </div>
          )}

          {/* Unified tool dock — one home for every tool, identical on desktop
              and mobile (replaces the split rail / bottom bar). */}
          {!sheetOpen && (
            <div className="tooldock" role="toolbar" aria-label="Tools">
              {TOOLS.map((t, i) => (
                <span key={t.key} style={{ display: "contents" }}>
                  {i === 1 && <span className="tooldock__sep" />}
                  {t.key === "sign" && <span className="tooldock__sep" />}
                  {/* A tool that opens something says so twice: the corner
                      notch is the visual tell, and `aria-expanded` /
                      `aria-haspopup` is the same fact for anyone who can't see
                      it. Draw discloses a toolbar it controls; Sign opens a
                      dialog — different relationships, so different attributes
                      rather than one approximate `haspopup` on both. */}
                  <button
                    className={`tooldock__btn${tool === t.key ? " tooldock__btn--on" : ""}${t.opens ? " tooldock__btn--opens" : ""}`}
                    onClick={() => pickTool(t.key)}
                    aria-pressed={tool === t.key}
                    aria-label={t.label}
                    // `aria-expanded` is the disclosure's state, not the
                    // tool's: the bar collapses while Draw stays active, and
                    // saying "expanded" then would be a lie. `aria-controls`
                    // only while the element it names is mounted.
                    aria-expanded={t.opens === "toolbar" ? tool === t.key && drawbarOpen : undefined}
                    aria-controls={t.opens === "toolbar" && tool === t.key ? "drawbar" : undefined}
                    aria-haspopup={t.opens === "dialog" ? "dialog" : undefined}
                    data-tip={`${t.label} · ${TOOL_SHORTCUT[t.key]}`}
                  >
                    <Icon name={t.icon} size={20} />
                  </button>
                </span>
              ))}
            </div>
          )}

          {findOpen && (
            <FindBar
              query={findQuery}
              count={matches.length}
              active={matches.length ? findActive + 1 : 0}
              onQuery={(q) => {
                setFindQuery(q);
                setFindActive(0);
              }}
              onNext={nextMatch}
              onPrev={prevMatch}
              onRedactAll={redactAllMatches}
              onClose={closeFind}
            />
          )}

          {multi.length >= 2 && (
            <div className="multibar" role="toolbar" aria-label={`${multi.length} objects selected`}>
              <span className="multibar__title label-large">{multi.length} selected</span>
              <span className="multibar__sep" />
              <button className="icon-btn icon-btn--sm" onClick={() => alignMulti("left")} aria-label="Align left" data-tip="Align left"><Icon name="align_left" size={18} /></button>
              <button className="icon-btn icon-btn--sm" onClick={() => alignMulti("center-h")} aria-label="Align centre" data-tip="Align horizontal centre"><Icon name="align_center_h" size={18} /></button>
              <button className="icon-btn icon-btn--sm" onClick={() => alignMulti("right")} aria-label="Align right" data-tip="Align right"><Icon name="align_right" size={18} /></button>
              <span className="multibar__sep" />
              <button className="icon-btn icon-btn--sm" onClick={() => alignMulti("top")} aria-label="Align top" data-tip="Align top"><Icon name="align_top" size={18} /></button>
              <button className="icon-btn icon-btn--sm" onClick={() => alignMulti("middle")} aria-label="Align middle" data-tip="Align vertical centre"><Icon name="align_center_v" size={18} /></button>
              <button className="icon-btn icon-btn--sm" onClick={() => alignMulti("bottom")} aria-label="Align bottom" data-tip="Align bottom"><Icon name="align_bottom" size={18} /></button>
              <span className="multibar__sep" />
              <button className="icon-btn icon-btn--sm" onClick={() => distributeMulti("h")} disabled={multi.length < 3} aria-label="Distribute horizontally" data-tip="Distribute horizontally"><Icon name="distribute_h" size={18} /></button>
              <button className="icon-btn icon-btn--sm" onClick={() => distributeMulti("v")} disabled={multi.length < 3} aria-label="Distribute vertically" data-tip="Distribute vertically"><Icon name="distribute_v" size={18} /></button>
              <span className="multibar__sep" />
              <button className="icon-btn icon-btn--sm" onClick={() => arrangeSelection("front")} disabled={!canArrange} aria-label="Bring to front" data-tip="Bring to front · ]"><Icon name="bring_front" size={18} /></button>
              <button className="icon-btn icon-btn--sm" onClick={() => arrangeSelection("back")} disabled={!canArrange} aria-label="Send to back" data-tip="Send to back · ["><Icon name="send_back" size={18} /></button>
              <span className="multibar__sep" />
              <button className="icon-btn icon-btn--sm" onClick={duplicateMulti} aria-label="Duplicate" data-tip="Duplicate"><Icon name="duplicate" size={18} /></button>
              <button className="icon-btn icon-btn--sm" onClick={deleteMulti} aria-label="Delete" data-tip="Delete"><Icon name="delete" size={18} /></button>
              <button className="icon-btn icon-btn--sm" onClick={clearMulti} aria-label="Clear selection" data-tip="Clear"><Icon name="close" size={18} /></button>
            </div>
          )}

          {tool === "draw" && (
            <DrawToolbar
              drawTool={drawTool}
              setDrawTool={setDrawTool}
              drawStyle={drawStyle}
              setDrawStyle={setDrawStyle}
              open={drawbarOpen}
              setOpen={setDrawbarOpen}
            />
          )}

          {/* Contextual quick-bar — the fast path to edits at the object.
              Mobile: instead of auto-opening the sheet. Desktop: only when the
              Inspector is collapsed (canvas-max mode); its Style action reopens
              the Inspector for the full controls. */}
          {selection &&
            selection.kind !== "stamp" &&
            (compact ? !sheetOpen : !inspectorOpen) && (
              <SelectionBar
                key={`${selection.kind}-${selection.id}`}
                selection={selection}
                annotationKind={selectedAnnotation?.kind}
                onEdit={editSelection}
                onStyle={() => (compact ? setSheetOpen(true) : setInspectorOpen(true))}
                onDelete={onDelete}
                onClose={() => setSelection(null)}
              />
            )}
        </div>

        {/* Adaptive Inspector. Desktop: a persistent right column that
            collapses to an edge tab; never empty (properties when something is
            selected, document/finishing actions otherwise). Mobile: keeps the
            on-demand bottom sheet driven by the contextual SelectionBar. */}
        {isWide ? (
          inspectorOpen ? (
            <aside className="inspector">
              {/* Two tabs, not one surface wearing two hats. This panel used to
                  swap between a list of document actions and the properties of
                  the selection with nothing to say it had — so the controls you
                  came for vanished the moment you clicked the page, and the ones
                  that replaced them looked like they had always been there.
                  Naming both states makes the switch legible and, more to the
                  point, reversible: you can read a fragment's properties and
                  still get back to Compress without deselecting. */}
              <div className="inspector__tabs">
                <div className="inspector__tablist" role="tablist" aria-label="Panel">
                  {PANEL_TABS.map((t) => (
                    <button
                      key={t.key}
                      id={`panel-tab-${t.key}`}
                      role="tab"
                      className={`inspector__tabbtn${panelTab === t.key ? " inspector__tabbtn--on" : ""}`}
                      aria-selected={panelTab === t.key}
                      aria-controls="panel-body"
                      tabIndex={panelTab === t.key ? 0 : -1}
                      onClick={() => setPanelTab(t.key)}
                      onKeyDown={onPanelTabKeyDown}
                    >
                      <Icon name={t.icon} size={16} />
                      <span className="label-large">{t.label}</span>
                    </button>
                  ))}
                </div>
                <button
                  className="icon-btn icon-btn--sm"
                  onClick={() => setInspectorOpen(false)}
                  aria-label="Hide panel"
                  data-tip="Hide panel"
                >
                  <Icon name="chevron_right" size={18} />
                </button>
              </div>
              <div
                id="panel-body"
                role="tabpanel"
                aria-labelledby={`panel-tab-${panelTab}`}
              >
                {panelTab === "document" ? documentPanel : propertiesPanel}
              </div>
            </aside>
          ) : (
            <button
              className="inspector__tab"
              onClick={() => setInspectorOpen(true)}
              // The label used to be set sideways with `writing-mode`, which is
              // slow to read at any size and was carrying the same information
              // the icon already gives.
              aria-label="Show panel"
              data-tip="Show panel"
            >
              <Icon name="sliders" size={18} />
            </button>
          )
        ) : (
          sheetOpen &&
          panelSelection && (
            <>
              {/* Visual dim only (pointer-events:none in CSS). Dismiss the
                  on-demand sheet via its Close button, tapping the canvas
                  through the dim, or Esc. */}
              <div className="scrim" aria-hidden="true" />
              <aside className="panel">{propertiesPanel}</aside>
            </>
          )
        )}
      </div>

      {/* Persistent, visually-hidden live regions guarantee the status is
          announced by assistive tech even though the visible snackbar mounts
          and unmounts. Errors are assertive; everything else is polite. */}
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {status === "error" ? "" : message}
      </div>
      <div className="sr-only" role="alert" aria-live="assertive" aria-atomic="true">
        {status === "error" ? message : ""}
      </div>
      {message && (
        <div
          className={`snackbar body-medium${status === "error" ? " snackbar--err" : ""}${busy ? " snackbar--busy" : ""}`}
        >
          {/* The message text is announced by the sr-only live regions above,
              so it's hidden from AT here to avoid a double read. The Cancel
              button, however, must stay in the accessibility tree and the tab
              order — so this container is NOT aria-hidden. */}
          {busy && <span className="spinner spinner--sm" aria-hidden="true" />}
          <span className="snackbar__msg" aria-hidden="true">{message}</span>
          {busy && onCancel && (
            <button className="snackbar__cancel" onClick={() => onCancel()} aria-label="Cancel the current operation">
              Cancel
            </button>
          )}
        </div>
      )}

      {passwordDialog}

      {sigOpen && (
        <Suspense fallback={null}>
          <SignatureDialog
            onClose={() => setSigOpen(false)}
            onCreate={(sig) => {
              setSigOpen(false);
              setPendingStamp(sig);
              setStatus("ready");
              setMessage(placeHint("your signature"));
            }}
          />
        </Suspense>
      )}

      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void startImagePlacement(f);
          e.target.value = "";
        }}
      />

      <input
        ref={openInputRef}
        type="file"
        accept="application/pdf,.pdf"
        multiple
        hidden
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = "";
          void openFiles(files);
        }}
      />

      {confirmCloseId && (() => {
        const name = confirmCloseId === activeId ? fileName : tabs.find((t) => t.id === confirmCloseId)?.fileName ?? "this PDF";
        const last = tabs.length === 1;
        const downloaded =
          confirmCloseId === activeId ? !unsaved : !(tabs.find((t) => t.id === confirmCloseId)?.unsaved ?? true);
        return (
          <ConfirmDialog
            title={last ? "Close this PDF?" : `Close ${name}?`}
            message={
              downloaded
                ? `You downloaded ${name}, so your changes should be in that file. If the download didn't finish, closing loses them.`
                : `Your unsaved changes to ${name} will be discarded. Download the edited file first if you want to keep it.`
            }
            confirmLabel={downloaded ? "Close" : "Discard & close"}
            danger={!downloaded}
            onConfirm={() => closeTab(confirmCloseId)}
            onCancel={() => {
              const id = confirmCloseId;
              setConfirmCloseId(null);
              // Back to the tab the close was asked from, not <body>.
              requestAnimationFrame(() =>
                document.querySelector<HTMLElement>(`[data-doc-tab="${CSS.escape(id)}"]`)?.focus(),
              );
            }}
          />
        );
      })()}

      {coverWarn && (
        <ConfirmDialog
          title="Whiteout doesn't remove the text"
          message={`${coverWarn.count} whiteout cover${coverWarn.count > 1 ? "s" : ""} (page ${coverWarn.pages.join(", ")}) sit over live text that stays readable — by copy/paste or search — in the downloaded file. For content that must be permanently removed, use the Redact tool instead. Download anyway?`}
          confirmLabel="Download anyway"
          cancelLabel="Go back"
          danger
          onConfirm={() => {
            setCoverWarn(null);
            void runExport();
          }}
          onCancel={() => setCoverWarn(null)}
        />
      )}

      {finishTab && (
        <Suspense fallback={null}>
          <FinishDialog
            initialTab={finishTab}
            currentNumbers={pageNumbers}
            currentWatermark={watermark}
            onApplyNumbers={applyNumbers}
            onApplyWatermark={applyWatermark}
            onClearNumbers={clearNumbers}
            onClearWatermark={clearWatermark}
            onClose={() => setFinishTab(null)}
          />
        </Suspense>
      )}

      {compressOpen && (
        <Suspense fallback={null}>
          <CompressDialog onEstimate={estimateCompress} onDownload={downloadCompress} onClose={() => setCompressOpen(false)} />
        </Suspense>
      )}

      {signCertOpen && (
        <Suspense fallback={null}>
          <SignCertDialog onSign={signWithCert} onClose={() => setSignCertOpen(false)} />
        </Suspense>
      )}

      {cmdOpen && (
        <CommandPalette
          onClose={() => setCmdOpen(false)}
          commands={
            [
              // Tools come from `TOOLS`, not a second hand-written copy of it: the
              // palette's duplicate list had drifted to icon names the dock no
              // longer used, so half the tools drew a blank square here.
              ...TOOLS.map((t) => ({
                id: t.key,
                label: t.label,
                hint: TOOL_SHORTCUT[t.key],
                icon: t.icon,
                run: () => pickTool(t.key),
              })),
              { id: "duplicate", label: "Duplicate selection", hint: "Ctrl+D", icon: "duplicate", disabled: !selection || selection.kind === "fragment", run: duplicateSelection },
              { id: "find", label: "Find in document", hint: "Ctrl+F", icon: "search", run: openFind },
              ...(pdf && pdf.pages.length > 1
                ? [{ id: "goto", label: "Go to page…", icon: "go_to_page", keywords: "jump page number", run: openPageJump }]
                : []),
              { id: "pages", label: navOpen ? "Hide page thumbnails" : "Show page thumbnails", icon: navOpen ? "panel_close" : "panel_open", run: () => setNavOpen((v) => !v) },
              { id: "undo", label: "Undo", hint: "Ctrl+Z", icon: "undo", disabled: !docHistory.canUndo, run: undo },
              { id: "redo", label: "Redo", hint: "Ctrl+Shift+Z", icon: "redo", disabled: !docHistory.canRedo, run: redo },
              // Document/finishing actions come from the shared source of truth.
              ...docActions.map((a) => ({ id: a.id, label: a.label, icon: a.icon, keywords: a.keywords, opens: a.opens, run: a.run })),
              { id: "dim", label: dimPages ? "Undim pages" : "Dim pages", icon: "contrast", run: () => setDimPages((v) => !v) },
              { id: "theme", label: `Theme: ${themeLabel}`, icon: themeIcon, keywords: "dark light system", run: theme.cycle },
              { id: "download", label: "Download PDF", hint: "", icon: "download", run: download },
              { id: "open", label: "Open another PDF", hint: "Ctrl+O", icon: "note_add", run: openAnother },
              ...tabs
                .filter((t) => t.id !== activeId)
                .map((t) => ({
                  id: `tab-${t.id}`,
                  label: `Switch to ${t.fileName}`,
                  icon: "picture_as_pdf",
                  keywords: "tab document file switch",
                  run: () => switchTo(t.id),
                })),
              ...(tabs.length > 1
                ? [{ id: "download-all", label: `Download all (${tabs.length}) as ZIP`, icon: "download_all", keywords: "zip every all tabs documents", run: () => void downloadAll() }]
                : []),
              { id: "close", label: "Close document", icon: "close", keywords: "home start exit leave", run: goHome },
            ] as Command[]
          }
        />
      )}

      {organizeOpen && pdf && (
        <Suspense fallback={null}>
          <Organize
            mainBytes={pdf.bytes}
            fileName={fileName}
            hasEdits={changeCount > 0}
            onApply={(bytes, note) => {
              setOrganizeOpen(false);
              // The result *is* the edits, baked in: still unsaved work, so the
              // tab stays dirty and autosaved, and closing it asks.
              // Pages pulled in from a password-opened tab make the result one
              // too, or merging would be a way round "never stored on the device".
              const tookLocked = organizeTookLocked.current;
              organizeTookLocked.current = false;
              void openBytes(bytes, fileName, note, undefined, {
                replace: true,
                baked: Math.max(1, changeCount),
                ...(tookLocked ? { locked: true } : {}),
              });
            }}
            onExtract={(bytes) =>
              downloadBytes(bytes, fileName.replace(/\.pdf$/i, "") + "-extract.pdf")
            }
            onClose={() => {
              organizeTookLocked.current = false;
              setOrganizeOpen(false);
            }}
            otherDocs={tabs
              .filter((t) => t.id !== activeId)
              .map((t) => ({
                id: t.id,
                name: t.fileName,
                bake: async () => {
                  // Conservative: a locked tab baked at all marks the result,
                  // even if its pages are later taken back out of the plan.
                  if (t.locked) organizeTookLocked.current = true;
                  const { exportPdf } = await import("./pdf/exporter");
                  const state = t.history ? t.history.entries[t.history.index] : EMPTY_DOC;
                  // The same guard as Download: a whiteout over live text would
                  // be merged in looking redacted while the text stays readable.
                  const warn = findUnsafeCovers(t.pdf, state.redactions);
                  if (warn.count > 0) {
                    throw Object.assign(
                      new Error(`"${t.fileName}" has whiteout over live text (page ${warn.pages.join(", ")}). Redact it instead, then add its pages.`),
                      { userFacing: true },
                    );
                  }
                  return toAB(await exportPdf(t.pdf, { ...EMPTY_DOC, ...state, losslessRaster }));
                },
              }))}
          />
        </Suspense>
      )}
    </div>
  );
}
