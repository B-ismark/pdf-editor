# Workspace tabs and autosave

_Read before touching `openBytes`, `DocTabs`, parking/restoring documents, the `App` / `DocumentEditor` split, `releaseDoc`, or autosave storage keys._

Moved verbatim from `CLAUDE.md`; the index there links here.

## Gotchas

- **Two components: the workspace and the document.** `App.tsx` is the
  workspace — the tab list, opening (`openBytes`, `unlock`, the password
  prompt), closing, restore, autosave, prefs, the status line and the start
  screen. `DocumentEditor.tsx` is the one document in front — its history,
  view, tools, selection, find, Inspector and dialogs. The shared types are in
  `workspace.ts`. The editor is mounted with `key={id + ":" + gen}`, and `gen`
  goes up every time a *new or rebuilt* document comes to the front (a new tab,
  a rebuild in place), so **an editor belongs to one document for its whole
  life**: nothing per-document can leak into the next file, and there is no
  reset list to keep up to date (the old `resetDocUi` / `showDoc`).
  - **The last document stays warm** (`warm`, `WARM = 2`). A switch keeps the
    editor it leaves mounted behind the new one, under React 19.2's
    `<Activity mode="hidden">`: its state, DOM and painted canvases stay, its
    effects (listeners, observers, the `useImperativeHandle` handle) are torn
    down, and a switch back reveals it in one frame instead of repainting
    every page. A third document pushes the oldest out; it comes back, as
    before, in a fresh editor seeded from its parked entry. Parking still
    happens on every switch-away, so `tabs` stays the truth for autosave,
    close and Download all — and nothing outside an editor changes a
    background document's `history`, which is all the editor seeds once.
  - **The one behind is off the page, not just hidden.** Each editor renders
    through a portal into a box of its own (`hosts` in `App.tsx`) and only the
    front one's box is attached, by `EditorSlot`. Merely hidden, its tab strip,
    tool dock, pages and ids were all still in the document: every
    `document.querySelector` in the app (and every test locator) could meet
    the hidden copy first. `EditorSlot` comes before the editors so its layout
    effect attaches the box before theirs run.
  - **Reveal re-runs every effect, mount-only ones included**, with the state
    it left with. Anything an effect *hands on* must not repeat a stale value:
    the editor only writes the fit to `fitRef` when it changes, and on reveal
    `useViewport` takes the workspace's fit (the window may have been resized,
    or the panel hidden, meanwhile). Re-announcing the old fit first left a
    document that waited through a resize 280 px too wide.
    Likewise `PageView` skips a paint when the canvas already holds that page
    at that scale (`paintedAs`) — re-rendering blanks it first, the white flash
    warm editors exist to avoid. **Hiding is also an ending:** the editor
    gives back a phone selection's Back entry (its listener goes; Back in the
    next document must not pop it) and drops `autoFocusId` (a box typed into
    would take focus back from the tab strip), and `useHistory` ends the
    gesture so typing either side of a switch is two undo steps.
  - **Who owns what.** For the tab in front, `tabs` stays the truth for `pdf`,
    `fileName`, `baked`, `saved` and `locked` (only the workspace changes
    them). Its `history`, `view`, `changeCount` and `unsaved` are stale while it
    is in front: the editor reports them through `onLive` (a `LiveDoc` tagged
    with the tab id, so a late report is never read as another tab's) and
    hands them over through its `park()` handle, read synchronously before it
    unmounts.
  - **The editor is `memo`'d, and the workspace re-renders on every edit it
    reports.** Everything passed down must keep its identity: callbacks are
    `useCallback` or `useStable`, and objects (the theme) are memoised. A new
    prop identity per render re-renders every page of the document per
    keystroke.
  - Seeding: `useHistory(initial, limit, from)` resumes a parked history; the
    editor calls `restoreView(entry.view)` once on mount, after it sets the page
    width.
  - **What a fresh editor must not re-learn: the fit and the focus.** The
    fit-to-width measurement belongs to the workspace (the old single shell
    measured it once), so the shell holds it in `fitRef` and each editor seeds
    `useViewport(seed)` from it and keeps it current. Measured afresh, a
    switch drew one frame at the unmeasured scale, restored the scroll position
    against that height (half-way down came back a third of the way down), and
    re-fitted a page the user had left at its size by hiding the panel. The tab
    strip remounts with the editor too, so `DocTabs` carries keyboard focus
    across the remount (`carry`): without it, Delete and the arrow keys dropped
    focus to `<body>`. And anything the shell decides *at a moment* (the
    `beforeunload` guard) asks the editor through its handle rather than reading
    the last `onLive` report, which lands a render late.
- **Tabs: park, then unpark — and `openBytes` reads live state.**
  `openBytes` opens a *new tab* by default; `{ replace: true }` is only for the
  operations that rebuild the document in front (Organise, page numbers,
  watermark), whose output is the same document with its edits baked in. It is
  called in loops (several dropped files, a restored workspace), so it reads
  `activeId` / `tabs` from the `liveTabs` ref *after* its await, never from its
  closure: a stale closure parked nothing, so a restored document went into the
  background counted as clean and autosave then deleted its copy. It parks the
  front editor (`parkActive`) right then, outside any state updater, and
  `park()` carries the tab id so a handle from the wrong editor is ignored.
  Object ids come from one counter across the whole workspace,
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
  `unsaved` is what the tab's dot and the app-bar counter ("Downloaded")
  read. **A download can't be confirmed** — the page only clicks a link, and a
  cancelled "Save as…" looks identical — so downloaded work is never let go
  silently: closing it still asks, as a plain "Close" with the honest caveat
  rather than "Discard & close", and the leave prompt stays off only while the
  session copy holds the work (autosave on, not a password-opened document).
  The rest of the app reads `unsaved` the same way; Organise's "you'll lose edits" and
  autosave still read `changeCount`, deliberately — a downloaded document is
  still work worth restoring after a crash. Every path that hands the user the
  whole document sets the mark (Download, Download all, Compress, certificate
  signing), taking the state *before* its first await so an edit made while
  the file builds isn't counted as downloaded. Export-as-images and Extract
  pages don't: neither is the document. The mark is per tab (`OpenDoc.saved`)
  and is cleared by anything that loads new bytes into the tab.
