# App shell: app bar, Inspector, menus, icons, shape and motion

_Read before touching `Icon.tsx`, the app bar, the Inspector, the ⋯ menu, the command palette, tooltips/popovers (`floating.ts`), `corner-shape`, easing tokens, the command registry (`commands`)/`TOOLS`, prefs or theme._

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
  tool's icon, take it from `TOOLS` (or the registry) — the command palette's
  hand-written copy of that list had already drifted.
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
  header & footer and watermark, each with its state, Add/Edit (opens the Finish
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
  ⋯ menu — on a phone the panel is a selection-driven sheet and typing in the
  palette is slow — read from the command registry by `MENU_GROUPS`.
- **Every command is declared once, in the registry.** `commands` in
  `DocumentEditor.tsx` (typed by `Command` in `CommandPalette.tsx`) is every
  action the app has: tools, Draw sub-tools, selection actions, undo/redo,
  find and go-to, view (pages, panel, zoom), document actions, exports,
  device settings, file and tab switching. The palette lists all of it; the
  ⋯ menu and the Export menu render their rows from it by `group`, through one
  `menuRow`. A command that doesn't apply right now is `hidden` (align with no
  group selected, the panel toggle on a phone); one that can't run *yet* is
  `disabled` (exports while a file is being made) — menus grey it, the palette
  leaves it out. Labels, icons, shortcuts, `opens`, `checked` and `value`
  live on the entry, so a menu row and its palette row can't differ; the
  palette's hand-kept list had lost zoom, the panel, align/distribute and
  "Save session", and called the pages toggle by another name. Each row
  carries `data-cmd`; `shell.spec` ("command registry") walks both menus and
  finds every row in the palette with the same label, icon and mark. A new
  button that does something the registry doesn't have is the drift starting
  again: add the command, then render the button's label from it or keep the
  two words identical. Buttons on the canvas (multibar, zoom pill, rail) still
  render themselves; only the lists are generated. A row's accessible name is
  its label: the hint beside it (shortcut or group) is `aria-hidden`, and the
  keys reach assistive tech as `aria-keyshortcuts`. Closing the palette puts
  focus back where it was *before* the command runs, so a command that moves
  focus wins and one that doesn't leaves it with the person. Its Escape stops
  there — the editor's Escape would otherwise drop the selection the
  Selection commands act on.
- **Download is a split button; Export holds every output.** Actions that make
  a file and leave the document alone (Compress, Sign with certificate, Export
  as images, Export text, and Download all with several tabs) are
  `group: "export"` in the command registry. `MENU_GROUPS` leaves that group out, so the
  Inspector and the desktop ⋯ menu don't list them; the caret beside Download
  (`Export options`, `aria-haspopup="menu"`) opens them, with "Download PDF"
  first. A phone has no width for a second control in the bar (the `shell.spec`
  360px budget), so there the caret is not rendered and the export group heads
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
  action that opens a dialog carries `opens: "dialog"` in the command registry; a tool
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

- **Chrome hierarchy (10b).** Frame, heading, control — each in its own voice.
  - The app bar drops its bottom rule when the tab strip follows it
    (`.appbar:has(+ .doctabs)`): one surface, the tabs its lower row. The
    strip's own rule is the one the active tab breaks.
  - `.label-small` exists now (theme.css). The ⋯ menu's group labels named it
    before it did, so they fell back to body size in capitals — louder than the
    items. Labels are sentence case, smaller and lighter than rows.
  - `.menu__list` scroll shades: two `local` covers in the menu's own colour
    over two `scroll` shades. The covers travel with the content and hide the
    shade at whichever end you're at. Its `background` is that whole stack —
    keep the colour as its last layer if you change it.
  - Inspector rows: `.props .field` is a grid, label in a 76px column, the
    control starting beside it — the same column the Document facts use. Wide
    controls (segmented, size row, slider, inputs) stretch; the rest sit at
    the start. A value in a label (`<b>`) takes the label's weight. Quiet
    actions (`.btn--text` in `.props__row-actions`) sit in the control column.
    `.props` is a size container: at 264px of content or less (the 288px
    Inspector of a 600–839px window; the 320px one stays above it even with a
    15px scrollbar, which headless tests hide — see `hierarchy.spec`) labels go above their controls, which take the
    whole width — beside them, the slider was 75px and "Web address" wrapped.
    `.props .slider` zeroes the range input's own 2px margin.
  - The scroll shade's colour is `--scroll-shade` (theme.css), much stronger
    in dark: 16% black on a dark surface was a step of a few levels.
  - Phone Download: a 44px hit area painting a 40px chip (`background-clip:
    content-box`), the size of ⋯ beside it. Not 48px: at 360px the bar's row
    is exactly full (see the phone rule).
- **Organise's per-page controls (10c).** Hidden at rest only under
  `(hover: hover) and (pointer: fine)`, and by opacity, never by `display`, so
  a card doesn't change height as they come: under the pointer, on picked
  pages, and in the card the keyboard is in (`:focus-within`, so Tab and
  Shift+Tab reach them). `(any-pointer: coarse)` puts them back: a touch
  laptop hovers like a desktop, but a tap on an invisible Delete deleted the
  page — and hiding them on a phone (`visibility`) took them out of the
  accessibility tree and lost them after every move, since a move clears the
  pick. After a move or delete, focus goes back to the moved page's same
  control (or the next page's button): the card remounts, so focus fell to the
  body. Page buttons are named "Page N"; the pick mark is `check`, not `add`.
- **Dialogs (10d).**
  - Where focus lands on opening (`useModal`): where a child's `autoFocus`
    already put it; else a control marked `data-autofocus` (the crop frame);
    else the first field; else the dialog box itself (`tabIndex={-1}`, no ring
    drawn on it). Never "the first focusable" — Close leads the markup, so that
    put a ring on "close" for anyone arriving by keyboard, and Enter closed it.
    A "field" is a place to type, a `<select>`, or a radio group's *checked*
    radio — not a checkbox or slider (Sign opened on "Remember this signature",
    below the pad), not an unchosen radio. With a coarse pointer, places to type
    are skipped: focusing one raises the on-screen keyboard over a dialog not
    yet begun. So a dialog marks its field `data-autofocus`, not `autoFocus`
    (which runs first and can't be told) — Download with password and Sign with
    certificate did. The password to open a locked file keeps `autoFocus`:
    typing it is all that dialog asks.
  - **Opening a dialog must not change it.** A field that acts on focus is
    marked `data-autofocus` on the spot that leaves things as they were:
    Header & footer's chips type into the slot last focused, so it opens on
    that slot (Footer, centre); Split's page-count box switches to "Every" on
    focus, so with pages picked it opens on the "Before each picked page" radio.
  - Focus goes back to the opener on close. `useModal` reads the opener while
    rendering: by its effect a child's `autoFocus` has moved focus inside, and
    restoring to that removed field dropped focus onto the page. A dialog
    closing while another has already taken focus (Download with password
    handing on to the covered-text warning) leaves focus there and hands its
    opener on (`handedOn`); the new one adopts it when its own opener — a
    button in the dialog now gone — is disconnected. With neither (an opener
    gone and nothing handed on), it falls back to whatever held focus when its
    effect ran, if that's outside the dialog.
  - **A scrim closes on press, and the press lands nowhere** (`scrimPress`):
    closing on pointerdown removes the scrim, so the mousedown that followed
    reached the page behind and took focus off the opener just restored.
    Every scrim cancels its pointerdown. A finger's tap sends its click
    anyway, onto whatever was under the backdrop, so a touch or pen press also
    swallows that click — only a real one at the spot pressed, within 600ms.
    The guard stands down on `pointercancel` or a lift elsewhere: a swipe
    sends no click, and an armed guard took the next real tap instead.
  - Closing a tab from its "Discard & close" warning puts focus on the tab
    now in front (the tab itself), not the page.
  - Titles are `<h2 className="headline-small dialog__title">` (24px), every
    dialog alike. Compare and Organise are full-screen surfaces with a bar
    title, and keep `title-large`.
  - Disabled `.btn` uses Material's disabled roles (on-surface 12% fill, 38%
    label, no hover), not opacity — at 55% a filled button was itself, faded.
    Except a button at work (a `.spinner` child): it keeps its own colours, so
    the spinner shows and "Exporting…" reads as under way. The split button's
    caret (`aria-disabled`, so focus isn't dropped) matches its Download half.
  - The palette files rows under their group's heading (`role="group"` in the
    listbox, groups in registry order); the right-hand column is a `<kbd>` for
    a shortcut and nothing else. Arrow keys walk the flattened rows in the
    order shown; moving by the arrows onto a group's first row scrolls its
    heading into view too (not on hover — the list would slide under the
    pointer). Hover follows `pointermove` with a real change of position, not
    `pointerenter`: a row scrolled under a resting pointer fires an enter, and
    that took the active row back from the arrows.
    The input is a `combobox` whose `aria-activedescendant` names the active
    row; headings are `aria-hidden` (each group is labelled by its heading).

- **The welcome (10e).** A greeting, not a form field: no dashed box at rest
  (that is how an upload field looks), the privacy promise as the headline
  ("Your PDFs stay on this device", the `on_device` icon), one short line, the
  button. **Few words**: how to use it is shown, not written.
  - The drag hint ("or drag & drop files here", which a phone was told too) is
    gone. The handlers sit on the welcome's whole `.app` (the app bar too, as
    in the editor), and while a drag *carrying files* is over it a solid
    "Drop to open" surface covers the window (`position: fixed`, so a scrolled
    welcome doesn't leave it hanging off the top). A dragged text selection
    shows nothing. `dragleave` into one of its own children isn't leaving
    (checked with `relatedTarget`), or the surface flickered.
  - The button says "Choose PDF or photos": that line was the only place
    starting a document from pictures was mentioned. Its icon is `open_file`
    (a folder), not the upload arrow — under "No uploads" that contradicted the
    headline.
  - The restore offer and the welcome are one centred group
    (`align-content: center`); the column is `minmax(0, 1fr)` so the offer's
    min-content can't widen it past a phone (it scrolled sideways, clipping the
    headline). Its three buttons are one group
    (`.restore-banner__actions`) that moves below the text whole on a phone,
    never Restore beside the text and the other two under it (at 320 px that
    takes the welcome's padding down to 16 px: the three need 245 px). A list
    or a long name, cut short, carries the full names as a tooltip.
  - While a dialog is open (the password prompt from a first drop), a file
    over the window gets `dropEffect = "none"` and no surface, in the welcome
    and the editor alike: `openFiles` would refuse it behind the scrim. The
    dragover is still cancelled, or the browser would open the file itself.
  - The visible loading and error lines are `aria-hidden`; persistent `sr-only`
    `role="status"` / `role="alert"` regions announce them, as in the editor —
    a region that mounts with its text already in it often isn't read out.
  - Lines use `text-wrap: balance`, so none ends on one word.
- **A page at a reading width (10a).** The fit is capped at the page's printed
  size (`ACTUAL_SIZE` in `useViewport`, 96/72): on a wide window an A4 page is
  794px, centred, with margin — not stretched to the window. Below that it
  fits the room it has, and the room is *observed* (a ResizeObserver on the
  scroll surface), so opening Pages or the Inspector refits rather than leaving
  the page's right edge under the panel; the scroll is anchored so the reader
  stays on the same page. The old "never refit on a panel toggle" rule was there
  to stop a jump — the cap does that now on wide windows, where a panel only
  moves the margin. Below the cap (a 1024px laptop) showing or hiding the
  Inspector does rescale the page: a page cut off under a panel was judged the
  worse of the two. The scroll is anchored at the top-left (the page you were
  on stays in front); sideways, to where the reader had it before the room
  changed — the browser clamps `scrollLeft` before the observer runs, so the
  anchor is taken from the last scroll at the measured width (`across`).
  - The toast's bottom-left place is the *window's* corner: with Pages open
    that is the sidebar's last thumbnail, so it goes back to centre-above-the-
    cluster then; and a phone's open draw bar is two rows (three at ≤359px),
    so the toast steps up to 196px (240px) over it.
  - **Anything scrolled into view stops clear of them** (`scroll-padding` on
    `.viewer__scroll`: the dock's band at the bottom, the pill's at the top on
    a narrow viewer). With the pill in the dock's row, an object brought into
    view at the bottom edge was under it, and a click there hit the pill.
    So a page from the thumbnails or Go to page lands 16px (72px narrow)
    below the top, and PageDown steps by the padded height. Find and the zoom
    anchors set the scroll directly and don't see it.
  - The sideways anchor (`across`) is just a fraction, dropped when the surface
    goes behind another document (it returns scrolled to its start, silently).
    Don't gate it on `scrollWidth` matching: that never reads less than the
    room, and `.doc`'s padding steps from 16px to 24px at 840px, so it moves
    with the room alone — a check on it threw good places away (the view went
    to the left edge on a phone turned sideways).
  - **The floating controls leave the page's opening lines clear.** On a viewer
    ≥880px wide (a container query) the zoom pill joins the dock's row at the
    bottom-right; narrower, it keeps the top-right and `.doc` starts 72px down,
    below it. The status toast is bottom-left at ≥1280px windows, above the
    bottom cluster on phones (top again only while the properties sheet holds the
    bottom, `:has(.viewer__scroll--sheet)`), and says what opened in plain words
    ("Opened · 150 pages") — the parse count ("3750 text fragments") is gone.

- **One owner for the app's history entries (`useModal`).** Dialogs push an
  entry so Back closes them, and the editor's phone layer (Back puts the
  selection / sheet / edit away) pushes one too — both through `pushHistory`
  / `unwindHistory` / `onStrayBack`, never `history.*` directly. One
  `popstate` listener: our own removals are *counted* (two closing in one
  render are two pops); a push made while a removal is in flight waits for it
  (Chrome lands a queued `back()` *after* a following `pushState`, dropping
  the new entry — the dialog that opened then steps out of the app when it
  closes); a real Back goes to the top dialog, and only with none open to the
  editor's layer. Before, the editor's own listener took a dialog's removal
  for Back, and a deselect in the same render as a dialog opening closed the
  dialog at once. `protect.spec` guards both.

- **Save in place, Save as, Share, Print (8c)** live in `fileAccess.ts` and
  `print.ts`; each is optional, asked for (`canOpenInPlace`, `canSaveAs`,
  `canShareFiles`) and falls back — the file input to open, a download to save.
  The Export rows hide when the browser can't (`hidden`), never show disabled.
  - A file's *handle* (`OpenDoc.handle`) comes only from `pickFiles` (Ctrl+O /
    Choose PDF on Chromium) or Save as, is memory-only and is lost on restore.
    Pictures never get one — saving a PDF over a JPEG. A rebuild that replaces
    the tab (Organise) keeps it. Picking a file that's already open
    (`isSameEntry`) goes to its tab: two tabs on one file save over each other.
    For the same reason Save as refuses a file another tab has open
    (`openElsewhere`); onto its *own* file it is Save, and a password-opened
    file gets the same warning. Files are read with `allSettled`: one that's gone
    doesn't cost the rest, and is named *after* they open (or the load
    message talks over it).
  - `handleLocked`, not `locked`, decides the "Save without its password?"
    warning: it's about the file on disk, and clears once that's written
    (in place or Save as). `locked` stays — it keeps the unlocked copy out of
    the browser's storage.
  - Save / Save as / Print / Share run one at a time (`exclusive`, a ref set at
    once — the busy status lands a render later); a held Ctrl+S is one save.
    On a Mac only ⌘ — Ctrl+P there is "caret up" in text. Under a dialog Ctrl+S
    is swallowed (no "save web page"), Ctrl+P left to the browser.
  - Share does **not** mark the document saved: a share target may keep nothing.
  - Permission is asked (`mayWrite`) **before** the export: the prompt needs
    the click, and a long build outlives it. Share can't do that (the file must
    exist first), so a `NotAllowedError` becomes the "Ready to share"
    dialog, whose button is the fresh tap.
  - Ctrl+S / Ctrl+P are taken from the browser only while a document is open
    (its own "save page" / "print page" would save or print the app).
  - Saved in place sets `SavedMark.inPlace`: the counter reads "Saved", and
    closing doesn't ask (the write finished; a download might not have).
  - Print draws its own raster pages into `#print-root` and hides the app under
    `@media print` — no iframe (needs a CSP change, and a built-in viewer
    phones lack). The hiding keys on a `printing-doc` class on `body`, set
    only while the pages are there (not `:has`, which older engines drop
    whole — the app then prints itself), so a print the
    browser starts itself still prints the screen, not blank paper. Each page
    size gets a named `@page` (`page:` on its image) in a constructed sheet, so
    a landscape page gets a landscape sheet. Pages go on `afterprint` or when
    print media ends, whichever comes.
  - Playwright gets no `filechooser` for `showOpenFilePicker`, so a spec that
    opens through the input on Chromium deletes it first (`tabs.spec` Ctrl+O),
    and `saveto.spec` stubs the pickers.

- **Header & footer is the old page numbers, grown.** Six places (three in
  the header, three in the footer), each a line of text with tokens —
  `{page}`, `{pages}`, `{date}`, `{file}`, `{bates}` — filled in per page by
  `pdf/headerFooter.ts` (`labelsFor`). That one resolver feeds the on-page
  preview (`FinishPreview`), the dialog's "Page 1 reads" line and the exporter,
  so none of them can disagree; the margin (`HF_MARGIN`) is shared the same
  way. It's still stored as `DocState.pageNumbers` with the same type: a
  setting without `slots` (any session from before) reads as `"{page}"` at
  its `position`, and the Inspector still calls that "Bottom centre · from 1".
  `{pages}` is the *last page's number* (start + count − 1), so "Page 3 of 7"
  holds when numbering starts elsewhere. `{date}` and `{file}` are fixed into
  the setting at Apply — the preview, every page and a later export (or a
  restored session, or a renamed file) read the same thing. Update keeps them
  too, unless the person ticks "Use today's date and this file's name" (shown
  only when that would change a page) — but only a value that was *on* the
  pages is kept: Apply stores a date even for a "{page}" setting, and adding
  `{date}` months later must not surface that never-shown one. The date is
  written in the reader's language only when Helvetica can draw it
  (`dateLabel`: "18 novembre 2026"), in English otherwise — a Japanese or
  Russian date would reach the file as fragments while the preview showed it
  whole. Bates is prefix + a zero-padded count from its own start, one per
  page as arranged, and keeps counting past its digits rather than wrapping. Text
  goes through `sanitize` like a watermark: a character Helvetica can't write
  is dropped and reported, not drawn as "?". Token chips in the dialog take
  `preventDefault` on mousedown so the caret stays in the place being typed,
  and put the caret back in the same task (`flushSync`), not a frame later —
  a fast keystroke in between lands at the end. The number fields hold what
  was typed and clamp on blur; clamping per keystroke made "6 → backspace → 2"
  read 12. The preview places each label by its *baseline* (`text-box:
  trim-end text alphabetic` makes the span's bottom the baseline): the
  exporter's footer baseline is on the margin, the header's a text size below
  it. Stored values are read defensively (`slotsOf`, `firstNumber`): restore
  doesn't validate `DocState`, and a non-text slot must not stop the page
  rendering, nor a non-numeric size the export. The dialog opens on the same
  reading (`normalBates`), so Update with nothing touched renumbers nothing;
  it keeps the stored text size too, having no size control of its own. Both
  first numbers (page and Bates) cap at `MAX_START`, twelve digits — page and
  dialog alike, and far enough below 2^53 that no two pages share a number.
