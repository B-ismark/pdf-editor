import { useState } from "react";
import { Icon } from "./Icon";

interface Props {
  /** Edited documents whose copy on this device will bring them back. */
  kept: number;
  /** Edited documents with changes that exist nowhere but this page (autosave
   * off, or a password-opened file, which is never stored) and not downloaded. */
  atRisk: number;
  /** Open documents with nothing to bring back: they'll need opening again. */
  reopen: number;
  onReload: () => Promise<void>;
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/**
 * Shown once the app notices it was updated while this page was open — a part
 * of it (a dialog, the exporter) couldn't be fetched because the deploy
 * replaced it. Everything already loaded keeps working, so this is an offer,
 * not a wall: it says what a reload will and won't bring back, and the user
 * picks the moment.
 */
export function UpdateBanner({ kept, atRisk, reopen, onReload }: Props) {
  const [hidden, setHidden] = useState(false);
  const [reloading, setReloading] = useState(false);
  if (hidden) return null;

  const lines: string[] = [];
  if (atRisk > 0)
    lines.push(
      `${atRisk === 1 ? "One document has" : `${plural(atRisk, "document")} have`} changes that aren't stored on this device — download ${atRisk === 1 ? "it" : "them"} first if you can.`,
    );
  if (kept > 0) lines.push(`Your edits are saved on this device and come back after reloading.`);
  if (reopen > 0)
    lines.push(`${reopen === 1 ? "A file you haven't changed" : "Files you haven't changed"} will need opening again.`);
  if (lines.length === 0) lines.push("Reload to use the new version.");

  return (
    <div className="update-banner" role="alert">
      <span className="update-banner__icon">
        <Icon name="app_update" size={20} />
      </span>
      <div className="update-banner__text">
        <b className="title-small">PDF Editor was updated</b>
        <span className="body-small">
          Some parts can't open until you reload. {lines.join(" ")}
        </span>
      </div>
      <div className="update-banner__actions">
        <button
          className="btn btn--filled"
          disabled={reloading}
          onClick={async () => {
            setReloading(true);
            await onReload();
          }}
        >
          {reloading ? "Saving…" : "Reload"}
        </button>
        <button className="btn btn--text" onClick={() => setHidden(true)}>
          Not now
        </button>
      </div>
    </div>
  );
}
