import { useRef, useState } from "react";
import { Icon } from "./Icon";

interface Props {
  onCreate: (sig: { dataUrl: string; w: number; h: number }) => void;
  onClose: () => void;
}

type Tab = "draw" | "type" | "upload";
const PAD_W = 560;
const PAD_H = 220;

/** Create a signature by drawing, typing (script font), or uploading. */
export function SignatureDialog({ onCreate, onClose }: Props) {
  const [tab, setTab] = useState<Tab>("draw");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const dirty = useRef(false);
  const [typed, setTyped] = useState("");
  const [uploaded, setUploaded] = useState<{ dataUrl: string; w: number; h: number } | null>(null);

  const ctx = () => canvasRef.current?.getContext("2d") ?? null;

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
      onCreate({ dataUrl: canvasRef.current!.toDataURL("image/png"), w: PAD_W, h: PAD_H });
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
      onCreate({ dataUrl: c.toDataURL("image/png"), w: c.width, h: c.height });
    } else if (uploaded) {
      onCreate(uploaded);
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

  return (
    <div className="dialog-scrim" onPointerDown={onClose}>
      <div className="dialog" onPointerDown={(e) => e.stopPropagation()}>
        <div className="dialog__head">
          <span className="title-large">Add signature</span>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="close" size={22} />
          </button>
        </div>

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
                  <Icon name="upload_file" size={18} /> Choose image
                  <input type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) onUpload(f); }} />
                </label>
              )}
            </div>
          )}
        </div>

        <div className="dialog__actions">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn--filled" onClick={insert} disabled={!canInsert}>Add</button>
        </div>
      </div>
    </div>
  );
}
