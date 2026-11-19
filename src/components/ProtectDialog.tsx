import { useState } from "react";
import { useModal, scrimPress } from "../hooks/useModal";
import { Icon } from "./Icon";

interface Props {
  onDownload: (password: string) => void;
  onClose: () => void;
  /** A file is being made right now. */
  busy: boolean;
}

/**
 * "Download with password": a copy that needs a password to open, encrypted
 * with AES-256. The document here isn't changed, and the password is used for
 * that one file and never kept — so it's typed twice, because a mistyped one
 * locks the person out of their own copy for good.
 */
export function ProtectDialog({ onDownload, onClose, busy }: Props) {
  const ref = useModal<HTMLDivElement>(onClose);
  const [pw, setPw] = useState("");
  const [again, setAgain] = useState("");
  const [show, setShow] = useState(false);
  // "Don't match" waits until the second field is finished with (left, or
  // Download tried) — not on its first letter, which would be announced
  // mid-word and mark the field wrong while it's still being typed.
  // Typing in it again puts the check back to waiting.
  const [tried, setTried] = useState(false);
  const [againDone, setAgainDone] = useState(false);
  const mismatch = againDone && pw.length > 0 && pw !== again;
  const empty = tried && pw.length === 0;
  const error = empty ? "Type a password first." : mismatch ? "The two passwords don't match." : "";

  // Not a <form>, and no autofill hint that reads as a sign-up: browsers and
  // password managers offer to save what's typed into a submitted password
  // form, and this password is meant to be kept nowhere.
  const submit = () => {
    setTried(true);
    setAgainDone(true);
    if (busy || pw.length === 0 || pw !== again) return;
    onDownload(pw);
  };
  const onEnter = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submit();
    }
  };
  const noSave = { autoComplete: "off", "data-1p-ignore": "", "data-lpignore": "true", "data-form-type": "other" } as const;
  return (
    <div className="dialog-scrim" onPointerDown={scrimPress(onClose)}>
      <div
        ref={ref}
        tabIndex={-1}
        className="dialog dialog--sm"
        onPointerDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="protect-title"
      >
        <h2 className="headline-small dialog__title" id="protect-title">Download with password</h2>
        <div className="pwform">
          <p className="body-medium confirm__msg">
            The copy you download asks for this password before it opens. It isn't kept anywhere, so if it's lost, so
            is the copy. The document here stays as it is.
          </p>
          <label className="field">
            <span className="field__label label-medium">Password</span>
            <input
              className="sigtype__input"
              type={show ? "text" : "password"}
              {...noSave}
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              onKeyDown={onEnter}
              aria-invalid={empty || undefined}
              aria-describedby={empty ? "protect-error" : undefined}
              data-autofocus
            />
          </label>
          <label className="field">
            <span className="field__label label-medium">Type it again</span>
            <input
              className="sigtype__input"
              type={show ? "text" : "password"}
              {...noSave}
              value={again}
              onChange={(e) => {
                setAgain(e.target.value);
                setAgainDone(false);
              }}
              onBlur={() => again.length > 0 && setAgainDone(true)}
              onKeyDown={onEnter}
              aria-invalid={mismatch || undefined}
              aria-describedby={mismatch ? "protect-error" : undefined}
            />
          </label>
          <label className="sigremember">
            <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} />
            <span className="body-medium">Show password</span>
          </label>
          {/* Always mounted, so a change of text is what's announced. */}
          <p className="pwform__error body-small" id="protect-error" role="alert" hidden={!error}>
            {error}
          </p>
          <div className="dialog__actions">
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
            <button type="button" className="btn btn--filled" onClick={submit} disabled={busy}>
              <Icon name="protect" size={16} /> Download
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
