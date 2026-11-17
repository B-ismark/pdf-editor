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

- **The Inspector has two named tabs, not one surface with two moods.** It used to
  swap between the document actions and the selection's properties with nothing to
  say it had, so clicking the page made Compress/Watermark/OCR vanish with no way
  back. Selecting moves to Properties (that's what the click asked for);
  deselecting deliberately does *not* move back, or the panel would flip on every
  stray click. **A stamp is the exception**: stamps are edited on the canvas and
  have no controls in this panel, so moving there for one traded every document
  action for "Nothing selected" — clicking your own signature emptied the panel.
  `onSelect` skips the move for stamps (the selection-change effect already keyed
  on `panelSelection`, which is stamp-aware), and Properties names an image and
  says where to edit it rather than claiming nothing is selected.
  The tab strip is a *roving* tabstop, which means the arrow keys move focus and
  not just `aria-selected`: the unselected tab is `tabIndex={-1}`, so changing
  the selection alone leaves the keyboard on a control outside the tab order —
  the next Tab jumps somewhere unrelated and Space acts on the wrong tab. Focus
  moves synchronously, not in a `requestAnimationFrame`, because the next
  keystroke has to land on the tab this one moved to. The document actions also live in the ⋯ menu — deliberately, since
  on a phone the panel is a selection-driven sheet and the palette needs a
  keyboard — so the two must keep the *same* groups, order, names and icons; they
  both read from `docActions` and `DOC_GROUPS`.
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
  pure enhancement, while the Inspector's joint — the concave fillets that tie
  the selected tab to the panel, which is the only thing saying *which tab this
  panel belongs to* — is drawn with a `radial-gradient` mask instead. Masking
  the paint rather than the box costs nothing there because the fillets carry no
  border and no shadow; on a surface with elevation it would clip the shadow at
  the joint, which is the one thing the mask path can't do.
  **The joint hangs off the tab button itself** (`::before` / `::after`), not off
  a measured position, so there is no `ResizeObserver`, nothing to recompute on a
  font-size change, and nothing to fall out of sync. If you ever move it to a
  dock that floats free of its anchor, that stops being true and you inherit the
  whole stale-dependency problem the `PageView` memo note (`rendering.md`) describes.
  The tab strip is deliberately a shade *different* from the panel
  (`--surface-container` against `--surface-container-low`) — the joint is
  invisible if they match, and the fillets must stay the panel's colour.
  This replaced the underline indicator; the old note about a filled pill
  reading as a toggle still holds, which is why the selected tab is a *joined
  tab* rather than a floating pill.
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
  render the same doc actions — the Inspector, the ⋯ menu, the command palette —
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
  text style.
- **Theme** — `theme.css` holds M3 Expressive tokens; light is `:root`, dark is
  `:root[data-theme="dark"]`. An inline script in `index.html` sets the theme
  before first paint (no flash). `useTheme` cycles system/light/dark.
- **Finishing ops rebuild the document**, which bakes in (and resets) current
  edits — they call `bakeCurrent()` then reopen the result. Expected.
- **The app bar raises itself above the zoom pill while the ⋯ menu is open**
  (`.appbar--menu`, z 56). The menu lives inside the bar's stacking context
  (z 20), so no z-index on the menu itself can out-rank the pill (55); the
  bar stays below scrims and sheets (60+).
- **The page chip** (`PageJump`, in the zoom pill) reads `useActivePage`, which
  takes the document's identity as well as its page count — two tabs with the
  same count would otherwise keep observing the previous file's pages. The
  field opens empty with the current page as placeholder; out of range clamps
  to the document. "Go to page…" in the palette opens the same field.
- **Phone drawbar** is a two-row grid under 600px (tools 4×2 | colour, width,
  collapse), so all of it fits in 360px with 48px targets.
