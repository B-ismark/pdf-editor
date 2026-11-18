# Pages: the plan, turned pages, deletion

_Read before touching `pdf/pagePlan.ts`, `DocState.pages`, Organise's apply,
anything that walks pages in order, or anything that maps a pointer onto a page._

## The model

- **Overlay objects keep their source page index.** `DocState.pages` is the plan:
  `PageRef[]` (`{ index, rotate }`, source page plus the extra turn the user
  added), in shown order. Absent means every page as loaded. Reordering, turning
  and deleting change only the plan, so markup follows its page and undo puts the
  pages back. A source page appears at most once: Organise has no duplicate for
  own pages. `resolvePlan` falls back to identity for a plan that doesn't fit the
  file (a session restored against a different document).
- **Two ways to walk pages.** Anything that goes through pages *in order* (the
  viewer, the rail, find, page numbers, copy/export text, compress, export
  progress) walks `shown` (`shownPages(pdf.pages, plan)`). Anything that looks a
  page *up* by an object's `pageIndex` still uses `pdf.pages` or
  `shownBySource`. `data-page-pos` on `.page` is the shown position;
  `useActivePage` and `scrollToPage` count positions, never source indices.
- **Everything is stored in user space.** `PageData.viewBox` is the unrotated
  page; `PageData.rotation` is its own `/Rotate`, and a *shown* page
  (`turnPage`) carries the total turn, own plus plan. Find results, redactions,
  text boxes and marks are all stored unturned, which is what the exporter
  draws on.

## Showing a turned page

- The canvas is rendered by pdf.js at the total turn. The overlay is laid out
  unturned, centred in the slot, and CSS-rotated (`data-rotation` on it); the
  slot swaps width and height for a quarter turn (`shownSize`).
- **Pointer maths goes through `toLocal`** (`hooks/useDrag.ts`), which
  inverse-rotates about the element's centre using `offsetWidth`/`offsetHeight`.
  `getBoundingClientRect()` arithmetic is wrong on a turned page: its box is the
  rotated bounding box. `startPointerDrag` unturns deltas for the same reason;
  the rotate handle opts out with `screen: true`, since it wants screen angles.
  Arrow-key nudges go through `shownToUserDelta`.
- **New objects read upright.** A text box, note, stamp or tapped mark made on a
  page turned by R gets `rotation: uprightFor(R)`; drag-sized boxes swap width
  and height about their centre (`uprightBox` in `PageView`).
- **Colour sampling refuses a turned raster** and reads its own unturned render
  instead (`readPageColors`), so preview and export sample the same pixels.
- Page-number and watermark previews stay in user space, as the export draws
  them.

## The Pages sidebar

- `PageNav` (the left sidebar) edits the plan live: move (drag, Alt+↑/↓), turn
  and delete, through the pure helpers `movePages` / `turnPages` / `dropPages`
  in `pagePlan.ts` and the editor's `applyPlan`, the one path the grid
  (Organise) uses too. One action, one undo step; nothing is stored when the
  plan comes out the same (`samePlan`).
- **Pages are picked by source index**, not position, so a move keeps the
  selection and an undo that takes a page away just drops it from the set.
- A drop gap counts positions *before* the move (`movePages`), which is what
  the bar drawn between two thumbnails means.
- `dropPages` never empties the plan; the sidebar disables Delete when every
  page is picked.
- Touch: a swipe scrolls; press and hold (400ms) picks a page, and moving after
  the hold drags it. A non-passive `touchmove` stops the list scrolling under a
  held page. The click the browser sends after a drag or a hold is swallowed by
  page and time, not for one tick: a touch click can arrive well after
  `pointerup`.
- The grid view is Organise, opened from the sidebar header. Merge and Extract
  live there: they make a different file rather than change this one.
- **Focus and keys.** Canvas objects take pointer presses without moving focus,
  so the sidebar blurs its own focus on any `pointerdown` outside it; otherwise
  Delete meant for a selected box would delete a picked page. Delete/Backspace
  act only on *picked* pages, never on a row that merely has focus. Refocusing a
  row after an action is a counter (`refocus()`), not a flag: a flag set by a
  key that changed nothing lingered and stole focus on a later render.
- **A drag reads the present, not the press.** The drop uses `live.current`
  (this render's `move` and selection). A plan change mid-drag (Ctrl+Z) calls the
  drag off; so do Escape and letting go off the list (`gapAt` returns null).
- Picks are pruned when an undo/redo removes their page, so they don't come back
  pre-selected. The "N pages selected" live region is always mounted, so the
  first count is announced.
- **Find**: the active match is held by hit id, not list slot, so a reorder
  keeps it on the same hit; and the view scrolls only when the active hit
  *changes*. Before, any rebuild of the match list (a sidebar action, or just
  text arriving for newly rendered pages) threw the view back to it.

## Export

- `exportPdf` takes `pages`. It draws on every kept source page in user space,
  sets each page's `/Rotate` to own + plan, and puts the pages in plan order with
  one rewrite of the flat page tree (`setPageList` in `pageTree.ts`).
- **Never `removePage`/`insertPage` to rearrange.** The fork's `removePage`
  deletes the page *object* as well as its slot. A page moved that way is gone,
  and a removed page can no longer be read to find the widgets and comment
  threads that must go with it. `setPageList` resets pdf-lib's page cache
  directly (no public API does it without deleting) and then verifies, so a
  change in the library fails the export instead of shipping the wrong pages.
  The raster page is created with `PDFPage.create` and swapped in by the same
  rewrite.
- **A deleted page is cut, not just unlisted** (`cutDeletedPages`): bookmarks
  that open it go (their children move up a level), links on kept pages that
  jump to it go, every other reference becomes null, its fields and comment
  threads are pruned, and the structure tree is dropped, all before
  `collectGarbage`. `pages.spec` counts `/Page` objects in the file.
- **Organise**: a plan of only this document's pages is applied as
  `doc.set({ pages })`: no confirm, undoable, edits kept. A plan with another
  document's pages (a merge) still rebuilds the file, and so does Extract.
  Both start from this document *as shown* (`bakeMain` exports it with the
  plan, so edits, redactions and turns are drawn in), and `mainAsShown` in
  `Organize.tsx` remaps Organise's source indices and turns onto those baked
  pages. Extract must never hand back the raw original: a redacted page would
  come back unredacted. The bake runs the same whiteout-over-text guard as
  Download. Page numbers and the watermark are not drawn in by a merge; they
  carry over to the new document as live settings, so they number the merged
  file in its new order.
- **`buildFromPlan` cuts strays too.** `copyPages` follows a link annotation's
  `/Dest` into a page that isn't in the plan and copies it along, outside the
  page tree. Any `/Type /Page` not in the tree is cut and garbage-collected.
- **Page labels follow their pages.** When the plan isn't the identity,
  `remapPageLabels` (`structure.ts`) rewrites `/PageLabels` one range per kept
  page, with the start number advanced to where that page sat in its range.

## Inserting and splitting (Organise)

- **New pages go after the last picked page, else after the pages added
  last, else at the end** (`insertAt` in `Organize.tsx`). Inserting picks
  **nothing**: a pick changes what Extract does and Split's default mode, so
  the "follow the last insert" point is its own state (`after`), dropped as
  soon as a page is picked, moved, turned or deleted. The hint line says where
  the next insert goes.
- **The grid is `inert` while anything is being added or split** (set by
  hand in a layout effect — React 18 doesn't know the attribute — so it lands
  in the same commit as the busy label). The insert point was worked out from
  the plan before the await; a delete or move during it would make it point
  somewhere else.
- **Adding several files is all or nothing**: every file is read, sniffed and
  counted first (`prepare`), then all go in in one `insert`. A file that
  can't be added is named, and nothing is added.
- **Everything inserted is a source of its own**: another PDF, a run of
  pictures (one `imagesToPdf` document per run of consecutive pictures in the
  pick), or a blank page (`blankPage`, sized by `shownPageSize` like the page
  before the insert point, as shown — so beside a turned page it's the turned
  shape, with no `/Rotate` of its own). So inserting makes the plan "not own
  pages only" and Apply **rebuilds** the document, as a merge does (with the
  same confirm when there are edits). A blank page doesn't yet join the live,
  undoable plan: `PageRef` only names source pages.
- **Split** (`SplitDialog`) cuts the plan as Organise shows it, unapplied
  changes and inserts included, as Extract does: every N pages, or a new part
  at each picked page. It bakes this document once (`mainAsShown(plan, true)`,
  page numbers and watermark drawn in) and builds each part from the baked
  entries — never from the original bytes, which would hand back redacted
  text. The parts go out as one stored ZIP, named `<file>-pages-<a>-<b>.pdf`
  (names flagged UTF-8, general-purpose bit 11).
- **Extract and Split are downloads, so they get the exporter's scrub**:
  `buildFromPlan(…, { forDownload: true })` runs `sanitizeDocument` and
  collects garbage. Without edits, `mainAsShown` hands back the *original*
  bytes, so page `/AA` scripts, launch links, attachments and page XMP would
  otherwise ride along. `buildFromPlan` never stamps a pdf-lib producer.
- **The Split dialog can't be dismissed while it splits** (Escape, scrim and
  Cancel are off): closing it would hide the work without stopping it.
- **Split from the Export menu** opens Organise with `startWithSplit`, and
  opens the dialog one commit *after* Organise mounts: mounted together, the
  child's `useModal` would register first and Organise's focus trap would sit
  on top of it. Leaving
  the dialog (Cancel or after the download) closes Organise too, back to the
  page. Opened from inside Organise, it returns to the grid.

## Pictures to PDF

- `openFiles` (App) sniffs each pick's first bytes (`sniffImage`): pictures
  picked together become **one** PDF in pick order (`openImages`), PDFs open
  in tabs of their own. The new document opens with `baked: 1` — it exists
  nowhere else, so it is unsaved work (dot, close asks, autosave keeps it).
- `cleanJpeg` drops every APPn segment but APP0 and APP14 (Adobe — a CMYK
  JPEG reads inverted without it), plus comments — before the picture and
  between progressive scans. APP0 is kept only when it's JFIF, rewritten with
  no thumbnail; JFXX goes. It **stops at the end marker**: phones append a
  second picture with its own EXIF (MPF, Ultra HDR gain maps) or a motion
  photo's video after it. Scan data is copied untouched: no re-encode, no loss. It reads the EXIF orientation on the
  way through; the page then draws the picture upright with `orientMatrix`
  (all eight orientations, mirrors included), and swaps the page's sides for
  5–8. Stripping the tag is also what keeps a viewer that honours EXIF from
  turning it twice.
- PNGs are decoded and re-deflated by pdf-lib: pixels only, no text chunks.
- Page size: 96 per inch, capped so the long side is at most 842 pt
  (`pageSizeFor`). The document is created with `updateMetadata: false`: no
  producer, no dates.
- pdf-lib stays off the render path: `images.ts` (sniffing, the JPEG pass,
  the maths) has no pdf-lib import; `imagesToPdf.ts` does and is imported
  lazily by App, statically only by the already-lazy Organise.

## Editing on a turned page

- Align, distribute, paste and duplicate work in the page *as shown*:
  `userToShownBox` / `shownToUserDelta` (`pagePlan.ts`) convert the boxes and
  offsets, so "left" and "down-right" mean what the reader sees.
- The view refits when a turn changes the widest shown page, and rail
  thumbnails scale a quarter-turned canvas to fit their slot.
- The tick/cross preview ghost is drawn upright, as the placed mark is.
- An object on a deleted page can't stay selected, be pasted back, or be
  counted as a change: `shownBySource` gates selection, paste and the counts.

## View space and the view origin

- A page's visible box (pdf.js `page.view`, CropBox ∩ MediaBox) need not start
  at the user-space origin. `loadPdf` moves every fragment transform and form
  widget rect by minus its corner, once, and records it as `PageData.origin`;
  so the whole app — overlays, pointer maths, clamps, colour sampling, OCR —
  works in *view space*, origin 0,0, and none of it needs to know.
- The exporter adds the origin back on vector pages: one `q 1 0 0 1 ox oy cm`
  around everything it draws, and explicitly for link `/Rect`s and the page
  number / watermark frame. A raster page *is* the view at 0,0, so it adds
  nothing. Anything new that reads coordinates out of pdf.js (a new
  `getTextContent` / `getAnnotations` consumer) must shift the same way.
- Guarded by `crop.spec` (heading overlay on its glyphs; an edit and a link
  land at the same user-space place in the download).

## Crop

- A crop is `PageRef.crop` — a rect in the page's *view space*, unturned — so
  it's an ordinary undoable plan edit, counted as a change, carried by reorder
  and turn (`turnPages` spreads the ref; `applyPlan` and Organise's own-pages
  apply keep it). `fitCrop` holds it inside the view and at least `MIN_CROP`
  a side, and returns `undefined` for "the whole page", so an uncropped page
  stores nothing. `samePlan` compares crops.
- Shown pages carry `crop` (`turnPage`, cached per turn+crop). `shownSize` is
  the crop turned; `sheetSize` is the whole page turned; `cropOffset` is where
  the crop's top-left sits on the turned sheet. `PageView` makes the slot the
  crop window (`.page[data-cropped]` clips) and moves `.page__sheet` — canvas
  and overlay — by `-cropOffset`, so every overlay coordinate, `toLocal` and
  the turn are unchanged. `FinishPreview` is laid against the crop, as the
  exporter places page numbers and the watermark.
- Export sets the page's CropBox (view + origin on vector pages, as-is on a
  raster) — the edges stay in the file; README says to Redact to remove. A
  cropped document always has changes, so Organise's rebuild, Split and
  Extract go through the baked copy, which has the CropBox; `mainAsShown`
  drops the crop from main entries for that reason.
- Thumbnails (rail and Organise) render the page as the file turns it and cut
  the crop out (`cutToCrop`). The Crop dialog works in margins from the sides
  *as shown* (`marginsOf` / `cropFromMargins`), which is what lets "All pages"
  apply one set of margins to pages of any size or turn.

## Known limits

- OCR renders in user space. On a page whose own `/Rotate` turns sideways-scanned
  text upright, it reads sideways text: fewer words, never misplaced ones.
- Resize cursors on a turned page point the unturned way.
- Marquee hit-testing and the selection bbox of a *rotated text box* are
  approximate.
- New objects are placed and clamped against the whole page, not the crop, so
  one can land partly in the hidden edge, its resize handle with it (move it
  in by its move grip, or undo; whatever stays outside ships hidden).
- A session saved before the view-origin fix, with overlays on a page whose view
  doesn't start at 0,0, restores them shifted by that corner.
- A session saved before this change, with overlays on a `/Rotate` page, restores
  them in the old (shown-space) coordinates, so they shift.
