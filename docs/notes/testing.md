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
  window and every row is one line, the Inspector names both of its jobs and keeps them reachable,
  a tooltip on an edge control stays on screen, and counts read as English;
- `icons.spec.ts` — every `name=` in `src/` is mapped (an unmapped one renders a
  blank square, silently) and every mapped name is used;
- `marks.spec.ts` — a tick is placed by a *tap* (a checkbox is smaller than the
  drag threshold), a drag sizes it instead, both cross strokes are drawn, a mark
  gets the same resize frame as any other box, the glyph reaches the exported
  bytes rather than living only in the overlay, a *rotated* mark exports at the
  angle the overlay drew, a mark survives its page being rasterised for
  redaction, and the tool's gesture hint is un-occluded while a ghost of the mark
  follows the cursor;
- `affordance.spec.ts` — the Inspector, the ⋯ menu and the command palette mark
  the *same* set of actions as opening something, an action that acts
  immediately carries no mark, and a tool that opens something declares which
  kind (`aria-expanded` for a disclosure, `aria-haspopup` for a dialog);
- `shape.spec.ts` — the selected tab's joint is masked rather than
  `corner-shape`d (so it renders off Chromium), the fillets are painted in the
  panel's colour and not the strip's, shape follows the selection, and no
  chrome geometry reaches `.page` / `.page__canvas` / the thumbnails;
- `fragment.spec.ts` — an edit's overlay text (and a text box's) starts at
  exactly the x the exporter draws it at, with no horizontal padding anywhere in
  the chain, and a selected fragment is marked by rules above and below rather
  than a ring whose vertical edge reads as a letter;
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
  live text in *any* tab; and closing a tab by keyboard keeps focus on the strip;
- `saved.spec.ts` — a download is a save: it clears the counter, the tab's
  dot, the leave prompt and the close prompt; the next edit brings all four
  back and undoing to what was downloaded clears them again; the saved state
  travels with a tab to the background; Download all saves every tab it
  zipped; and a signature is stored on the device only when "Remember this
  signature" is ticked, and can be removed;
- `password.spec.ts` — a password-protected PDF asks in-app, says a wrong
  password is wrong without losing what was typed, opens with the right one,
  and downloads as a plain PDF with its text (no `/Encrypt`); cancel opens
  nothing; an owner-locked file opens without asking and its download is
  readable (it wasn't); and a password-opened document never reaches the
  autosave store. Fixtures are encrypted with `@cantoo/pdf-lib`;
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
