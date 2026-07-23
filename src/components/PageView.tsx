import { useEffect, useRef, useState } from "react";
import { renderPage } from "../pdf/loader";
import { isFragmentModified } from "../pdf/exporter";
import { resolveFragmentStyle } from "../pdf/style";
import type {
  Edits,
  PageData,
  Redaction,
  Selection,
  TextBox,
  Tool,
} from "../pdf/types";
import { EditableFragment } from "./EditableFragment";
import { TextBoxItem } from "./TextBoxItem";
import { RedactionItem } from "./RedactionItem";

interface Props {
  bytes: ArrayBuffer;
  page: PageData;
  scale: number;
  tool: Tool;
  edits: Edits;
  textBoxes: TextBox[];
  redactions: Redaction[];
  selection: Selection;
  autoFocusId: string | null;
  /** Bumps on undo/redo so editable text is re-seeded from state. */
  revision: number;
  onSelect: (selection: Selection) => void;
  onChangeFragmentText: (id: string, text: string) => void;
  onChangeTextBoxText: (id: string, text: string) => void;
  onChangeTextBox: (id: string, patch: Partial<TextBox>, key: string) => void;
  onChangeRedaction: (
    id: string,
    patch: Partial<Redaction>,
    key: string,
  ) => void;
  onAddTextBox: (pageIndex: number, x: number, y: number) => void;
  onAddRedaction: (
    pageIndex: number,
    x: number,
    y: number,
    width: number,
    height: number,
  ) => void;
}

/** Minimum drag size (CSS px) before a redaction is created. */
const MIN_REDACTION = 6;

/** One rendered page: a raster canvas with an editable text overlay on top. */
export function PageView(props: Props) {
  const {
    bytes,
    page,
    scale,
    tool,
    edits,
    textBoxes,
    redactions,
    selection,
    autoFocusId,
    revision,
    onSelect,
    onChangeFragmentText,
    onChangeTextBoxText,
    onChangeTextBox,
    onChangeRedaction,
    onAddTextBox,
    onAddRedaction,
  } = props;

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [drag, setDrag] = useState<
    { x0: number; y0: number; x1: number; y1: number } | null
  >(null);

  useEffect(() => {
    let cancelled = false;
    const canvas = canvasRef.current;
    if (!canvas) return;
    renderPage(bytes, page.pageIndex, canvas, scale).catch((err) => {
      if (!cancelled) setError(String(err));
    });
    return () => {
      cancelled = true;
    };
  }, [bytes, page.pageIndex, scale]);

  const width = page.viewBox.width * scale;
  const height = page.viewBox.height * scale;
  const H = page.viewBox.height;

  const localPoint = (clientX: number, clientY: number) => {
    const rect = overlayRef.current!.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  };

  const onOverlayMouseDown = (ev: React.MouseEvent) => {
    // Only react to clicks on the overlay background, not on children.
    if (ev.target !== overlayRef.current) return;
    const { x, y } = localPoint(ev.clientX, ev.clientY);

    if (tool === "redact") {
      ev.preventDefault();
      setDrag({ x0: x, y0: y, x1: x, y1: y });
    } else if (tool === "text") {
      // Stop the default focus shift so the new box's auto-focus sticks.
      ev.preventDefault();
      const size = 16;
      const xPdf = x / scale;
      const yPdf = H - y / scale - size; // baseline below the click point
      onAddTextBox(page.pageIndex, xPdf, yPdf);
    } else {
      onSelect(null);
    }
  };

  const onOverlayMouseMove = (ev: React.MouseEvent) => {
    if (!drag) return;
    const { x, y } = localPoint(ev.clientX, ev.clientY);
    setDrag({ ...drag, x1: x, y1: y });
  };

  const onOverlayMouseUp = () => {
    if (!drag) return;
    const left = Math.min(drag.x0, drag.x1);
    const top = Math.min(drag.y0, drag.y1);
    const w = Math.abs(drag.x1 - drag.x0);
    const h = Math.abs(drag.y1 - drag.y0);
    setDrag(null);
    if (w < MIN_REDACTION || h < MIN_REDACTION) return;
    onAddRedaction(
      page.pageIndex,
      left / scale,
      H - (top + h) / scale,
      w / scale,
      h / scale,
    );
  };

  const cursor =
    tool === "text" ? "text" : tool === "redact" ? "crosshair" : "default";

  return (
    <div className="page" style={{ width, height }}>
      <canvas ref={canvasRef} className="page__canvas" />
      {error ? (
        <div className="page__error">Failed to render page: {error}</div>
      ) : (
        <div
          ref={overlayRef}
          className="page__overlay"
          style={{ cursor }}
          onMouseDown={onOverlayMouseDown}
          onMouseMove={onOverlayMouseMove}
          onMouseUp={onOverlayMouseUp}
          onMouseLeave={() => drag && setDrag(null)}
        >
          {page.fragments.map((fragment) => {
            const edit = edits[fragment.id];
            const value = edit?.text ?? fragment.original;
            const style = resolveFragmentStyle(fragment, edit?.style ?? {});
            const modified = isFragmentModified(fragment, edit);
            const selected =
              selection?.kind === "fragment" && selection.id === fragment.id;
            return (
              <EditableFragment
                key={fragment.id}
                fragment={fragment}
                scale={scale}
                pageHeight={H}
                value={value}
                style={style}
                modified={modified}
                selected={selected}
                interactive={tool === "select"}
                revision={revision}
                onSelect={(id) => onSelect({ kind: "fragment", id })}
                onChangeText={onChangeFragmentText}
              />
            );
          })}

          {textBoxes.map((box) => (
            <TextBoxItem
              key={box.id}
              box={box}
              scale={scale}
              pageHeight={H}
              selected={selection?.kind === "textbox" && selection.id === box.id}
              interactive={tool === "select"}
              autoFocus={autoFocusId === box.id}
              revision={revision}
              onSelect={(id) => onSelect({ kind: "textbox", id })}
              onChangeText={onChangeTextBoxText}
              onChange={onChangeTextBox}
            />
          ))}

          {redactions.map((r) => (
            <RedactionItem
              key={r.id}
              redaction={r}
              scale={scale}
              pageHeight={H}
              selected={selection?.kind === "redaction" && selection.id === r.id}
              interactive={tool === "select"}
              onSelect={(id) => onSelect({ kind: "redaction", id })}
              onChange={onChangeRedaction}
            />
          ))}

          {drag && (
            <div
              className="redaction redaction--preview"
              style={{
                left: Math.min(drag.x0, drag.x1),
                top: Math.min(drag.y0, drag.y1),
                width: Math.abs(drag.x1 - drag.x0),
                height: Math.abs(drag.y1 - drag.y0),
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}
