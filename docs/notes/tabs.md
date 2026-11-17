# Workspace tabs and autosave

_Read before touching `openBytes`, `DocTabs`, parking/restoring documents, `resetDocUi`, `releaseDoc`, or autosave storage keys._

Moved verbatim from `CLAUDE.md`; the index there links here.

## Gotchas

- **Tabs: park, then unpark — and `openBytes` reads live state.**
  `openBytes` opens a *new tab* by default; `{ replace: true }` is only for the
  operations that rebuild the document in front (Organise, page numbers,
  watermark), whose output is the same document with its edits baked in. It is
  called in loops (several dropped files, a restored workspace), so it reads
  `activeId` / `tabs` / `parkActive` from the `liveTabs` ref *after* its await,
  never from its closure: a stale closure parked nothing, so a restored document
  went into the background counted as clean and autosave then deleted its copy.
  Anything per-document that isn't in `DocState` (selection, find, an armed
  tool, a pending stamp) must be cleared in `resetDocUi`, or an id from one file
  lands on another. Object ids come from one counter across the whole workspace,
  which is why a restore bumps it past *every* restored document's ids.
  Closing a tab calls `releaseDoc(bytes)` (`pdf/loader.ts`): the caches are
  WeakMaps, but the pdf.js *worker* keeps every document it opened until told
  to `destroy()` it. The per-document stores (`fontInfo`, `fragmentColors`,
  the parse cache) are keyed by the `ArrayBuffer`, so tabs never collide in them.
  **Autosave is one pair of keys per edited tab** (`doc:<id>` / `bytes:<id>`,
  tab order and the front tab stored *inside* the doc records, so a one-document
  session is still exactly two keys). A clean tab is never stored, and autosave
  only deletes slots it *owns* — a previous session the user said "Not now" to
  survives opening some other file. The pre-tabs `current` / `current-bytes`
  layout is still read once and migrated.
  Deletion is immediate where the user asked for it: closing a tab flushes the
  debounced save (and `pagehide` flushes any pending one), "Delete" on the
  restore prompt removes only the slots it offered, and a page whose slot was
  deleted by another window (BroadcastChannel `pdf-editor-autosave`) writes its
  live copy back. A session dismissed with "Not now" is deliberately kept until
  "Delete", so it is offered again alongside later work.
- **"Unsaved" means "not in a file the user has", not "changed since open".**
  `changeCount` counts edits since the document was opened; `unsaved` is
  `changeCount > 0` *and* the live state isn't the one last downloaded
  (`SavedMark`: the `DocState` object plus `baked`, compared by identity —
  every edit makes a new state object, and undo/redo hand back the very
  objects in the history, so undoing to what was downloaded is saved again).
  `unsaved` is what the leave prompt, the close-tab prompt, the tab's dot and
  the app-bar counter ("Downloaded") read; Organise's "you'll lose edits" and
  autosave still read `changeCount`, deliberately — a downloaded document is
  still work worth restoring after a crash. Every path that hands the user the
  whole document sets the mark (Download, Download all, Compress, certificate
  signing), taking the state *before* its first await so an edit made while
  the file builds isn't counted as downloaded. Export-as-images and Extract
  pages don't: neither is the document. The mark is per tab (`OpenDoc.saved`)
  and is cleared by anything that loads new bytes into the tab.
