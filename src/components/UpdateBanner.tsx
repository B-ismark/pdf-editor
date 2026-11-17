import { useState } from "react";
import { Icon } from "./Icon";
import type { LoadTrouble } from "../staleBuild";

interface Props {
  /** Why a part couldn't load: a newer build replaced it, or the connection. */
  kind: LoadTrouble;
  /** Edited documents whose copy on this device will bring them back. */
  kept: number;
  /** Edited documents with changes that exist nowhere but this page (autosave
   * off, or a password-opened file, which is never stored) and not downloaded. */
  atRisk: number;
  /** Edited documents that aren't stored here but were downloaded: the
   * download has the work; the tab itself won't come back. */
  downloaded: number;
  /** Open documents never edited: they'll need opening again. */
  reopen: number;
  /** Store what can be stored, then reload. Resolves `false` — without
   * reloading — when the copy couldn't be written. */
  onReload: (force: boolean) => Promise<boolean>;
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/**
 * Shown once a part of the app (a dialog, the exporter) couldn't be fetched —
 * because a deploy replaced it, or because the connection dropped.
 * Everything already loaded keeps working, so this is an offer, not a wall:
 * it says what a reload will and won't bring back, and the user picks the
 * moment.
 */
export function UpdateBanner({ kind, kept, atRisk, downloaded, reopen, onReload }: Props) {
  const [hidden, setHidden] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  if (hidden) return null;

  const lines: string[] = [];
  if (saveFailed)
    lines.push("Your latest edits couldn't be saved on this device — download them first, or reload anyway.");
  if (atRisk > 0)
    lines.push(
      `${atRisk === 1 ? "One document has" : `${plural(atRisk, "document")} have`} changes that aren't stored on this device — download ${atRisk === 1 ? "it" : "them"} first if you can.`,
    );
  if (kept > 0 && !saveFailed) lines.push(`Your edits are saved on this device and come back after reloading.`);
  if (downloaded > 0)
    lines.push(
      `${downloaded === 1 ? "A document you downloaded" : "Documents you downloaded"} will need opening again from the download.`,
    );
  if (reopen > 0)
    lines.push(`${reopen === 1 ? "A file you haven't changed" : "Files you haven't changed"} will need opening again.`);
  if (lines.length === 0) lines.push(kind === "updated" ? "Reload to use the new version." : "Reload to continue.");

  const lead =
    kind === "updated"
      ? "Some parts can't open until you reload."
      : "Check your connection — some parts can't open until you reload.";

  return (
    <div className="update-banner" role="alert">
      <span className="update-banner__icon">
        {kind === "updated" ? <Icon name="app_update" size={20} /> : <Icon name="offline" size={20} />}
      </span>
      <div className="update-banner__text">
        <b className="title-small">
          {kind === "updated" ? "PDF Editor was updated" : "Part of the editor couldn't load"}
        </b>
        <span className="body-small">
          {lead} {lines.join(" ")}
        </span>
      </div>
      <div className="update-banner__actions">
        <button
          className="btn btn--filled"
          disabled={reloading}
          onClick={async () => {
            setReloading(true);
            const going = await onReload(saveFailed);
            // Still here: the save failed, or the user stayed when the
            // browser asked about leaving. Either way the button works again.
            if (!going) setSaveFailed(true);
            setReloading(false);
          }}
        >
          {reloading ? "Saving…" : saveFailed ? "Reload anyway" : "Reload"}
        </button>
        <button className="btn btn--text" onClick={() => setHidden(true)}>
          Not now
        </button>
      </div>
    </div>
  );
}
