import {
  Fragment,
  Suspense,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type KeyboardEvent as ReactKeyboardEvent,
  type MutableRefObject,
  type Ref,
  type SetStateAction,
} from "react";
import { PageView, type AnnotSpec } from "./components/PageView";
import { translateAnnotation } from "./components/AnnotationLayer";
import { PropertiesPanel } from "./components/PropertiesPanel";
import { DocumentPanel } from "./components/DocumentPanel";
import { fieldValue, hasValue, sameValue } from "./components/FormFieldLayer";
import { DrawToolbar, SUBTOOLS } from "./components/DrawToolbar";
import { SelectionBar } from "./components/SelectionBar";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { FindBar } from "./components/FindBar";
import { PatternPanel } from "./components/PatternPanel";
import { PageNav } from "./components/PageNav";
import { PageJump } from "./components/PageJump";
import { CommandPalette, GROUP_LABEL, ariaKeys, type Command, type CommandGroup } from "./components/CommandPalette";
import { Icon } from "./components/Icon";
import { leftOutNote } from "./pdf/standardText";
import { keptFillableNote } from "./keptNote";
import { findMatches, findPatternMatches, joinPage, extractText, type FindMatch, type PatternHit } from "./pdf/find";
import { PATTERN_PRESETS, customMatcher } from "./pdf/patterns";
import { fitCrop, isIdentityPlan, quarterTurn, resolvePlan, samePlan, shownToUserDelta, shownPages, shownSize, uprightFor, userToShown, userToShownBox } from "./pdf/pagePlan";
import { boxCX, boxCY } from "./pdf/bbox";
import { findUnsafeCovers, type CoverWarning } from "./pdf/redactionSafety";
import { completeText, pagesPending } from "./pdf/textIndex";
import { downloadBytes, downloadText } from "./download";
import { canSaveAs, canShareFiles, mayWrite, pdfFile, pickSaveTarget, sameFile, shareFile, writeTo, type FileHandle } from "./fileAccess";

/** Where a finished file goes. */
type Delivery =
  | { kind: "download"; password?: string }
  | { kind: "save"; target: FileHandle }
  | { kind: "save-as"; target: FileHandle }
  | { kind: "share" };

const DELIVERY_VERB: Record<Delivery["kind"], string> = { download: "Download", save: "Save", "save-as": "Save", share: "Share" };
import { onStrayBack, pushHistory, unwindHistory, type HistoryEntry } from "./hooks/useModal";
import { plural } from "./plural";
import type { FormField, FormValue, PageNumberOptions, PageRef, WatermarkOptions } from "./pdf/types";
import { useHistory } from "./hooks/useHistory";
import { useCustomPattern } from "./hooks/useCustomPattern";
import { EMPTY_DOC, aModalIsOpen, parkedState, toAB, type EditorHandle, type LiveDoc, type OpenDoc, type SavedMark, type Status } from "./workspace";
import { usePageArrays, usePageRecords, usePageSets } from "./hooks/usePageBuckets";
import { DocTabs } from "./components/DocTabs";
import { useMediaQuery } from "./hooks/useMediaQuery";
import { useFragmentFont } from "./hooks/usePageFonts";
import { peekPageFonts, subscribeFonts } from "./pdf/fontInfo";
import { useFragmentColors } from "./hooks/usePageColors";
import { usePersistentState } from "./hooks/usePrefs";
import { useTheme } from "./hooks/useTheme";
import { useViewport, type Fit } from "./hooks/useViewport";
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
import { lazyPart, staleBuildMessage } from "./staleBuild";
import { readOutline, type OutlineEntry } from "./pdf/outline";

// On-demand modals — each pulls in heavy code (pdf-lib, canvas rendering) that
// isn't needed until the user opens it, so they're code-split out of the
// initial bundle.
const Organize = lazyPart(() => import("./components/Organize").then((m) => m.Organize));
const SignatureDialog = lazyPart(() => import("./components/SignatureDialog").then((m) => m.SignatureDialog));
const FinishDialog = lazyPart(() => import("./components/FinishDialog").then((m) => m.FinishDialog));
const CompressDialog = lazyPart(() => import("./components/CompressDialog").then((m) => m.CompressDialog));
const CropDialog = lazyPart(() => import("./components/CropDialog").then((m) => m.CropDialog));
const HiddenInfoDialog = lazyPart(() => import("./components/HiddenInfoDialog").then((m) => m.HiddenInfoDialog));
const ProtectDialog = lazyPart(() => import("./components/ProtectDialog").then((m) => m.ProtectDialog));
const SignCertDialog = lazyPart(() => import("./components/SignCertDialog").then((m) => m.SignCertDialog));
const CompareDialog = lazyPart(() => import("./components/CompareDialog").then((m) => m.CompareDialog));
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
import { IS_MAC } from "./platform";

type NavKey = Tool | "sign";


// Stable identities for the "field absent from an older DocState" case. Fresh
// `[]` / `{}` literals here would be a new object on every render, which defeats
// the memo on PageView and re-renders every page of the document per keystroke.
const NO_LINKS: LinkAnnot[] = [];
const NO_FORM_VALUES: Record<string, FormValue> = {};

/** What a page with nothing of a kind on it gets: one shared identity each, so
 * its props stay referentially equal and the memo'd `PageView` skips it. */
const NO_ITEMS: never[] = [];
const NO_EDITS: Edits = {};
const NO_IDS: Set<string> = new Set();
const pageItems = <T,>(map: Map<number, T[]>, pageIndex: number): T[] =>
  map.get(pageIndex) ?? NO_ITEMS;

/** The ⋯ menu's groups, in order. Its rows come out of the command registry
 * by group (see `commands` below), so the menu can't list a command the
 * palette doesn't, or label it differently. */
const MENU_GROUPS: CommandGroup[] = ["organise", "text", "finish"];
/** Keyboard for a `role="menu"` list (ARIA menu pattern): arrows, Home/End
 * walk the items, Escape closes and returns focus to the button that opened
 * it, Tab closes and lets focus move on. Shared by the ⋯ and Export menus. */
function menuKeys(
  list: { current: HTMLElement | null },
  button: { current: HTMLElement | null },
  close: () => void,
) {
  return (e: ReactKeyboardEvent) => {
    // A shortcut with a modifier (Ctrl+O, Ctrl+K…) is for the app: the menu
    // gets out of its way. Every other key is the menu's own — it mustn't also
    // reach the editor, where an arrow nudges the selected box, Delete deletes
    // it and a letter switches tools behind the open menu.
    if (e.ctrlKey || e.metaKey || e.altKey) {
      close();
      return;
    }
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      button.current?.focus();
      return;
    }
    const items = Array.from(
      list.current?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)') ?? [],
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
    else if (e.key === "Tab") {
      close();
    }
  };
}

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

/** True when focus is in a text-entry context — or on any form field, whose
 * keys (arrows between radio buttons, Space to tick) are its own — so
 * single-key shortcuts, Delete and arrow-nudge must not hijack the keystroke. */
function isTypingTarget(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  return (
    el.isContentEditable ||
    !!el.closest(".formlayer") ||
    el.tagName === "INPUT" ||
    el.tagName === "TEXTAREA" ||
    el.tagName === "SELECT"
  );
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

export interface DocumentEditorProps {
  /** The document in front. Its `history` and `view` seed this editor once, on
   * mount; `pdf`, `fileName`, `baked`, `saved` and `locked` stay live. */
  entry: OpenDoc;
  /** Every open document, this one included, in tab order. */
  tabs: OpenDoc[];
  status: Status;
  setStatus: (s: Status) => void;
  setMessage: (m: string) => void;
  setOnCancel: Dispatch<SetStateAction<null | (() => void)>>;
  /** Object ids are unique across the whole workspace, so the counter is too. */
  idCounter: MutableRefObject<number>;
  handleRef: Ref<EditorHandle>;
  /** The workspace's fit-to-width measurement: read once as this editor
   * mounts, kept current while it is in front (see {@link Fit}). */
  fitRef: MutableRefObject<Fit | null>;
  onLive: (live: LiveDoc) => void;
  /** This document was handed to the user whole (Download, Compress, signing). */
  onSaved: (id: string, mark: SavedMark, saveAs?: { handle: FileHandle; fileName: string }) => void;
  /** OCR added text to these bytes' pages: every tab showing them gets it. */
  onPages: (bytes: ArrayBuffer, pages: LoadedPdf["pages"]) => void;
  /** Rebuild this document from new bytes (Organise's merge). */
  onReplace: (bytes: ArrayBuffer, note: string, seed: DocState | undefined, opts: { baked: number; locked?: boolean }) => void;
  onSwitch: (id: string) => void;
  onCloseTab: (id: string) => void;
  onOpenAnother: () => void;
  /** The name of another open tab that is this file on disk, if any. */
  openElsewhere: (handle: FileHandle, except: string) => Promise<string | undefined>;
  onDownloadAll: () => void;
  // App-wide chrome and preferences: kept by the workspace, so they survive
  // switching documents.
  navOpen: boolean;
  setNavOpen: Dispatch<SetStateAction<boolean>>;
  drawbarOpen: boolean;
  setDrawbarOpen: Dispatch<SetStateAction<boolean>>;
  inspectorOpen: boolean;
  setInspectorOpen: Dispatch<SetStateAction<boolean>>;
  dimPages: boolean;
  setDimPages: Dispatch<SetStateAction<boolean>>;
  autosaveOn: boolean;
  onToggleAutosave: () => void;
  losslessRaster: boolean;
  setLosslessRaster: Dispatch<SetStateAction<boolean>>;
  theme: ReturnType<typeof useTheme>;
}

/** One document, in front: everything that belongs to the file rather than to
 * the app. Mounted fresh per document (see `workspace.ts`). */
/** Documents (by tab id) whose picture-page hint was dismissed or acted on,
 * for this page's lifetime. Never stored: it's a nudge, not a setting. */
const hintSettled = new Set<string>();

export const DocumentEditor = memo(function DocumentEditor({
  entry,
  tabs,
  status,
  setStatus,
  setMessage,
  setOnCancel,
  idCounter,
  handleRef,
  fitRef,
  onLive,
  onSaved,
  onPages,
  onReplace,
  onSwitch,
  onCloseTab,
  onOpenAnother,
  openElsewhere,
  onDownloadAll,
  navOpen,
  setNavOpen,
  drawbarOpen,
  setDrawbarOpen,
  inspectorOpen,
  setInspectorOpen,
  dimPages,
  setDimPages,
  autosaveOn,
  onToggleAutosave,
  losslessRaster,
  setLosslessRaster,
  theme,
}: DocumentEditorProps) {
  const { pdf, fileName, baked, saved: savedMark, locked, id: activeId, handle, handleLocked } = entry;
  const [tool, setTool] = useState<Tool>("select");
  /** "This page is a picture" — offered the first time the user clicks a page
   * with no text layer to edit (a scan, or a "print to PDF" that flattened
   * every page to an image). Clicking such a page used to do nothing at all,
   * which reads as "editing is broken". Once dismissed, or once OCR has been
   * asked for, it stays away for this document — across tab switches too,
   * which remount this editor (hence the module-level set). */
  const [pictureHint, setPictureHint] = useState<"off" | "shown" | "done">(() =>
    hintSettled.has(entry.id) ? "done" : "off",
  );
  const settleHint = useCallback(() => {
    hintSettled.add(entry.id);
    setPictureHint("done");
  }, [entry.id]);
  /** Where the current press began: only a click that stayed put counts — the
   * press that starts a scroll, pan or pinch must not raise the hint. */
  const pressAt = useRef<{ x: number; y: number } | null>(null);
  /** Organise pulled pages from a password-opened tab (see its `onApply`). */
  const organizeTookLocked = useRef(false);
  const docHistory = useHistory<DocState>(EMPTY_DOC, undefined, entry.history);
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
  const formFlatten = !!docHistory.state.formFlatten;
  const pageNumbers = docHistory.state.pageNumbers ?? null;
  const watermark = docHistory.state.watermark ?? null;
  // The pages as shown: plan order, each with its total turn. Every view that
  // walks pages in order (the viewer, the rail, find, page numbers, export)
  // walks this; anything that looks a page *up* by an object's `pageIndex`
  // still uses `pdf.pages`, since overlay objects keep their source index.
  const planned = docHistory.state.pages;
  // On the page count, not `pdf`: the document object changes as its text
  // arrives, and a new plan each time re-keyed the page indicator and rail.
  const pageCount = pdf?.pages.length ?? 0;
  const plan = useMemo(() => resolvePlan(planned, pageCount), [pageCount, planned]);
  const shown = useMemo(() => (pdf ? shownPages(pdf.pages, plan) : []), [pdf, plan]);
  const shownBySource = useMemo(() => new Map(shown.map((p) => [p.pageIndex, p])), [shown]);
  // Source page → its position as shown, for anything that names a page by
  // where the reader finds it (a link to a page, a bookmark).
  const posBySource = useMemo(() => new Map(plan.map((p, i) => [p.index, i])), [plan]);
  // The document's own bookmarks, read once from the parse the pages use.
  const pdfBytes = pdf?.bytes;
  const [outline, setOutline] = useState<OutlineEntry[]>([]);
  const [navView, setNavView] = useState<"pages" | "outline">("pages");
  useEffect(() => {
    if (!pdfBytes) return;
    let live = true;
    void readOutline(pdfBytes).then((o) => live && setOutline(o));
    return () => {
      live = false;
    };
  }, [pdfBytes]);
  // What the Inspector says about the document with nothing selected.
  const pageFacts = useMemo(
    () =>
      shown.map((p) => {
        const { width, height } = shownSize(p);
        let ocr = 0;
        for (const f of p.fragments) if (f.id.startsWith("ocr:")) ocr++;
        return { width, height, text: p.fragments.length - ocr, ocr, ocrRead: !!p.ocrRead, ...(p.textPending ? { pending: true } : {}) };
      }),
    [shown],
  );
  // Every field in the file, by name — the first widget of each, which holds
  // the value the file came with.
  const formFieldsByName = useMemo(() => {
    const byName = new Map<string, FormField>();
    if (pdf) for (const p of pdf.pages) for (const f of p.fields) if (!byName.has(f.name)) byName.set(f.name, f);
    return byName;
  }, [pdf]);
  // The form, as the Inspector describes it: fields by name (a radio group is
  // one field however many buttons it has), and how many hold a value.
  const formFacts = useMemo(() => {
    const byName = new Map<string, FormField>();
    for (const p of shown) for (const f of p.fields) if (!byName.has(f.name)) byName.set(f.name, f);
    let filled = 0;
    for (const f of byName.values()) if (hasValue(fieldValue(f, formValues))) filled++;
    return { fields: byName.size, filled };
  }, [shown, formValues]);
  /** Apply a page plan (reorder, turn, delete) as one undoable edit. Stored
   * only when it changes something, so an arrangement put back by hand reads as
   * the document as loaded. The sidebar and the grid both come through here. */
  const applyPlan = (next: PageRef[]): boolean => {
    if (!pdf || next.length === 0 || samePlan(next, plan)) return false;
    const pages = isIdentityPlan(next, pdf.pages.length)
      ? undefined
      : next.map((p) => {
          const crop = fitCrop(p.crop, pdf.pages[p.index].viewBox);
          return { index: p.index, rotate: quarterTurn(p.rotate), ...(crop ? { crop } : {}) };
        });
    doc.set((d) => ({ ...d, pages }));
    return true;
  };
  const arrangePages = (next: PageRef[], note: string) => {
    if (applyPlan(next)) setMessage(note);
  };
  /** The shown position of the page most in view: what a command about "this
   * page" means. */
  const pageInView = (): number => {
    const scroller = document.querySelector<HTMLElement>(".viewer__scroll");
    const els = [...document.querySelectorAll<HTMLElement>(".page[data-page-pos]")];
    if (!scroller || els.length === 0) return 0;
    const view = scroller.getBoundingClientRect();
    let best = 0;
    let bestSeen = -1;
    for (const el of els) {
      const r = el.getBoundingClientRect();
      const seen = Math.max(0, Math.min(r.bottom, view.bottom) - Math.max(r.top, view.top));
      if (seen > bestSeen) {
        bestSeen = seen;
        best = Number(el.dataset.pagePos) || 0;
      }
    }
    return best;
  };
  /** Crop one page, or every page by the same margins, as one undoable edit. */
  const cropPages = (scope: "page" | "all", m: import("./components/CropDialog").Margins, cropFromMargins: typeof import("./components/CropDialog").cropFromMargins) => {
    const at = cropAt;
    setCropAt(null);
    if (at == null) return;
    const next = plan.map((p, pos) => {
      if (scope === "page" && pos !== at) return p;
      const crop = cropFromMargins(shown[pos], m);
      return { index: p.index, rotate: p.rotate, ...(crop ? { crop } : {}) };
    });
    if (!applyPlan(next)) return;
    const cropped = next.some((p) => p.crop);
    setMessage(
      scope === "all"
        ? cropped ? `Cropped all ${plural(next.length, "page")}.` : "Every page shows in full again."
        : next[at].crop ? `Cropped page ${at + 1}.` : `Page ${at + 1} shows in full again.`,
    );
  };
  /** The turn the page holding object `id` is shown at (0 if not found). */
  const turnOfObject = useCallback(
    (id: string | undefined): number => {
      if (!id) return 0;
      const s = docHistory.state;
      const owner = [...s.textBoxes, ...s.redactions, ...s.annotations, ...s.stamps, ...(s.links ?? [])].find((o) => o.id === id);
      return owner ? (shownBySource.get(owner.pageIndex)?.rotation ?? 0) : 0;
    },
    [docHistory.state, shownBySource],
  );
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
  const [sigOpen, setSigOpen] = useState(false);
  const [finishTab, setFinishTab] = useState<"numbers" | "watermark" | null>(null);
  const [pendingStamp, setPendingStamp] = useState<{ dataUrl: string; w: number; h: number } | null>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const [selection, setSelection] = useState<Selection>(null);
  // Mobile: the full properties sheet only opens on demand (via the selection
  // bar), and text elements only become editable in an explicit edit mode —
  // so a single tap selects without a sheet covering the object or the
  // keyboard popping up. (`compact`/`sheetOpen` defined below, after isWide.)
  const [sheetOpen, setSheetOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [autoFocusId, setAutoFocusId] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  // Organise opens as its grid, or straight into Split from the Export menu.
  const [organizeOpen, setOrganizeOpen] = useState<false | "grid" | "split">(false);
  const [coverWarn, setCoverWarn] = useState<CoverWarning | null>(null);
  const [protectOpen, setProtectOpen] = useState(false);
  /** Where the file being made goes — and, for a download with a password,
   * that password — held only until it's made (or the whiteout warning in
   * between is cancelled). Never stored. */
  const pendingDelivery = useRef<Delivery>({ kind: "download" });
  /** Saving in place over a file that opened with a password: asked first. */
  const [unlockWarn, setUnlockWarn] = useState(false);
  /** A built file waiting for a tap to open the share sheet (see `shareFile`). */
  const [shareReady, setShareReady] = useState<File | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findActive, setFindActive] = useState(0);
  // ---- Redact patterns ----
  // Shares the find highlight, the active hit and its scrolling: the two are
  // never open together, and whichever is open supplies `matches`.
  const [patternOpen, setPatternOpen] = useState(false);
  // Dates are off to begin with: most documents are full of them, and they
  // are rarely what someone is redacting.
  const [patternKinds, setPatternKinds] = useState<string[]>(() =>
    PATTERN_PRESETS.filter((p) => p.id !== "date").map((p) => p.id),
  );
  const [patternCustom, setPatternCustom] = useState("");
  const [patternExcluded, setPatternExcluded] = useState<ReadonlySet<string>>(() => new Set());
  const [cmdOpen, setCmdOpen] = useState(false);
  // The zoom pill's page chip is a number field (go to page).
  const [pageJumpOpen, setPageJumpOpen] = useState(false);
  const [multi, setMulti] = useState<string[]>([]);
  const [compressOpen, setCompressOpen] = useState(false);
  const [signCertOpen, setSignCertOpen] = useState(false);
  const [hiddenOpen, setHiddenOpen] = useState(false);
  const [compareOpen, setCompareOpen] = useState(false);
  /** The shown position of the page the Crop dialog is open on. */
  const [cropAt, setCropAt] = useState<number | null>(null);
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  const menuListRef = useRef<HTMLDivElement>(null);
  // The Export menu, from the caret beside Download.
  const [exportOpen, setExportOpen] = useState(false);
  const exportBtnRef = useRef<HTMLButtonElement>(null);
  const exportListRef = useRef<HTMLDivElement>(null);
  const nextId = (prefix: string) => `${prefix}-${idCounter.current++}`;

  const vp = useViewport(fitRef.current, () => fitRef.current);
  const { fitWidth, pageWidthPts } = vp.fit;
  // A form box or radio keeps focus after a click, and keys go to it (Space
  // ticks, arrows move the choice). Selecting something else on the page
  // mostly prevents the pointer's default, which would have moved focus — so
  // hand focus back here, or Delete and arrow-nudge would still go to the box.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const el = document.activeElement as HTMLElement | null;
      if (!el?.closest(".formlayer")) return;
      if (e.target instanceof Node && el.contains(e.target)) return;
      el.blur();
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, []);

  /** The fit this editor last handed on. Only a change is handed on: coming
   * back from behind another document re-runs this effect with the fit it had
   * when it left, and writing that would overwrite the one it is about to
   * take (the window may have been resized meanwhile, see `useViewport`). */
  const handedOn = useRef("");
  useEffect(() => {
    const at = `${fitWidth}:${pageWidthPts}`;
    if (fitWidth > 0 && pageWidthPts > 0 && at !== handedOn.current) {
      handedOn.current = at;
      fitRef.current = { fitWidth, pageWidthPts };
    }
  }, [fitRef, fitWidth, pageWidthPts]);
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

  const editedFragmentCount = useMemo(() => {
    if (!pdf) return 0;
    let n = [...fragmentById.values()].filter((f) =>
      shownBySource.has(f.pageIndex) && isFragmentModified(f, edits[f.id]),
    ).length;
    // An edit restored onto a page whose text hasn't been read yet: its
    // fragment isn't known, so it can't be compared with the original — count
    // it, so the document doesn't read as unchanged (and closable without a
    // word) until its text arrives. Likewise a page whose text couldn't be
    // read: the edit can't be placed, and it's still a change someone made.
    const pending = new Set(pdf.pages.filter((p) => p.textPending || p.textUnreadable).map((p) => p.pageIndex));
    if (pending.size)
      for (const id of Object.keys(edits)) {
        const at = Number(id.slice(0, id.indexOf(":")));
        if (!fragmentById.has(id) && pending.has(at) && shownBySource.has(at)) n++;
      }
    return n;
  }, [pdf, fragmentById, edits, shownBySource]);
  // Only what ships: markup on a deleted page stays in the state (undo brings
  // the page back with it) but isn't a change to the file.
  const shippedOverlays = useMemo(
    () =>
      [textBoxes, redactions, annotations, stamps, links].reduce(
        (n, list) => n + (list as { pageIndex: number }[]).filter((o) => shownBySource.has(o.pageIndex)).length,
        0,
      ),
    [textBoxes, redactions, annotations, stamps, links, shownBySource],
  );
  const changeCount =
    editedFragmentCount + shippedOverlays + Object.keys(formValues).length + (formFlatten ? 1 : 0) +
    (pageNumbers ? 1 : 0) + (watermark ? 1 : 0) + (planned ? 1 : 0) + baked;
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
  const searching = findOpen || patternOpen;
  useEffect(() => {
    if (!searching) return;
    return subscribeFonts(() => setFontsVersion((v) => v + 1));
  }, [searching]);
  const fontFor = useCallback(
    (f: TextFragment) => (pdf ? peekPageFonts(pdf.bytes, f.pageIndex).get(f.itemIndex) ?? null : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fontsVersion is the store's version
    [pdf, fontsVersion],
  );
  const custom = useMemo(() => customMatcher(patternCustom), [patternCustom]);
  // The shown pages' text as the patterns see it, joined once and shared by
  // the presets (matched here) and a custom pattern (matched in a worker, which
  // can be stopped: see useCustomPattern).
  const patternJoined = useMemo(
    () => (pdf && patternOpen ? shown.map((p) => joinPage(p, edits)) : null),
    [pdf, patternOpen, shown, edits],
  );
  const customRun = useCustomPattern(custom && !("error" in custom) ? patternCustom.trim() : "", patternJoined);
  const patternResult = useMemo(() => {
    if (!pdf || !patternOpen || !patternJoined) return { hits: [] as PatternHit[], tooMany: false };
    const matchers = PATTERN_PRESETS.filter((p) => patternKinds.includes(p.id)).map((p) => p.matcher);
    return findPatternMatches(shown, edits, matchers, {
      fontFor,
      joined: patternJoined,
      extra: customRun.spans ? { kind: "custom", spans: customRun.spans } : null,
    });
  }, [pdf, patternOpen, patternJoined, patternKinds, customRun.spans, shown, edits, fontFor]);
  // Pages whose text is still being read in the background. Find and the
  // patterns search what has arrived and keep up as more does, but redacting
  // "every match" waits until every page can have one.
  const reading = useMemo(() => pagesPending(pdf), [pdf]);
  const patternTooMany = patternResult.tooMany || customRun.tooMany;
  const patternHits: PatternHit[] = patternTooMany ? [] : patternResult.hits;
  const matches: FindMatch[] = useMemo(() => {
    if (pdf && findOpen && findQuery) return findMatches(shown, edits, findQuery, fontFor);
    if (patternOpen)
      return patternHits.flatMap((h) =>
        patternExcluded.has(h.key) ? h.boxes.map((b) => ({ ...b, off: true })) : h.boxes,
      );
    return [];
  }, [pdf, shown, findOpen, findQuery, edits, fontFor, patternOpen, patternHits, patternExcluded]);
  const matchesByPage = useMemo(() => {
    const m = new Map<number, FindMatch[]>();
    for (const hit of matches) {
      const arr = m.get(hit.pageIndex) ?? [];
      arr.push(hit);
      m.set(hit.pageIndex, arr);
    }
    return m;
  }, [matches]);
  // The active match is a hit, not a slot in the list: when the list is rebuilt
  // under it (a page moved, turned or deleted in the sidebar) it stays on the
  // same hit wherever that now sorts, and only falls back to the slot when the
  // hit itself has gone.
  const findSeen = useRef<{ matches: FindMatch[]; id: string | null }>({ matches, id: null });
  const activeIndex = useMemo(() => {
    const seen = findSeen.current;
    if (seen.matches === matches || seen.id == null) return findActive;
    const i = matches.findIndex((m) => m.id === seen.id);
    return i >= 0 ? i : findActive;
  }, [matches, findActive]);
  const activeMatch = matches[activeIndex] ?? null;
  useLayoutEffect(() => {
    findSeen.current = { matches, id: activeMatch?.id ?? null };
    if (activeIndex !== findActive) setFindActive(activeIndex);
  }, [matches, activeMatch, activeIndex, findActive]);

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
  // Only when the active match becomes a different hit: the list being rebuilt
  // around the same one — a page turned or moved in the sidebar — mustn't throw
  // the view back to it from wherever you are working.
  const scrolledTo = useRef<string | null>(null);
  // Opening Redact patterns leaves the view where the person was reading: its
  // first hit becomes active without throwing the page to it.
  const holdScroll = useRef(false);
  // "Show" on a row always scrolls, even to the hit already active.
  const [showNonce, setShowNonce] = useState(0);
  useEffect(() => {
    if (!activeMatch || !pdf) {
      scrolledTo.current = null;
      return;
    }
    if (holdScroll.current) {
      holdScroll.current = false;
      scrolledTo.current = activeMatch.id;
      return;
    }
    if (activeMatch.id === scrolledTo.current) return;
    const scroller = document.querySelector<HTMLElement>(".viewer__scroll");
    const pageEl = document.querySelector<HTMLElement>(
      `[data-page-index="${activeMatch.pageIndex}"]`,
    );
    const page = shownBySource.get(activeMatch.pageIndex);
    if (!scroller || !pageEl || !page) return;
    // Where the match shows on the (possibly turned) page: the nearest of its
    // corners to the top, as the page is displayed.
    const corners = [
      userToShown(activeMatch.x, activeMatch.y, page),
      userToShown(activeMatch.x + activeMatch.width, activeMatch.y + activeMatch.height, page),
    ];
    const yInPage = Math.min(corners[0].y, corners[1].y) * vp.scale;
    const offsetFromScrollTop =
      pageEl.getBoundingClientRect().top - scroller.getBoundingClientRect().top + yInPage;
    scrolledTo.current = activeMatch.id;
    scroller.scrollTo({
      top: scroller.scrollTop + offsetFromScrollTop - scroller.clientHeight / 3,
      behavior: "smooth",
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- showNonce forces a scroll
  }, [activeMatch, pdf, shownBySource, vp.scale, showNonce]);

  const nextMatch = useCallback(() => {
    setFindActive((i) => (matches.length ? (i + 1) % matches.length : 0));
  }, [matches.length]);
  const prevMatch = useCallback(() => {
    setFindActive((i) => (matches.length ? (i - 1 + matches.length) % matches.length : 0));
  }, [matches.length]);
  const openFind = useCallback(() => {
    holdScroll.current = false;
    setSelection(null);
    setPatternOpen(false);
    setFindActive(0);
    setFindOpen(true);
  }, []);
  const closeFind = useCallback(() => {
    holdScroll.current = false;
    setFindOpen(false);
    setFindQuery("");
    setPatternOpen(false);
  }, []);
  // Where focus was when the panel opened, to give it back on close.
  const patternOpener = useRef<HTMLElement | null>(null);
  const patternOpenRef = useRef(patternOpen);
  patternOpenRef.current = patternOpen;
  const openPatterns = useCallback(() => {
    // Already open (picked again from the ⋯ menu or the palette, which stay
    // usable beside it): just go back to it. Starting over would quietly
    // re-tick every hit the person had chosen to keep.
    if (patternOpenRef.current) {
      document.querySelector<HTMLElement>(".patterns input")?.focus();
      return;
    }
    const active = document.activeElement;
    patternOpener.current = active instanceof HTMLElement && active !== document.body ? active : null;
    setSelection(null);
    setMulti([]);
    setFindOpen(false);
    setFindQuery("");
    setFindActive(0);
    setPatternExcluded(new Set());
    holdScroll.current = true;
    setPatternOpen(true);
  }, []);
  // Closing the panel hands focus back to what opened it — or, when that has
  // gone (a menu row, the palette, the find bar), to the ⋯ menu the command
  // lives in — rather than dropping it on the page body. Only when focus is
  // actually lost: a click on the page that closed it keeps its own.
  const wasPatternOpen = useRef(false);
  useEffect(() => {
    if (wasPatternOpen.current && !patternOpen) {
      const lost = !document.activeElement || document.activeElement === document.body;
      if (lost) {
        const back = patternOpener.current?.isConnected
          ? patternOpener.current
          : document.querySelector<HTMLElement>('[aria-label="More actions"]');
        back?.focus();
      }
      patternOpener.current = null;
    }
    wasPatternOpen.current = patternOpen;
  }, [patternOpen]);

  /** Redact every ticked pattern hit (one undo step). */
  const redactPatterns = useCallback(() => {
    // Exactly the boxes highlighted, as with "Redact all".
    const chosen = patternHits.filter((h) => !patternExcluded.has(h.key));
    if (chosen.length === 0 || !pdf) return;
    doc.set((d) => ({
      ...d,
      redactions: [
        ...d.redactions,
        ...chosen.flatMap((h) =>
          h.boxes.map((m) => ({
            id: nextId("rd"),
            pageIndex: m.pageIndex,
            x: m.x,
            y: m.y,
            width: m.width,
            height: m.height,
            color: "#000000",
          })),
        ),
      ],
    }));
    const n = chosen.length;
    // The message only: the status belongs to whatever else is running (OCR
    // can be, beside this panel), and isn't this action's to clear.
    setMessage(`Redacted ${n} item${n === 1 ? "" : "s"}. Undo brings them back.`);
    closeFind();
  }, [patternHits, patternExcluded, pdf, doc, closeFind]);

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
      // Every page's text, read or not yet.
      const full = await completeText(pdf);
      await navigator.clipboard.writeText(extractText(shownPages(full.pages, plan), edits));
      setStatus("ready");
      setMessage("Document text copied to clipboard.");
    } catch {
      setStatus("error");
      setMessage("Couldn't copy — your browser blocked clipboard access.");
    }
  }, [pdf, plan, edits]);

  /** Download all document text as a .txt file. */
  const exportTextFile = useCallback(async () => {
    if (!pdf) return;
    setMenuOpen(false);
    const full = await completeText(pdf);
    downloadText(extractText(shownPages(full.pages, plan), edits), fileName.replace(/\.pdf$/i, "") + ".txt");
    setStatus("ready");
    setMessage("Text exported.");
  }, [pdf, plan, edits, fileName]);

  // The fit-to-width base follows the widest page *as shown*: turning a
  // portrait page sideways in Organise (or undoing it) changes it. Measured
  // here rather than only on load, or turned pages run off the side.
  const shownWidthPts = useMemo(() => Math.max(...shown.map((p) => shownSize(p).width), 1), [shown]);
  const setPageWidth = vp.setPageWidth;
  useEffect(() => {
    if (pdf) setPageWidth(shownWidthPts);
  }, [pdf, shownWidthPts, setPageWidth]);

  // Back where it was left; a document seen for the first time starts at its
  // first page. Once, on mount: after the page width above, so the fit scale
  // the position is restored against is this document's.
  const restoreView = vp.restoreView;
  useEffect(() => {
    restoreView(entry.view ?? { zoom: 1, ry: 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // What the workspace reads synchronously as this document goes into the
  // background, before this editor unmounts.
  const snapshot = doc.snapshot;
  const captureView = vp.captureView;
  const counts = useRef({ changeCount, unsaved });
  counts.current = { changeCount, unsaved };
  useImperativeHandle(
    handleRef,
    () => ({ park: () => ({ id: activeId, history: snapshot(), view: captureView(), ...counts.current }) }),
    [activeId, snapshot, captureView],
  );

  // Report the live state up: autosave, the tab's dirty mark and the close
  // guard all read it. Tagged with this tab's id, so a late report from an
  // editor on its way out can't be taken for the next document's.
  useEffect(() => {
    onLive({ id: activeId, doc: docHistory.state, changeCount, unsaved });
  }, [onLive, activeId, docHistory.state, changeCount, unsaved]);


  /** Export the current edits to fresh bytes so finishing ops build on them.
   * `leftOut` is the note for what a standard font couldn't write, or "";
   * `kept` the note for fields that stayed fillable when flattening, or "" —
   * for a result that is still a PDF (see keptNote.ts). */
  const bakeCurrent = useCallback(async (): Promise<{ buf: ArrayBuffer; leftOut: string; kept: string }> => {
    const { exportPdf } = await import("./pdf/exporter");
    let leftOut = "";
    let kept = "";
    const out = await exportPdf(pdf!, {
      edits, textBoxes, redactions, annotations, stamps, links, formValues, formFlatten, pageNumbers, watermark, losslessRaster, pages: planned,
      onDropped: (chars) => (leftOut = leftOutNote(chars)),
      onFormKept: (names) => (kept = keptFillableNote(names)),
    });
    return { buf: toAB(out), leftOut, kept };
    // `losslessRaster` is read for the export, so it has to be a dependency —
    // otherwise this captures whatever it was when `pdf` last changed.
  }, [pdf, edits, textBoxes, redactions, annotations, stamps, links, formValues, formFlatten, pageNumbers, watermark, losslessRaster, planned]);

  // Page numbers and watermark are document-wide layers stored in DocState and
  // drawn at export time (see exporter.ts). Setting them is a normal, undoable
  // edit — no document rebuild, no lost history, and they preview live.
  const applyNumbers = useCallback(
    (opts: PageNumberOptions) => {
      setFinishTab(null);
      doc.set((d) => ({ ...d, pageNumbers: opts }));
      setStatus("ready");
      setMessage("Header & footer added.");
    },
    [doc],
  );

  const clearNumbers = useCallback(() => {
    setFinishTab(null);
    doc.set((d) => ({ ...d, pageNumbers: null }));
    setStatus("ready");
    setMessage("Header & footer removed.");
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
  const compressBaked = useRef<{ buf: ArrayBuffer; sizes: { width: number; height: number }[]; before: number; leftOut: string; kept: string } | null>(null);
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
        const { buf: baked, leftOut, kept } = await bakeCurrent();
        // The baked file is in shown order with the turns applied, and its
        // pages are re-imaged as shown.
        const sizes = shown.map(shownSize);
        compressBaked.current = { buf: baked, sizes, before: baked.byteLength, leftOut, kept };
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
    const leftOut = compressBaked.current?.leftOut ?? "";
    // Only a copy that is still the text version keeps a form to speak of; a
    // rasterised one is pictures of the pages, answers and all.
    const kept = out.lossless || !out.helped ? (compressBaked.current?.kept ?? "") : "";
    setCompressOpen(false);
    const base = compressName.current.replace(/\.pdf$/i, "");
    const suffix = out.lossless ? "-optimized.pdf" : out.helped ? "-compressed.pdf" : ".pdf";
    downloadBytes(out.bytes, base + suffix);
    // A smaller copy is still a copy of everything: the dialog is modal, so
    // nothing has changed since it was built.
    onSaved(activeId, markNow.current);
    setStatus("ready");
    const fmt = (n: number) => (n < 1_000_000 ? Math.round(n / 1000) + " KB" : (n / 1_000_000).toFixed(2) + " MB");
    setMessage(
      (out.lossless
        ? `Optimized, text kept — ${fmt(out.before)}.`
        : out.helped
          ? `Compressed — ${fmt(out.before)} → ${fmt(out.after)} (${Math.round((1 - out.after / out.before) * 100)}% smaller).`
          : `Already compact — kept the text version at ${fmt(out.before)}.`) + leftOut + kept,
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
      const { buf: baked, leftOut, kept } = await bakeCurrent();
      const { signPdf } = await import("./pdf/sign");
      const signed = await signPdf(baked, identity, meta);
      downloadBytes(signed, fileName.replace(/\.pdf$/i, "") + "-signed.pdf");
      onSaved(activeId, mark);
      setStatus("ready");
      setMessage("Signed the document and downloaded it." + leftOut + kept);
    },
    [pdf, bakeCurrent, fileName, downloadBytes],
  );

  const runOcr = useCallback(async () => {
    if (!pdf) return;
    setMenuOpen(false);
    settleHint();
    const ctrl = new AbortController();
    setOnCancel(() => () => ctrl.abort());
    setStatus("working");
    setMessage("Reading text (OCR)…");
    try {
      // Only pages with no text of their own: OCR on a page that already has
      // a text layer lays a second copy of every word over the first.
      // And only pages still in the document: one deleted in the page plan
      // isn't shown, so reading it is work (and a progress count) for nothing.
      // Which pages have text of their own needs every page's text read.
      const full = await completeText(pdf);
      const unread = full.pages.filter(
        (pg) => shownBySource.has(pg.pageIndex) && !pg.fragments.some((f) => !f.id.startsWith("ocr:")),
      );
      if (unread.length === 0) {
        setStatus("ready");
        setMessage("Every page already has text — nothing to recognise.");
        return;
      }
      const { ocrPages } = await import("./pdf/ocr");
      const { perPage, pagesFailed } = await ocrPages(
        pdf.bytes,
        unread,
        (p, t) =>
          setMessage(p === 0 ? "Starting OCR engine…" : `Reading text… page ${p}/${t}`),
        ctrl.signal,
        // Keeping the wasm engine on the device is on-device storage, so it
        // follows the same switch as the session copy.
        { cacheEngine: autosaveOn },
      );
      let added = 0;
      // Pages OCR actually read (with or without words). One that failed isn't
      // marked, so the Inspector goes on offering it.
      const read = new Set(perPage.keys());
      const pages = full.pages.map((pg) => {
        if (!read.has(pg.pageIndex)) return pg;
        const extra = perPage.get(pg.pageIndex) ?? [];
        added += extra.length;
        // Replace any prior OCR layer so re-running doesn't duplicate words.
        const kept = pg.fragments.filter((f) => !f.id.startsWith("ocr:"));
        return { ...pg, fragments: [...kept, ...extra], ocrRead: true };
      });
      // Into the document that was read, even if another is in front by now:
      // the pages are that file's, not whichever tab finished first.
      onPages(pdf.bytes, pages);
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
        const stale = staleBuildMessage(err);
        const timedOut = /timed out/i.test((err as Error)?.message ?? "");
        setStatus("error");
        setMessage(
          stale ??
          (timedOut
            ? "OCR timed out on this document — it may be very large or image-heavy. Try again, or split it into fewer pages."
            : "OCR couldn't finish on this document. It may be very large or image-heavy — try again."),
        );
      }
    } finally {
      setOnCancel(null);
    }
    // `autosaveOn` is read for `cacheEngine`, so it has to be a dependency —
    // without it the callback keeps whatever value was current when `pdf` last
    // changed, and OCR goes on caching the engine after the switch is off.
  }, [pdf, autosaveOn, shownBySource]);

  const exportImages = useCallback(async () => {
    if (!pdf) return;
    setMenuOpen(false);
    setStatus("working");
    setMessage("Rendering images…");
    try {
      const { buf: baked, leftOut } = await bakeCurrent();
      const { renderImages } = await import("./pdf/finishOps");
      const urls = await renderImages(baked, shown.length, 2, (p, t) =>
        setMessage(`Rendering images… page ${p}/${t}`),
      );
      const base = fileName.replace(/\.pdf$/i, "");
      const { makeZip, dataUrlToBytes } = await import("./pdf/zip");
      if (urls.length === 1) {
        // A single page downloads as a plain PNG — friendlier than a one-file zip.
        downloadBytes(dataUrlToBytes(urls[0]), `${base}.png`, "image/png");
        setStatus("ready");
        setMessage("Exported 1 image." + leftOut);
      } else {
        // Bundle every page into one ZIP so no download is blocked and the
        // success message is honest (browsers block the 2nd+ auto-download).
        setMessage("Packaging images…");
        const zip = makeZip(urls.map((u, i) => ({ name: `${base}-p${i + 1}.png`, data: dataUrlToBytes(u) })));
        downloadBytes(zip, `${base}-images.zip`, "application/zip");
        setStatus("ready");
        setMessage(`Exported ${urls.length} images as a ZIP.${leftOut}`);
      }
    } catch (err) {
      setStatus("error");
      setMessage(staleBuildMessage(err) ?? "Couldn't export images. Please try again.");
    }
  }, [pdf, bakeCurrent, fileName, downloadBytes]);

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
    (pageIndex: number, x: number, y: number, rotation: number) => {
      const id = nextId("tb");
      const box: TextBox = {
        id,
        pageIndex,
        x,
        y,
        text: "",
        style: { ...lastTextStyle },
        ...(rotation ? { rotation } : null),
      };
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

  // Typing in a field is one undo step per field, like typing anywhere; a
  // click (a box ticked, a button or option chosen) is a step of its own. A
  // value put back to how the file came is no longer a change.
  const onChangeFormValue = useCallback(
    (name: string, value: FormValue, typing = false) => {
      const field = formFieldsByName.get(name);
      doc.set(
        (d) => {
          const values = d.formValues ?? {};
          const now = name in values ? values[name] : field?.defaultValue;
          if (field && sameValue(now, value)) return d;
          const next = { ...values };
          if (field && sameValue(field.defaultValue, value)) delete next[name];
          else next[name] = value;
          return { ...d, formValues: Object.keys(next).length > 0 ? next : undefined };
        },
        typing ? `form-${name}` : undefined,
      );
    },
    [doc, formFieldsByName],
  );

  const setFormFlatten = useCallback(
    (on: boolean) => doc.set((d) => ({ ...d, formFlatten: on || undefined })),
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
      const page = shownBySource.get(pageIndex);
      if (!pendingStamp || !page) return;
      // Centred on the click and kept on the page — the same `placeAt` the
      // page's ghost preview draws with, so what you aimed is what you get.
      // On a turned page it's turned to read upright as the page is shown.
      const { width: pw, height: ph } = page.viewBox;
      const upright = uprightFor(page.rotation);
      const box = placeAt(placedSize(pendingStamp, pw, ph, upright), cx, cy, pw, ph, upright);
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
    [pendingStamp, doc, shownBySource],
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
  const backGuard = useRef<HistoryEntry | null>(null);
  const dismissable = compact && (editingId != null || sheetOpen || selection != null || patternOpen);
  // On a phone the zoom pill yields to the top-centre contextual bar (find,
  // multi-select, a selection). The page field lives in it, so a hidden pill
  // closes the field — otherwise it would reopen, focused, keyboard up, the
  // moment the pill came back.
  const zoomHidden =
    compact &&
    (findOpen ||
      patternOpen ||
      pictureHint === "shown" ||
      multi.length >= 2 ||
      (selection != null && selection.kind !== "stamp" && !sheetOpen));
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
  // Through `useModal`'s history owner, so a dialog's own unwind is never
  // taken for Back here, and a push never races a pending unwind.
  useEffect(() => {
    if (dismissable && !backGuard.current) {
      backGuard.current = pushHistory({ pdfEditorLayer: true });
    } else if (!dismissable && backGuard.current) {
      // The layer was dismissed via the UI — remove our entry without
      // leaving the app.
      unwindHistory(backGuard.current);
      backGuard.current = null;
    }
  }, [dismissable]);
  // Going behind another document (`<Activity>`, see `App.tsx`) or closing:
  // give back the Back entry a selection pushed, since the listener that
  // would take it goes now, and the next document's Back must not pop it.
  // Coming back with the selection still there pushes a new one (above). And
  // a text box being typed into doesn't take focus again on the way back.
  useEffect(
    () => () => {
      if (backGuard.current) unwindHistory(backGuard.current);
      backGuard.current = null;
      setAutoFocusId(null);
    },
    [],
  );
  useEffect(
    () =>
      onStrayBack(() => {
        if (!backGuard.current) return;
        backGuard.current = null;
        if (editingId != null) {
          setEditingId(null);
          setAutoFocusId(null);
        } else if (sheetOpen) {
          setSheetOpen(false);
        } else if (selection != null) {
          setSelection(null);
        } else if (patternOpen) {
          closeFind();
        }
      }),
    [editingId, sheetOpen, selection, patternOpen, closeFind],
  );

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

  // A link to a page names its source page; the panel speaks positions.
  const onChangeLinkPage = useCallback(
    (pos: number | undefined) => {
      if (selection?.kind !== "link") return;
      const page = pos == null ? undefined : plan[pos]?.index;
      if (pos != null && page == null) return;
      onChangeLink(selection.id, { page }, `lpage-${selection.id}`);
    },
    [selection, onChangeLink, plan],
  );

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
      // A copy of something on a page that's since been deleted would land
      // on a page nobody can see.
      const page = shownBySource.get((item.obj as { pageIndex?: number }).pageIndex ?? -1);
      if (!page) return;
      const id = nextId(def.idPrefix);
      const off = shownToUserDelta(PASTE_DX, PASTE_DY, page.rotation);
      const copy = { ...def.translate(item.obj, off.dx, off.dy), id };
      doc.set((d) => keepStampsOnPage(addOverlay(d, item.kind, copy), [id], pdf?.pages));
      setSelection({ kind: item.kind, id });
    },
    [doc, pdf, shownBySource],
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
  // Align and distribute work on the page as shown: on a turned page "left"
  // is another side of each box in the page's own space. Boxes are turned into
  // the shown frame, moved there, and the moves turned back.
  const multiTurn = turnOfObject(multi[0]);
  const shownItems = useMemo(
    () => multiItems.map((it) => ({ ...it, box: userToShownBox(it.box, multiTurn) })),
    [multiItems, multiTurn],
  );
  const applyShownDeltas = useCallback(
    (deltas: Map<string, { dx: number; dy: number }>) => {
      const back = new Map<string, { dx: number; dy: number }>();
      deltas.forEach((d, id) => back.set(id, shownToUserDelta(d.dx, d.dy, multiTurn)));
      applyDeltas(back);
    },
    [applyDeltas, multiTurn],
  );
  const alignMulti = useCallback(
    (op: AlignOp) => {
      const multiItems = shownItems;
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
      applyShownDeltas(deltas);
    },
    [shownItems, applyShownDeltas],
  );

  const distributeMulti = useCallback(
    (axis: "h" | "v") => {
      const multiItems = shownItems;
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
      applyShownDeltas(deltas);
    },
    [shownItems, applyShownDeltas],
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
          const off = shownToUserDelta(PASTE_DX, PASTE_DY, shownBySource.get((item as unknown as { pageIndex: number }).pageIndex)?.rotation ?? 0);
          next = addOverlay(next, def.kind, { ...def.translate(item, off.dx, off.dy), id });
        }
      }
      return next;
    });
    setMulti(newIds);
  }, [multi, multiItems, doc, shownBySource]);

  // Move focus into a menu when it opens (ARIA menu pattern).
  useEffect(() => {
    if (!menuOpen) return;
    menuListRef.current
      ?.querySelector<HTMLElement>('[role^="menuitem"]')
      ?.focus();
  }, [menuOpen]);
  useEffect(() => {
    if (!exportOpen) return;
    exportListRef.current?.querySelector<HTMLElement>('[role^="menuitem"]:not(:disabled)')?.focus();
  }, [exportOpen]);
  // Only one menu at a time: opening one closes the other.
  useEffect(() => {
    if (menuOpen) setExportOpen(false);
  }, [menuOpen]);
  useEffect(() => {
    if (exportOpen) setMenuOpen(false);
  }, [exportOpen]);
  // The caret isn't rendered on a phone: a menu left open across the
  // breakpoint would come back already open, with nothing focused in it.
  useEffect(() => {
    if (compact) setExportOpen(false);
  }, [compact]);
  // Every Export item is disabled while a file is being made.
  useEffect(() => {
    if (busy) setExportOpen(false);
  }, [busy]);
  // The palette opens over everything; a menu left under it is orphaned.
  useEffect(() => {
    if (cmdOpen) {
      setExportOpen(false);
      setMenuOpen(false);
    }
  }, [cmdOpen]);

  // Close a menu with focus back on the button that opened it, *before* the
  // item runs: a dialog the item opens records what had focus to return to on
  // close, and by then the menu item itself is gone.
  const closeMenu = () => {
    setMenuOpen(false);
    menuBtnRef.current?.focus();
  };
  const closeExport = () => {
    setExportOpen(false);
    exportBtnRef.current?.focus();
  };

  const onMenuKeyDown = useMemo(() => menuKeys(menuListRef, menuBtnRef, () => setMenuOpen(false)), []);
  const onExportKeyDown = useMemo(() => menuKeys(exportListRef, exportBtnRef, () => setExportOpen(false)), []);

  const undo = useCallback(() => {
    doc.undo();
  }, [doc]);
  const redo = useCallback(() => {
    doc.redo();
  }, [doc]);

  useEffect(() => {
    if (
      selection &&
      ((selection.kind !== "fragment" && !overlayExists(docHistory.state, selection.kind, selection.id)) ||
        // Its page was deleted (or a redo deleted it again): nothing to edit.
        !shownBySource.has(pageOf(selection.id) ?? -1))
    ) {
      setSelection(null);
    }
  }, [docHistory.state, selection, shownBySource, pageOf]);
  useEffect(() => {
    setMulti((m) => {
      const kept = m.filter((id) => shownBySource.has(pageOf(id) ?? -1));
      return kept.length === m.length ? m : kept;
    });
  }, [shownBySource, pageOf]);


  /** Ctrl+S and Ctrl+P, defined further down; read live by the key handler. */
  const fileKeys = useRef<{ save: () => void; print: () => void }>({ save: () => {}, print: () => {} });

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // A modal (Organize / Finish / Compress / Command Palette) owns the
      // keyboard while it's open — don't undo/redo/find/delete on the canvas
      // hidden beneath it. Modals manage their own Escape via useModal.
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      if (aModalIsOpen()) {
        // Not the browser's "save this web page" either, under a dialog.
        if (mod && key === "s") e.preventDefault();
        return;
      }
      if (mod && key === "z") {
        e.preventDefault();
        e.shiftKey ? redo() : undo();
        return;
      }
      // Ctrl/⌘+S saves the document, Ctrl/⌘+P prints it — not the browser's
      // "save this web page" or a print of the editor's own screen.
      // On a Mac only ⌘: Ctrl+P there moves the caret up a line in text.
      if ((IS_MAC ? e.metaKey && !e.ctrlKey : mod) && (key === "s" || key === "p") && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        // Held down, it's one save, not one per key repeat.
        if (e.repeat) return;
        setMenuOpen(false);
        setExportOpen(false);
        if (key === "s") fileKeys.current.save();
        else fileKeys.current.print();
        return;
      }
      // Ctrl/⌘+O opens files into new tabs (the browser's own "open file" would
      // navigate away from everything open here).
      if (mod && key === "o" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        setMenuOpen(false);
        setExportOpen(false);
        onOpenAnother();
        return;
      }
      if (mod && key === "y") {
        e.preventDefault();
        redo();
        return;
      }
      // Ctrl/⌘+D on a group selection duplicates the group, as its multibar
      // button and the palette's "Duplicate · Ctrl+D" do. The single-object
      // handler above leaves it alone (a group has no single `selection`), and
      // without this the browser took the key and offered to bookmark the page.
      if (mod && key === "d" && multi.length > 0 && !isTypingTarget()) {
        e.preventDefault();
        duplicateMulti();
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
      // A selection made beside the open patterns panel goes first, as it
      // would anywhere else; the next Escape closes the panel.
      if (e.key === "Escape" && patternOpen && selection) {
        e.preventDefault();
        setSelection(null);
        return;
      }
      if (e.key === "Escape" && (findOpen || patternOpen)) {
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
          // The arrow means "that way on screen"; on a turned page that's a
          // different direction in the page's own space.
          const d = shownToUserDelta(move[0], move[1], turnOfObject(multi[0]));
          moveMulti(d.dx, d.dy, "nudge-multi");
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
        (e.key === "Delete" || e.key === "Backspace") &&
        !isTypingTarget()
      ) {
        e.preventDefault();
        onDelete();
        return;
      }
      // Delete a selected annotation (but not while editing a sticky note).
      if (
        selection?.kind === "annotation" &&
        e.key === "Delete" &&
        selectedAnnotation?.kind !== "note" &&
        !isTypingTarget()
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
        const { dx, dy } = shownToUserDelta(arrow[0] * step, arrow[1] * step, turnOfObject(selection.id));
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
    onOpenAnother,
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
    patternOpen,
    links,
    onChangeLink,
    multi,
    clearMulti,
    deleteMulti,
    duplicateMulti,
    moveMulti,
    arrangeSelection,
    canArrange,
    pendingStamp,
    turnOfObject,
  ]);

  // "Hidden information": the export's own clean-up, run on a copy, plus what
  // it leaves in. Covered text is counted here, where the edits are: places an
  // edit or a whiteout paints over text on a page that won't be flattened
  // (a true redaction flattens the page, which really removes it).
  const inspectHiddenInfo = useCallback(async () => {
    if (!pdf) throw new Error("No document");
    const { inspectHidden, hiddenRows } = await import("./pdf/hiddenInfo");
    // A page ships its own content unless the plan deletes it or a true
    // redaction flattens it to a picture: then nothing on it is "kept".
    const kept = new Set(plan.map((p) => p.index));
    const flattened = new Set(redactions.filter((r) => !r.cover).map((r) => r.pageIndex));
    const stays = (i: number) => kept.has(i) && !flattened.has(i);
    const info = await inspectHidden(pdf.bytes, stays);
    // Every page's text, read or not yet.
    const full = await completeText(pdf);
    // Whiteouts over text, by the same measure as the download warning.
    let covered = findUnsafeCovers(full, redactions.filter((r) => stays(r.pageIndex)), planned).count;
    for (const pg of full.pages) {
      if (!stays(pg.pageIndex)) continue;
      covered += pg.fragments.filter((f) => isFragmentModified(f, edits[f.id])).length;
    }
    return hiddenRows(info, covered);
  }, [pdf, plan, planned, redactions, edits]);

  /** What the exporter is given: the document as it stands. */
  const exportInput = useCallback(
    (password?: string) => ({ edits, textBoxes, redactions, annotations, stamps, links, formValues, formFlatten, pageNumbers, watermark, losslessRaster, pages: planned, password }),
    [edits, textBoxes, redactions, annotations, stamps, links, formValues, formFlatten, pageNumbers, watermark, losslessRaster, planned],
  );

  const runExport = useCallback(async (asOf?: SavedMark) => {
    if (!pdf) return;
    const to = pendingDelivery.current;
    pendingDelivery.current = { kind: "download" };
    const password = to.kind === "download" ? to.password : undefined;
    // What the file is built from is this render's state; the mark has to be
    // the same one. A caller that waited first passes the mark it read before.
    const mark = asOf ?? markNow.current;
    setStatus("exporting");
    setMessage("Building edited PDF…");
    const flattened = redactions.length > 0 ? " Redacted pages were flattened to images." : "";
    // A copy made without the password the file opened with says so.
    const noPassword = locked && !password ? " This copy has no password. To add one, use Download with password." : "";
    // What a standard font couldn't write and the file leaves out, though the
    // page on screen shows it (see standardText.ts).
    let leftOut = "";
    try {
      const { exportPdf } = await import("./pdf/exporter");
      // Fields that were to be flattened but couldn't be drawn stay a form.
      let kept: string[] = [];
      const out = await exportPdf(
        pdf,
        {
          ...exportInput(password),
          onFormKept: (names: string[]) => (kept = names),
          onDropped: (chars) => (leftOut = leftOutNote(chars)),
        },
        (p, t) => setMessage(`Building edited PDF… page ${p}/${t}`),
      );
      const formNote = keptFillableNote(kept);
      const editedName = fileName.replace(/\.pdf$/i, "") + "-edited.pdf";
      if (to.kind === "save" || to.kind === "save-as") {
        const target = to.target;
        setMessage(`Saving to ${target.name}…`);
        await writeTo(target, out);
        onSaved(activeId, { ...mark, inPlace: true }, to.kind === "save-as" ? { handle: target, fileName: target.name } : undefined);
        setStatus("ready");
        // Over a locked file, the user agreed to this before it was built.
        setMessage(`Saved to ${target.name}.${flattened}${leftOut}${formNote}${to.kind === "save-as" ? noPassword : ""}`);
        return;
      }
      if (to.kind === "share") {
        const file = pdfFile(out, editedName);
        const shared = await shareFile(file);
        setStatus("ready");
        if (shared === "needs-tap") {
          setShareReady(file);
          setMessage("Your file is ready to share.");
        } else if (shared === "shared") {
          // Not marked saved: a share target ("Copy", a message draft) may
          // keep nothing, so the work still needs saving somewhere.
          setMessage(`Shared ${editedName}.${flattened}${leftOut}${formNote}${noPassword}`);
        } else setMessage("Not shared.");
        return;
      }
      downloadBytes(out, editedName);
      onSaved(activeId, mark);
      setStatus("ready");
      setMessage(
        (redactions.length > 0 ? "Downloaded — redacted pages were flattened to images." : "Downloaded edited PDF.") +
          leftOut +
          formNote +
          (password ? " It opens only with the password you set." : noPassword),
      );
    } catch (err) {
      setStatus("error");
      setMessage(
        staleBuildMessage(err) ??
          (to.kind === "save" || to.kind === "save-as"
            ? `Couldn't save to ${to.target.name} — it's unchanged. Try Save as… or Download.`
            : "Couldn't build the edited PDF. Please try again."),
      );
    }
  }, [pdf, exportInput, redactions.length, fileName, locked, activeId, onSaved]);

  // Guard the download: a whiteout cover only paints over content — the text
  // beneath stays recoverable. If any cover sits over live text, warn before
  // handing back a file that looks redacted but isn't. True redactions
  // rasterise the page and are safe, so they never trip this.
  const delivering = useRef(false);
  // A delivery that waits on the text can outlive the editor (the tab closed,
  // or Organise replaced the document): it must not go on to export then.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const deliver = useCallback(
    async (to: Delivery) => {
      if (!pdf || delivering.current) return;
      // The file is built from the state as it is now (this render's), so the
      // saved mark is read now too — not after the wait below, when an edit
      // typed meanwhile would be marked saved without being in the file.
      const mark = markNow.current;
      delivering.current = true;
      try {
        // Held across the whiteout warning, so "… anyway" makes the same file,
        // sent the same place, that was asked for.
        pendingDelivery.current = to;
        let full = pdf;
        if (pagesPending(pdf) > 0) {
          // Busy from the press, as the export itself is: a save, share or
          // second download asked for meanwhile is refused the usual way, not
          // dropped without a word.
          setStatus("exporting");
          setMessage("Reading the document's text…");
          try {
            // Doesn't reject: a page that won't read comes back unreadable.
            full = await completeText(pdf);
          } finally {
            // Leaving the busy state the wait set; the export sets its own.
            // (Also if the editor is gone: busy would lock the workspace.)
            setStatus("ready");
            setMessage("");
          }
          if (!alive.current) return;
        }
        const warn = findUnsafeCovers(full, redactions, planned);
        if (warn.count > 0) {
          setCoverWarn(warn);
          return;
        }
        await runExport(mark);
      } finally {
        delivering.current = false;
      }
    },
    [pdf, redactions, planned, runExport],
  );
  const download = useCallback((password?: string) => deliver({ kind: "download", password }), [deliver]);

  // One save / print / share at a time. Set at once, not on the next render as
  // the busy status is: a second Ctrl+S (or key repeat) while the first waits
  // on a permission or a picker would otherwise start a second export to the
  // same file.
  const fileOp = useRef(false);
  const exclusive = useCallback(async (op: () => Promise<void>) => {
    if (fileOp.current || busyRef.current) return;
    fileOp.current = true;
    try {
      await op();
    } finally {
      fileOp.current = false;
    }
  }, []);

  /** Write back to the file it came from. Permission is asked first, while the
   * click that asked for the save still counts. */
  const saveInPlace = useCallback(() => exclusive(async () => {
    if (!handle) return;
    try {
      if (!(await mayWrite(handle))) {
        setMessage(`Not saved — writing to ${handle.name} wasn't allowed. Try Save as… or Download.`);
        return;
      }
    } catch {
      setMessage(`Not saved — ${handle.name} can't be written to. Try Save as… or Download.`);
      return;
    }
    await deliver({ kind: "save", target: handle });
  }), [handle, deliver, exclusive]);

  /** Save to a file the user picks; the document is that file from then on. */
  const saveAs = useCallback(() => exclusive(async () => {
    if (!pdf) return;
    let target: FileHandle | null;
    try {
      // "-edited" once. A file that already is one is offered "… copy" — not
      // "-edited-edited", and not its own name: Save as makes a copy.
      const base = fileName.replace(/\.pdf$/i, "");
      target = await pickSaveTarget(/-edited$/i.test(base) ? `${base} copy.pdf` : `${base}-edited.pdf`);
    } catch {
      setMessage("Couldn't open the save dialog. Use Download instead.");
      return;
    }
    if (!target) return;
    // Picked its own file: that's Save, and a file that opened with a password
    // is warned about first, as Ctrl+S warns.
    if (handle && handleLocked && (await sameFile(target, handle))) {
      setUnlockWarn(true);
      return;
    }
    // Over a file another tab has open, the two would save over each other.
    const other = await openElsewhere(target, activeId);
    if (other) {
      setMessage(`${target.name} is open in another tab. Save it from there, or choose another name.`);
      return;
    }
    await deliver({ kind: "save-as", target });
  }), [pdf, fileName, handle, handleLocked, deliver, exclusive, openElsewhere, activeId]);

  /** Ctrl+S: back to its own file where there is one; else wherever the user
   * picks; else a download — never the browser's "save this web page". */
  const save = useCallback(() => {
    if (!pdf || busyRef.current || fileOp.current) return;
    if (handle) {
      // Over a file that opened with a password, the copy written wouldn't
      // have one: say so first.
      if (handleLocked) setUnlockWarn(true);
      else void saveInPlace();
    } else if (canSaveAs()) void saveAs();
    else void download();
  }, [pdf, handle, handleLocked, saveInPlace, saveAs, download]);

  const share = useCallback(() => exclusive(() => deliver({ kind: "share" })), [deliver, exclusive]);

  /** Print the finished file — the edits drawn in, as they'll download. */
  const printDoc = useCallback(() => exclusive(async () => {
    if (!pdf) return;
    setStatus("exporting");
    setMessage("Preparing to print…");
    try {
      const { exportPdf } = await import("./pdf/exporter");
      let leftOut = "";
      const out = await exportPdf(
        pdf,
        { ...exportInput(), onDropped: (chars) => (leftOut = leftOutNote(chars)) },
        (p, t) => setMessage(`Preparing to print… page ${p}/${t}`),
      );
      const { printPdf } = await import("./print");
      const bytes = out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
      await printPdf(bytes, (p, t) => setMessage(`Preparing to print… drawing page ${p}/${t}`));
      setStatus("ready");
      // The print is the file, so it leaves out what the download would.
      setMessage(leftOut.trim());
    } catch (err) {
      setStatus("error");
      setMessage(staleBuildMessage(err) ?? "Couldn't prepare the document for printing. Please try again.");
    }
  }), [pdf, exportInput, exclusive]);
  fileKeys.current = { save, print: () => void printDoc() };

  const goHome = useCallback(() => onCloseTab(activeId), [activeId, onCloseTab]);


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

  // ---- The command registry ----
  // Every command the app has, declared once. The command palette lists all of
  // it; the ⋯ menu and the Export menu render their rows from it by group. So a
  // label, icon, shortcut or "opens something" mark is set in one place, and a
  // command can't exist in a menu and be missing from the palette (zoom, the
  // panel, align and the device settings all were, before this list).
  // Commands that don't apply right now are `hidden` rather than left out, so
  // the list reads as the full inventory.
  const single = selection && selection.kind !== "fragment" ? selection : null;
  const multiOn = multi.length >= 2;
  const delByKey =
    multiOn ||
    single?.kind === "redaction" ||
    single?.kind === "stamp" ||
    single?.kind === "link" ||
    (single?.kind === "annotation" && selectedAnnotation?.kind !== "note");
  const commands: Command[] = [
    ...TOOLS.map((t): Command => ({
      id: `tool-${t.key}`,
      group: "tools",
      label: t.label,
      icon: t.icon,
      shortcut: TOOL_SHORTCUT[t.key],
      opens: t.opens,
      run: () => pickTool(t.key),
    })),
    ...SUBTOOLS.map((t): Command => ({
      id: `draw-${t.key}`,
      group: "draw",
      label: t.label,
      icon: t.icon,
      keywords: "draw annotate markup",
      // As picking it in the strip does: the sub-tool is set and the strip
      // stands down, so the page is there to draw on.
      run: () => {
        setDrawTool(t.key);
        if (tool !== "draw") pickTool("draw");
        setDrawbarOpen(false);
      },
    })),

    { id: "duplicate", group: "selection", label: "Duplicate", icon: "duplicate", shortcut: "Ctrl+D", keywords: "copy clone", hidden: !single && !multiOn, run: () => (multiOn ? duplicateMulti() : duplicateSelection()) },
    // Del is only shown where the key does it: text boxes and notes keep it
    // for their own text (see the key handler), so for them the command has no
    // shortcut rather than one that does nothing.
    { id: "delete", group: "selection", label: "Delete", icon: "delete", shortcut: delByKey ? "Del" : undefined, keywords: "remove", hidden: !single && !multiOn, run: () => (multiOn ? deleteMulti() : onDelete()) },
    { id: "front", group: "selection", label: "Bring to front", icon: "bring_front", shortcut: "]", keywords: "arrange order stack raise", hidden: !canArrange, run: () => arrangeSelection("front") },
    { id: "back", group: "selection", label: "Send to back", icon: "send_back", shortcut: "[", keywords: "arrange order stack lower", hidden: !canArrange, run: () => arrangeSelection("back") },
    ...([
      ["left", "Align left", "align_left"],
      ["center-h", "Align centre", "align_center_h"],
      ["right", "Align right", "align_right"],
      ["top", "Align top", "align_top"],
      ["middle", "Align middle", "align_center_v"],
      ["bottom", "Align bottom", "align_bottom"],
    ] as const).map(([op, label, icon]): Command => ({
      id: `align-${op}`, group: "selection", label, icon, keywords: "line up", hidden: !multiOn, run: () => alignMulti(op),
    })),
    { id: "distribute-h", group: "selection", label: "Distribute horizontally", icon: "distribute_h", keywords: "space evenly", hidden: multi.length < 3, run: () => distributeMulti("h") },
    { id: "distribute-v", group: "selection", label: "Distribute vertically", icon: "distribute_v", keywords: "space evenly", hidden: multi.length < 3, run: () => distributeMulti("v") },
    { id: "deselect", group: "selection", label: "Clear selection", icon: "deselect", shortcut: "Esc", keywords: "deselect none", hidden: !selection && !multiOn, run: () => { setMulti([]); setSelection(null); } },

    { id: "undo", group: "edit", label: "Undo", icon: "undo", shortcut: "Ctrl+Z", hidden: !docHistory.canUndo, run: undo },
    { id: "redo", group: "edit", label: "Redo", icon: "redo", shortcut: "Ctrl+Shift+Z", hidden: !docHistory.canRedo, run: redo },

    { id: "find", group: "navigate", label: "Find in document", icon: "search", shortcut: "Ctrl+F", keywords: "search", run: openFind },
    { id: "find-next", group: "navigate", label: "Next match", icon: "chevron_down", keywords: "find search", hidden: matches.length === 0, run: nextMatch },
    { id: "find-prev", group: "navigate", label: "Previous match", icon: "chevron_up", keywords: "find search", hidden: matches.length === 0, run: prevMatch },
    { id: "goto", group: "navigate", label: "Go to page…", icon: "go_to_page", keywords: "jump page number", hidden: !pdf || shown.length < 2, run: openPageJump },

    { id: "pages", group: "view", label: navOpen ? "Hide pages" : "Show pages", icon: navOpen ? "panel_close" : "panel_open", keywords: "thumbnails sidebar", run: () => setNavOpen((v) => !v) },
    { id: "panel", group: "view", label: inspectorOpen ? "Hide panel" : "Show panel", icon: "sliders", keywords: "inspector properties", hidden: !isWide, run: () => setInspectorOpen(!inspectorOpen) },
    { id: "zoom-in", group: "view", label: "Zoom in", icon: "add", keywords: "bigger magnify", run: vp.zoomIn },
    { id: "zoom-out", group: "view", label: "Zoom out", icon: "remove", keywords: "smaller", run: vp.zoomOut },
    { id: "zoom-fit", group: "view", label: "Fit to width", icon: "fit_width", keywords: "zoom reset 100", run: vp.resetZoom },

    { id: "organize", group: "organise", label: "Organise pages", icon: "organize", keywords: "reorder rotate merge split extract", opens: "dialog", run: () => { setSelection(null); setOrganizeOpen("grid"); } },
    { id: "crop", group: "organise", label: "Crop pages", icon: "crop", keywords: "crop trim margins edges cut box", opens: "dialog", run: () => { setSelection(null); setCropAt(pageInView()); } },
    { id: "image", group: "organise", label: "Add image", icon: "image", keywords: "picture photo stamp", opens: "dialog", run: () => imageInputRef.current?.click() },
    { id: "ocr", group: "text", label: "Recognise text (OCR)", icon: "scan_text", keywords: "scan searchable image ocr", run: () => void runOcr() },
    { id: "redact-patterns", group: "text", label: "Redact patterns", icon: "redact_patterns", keywords: "find search email phone card iban ssn date regex personal information pii privacy", opens: "dialog", run: openPatterns },
    { id: "hidden-info", group: "text", label: "Hidden information", icon: "hidden_info", keywords: "metadata author properties privacy scrub remove clean attachments scripts javascript", opens: "dialog", run: () => { setSelection(null); setHiddenOpen(true); } },
    { id: "copytext", group: "text", label: "Copy all text", icon: "content_copy", keywords: "clipboard", run: () => void copyAllText() },
    { id: "numbers", group: "finish", label: "Header & footer", icon: "page_numbers", keywords: "page numbers pagination folio bates date file name header footer", opens: "dialog", run: () => { setSelection(null); setFinishTab("numbers"); } },
    { id: "watermark", group: "finish", label: "Watermark", icon: "watermark", keywords: "draft stamp", opens: "dialog", run: () => { setSelection(null); setFinishTab("watermark"); } },

    // Making a file can't start while one is being made.
    { id: "download", group: "export", label: "Download PDF", icon: "download", keywords: "save export", shortcut: !handle && !canSaveAs() ? "Ctrl+S" : undefined, disabled: busy, run: () => void download() },
    { id: "save", group: "export", label: `Save to ${handle?.name ?? ""}`, icon: "save", shortcut: "Ctrl+S", keywords: "save write file disk overwrite in place", disabled: busy, hidden: !handle, run: save },
    { id: "save-as", group: "export", label: "Save as…", icon: "save_as", shortcut: handle ? undefined : "Ctrl+S", keywords: "save file disk new copy choose folder location", disabled: busy, hidden: !canSaveAs(), run: () => void saveAs() },
    { id: "print", group: "export", label: "Print", icon: "print", shortcut: "Ctrl+P", keywords: "paper printer", disabled: busy, run: () => void printDoc() },
    { id: "share", group: "export", label: "Share", icon: "share", keywords: "send message mail airdrop", disabled: busy, hidden: !canShareFiles(), run: () => void share() },
    { id: "protect", group: "export", label: "Download with password", icon: "protect", keywords: "encrypt password protect lock secure aes", opens: "dialog", disabled: busy, run: () => { setSelection(null); setProtectOpen(true); } },
    { id: "split", group: "export", label: "Split into files", icon: "split_pdf", keywords: "split cut separate divide parts pages zip", opens: "dialog", disabled: busy || shown.length < 2, run: () => { setSelection(null); setOrganizeOpen("split"); } },
    { id: "compress", group: "export", label: "Compress PDF", icon: "compress", keywords: "shrink reduce size optimise", opens: "dialog", disabled: busy, run: openCompress },
    { id: "sign-cert", group: "export", label: "Sign with certificate", icon: "certificate", keywords: "digital signature pades certificate p12 sign", opens: "dialog", disabled: busy, run: () => { setSelection(null); setSignCertOpen(true); } },
    { id: "eximg", group: "export", label: "Export as images", icon: "images", keywords: "png zip export", disabled: busy, run: () => void exportImages() },
    { id: "exporttext", group: "export", label: "Export text (.txt)", icon: "text_download", keywords: "save txt plain", disabled: busy, run: exportTextFile },
    { id: "download-all", group: "export", label: `Download all (${tabs.length}) as ZIP`, icon: "download_all", keywords: "zip every all tabs documents", disabled: busy, hidden: tabs.length < 2, run: () => onDownloadAll() },

    // Device settings. Theme and Dim leave the menu open, so the change can be
    // seen happening; the other two close it, as they always did.
    { id: "theme", group: "settings", label: "Theme", value: themeName, icon: themeIcon, keywords: "dark light system appearance", stays: true, run: theme.cycle },
    { id: "dim", group: "settings", label: "Dim pages", icon: "contrast", keywords: "dark night contrast", checked: dimPages, stays: true, run: () => setDimPages((v) => !v) },
    { id: "autosave", group: "settings", label: "Save session on this device", icon: "save_local", keywords: "autosave restore remember", checked: autosaveOn, run: onToggleAutosave },
    { id: "lossless", group: "settings", label: "Lossless redacted pages", icon: "lossless", keywords: "redaction quality bit-exact png export setting", checked: losslessRaster, detail: "Redacted pages export bit-exact, at several times the file size", run: () => setLosslessRaster((v) => !v) },

    { id: "compare", group: "file", label: "Compare documents", icon: "compare", keywords: "compare diff difference changes versions redline track two", opens: "dialog", disabled: tabs.length < 2, detail: tabs.length < 2 ? "Open the other version too, then compare" : undefined, run: () => { setSelection(null); setCompareOpen(true); } },
    { id: "open", group: "file", label: "Open another PDF", icon: "note_add", shortcut: "Ctrl+O", keywords: "new tab file image picture photo jpg jpeg png", run: onOpenAnother },
    { id: "close", group: "file", label: "Close document", icon: "close", keywords: "home start exit leave", run: goHome },
    { id: "palette", group: "file", label: "Search commands", icon: "command", shortcut: "Ctrl+K", keywords: "palette", opens: "dialog", hidden: cmdOpen, run: () => setCmdOpen(true) },

    ...tabs
      .filter((t) => t.id !== activeId)
      .map((t): Command => ({
        id: `tab-${t.id}`,
        group: "documents",
        label: `Switch to ${t.fileName}`,
        icon: "picture_as_pdf",
        keywords: "tab document file switch",
        run: () => onSwitch(t.id),
      })),
  ];
  const inGroup = (g: CommandGroup) => commands.filter((c) => c.group === g && !c.hidden);

  /** One row of the ⋯ or Export menu, drawn from its registry entry. */
  const menuRow = (c: Command, close: () => void) => (
    <button
      key={c.id}
      className="menu__item"
      data-cmd={c.id}
      data-group={c.group}
      aria-keyshortcuts={ariaKeys(c.shortcut)}
      role={c.checked !== undefined ? "menuitemcheckbox" : "menuitem"}
      aria-checked={c.checked}
      aria-haspopup={c.opens === "dialog" ? "dialog" : undefined}
      // A row that shows a value ("Theme … Dark") reads as a setting, not a
      // control: the name says it can be operated, and still contains the
      // visible words (WCAG 2.5.3).
      aria-label={c.value ? `${c.label}: ${c.value}. Activate to change.` : undefined}
      disabled={c.disabled}
      data-tip={c.detail}
      onClick={() => {
        if (!c.stays) close();
        c.run();
      }}
    >
      {c.icon && <Icon name={c.icon} size={18} />}
      <span className="menu__itemlabel">{c.label}</span>
      {c.value && <span className="menu__value label-medium">{c.value}</span>}
      {c.checked && <Icon name="check" size={16} className="menu__check" />}
      {/* No keys to press on a phone, so no shortcuts to show there. */}
      {c.shortcut && !compact && !c.value && !c.checked && <span className="menu__value label-medium" aria-hidden="true">{c.shortcut}</span>}
      {c.opens === "dialog" && <Icon name="opens_dialog" size={16} className="opens-mark" />}
    </button>
  );

  const appBar = (
    <header className={`appbar${menuOpen || exportOpen ? " appbar--menu" : ""}`}>
      {/* With a document open the brand is the way back to the start screen —
          it looks like a home link, so it has to behave like one. With nothing
          open it's already home, and stays inert text. */}
      {pdf && (
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
            {unsaved ? `${changeCount} change${changeCount === 1 ? "" : "s"}` : changeCount > 0 ? (savedMark?.inPlace ? "Saved" : "Downloaded") : ""}
          </span>
          {/* A split button: the main half is the one-click Download it always
              was; the caret beside it opens Export, every other way to make a
              file from this document. None of them changes the document. On a
              phone there's no room for a second control in this row, so the
              Export group heads the ⋯ menu instead. */}
          <div className={`splitbtn appbar__export${compact ? "" : " splitbtn--split"}`}>
            <button
              className="btn btn--filled appbar__download"
              onClick={() => void download()}
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
            {!compact && (
              <div className="menu">
                <button
                  ref={exportBtnRef}
                  className="btn btn--filled splitbtn__caret"
                  onClick={() => { if (!busy) setExportOpen((v) => !v); }}
                  // Nothing in it can run while a file is being made. Not
                  // `disabled`: picking an item puts focus back here just as
                  // the file starts, and a disabled button would drop it to
                  // the page.
                  aria-disabled={busy || undefined}
                  aria-label="Export options"
                  aria-haspopup="menu"
                  aria-expanded={exportOpen}
                  data-tip="Export options"
                >
                  <Icon name="chevron_down" size={16} />
                </button>
                {exportOpen && (
                  <>
                    <div className="menu__scrim" onClick={() => setExportOpen(false)} />
                    <div className="menu__list" role="menu" aria-label="Export" ref={exportListRef} onKeyDown={onExportKeyDown}>
                      {inGroup("export")
                        .filter((c) => c.id !== "download-all")
                        .map((c) => menuRow(c, closeExport))}
                      {inGroup("export")
                        .filter((c) => c.id === "download-all")
                        .map((c) => (
                          <Fragment key={c.id}>
                            <div className="menu__divider" role="separator" />
                            {menuRow(c, closeExport)}
                          </Fragment>
                        ))}
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
          <div className="menu">
            <button ref={menuBtnRef} className="icon-btn appbar__more" onClick={() => setMenuOpen((v) => !v)} aria-label="More actions" aria-haspopup="menu" aria-expanded={menuOpen} data-tip="More actions">
              <Icon name="more_vert" size={18} />
            </button>
            {menuOpen && (
              <>
                <div className="menu__scrim" onClick={() => setMenuOpen(false)} />
                <div className="menu__list" role="menu" ref={menuListRef} onKeyDown={onMenuKeyDown}>
                  {/* Labelled groups, each the registry's rows for that group.
                      They were only separated by hairlines once, so the menu
                      read as one 13-item wall. On a phone there's no Export
                      caret, so its group heads this menu — less Download PDF,
                      which is the bar's own button on every screen. */}
                  {[...(compact ? (["export"] as const) : []), ...MENU_GROUPS, "settings" as const, "file" as const].map((g, gi) => {
                    const rows = inGroup(g).filter((c) => c.id !== "download");
                    return (
                      <Fragment key={g}>
                        {gi > 0 && <div className="menu__divider" />}
                        {/* `role="group"` with a labelled heading, not a bare
                            span: a `role="menu"` may only contain menuitems,
                            groups and separators, so a loose label is either
                            ignored or reported as a stray item. */}
                        <div role="group" aria-labelledby={`menu-grp-${g}`}>
                          <span className="menu__label label-small" id={`menu-grp-${g}`}>
                            {GROUP_LABEL[g]}
                          </span>
                          {rows.map((c) => menuRow(c, closeMenu))}
                        </div>
                      </Fragment>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        </>
      )}
      {/* No theme button here: it lives with the other preferences in the
          menu (see the workspace's start screen, which keeps one). */}
    </header>
  );

  const hidePanel = (
    <button className="icon-btn icon-btn--sm" onClick={() => setInspectorOpen(false)} aria-label="Hide panel" data-tip="Hide panel">
      <Icon name="chevron_right" size={18} />
    </button>
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
      linkPage={selectedLink?.page == null ? undefined : posBySource.get(selectedLink.page) ?? null}
      pageCount={plan.length}
      onChangeLinkPage={onChangeLinkPage}
      onChangeStyle={onChangeStyle}
      onChangeRedactionColor={onChangeRedactionColor}
      onChangeLinkUrl={onChangeLinkUrl}
      onChangeAnnotation={onChangeAnnotation}
      onArrange={arrangeSelection}
      onDelete={onDelete}
      onReset={onResetStyle}
      onClose={() => (compact ? setSheetOpen(false) : setSelection(null))}
      headerAction={compact ? undefined : hidePanel}
    />
  );

  // Several objects selected (a marquee): they share no one set of
  // properties, so the panel says what is selected and where the actions are,
  // rather than falling back to the document as if nothing were.
  const multiPanel = (
    <div className="props">
      <div className="props__header">
        <h2 className="props__title title-medium">{multi.length} objects selected</h2>
        {hidePanel}
      </div>
      <p className="props__empty body-medium">
        Move them together by dragging, or use the bar above the page to arrange, duplicate or delete them. Select
        one to change its properties.
      </p>
    </div>
  );

  const patternPanel = patternOpen && (
    <PatternPanel
      docked={!compact}
      kinds={patternKinds}
      custom={patternCustom}
      customError={
        custom && "error" in custom
          ? custom.error
          : customRun.slow
            ? "That pattern takes too long to run. Make it more specific."
            : null
      }
      pending={customRun.pending || reading > 0}
      tooMany={patternTooMany}
      hits={patternHits}
      excluded={patternExcluded}
      activeId={patternHits.find((h) => h.boxes.some((b) => b.id === activeMatch?.id))?.id ?? null}
      pageLabel={(i) => `Page ${shown.findIndex((p) => p.pageIndex === i) + 1}`}
      onToggleKind={(id) =>
        setPatternKinds((k) => (k.includes(id) ? k.filter((x) => x !== id) : [...k, id]))
      }
      onCustom={setPatternCustom}
      onToggleHit={(id) =>
        setPatternExcluded((ex) => {
  const next = new Set(ex);
  if (!next.delete(id)) next.add(id);
  return next;
        })
      }
      onSetAll={(on) => setPatternExcluded(on ? new Set() : new Set(patternHits.map((h) => h.key)))}
      onShow={(h) => {
        const i = matches.findIndex((m) => m.id === h.boxes[0].id);
        if (i < 0) return;
        setFindActive(i);
        scrolledTo.current = null;
        setShowNonce((n) => n + 1);
      }}
      onRedact={redactPatterns}
      onClose={closeFind}
    />
  );

  // Nothing selected: the document's own properties. See DocumentPanel.
  const documentPanel = (
    <DocumentPanel
      fileName={fileName}
      pages={pageFacts}
      pageNumbers={pageNumbers}
      watermark={watermark}
      lossless={losslessRaster}
      form={formFacts.fields > 0 ? { ...formFacts, flatten: formFlatten } : null}
      onFormFlatten={setFormFlatten}
      busy={busy}
      onEditNumbers={() => setFinishTab("numbers")}
      onEditWatermark={() => setFinishTab("watermark")}
      onClearNumbers={clearNumbers}
      onClearWatermark={clearWatermark}
      onOcr={runOcr}
      onLossless={setLosslessRaster}
      headerAction={hidePanel}
    />
  );


  return (
    <>
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
          onSelect={onSwitch}
          onClose={onCloseTab}
          onOpen={onOpenAnother}
        />
      )}

      <div className="workspace">
        {navOpen && (
          <>
            {compact && <div className="pagenav__scrim" onClick={() => setNavOpen(false)} />}
            <PageNav
              bytes={pdf.bytes}
              pages={plan}
              onArrange={arrangePages}
              onGrid={() => {
                setSelection(null);
                setOrganizeOpen("grid");
              }}
              onClose={compact ? () => setNavOpen(false) : undefined}
              outline={outline}
              view={navView}
              onView={setNavView}
            />
          </>
        )}
        <div className="viewer">
          <div
            className={`viewer__scroll${(sheetOpen || patternOpen) && compact ? " viewer__scroll--sheet" : ""}`}
            ref={vp.viewportRef}
            {...vp.handlers}
          >
            <div
              className="doc"
              onPointerDownCapture={(ev) => {
                pressAt.current = ev.isPrimary && ev.button === 0 ? { x: ev.clientX, y: ev.clientY } : null;
              }}
              onClickCapture={(ev) => {
                // A click meant to pick text, on a page that has none.
                const at = pressAt.current;
                pressAt.current = null;
                if (tool !== "select" || pictureHint !== "off" || !pdf || !at) return;
                if (Math.hypot(ev.clientX - at.x, ev.clientY - at.y) > 6) return;
                // The page itself — not a box, note or mark the user put on it.
                const target = ev.target as Element;
                if (!target.matches("canvas, .page, .page__overlay")) return;
                const el = target.closest<HTMLElement>(".page");
                const idx = Number(el?.dataset.pageIndex);
                const pg = pdf.pages.find((p) => p.pageIndex === idx);
                // Not a page still being read: no text *yet* isn't a picture.
                if (pg && !pg.textPending && pg.fragments.length === 0) setPictureHint("shown");
              }}
            >
            {shown.map((page, position) => (
              <PageView
                key={page.pageIndex}
                bytes={pdf.bytes}
                page={page}
                position={position}
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
                pagePos={posBySource}
                formValues={formValues}
                pageNumbers={pageNumbers}
                watermark={watermark}
                pageTotal={shown.length}
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

          {pictureHint === "shown" && !findOpen && !selection && multi.length < 2 && (
            <div className="picturehint" role="status">
              <Icon name="scan_text" size={18} />
              <span className="body-medium picturehint__text">
                This page has no text to edit. If it's a scan or picture, recognise its text first.
              </span>
              <button className="btn btn--tonal" onClick={() => void runOcr()} disabled={busy}>
                Recognise text
              </button>
              <button
                className="icon-btn icon-btn--sm"
                onClick={settleHint}
                aria-label="Dismiss"
                data-tip="Dismiss"
              >
                <Icon name="close" size={16} />
              </button>
            </div>
          )}

          {/* Pinned zoom control (does not scroll): bottom-right in the dock's
              row on a wide viewer, top-right on a narrow one (styles.css,
              "Reading width"). On phones it yields to whichever top-centre
              contextual bar is showing (find / multi-select / selection) so
              the two never overlap on a narrow screen. */}
          {!zoomHidden && (
          <div className="zoombar" role="group" aria-label="Zoom">
            <button className="icon-btn" onClick={vp.zoomOut} aria-label="Zoom out" data-tip="Zoom out">
              <Icon name="remove" size={18} />
            </button>
            {shown.length > 1 && (
              <>
                <PageJump pageCount={shown.length} docKey={plan} editing={pageJumpOpen} onEditingChange={setPageJumpOpen} />
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

          {/* Phone: a bottom sheet over the page. Wider: in the right-hand
              column (below), so it never covers the lines it is listing. */}
          {compact && patternPanel}

          {findOpen && (
            <FindBar
              query={findQuery}
              count={matches.length}
              active={matches.length ? activeIndex + 1 : 0}
              reading={reading > 0}
              onQuery={(q) => {
                setFindQuery(q);
                setFindActive(0);
              }}
              onNext={nextMatch}
              onPrev={prevMatch}
              onRedactAll={redactAllMatches}
              onPatterns={openPatterns}
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
            // Desktop: also while Redact patterns has the Inspector's column.
            (compact ? !sheetOpen : !inspectorOpen || patternOpen) && (
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
            collapses to an edge tab; never empty (the selection's properties,
            or the document's own when nothing is selected). Mobile: keeps the
            on-demand bottom sheet driven by the contextual SelectionBar. */}
        {isWide ? (
          patternOpen ? (
            // Reviewing patterns takes the column over while it lasts: the
            // list is about the page, like the properties are about the
            // selection, and beside the page is where it doesn't hide it.
            <div className="inspector inspector--patterns">{patternPanel}</div>
          ) : inspectorOpen ? (
            <aside className="inspector" aria-label={selection || multi.length >= 2 ? "Properties" : "Document"}>
              {/* One job: describe what is selected, or the document when
                  nothing is. It used to be two tabs (document actions /
                  properties); the actions now live where they act — Export,
                  the Pages sidebar, the ⋯ menu — so there is nothing left to
                  switch between, and deselecting is the way back. */}
              {selection ? propertiesPanel : multi.length >= 2 ? multiPanel : documentPanel}
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


      {coverWarn && (
        <ConfirmDialog
          title="Whiteout doesn't remove the text"
          message={`${coverWarn.count} whiteout cover${coverWarn.count > 1 ? "s" : ""} (page ${coverWarn.pages.join(", ")}) sit over live text that stays readable — by copy/paste or search — in the ${pendingDelivery.current.kind === "download" ? "downloaded" : pendingDelivery.current.kind === "share" ? "shared" : "saved"} file. For content that must be permanently removed, use the Redact tool instead. ${DELIVERY_VERB[pendingDelivery.current.kind]} anyway?`}
          confirmLabel={`${DELIVERY_VERB[pendingDelivery.current.kind]} anyway`}
          cancelLabel="Go back"
          danger
          onConfirm={() => {
            setCoverWarn(null);
            void runExport();
          }}
          onCancel={() => {
            pendingDelivery.current = { kind: "download" };
            setCoverWarn(null);
          }}
        />
      )}

      {unlockWarn && handle && (
        <ConfirmDialog
          title="Save without its password?"
          message={`${handle.name} opens with a password. Saving here replaces it with a copy that opens without one. To keep a password on the file, use Download with password instead.`}
          confirmLabel="Save without password"
          cancelLabel="Go back"
          danger
          onConfirm={() => {
            setUnlockWarn(false);
            void saveInPlace();
          }}
          onCancel={() => setUnlockWarn(false)}
        />
      )}

      {shareReady && (
        <ConfirmDialog
          title="Ready to share"
          message={`${shareReady.name} is ready.`}
          confirmLabel="Share"
          onConfirm={() => {
            const file = shareReady;
            setShareReady(null);
            // This tap is the one the share sheet needs.
            void shareFile(file).then((r) => {
              // Not a save, as on the direct path: the target may keep nothing.
              if (r === "shared") {
                setMessage(`Shared ${file.name}.`);
              } else setMessage(r === "cancelled" ? "Not shared." : "Sharing isn't available right now. Use Download instead.");
            }).catch(() => setMessage("Couldn't share the file. Use Download instead."));
          }}
          onCancel={() => setShareReady(null)}
        />
      )}

      {protectOpen && (
        <Suspense fallback={null}>
          <ProtectDialog
            busy={busy}
            onDownload={(pw) => {
              setProtectOpen(false);
              void download(pw);
            }}
            onClose={() => setProtectOpen(false)}
          />
        </Suspense>
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
            fileName={fileName}
            pageTotal={shown.length}
          />
        </Suspense>
      )}

      {compressOpen && (
        <Suspense fallback={null}>
          <CompressDialog onEstimate={estimateCompress} onDownload={downloadCompress} onClose={() => setCompressOpen(false)} />
        </Suspense>
      )}

      {cropAt != null && shown[cropAt] && pdf && (
        <Suspense fallback={null}>
          <CropDialog
            bytes={pdf.bytes}
            page={shown[cropAt]}
            position={cropAt}
            count={shown.length}
            onCrop={(scope, m, fromMargins) => cropPages(scope, m, fromMargins)}
            onClose={() => setCropAt(null)}
          />
        </Suspense>
      )}

      {hiddenOpen && (
        <Suspense fallback={null}>
          <HiddenInfoDialog
            onInspect={inspectHiddenInfo}
            busy={busy}
            onDownload={() => {
              setHiddenOpen(false);
              void download();
            }}
            onClose={() => setHiddenOpen(false)}
          />
        </Suspense>
      )}

      {compareOpen && pdf && (
        <Suspense fallback={null}>
          <CompareDialog
            // Before is the document you came from — the tab before this one —
            // and After this one; Swap trades them.
            before={(tabs[tabs.findIndex((t) => t.id === activeId) - 1] ?? tabs.find((t) => t.id !== activeId))!.id}
            after={activeId}
            onClose={() => setCompareOpen(false)}
            docs={tabs.map((t) => {
              const front = t.id === activeId;
              const state = front ? docHistory.state : parkedState(t);
              const tabPdf = front ? pdf : t.pdf;
              // Changes beyond what's already in the bytes (an Organise, a merge).
              const edited = (front ? changeCount - baked : t.changeCount - t.baked) > 0;
              return {
                id: t.id,
                name: t.fileName,
                load: async () => {
                  // Its own parse, which the tab draws from: never released here.
                  if (!edited) {
                    const full = await completeText(tabPdf);
                    return { pdf: full, text: full.pages, edited, release: () => {} };
                  }
                  // As it would download, so the comparison reads what the file will.
                  const [{ exportPdf }, { loadPdf, releaseDoc }, { textAsExported }] = await Promise.all([
                    import("./pdf/exporter"),
                    import("./pdf/loader"),
                    import("./pdf/compare"),
                  ]);
                  const input = { ...EMPTY_DOC, ...state, losslessRaster };
                  const copies: LoadedPdf[] = [];
                  const release = () => copies.forEach((c) => releaseDoc(c.bytes));
                  try {
                    const shown = await loadPdf(toAB(await exportPdf(tabPdf, input)));
                    copies.push(shown);
                    // A true redaction makes its page a picture; read the text
                    // from an export without them, and hide what they cover.
                    const covers = input.redactions.filter((r) => r.cover);
                    let read = shown;
                    if (covers.length < input.redactions.length) {
                      read = await loadPdf(toAB(await exportPdf(tabPdf, { ...input, redactions: covers })));
                      copies.push(read);
                    }
                    const plan = resolvePlan(state.pages, tabPdf.pages.length);
                    const { pages, hidden } = textAsExported(read.pages, (await completeText(tabPdf)).pages, plan, input);
                    return { pdf: shown, text: pages, hidden, edited, release };
                  } catch (err) {
                    release();
                    throw err;
                  }
                },
              };
            })}
          />
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
          commands={commands}
        />
      )}

      {organizeOpen && pdf && (
        <Suspense fallback={null}>
          <Organize
            mainBytes={pdf.bytes}
            fileName={fileName}
            hasEdits={changeCount > 0}
            pages={plan}
            onArrange={(next) => {
              setOrganizeOpen(false);
              setSelection(null);
              applyPlan(next);
            }}
            bakeMain={async (finishing) => {
              // The same guard as Download: baked in, a whiteout cover stops
              // being an object, and nothing would flag the text under it.
              const warn = findUnsafeCovers(await completeText(pdf), redactions, planned);
              if (warn.count > 0) {
                throw Object.assign(
                  new Error(`Whiteout sits over live text on page ${warn.pages.join(", ")}. Redact it instead, then try again.`),
                  { userFacing: true },
                );
              }
              const { exportPdf } = await import("./pdf/exporter");
              const state = finishing ? docHistory.state : { ...docHistory.state, pageNumbers: undefined, watermark: undefined };
              return toAB(await exportPdf(pdf, { ...state, losslessRaster }));
            }}
            onApply={(bytes, note) => {
              setOrganizeOpen(false);
              // The result *is* the edits, baked in: still unsaved work, so the
              // tab stays dirty and autosaved, and closing it asks.
              // Pages pulled in from a password-opened tab make the result one
              // too, or merging would be a way round "never stored on the device".
              const tookLocked = organizeTookLocked.current;
              organizeTookLocked.current = false;
              // Page numbers and the watermark weren't drawn in: they carry
              // over live, so they number and mark the merged pages.
              const finishing = pageNumbers || watermark ? { ...EMPTY_DOC, pageNumbers: pageNumbers ?? undefined, watermark: watermark ?? undefined } : undefined;
              onReplace(bytes, note, finishing, {
                baked: Math.max(1, changeCount),
                ...(tookLocked ? { locked: true } : {}),
              });
            }}
            onExtract={(bytes) =>
              downloadBytes(bytes, fileName.replace(/\.pdf$/i, "") + "-extract.pdf")
            }
            onSplit={(zip) =>
              downloadBytes(zip, fileName.replace(/\.pdf$/i, "") + "-split.zip", "application/zip")
            }
            startWithSplit={organizeOpen === "split"}
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
                  const warn = findUnsafeCovers(await completeText(t.pdf), state.redactions, state.pages);
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
    </>
  );
});
