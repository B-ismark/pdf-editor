import type { FileHandle } from "./fileAccess";
import type { DocState, LoadedPdf } from "./pdf/types";
import type { HistorySnapshot } from "./hooks/useHistory";

/**
 * What the workspace shell and the document editor share: a document as the
 * workspace holds it, and the one channel status messages travel on.
 *
 * The split: `App` is the workspace — the open documents, opening and closing
 * them, the password prompt, restore, autosave, app-wide preferences and the
 * status line. `DocumentEditor` is one document — its history, view, tools,
 * selection, find, Inspector and dialogs — and is mounted fresh for each
 * document brought to the front (`key` = tab id + load generation), so nothing
 * per-document can leak from one file into the next.
 */

// "exporting" is reserved for the primary Download action (drives the Download
// button's label); "working" is every other long op (OCR, compress, watermark,
// page numbers, image export) so they show the busy indicator without hijacking
// the Download button.
export type Status = "idle" | "loading" | "ready" | "exporting" | "working" | "error";

export const isBusy = (s: Status) => s === "loading" || s === "exporting" || s === "working";

export const EMPTY_DOC: DocState = { edits: {}, textBoxes: [], redactions: [], annotations: [], stamps: [] };

/**
 * The state a document was in when it was last downloaded. The document is
 * saved while its live state *is* this one — the same object, since every edit
 * makes a new one — so an edit after downloading makes it unsaved again, and
 * undoing back to what was downloaded makes it saved again. Without this the
 * change counter survived a download, and the leave and close prompts warned
 * that changes already in the downloaded file would be lost.
 */
export interface SavedMark {
  doc: DocState;
  baked: number;
  /** Written back to the document's own file, rather than downloaded. */
  inPlace?: boolean;
}

/** A document open in the workspace. For the one in front, `history`, `view`,
 * `changeCount` and `unsaved` are stale — the editor holds the live values and
 * reports them ({@link LiveDoc}) — and are refreshed whenever it is parked.
 * `pdf`, `fileName`, `baked`, `saved` and `locked` are always current: only the
 * workspace changes them. */
export interface OpenDoc {
  id: string;
  fileName: string;
  pdf: LoadedPdf;
  /** Its whole undo history, or null for a document that was never edited. */
  history: HistorySnapshot<DocState> | null;
  /** Where it was scrolled to and zoomed, so coming back lands in place. */
  view: { zoom: number; ry: number } | null;
  changeCount: number;
  /** Changes already baked into `pdf.bytes` (an Organise, a merge) that the
   * doc state can't see. They still make the document unsaved work. */
  baked: number;
  /** What was last downloaded, if anything (see {@link SavedMark}). */
  saved: SavedMark | null;
  /** Opened with a password. Its unlocked copy is never stored on the device:
   * the user locked that file for a reason, and a plain copy in the browser's
   * storage would undo it. */
  locked: boolean;
  /** Has changes since its last download (or ever, if never downloaded). */
  unsaved: boolean;
  /** The file on the user's disk it was opened from (or last saved as), where
   * the browser lets the app write back to it. Held in memory only. */
  handle?: FileHandle;
  /** The file behind `handle` opens with a password, so saving over it
   * removes that — the user is asked first. Cleared once it's been written. */
  handleLocked?: boolean;
}

/** The document state a parked tab is at. */
export const parkedState = (t: OpenDoc): DocState => (t.history ? t.history.entries[t.history.index] : EMPTY_DOC);

/** What the editor in front reports up after every change: what the workspace
 * needs to autosave it, mark its tab and guard closing it. Tagged with the tab
 * it describes, so a report can never be read as another document's. */
export interface LiveDoc {
  id: string;
  doc: DocState;
  changeCount: number;
  unsaved: boolean;
}

/** What the workspace takes from the editor when the document goes into the
 * background: read synchronously, before the editor unmounts. */
export interface EditorHandle {
  park(): {
    /** The tab this editor is showing: a handle read across a switch can't
     * be mistaken for the next document's. */
    id: string;
    history: HistorySnapshot<DocState>;
    view: { zoom: number; ry: number };
    changeCount: number;
    unsaved: boolean;
  };
}

/** True when a modal dialog (Organize, Finish, Compress, Command Palette, the
 * password prompt, …) is open. Global shortcuts must not act on what's beneath
 * it, and nothing may open a document behind it. */
export function aModalIsOpen(): boolean {
  return !!document.querySelector('[aria-modal="true"]');
}

export const toAB = (u8: Uint8Array): ArrayBuffer => {
  const ab = new ArrayBuffer(u8.byteLength);
  new Uint8Array(ab).set(u8);
  return ab;
};
