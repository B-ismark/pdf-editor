# Text fidelity: fonts, baseline, insets and colours of edited text

_Read before touching `fontInfo.ts`, `usePageFonts.ts`, `style.ts`, `textBaseline.ts`, `fragmentColors.ts`, `EditableFragment`, `TextBoxItem`, or how either export path draws edited text._

Moved verbatim from `CLAUDE.md`; the index there links here.

## Gotchas

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
- **A text overlay carries no horizontal inset, and a fragment's selection mark
  has no vertical edges.** Two ways the overlay stopped matching the page
  underneath it, both of them chrome hugging glyphs. `.fragment` had
  `padding: 0 1px`, and since `left` is the exact x the exporter draws at, the
  replacement text rendered a pixel right of both the original glyphs and the
  file — every click nudged the line sideways. `.textbox` had the same inset for
  the same reason and lost it in the same pass: no original glyphs sit under a
  text box, so nothing looked wrong, but the preview was still a pixel off the
  file it previews. And `.fragment__cover--sel` was a 1.5px ring around the cover;
  the cover hugs the run (it has to, it hides exactly what it replaces), so the
  ring's *vertical* edge landed in the gap before the next word and read as a
  letter — selecting "Most of" rendered "Most ofl", which is what it was reported
  as. The mark is two horizontal rules above and below the run instead: a rule
  can't be mistaken for a glyph, which is the whole reason it isn't a box.
  `tests/fragment.spec.ts` pins both. (The cover's own size and colour are
  untouched by all of this — they are a claim about the exported file.)

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
    raster instead, since it has one, *and only for a page that has an edited
    fragment*: nothing else reads the sample, so on a redacted-but-unedited
    document the whole tally was being paid for data no one asks for. Two rules
    follow. `readPageColors` must not publish over a reading that landed while
    its own render was in flight — that reading came from the raster on screen,
    and overwriting it with a sample of a different one is precisely how the
    exported colours come to disagree with the previewed ones. And whatever
    decides the gate has to be the same test the drawing code uses
    (`isFragmentModified`), or an edited fragment on a rasterised page loses its
    colours; `colors.spec.ts` covers exactly that case. The corollary is that a page first painted
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
  - **A turned raster is refused; the page is sampled unturned instead.**
    Fragment transforms are in user space and a turned canvas isn't. On a
    `/Rotate 90` test page, reading one at fragment coordinates reported a
    *black* background for black-on-white text. `sampleColors` still refuses
    `turn !== 0`; on a turned page `PageView` calls `readPageColors`, which
    renders the page unturned, and the exporter's raster is unturned too. See
    `pages.md`.
  - **`resolveFragmentStyle` takes the ink as `baseColor`**, so the overlay, the
    properties panel, and both export paths cannot disagree about what colour the
    text is. A memo that reads it needs it as a dependency (`activeStyle` in
    `DocumentEditor.tsx`) — it arrives after the page is sampled.
  - **An edit keeps to its line** (`lineFit.ts`). A line is usually several
    runs, each at its own x; an edit that grew in place covered the next run
    (the opaque cover too), on screen and in the file. `roomAfter` gives the room
    up to the next run on the same baseline, less up to a word space (pdf.js
    drops the space item, so the next x is its first glyph); `fitScale` condenses
    past it. The overlay (`scaleX`), the vector path (`cm`) and the raster path
    (`ctx.scale`) all use it. Reflow was rejected: it redraws untouched text and
    would slide words out from under a measured search-redaction box.
