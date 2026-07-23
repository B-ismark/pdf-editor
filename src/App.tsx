import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PageView } from "./components/PageView";
import { PropertiesPanel } from "./components/PropertiesPanel";
import { useHistory } from "./hooks/useHistory";
import { loadPdf } from "./pdf/loader";
import { exportPdf, isFragmentModified } from "./pdf/exporter";
import { DEFAULT_STYLE, resolveFragmentStyle } from "./pdf/style";
import type {
  DocState,
  LoadedPdf,
  Redaction,
  Selection,
  TextBox,
  TextFragment,
  TextStyle,
  Tool,
} from "./pdf/types";

type Status = "idle" | "loading" | "ready" | "exporting" | "error";

const EMPTY_DOC: DocState = { edits: {}, textBoxes: [], redactions: [] };

const TOOLS: { key: Tool; label: string; hint: string }[] = [
  { key: "select", label: "Select", hint: "Click text to edit, restyle, drag, or resize it" },
  { key: "text", label: "Add text", hint: "Click on the page to drop a text box" },
  { key: "redact", label: "Redact", hint: "Drag to permanently black out a region" },
];

export function App() {
  const [pdf, setPdf] = useState<LoadedPdf | null>(null);
  const [fileName, setFileName] = useState("document.pdf");
  const [tool, setTool] = useState<Tool>("select");
  const doc = useHistory<DocState>(EMPTY_DOC);
  const { edits, textBoxes, redactions } = doc.state;
  const [selection, setSelection] = useState<Selection>(null);
  const [autoFocusId, setAutoFocusId] = useState<string | null>(null);
  // Bumped on undo/redo/load so imperatively-managed editable text re-seeds.
  const [revision, setRevision] = useState(0);
  const [scale, setScale] = useState(1.4);
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState("");
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const counter = useRef(0);
  const nextId = (prefix: string) => `${prefix}-${counter.current++}`;

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
    editedFragmentCount + textBoxes.length + redactions.length;

  const openFile = useCallback(
    async (file: File) => {
      if (file.type && file.type !== "application/pdf") {
        setStatus("error");
        setMessage(`"${file.name}" is not a PDF.`);
        return;
      }
      setStatus("loading");
      setMessage(`Loading ${file.name}…`);
      try {
        const bytes = await file.arrayBuffer();
        const loaded = await loadPdf(bytes);
        setPdf(loaded);
        setFileName(file.name);
        doc.reset(EMPTY_DOC);
        setSelection(null);
        setTool("select");
        setRevision((r) => r + 1);
        setStatus("ready");
        const total = loaded.pages.reduce((n, p) => n + p.fragments.length, 0);
        setMessage(`${loaded.pages.length} page(s), ${total} text fragments.`);
      } catch (err) {
        setStatus("error");
        setMessage(`Could not open PDF: ${String(err)}`);
      }
    },
    [doc],
  );

  // ---- Text edits ----
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

  // ---- Geometry (drag / resize) ----
  const onChangeTextBox = useCallback(
    (id: string, patch: Partial<TextBox>, key: string) => {
      doc.set(
        (d) => ({
          ...d,
          textBoxes: d.textBoxes.map((b) =>
            b.id === id ? { ...b, ...patch } : b,
          ),
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
          redactions: d.redactions.map((r) =>
            r.id === id ? { ...r, ...patch } : r,
          ),
        }),
        key,
      );
    },
    [doc],
  );

  // ---- Adding ----
  const onAddTextBox = useCallback(
    (pageIndex: number, x: number, y: number) => {
      const id = nextId("tb");
      const box: TextBox = {
        id,
        pageIndex,
        x,
        y,
        text: "",
        style: { ...DEFAULT_STYLE },
      };
      doc.set((d) => ({ ...d, textBoxes: [...d.textBoxes, box] }));
      setTool("select");
      setSelection({ kind: "textbox", id });
      setAutoFocusId(id);
    },
    [doc],
  );

  const onAddRedaction = useCallback(
    (pageIndex: number, x: number, y: number, width: number, height: number) => {
      const id = nextId("rd");
      doc.set((d) => ({
        ...d,
        redactions: [
          ...d.redactions,
          { id, pageIndex, x, y, width, height, color: "#000000" },
        ],
      }));
      setTool("select");
      setSelection({ kind: "redaction", id });
    },
    [doc],
  );

  const onSelect = useCallback((sel: Selection) => {
    setAutoFocusId(null);
    setSelection(sel);
  }, []);

  // ---- Styling ----
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
      // Colour sweeps coalesce into one undo step; discrete toggles don't.
      const onlyColour =
        Object.keys(patch).length === 1 && patch.color !== undefined;
      const key = onlyColour
        ? `color-${selection.kind}-${selection.id}`
        : undefined;

      if (selection.kind === "fragment") {
        const id = selection.id;
        doc.set((d) => {
          const f = fragmentById.get(id);
          const prev = d.edits[id] ?? { text: f?.original ?? "", style: {} };
          return {
            ...d,
            edits: { ...d.edits, [id]: { ...prev, style: { ...prev.style, ...patch } } },
          };
        }, key);
      } else if (selection.kind === "textbox") {
        const id = selection.id;
        doc.set(
          (d) => ({
            ...d,
            textBoxes: d.textBoxes.map((b) =>
              b.id === id ? { ...b, style: { ...b.style, ...patch } } : b,
            ),
          }),
          key,
        );
      }
    },
    [selection, fragmentById, doc],
  );

  const onChangeRedactionColor = useCallback(
    (color: string) => {
      if (selection?.kind !== "redaction") return;
      const id = selection.id;
      doc.set(
        (d) => ({
          ...d,
          redactions: d.redactions.map((r) =>
            r.id === id ? { ...r, color } : r,
          ),
        }),
        `rcolor-${id}`,
      );
    },
    [selection, doc],
  );

  const onDelete = useCallback(() => {
    if (selection?.kind === "textbox") {
      const id = selection.id;
      doc.set((d) => ({
        ...d,
        textBoxes: d.textBoxes.filter((b) => b.id !== id),
      }));
      setSelection(null);
    } else if (selection?.kind === "redaction") {
      const id = selection.id;
      doc.set((d) => ({
        ...d,
        redactions: d.redactions.filter((r) => r.id !== id),
      }));
      setSelection(null);
    }
  }, [selection, doc]);

  // ---- Undo / redo ----
  const undo = useCallback(() => {
    doc.undo();
    setRevision((r) => r + 1);
  }, [doc]);

  const redo = useCallback(() => {
    doc.redo();
    setRevision((r) => r + 1);
  }, [doc]);

  // Drop a selection that no longer exists after an undo/redo.
  useEffect(() => {
    if (selection?.kind === "textbox" && !textBoxes.some((b) => b.id === selection.id)) {
      setSelection(null);
    } else if (
      selection?.kind === "redaction" &&
      !redactions.some((r) => r.id === selection.id)
    ) {
      setSelection(null);
    }
  }, [textBoxes, redactions, selection]);

  // Keyboard: undo/redo, and Delete for a selected redaction.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      if (mod && key === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && key === "y") {
        e.preventDefault();
        redo();
        return;
      }
      if (
        selection?.kind === "redaction" &&
        (e.key === "Delete" || e.key === "Backspace")
      ) {
        e.preventDefault();
        onDelete();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selection, onDelete, undo, redo]);

  const download = useCallback(async () => {
    if (!pdf) return;
    setStatus("exporting");
    setMessage("Building edited PDF…");
    try {
      const out = await exportPdf(pdf, { edits, textBoxes, redactions });
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
          ? "Downloaded. Redacted pages were flattened to images."
          : "Downloaded edited PDF.",
      );
    } catch (err) {
      setStatus("error");
      setMessage(`Export failed: ${String(err)}`);
    }
  }, [pdf, edits, textBoxes, redactions, fileName]);

  const reset = useCallback(() => {
    if (changeCount > 0 && !confirm("Discard all changes and start over?"))
      return;
    setPdf(null);
    doc.reset(EMPTY_DOC);
    setSelection(null);
    setTool("select");
    setStatus("idle");
    setMessage("");
  }, [changeCount, doc]);

  const activeHint = TOOLS.find((t) => t.key === tool)?.hint ?? "";

  return (
    <div className="app">
      <header className="toolbar">
        <div className="toolbar__brand">
          <span className="toolbar__logo">✎</span>
          <span>PDF Text Editor</span>
        </div>

        {pdf && (
          <>
            <div className="toolbar__group toolbar__tools">
              {TOOLS.map((t) => (
                <button
                  key={t.key}
                  className={`tool${tool === t.key ? " tool--on" : ""}`}
                  onClick={() => {
                    setTool(t.key);
                    if (t.key !== "select") setSelection(null);
                  }}
                  title={t.hint}
                >
                  {t.label}
                </button>
              ))}
            </div>

            <div className="toolbar__group">
              <button onClick={undo} disabled={!doc.canUndo} title="Undo (Ctrl+Z)">
                ↶
              </button>
              <button onClick={redo} disabled={!doc.canRedo} title="Redo (Ctrl+Shift+Z)">
                ↷
              </button>
            </div>

            <div className="toolbar__group">
              <button
                onClick={() =>
                  setScale((s) => Math.max(0.5, +(s - 0.2).toFixed(2)))
                }
                title="Zoom out"
              >
                −
              </button>
              <span className="toolbar__zoom">{Math.round(scale * 100)}%</span>
              <button
                onClick={() =>
                  setScale((s) => Math.min(3, +(s + 0.2).toFixed(2)))
                }
                title="Zoom in"
              >
                +
              </button>
            </div>
          </>
        )}

        <div className="toolbar__spacer" />

        {pdf && (
          <>
            <span className="toolbar__status">
              {changeCount > 0
                ? `${changeCount} change${changeCount === 1 ? "" : "s"}`
                : "No changes yet"}
            </span>
            <button
              className="btn btn--primary"
              onClick={download}
              disabled={status === "exporting"}
            >
              {status === "exporting" ? "Exporting…" : "Download PDF"}
            </button>
            <button className="btn" onClick={reset}>
              New file
            </button>
          </>
        )}
      </header>

      {!pdf ? (
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
          onClick={() => inputRef.current?.click()}
        >
          <div className="dropzone__icon">📄</div>
          <h1>Drop a PDF here</h1>
          <p>or click to browse. Everything runs in your browser — no uploads.</p>
          {status === "loading" && <p className="dropzone__note">{message}</p>}
          {status === "error" && <p className="dropzone__error">{message}</p>}
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
      ) : (
        <>
          <PropertiesPanel
            selection={selection}
            style={activeStyle}
            redactionColor={redactionColor}
            onChangeStyle={onChangeStyle}
            onChangeRedactionColor={onChangeRedactionColor}
            onDelete={onDelete}
          />
          <div className="statusbar">
            <span className={status === "error" ? "statusbar--error" : ""}>
              {message}
            </span>
            <span className="statusbar__hint">{activeHint}</span>
          </div>
          <main className="viewer">
            {pdf.pages.map((page) => (
              <PageView
                key={page.pageIndex}
                bytes={pdf.bytes}
                page={page}
                scale={scale}
                tool={tool}
                edits={edits}
                textBoxes={textBoxes.filter(
                  (b) => b.pageIndex === page.pageIndex,
                )}
                redactions={redactions.filter(
                  (r) => r.pageIndex === page.pageIndex,
                )}
                selection={selection}
                autoFocusId={autoFocusId}
                revision={revision}
                onSelect={onSelect}
                onChangeFragmentText={onChangeFragmentText}
                onChangeTextBoxText={onChangeTextBoxText}
                onChangeTextBox={onChangeTextBox}
                onChangeRedaction={onChangeRedaction}
                onAddTextBox={onAddTextBox}
                onAddRedaction={onAddRedaction}
              />
            ))}
          </main>
        </>
      )}
    </div>
  );
}
