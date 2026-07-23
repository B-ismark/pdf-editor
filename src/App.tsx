import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PageView, type AnnotSpec } from "./components/PageView";
import { PropertiesPanel } from "./components/PropertiesPanel";
import { DrawToolbar } from "./components/DrawToolbar";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { TooltipHost } from "./components/TooltipHost";
import { Icon } from "./components/Icon";
import type { PageNumberOptions, WatermarkOptions } from "./pdf/finishOps";
import { useHistory } from "./hooks/useHistory";
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

const TOOLS: { key: NavKey; label: string; icon: string }[] = [
  { key: "select", label: "Select", icon: "arrow_selector_tool" },
  { key: "text", label: "Add text", icon: "text_fields" },
  { key: "draw", label: "Draw", icon: "draw" },
  { key: "sign", label: "Sign", icon: "signature" },
  { key: "redact", label: "Redact", icon: "select" },
];

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
  const [sigOpen, setSigOpen] = useState(false);
  const [finishTab, setFinishTab] = useState<"numbers" | "watermark" | null>(null);
  const [pendingStamp, setPendingStamp] = useState<{ dataUrl: string; w: number; h: number } | null>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const [selection, setSelection] = useState<Selection>(null);
  const [autoFocusId, setAutoFocusId] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState("");
  const [dragging, setDragging] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [organizeOpen, setOrganizeOpen] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const counter = useRef(0);
  const nextId = (prefix: string) => `${prefix}-${counter.current++}`;

  const vp = useViewport();
  const theme = useTheme();
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
        setMessage(`Could not open PDF: ${String(err)}`);
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
      } catch (err) {
        setStatus("error");
        setMessage(`Failed: ${String(err)}`);
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
      } catch (err) {
        setStatus("error");
        setMessage(`Failed: ${String(err)}`);
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
    } catch (err) {
      setStatus("error");
      setMessage(`Failed: ${String(err)}`);
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
    setSelection(sel);
  }, []);

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
      if (
        (selection?.kind === "redaction" || selection?.kind === "stamp") &&
        (e.key === "Delete" || e.key === "Backspace")
      ) {
        e.preventDefault();
        onDelete();
      }
      // Delete a selected annotation (but not while editing a sticky note).
      if (
        selection?.kind === "annotation" &&
        e.key === "Delete" &&
        selectedAnnotation?.kind !== "note"
      ) {
        e.preventDefault();
        onDelete();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selection, selectedAnnotation, onDelete, undo, redo]);

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
    } catch (err) {
      setStatus("error");
      setMessage(`Export failed: ${String(err)}`);
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
            <button className="icon-btn" onClick={() => setMenuOpen((v) => !v)} aria-label="More" aria-expanded={menuOpen} data-tip="More actions">
              <Icon name="more_vert" size={18} />
            </button>
            {menuOpen && (
              <>
                <div className="menu__scrim" onClick={() => setMenuOpen(false)} />
                <div className="menu__list" role="menu">
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
    <div className="app">
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
                placing={!!pendingStamp}
                selection={selection}
                autoFocusId={autoFocusId}
                revision={revision}
                onSelect={onSelect}
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

          {/* Pinned zoom control (bottom-right, does not scroll) */}
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

          {tool === "draw" && (
            <DrawToolbar
              drawTool={drawTool}
              setDrawTool={setDrawTool}
              drawStyle={drawStyle}
              setDrawStyle={setDrawStyle}
            />
          )}
        </div>

        {/* Stamps (signatures/images) are manipulated directly on the canvas —
            no properties sheet, so it never covers the element being dragged. */}
        {selection && selection.kind !== "stamp" && (
          <>
            {/* Mobile-only scrim: tap outside the sheet to dismiss. */}
            <div className="scrim" onPointerDown={() => setSelection(null)} />
            <aside className="panel">
              <PropertiesPanel
                selection={selection}
                style={activeStyle}
                redactionColor={redactionColor}
                annotation={selectedAnnotation}
                onChangeStyle={onChangeStyle}
                onChangeRedactionColor={onChangeRedactionColor}
                onChangeAnnotation={onChangeAnnotation}
                onDelete={onDelete}
                onReset={onResetStyle}
                onClose={() => setSelection(null)}
              />
            </aside>
          </>
        )}
      </div>

      {/* Mobile primary action */}
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

      {message && (
        <div className={`snackbar body-medium${status === "error" ? " snackbar--err" : ""}`}>
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
