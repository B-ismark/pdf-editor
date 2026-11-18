# Roadmap

The work plan from the November 2026 audit. The full findings are in `docs/audit/`:

- `UX-WALKTHROUGH.md`: a journey-by-journey UX review with severities. The screenshots it cites were not kept.
- `TECH-PERFORMANCE.md`: measurements, performance findings and technology choices.
- `PRODUCT-IA.md`: the feature inventory, competitor gaps, an IA proposal, and the multi-document design.

Read only the section a package points at, not the whole folder.

**Already done:** multi-document tabs (`claude/funny-cray-p09xj4`). That closes:

- UX #2: a second PDF erased the first one's session.
- Tech 2.2: closed documents were never destroyed. Done partly: `releaseDoc` is called on tab close.
- The single autosave slot (tech 2.8, partly).

## How to work through it

- **One package = one session = one branch = one PR.** Keep each PR reviewable.
- **Read narrowly.** Open the audit section named in the package, and only the files it touches.
- **Test narrowly while iterating.** Build first, because the suite serves `dist/`, then run the one relevant spec. Run the full `npm test` once before committing.
- **Screenshots only for packages that change something visible.**
- **When a package is done:**
  - tick it here;
  - add a spec for any invariant it creates;
  - add a note to the matching `docs/notes/<area>.md` only if a future session would otherwise get it wrong.
- **Order.**
  - 0 comes first.
  - 1 only touches export files, so it can run alongside 2–4.
  - 2, 3 and 4 all edit `App.tsx`, so run them one after another.
  - 5 must come before 6, and 6 before 7 and 8.
  - 9 can come any time after 5.

## Packages

- [x] **0. Housekeeping** (S). Done: `CLAUDE.md` is an index; the per-area notes are in `docs/notes/`.
  - Slim `CLAUDE.md` into a short index (commands, architecture, the rules every session needs).
  - Move the long per-area gotchas into `docs/notes/<area>.md`, each linked from the index with a one-line "read this before touching X".
  - Lose no content; only move it.
- [x] **1. Export you can trust** (M). Done in PR #45, after two adversarial reviews; limits accepted are listed there and in `docs/notes/privacy-and-export.md`. Files: `pdf/find.ts`, `pdf/exporter.ts`, `pdf/pageOps.ts`, `tests/export.spec.ts`.
  - **Search redaction leaks text.** Boxes are sized by character count and land about 2 characters right, so the leading characters survive in the export. Measure the boxes, and pad them. (UX #1, PRODUCT I-2)
  - **Document structure is dropped.** Keep outlines, page labels, the structure tree with `/Lang`, named destinations, optional-content config and `/AcroForm` on export, and keep internal links pointing at the right pages. (PRODUCT I-1)
  - **Shared resources are duplicated.** Batch `copyPages` so fonts and images are copied once per file, not once per page, and add a size spec. (TECH 2.1)
  - **Export sleeps per page.** Remove the ~4 ms per-page sleep in the export loop. (TECH 2.6)
- [x] **2. Fast on long documents** (S–M). (TECH 2.3, 2.4) Done: one page re-renders per keystroke instead of all of them; the first frame and the page rail stay windowed. Guarded by `rendering.spec.ts`; notes in `docs/notes/rendering.md`.
  - The `PageView` memo is defeated on every keystroke and selection. Make the `doc` callbacks stable and pass per-page edits and selection as props.
  - `useRenderWindow` starts every element as "near". Fix the initial state and make thumbnail renders cancellable.
- [x] **3. Phone and canvas fixes** (M). (UX #3, #4, #7, #9 and the P1 a11y list) Done: guarded by `placement`, `edge`, `keyboard` and `phone` specs; notes in `docs/notes/canvas-tools.md` and `shell.md`.
  - Phone: the zoom pill covers the first ⋯ menu item.
  - Phone: the drawbar overflows (471px of content in 366px).
  - A signature can't be placed on text. Add a ghost preview while placing.
  - Text, edits and stamps can run past the page edge. Clamp them or warn.
  - The phone Download button has no accessible name.
  - Tab visits every fragment before it reaches the chrome.
  - Add a page indicator with go-to-page.
- [x] **4. Saved means saved** (S–M). (UX #6, #8, #10) Done: guarded by `saved` and `password` specs (and `tabs` for discard); notes in `docs/notes/tabs.md`, `privacy-and-export.md`, `shell.md`. `@cantoo/pdf-lib` is in, used only to decrypt at open — package 5's swap can build on it.
  - Add a real "saved" state after download.
  - "Discard & close" must erase the stored session. (Already true from the tabs work: `tabs.spec` "a discarded document is gone from the device at once".)
  - Add a password prompt on open (pdf.js `onPassword`).
  - Ask for consent before storing signatures.
- [x] **5. Foundation** (L). (TECH §4, PRODUCT §3.3) Done: guarded by the `pages` spec (and `sign` for the engine swap); notes in `docs/notes/pages.md`. The shell split moved to package 6, where the layout work needs it.
  - Add a page plan to `DocState`, so page operations stop discarding edits. Turned pages are edited properly: markup turns with the page, and `/Rotate` pages place overlays correctly.
  - Swap pdf-lib for `@cantoo/pdf-lib`.
- [x] **6. New layout** (L, 2–3 sessions). (PRODUCT §3.2) Done.
  - [x] First: split the `App.tsx` workspace shell from a per-document `DocumentEditor` (moved from package 5). Notes in `docs/notes/tabs.md`.
  - [x] A Pages sidebar replaces the rail, with live, undoable page operations (move, turn, delete). Organise becomes its grid view, opened from the sidebar. Guarded by the `sidebar` spec.
  - [x] Download becomes an Export split button that holds every "produce a file" action. Guarded by `shell.spec` ("Export split button"); notes in `docs/notes/shell.md`.
  - [x] The Inspector becomes properties only, showing document settings when nothing is selected. Guarded by `shell.spec` ("inspector"); notes in `docs/notes/shell.md`.
  - [x] The command palette is generated from one command registry, which the ⋯ and Export menus render from too. Guarded by `shell.spec` ("command registry"); notes in `docs/notes/shell.md`.
- [ ] **7. Privacy features** (M). (PRODUCT §2.1)
  - Pattern redaction with a review list.
  - A "Remove hidden information" report.
  - Encrypt and decrypt on export (`@cantoo/pdf-lib` or qpdf-wasm, lazy-loaded and self-hosted).
- [ ] **8. Page tools** (M ×2). (PRODUCT §2.1)
  - Split, Images → PDF, Crop, insert a page at a position.
  - Print, Share, Save in place.
  - Complete forms, with a keep-fillable/flatten choice.
  - Outline sidebar; links to a page.
  - Header/footer tokens and Bates numbering.
  - Compare two documents.
- [ ] **9. Engine upgrades** (M). (TECH 2.5, 2.7, §3)
  - Background text extraction.
  - Raster and image encoding in a Worker.
  - React 19.2, using `<Activity>` for background tabs.
  - pdf.js 5, Vite 7.
