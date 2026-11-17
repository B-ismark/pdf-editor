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

## Editing on a turned page

- Align, distribute, paste and duplicate work in the page *as shown*:
  `userToShownBox` / `shownToUserDelta` (`pagePlan.ts`) convert the boxes and
  offsets, so "left" and "down-right" mean what the reader sees.
- The view refits when a turn changes the widest shown page, and rail
  thumbnails scale a quarter-turned canvas to fit their slot.
- The tick/cross preview ghost is drawn upright, as the placed mark is.
- An object on a deleted page can't stay selected, be pasted back, or be
  counted as a change: `shownBySource` gates selection, paste and the counts.

## Known limits

- OCR renders in user space. On a page whose own `/Rotate` turns sideways-scanned
  text upright, it reads sideways text: fewer words, never misplaced ones.
- Resize cursors on a turned page point the unturned way.
- Marquee hit-testing and the selection bbox of a *rotated text box* are
  approximate.
- A session saved before this change, with overlays on a `/Rotate` page, restores
  them in the old (shown-space) coordinates, so they shift.
