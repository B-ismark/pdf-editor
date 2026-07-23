import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PageView, type AnnotSpec } from "./components/PageView";
import { translateAnnotation } from "./components/AnnotationLayer";
import { PropertiesPanel } from "./components/PropertiesPanel";
import { DrawToolbar } from "./components/DrawToolbar";
import { SelectionBar } from "./components/SelectionBar";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { TooltipHost } from "./components/TooltipHost";
import { Icon } from "./components/Icon";
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
import type {
  Annotation,
  AnnotationTool,
  DocState,
  DrawStyle,
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
];

// Single-key tool shortcuts (ignored while typing or when a modal is open).
const TOOL_KEYS: Record<string, NavKey> = {
  v: "select",
  t: "text",
  d: "draw",
  s: "sign",
  r: "redact",
};
const TOOL_SHORTCUT: Record<NavKey, string> = {
  select: "V",
  text: "T",
  draw: "D",
  sign: "S",
  redact: "R",
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
  const inputRef = useRef<HTMLInputElement>(null);
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  const menuListRef = useRef<HTMLDivElement>(null);
  const counter = useRef(0);
  const nextId = (prefix: string) => `${prefix}-${counter.current++}`;

  const vp = useViewport();
  const theme = useTheme();
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
    editedFragmentCount + textBoxes.length + redactions.length + annotations.length + stamps.length;

  const openBytes = useCallback(
    async (bytes: ArrayBuffer, name: string, note?: string) => {
      setStatus("loading");
      setMessage(`Loading ${name}…`);
      try {
        const loaded = await loadPdf(bytes);
        setPdf(loaded);
        setFileName(name);
        doc.reset(EMPTY_DOC);
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
    const out = await exportPdf(pdf!, { edits, textBoxes, redactions, annotations, stamps });
    return toAB(out);
  }, [pdf, edits, textBoxes, redactions, annotations, stamps]);

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
    (pageIndex: number, x: number, y: number, width: number, height: number) => {
      const id = nextId("rd");
      doc.set((d) => ({
        ...d,
        redactions: [...d.redactions, { id, pageIndex, x, y, width, height, color: "#000000" }],
      }));
      // Switch to Select so the new redaction can be moved/resized/recoloured
      // right away (in Redact mode it wouldn't be interactive).
      setTool("select");
      setSelection({ kind: "redaction", id });
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

  /** Select a text element and immediately enter edit mode (double-tap on
   * touch). Unlike `editSelection`, this takes the target directly so it
   * doesn't depend on the selection state settling first. */
  const enterEdit = useCallback((sel: NonNullable<Selection>) => {
    setSelection(sel);
    setSheetOpen(false);
    setEditingId(sel.id);
    setAutoFocusId(sel.id);
    setRevision((r) => r + 1);
  }, []);

  // Deselecting also exits edit mode and closes the on-demand sheet.
  useEffect(() => {
    if (!selection) {
      setEditingId(null);
      setSheetOpen(false);
    }
  }, [selection]);

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

  const redactionColor =
    selection?.kind === "redaction"
      ? redactions.find((r) => r.id === selection.id)?.color ?? "#000000"
      : null;

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
    }
  }, [selection, doc]);

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
    }
  }, [textBoxes, redactions, annotations, stamps, selection]);

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
      // Escape clears the current selection (and closes the mobile sheet /
      // desktop panel, which is driven by selection). Modals stop Escape from
      // reaching here via their own capture-phase handler.
      if (e.key === "Escape" && selection) {
        e.preventDefault();
        setSelection(null);
        return;
      }
      if (
        (selection?.kind === "redaction" || selection?.kind === "stamp") &&
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
  ]);

  const download = useCallback(async () => {
    if (!pdf) return;
    setStatus("exporting");
    setMessage("Building edited PDF…");
    try {
      const { exportPdf } = await import("./pdf/exporter");
      const out = await exportPdf(pdf, { edits, textBoxes, redactions, annotations, stamps });
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
  }, [pdf, edits, textBoxes, redactions, annotations, stamps, fileName]);

  const doReset = useCallback(() => {
    setPdf(null);
    doc.reset(EMPTY_DOC);
    setSelection(null);
    setTool("select");
    setStatus("idle");
    setMessage("");
    setMenuOpen(false);
    setConfirmReset(false);
  }, [doc]);

  const reset = useCallback(() => {
    setMenuOpen(false);
    if (changeCount > 0) setConfirmReset(true);
    else doReset();
  }, [changeCount, doReset]);

  const pickTool = (t: NavKey) => {
    setPendingStamp(null);
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
      annotation={selectedAnnotation}
      onChangeStyle={onChangeStyle}
      onChangeRedactionColor={onChangeRedactionColor}
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
                edits={edits}
                textBoxes={textBoxes.filter((b) => b.pageIndex === page.pageIndex)}
                redactions={redactions.filter((r) => r.pageIndex === page.pageIndex)}
                annotations={annotations.filter((a) => a.pageIndex === page.pageIndex)}
                stamps={stamps.filter((s) => s.pageIndex === page.pageIndex)}
                placing={!!pendingStamp}
                selection={selection}
                autoFocusId={autoFocusId}
                editingId={editingId}
                compact={compact}
                revision={revision}
                onSelect={onSelect}
                onEditText={enterEdit}
                onChangeFragmentText={onChangeFragmentText}
                onChangeTextBoxText={onChangeTextBoxText}
                onChangeTextBox={onChangeTextBox}
                onChangeRedaction={onChangeRedaction}
                onChangeNoteText={onChangeNoteText}
                onMoveAnnotation={onMoveAnnotation}
                onChangeStamp={onChangeStamp}
                onDeleteStamp={onDeleteStamp}
                onAddTextBox={onAddTextBox}
                onAddRedaction={onAddRedaction}
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
