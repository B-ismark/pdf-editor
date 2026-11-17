# App shell: app bar, Inspector, menus, icons, shape and motion

_Read before touching `Icon.tsx`, the app bar, the Inspector, the ⋯ menu, the command palette, tooltips/popovers (`floating.ts`), `corner-shape`, easing tokens, `docActions`/`TOOLS`, prefs or theme._

Moved verbatim from `CLAUDE.md`; the index there links here.

## Gotchas

- **An icon name means one thing, and it has to exist.** `Icon` takes a
  `name: string` and falls back to a bare `Square` when it isn't in the map — so a
  typo renders an empty box with no error anywhere, which is how `name="sliders"`
  shipped as a blank square on the Inspector's collapsed tab. Worse than a plain
  icon is a *reused* one: `RotateCw` once stood for rotating a page, restoring a
  session, saving one, and resetting a style, and `Shrink` stood for "compress"
  *and* for the switch that turns compression off. Add a key per meaning, name it
  for the meaning rather than the picture, and let `icons.spec.ts` catch the three
  failure modes it can see: unmapped names, dead keys, and two names resolving to
  the same component without an entry in `SHARED_GLYPHS`. If a call site needs a
  tool's icon, take it from `TOOLS` — the command palette's hand-written copy of
  that list had already drifted.
  **What no spec catches: glyphs that are different components and the same
  picture.** Lucide's `Pen` and `Pencil` share one body path (a 4px tip stroke
  apart) and `PenLine` adds an underline to it — three components, one drawing at
  20px, and the first rewrite of this map used all three plus `Pencil` twice.
  Render every mapped glyph onto one sheet and look at it before you're done;
  reading the map will not show you this.
- **The app bar has a width budget, and the primary action never pays it.** Eight
  48px controls do not fit a 390px phone. `.appbar__download` carries `flex: none`
  like every `.icon-btn` around it, because when it didn't, all of the overflow
  came out of it: Download measured 14×44 at 390px and 0×44 at 360px, where the
  row overflowed regardless. Anything new in that row has to displace something
  (preferences belong in the ⋯ menu), and `shell.spec.ts` fails at 360px if the
  row can't fit itself.
- **The app bar's two ends are sized against each other.** Download was 130×44
  in a 52px row — 85% of the bar's height and wider than everything else in it —
  next to a bare 48px glyph for the ⋯ menu that holds every document action there
  is: the loudest control in the row beside the quietest, which is how "where is
  everything else?" happens. Download is a 38px compact pill on a pointer and
  stays 44px icon-only on a phone (the touch floor is not negotiable), and the ⋯
  gets a container. That container is painted on the button's *content* box
  (`padding: 4px` + `background-clip: content-box`), so the chip is 40px inside a
  48px hit area. Don't reach for an absolutely-positioned `::before` — a
  positioned pseudo-element paints *above* the icon, which shipped once as an
  empty grey disc. `tests/shell.spec.ts` covers both ends.

- **The Inspector has one job: describe.** With something selected it shows
  that thing's properties; with nothing selected, the *document's* properties
  (`DocumentPanel.tsx`): file, page count, page size (named paper where it
  matches, "Mixed · N sizes" otherwise), whether the text is searchable (with
  "Recognise text (OCR)" when some pages have none), the every-page layers —
  page numbers and watermark, each with its state, Add/Edit (opens the Finish
  dialog) and Remove (an undoable edit) — and the lossless-redaction export
  setting. Deselecting (Escape, or a click on empty page) is the way back.
  It used to be two tabs, Document (a list of actions) and Properties, because
  swapping a list of *commands* out from under the user on every click lost
  them. That reason went away when the commands moved to where they act: outputs
  to Export, page work to the Pages sidebar, the rest to the ⋯ menu and the
  palette. What swaps out now is a description, which is what Figma and every
  design tool does with nothing selected. A stamp still counts as a selection:
  it has no controls here, so the panel names it "Image" and says how it is
  edited on the canvas. Both views carry "Hide panel" in their heading, which is
  sticky so it stays reachable in a long panel. Every title is an `h2`, so
  heading navigation finds the panel whatever it shows; a marquee of several
  objects gets its own short panel ("2 objects selected"), not the document's.
  "Lossless redacted pages" is an *app* setting (`pref.losslessRaster`, every
  export on the device), so it lives with the other settings in the ⋯ menu at
  every width and in the palette; the Inspector mirrors it under "Export setting ·
  this device", labelled and described as such, because it changes what this
  file exports. OCR from the panel reads only shown pages with no text of their
  own (a second, recognised copy over real text doubles every word) and marks
  each page it read (`PageData.ocrRead`), so the offer goes once nothing is left
  — a page OCR *failed* on stays offered. The Text fact never says "scanned": a
  blank or vector-only page has no text either. The document actions also live in the
  ⋯ menu — on a phone the panel is a selection-driven sheet and the palette
  needs a keyboard — read from `docActions` and `DOC_GROUPS`.
- **Download is a split button; Export holds every output.** Actions that make
  a file and leave the document alone (Compress, Sign with certificate, Export
  as images, Export text, and Download all with several tabs) are
  `group: "export"` on `docActions`. `DOC_GROUPS` leaves that group out, so the
  Inspector and the desktop ⋯ menu don't list them; the caret beside Download
  (`Export options`, `aria-haspopup="menu"`) opens them, with "Download PDF"
  first. A phone has no width for a second control in the bar (the `shell.spec`
  360px budget), so there the caret is not rendered and `EXPORT_GROUP` heads
  the ⋯ menu instead (Download all included). Both menus share `menuKeys`
  (arrows, Home/End, Escape back to the opener, Tab closes); it stops the
  event, so Delete or an arrow in an open menu never reaches the selection on
  the canvas, and a modified key closes the menu and goes through. Picking an
  item focuses the opener *before* the item runs, so a dialog it opens hands
  focus back there. The caret is `aria-disabled`, not `disabled`, while busy:
  it is where focus lands as a download starts. Either menu lifts the bar to
  `.appbar--menu` (over the zoom pill), and Export closes on busy, on the
  palette and on crossing to phone width.
- **Floating chrome has to be clamped to the viewport.** `TooltipHost` centres its
  bubble on the anchor with `translate(-50%)`; without the layout-effect clamp,
  every control at a screen edge (the collapsed Inspector tab, the ⋯ button on a
  phone) got a tooltip drawn half outside the window. Same class of bug as the
  overflow menu having no `max-height`, which left its last two items unreachable
  on an 820px window.
  The maths is `src/floating.ts` now, shared by the tooltip and `ColorField`,
  because the popover had its own version of it and got it wrong: `top =
  min(anchor.bottom + 6, innerHeight - 200)` — a hardcoded height and no flip —
  put the palette over 11,760px² of the draw toolbar it belongs to and up to
  10,976px² of the tool dock below, i.e. the two controls you reach for next, and
  on a 390×844 phone its bottom edge landed 3.5px from the screen. `placeAnchored`
  measures the surface, flips it above when it doesn't fit below, and takes a
  `clear` rect — the *toolbar the anchor sits in*, since clearing the 40px swatch
  still leaves you inside the 60px bar around it. `tests/chrome.spec.ts` asserts
  zero overlap with either bar at three widths.
- **Shape carries state, so it has to render everywhere.** `corner-shape`
  (`squircle`, `scoop`, `notch`, …) is Chromium-only and is *silently* ignored
  elsewhere — no error, no fallback, just the plain radius. That makes it safe
  for softening a shape the app already has and unsafe for anything that means
  something. The split is enforced by `shape.spec.ts` and is the reason the two
  look different in the source: the squircle pass is one `@supports` block of
  pure enhancement. Anything that needs a cut corner to say something has to be
  masked (a `radial-gradient` mask renders everywhere), never `corner-shape`d.
  (The Inspector's joined tab was the one such case; it went with the tabs.)
- **`corner-shape` never touches the document.** Not `.page`, not
  `.page__canvas`, not `.page__overlay`, not the thumbnails. Every pixel inside a
  page is a claim about what `exporter.ts` will write, and a corner the exported
  PDF does not have is a lie told in the one place this app can't afford one.
  Chrome can be soft; the document is reportage.
- **Motion is springs now, not one bezier.** `--ease-spring` used to be a
  cubic-bezier commented as a "springy overshoot approximation", and a bezier
  can't be anything else — it overshoots once and stops, where a spring
  overshoots and *settles*, and the settle is the part that reads as physical.
  It is a `linear()` spring now, and there are two schemes because a bounce that
  suits a tab pill is wrong on a dialog: `--ease-spring` rings visibly,
  `--ease-settle` arrives without ringing. Both work in every current browser.
- **"This opens something" is declared on the data, not the call site.** An
  action that opens a dialog carries `opens: "dialog"` on `docActions`; a tool
  that opens a toolbar or dialog carries `opens` on `TOOLS`. Three surfaces
  render the same doc actions — the ⋯ menu, the Export menu, the command palette —
  and deciding per call site is exactly how they drifted apart last time.
  The visible mark is decorative in both cases; the fact reaches assistive tech
  through `aria-haspopup="dialog"` or, for the drawbar, `aria-expanded` +
  `aria-controls="drawbar"` (a disclosure the tool owns, not a popup). Don't put
  a mark on an action that runs immediately — it promises a dialog that never
  arrives, which is worse than no mark.
- **No native UI.** Use the in-house `ConfirmDialog` (not `confirm()`),
  `ColorField` (not `<input type=color>`), and `TooltipHost` + `data-tip=`
  (not `title=`). `ColorField`'s popover is **portaled to `document.body`** —
  needed because a transformed ancestor (e.g. the centered `.drawbar`) would
  otherwise capture its `position: fixed`.
- **Persisted prefs** live in `localStorage` via `hooks/usePrefs.ts`
  (`pref.drawTool`, `pref.drawStyle`, `pref.textStyle`) and `useTheme.ts`
  (`theme`), `useSignatures.ts` (`signatures`). New text boxes inherit the last
  text style. A signature reaches `signatures` only when the dialog's
  "Remember this signature on this device" is ticked — off by default, and
  it stays a per-signature choice rather than a remembered preference. Unticked
  doesn't mean "nothing on the device": a placed signature is a stamp in the
  document, so the session copy holds it, and the dialog's hint says so.
- **Theme** — `theme.css` holds M3 Expressive tokens; light is `:root`, dark is
  `:root[data-theme="dark"]`. An inline script in `index.html` sets the theme
  before first paint (no flash). `useTheme` cycles system/light/dark.
- **Finishing ops rebuild the document**, which bakes in (and resets) current
  edits — they call `bakeCurrent()` then reopen the result. Expected.
- **The app bar raises itself above the zoom pill while the ⋯ menu is open**
  (`.appbar--menu`, z 56). The menu lives inside the bar's stacking context
  (z 20), so no z-index on the menu itself can out-rank the pill (55); the
  bar stays below dialogs (70), the palette (75) and tooltips (90); the sheet
  scrim (25) already covers it, so the menu can't open over a sheet.
- **The page chip** (`PageJump`, in the zoom pill) reads `useActivePage`, which
  takes the document's identity as well as its page count — two tabs with the
  same count would otherwise keep observing the previous file's pages. The
  field opens empty with the current page as placeholder; out of range clamps
  to the document. Enter/Esc hand focus back to the chip (blur doesn't).
  "Go to page…" in the palette opens the same field; on a phone, where the
  pill hides behind a selection or the find bar, it clears those first, and a
  hidden pill closes the field so it can't reopen on its own later.
- **Phone drawbar** is a two-row grid under 600px (tools 4×2 | colour, width,
  collapse), so all of it fits in 360px with 48px targets. Under 360px the
  tools take the full width and the style controls go in a row beneath; the
  bar spans the screen there (`left/right: 12px`), because centred with
  `left: 50%` it only gets half the screen to lay out in.
- **The app can be updated under an open page.** On-demand parts (dialogs,
  exporter, signing, OCR) are hashed files a deploy deletes. Load them with
  `lazyPart` (`src/staleBuild.ts`), never bare `React.lazy`: a part whose file
  can't be fetched becomes a stub that closes itself and raises the banner
  (`UpdateBanner`), instead of the rejection unmounting the app. In a `catch`
  that turns a failure into a message, try `staleBuildMessage(err)` first.
  The banner tells a deploy from a dropped connection (`diagnose`: the file
  404s on a no-store re-request → "was updated"; otherwise "couldn't load —
  check your connection") — Chromium caches a failed module fetch, so either
  way only a reload brings the part back. Only *fetch* failures count:
  `vite:preloadError` fires for every rejected import, a module that threw
  while starting included, so it's filtered with `isStaleBuildError`. Don't
  `preventDefault()` it — Vite then resolves the import to `undefined`.
  The banner sits in flow above the app bar (never over the tabs, zoom pill
  or find bar). Its Reload flushes autosave first (bounded at 3 s) and skips
  the browser's leave prompt when nothing is at risk; if the save fails it
  says so and offers "Reload anyway". `CrashScreen` (in `main.tsx`) is the
  last resort for anything else that throws during render; its Reload flushes
  through `flushAutosave()` (module-level — the app has unmounted), and its
  copy promises a restore only if "Save session on this device" is on.
  Autosave runs one save at a time (`inflight` chain), so a flush can't be
  overtaken by an older write. The deploy also carries the last five builds'
  assets forward (`scripts/carry-assets.mjs`) and always records the build
  that's live, so this is rare.
- **The picture-page hint** (`.picturehint`) appears the first time a Select
  *click* (not the press that starts a scroll, pan or drag; primary button;
  on the page itself, not on a box placed on it) lands on a page with no text
  fragments, and offers OCR. The wording doesn't claim the page *is* an image —
  blank and vector-only pages have no fragments either. Dismissed or acted on,
  it stays away for that tab for the page's lifetime (`hintSettled`, module
  level — the editor remounts on every tab switch). It's laid out against the
  viewer (a container query), not the window: beside the zoom pill when the
  page area is wide enough, below it when not, centred on phones where the
  pill steps aside.
