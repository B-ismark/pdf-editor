# CLAUDE.md

Guidance for AI coding sessions working in this repo. Read this first — it
should save you from re-scanning everything.

## What this is

A **fully client-side, in-browser PDF editor** (React + TypeScript + Vite).
Upload a PDF and edit text in place, add text/notes/shapes, sign, redact,
organize pages, and download. **No server, no uploads** — privacy is the point.
Deployed as a static site to GitHub Pages: https://b-ismark.github.io/pdf-editor/

See `README.md` for the user-facing feature list and the detailed
"Limitations" section (fonts approximated, redaction rasterizes the page, no
password encryption, etc.). Don't duplicate that here.

Two audits are on record and worth skimming before changing anything they
touched: `docs/UI-UX-AUDIT.md` (usability, accessibility, platform conformance —
**Part 3** is the shell review of the app bar, rail, Inspector, menu and icon set)
and `docs/PRODUCT-AUDIT.md` (privacy, security, performance, export integrity —
including measurements, and the one finding deliberately left open).

## Commands

```bash
npm install
npm run dev        # Vite dev server
npm run build      # tsc -b && vite build  → dist/   (run this before committing)
npm run preview    # serve dist/ (defaults to :4173 with --port)
npm run typecheck  # tsc -b --noEmit
npm test           # builds, then runs the Playwright end-to-end suite against dist/
```

There is **no unit-test runner / linter** configured. Verification is
`npm run build` (which type-checks) plus **`npm test`** — which *also* builds,
deliberately: the suite serves `dist/`, so running it after a source edit without
rebuilding exercises the previous bundle and reports a confident green. That is how
a renamed button label passed locally and failed in CI. Invoking `playwright test`
directly to iterate on one spec skips the rebuild — build first. It is a Playwright suite
(`tests/`, `playwright.config.ts`) that serves `dist/` and drives it in real
Chromium. `.github/workflows/ci.yml` runs both on PRs into `main` and on `main`
itself (deliberately *not* on every branch push — a PR branch lives in this repo,
so that matched both triggers and ran the whole suite twice per commit);
`deploy.yml` handles Pages separately. **Run both before committing.**

`tests/app.spec.ts` covers feature behaviour. The rest cover the invariants
type-checking can't see, and each exists because it broke once:

- `privacy.spec.ts` — no off-origin request or `<link>`; CSP present, restrictive,
  and not silently widened; autosave stores a session and the toggle erases it;
- `rendering.spec.ts` — the render window stays bounded on a 150-page document,
  doesn't grow while scrolling, and the page you scroll to is actually painted;
- `export.spec.ts` — an unsafe link URL is flagged in the UI and absent from the
  exported bytes, no authoring metadata is written, a redacted page has no
  extractable text while its neighbour keeps its own, the redaction raster is a
  JPEG (and the lossless switch really turns that off), "Keep text" shrinks a
  flate-compressed image without costing the page its text, it never rewrites a
  soft mask, and an image whose `/DecodeParms` it can't read is left alone;
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
- `shell.spec.ts` — the app bar fits its own controls at 360/390/430px with the
  primary action at full size, the overflow menu ends inside the window and every
  row is one line, the Inspector names both of its jobs and keeps them reachable,
  a tooltip on an edge control stays on screen, and counts read as English;
- `icons.spec.ts` — every `name=` in `src/` is mapped (an unmapped one renders a
  blank square, silently) and every mapped name is used;
- `marks.spec.ts` — a tick is placed by a *tap* (a checkbox is smaller than the
  drag threshold), a drag sizes it instead, both cross strokes are drawn, a mark
  gets the same resize frame as any other box, and the glyph reaches the
  exported bytes rather than living only in the overlay;
- `affordance.spec.ts` — the Inspector, the ⋯ menu and the command palette mark
  the *same* set of actions as opening something, an action that acts
  immediately carries no mark, and a tool that opens something declares which
  kind (`aria-expanded` for a disclosure, `aria-haspopup` for a dialog);
- `shape.spec.ts` — the selected tab's joint is masked rather than
  `corner-shape`d (so it renders off Chromium), the fillets are painted in the
  panel's colour and not the strip's, shape follows the selection, and no
  chrome geometry reaches `.page` / `.page__canvas` / the thumbnails.

If you add a feature that touches privacy, the export bytes, or per-page
rendering, add a spec for it — that's where this project's real invariants live.
Fixtures are generated at run time in `tests/fixtures.ts`; shared page helpers
(request/error watching, opening a doc, canvas stats) are in `tests/helpers.ts`.
See `docs/PRODUCT-AUDIT.md` for the findings behind each spec.

## Architecture

- **Render path** — `pdf/loader.ts` uses **PDF.js** (`pdfjs-dist`) to rasterize
  each page to a `<canvas>` and extract text fragments (position + a *generic*
  font family). The pdf.js worker is bundled via `?url` and set as
  `GlobalWorkerOptions.workerSrc`. The document's real per-fragment fonts come
  from `pdf/fontInfo.ts` after the page paints — see the gotcha below.
- **Write path** — `pdf/exporter.ts` uses **pdf-lib** to produce the output.
  Non-redacted pages keep vector content (edits/text/annotations/stamps drawn on
  top); **redacted pages are rasterized to an image** so content is truly
  removed. `pageOps.ts` (reorder/rotate/merge/extract) and `finishOps.ts` (page
  numbers/watermark/export-as-images) also use pdf-lib.
- **State** — `hooks/useHistory.ts` holds a single `DocState`
  (`edits, textBoxes, redactions, annotations, stamps`) with undo/redo and
  gesture coalescing (pass a stable `key` to `doc.set` to collapse a continuous
  drag/type into one history step). A `revision` counter re-seeds
  `contentEditable` overlays on undo/redo. `App.tsx` is the orchestrator.
- **Viewport** — `hooks/useViewport.ts`: fit-to-width base scale + zoom
  multiplier, app-managed pan/pinch/double-tap/⌘-wheel. The scroll surface is
  `.viewer__scroll` inside a non-scrolling `.viewer` frame so the zoom control
  stays pinned. Fit-scale is measured only on mount / doc load / window resize
  (NOT on panel toggles) so opening the properties panel doesn't rescale-jump.
- **Overlays** — one absolutely-positioned overlay per page (`PageView.tsx`)
  holds `EditableFragment`, `TextBoxItem`, `RedactionItem`, `AnnotationLayer`
  (SVG), `NoteItem`, `StampItem`. All coordinates are PDF units (origin
  bottom-left) converted to screen via `scale`.

## Conventions & gotchas (read before editing)

- **Self-contained assets only — now enforced.** A build-time
  Content-Security-Policy (`cspPlugin` in `vite.config.ts`) sets
  `default-src 'self'` / `connect-src 'self'`, so an off-origin request fails in
  the browser rather than silently working in dev and leaking in production. A
  CDN font link had shipped for months against this exact rule; the CSP plus
  `tests/privacy.spec.ts` is what stops that recurring. Icons are **Lucide**
  (`Icon.tsx` maps semantic names → Lucide components); type is the system font
  stack (`--font-plain`). **Don't add CDN/font dependencies**, and if you add
  something the policy blocks, widen the policy deliberately and say why at the
  definition — don't reach for `'unsafe-*'`.
- **Per-page rendering is windowed.** `useRenderWindow` (IntersectionObserver)
  gates both the canvas raster and the overlay subtree in `PageView`, and the
  thumbnails in `Thumbnail`. Layout stays eager (page frames keep their true
  size, so scroll anchors are exact) — only the contents are windowed. Two
  traps: the observer's `root` must be the *scrolling ancestor*, since
  `rootMargin` doesn't expand an intervening clip; and `PageView` is `memo`'d,
  so props passed from `App` must be referentially stable (per-page overlay
  arrays are bucketed once via `bucketByPage`, and absent `DocState` fields use
  the shared `NO_LINKS` / `NO_FORM_VALUES` constants, never fresh literals).
- **A fragment's font is not in `PageData`.** All `getTextContent()` reports is
  pdf.js's generic `fallbackName` — `"sans-serif" | "serif" | "monospace"`, no
  weight, no slant, no typeface. Two bugs lived in that gap: a `/serif/` test
  matched inside `"sans-serif"`, so every sans document's edited text was
  redrawn in Times, and bold headings came back regular. The real font only
  exists on the main thread *after the page renders*, so `pdf/fontInfo.ts`
  harvests it per page, lazily, into a small store (`hooks/usePageFonts.ts`) —
  rendering 150 pages up front to learn their fonts would cost more than the
  load. Use `resolveFragmentStyle(fragment, override, source)` and treat
  `keepsSourceTypeface()` as the one place that decides whether the document's
  own face is used: the overlay previews exactly what the exporter re-embeds,
  and they must not drift. When drawing with that face, take its weight/slant
  from the face too (`cssFont(..., face)`) — a bold face plus `font-weight:
  bold` gets synthesised bold on top of real bold.
- **Overlays are positioned from the baseline, and the baseline is measured.**
  A fragment's baseline is `transform[5]`, a text box's is `box.y`, and both
  write paths draw at exactly that y — so the overlay has to land on it exactly
  or the preview lies about the file. It is *not* `top = baseline - fontPx`: CSS
  puts the baseline at `(lineHeight - (ascent + descent)) / 2 + ascent` from the
  top of the line box, ~0.76–0.85em with `line-height: 1`. That off-by-a-metric
  lifted every edit 0.15–0.24em, growing with zoom and differing per typeface,
  for as long as the feature existed. `textBaseline.ts` probes the real layout
  (a zero-size `inline-block` sits on its line's baseline) and caches per font
  shorthand; `measureText`'s `fontBoundingBox*` are rounded to whole pixels and
  leave ~0.75px on the table, which is why they aren't used. Two consequences:
  the probe is only valid for the line-height the element actually gets (hence
  `FRAGMENT_LINE_HEIGHT` / `TEXTBOX_LINE_HEIGHT` being passed in), and the
  measured element must keep zero *vertical* padding.
- **An edit's colours are sampled, not constants.** Two of them: the cover that
  hides the original glyphs was hardcoded white (a hole through any coloured
  pill, cell, or banner) and the replacement was drawn hardcoded black (white
  text on a dark panel came back unreadable). Neither is in `PageData` —
  `getTextContent()` reports no fill colour at all — so `pdf/fragmentColors.ts`
  reads both off the raster, lazily per page, the way `fontInfo.ts` reads fonts.
  The content stream *does* carry the colour operators, but nothing joins them to
  text items: pdf.js splits and merges runs on its own terms, so matching them up
  means re-running its text-state machine to recover each run's position. Four
  things there are load-bearing:
  - **The background comes from the glyph box's four corners**, read twice. The
    box as a whole answers with the *text's* colour on any fragment whose ink
    covers more than half of it — and a cover in the text's own colour makes the
    replacement invisible, which is worse than a white box. A ring outside the box
    escapes a tightly-fitting pill and returns whatever surrounds the pill. So:
    a corner patch that is *pure* (one flat colour, `PURE_PATCH_SHARE`) is
    background by construction, because glyphs bring edges and edges bring blends
    — pure patches answer first, weighted by pixel count. That is the only way to
    read a fragment whose `size` is its ink height rather than a font em, i.e.
    every OCR word: their box top lands *on* the glyph tops, so the upper patches
    sit in the ink while the lower ones are clean paper. Failing that, all four
    patches pool into one dominance test — the original reading, kept because it's
    the one that answers a table cell whose borders clip every patch, leaving none
    pure. `PURE_AGREEMENT` is the safety valve: a fragment straddling a panel edge
    has two pure patches of panel against two of paper, a 50% split that declines,
    because half a boundary in the wrong colour is worse than white.
  - **Ink is read above the baseline only.** Underlines, table rules and cell
    borders live in the descender band, and ink is whatever sits furthest from
    the background — so a rule more extreme than the text wins it. Measured: 16pt
    `#878787` text with a black rule 4 units under its baseline read `#000000`.
    Above the baseline there's more than enough glyph left and a horizontal rule
    can't be mistaken for it. (A strikethrough still crosses that band and
    survives on the distance test: ordinary text is the more extreme colour.)
  - **Ink is gated on the em box in pixels, not the page scale.** Ink is the
    colour furthest from the background, i.e. the glyph interior — *if* any pixel
    is fully covered. Below ~8px of em, every pixel is a blend and the furthest
    is a washed-out grey: measured on Helvetica black-on-white, 10pt at 0.76
    px/unit reads `#5c5c5c` while 14pt at the same scale reads exact black. The
    threshold is therefore per fragment (`MIN_INK_EM_PX`), and erring permissive
    is the expensive direction — it redraws ordinary black text in grey on the
    common document to serve the rare one. Declining leaves black, which is
    where this started.
  - **The store is fed by `offerPageCanvas`** from the raster the user is already
    looking at, which is what keeps the on-screen colours and the exported ones
    the same: one cache, one algorithm, and for any page you can actually see a
    disagreement on, one measurement. The exporter rasterises a page itself only
    when nobody ever looked at it — and on the redaction path it offers its own
    raster instead, since it has one. The corollary is that a page first painted
    at a low scale keeps that reading: sub-12px-em type on a narrow low-dpi
    window exports black even after zooming in. Re-sampling on a better raster
    would fix that at the cost of colours changing under the user, and was not
    done.
  - **It is called when a fragment is shown, not when a page paints.** One
    full-page `getImageData` plus the tallies is 18ms on a 1.1M px canvas and
    63ms median / 146ms worst on a 4.6M px one, on the main thread. Sampling as
    each page painted spent that on every page scrolled past to serve a case most
    never reach; `PageView` now samples in a layout effect gated on a selected or
    edited fragment (before the frame, so there's no white-then-correct flash).
    `colors.spec.ts` asserts scrolling reads back no pixels at all.
  - **A rotated page is refused outright.** `viewBox` is the rotated viewport but
    a fragment's `transform` is unrotated text space, and nothing reconciles them
    — so sampling reads mis-mapped coordinates and reports them with full
    confidence. On a `/Rotate 90` test page, black-on-white text came back with a
    *black* background, which would paint a black rectangle over white paper.
    Rotated text is already not repositioned in the overlay; declining keeps the
    colours wrong in the same way, and no worse.
  - **`resolveFragmentStyle` takes the ink as `baseColor`**, so the overlay, the
    properties panel, and both export paths cannot disagree about what colour the
    text is. A memo that reads it needs it as a dependency (`activeStyle` in
    `App.tsx`) — it arrives after the page is sampled.
- **Anything that reaches the output file is validated at the exporter**, not
  only in the UI: link URLs go through `safeLinkUrl` (`pdf/url.ts`, an
  allow-list) and copied annotation actions through `sanitize.ts` (also an
  allow-list, `/Next` chains included). The exporter is the single choke point,
  so a value from a restored session can't bypass a UI check.
- **The redaction raster picks its own codec, and must never grow a page.**
  `embedPageRaster` encodes both PNG and JPEG and embeds the smaller. Neither
  wins everywhere — lossless is hopeless against scanner noise (a scanned A4
  page measured 5127 KB as PNG against 1056 KB as JPEG), but PNG is far smaller
  on a sparse vector page — so the comparison is the design, not a fallback.
  `pref.losslessRaster` (⋯ menu) skips JPEG entirely for users who need the
  raster bit-exact. `docs/RASTER-CODEC-EVAL.md` has the measurements, and the
  reasons JBIG2 and MuPDF were evaluated and turned down.
- **`optimizeImages.ts` decodes flate images itself.** `DCTDecode` goes to the
  browser's JPEG decoder; `FlateDecode` is inflated, un-predicted, and unpacked
  here — `/Predictor` is not optional, since ignoring it yields noise rather
  than a slightly-off image, and `flateParms` therefore *bails* on anything it
  can't read rather than assuming the default. Every unsupported shape (chained
  filters, 1/16-bit depths, CMYK or indexed colour, masks, `/Decode`) returns
  null and leaves the image untouched, which is why the checks are an
  allow-list. Two traps worth keeping in mind:
  - **A soft mask is an image XObject too**, DeviceGray/8-bit/flate — i.e.
    indistinguishable from a candidate by its own contents, and only the
    `/SMask` reference *from the image that owns it* marks it. Rewriting one as
    a DeviceRGB JPEG is an invalid mask and lossy transparency, so `maskedRefs`
    pre-scans for those references. Accepting flate is what put masks in range;
    they were unreachable when only `DCTDecode` was.
  - **The rebuilt image dict is a fresh minimal one**, so any key that outlives
    the pixels has to be carried over by name — `/Interpolate` and `/Intent`,
    plus `/OC` (without which an image on a hidden optional-content layer
    becomes permanently visible) and `/StructParent` (which ties it to the
    tagged-PDF tree carrying its alt text).
  - **"Present but unreadable" is not "absent".** `flateParms` returns the
    no-prediction defaults *only* when `/DecodeParms` is missing outright; a
    dangling reference or a shape it doesn't model bails instead. Collapsing
    the two is how you unfilter predicted data as if it were raw, and nothing
    downstream can catch it — predictor-filtered data is always *larger* than
    the samples it encodes, so the short-data guard never fires. For the same
    reason the parms object is checked with `instanceof PDFDict`, not for a
    `.get` method: `PDFArray` has one of those too.
- **On the redaction raster path, anything not covered is permanent.** The
  raster is all that survives, so cover rectangles must be *measured*
  (`ctx.measureText` / `widthOfTextAtSize`), never estimated from character
  counts. That estimate shipped once and left original text visible past the
  cover for wide glyphs and non-Latin scripts.
- **Download via `src/download.ts`.** It attaches the anchor before clicking and
  defers `revokeObjectURL`; revoking synchronously races the browser's fetch of
  the blob and cancels downloads on Firefox/Safari.
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
- **The Inspector has two named tabs, not one surface with two moods.** It used to
  swap between the document actions and the selection's properties with nothing to
  say it had, so clicking the page made Compress/Watermark/OCR vanish with no way
  back. Selecting moves to Properties (that's what the click asked for);
  deselecting deliberately does *not* move back, or the panel would flip on every
  stray click. The document actions also live in the ⋯ menu — deliberately, since
  on a phone the panel is a selection-driven sheet and the palette needs a
  keyboard — so the two must keep the *same* groups, order, names and icons; they
  both read from `docActions` and `DOC_GROUPS`.
- **Floating chrome has to be clamped to the viewport.** `TooltipHost` centres its
  bubble on the anchor with `translate(-50%)`; without the layout-effect clamp,
  every control at a screen edge (the collapsed Inspector tab, the ⋯ button on a
  phone) got a tooltip drawn half outside the window. Same class of bug as the
  overflow menu having no `max-height`, which left its last two items unreachable
  on an 820px window.
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
  whole stale-dependency problem the `PageView` memo note describes.
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
- **Tick and cross are placed by a tap, and their geometry lives in one place.**
  Every other draw sub-tool needs a drag, but a form checkbox is smaller than
  `MIN_DRAG`, so requiring a drag would make a thirty-field form thirty drags: a
  click drops a `DEFAULT_MARK_SIZE` mark, a drag sizes it. The glyphs are drawn
  three times over — the SVG overlay, the pdf-lib vector export, and the canvas
  that rasterises a redacted page — so they are defined once as unit polylines
  in `pdf/marks.ts` and each path maps the same numbers into its own space. A
  second copy is a preview that lies about the file. Both kinds are
  box-shaped, which is what earns them the existing selection frame, marquee
  hit-testing and rotation for free; the set of box kinds is `isBoxAnnotation`
  in `pdf/types.ts`, and a new box kind that isn't added there renders fine and
  silently loses its resize handles.
- **No native UI.** Use the in-house `ConfirmDialog` (not `confirm()`),
  `ColorField` (not `<input type=color>`), and `TooltipHost` + `data-tip=`
  (not `title=`). `ColorField`'s popover is **portaled to `document.body`** —
  needed because a transformed ancestor (e.g. the centered `.drawbar`) would
  otherwise capture its `position: fixed`.
- **pdf-lib is lazy-loaded.** `exporter.ts`, `finishOps.ts`, and the
  `Organize`/`FinishDialog`/`SignatureDialog` components are `import()`-ed /
  `React.lazy`-ed on demand so pdf-lib stays out of the initial bundle. **Keep
  the render path free of pdf-lib** — e.g. `isFragmentModified` lives in the
  pure `pdf/style.ts`, not `exporter.ts`. If you add code the initial render
  needs, don't import it from a pdf-lib module.
- **Touch = select-first.** `hooks/useDrag.ts` exports `tapSelect` and
  `startElementGesture`: on touch, an *unselected* element only selects on a
  clean tap and lets the page pan under a drag; once selected it drags. Reuse
  these for any new draggable/selectable overlay. Stamps have no properties
  sheet — they're edited directly on the canvas (drag/resize handle/delete
  badge).
- **Persisted prefs** live in `localStorage` via `hooks/usePrefs.ts`
  (`pref.drawTool`, `pref.drawStyle`, `pref.textStyle`) and `useTheme.ts`
  (`theme`), `useSignatures.ts` (`signatures`). New text boxes inherit the last
  text style.
- **Theme** — `theme.css` holds M3 Expressive tokens; light is `:root`, dark is
  `:root[data-theme="dark"]`. An inline script in `index.html` sets the theme
  before first paint (no flash). `useTheme` cycles system/light/dark.
- **Finishing ops rebuild the document**, which bakes in (and resets) current
  edits — they call `bakeCurrent()` then reopen the result. Expected.

## OCR (on-device, self-hosted)

OCR uses **tesseract.js**, lazy-loaded in `pdf/ocr.ts`. To honour the no-CDN /
privacy rule, all OCR assets are served from the app's own origin: run
`npm run setup-ocr` to copy the worker + wasm cores into `public/tesseract/` and
the language model into `public/tessdata/` (both git-ignored; the deploy workflow
runs this step). If the assets are absent, OCR degrades gracefully with a
"run `npm run setup-ocr`" message.

**Every OCR asset comes from an installed package**, including the language
model (`@tesseract.js-data/eng`, the `4.0.0_best_int` variant). It used to be
downloaded from `tessdata.projectnaptha.com` with `continue-on-error: true` in
CI, which meant any outage or block on that one host produced a *green* deploy
where OCR was dead and users saw "Text recognition isn't available in this
version". Sourcing it from npm makes the bytes lockfile-pinned and lets the
workflow step fail loudly. Don't reintroduce a network fetch on this path.

`tests/ocr.spec.ts` exercises OCR end-to-end against a generated image-only page
whenever the assets are installed, and skips itself otherwise. CI runs
`npm run setup-ocr` before the build so it actually executes there. The fixture's bitmap is rendered by a real browser in a
real typeface — a hand-rolled pixel font was tried and Tesseract read 1 of 3
words from it, which makes for a useless assertion.

Recognised words are
appended to a page's `fragments` as a transparent, selectable/searchable text
layer (so Find and search-and-redact work on scans).

**An OCR fragment's `size` is the recognised ink height, not a font em**, which
matters to `fragmentColors.ts`: its sample box is built from `size`, so the box
top lands *on* the glyph tops rather than above them and the upper corner patches
sit in the ink. Pooling all four patches into one dominance test therefore
declined a large bold all-caps word outright; reading a *pure* patch as background
regardless of the others resolves it, since the patches below the baseline are
clean paper. An edited scan word now takes the scan's own paper and ink —
`fill=#ffffff ink=#111111` on the `scanned` fixture, every word, and
`ocr.spec.ts` asserts exactly that. A *noisy* scan still declines throughout,
because no colour owns enough of a speckled page, which leaves the edit
black-on-white as it was before any of this.

**`setup-ocr` copies only the `.wasm.js` cores, not the sibling `.wasm`.** Each
variant ships both ways — a small `<name>.js` glue that fetches `<name>.wasm`,
and `<name>.wasm.js` with the module inlined as base64 — and `getCore.js` in
tesseract.js only ever builds a `.wasm.js` URL when `corePath` is a directory,
which is how `pdf/ocr.ts` passes it. Copying both put 8.2 MB in `dist/` that no
browser fetched. Switching to the smaller glue means copying the `.wasm` back
*and* doing SIMD detection yourself.

### The engine cache (`public/sw.js`)

**There is one service worker, and it exists only to cache the wasm core.** The
core's filenames are fixed by tesseract.js, so they carry no content hash, and
Pages serves everything `max-age=600` — without this a returning user
re-downloads ~1.4 MB of engine every ten minutes. (The *language model* needs no
help: tesseract.js already keeps it in IndexedDB, so its 2.82 MB is once per
device.)

Three things about it are load-bearing, so don't casually relax them:

- **It handles same-origin GETs under `<scope>tesseract/` and nothing else** —
  every other request returns from the handler untouched. There is deliberately
  no offline app shell: caching the app would be a far larger surface, and a
  stale shell is the classic service-worker failure this side-steps entirely.
  `ocr.spec.ts` asserts the cache contains only `tesseract/` entries.
- **It's registered lazily, from `ocrPages`**, so only people who actually run
  OCR end up with a service worker at all — and registration *waits for control*
  (`skipWaiting`/`clients.claim`) before Tesseract boots, or the very run that
  triggered it would miss the cache and store nothing.
- **It's part of "Save session on this device."** The cache holds engine
  binaries, not anything of the user's, but a switch labelled "don't keep things
  on this device" that left 1.4 MB of wasm behind is a switch that lies. So
  `ocrPages` takes `cacheEngine` (App passes `autosaveOn`), and `toggleAutosave`
  calls `clearEngineCache()` beside `clearSession()`. Mechanism lives in
  `pdf/engineCache.ts`, which imports nothing from `ocr.ts` — that's what lets
  `App` reach `clearEngineCache` without pulling tesseract.js into the initial
  bundle.
- **The cache name comes from `sw.js?v=<tesseract.js>-<tesseract.js-core>`**,
  injected by `define` in `vite.config.ts` from the installed packages. That's
  what makes an upgrade evict the old core rather than serve it forever.

Two traps, both of which cost a debugging round:

- **`sw.js` caches only while armed** (`caching` starts `false`; the app posts
  `enable` before each run). Don't "simplify" that to default-on. A service
  worker is killed when idle and restarted on the next event, so state held in a
  variable evaporates — a default-on worker that switches off on a message
  silently un-disables itself. And `unregister()` does not stop an active worker
  from serving pages that are still open, so the registration going away is not
  enough either.
- **A callback that reads the pref needs it as a dependency.** `runOcr` was
  `[pdf]`, so `cacheEngine: autosaveOn` captured whatever the value was when
  `pdf` last changed and kept caching after the switch was off. This is exactly
  the class of bug the `PageView` memo note warns about, one layer up.

Testing gotcha: **don't assert "no network response for the core"** to prove a
cache hit. Playwright attributes the service worker's own `fetch()` to the
worker, so `response.fromServiceWorker()` is true either way and the assertion
passes against a worker that never reads its cache. The spec instead
`route(...).abort()`s the core and requires OCR to succeed anyway.

## Testing (Playwright)

Start with the committed suite: `npm run build && npm test`. Playwright starts
its own preview server (`webServer` in the config) and the specs generate their
own PDFs. Extend `tests/` rather than writing a throwaway script when the thing
you're verifying should stay verified.

For one-off exploration (a new interaction, a screenshot in both themes):

- No browser download in the sandbox, and the pinned Playwright wants a newer
  build than is installed — so run the suite as
  `PW_EXECUTABLE_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome npm test`.
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

## Deployment

`.github/workflows/deploy.yml` builds and deploys `dist/` to GitHub Pages on
every push to `main`. Pages **Source must be "GitHub Actions"** (one-time repo
setting). `vite.config.ts` uses `base: "./"` so assets resolve under the project
subpath. Merging a PR to `main` triggers the deploy; verify the run succeeds.

## Git / workflow

- Feature branch: `claude/pdf-text-editor-iwl4ue`. PRs squash-merge into `main`.
- After a squash-merge, to start clean follow-up work without re-listing merged
  commits: `git fetch origin main && git add -A && git reset --soft origin/main`,
  then commit and force-with-lease push.
