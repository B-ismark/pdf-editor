# PDF Editor: UI/UX audit (committed HEAD)

**Build audited:** `git archive HEAD`, built and served from the scratchpad on :4174. It was isolated from a concurrent session that is editing `src/` and adding `DocTabs.tsx`.

**How it was driven:** Playwright with Chromium 1243.
- Viewports: desktop 1280×820 and phone 390×844 (isMobile, hasTouch).
- Themes: light and dark.
- Screenshots: taken at DSF 1, in `scratchpad/ux/`.

**Flows covered:**
- open, error files, text edit, add text, draw (all sub-tools), select and marquee;
- sign, redact, whiteout, find and redact-all, download;
- organize and merge, page numbers, watermark, compress, export images;
- OCR, forms, links, command palette, keyboard, zoom, page rail;
- autosave and restore, close, opening a second PDF.

**Console:** no `pageerror` events and no off-origin requests. The only failed request was `requestfailed tessdata/eng.traineddata.gz net::ERR_ABORTED` during OCR, which is benign (tesseract retries and OCR succeeds).

Items already fixed in `docs/UI-UX-AUDIT.md` Parts 1–3 are not repeated here.

---

## Top 10

| # | Sev | Finding | Shots |
|---|-----|---------|-------|
| 1 | P0 | Search-and-redact boxes sit about 2 characters to the right of the match. The leading characters ("Ac", "41") survive into the exported, rasterised file. | 47, 48, 50, 54, 56 |
| 2 | P0 | Opening a second PDF with unsaved edits erases the autosaved session permanently. The confirm offers no "Download first" option, and still says "discards" after the user has already downloaded. | 55, 88, 89 |
| 3 | P0 | Phone: the zoom pill sits above the ⋯ overflow menu and swallows taps on its first item, "Organise pages". | 29 |
| 4 | P0 | Placing a signature fails when the click lands on text: the text fragment is selected and nothing is placed. Only blank margins accept the signature, and there is no ghost preview. | 37, 38, 42 |
| 5 | P1 | Organize "Apply" discards every edit, annotation and redaction, with no undo. | 60, 61 |
| 6 | P1 | "Discard & close" does not discard. The session is still restorable after a reload, so the copy is false in the privacy-sensitive direction. | 87, 90, 100 |
| 7 | P1 | Phone draw toolbar overflows (471px content in 366px). Note, the colour swatch and the collapse handle sit off-screen with no scroll affordance. | 25, 31 |
| 8 | P1 | There is never a "saved" state. The change counter survives a download, so the leave and discard prompts keep firing forever. | 53 |
| 9 | P1 | Edited text and placed signatures run past the page edge with no wrap, clamp or warning. The viewport then scrolls sideways and hides the page's left side. | 06, 07, 43 |
| 10 | P1 | Encrypted PDFs are rejected outright; there is no password prompt. | 84-err-encrypted |

Also P1: the phone Download button has no accessible name; Tab visits all ~25 text fragments per page before reaching the chrome; there is no page indicator or go-to-page; signatures are stored in localStorage without consent.

---

## 1. Opening, empty state, errors

**P1: Encrypted PDF rejected (84-err-encrypted)**
- **Observed:** opening the file shows "This PDF is password-protected or encrypted, so it can't be opened here."
  - The owner-password-only file opens fine (84-err-owner-locked).
- **Why it hurts:** a user-password PDF is a common case (bank statements, HR forms), and the user gets a dead end.
- **Redesign:**
  - Catch pdf.js `PasswordException` and show an in-app password dialog with a "Wrong password" retry state.
  - The README limitation (no encrypting on export) can stay, but say on export that the result will be unencrypted.

**P2: Load status message is jargon and covers the page (02-open-*)**
- **Observed:** a snackbar reading "12 pages · 300 text fragments" sits mid-viewport over the page for about 4.7s.
- **Why it hurts:** "Text fragments" is an internal term. The message covers the content the user is trying to read and tells them nothing actionable.
- **Redesign:**
  - Say "12 pages · click any text to edit it". Show it once per session, anchored to the bottom.
  - For scans, say instead "No selectable text: run text recognition?" (see section 9).

**P2: Filename not shown anywhere**
- **Observed:** the app bar shows only the brand.
- **Why it hurts:** once there are several files, or after a restore, the user cannot tell which document is open.
- **Redesign:** show the filename (truncated, with the full name in a tooltip) next to the brand, and update `document.title`.

**P2: Phone empty state says "or drag & drop" (01-empty-phone-*)**
- **Why it hurts:** dragging a file is not possible on a phone.
- **Redesign:** hide that phrase under `(pointer: coarse)`.
- The empty state also has no "what can I do here" content. Add three feature chips (Edit text · Sign · Redact) and a "Try a sample" link.

**Error files (fake, corrupt, garbled):** clear, human messages. Good.

---

## 2. Editing existing text

**P1: Overflowing edits (06, 07)**
- **Observed:** typing past the line end extends the overlay beyond the page's right edge. The scroll surface becomes horizontally scrollable and shifts, so the page's left margin is cut off.
- **Why it hurts:** the user loses their place. The exported file also has text running off the page, and nothing warns about it.
- **Redesign:**
  - Show a soft right-edge guide while editing.
  - When the fragment exceeds its original width by more than about 5%, show an inline chip: "Text runs past the margin. Shrink to fit / Wrap / Keep".
  - Never let an overlay widen the scroll surface (`overflow: clip` on `.page`).

**P2: No hover affordance on editable text (03)**
- **Observed:** hovering editable text shows no cursor change or outline.
- **Why it hurts:** the core feature of the app ("click any text") cannot be discovered.
- **Redesign:** use `cursor: text` and the same faint above/below rules the selection uses, at 30% opacity, on hover. Pointer devices only.

**P1: Keyboard Tab order (79)**
- **Observed:** every text fragment is a tab stop, about 25 per page and 300 for a 12-page document, before focus reaches any later chrome.
- **Why it hurts:** keyboard and switch users can't get past page 1.
- **Redesign:** make the page a single composite widget.
  - One tab stop per page, using a roving tabindex.
  - Arrow keys move between fragments; Enter edits.
  - Add a "Skip to toolbar" link.

**P2: Restored session has no undo history (86).** A restore is a reasonable point to reset history, but say so: "Restored · earlier steps can't be undone".

---

## 3. Add text, draw, notes, select

**P1: Phone drawbar overflow (25, 31)**
- **Observed:** `scrollWidth` is 471 against a clientWidth of 366.
  - Note, the colour swatch (squashed to 2px wide) and the fold handle are clipped.
  - There is no fade or scroll hint.
- **Redesign:** on a phone, split the bar into two rows (tools / style), or move the style controls into the colour popover. Keep 48px targets.

**P2: Zoom pill overlaps page chrome (23)**
- **Observed:** on desktop the pill covers the top-right of the page and the multi-select bar's close button.
- **Redesign:**
  - Reserve a lane for the pill, or move it bottom-right next to the dock.
  - Never render it above transient bars: the multi-select bar should push it or take precedence.

**P2: Multi-select inconsistencies (24)**
- **Observed:**
  - After undo the bar says "6 selected" when 5 items remain.
  - The Properties tab says "Nothing selected" during a multi-selection.
- **Redesign:**
  - Derive the count from live state.
  - Properties should show the shared controls for the group (colour, stroke width, align, distribute, stack).

**P2: One colour for all draw sub-tools (15, 18)**
- **Observed:** pen, ticks and shapes all inherit the highlight yellow.
- **Why it hurts:** a yellow tick is invisible on paper.
- **Redesign:** remember a colour per sub-tool, defaulting to ink colours for pen, ticks and shapes and yellow for highlight.

**P2: Highlighter does not follow text**
- **Observed:** highlight is a free rectangle, and once drawn over text it can't be clicked, because the click selects the text.
- **Redesign:**
  - Snap the highlight to the text lines under the drag.
  - Let a click on a highlight's visible area select it when the Draw tool is active, or route via Alt-click.

**P2: Sticky tooltip on touch (31).** "Draw · D" stays visible after a tap. Suppress `data-tip` on `pointerType === "touch"`, or dismiss it on `pointerup`.

---

## 4. Sign

**P0: Placement blocked by text (37, 38, 42)**
- **Observed:** in placement mode, clicking over body text selects the fragment and no stamp appears. Only blank margins work.
  - The prompt reads "Tap the page" on desktop as well.
  - There is no ghost preview of the signature under the cursor.
- **Why it hurts:** signature lines sit next to text, so the most common click fails silently.
- **Redesign:**
  - While placing, overlay a transparent capture layer above the text overlay.
  - Show the signature as a ghost following the pointer, centred on it.
  - Click to commit; Esc to cancel.
  - Use the wording "Click where the signature goes" on pointer devices and "Tap" on touch.

**P1: Placed stamp anchored by its top-left corner (43)**
- **Observed:** a click near the right edge overflows the page and scrolls the viewport.
- **Redesign:** centre the stamp on the click and clamp it inside the page box.

**P1: Signatures saved silently (39)**
- **Observed:** `useSignatures` writes every created signature (up to 8 PNG data URLs) to localStorage key `signatures`. There is no opt-in, and the "Save session on this device" switch neither governs nor clears them.
- **Why it hurts:** in an app whose pitch is privacy, a reusable image of someone's signature is the most sensitive thing to persist without asking. On a shared computer the next user gets it.
- **Redesign:**
  - Add a "Remember this signature on this device" checkbox in the dialog, off by default.
  - Make the autosave switch's off state also clear saved signatures, or give them their own switch in the ⋯ menu with a clear explanation.

**P2: Add is enabled on an empty Draw pad (41)**
- **Observed:** `canInsert` is `true` for the draw tab regardless of ink, and `insert()` silently returns.
- **Redesign:** track ink with state rather than a ref so the button disables until something is drawn.

---

## 5. Redact, whiteout, find

**P0: Search-and-redact misaligned (47, 48, 50, 54, 56)**
- **Observed:**
  - "Redact all" for "Account 4111" places boxes shifted right by about 2 glyphs. The leading "Ac" remains visible in the exported, rasterised file.
  - "4111-1111" leaves "41" visible.
  - The find highlight shows the same offset, so the preview is wrong too.
- **Why it hurts:** this is a disclosure bug. The user believes the data is gone, and the export carries it.
- **Redesign:**
  - Compute match rectangles from measured glyph advances (`measureText` on the substring prefix, in the fragment's resolved font), not proportional character counts.
  - Pad each box by about 0.1em on both sides.
  - Before export, show a "Review redactions" step listing each box with a zoomed crop, so a misplaced box is visible.
  - Add a spec that redacts a substring in mid-fragment and OCRs or text-extracts the export for the term.

**P0/P1: "Redact all" has no confirm or preview (49, 50)**
- **Observed:** one click redacts every literal substring match, and the change counter jumps (e.g. to 288).
- **Redesign:**
  - Show "Redact 12 matches on 4 pages?" with a per-match checkbox list.
  - Offer a whole-word or case option.
  - Count the operation as one change in the counter.

**P2: Whiteout warning grammar (46).** "1 whiteout cover … sit over" should be pluralised properly ("sits" or "sit"); the shell spec already exercises count wording.

---

## 6. Download, save state, leaving

**P1: No "saved" state (53)**
- **Observed:** after a successful download the counter still reads "N changes". `beforeunload` still fires, and both the close and the open-another confirms still say the changes will be discarded.
- **Why it hurts:**
  - The prompts lose credibility: users learn to click through them.
  - The copy is literally false: the changes are already in the downloaded file.
- **Redesign:**
  - Record a "saved at revision N" mark on download.
  - Show "Downloaded · 2 min ago" in place of the counter.
  - Suppress the prompts until the revision moves again.

**Export progress** ("Building edited PDF… page 3/12", 52) is good.

---

## 7. Second PDF, close, autosave

**Precise behaviour of opening a second PDF with unsaved edits** (⋯ → "Open another PDF", or the command palette):

1. If `changeCount > 0`, a ConfirmDialog appears (55):
   - title "Open a different PDF?";
   - body "This discards all your current changes.";
   - buttons "Cancel" (it gets the focus) and "Discard & open" (danger style).
   - There is no "Download first" option.
2. The confirm comes *before* the OS file picker. If the user confirms and then cancels the picker, nothing is lost: the document and its "1 change" stay.
3. If a file is picked, `openBytes` calls `doc.reset(EMPTY_DOC)`. The autosave effect then sees no changes and calls `idbClear()`. IndexedDB holds a single session slot, so the previous document's autosave is deleted.
   - A reload shows no restore banner (89). The edits are unrecoverable.
4. The prompt appears even if the user already downloaded, because the counter never resets (finding 6).
5. Dropping a PDF onto an open document is not handled: only the empty-state dropzone has a drop handler. The browser navigates to the file, with the native `beforeunload` prompt if there are changes. This was read from the code, not exercised.

**P0 redesign:**
- Make the confirm three-way: "Download & open" (primary), "Open without saving", "Cancel". Skip it entirely when the state is saved (finding 6).
- Keep autosave per file, keyed by a hash of the file, not as a single slot, so the old session is still offered from the home screen ("Recent on this device"). The in-progress `DocTabs` work in the other session points the same way. If tabs land, opening a file should add a tab, not replace one.
- Add a workspace-level drop handler that routes through the same flow.

**P1: "Discard & close" doesn't discard (87, 90, 100)**
- **Observed:**
  - The confirm says "Your unsaved changes will be discarded."
  - After "Discard & close" the home screen shows no restore banner (90).
  - After a reload, "Restore your last session?" appears and restores the edits (100). `closeDoc` never clears IndexedDB.
- **Why it hurts:** the copy is false in both directions. A user who meant "throw this away", for example on a shared machine, leaves it on disk. A user who closed by accident is told the work is gone when it isn't.
- **Redesign:** choose one behaviour and say it.
  - Recommended: clear the session on "Discard & close".
  - Offer a separate "Close (keep on this device)" when autosave is on.

---

## 8. Organize pages & finishing ops

**P1: Apply discards everything (60, 61)**
- **Observed:** "This rebuilds the document and discards your current text edits, annotations, and redactions." There is no undo afterwards.
- **Why it hurts:** reordering pages is commonly done *after* signing or annotating, and it silently becomes destructive.
- **Redesign:**
  - Remap overlay `page` indices through the permutation instead of baking. Rotation and deletion are pure index operations on `DocState`.
  - Until then, offer "Download edited copy first" in the confirm, and make Apply undoable by snapshotting the previous bytes and state.

**P1: Organize interaction (57–59)**
- **Observed:**
  - Reordering uses arrow buttons only; there is no drag.
  - Delete takes effect immediately, with no undo inside the dialog.
  - A rotated thumbnail overflows its card (58).
  - Selection for extract had no visible state.
  - The hint text has the filename appended oddly.
- **Redesign:**
  - Drag-to-reorder thumbnails, keeping the arrows for keyboard users.
  - A visible selection ring and count ("3 pages selected · Extract · Delete").
  - In-dialog undo.
  - Fit rotated thumbnails with `object-fit: contain` in a square cell.

**P2: Page numbers and watermark have no preview (62–65)**
- **Observed:** the position picker is six unlabelled boxes, and nothing previews the result.
- **Redesign:** label the positions with a tooltip and `aria-label` ("Bottom centre"), and show a live preview on the current page thumbnail.

**P2: Compress defaults to a rasterising option (67)**
- **Observed:** "Balanced" is preselected, and it loses selectable text.
- **Redesign:** default to "Keep text". Mark the rasterising options "Text becomes an image".

**P3: Export as images downloads immediately (66).** It produces a ZIP with no format or DPI options. Add a small options step, or at least show the DPI in the label.

---

## 9. OCR, forms, links

**Working:** OCR on the scanned fixture recognised all 4 words, which are findable and editable (70, 71). Form text fields and the checkbox work (73). The unsafe-link warning is clear (76).

**P2: No proactive OCR suggestion (68)**
- **Observed:** a scan opens with "0 text fragments", and clicking on it does nothing (69).
- **Redesign:** when a page has no text and an image covers it, show an inline banner: "This page is a scan. Recognise text so you can search and edit?"

**P2: Form dropdown is inert (72, 73)**
- **Observed:** the `/Ch` field renders as an empty box that can't be opened.
- **Redesign:** render choice fields as the app's own menu, populated from the field's `/Opt`.

**P2: Existing links can't be selected or edited (74).** Only new links are editable. Hit-test existing link annotations and open the same link editor.

---

## 10. Navigation, zoom, palette, shortcuts

**P1: No page indicator or go-to-page**
- **Observed:** outside the page rail there is no "3 / 12" display and no way to jump to a page.
- **Redesign:**
  - Put a "3 / 12" chip in the zoom pill.
  - Clicking it opens a page-number field.
  - Add a "Go to page" command to the palette.

**P2: Zoom semantics (80, 81)**
- **Observed:**
  - "100%" means fit-to-width, not actual size.
  - Clicking the percentage silently resets the zoom.
  - Ctrl+0 does nothing.
- **Redesign:**
  - Label the base zoom "Fit width".
  - Make the percentage open a small menu: Fit width / Fit page / 100% / 200%.
  - Bind Ctrl+0, Ctrl+1 and Ctrl+2 to those.

**P2: Rail doesn't refit (82, 83).** Opening the page rail leaves the page clipped under the Inspector. Refit when the available width changes because of the app's own panels, animating the scale rather than jumping.

**P3: Command palette gaps (77, 78)**
- **Observed:**
  - There are no Undo, Zoom or Go-to-page commands.
  - "rot" finds only "Organise pages".
  - There is no "?" shortcut sheet, no Ctrl+S (download) and no Ctrl+O (open).
- **Redesign:**
  - Add keywords to commands (rotate, reorder, delete page → Organise).
  - Add a shortcut sheet on "?".
  - Bind Ctrl+S and Ctrl+O to the existing actions, through the same three-way confirm.

---

## 11. Phone-specific

- **P0: Zoom pill above the ⋯ menu (29).** The pill's z-index beats the overflow menu, and Playwright reports `.zoombar intercepts pointer events` on "Organise pages". Put the menu (and every popover or sheet) on a layer above all floating chrome, or hide the pill while a menu is open.
- **P1: Download has no accessible name.** It shows as "button" in the aria snapshot, because the label is hidden at icon-only width. Add `aria-label="Download"`.
- **P1: Drawbar overflow (31).** See section 3.
- **P2: Sticky tooltips after a tap (31).** See section 3.

---

## Dark mode

- No contrast regressions were spotted in the panels, menus or dialogs (01/02-dark, 90).
- The selected-tab joint and the fillets render correctly.
- The page itself stays white, which is correct: it is the document.
