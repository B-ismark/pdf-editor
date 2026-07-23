import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PageView, type AnnotSpec } from "./components/PageView";
import { translateAnnotation } from "./components/AnnotationLayer";
import { PropertiesPanel } from "./components/PropertiesPanel";
import { DrawToolbar } from "./components/DrawToolbar";
import { SelectionBar } from "./components/SelectionBar";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { TooltipHost } from "./components/TooltipHost";
import { FindBar } from "./components/FindBar";
import { PageNav } from "./components/PageNav";
import { CommandPalette, type Command } from "./components/CommandPalette";
import { Icon } from "./components/Icon";
import { findMatches, extractText, type FindMatch } from "./pdf/find";
import {
  annotationBox,
  boxCX,
  boxCY,
  linkBox,
  redactionBox,
  stampBox,
  textBoxBox,
  type Box,
} from "./pdf/bbox";
import { useAutosave } from "./hooks/useAutosave";
import type { PageNumberOptions, WatermarkOptions } from "./pdf/finishOps";
import { useHistory } from "./hooks/useHistory";
import { useMediaQuery } from "./hooks/useMediaQuery";
import { usePersistentState } from "./hooks/usePrefs";
import { useTheme } from "./hooks/useTheme";
import { useViewport } from "./hooks/useViewport";
import { loadPdf } from "./pdf/loader";
import { DEFAULT_STYLE, isFragmentModified, resolveFragmentStyle } from "./pdf/style";

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
import type {
  Annotation,
  AnnotationTool,
  DocState,
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

type Status = "idle" | "loading" | "ready" | "exporting" | "error";
type NavKey = Tool | "sign";

const EMPTY_DOC: DocState = { edits: {}, textBoxes: [], redactions: [], annotations: [], stamps: [] };

/** Turn a raw thrown error into plain-language guidance (audit #12). */
function pdfOpenError(err: unknown): string {
  const s = String(err).toLowerCase();
  if (s.includes("password") || s.includes("encrypt"))
    return "This PDF is password-protected or encrypted, so it can't be opened here.";
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

const TOOLS: { key: NavKey; label: string; icon: string }[] = [
  { key: "select", label: "Select", icon: "arrow_selector_tool" },
  { key: "text", label: "Add text", icon: "text_fields" },
  { key: "draw", label: "Draw", icon: "draw" },
  { key: "sign", label: "Sign", icon: "signature" },
  { key: "redact", label: "Redact", icon: "select" },
  { key: "whiteout", label: "Whiteout", icon: "eraser" },
  { key: "link", label: "Link", icon: "link" },
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

export function App() {
  const [pdf, setPdf] = useState<LoadedPdf | null>(null);
  const [fileName, setFileName] = useState("document.pdf");
  const [tool, setTool] = useState<Tool>("select");
  const doc = useHistory<DocState>(EMPTY_DOC);
  const { edits, textBoxes, redactions, annotations, stamps } = doc.state;
  const links = doc.state.links ?? [];
  const formValues = doc.state.formValues ?? {};
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
  const [dimPages, setDimPages] = useState<boolean>(() => {
    try {
      return localStorage.getItem("pref.dimPages") === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("pref.dimPages", dimPages ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [dimPages]);
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
  const [revision, setRevision] = useState(0);
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState("");
  const [dragging, setDragging] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [organizeOpen, setOrganizeOpen] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findActive, setFindActive] = useState(0);
  const [navOpen, setNavOpen] = useState(false);
  const [cmdOpen, setCmdOpen] = useState(false);
  const [multi, setMulti] = useState<string[]>([]);
  const [compressOpen, setCompressOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  const menuListRef = useRef<HTMLDivElement>(null);
  const counter = useRef(0);
  const nextId = (prefix: string) => `${prefix}-${counter.current++}`;

  const vp = useViewport();
  const theme = useTheme();
  const { restorable, save: saveSession, clear: clearAutosave, dismissRestore } = useAutosave();
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
  const themeLabel =
    theme.mode === "light"
      ? "Light theme"
      : theme.mode === "dark"
        ? "Dark theme"
        : "System theme";

  const fragmentById = useMemo(() => {
    const map = new Map<string, TextFragment>();
    pdf?.pages.forEach((p) => p.fragments.forEach((f) => map.set(f.id, f)));
    return map;
  }, [pdf]);

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
    editedFragmentCount + textBoxes.length + redactions.length + annotations.length + stamps.length + links.length + Object.keys(formValues).length;

  // ---- Find in document (Ctrl/⌘+F) ----
  const matches: FindMatch[] = useMemo(
    () => (pdf && findOpen && findQuery ? findMatches(pdf.pages, edits, findQuery) : []),
    [pdf, findOpen, findQuery, edits],
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

  // Scroll the active match into view (centre it in the scroll surface).
  useEffect(() => {
    if (!activeMatch) return;
    const el = document.querySelector<HTMLElement>(`[data-page-index="${activeMatch.pageIndex}"]`);
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [activeMatch]);

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
    if (matches.length === 0) return;
    doc.set((d) => ({
      ...d,
      redactions: [
        ...d.redactions,
        ...matches.map((m) => ({
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
    const n = matches.length;
    setMessage(`Redacted ${n} match${n === 1 ? "" : "es"} of “${findQuery}”.`);
    setStatus("ready");
    closeFind();
  }, [matches, doc, findQuery, closeFind]);

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
    const blob = new Blob([extractText(pdf.pages, edits)], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName.replace(/\.pdf$/i, "") + ".txt";
    a.click();
    URL.revokeObjectURL(url);
    setStatus("ready");
    setMessage("Text exported.");
  }, [pdf, edits, fileName]);

  // ---- Autosave to IndexedDB (debounced) + one-time restore ----
  useEffect(() => {
    if (!pdf) return;
    saveSession(fileName, pdf.bytes, doc.state, changeCount > 0);
  }, [pdf, fileName, doc.state, changeCount, saveSession]);

  const openBytes = useCallback(
    async (bytes: ArrayBuffer, name: string, note?: string, seedDoc?: DocState) => {
      setStatus("loading");
      setMessage(`Loading ${name}…`);
      try {
        const loaded = await loadPdf(bytes);
        setPdf(loaded);
        setFileName(name);
        doc.reset(seedDoc ?? EMPTY_DOC);
        setSelection(null);
        setTool("select");
        setRevision((r) => r + 1);
        vp.setPageWidth(Math.max(...loaded.pages.map((p) => p.viewBox.width), 1));
        vp.resetZoom();
        setStatus("ready");
        const total = loaded.pages.reduce((n, p) => n + p.fragments.length, 0);
        setMessage(note ?? `${loaded.pages.length} page(s) · ${total} text fragments`);
      } catch (err) {
        setStatus("error");
        setMessage(pdfOpenError(err));
      }
    },
    [doc, vp],
  );

  const openFile = useCallback(
    async (file: File) => {
      if (file.type && file.type !== "application/pdf") {
        setStatus("error");
        setMessage(`"${file.name}" is not a PDF.`);
        return;
      }
      await openBytes(await file.arrayBuffer(), file.name);
    },
    [openBytes],
  );

  const restoreSession = useCallback(async () => {
    if (!restorable) return;
    const s = restorable;
    // Bump the id counter past any restored ids so new objects don't collide.
    const ids = [
      ...s.doc.textBoxes.map((b) => b.id),
      ...s.doc.redactions.map((r) => r.id),
      ...s.doc.annotations.map((a) => a.id),
      ...s.doc.stamps.map((st) => st.id),
    ];
    for (const id of ids) {
      const n = Number(id.split("-").pop());
      if (Number.isFinite(n) && n + 1 > counter.current) counter.current = n + 1;
    }
    dismissRestore();
    await openBytes(s.bytes, s.fileName, "Session restored.", s.doc);
  }, [restorable, dismissRestore, openBytes]);

  const downloadBytes = useCallback((bytes: Uint8Array, filename: string) => {
    const blob = new Blob([bytes as BlobPart], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  const toAB = (u8: Uint8Array): ArrayBuffer => {
    const ab = new ArrayBuffer(u8.byteLength);
    new Uint8Array(ab).set(u8);
    return ab;
  };

  /** Export the current edits to fresh bytes so finishing ops build on them. */
  const bakeCurrent = useCallback(async (): Promise<ArrayBuffer> => {
    const { exportPdf } = await import("./pdf/exporter");
    const out = await exportPdf(pdf!, { edits, textBoxes, redactions, annotations, stamps, links, formValues });
    return toAB(out);
  }, [pdf, edits, textBoxes, redactions, annotations, stamps, links, formValues]);

  const applyNumbers = useCallback(
    async (opts: PageNumberOptions) => {
      setFinishTab(null);
      setStatus("exporting");
      setMessage("Adding page numbers…");
      try {
        const baked = await bakeCurrent();
        const { addPageNumbers } = await import("./pdf/finishOps");
        const res = await addPageNumbers(baked, opts);
        await openBytes(toAB(res), fileName, "Page numbers added.");
      } catch {
        setStatus("error");
        setMessage("Couldn't add page numbers. Please try again.");
      }
    },
    [bakeCurrent, openBytes, fileName],
  );

  const applyWatermark = useCallback(
    async (opts: WatermarkOptions) => {
      setFinishTab(null);
      setStatus("exporting");
      setMessage("Applying watermark…");
      try {
        const baked = await bakeCurrent();
        const { addWatermark } = await import("./pdf/finishOps");
        const res = await addWatermark(baked, opts);
        await openBytes(toAB(res), fileName, "Watermark applied.");
      } catch {
        setStatus("error");
        setMessage("Couldn't apply the watermark. Please try again.");
      }
    },
    [bakeCurrent, openBytes, fileName],
  );

  const applyCompress = useCallback(
    async (opts: import("./pdf/finishOps").CompressOptions) => {
      if (!pdf) return;
      setCompressOpen(false);
      setStatus("exporting");
      setMessage("Compressing…");
      try {
        const baked = await bakeCurrent();
        const { compressPdf } = await import("./pdf/finishOps");
        const sizes = pdf.pages.map((p) => ({ width: p.viewBox.width, height: p.viewBox.height }));
        const out = await compressPdf(baked, sizes, opts);
        const before = pdf.bytes.byteLength;
        const after = out.byteLength;
        downloadBytes(out, fileName.replace(/\.pdf$/i, "") + "-compressed.pdf");
        setStatus("ready");
        const pct = Math.round((1 - after / before) * 100);
        const fmt = (n: number) => (n / 1_000_000).toFixed(2) + " MB";
        setMessage(
          pct > 0
            ? `Compressed — ${fmt(before)} → ${fmt(after)} (${pct}% smaller).`
            : `Compressed to ${fmt(after)}.`,
        );
      } catch {
        setStatus("error");
        setMessage("Couldn't compress this PDF. Please try again.");
      }
    },
    [pdf, bakeCurrent, fileName, downloadBytes],
  );

  const runOcr = useCallback(async () => {
    if (!pdf) return;
    setMenuOpen(false);
    setStatus("exporting");
    setMessage("Reading text (OCR)…");
    try {
      const { ocrPages } = await import("./pdf/ocr");
      const map = await ocrPages(pdf.bytes, pdf.pages, (p, t) =>
        setMessage(`Reading text… page ${p}/${t}`),
      );
      let added = 0;
      const pages = pdf.pages.map((pg) => {
        const extra = map.get(pg.pageIndex) ?? [];
        added += extra.length;
        // Replace any prior OCR layer so re-running doesn't duplicate words.
        const kept = pg.fragments.filter((f) => !f.id.startsWith("ocr:"));
        return { ...pg, fragments: [...kept, ...extra] };
      });
      setPdf({ ...pdf, pages });
      setRevision((r) => r + 1);
      setStatus("ready");
      setMessage(
        added > 0
          ? `OCR added ${added} words — now searchable and redactable.`
          : "No recognisable text found.",
      );
    } catch (err) {
      setStatus("error");
      setMessage(
        (err as Error)?.name === "OcrAssetsMissing"
          ? "On-device OCR isn't set up in this build — run `npm run setup-ocr` to enable it."
          : "OCR failed on this document. Please try again.",
      );
    }
  }, [pdf]);

  const exportImages = useCallback(async () => {
    if (!pdf) return;
    setMenuOpen(false);
    setStatus("exporting");
    setMessage("Rendering images…");
    try {
      const baked = await bakeCurrent();
      const { renderImages } = await import("./pdf/finishOps");
      const urls = await renderImages(baked, pdf.pages.length, 2);
      const base = fileName.replace(/\.pdf$/i, "");
      urls.forEach((url, i) => {
        setTimeout(() => {
          const a = document.createElement("a");
          a.href = url;
          a.download = `${base}-p${i + 1}.png`;
          a.click();
        }, i * 300);
      });
      setStatus("ready");
      setMessage(`Exported ${urls.length} image(s).`);
    } catch {
      setStatus("error");
      setMessage("Couldn't export images. Please try again.");
    }
  }, [pdf, bakeCurrent, fileName]);

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

  const onPlaceStamp = useCallback(
    (pageIndex: number, xLeft: number, yTop: number) => {
      if (!pendingStamp) return;
      const width = Math.min(220, pendingStamp.w * 0.75);
      const height = width * (pendingStamp.h / pendingStamp.w);
      const id = nextId("st");
      const stamp: Stamp = { id, pageIndex, x: xLeft, y: yTop - height, width, height, dataUrl: pendingStamp.dataUrl };
      doc.set((d) => ({ ...d, stamps: [...d.stamps, stamp] }));
      setPendingStamp(null);
      // Switch to Select so the just-placed stamp is immediately movable/
      // resizable, regardless of which tool was active before signing.
      setTool("select");
      setSelection({ kind: "stamp", id });
      setMessage("");
    },
    [pendingStamp, doc],
  );

  const onChangeStamp = useCallback(
    (id: string, patch: Partial<Stamp>, key: string) => {
      doc.set(
        (d) => ({ ...d, stamps: d.stamps.map((s) => (s.id === id ? { ...s, ...patch } : s)) }),
        key,
      );
    },
    [doc],
  );

  const onDeleteStamp = useCallback(
    (id: string) => {
      doc.set((d) => ({ ...d, stamps: d.stamps.filter((s) => s.id !== id) }));
      setSelection((sel) => (sel?.kind === "stamp" && sel.id === id ? null : sel));
    },
    [doc],
  );

  const startImagePlacement = useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result);
      const img = new Image();
      img.onload = () => {
        setPendingStamp({ dataUrl, w: img.naturalWidth, h: img.naturalHeight });
        setStatus("ready");
        setMessage("Tap the page to place the image.");
      };
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
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
    setRevision((r) => r + 1);
  }, [selection]);

  // Deselecting also exits edit mode and closes the on-demand sheet.
  useEffect(() => {
    if (!selection) {
      setEditingId(null);
      setSheetOpen(false);
    }
  }, [selection]);

  const selectedAnnotation =
    selection?.kind === "annotation"
      ? annotations.find((a) => a.id === selection.id) ?? null
      : null;

  const activeStyle: TextStyle | null = useMemo(() => {
    if (selection?.kind === "fragment") {
      const f = fragmentById.get(selection.id);
      return f ? resolveFragmentStyle(f, edits[f.id]?.style ?? {}) : null;
    }
    if (selection?.kind === "textbox") {
      return textBoxes.find((b) => b.id === selection.id)?.style ?? null;
    }
    return null;
  }, [selection, fragmentById, edits, textBoxes]);

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
    setRevision((r) => r + 1);
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
    if (selection?.kind === "textbox") {
      const id = selection.id;
      doc.set((d) => ({ ...d, textBoxes: d.textBoxes.filter((b) => b.id !== id) }));
      setSelection(null);
    } else if (selection?.kind === "redaction") {
      const id = selection.id;
      doc.set((d) => ({ ...d, redactions: d.redactions.filter((r) => r.id !== id) }));
      setSelection(null);
    } else if (selection?.kind === "annotation") {
      const id = selection.id;
      doc.set((d) => ({ ...d, annotations: d.annotations.filter((a) => a.id !== id) }));
      setSelection(null);
    } else if (selection?.kind === "stamp") {
      const id = selection.id;
      doc.set((d) => ({ ...d, stamps: d.stamps.filter((s) => s.id !== id) }));
      setSelection(null);
    } else if (selection?.kind === "link") {
      const id = selection.id;
      doc.set((d) => ({ ...d, links: (d.links ?? []).filter((l) => l.id !== id) }));
      setSelection(null);
    }
  }, [selection, doc]);

  // Command palette (Ctrl/⌘+K) — a global toggle independent of focus.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCmdOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  // ---- Duplicate / copy-paste of overlay objects ----
  type ClipItem =
    | { kind: "textbox"; obj: TextBox }
    | { kind: "redaction"; obj: Redaction }
    | { kind: "annotation"; obj: Annotation }
    | { kind: "stamp"; obj: Stamp }
    | { kind: "link"; obj: LinkAnnot };
  const clipboard = useRef<ClipItem | null>(null);

  const selectedClip = useCallback((): ClipItem | null => {
    if (!selection) return null;
    if (selection.kind === "textbox") {
      const obj = textBoxes.find((b) => b.id === selection.id);
      return obj ? { kind: "textbox", obj } : null;
    }
    if (selection.kind === "redaction") {
      const obj = redactions.find((r) => r.id === selection.id);
      return obj ? { kind: "redaction", obj } : null;
    }
    if (selection.kind === "annotation") {
      const obj = annotations.find((a) => a.id === selection.id);
      return obj ? { kind: "annotation", obj } : null;
    }
    if (selection.kind === "stamp") {
      const obj = stamps.find((s) => s.id === selection.id);
      return obj ? { kind: "stamp", obj } : null;
    }
    if (selection.kind === "link") {
      const obj = links.find((l) => l.id === selection.id);
      return obj ? { kind: "link", obj } : null;
    }
    return null;
  }, [selection, textBoxes, redactions, annotations, stamps, links]);

  /** Add a copy of a clipboard item, offset slightly, and select it. */
  const pasteItem = useCallback(
    (item: ClipItem) => {
      const dx = 12;
      const dy = -12;
      if (item.kind === "textbox") {
        const id = nextId("tb");
        const b = { ...item.obj, id, x: item.obj.x + dx, y: item.obj.y + dy };
        doc.set((d) => ({ ...d, textBoxes: [...d.textBoxes, b] }));
        setSelection({ kind: "textbox", id });
      } else if (item.kind === "redaction") {
        const id = nextId("rd");
        const r = { ...item.obj, id, x: item.obj.x + dx, y: item.obj.y + dy };
        doc.set((d) => ({ ...d, redactions: [...d.redactions, r] }));
        setSelection({ kind: "redaction", id });
      } else if (item.kind === "link") {
        const id = nextId("ln");
        const l = { ...item.obj, id, x: item.obj.x + dx, y: item.obj.y + dy };
        doc.set((d) => ({ ...d, links: [...(d.links ?? []), l] }));
        setSelection({ kind: "link", id });
      } else if (item.kind === "stamp") {
        const id = nextId("st");
        const s = { ...item.obj, id, x: item.obj.x + dx, y: item.obj.y + dy };
        doc.set((d) => ({ ...d, stamps: [...d.stamps, s] }));
        setSelection({ kind: "stamp", id });
      } else {
        const id = nextId("an");
        const a = { ...translateAnnotation(item.obj, dx, dy), id } as Annotation;
        doc.set((d) => ({ ...d, annotations: [...d.annotations, a] }));
        setSelection({ kind: "annotation", id });
      }
    },
    [doc],
  );

  const duplicateSelection = useCallback(() => {
    const item = selectedClip();
    if (item) pasteItem(item);
  }, [selectedClip, pasteItem]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || isTypingTarget()) return;
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
  const clearMulti = useCallback(() => setMulti([]), []);

  const onMarquee = useCallback((ids: string[]) => {
    setMulti(ids.length >= 2 ? ids : []);
  }, []);

  // A single selection or a tool change ends a multi-selection.
  useEffect(() => {
    if (selection) setMulti([]);
  }, [selection]);

  const multiItems = useMemo(() => {
    const set = new Set(multi);
    const items: { id: string; kind: string; box: Box }[] = [];
    textBoxes.forEach((b) => set.has(b.id) && items.push({ id: b.id, kind: "textbox", box: textBoxBox(b) }));
    redactions.forEach((r) => set.has(r.id) && items.push({ id: r.id, kind: "redaction", box: redactionBox(r) }));
    annotations.forEach((a) => set.has(a.id) && items.push({ id: a.id, kind: "annotation", box: annotationBox(a) }));
    stamps.forEach((s) => set.has(s.id) && items.push({ id: s.id, kind: "stamp", box: stampBox(s) }));
    links.forEach((l) => set.has(l.id) && items.push({ id: l.id, kind: "link", box: linkBox(l) }));
    return items;
  }, [multi, textBoxes, redactions, annotations, stamps, links]);

  /** Apply per-id {dx,dy} deltas to every overlay object in one undo step. */
  const applyDeltas = useCallback(
    (deltas: Map<string, { dx: number; dy: number }>) => {
      doc.set((d) => ({
        ...d,
        textBoxes: d.textBoxes.map((b) => {
          const m = deltas.get(b.id);
          return m ? { ...b, x: b.x + m.dx, y: b.y + m.dy } : b;
        }),
        redactions: d.redactions.map((r) => {
          const m = deltas.get(r.id);
          return m ? { ...r, x: r.x + m.dx, y: r.y + m.dy } : r;
        }),
        annotations: d.annotations.map((a) => {
          const m = deltas.get(a.id);
          return m ? translateAnnotation(a, m.dx, m.dy) : a;
        }),
        stamps: d.stamps.map((s) => {
          const m = deltas.get(s.id);
          return m ? { ...s, x: s.x + m.dx, y: s.y + m.dy } : s;
        }),
        links: (d.links ?? []).map((l) => {
          const m = deltas.get(l.id);
          return m ? { ...l, x: l.x + m.dx, y: l.y + m.dy } : l;
        }),
      }));
    },
    [doc],
  );

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
    doc.set((d) => ({
      ...d,
      textBoxes: d.textBoxes.filter((b) => !set.has(b.id)),
      redactions: d.redactions.filter((r) => !set.has(r.id)),
      annotations: d.annotations.filter((a) => !set.has(a.id)),
      stamps: d.stamps.filter((s) => !set.has(s.id)),
      links: (d.links ?? []).filter((l) => !set.has(l.id)),
    }));
    setMulti([]);
  }, [multi, doc]);

  const duplicateMulti = useCallback(() => {
    if (multiItems.length === 0) return;
    const dx = 12, dy = -12;
    const newIds: string[] = [];
    doc.set((d) => {
      const next = { ...d, links: d.links ?? [] };
      const set = new Set(multi);
      for (const b of d.textBoxes.filter((x) => set.has(x.id))) {
        const id = nextId("tb"); newIds.push(id);
        next.textBoxes = [...next.textBoxes, { ...b, id, x: b.x + dx, y: b.y + dy }];
      }
      for (const r of d.redactions.filter((x) => set.has(x.id))) {
        const id = nextId("rd"); newIds.push(id);
        next.redactions = [...next.redactions, { ...r, id, x: r.x + dx, y: r.y + dy }];
      }
      for (const s of d.stamps.filter((x) => set.has(x.id))) {
        const id = nextId("st"); newIds.push(id);
        next.stamps = [...next.stamps, { ...s, id, x: s.x + dx, y: s.y + dy }];
      }
      for (const l of next.links.filter((x) => set.has(x.id))) {
        const id = nextId("ln"); newIds.push(id);
        next.links = [...next.links, { ...l, id, x: l.x + dx, y: l.y + dy }];
      }
      for (const a of d.annotations.filter((x) => set.has(x.id))) {
        const id = nextId("an"); newIds.push(id);
        next.annotations = [...next.annotations, { ...translateAnnotation(a, dx, dy), id }];
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
    setRevision((r) => r + 1);
  }, [doc]);
  const redo = useCallback(() => {
    doc.redo();
    setRevision((r) => r + 1);
  }, [doc]);

  useEffect(() => {
    if (selection?.kind === "textbox" && !textBoxes.some((b) => b.id === selection.id)) {
      setSelection(null);
    } else if (selection?.kind === "redaction" && !redactions.some((r) => r.id === selection.id)) {
      setSelection(null);
    } else if (selection?.kind === "annotation" && !annotations.some((a) => a.id === selection.id)) {
      setSelection(null);
    } else if (selection?.kind === "stamp" && !stamps.some((s) => s.id === selection.id)) {
      setSelection(null);
    } else if (selection?.kind === "link" && !links.some((l) => l.id === selection.id)) {
      setSelection(null);
    }
  }, [textBoxes, redactions, annotations, stamps, links, selection]);

  // Warn before leaving/reloading the tab while there are unsaved changes.
  // Everything lives in memory (no server, no autosave), so an accidental
  // refresh or back-navigation would otherwise silently discard all edits.
  useEffect(() => {
    if (changeCount === 0) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [changeCount]);

  // Auto-dismiss transient status messages (keep errors until superseded).
  useEffect(() => {
    if (!message || status === "error" || status === "loading" || status === "exporting") return;
    const t = setTimeout(() => setMessage(""), 4000);
    return () => clearTimeout(t);
  }, [message, status]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      if (mod && key === "z") {
        e.preventDefault();
        e.shiftKey ? redo() : undo();
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
            setTool(t);
            if (t !== "select") setSelection(null);
          }
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
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
  ]);

  const download = useCallback(async () => {
    if (!pdf) return;
    setStatus("exporting");
    setMessage("Building edited PDF…");
    try {
      const { exportPdf } = await import("./pdf/exporter");
      const out = await exportPdf(pdf, { edits, textBoxes, redactions, annotations, stamps, links, formValues });
      const blob = new Blob([out as BlobPart], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName.replace(/\.pdf$/i, "") + "-edited.pdf";
      a.click();
      URL.revokeObjectURL(url);
      setStatus("ready");
      setMessage(
        redactions.length > 0
          ? "Downloaded — redacted pages were flattened to images."
          : "Downloaded edited PDF.",
      );
    } catch {
      setStatus("error");
      setMessage("Couldn't build the edited PDF. Please try again.");
    }
  }, [pdf, edits, textBoxes, redactions, annotations, stamps, links, formValues, fileName]);

  const doReset = useCallback(() => {
    setPdf(null);
    doc.reset(EMPTY_DOC);
    setSelection(null);
    setTool("select");
    setStatus("idle");
    setMessage("");
    setMenuOpen(false);
    setConfirmReset(false);
    clearAutosave();
  }, [doc, clearAutosave]);

  const reset = useCallback(() => {
    setMenuOpen(false);
    if (changeCount > 0) setConfirmReset(true);
    else doReset();
  }, [changeCount, doReset]);

  const pickTool = (t: NavKey) => {
    setPendingStamp(null);
    setMulti([]);
    if (t === "sign") {
      setSelection(null);
      setSigOpen(true);
      return;
    }
    setTool(t);
    if (t !== "select") setSelection(null);
  };

  const appBar = (
    <header className="appbar">
      <div className="appbar__brand">
        <span className="appbar__logo">
          <Icon name="stylus_note" size={18} filled />
        </span>
        <span className="title-large appbar__name">PDF Editor</span>
      </div>
      {pdf && (
        <button
          className={`icon-btn${navOpen ? " icon-btn--on" : ""}`}
          onClick={() => setNavOpen((v) => !v)}
          aria-label="Toggle page thumbnails"
          aria-pressed={navOpen}
          data-tip="Pages"
        >
          <Icon name="panel" size={18} />
        </button>
      )}
      {!pdf && <div className="appbar__spacer" />}
      {pdf && (
        <>
          <div className="appbar__spacer" />
          <button className="icon-btn" onClick={undo} disabled={!doc.canUndo} aria-label="Undo" data-tip="Undo · Ctrl+Z">
            <Icon name="undo" size={18} />
          </button>
          <button className="icon-btn" onClick={redo} disabled={!doc.canRedo} aria-label="Redo" data-tip="Redo · Ctrl+Shift+Z">
            <Icon name="redo" size={18} />
          </button>
          <button className="icon-btn" onClick={() => (findOpen ? closeFind() : openFind())} aria-label="Find" aria-pressed={findOpen} data-tip="Find · Ctrl+F">
            <Icon name="search" size={18} />
          </button>
          <span className="appbar__changes label-medium">
            {changeCount > 0 ? `${changeCount} change${changeCount === 1 ? "" : "s"}` : ""}
          </span>
          <button className="btn btn--filled appbar__download" onClick={download} disabled={status === "exporting"}>
            <Icon name="download" size={16} />
            <span>{status === "exporting" ? "Exporting…" : "Download"}</span>
          </button>
          <div className="menu">
            <button ref={menuBtnRef} className="icon-btn" onClick={() => setMenuOpen((v) => !v)} aria-label="More actions" aria-haspopup="menu" aria-expanded={menuOpen} data-tip="More actions">
              <Icon name="more_vert" size={18} />
            </button>
            {menuOpen && (
              <>
                <div className="menu__scrim" onClick={() => setMenuOpen(false)} />
                <div className="menu__list" role="menu" ref={menuListRef} onKeyDown={onMenuKeyDown}>
                  <button
                    className="menu__item"
                    onClick={() => {
                      setMenuOpen(false);
                      setSelection(null);
                      setOrganizeOpen(true);
                    }}
                    role="menuitem"
                  >
                    <Icon name="select" size={18} /> Organize pages
                  </button>
                  <button
                    className="menu__item"
                    onClick={() => {
                      setMenuOpen(false);
                      imageInputRef.current?.click();
                    }}
                    role="menuitem"
                  >
                    <Icon name="image" size={18} /> Add image
                  </button>
                  <div className="menu__divider" />
                  <button
                    className="menu__item"
                    onClick={() => { setMenuOpen(false); setSelection(null); setFinishTab("numbers"); }}
                    role="menuitem"
                  >
                    <Icon name="tag" size={18} /> Page numbers
                  </button>
                  <button
                    className="menu__item"
                    onClick={() => { setMenuOpen(false); setSelection(null); setFinishTab("watermark"); }}
                    role="menuitem"
                  >
                    <Icon name="watermark" size={18} /> Watermark
                  </button>
                  <button className="menu__item" onClick={exportImages} role="menuitem">
                    <Icon name="image" size={18} /> Export as images
                  </button>
                  <button
                    className="menu__item"
                    onClick={() => { setMenuOpen(false); setSelection(null); setCompressOpen(true); }}
                    role="menuitem"
                  >
                    <Icon name="compress" size={18} /> Compress PDF
                  </button>
                  <button className="menu__item" onClick={runOcr} role="menuitem">
                    <Icon name="scan_text" size={18} /> OCR (recognise text)
                  </button>
                  <div className="menu__divider" />
                  <button className="menu__item" onClick={copyAllText} role="menuitem">
                    <Icon name="content_copy" size={18} /> Copy all text
                  </button>
                  <button className="menu__item" onClick={exportTextFile} role="menuitem">
                    <Icon name="scan_text" size={18} /> Export text (.txt)
                  </button>
                  <div className="menu__divider" />
                  <button
                    className="menu__item"
                    onClick={() => setDimPages((v) => !v)}
                    role="menuitemcheckbox"
                    aria-checked={dimPages}
                  >
                    <Icon name="contrast" size={18} /> Dim pages
                    {dimPages && <Icon name="check" size={16} className="menu__check" />}
                  </button>
                  <div className="menu__divider" />
                  <button className="menu__item" onClick={reset} role="menuitem">
                    <Icon name="note_add" size={18} /> Open another PDF
                  </button>
                </div>
              </>
            )}
          </div>
        </>
      )}
      <button
        className="icon-btn"
        onClick={theme.cycle}
        aria-label={`Theme: ${themeLabel}. Click to change.`}
        data-tip={themeLabel}
      >
        <Icon name={themeIcon} size={20} />
      </button>
    </header>
  );

  const propertiesPanel = (
    <PropertiesPanel
      selection={panelSelection}
      style={activeStyle}
      redactionColor={redactionColor}
      redactionCover={!!selectedRedaction?.cover}
      annotation={selectedAnnotation}
      linkUrl={selectedLink?.url ?? null}
      onChangeStyle={onChangeStyle}
      onChangeRedactionColor={onChangeRedactionColor}
      onChangeLinkUrl={onChangeLinkUrl}
      onChangeAnnotation={onChangeAnnotation}
      onDelete={onDelete}
      onReset={onResetStyle}
      onClose={() => (compact ? setSheetOpen(false) : setSelection(null))}
    />
  );

  if (!pdf) {
    return (
      <div className="app">
        <TooltipHost />
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
            const file = e.dataTransfer.files[0];
            if (file) void openFile(file);
          }}
        >
          {restorable && (
            <div className="restore-banner">
              <span className="restore-banner__icon"><Icon name="rotate" size={22} /></span>
              <div className="restore-banner__text">
                <b className="title-small">Restore your last session?</b>
                <span className="body-small">{restorable.fileName}</span>
              </div>
              <button className="btn btn--tonal" onClick={restoreSession}>Restore</button>
              <button className="btn btn--text" onClick={dismissRestore}>Dismiss</button>
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
            <p className="body-small dropzone__hint">or drag &amp; drop a file here</p>
            {status === "loading" && <p className="body-small dropzone__note">{message}</p>}
            {status === "error" && <p className="body-small dropzone__err">{message}</p>}
          </div>
          <input
            ref={inputRef}
            type="file"
            accept="application/pdf,.pdf"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void openFile(file);
              e.target.value = "";
            }}
          />
        </div>
      </div>
    );
  }

  return (
    <div className={`app${dimPages ? " app--dim" : ""}`}>
      <TooltipHost />
      {appBar}

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
        <nav className="toolnav" aria-label="Tools">
          {TOOLS.map((t) => (
            <button
              key={t.key}
              className={`toolnav__btn${tool === t.key ? " toolnav__btn--on" : ""}`}
              onClick={() => pickTool(t.key)}
              aria-pressed={tool === t.key}
              data-tip={`${t.label} · ${TOOL_SHORTCUT[t.key]}`}
            >
              <span className="toolnav__ind">
                <Icon name={t.icon} size={21} filled={tool === t.key} />
              </span>
              <span className="toolnav__label label-medium">{t.label}</span>
            </button>
          ))}
        </nav>

        <div className="viewer">
          <div
            className="viewer__scroll"
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
                edits={edits}
                textBoxes={textBoxes.filter((b) => b.pageIndex === page.pageIndex)}
                redactions={redactions.filter((r) => r.pageIndex === page.pageIndex)}
                annotations={annotations.filter((a) => a.pageIndex === page.pageIndex)}
                stamps={stamps.filter((s) => s.pageIndex === page.pageIndex)}
                links={links.filter((l) => l.pageIndex === page.pageIndex)}
                formValues={formValues}
                multiIds={multiIds}
                placing={!!pendingStamp}
                findMatches={matchesByPage.get(page.pageIndex)}
                activeFindId={activeMatch?.id ?? null}
                selection={selection}
                autoFocusId={autoFocusId}
                editingId={editingId}
                compact={compact}
                revision={revision}
                onSelect={onSelect}
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
                onAddAnnotation={onAddAnnotation}
                onPlaceStamp={onPlaceStamp}
              />
            ))}
            </div>
          </div>

          {/* Pinned zoom control (bottom-right, does not scroll) — hidden
              while the mobile properties sheet covers the bottom. */}
          {!sheetOpen && (
          <div className="zoombar" role="group" aria-label="Zoom">
            <button className="icon-btn" onClick={vp.zoomOut} aria-label="Zoom out" data-tip="Zoom out">
              <Icon name="remove" size={18} />
            </button>
            <button className="zoombar__label label-medium" onClick={vp.resetZoom} data-tip="Fit to width">
              {Math.round(vp.zoom * 100)}%
            </button>
            <button className="icon-btn" onClick={vp.zoomIn} aria-label="Zoom in" data-tip="Zoom in">
              <Icon name="add" size={18} />
            </button>
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
            />
          )}

          {/* Mobile: contextual toolbar (instead of auto-opening the sheet) so
              the selected object stays visible and directly manipulable. */}
          {compact && selection && selection.kind !== "stamp" && !sheetOpen && (
            <SelectionBar
              key={`${selection.kind}-${selection.id}`}
              selection={selection}
              annotationKind={selectedAnnotation?.kind}
              onEdit={editSelection}
              onStyle={() => setSheetOpen(true)}
              onDelete={onDelete}
              onClose={() => setSelection(null)}
            />
          )}
        </div>

        {/* Stamps are edited directly on the canvas (no panel). Wide screens
            get a persistent side panel so the layout doesn't shift. On phones,
            a single tap shows the contextual SelectionBar (above) — the full
            properties sheet opens only on demand (its Style action), so it
            never auto-covers the selected object. */}
        {isWide ? (
          <aside className="panel">{propertiesPanel}</aside>
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

      {/* Mobile primary action (hidden while the properties sheet is open) */}
      {!sheetOpen && (
        <button
          className="fab"
          onClick={download}
          disabled={status === "exporting"}
          aria-label="Download PDF"
        >
          <Icon name={status === "exporting" ? "hourglass_top" : "download"} size={20} />
          <span className="fab__label label-large">
            {status === "exporting" ? "Exporting…" : "Download"}
          </span>
        </button>
      )}

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
          className={`snackbar body-medium${status === "error" ? " snackbar--err" : ""}`}
          aria-hidden="true"
        >
          {message}
        </div>
      )}

      {sigOpen && (
        <Suspense fallback={null}>
          <SignatureDialog
            onClose={() => setSigOpen(false)}
            onCreate={(sig) => {
              setSigOpen(false);
              setPendingStamp(sig);
              setStatus("ready");
              setMessage("Tap the page to place your signature.");
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
          if (f) startImagePlacement(f);
          e.target.value = "";
        }}
      />

      {confirmReset && (
        <ConfirmDialog
          title="Open a different PDF?"
          message="This discards all your current changes."
          confirmLabel="Discard & open"
          danger
          onConfirm={doReset}
          onCancel={() => setConfirmReset(false)}
        />
      )}

      {finishTab && (
        <Suspense fallback={null}>
          <FinishDialog
            initialTab={finishTab}
            onApplyNumbers={applyNumbers}
            onApplyWatermark={applyWatermark}
            onClose={() => setFinishTab(null)}
          />
        </Suspense>
      )}

      {compressOpen && (
        <Suspense fallback={null}>
          <CompressDialog onApply={applyCompress} onClose={() => setCompressOpen(false)} />
        </Suspense>
      )}

      {cmdOpen && (
        <CommandPalette
          onClose={() => setCmdOpen(false)}
          commands={
            [
              { id: "select", label: "Select tool", hint: "V", icon: "arrow_selector_tool", run: () => pickTool("select") },
              { id: "text", label: "Add text", hint: "T", icon: "text_fields", run: () => pickTool("text") },
              { id: "draw", label: "Draw", hint: "D", icon: "draw", run: () => pickTool("draw") },
              { id: "sign", label: "Sign", hint: "S", icon: "signature", run: () => pickTool("sign") },
              { id: "redact", label: "Redact", hint: "R", icon: "select", run: () => pickTool("redact") },
              { id: "whiteout", label: "Whiteout", hint: "W", icon: "eraser", run: () => pickTool("whiteout") },
              { id: "link", label: "Add link", hint: "L", icon: "link", run: () => pickTool("link") },
              { id: "duplicate", label: "Duplicate selection", hint: "Ctrl+D", icon: "duplicate", disabled: !selection || selection.kind === "fragment", run: duplicateSelection },
              { id: "find", label: "Find in document", hint: "Ctrl+F", icon: "search", run: openFind },
              { id: "pages", label: "Toggle page thumbnails", icon: "panel", run: () => setNavOpen((v) => !v) },
              { id: "undo", label: "Undo", hint: "Ctrl+Z", icon: "undo", disabled: !doc.canUndo, run: undo },
              { id: "redo", label: "Redo", hint: "Ctrl+Shift+Z", icon: "redo", disabled: !doc.canRedo, run: redo },
              { id: "organize", label: "Organize pages", icon: "layers", keywords: "reorder rotate merge split", run: () => { setSelection(null); setOrganizeOpen(true); } },
              { id: "image", label: "Add image", icon: "image", run: () => imageInputRef.current?.click() },
              { id: "numbers", label: "Add page numbers", icon: "tag", run: () => { setSelection(null); setFinishTab("numbers"); } },
              { id: "watermark", label: "Add watermark", icon: "watermark", run: () => { setSelection(null); setFinishTab("watermark"); } },
              { id: "eximg", label: "Export as images", icon: "image", run: exportImages },
              { id: "compress", label: "Compress / optimise PDF", icon: "compress", keywords: "shrink reduce size", run: () => setCompressOpen(true) },
              { id: "ocr", label: "OCR — recognise text", icon: "scan_text", keywords: "scan searchable image", run: runOcr },
              { id: "copytext", label: "Copy all text", icon: "content_copy", run: copyAllText },
              { id: "exporttext", label: "Export text (.txt)", icon: "scan_text", run: exportTextFile },
              { id: "dim", label: dimPages ? "Undim pages" : "Dim pages", icon: "contrast", run: () => setDimPages((v) => !v) },
              { id: "theme", label: `Theme: ${themeLabel}`, icon: themeIcon, keywords: "dark light system", run: theme.cycle },
              { id: "download", label: "Download PDF", hint: "", icon: "download", run: download },
              { id: "open", label: "Open another PDF", icon: "note_add", run: reset },
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
              void openBytes(bytes, fileName, note);
            }}
            onExtract={(bytes) =>
              downloadBytes(bytes, fileName.replace(/\.pdf$/i, "") + "-extract.pdf")
            }
            onClose={() => setOrganizeOpen(false)}
          />
        </Suspense>
      )}
    </div>
  );
}
