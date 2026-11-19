import { useRef, useState } from "react";
import { staleBuildMessage } from "../staleBuild";
import { Icon } from "./Icon";
import { useModal, scrimPress } from "../hooks/useModal";
import type { SignIdentity, SignMeta } from "../pdf/sign";

interface Props {
  /** Bake + sign + download. Resolves on success, rejects with an Error whose
   *  message is safe to show. */
  onSign: (identity: SignIdentity, meta: SignMeta) => Promise<void>;
  onClose: () => void;
}

/** Collect a signing identity (a generated self-signed one, or an uploaded
 *  .p12) plus optional metadata, then hand off to sign the document. */
export function SignCertDialog({ onSign, onClose }: Props) {
  const [mode, setMode] = useState<"self" | "p12">("self");
  const [name, setName] = useState("");
  const [org, setOrg] = useState("");
  const [reason, setReason] = useState("");
  const [p12, setP12] = useState<{ data: Uint8Array; fileName: string } | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const modalRef = useModal<HTMLDivElement>(busy ? () => {} : onClose);

  const canSign = busy ? false : mode === "self" ? name.trim().length > 0 : !!p12;

  const submit = async () => {
    setError(null);
    const identity: SignIdentity =
      mode === "self"
        ? { kind: "self", name: name.trim(), org: org.trim() || undefined }
        : { kind: "p12", data: p12!.data, passphrase };
    const meta: SignMeta = { reason: reason.trim() || undefined };
    setBusy(true);
    try {
      await onSign(identity, meta);
      onClose();
    } catch (e) {
      setError(staleBuildMessage(e) ?? (e instanceof Error ? e.message : "Couldn't sign the document."));
      setBusy(false);
    }
  };

  return (
    <div className="dialog-scrim" onPointerDown={scrimPress(busy ? undefined : onClose)}>
      <div
        ref={modalRef}
        tabIndex={-1}
        className="dialog dialog--sm dialog__body--form"
        role="dialog"
        aria-modal="true"
        aria-label="Sign document"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="dialog__head">
          <h2 className="headline-small dialog__title">Sign document</h2>
          <button className="icon-btn" onClick={onClose} disabled={busy} aria-label="Close" data-tip="Close">
            <Icon name="close" size={20} />
          </button>
        </div>

        <div className="segmented" role="tablist" aria-label="Signing identity">
          <button
            role="tab"
            aria-selected={mode === "self"}
            className={`segmented__btn${mode === "self" ? " segmented__btn--on" : ""}`}
            onClick={() => setMode("self")}
            disabled={busy}
          >
            Create identity
          </button>
          <button
            role="tab"
            aria-selected={mode === "p12"}
            className={`segmented__btn${mode === "p12" ? " segmented__btn--on" : ""}`}
            onClick={() => setMode("p12")}
            disabled={busy}
          >
            Upload certificate
          </button>
        </div>

        {mode === "self" ? (
          <>
            <div className="field">
              <span className="field__label label-medium">Your name</span>
              <input className="sigtype__input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Ada Lovelace" data-autofocus disabled={busy} />
            </div>
            <div className="field">
              <span className="field__label label-medium">Organisation (optional)</span>
              <input className="sigtype__input" value={org} onChange={(e) => setOrg(e.target.value)} disabled={busy} />
            </div>
            <p className="confirm__msg body-small">
              Readers can check the file is unchanged since signing, but show a self-made
              identity as “not verified”.
            </p>
          </>
        ) : (
          <>
            <div className="field">
              <span className="field__label label-medium">Certificate (.p12 / .pfx)</span>
              <button className="btn" onClick={() => fileRef.current?.click()} disabled={busy}>
                <Icon name="note_add" size={16} /> {p12 ? p12.fileName : "Choose file…"}
              </button>
              <input
                ref={fileRef}
                type="file"
                accept=".p12,.pfx,application/x-pkcs12"
                hidden
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (f) setP12({ data: new Uint8Array(await f.arrayBuffer()), fileName: f.name });
                }}
              />
            </div>
            <div className="field">
              <span className="field__label label-medium">Passphrase</span>
              <input className="sigtype__input" type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} disabled={busy} />
            </div>
            <p className="confirm__msg body-small">
              The certificate and passphrase never leave this browser.
            </p>
          </>
        )}

        <div className="field">
          <span className="field__label label-medium">Reason (optional)</span>
          <input className="sigtype__input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. I approve this document" disabled={busy} />
        </div>

        {error && (
          <p className="organize__err body-small" role="alert">
            <Icon name="close" size={15} /> {error}
          </p>
        )}

        <div className="dialog__actions">
          <button className="btn btn--text" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn btn--filled" onClick={() => void submit()} disabled={!canSign}>
            {busy && <span className="spinner spinner--sm spinner--on-primary" aria-hidden="true" />}
            {busy ? "Signing…" : "Sign & download"}
          </button>
        </div>
      </div>
    </div>
  );
}
