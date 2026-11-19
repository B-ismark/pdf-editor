import { useRef, useState } from "react";
import { Icon } from "./Icon";
import { useSignatures } from "../hooks/useSignatures";
import { useModal, scrimPress } from "../hooks/useModal";

interface Props {
  onCreate: (sig: { dataUrl: string; w: number; h: number }) => void;
  onClose: () => void;
}

type Tab = "draw" | "type" | "upload";
const PAD_W = 560;
const PAD_H = 220;

/** Crop a drawn signature to its ink bounding box (+ a small even margin) so
 * the placed stamp fits the strokes instead of the whole empty pad. */
function trimToInk(canvas: HTMLCanvasElement): { dataUrl: string; w: number; h: number } | null {
  const g = canvas.getContext("2d");
  if (!g) return null;
  const { width, height } = canvas;
  const { data } = g.getImageData(0, 0, width, height);
  let minX = width, minY = height, maxX = 0, maxY = 0, found = false;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 10) {
        found = true;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (!found) return null;
  const pad = 14;
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(width - 1, maxX + pad);
  maxY = Math.min(height - 1, maxY + pad);
  const w = maxX - minX + 1;
  const h = maxY - minY + 1;
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  out.getContext("2d")!.drawImage(canvas, minX, minY, w, h, 0, 0, w, h);
  return { dataUrl: out.toDataURL("image/png"), w, h };
}

/** Create a signature by drawing, typing (script font), or uploading. */
export function SignatureDialog({ onCreate, onClose }: Props) {
  const [tab, setTab] = useState<Tab>("draw");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const dirty = useRef(false);
  const [typed, setTyped] = useState("");
  const [uploaded, setUploaded] = useState<{ dataUrl: string; w: number; h: number } | null>(null);
  const { sigs, save, remove } = useSignatures();
  // Off unless asked: a signature is a likeness of the user's hand, and
  // keeping it in the browser past this visit is their call, not a default.
  const [remember, setRemember] = useState(false);

  const ctx = () => canvasRef.current?.getContext("2d") ?? null;

  /** Keep it in the gallery if the user said so, then hand off for placement. */
  const commit = (sig: { dataUrl: string; w: number; h: number }) => {
    if (remember) save(sig);
    onCreate(sig);
  };

  const pos = (e: React.PointerEvent) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width) * PAD_W,
      y: ((e.clientY - r.top) / r.height) * PAD_H,
    };
  };
  const down = (e: React.PointerEvent) => {
    const c = ctx();
    if (!c) return;
    drawing.current = true;
    dirty.current = true;
    const p = pos(e);
    c.strokeStyle = "#111";
    c.lineWidth = 3;
    c.lineCap = "round";
    c.lineJoin = "round";
    c.beginPath();
    c.moveTo(p.x, p.y);
    canvasRef.current!.setPointerCapture(e.pointerId);
  };
  const move = (e: React.PointerEvent) => {
    if (!drawing.current) return;
    const c = ctx();
    if (!c) return;
    const p = pos(e);
    c.lineTo(p.x, p.y);
    c.stroke();
  };
  const up = () => (drawing.current = false);
  const clear = () => {
    ctx()?.clearRect(0, 0, PAD_W, PAD_H);
    dirty.current = false;
  };

  const insert = () => {
    if (tab === "draw") {
      if (!dirty.current) return;
      const trimmed = trimToInk(canvasRef.current!);
      if (trimmed) commit(trimmed);
    } else if (tab === "type") {
      if (!typed.trim()) return;
      const c = document.createElement("canvas");
      const g = c.getContext("2d")!;
      const font = '64px "Segoe Script", "Brush Script MT", "Snell Roundhand", cursive';
      g.font = font;
      const w = Math.ceil(g.measureText(typed).width) + 40;
      c.width = w;
      c.height = 110;
      const g2 = c.getContext("2d")!;
      g2.font = font;
      g2.fillStyle = "#111";
      g2.textBaseline = "middle";
      g2.fillText(typed, 20, 58);
      commit({ dataUrl: c.toDataURL("image/png"), w: c.width, h: c.height });
    } else if (uploaded) {
      commit(uploaded);
    }
  };

  const onUpload = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result);
      const img = new Image();
      img.onload = () => setUploaded({ dataUrl, w: img.naturalWidth, h: img.naturalHeight });
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
  };

  const canInsert = tab === "draw" || (tab === "type" && typed.trim()) || (tab === "upload" && uploaded);
  const modalRef = useModal<HTMLDivElement>(onClose);

  return (
    <div className="dialog-scrim" onPointerDown={scrimPress(onClose)}>
      <div
        ref={modalRef}
        tabIndex={-1}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Add signature"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="dialog__head">
          <h2 className="headline-small dialog__title">Add signature</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close" data-tip="Close">
            <Icon name="close" size={20} />
          </button>
        </div>

        {sigs.length > 0 && (
          <div className="sigsaved">
            <span className="field__label label-medium">Saved signatures</span>
            <div className="sigsaved__row">
              {sigs.map((s) => (
                <div key={s.dataUrl.slice(-24)} className="sigsaved__item">
                  <button
                    className="sigsaved__use"
                    onClick={() => onCreate(s)}
                    data-tip="Use this signature"
                    aria-label="Use saved signature"
                  >
                    <img src={s.dataUrl} alt="saved signature" />
                  </button>
                  <button
                    className="sigsaved__del"
                    onClick={() => remove(s.dataUrl)}
                    data-tip="Remove"
                    aria-label="Remove saved signature"
                  >
                    <Icon name="close" size={13} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="segmented dialog__tabs">
          {(["draw", "type", "upload"] as Tab[]).map((t) => (
            <button key={t} className={`segmented__btn${tab === t ? " segmented__btn--on" : ""}`} onClick={() => setTab(t)}>
              {t === "draw" ? "Draw" : t === "type" ? "Type" : "Upload"}
            </button>
          ))}
        </div>

        <div className="dialog__body">
          {tab === "draw" && (
            <div className="sigpad">
              <canvas
                ref={canvasRef}
                width={PAD_W}
                height={PAD_H}
                className="sigpad__canvas"
                onPointerDown={down}
                onPointerMove={move}
                onPointerUp={up}
                onPointerCancel={up}
              />
              <button className="btn sigpad__clear" onClick={clear}>Clear</button>
            </div>
          )}
          {tab === "type" && (
            <div className="sigtype">
              <input
                className="sigtype__input"
                placeholder="Type your name"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                autoFocus
              />
              <div className="sigtype__preview" aria-hidden>{typed || "Preview"}</div>
            </div>
          )}
          {tab === "upload" && (
            <div className="sigupload">
              {uploaded ? (
                <img src={uploaded.dataUrl} alt="preview" className="sigupload__img" />
              ) : (
                <label className="btn btn--tonal">
                  <Icon name="upload_file" size={16} /> Choose image
                  <input type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) onUpload(f); }} />
                </label>
              )}
            </div>
          )}
        </div>

        <label className="sigremember">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          <span>
            <span className="body-medium">Remember this signature on this device</span>
            <span className="sigremember__hint body-small">
              {remember
                ? "Kept in Saved signatures in this browser, never uploaded. Remove it there any time."
                : "Only in this document — and its session copy, if “Save session on this device” is on."}
            </span>
          </span>
        </label>

        <div className="dialog__actions">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn--filled" onClick={insert} disabled={!canInsert}>Add</button>
        </div>
      </div>
    </div>
  );
}
