# Testing: the Playwright suite and which spec guards what

_Read before adding or changing a spec, or when a spec fails and you need to know what invariant it protects._

Moved verbatim from `CLAUDE.md`; the index there links here.

## Which spec guards what

`tests/app.spec.ts` covers feature behaviour. The rest cover the invariants
type-checking can't see, and each exists because it broke once:

- `privacy.spec.ts` — no off-origin request or `<link>`; CSP present, restrictive,
  and not silently widened; autosave stores a session and the toggle erases it;
- `rendering.spec.ts` — the render window stays bounded on a 150-page document,
  doesn't grow while scrolling, and the page you scroll to is actually painted;
  no commit ever mounts every page's overlay; the page rail rasterises only a
  band and lets go of thumbnails it scrolls past; and a keystroke or a selection
  change re-renders only the pages involved, not all 150. The render count comes
  from a stand-in for React's DevTools hook installed by `addInitScript` (see the
  comment on `COUNT_PAGE_RENDERS`), so the app carries no instrumentation;
- `export.spec.ts` — an unsafe link URL is flagged in the UI and absent from the
  exported bytes, no authoring metadata is written, a redacted page has no
  extractable text while its neighbour keeps its own, the redaction raster is a
  JPEG (and the lossless switch really turns that off), "Keep text" shrinks a
  flate-compressed image without costing the page its text, it never rewrites a
  soft mask, and an image whose `/DecodeParms` it can't read is left alone.
  Package 1 added: "Redact all" covers every glyph of every search match (the
  target located from the rendered ink, not from font metrics, which disagree
  with pdf.js); export keeps the outline, page labels, tags and `/Lang`, named
  destinations, layers and the form; a redacted page leaves nothing behind
  (field values, tag `/ActualText`, orphaned objects, Info) while links to it
  follow the replacement; a shared image is written once on export *and* on
  Organise; a page used twice in Organise is two pages; and export yields per
  slice of work, not per page (counted, not timed). From the adversarial
  reviews: no red survives "Redact all" on text that's stretched, spaced,
  rotated, case-folded, right-to-left or on a page not yet scrolled to (the
  Turkish/Hebrew pages need DejaVu, and are skipped with a note without it); a
  damaged page tree redacts the page the user saw; a page sharing resources
  with a redacted one doesn't carry its forms out;
- `ocr.spec.ts` — an image-only page becomes findable text, with the engine and
  language model loaded from our own origin only; and the engine cache holds the
  wasm core and *nothing else* (skips if assets are absent);
- `font.spec.ts` — an edited fragment keeps the page's typeface and weight (a
  sans document's edits are not redrawn in Times), and picking a font overrides
  it;
- `baseline.spec.ts` — an edited fragment's glyphs sit on the baseline the
  exporter writes to, over five faces/sizes at two fit-to-width scales;
- `colors.spec.ts` — an edit inside a coloured panel keeps the panel's colour and
  the text's own colour, on screen and in the exported bytes, while black text on
  paper stays exactly black (the two fixture panels fail in opposite directions,
  so neither fix can pass for the other); a rule under the baseline isn't mistaken
  for the text's colour; a rotated page is declined rather than sampled at
  mis-mapped coordinates; and scrolling reads back no pixels;
- `find.spec.ts` — the active match is on screen and clear of the find bar;
- `reading.spec.ts` — a page fits at no more than its printed size, centred
  with margin, on a wide window; opening Pages refits a page that would run
  under the panel, keeping the reader on their page; and at rest the zoom pill,
  the status toast and the dock leave the first page's opening lines clear (and
  each other), on a wide window, a laptop and a phone (slice 10a).
- `hierarchy.spec.ts` — the app bar and the tab strip are one surface (same
  fill, no rule between, touching); the ⋯ menu's group labels are smaller than
  its items and not in capitals, and a menu taller than the window fits it and
  shades its scrolling edge; the Inspector's controls all start on one line
  beside their labels, a value in a label is in the label's weight, Reset
  style sits in the control column, and the Document panel's headings are
  sentence case; on a phone Download's chip is the same size as ⋯ (slice 10b).
- `phone.spec.ts` — the status message clears the zoom pill and the tool dock;
  every ⋯ menu item takes its own tap (the pill used to cover the first); the
  draw options fit a phone with every control on screen at a full touch
  target; the icon-only Download button has a name;
- `placement.spec.ts` — a signature clicked onto text is placed (not swallowed
  by the fragment), centred on the click exactly where the ghost showed, kept
  on the page at the edge, and Esc backs out;
- `edge.spec.ts` — a stamp or text box dragged past the page edge stops at it;
  an edit typed past the edge is marked, announced, doesn't widen the scroll
  surface, and loses the mark when undone;
- `keyboard.spec.ts` — Tab reaches the tool dock after at most one stop per
  page, Skip to tools jumps there, arrow keys walk fragments with one roving
  stop per page, and the zoom pill's page chip (and "Go to page…") jumps;
- `shell.spec.ts` — the app bar fits its own controls at 360/390/430px with the
  primary action at full size and, on a pointer, sized to the bar it sits in with
  the ⋯ menu carrying a visible container, the overflow menu ends inside the
  window and every row is one line, the Inspector describes the document with nothing selected (facts, page numbers/watermark set and removed from it, OCR offered on a scan and only for pages without text, gone once read, focus kept after Remove and after OCR, sizes that differ only in orientation counted as one, lossless as an app setting in ⋯/palette mirrored in the panel, a marquee not shown as the document) and the selection otherwise, with "Hide panel" in both, the command registry (every ⋯ and Export row is a palette command with the same label, icon and opens-mark; zoom, panel, pages, autosave, align run from the palette; group actions offered only with a group; Search commands in ⋯ opens the palette),
  a tooltip on an edge control stays on screen, and counts read as English; the
  Export split button's caret opens every output (and only it lists them; Download
  all joins with several tabs), keyboard-operable, and on a phone Export heads
  the ⋯ menu instead of adding a control;
- `icons.spec.ts` — every `name=` in `src/` is mapped (an unmapped one renders a
  blank square, silently) and every mapped name is used;
- `marks.spec.ts` — a tick is placed by a *tap* (a checkbox is smaller than the
  drag threshold), a drag sizes it instead, both cross strokes are drawn, a mark
  gets the same resize frame as any other box, the glyph reaches the exported
  bytes rather than living only in the overlay, a *rotated* mark exports at the
  angle the overlay drew, a mark survives its page being rasterised for
  redaction, and the tool's gesture hint is un-occluded while a ghost of the mark
  follows the cursor;
- `affordance.spec.ts` — the ⋯ menu, the Export menu and the command palette mark
  the *same* set of actions as opening something, an action that acts
  immediately carries no mark, and a tool that opens something declares which
  kind (`aria-expanded` for a disclosure, `aria-haspopup` for a dialog);
- `shape.spec.ts` — no chrome geometry (`corner-shape`) reaches `.page` /
  `.page__canvas` / the thumbnails;
- `fragment.spec.ts` — an edit's overlay text (and a text box's) starts at
  exactly the x the exporter draws it at, with no horizontal padding anywhere in
  the chain, and a selected fragment is marked by rules above and below rather
  than a ring whose vertical edge reads as a letter;
- `ligature.spec.ts` — in a document's own TrueType face, every letter draws
  as itself (pdf.js had filed the "fi" ligature under "f": "from" read
  "firom"), and an edit kept in that face exports at all, with real glyphs and
  real spaces (no .notdef boxes); skipped where DejaVu isn't installed;
- `line.spec.ts` — (also guards pdf.js 5's run merging: without
  `splitRunsAtSetFont` the runs arrive as one fragment and it fails) on a line
  written as several runs (as Word writes one), an
  edited run keeps to the room before the next run, less the word space, and is
  condensed when it needs more — on screen and in both export paths (vector,
  and raster under a redaction) — so it never covers the next word; a run with
  a tab-stop gap or nothing after it still grows freely; on a turned page the
  preview condenses as the file does; a very long edit stops at the 0.7 floor;
  an emptied neighbour frees its room; a raised footnote marker still bounds it;
- `chrome.spec.ts` — the draw sub-toolbar opens with its tool, folds away when a
  sub-tool is picked and comes back from its handle; the colour popover stays on
  screen and covers neither the toolbar it lives in nor the tool dock, at three
  widths; and the status snackbar clears both;
- `tabs.spec.ts` — a second PDF opens in a tab beside the first instead of
  replacing it, and the first comes back with its edits *and* its undo history;
  closing a tab with work in it asks (a clean one doesn't); a reload restores
  every edited tab and only those; Download all zips each tab with its own
  edits; and on a phone the strip appears only with a second document and
  doesn't push the status toast onto the zoom pill; a file dropped while a
  dialog or OCR/export is running opens nothing (the dialog's result would land
  in the new tab); an Organise result counts as unsaved (`baked`); restoring past
  the tab cap, Delete from a second window, and a discarded tab each leave the
  device holding exactly what they should; Download all refuses a whiteout over
  live text in *any* tab; closing or arrowing between tabs by keyboard keeps
  focus on the strip; and since a document can come back in a fresh editor, coming back
  lands at the scroll position it was left at, a switch keeps the page at the
  size it was shown (no re-fit after hiding the panel), and Ctrl+O closes the
  ⋯ menu;
- `sidebar.spec.ts` — the Pages sidebar moves (Alt+↑/↓ and drag, a whole
  selection together), turns and deletes pages as live, undoable edits that
  keep each page's markup and come out in the file in that order; Shift picks a
  run; a document always keeps one page (Delete off with every page picked);
  Ctrl+A and Escape in the sidebar act on pages, not the canvas; keyboard focus
  stays on the page through a move or delete; on a phone a tap goes to the page
  and a press-and-hold picks it. From review: a click on the canvas hands the
  keyboard back (Delete removes the selected box, not a page); a row with only
  focus isn't deleted; Escape / letting go off the list cancel a drag, and an
  undo mid-drag isn't redone by the drop; a blocked Delete doesn't steal focus
  later; picks don't survive their page's removal; with Find open the view and
  the active hit stay put through page work and text loading;
- `hidden.spec.ts` — the "Hidden information" report, on the `hidden` fixture
  (properties, XMP, file ID, scripts, attachments, launch/submit links, private
  data, a signed comment, a switched-off layer). Every kind is listed under the
  right heading; the download, read structurally (it's compressed, so byte
  searches prove nothing), has none of what was listed as removed and all of
  what was listed as kept; and the download, reopened, has nothing left to
  remove. Edits, and whiteouts that sit over text (a whiteout on blank paper
  isn't counted), are covered text until the page is redacted, which also
  takes its comments out of the "kept" list. A `describe` block reads the
  report in Node straight from `inspectHidden`/`hiddenRows`, over small files
  built for each way review caught it lying: an action named `/toString`, one
  file named in both `/AF` and EmbeddedFiles, a `/Screen` player, an opening
  view, an empty script tree, a broken `/Next` chain, a page with three
  private entries, `/BaseState /OFF` layers, and comments on a page that
  doesn't ship.
- `protect.spec.ts` — Export → Download with password. The download is
  AES-256 (`/V 5 /R 6`, read from the `/Encrypt` dict with upstream pdf-lib's
  `ignoreEncryption`); pdf.js, the independent reader, refuses it with no or
  the wrong password and reads the body with the right one; decrypted, it
  keeps none of the hidden information export strips. The app's own password
  prompt opens it. The password is in no storage, and the next plain download
  isn't encrypted. The dialog: Enter always answers; "don't match" waits
  until the second field is finished; nothing invites the browser to save
  the password. Strings on the catalog/pages (a `/Lang`, a page-label prefix)
  aren't readable in the raw bytes and read back right with the password. A
  full-width / no-break-space password opens in pdf.js as its prepared form
  and in the app as typed. History: through the whiteout warning the copy is
  still protected and closing the warning stays in the app; on a phone with
  something selected, the dialog opens (the deselect's removal no longer
  closes it) and Back closes it without leaving the app.
- `saveto.spec.ts` — Package 8c. With stubbed pickers / share sheet / print():
  a picked file is written back on Ctrl+S with the edit in its bytes, no
  download, "Saved", and closes without asking; denied permission writes
  nothing; a password-opened file warns first. With no handle Ctrl+S is Save
  as (asked once, then the tab is that file); a cancelled picker is silent;
  without pickers Ctrl+S downloads. Share passes the edited PDF, and a refused
  first call offers "Ready to share" (and isn't a save). Print lays out 12
  pages at 595×842 pt, 150 dpi, with the redaction black; under print media
  only they show. Review fixes: the same file picked again goes to its tab; two
  Ctrl+S at once write once; a file once saved without its password (in place
  or via Save as) isn't warned about again; a browser-started print shows the
  app; a landscape page gets a landscape `@page`; on a Mac Ctrl+S is left
  alone; with two tabs each saves to its own file; a failed write stays
  unsaved. Second review: Save as onto a file another tab has open is
  refused; one unreadable file among several opens the rest and is named;
  sharing through "Ready to share" isn't a save either. Third: Save as onto its
  own password-opened file warns as Ctrl+S does; a file named "-edited" is
  offered "… copy", never its own name; an already-open file picked with
  another is said to be open — but never over why the other didn't open.
- `forms.spec.ts` — Package 8d, on the `form` fixture (one field of every
  kind; a dropdown whose stored values differ from its shown text, and
  pdf-lib's numbered radio on-states). Read back with upstream pdf-lib: every
  kind fills, a limit stops typing, the radio is saved as the option it stands
  for and the dropdown as its stored value, and the file stays a form by
  default. Flatten prints the answers onto the page (pdf.js text) and leaves no
  fields. Greek can't be drawn by the standard font: that field stays fillable
  with `/NeedAppearances`, the user is told, and no "?????" reaches the page —
  told by Compress (keeping text) and Download all too, never by Export as
  images, whose picture shows the answer.
  The choice undoes. The review's findings each have a test: the fields
  don't block text or boxes around them, Backspace in a field never deletes the
  selected box, radios are named "size: option 2 of 3" and arrow keys move the
  choice, each click is its own undo step and a field put back is no change,
  a box or radio keeps the file's own look and `/DA`. On `formEdge`: an
  editable dropdown shows its own value and is named by its `/TU`, a single
  list starts empty, of two buttons with one export value the clicked one is
  chosen, flattening skips a hidden field and a signature and keeps a list
  with Greek options and a comb field it can't lay out fillable (both named),
  a redacted page's picture shows the answers as they are now (a cleared field
  blank, the newly chosen radio dotted, the old one not, a `\r` value on two
  lines, a long answer wrapped — with 20,000 unbroken characters after it,
  which mustn't stall the export — and a list scrolled to its chosen last
  option) and, flattening, reports nothing as staying
  fillable; a non-editable dropdown's own unlisted value is drawn (kept and
  flattened) and it stays non-editable; a locked field is read-only, a UTF-8-named radio
  is saved as the button clicked, a field in a `/Parent` loop or under an
  untitled parent gets its value, a clicked field gives the keyboard back to
  a selected box, Organise keeps the form, and merging two forms keeps the
  second's `/NeedAppearances`, `/DR` font and `/DA`.
- `crop.spec.ts` — Package 8b. A page whose CropBox starts at 100,200: the
  heading's overlay sits on its glyphs (not off the page), an edit is redrawn
  at the run's own user-space position, and a link drawn 20 points in from
  the view's corner gets a `/Rect` that far in from the CropBox's. Crop: the
  slot takes the crop's shape and text past the cut edge sits outside it, the
  download has exactly that CropBox on that page only, undo restores it; "All
  pages" applies one set of margins to all 12, the dialog reopens on them and
  "Whole page" + Uncrop clears every crop; on a `/Rotate 90` page "Top" cuts
  the user-space left side; Organise's thumbnail shows the crop and a plain
  move keeps it with the page.
- `pagetools.spec.ts` — Package 8a. Pictures: a phone JPEG (stored
  landscape, EXIF orientation 6, with GPS text in EXIF, XMP, a comment and
  IPTC) opens upright (portrait, its red corner top-right), 150 × 300 points
  for 200 × 400 pixels, with none of that text or "Exif" in the file and no
  producer; it opens as unsaved work (closing asks). Pictures picked with a PDF
  make one document in pick order beside the PDF's own tab; a file that only
  starts like a JPEG is refused by name. Organise: a blank page and a picture
  go after the picked page (nothing is then picked, but the next one still
  follows it), the blank sized like the page before it — turned with it when
  that page is turned. Split: from the Export menu it opens straight into the
  dialog and Cancel lands back on the page; every 5 pages of 12 makes three
  files named by range, the redacted page has no text in its part; in
  Organise, picks start parts in the order Organise shows. Review fixes:
  Split and Extract of an *unedited* file carrying a page script, a launch
  link, an attachment, page XMP and PieceInfo leave all of it out, with no
  producer, and the zip flags its names UTF-8 (the file goes in as a buffer —
  Playwright can't pick a path with an accent); a photo with a JFIF
  thumbnail, a JFXX segment, a comment after the scan and a second picture
  plus video after its end marker brings only the picture; Split from the
  menu keeps focus and Tab inside its dialog, and Escape / Cancel / scrim
  during the split don't close it; the grid goes `inert` while a page is
  added (read from mutation records — the add can finish before an observer
  looks), added pages aren't picked so Split defaults to "every N", picking
  only page 1 explains itself, "2.5" pages is refused, "Add file" starts its
  own accessible name; adding several files with one non-PDF adds nothing
  and names it; a mixed batch names the picture to blame, a picture called
  ".png" opens as "Pictures.pdf", and a .txt hears that pictures are
  accepted too. Other specs pick the open input by `input[data-open-input]`,
  not by its accept list, which changes as file types are added.
- `patterns.spec.ts` — Redact patterns: every preset is found in the
  `personal` fixture, a phone number split across two runs too, and the
  decoys (a Luhn-failing "card", a bad-checksum IBAN, a span of years, a short
  reference) are not; the fixture's only red is the hits, so red left after
  export means a box fell short. An unticked hit stays on the page and in the
  file, and the rest redact in one undo step. Dates are opt-in; a custom
  pattern that doesn't compile or matches empty text is refused with an alert.
  Escape leaves the page untouched; the find bar leads to the panel and the two
  never show together; on a phone the sheet fits and its Redact button is in
  view. From review, on the `tricky` fixture (every hard case in red): a hit
  beside a neighbour its checksum refuses, a phone number's one-digit first
  group and leading "1-", a lower-case IBAN, a custom pattern over an email,
  comb digits and a number split across a turned line all leave no red. A
  catastrophic custom pattern is stopped with the tab still answering; "."
  asks to be narrowed; unticked hits survive picking the command again and an
  edit to their line; opening doesn't move the view and Show always scrolls;
  focus returns to ⋯ on close; a selection beside the panel gets its
  SelectionBar and the first Escape; on a phone the last hit of a long
  document lands above the sheet, and Back closes the sheet.
- `update.spec.ts` — the site redeployed under an open page: an on-demand
  part whose file is gone (a 404'd chunk) doesn't open, the document and its
  edits stay on screen, no modal is left half-open, and a banner offers a
  reload; the banner pushes the app down rather than covering the tabs or
  zoom pill; Reload stores the latest edit first (no waiting out autosave)
  and asks no "Leave site?" when it's stored. From review: a dropped
  connection says "couldn't load", not "updated"; a part that throws for its
  own reasons raises no banner; the crash screen's Reload stores an edit made
  a moment before and its copy only promises a restore when saving is on;
  with saving off the banner says to download first. And picture-only pages:
  a click says the page has no text to edit and offers Recognise text (never
  on a page with real text, never on a drag or right-click), clear of the zoom
  pill on a wide and a narrow page area; Dismiss holds for the document, also
  across a tab switch; Recognise text makes the words editable. Both came from
  one user report (a blank screen after Compress; a printed-to-PDF file whose
  words did nothing);
- `outline.spec.ts` — Package 8e, on the `outlined` fixture (nested
  bookmarks: a direct `/Dest`, a named destination, a GoTo action and a web
  address). The Outline tab lists them as a tree and goes to each one's page
  *as arranged* (after a move it names and opens the new position; after a
  delete it stays, disabled, and goes nowhere), works from the keyboard, and
  isn't offered without bookmarks. A link to a page follows its page through a
  move into the file's `/Dest`, keeps its web address when switched back, is
  flagged and left out when its page is deleted, and lands on the raster when
  its page is redacted after the link was written. `buildFromPlan` (Merge,
  Extract, Split) keeps links between kept pages, in or out of order, to a
  blank page, to the right one of two pages sharing a content stream, and to
  the first use of a page used twice — and cuts one whose page was left out. The page field takes its number on Enter or
  blur, so typing "12" in a 4-page document doesn't move the link to page 1 —
  and on a click that deselects the link before any blur; both switches are one
  tab stop that arrows move, without also nudging the selected link, and End
  on a deleted page's link leaves it flagged; closing a section keeps focus in
  the tree;
- `headerfooter.spec.ts` — Package 8f. The resolver (a setting from before
  reads as its page number; tokens fill per page, case-insensitively; `{pages}`
  counts from the start; a brace that isn't a token stays; Bates pads, keeps
  counting past its digits, and survives nonsense) and, in the app: a new
  setting starts as a bottom-centre page number; clearing every place disables
  Apply; a chip goes in at the caret of the place last focused; the Bates block
  and its range appear once it's used; the page previews exactly what the file
  gets, a cleared place leaves no number behind, right-aligned text ends on the
  same margin; `{date}` and `{file}` are the applied ones, not today's or the
  tab's, and Update keeps them unless asked; a date in a language Helvetica
  can't write reaches the file whole (in English); the caret is after the
  token the moment the chip is handled; number fields clear and retype; a
  damaged stored setting still renders, exports, and opens in the dialog as
  the page reads it, and Update with nothing touched keeps its size and Bates
  numbers; a date added later is today's, not a stored, unshown one; the
  preview's baselines match the exporter's; a page-number setting from before opens as its one place;
- `compare.spec.ts` — Package 8g. The engine (a reflowed paragraph is one
  change, not every line after it; typographic quotes and soft hyphens aren't
  changes; the matcher is a longest common subsequence, checked against plain
  dynamic programming, and gives up past its cap) and, in the app: each change
  is listed with its kind, page and words, marked on Before's page (removed) and
  After's (added) over the word itself, and nothing on a page that didn't
  change; Next/Previous walk the list; Swap turns additions into removals;
  Overlay draws ink only in one version in that version's colour, even when the
  text is identical; a tab's unsaved edit is compared as it would download
  ("with your edits"); a small redaction removes only the words under it, on a
  cropped page too (the exporter rasterises that page); marks and Overlay keep
  their colours in dark theme; closing Compare leaves a background tab's fonts
  loaded; the command is disabled with one document open;
- `indexing.spec.ts` — Package 9a. A file opens with its layout and reads its
  text in the background. The spec holds one page's text back inside pdf.js's
  worker (it serves the worker with a prefix that delays that page's
  `GetTextContent` message), so "not read yet" lasts long enough to act in:
  the first page paints well inside the hold; the Inspector says "Reading
  text…", never "No text layer"; Find counts what has arrived and Redact all
  waits for every page; Export text includes the held page; a restored edit on
  it counts as a change and is drawn in the download; a restored whiteout over
  it still warns before download. Each was shown to fail with its
  `completeText` (or count) removed;
- `codec.spec.ts` — Package 9b. Image encoding runs in `codecWorker.ts`. A
  redacted page exports (smaller-of-JPEG-and-lossless, and lossless) and
  Compress + Keep text run with no main-thread long task over 250 ms, measured
  with the Long Tasks API (before: 1.1–1.2 s in one task per redacted page),
  and the codec worker is seen to start. The lossless raster is read back
  independently — DeviceRGB, `/Predictor 15`, every row's filter a PNG one, the
  redaction solid black and the photo intact. With the worker's script blocked
  the export still finishes on the page (and still as JPEG). The first three
  were shown to fail on the previous build;
- `decoders.spec.ts` — pdf.js 5. A fax-coded scan (`CCITTFaxDecode`) and a
  JPEG 2000 image (`codecs` fixture, a few dozen bytes each, written by an
  encoder once) paint — black square on white, flat red — with their
  WebAssembly fetched from the app's own origin and no script fallback needed.
  Shown to fail (both blank) with `wasmUrl` left out of `getDocument()`. And a
  browser without the newest built-ins (deleted on the page and in pdf.js's
  worker) still opens and paints a file — failed on pdf.js 5's modern build;
- `warm.spec.ts` — React 19.2's `<Activity>` keeps the last document mounted
  behind the one in front. Switching back shows the *same* canvas (marked
  before the switch) and never painted again, with its undo, where a rebuilt
  editor painted new ones; typing before and after a switch is two undo steps;
  coming back by keyboard leaves focus on the strip, not in a text box that
  was being typed into; on a phone, Back's history entries belong to the
  document in front; and a window moved to a 2× screen while its document
  waited repaints that document sharp on return (the paint key has the density);
  the document behind is off the page entirely (one tab strip, none of its
  canvases or text boxes findable); Ctrl+Z in front never reaches it; and a
  window resized while it waited fits it on return. The first failed on the
  previous build, the last before the editor stopped re-announcing its old fit
  on coming back (280 px off). The second review's four (repaint, undo merge,
  focus, Back entry) each failed before their fix;
- `winansi.spec.ts` — text drawn in a standard font (a text box, a watermark)
  never reaches the file as a stand-in "?": `@cantoo/pdf-lib` writes "?" for a
  character WinAnsi can't encode instead of throwing, so `sanitize`
  (`standardText.ts`) detects it by its encoding. A letter with a plain form
  is folded to it (Ł→L, ź→z, ﬁ→fi; ó is WinAnsi already and stays); Greek and
  Chinese are left out, and the status line after Download, Download all
  (naming the documents) and Print names each left-out character once (and
  says nothing when none were). Read through pdf.js,
  since content streams are compressed;
- `saved.spec.ts` — a download is a save: it clears the counter, the tab's
  dot and the leave prompt, and turns the close prompt into a plain "Close";
  a download the browser didn't finish still can't lose the work (close asks,
  and with the session copy off, leaving prompts); the next edit brings it all
  back and undoing to what was downloaded clears them again; the saved state
  travels with a tab to the background; Download all saves every tab it
  zipped; and a signature is stored on the device only when "Remember this
  signature" is ticked, and can be removed;
- `sign.spec.ts` — "Sign with certificate" output verifies the way a reader
  checks it: the `/ByteRange` spans the file except the signature, the PKCS#7
  digest matches those bytes, and the signature checks out against the
  embedded certificate. Exists because the engine swap could break signing
  silently (two copies of pdf-lib → no file at all), and caught it again when
  Vite 7 resolved @signpdf's `require` to the fork's CommonJS build;
- `password.spec.ts` — a password-protected PDF asks in-app, says a wrong
  password is wrong without losing what was typed, opens with the right one,
  and downloads as a plain PDF with its text (no `/Encrypt`); cancel opens
  nothing; an owner-locked file opens without asking and its download is
  readable (it wasn't); and a password-opened document never reaches the
  autosave store — nor does a document Organise merged its pages into; an
  owner-locked file with a 30,000-item outline opens (the unlocker's recursive
  walk overflowed); and Cancel during "Checking…" opens nothing. Fixtures are
  encrypted with `@cantoo/pdf-lib`;
- `pages.spec.ts` — reorder, turn and delete in Organise keep a text box with
  its page, take one undo, and export exactly the planned pages in order and
  turned, with no page object left for the deleted one; on a `/Rotate` page new
  text lands where it was placed and reads upright; on a turned page a drag
  moves the way the pointer went, Align and Duplicate work as the page is
  shown, the view refits, the thumbnail fits and the tick preview is upright.
  Merge and Extract start from the document as shown (a deleted page doesn't
  come back through a link, whiteout over text is refused, page numbers follow
  the new order, an extracted redacted page stays redacted); page labels follow
  their pages; markup on a deleted page can't be selected, pasted or counted;
- `overlays.spec.ts` — a marquee'd group moves as one (one undo step) and
  survives the drag, a plain click on a member selects just that one, arrows
  nudge the group, and a buried stroke can be raised — in the overlay's paint
  order *and* in the exported file's.

If you add a feature that touches privacy, the export bytes, or per-page
rendering, add a spec for it — that's where this project's real invariants live.
Fixtures are generated at run time in `tests/fixtures.ts`; shared page helpers
(request/error watching, opening a doc, canvas stats) are in `tests/helpers.ts`.
See `docs/PRODUCT-AUDIT.md` for the findings behind each spec.

## Running and exploring (Playwright)

Start with the committed suite: `npm run build && npm test`. Playwright starts
its own preview server (`webServer` in the config) and the specs generate their
own PDFs. Extend `tests/` rather than writing a throwaway script when the thing
you're verifying should stay verified.

For one-off exploration (a new interaction, a screenshot in both themes):

- No browser download in the sandbox, and the pinned Playwright wants a newer
  build than is installed — so run the suite as
  `PW_EXECUTABLE_PATH=/opt/pw-browsers/chromium-1243/chrome-linux64/chrome npm test`
  (the build number moves with the sandbox image; `ls /opt/pw-browsers`).
  The config reads that env var (CI uses `playwright install` instead). Without
  it every spec fails with "Executable doesn't exist", which is a missing binary,
  not a regression.
- `playwright` resolves transitively through the `@playwright/test`
  devDependency, so a plain `npm install` is enough — the old
  `npm install --no-save playwright` step is no longer needed. Node still
  resolves from the project's `node_modules`, so keep scripts inside the repo
  (`scripts/`), not in the scratchpad.
- `npm run build`, then `npx vite preview --port 4173`, and drive
  `http://localhost:4173/`. Load a PDF with
  `setInputFiles('input[type=file]', …)` — `tests/fixtures.ts` builds usable ones
  (12-page, 150-page, and an image-only "scan"). Test desktop (e.g. 1280×820) *and* mobile
  (390×844, `isMobile:true, hasTouch:true, deviceScaleFactor:3`) in both themes.
- **Listen for `console` errors, `pageerror`, 4xx responses, and off-origin
  requests** in any script you write. The mobile snackbar/zoom-pill collision and
  the CDN font were both invisible in the code and obvious the moment a script
  looked at the rendered geometry and the request log.
- Gotcha: single-key tool shortcuts are ignored while a `contentEditable` has
  focus, so after typing into an overlay click something neutral (or use the
  `.tooldock__btn[aria-label="…"]` buttons) before switching tools.

## Writing specs against shapes and rasters

- **Two traps when writing a spec against a shape or a raster.**
  `getBoundingClientRect()` on a *rotated* SVG element returns the rotated
  bounding box of the element's bounding box, not a tight fit of the path — for
  a diagonal glyph that reports a shape half again too tall, so comparing it
  against a pixel measurement of the exported file makes a correct exporter look
  broken. Rotate the element's own `points` instead. And a redacted page ships
  as a JPEG: the canvas exists and is *blank* until the image decodes, so
  `open()` returning is not enough to measure on — wait for the page to actually
  carry ink first.
