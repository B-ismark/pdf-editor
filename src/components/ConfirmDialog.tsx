import { useModal } from "../hooks/useModal";

interface Props {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** A small custom confirmation modal (replaces the browser's confirm()). */
export function ConfirmDialog({
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  danger,
  onConfirm,
  onCancel,
}: Props) {
  const ref = useModal<HTMLDivElement>(onCancel);
  return (
    <div className="dialog-scrim" onPointerDown={onCancel}>
      <div
        ref={ref}
        tabIndex={-1}
        className="dialog dialog--sm"
        onPointerDown={(e) => e.stopPropagation()}
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
      >
        <span className="title-large">{title}</span>
        <p className="body-medium confirm__msg">{message}</p>
        <div className="dialog__actions">
          <button className="btn" onClick={onCancel}>{cancelLabel}</button>
          <button className={`btn ${danger ? "btn--danger" : "btn--filled"}`} onClick={onConfirm} autoFocus>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
