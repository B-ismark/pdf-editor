import { useEffect, useRef, useState } from "react";
import { useModal } from "../hooks/useModal";

interface Props {
  fileName: string;
  /** The last password tried didn't open it. */
  wrong: boolean;
  /** A password was sent and is being tried. */
  checking: boolean;
  onSubmit: (password: string) => void;
  onCancel: () => void;
}

/**
 * Asks for the password that opens a protected PDF. It's used once, to unlock
 * the file in this tab; it isn't kept, and the unlocked copy is what gets
 * edited and downloaded.
 */
export function PasswordDialog({ fileName, wrong, checking, onSubmit, onCancel }: Props) {
  const ref = useModal<HTMLDivElement>(onCancel);
  const [value, setValue] = useState("");
  const input = useRef<HTMLInputElement>(null);
  // A wrong try keeps the dialog: select what was typed so the next try
  // replaces it, as a sign-in form does.
  useEffect(() => {
    if (wrong && !checking) input.current?.select();
  }, [wrong, checking]);
  return (
    <div className="dialog-scrim" onPointerDown={onCancel}>
      <div
        ref={ref}
        tabIndex={-1}
        className="dialog dialog--sm"
        onPointerDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="pw-title"
      >
        <h2 className="headline-small dialog__title" id="pw-title">This PDF is password-protected</h2>
        <form
          className="pwform"
          onSubmit={(e) => {
            e.preventDefault();
            if (value && !checking) onSubmit(value);
          }}
        >
          <p className="body-medium confirm__msg">
            Enter the password for “{fileName}” to open it. It's used once, here in your browser, and isn't kept.
          </p>
          <label className="field">
            <span className="field__label label-medium">Password</span>
            <input
              ref={input}
              className="sigtype__input"
              type="password"
              autoComplete="off"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              aria-invalid={(wrong && !checking) || undefined}
              aria-describedby={wrong && !checking ? "pw-error" : undefined}
              autoFocus
            />
          </label>
          {wrong && !checking && (
            <p className="pwform__error body-small" id="pw-error" role="alert">
              That password didn't open it. Check it and try again.
            </p>
          )}
          <div className="dialog__actions">
            <button type="button" className="btn" onClick={onCancel}>Cancel</button>
            <button type="submit" className="btn btn--filled" disabled={!value || checking}>
              {checking ? "Checking…" : "Open"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
