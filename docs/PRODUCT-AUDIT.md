# Product Audit — PDF Editor

**Scope:** the whole app (`src/`, `index.html`, `vite.config.ts`, the deploy
workflow) reviewed along five independent axes rather than one: **privacy**,
**security**, **performance**, **correctness / export integrity**, and
**UX / accessibility**, plus supply chain and verification practice.
**22 findings, 21 fixed**, one deferred with reasoning (#18).

**Method:** static review of every module, then behavioural verification in a
real browser (Chromium, desktop + phone, light + dark) against the built bundle
— network traffic, CSP enforcement, canvas memory, and the *bytes of exported
PDFs*, because several of the most important claims this product makes are only
observable in the output file.

**Relationship to the earlier audit:** `docs/UI-UX-AUDIT.md` covered usability,
platform conformance and accessibility, and its findings were implemented. This
pass deliberately looks elsewhere: at the promises the product makes about
privacy and permanence, at what it costs to run, and at what actually ends up
in the file the user hands to someone else.

**Date:** 2026-07-28. Findings #20-22 come from a second pass that exercised
OCR once its assets could be obtained; the first pass had recorded that as a gap.
That pass also **corrected finding #19**, which had wrongly asserted the project
had no automated tests — see the note under it.

---

## Summary

| # | Axis | Finding | Severity | Status |
| --- | --- | --- | --- | --- |
| 1 | Privacy | Google Fonts CDN on every page load | 🔴 P0 | ✅ Fixed |
| 2 | Privacy | No enforced boundary behind the "never uploads" promise | 🟠 P1 | ✅ Fixed |
| 3 | Privacy | Autosaved document copy with no way to delete it | 🟠 P1 | ✅ Fixed |
| 4 | Security | Link tool writes unvalidated URI schemes into the PDF | 🟠 P1 | ✅ Fixed |
| 5 | Security | Annotation-action sanitiser is a block-list with one entry | 🟠 P1 | ✅ Fixed |
| 6 | Correctness | Redaction path leaves replaced text partly uncovered | 🟠 P1 | ✅ Fixed |
| 7 | Performance | Every page rendered eagerly — memory scales with page count | 🔴 P0 | ✅ Fixed |
| 8 | Performance | Thumbnail rail rasterises the whole document on open | 🟠 P1 | ✅ Fixed |
| 9 | Performance | Autosave rewrites the entire PDF on every change | 🟠 P1 | ✅ Fixed |
| 10 | Performance | Every page re-renders on every keystroke | 🟡 P2 | ✅ Fixed |
| 11 | Correctness | Redacted-page encoding via base64 data URL | 🟡 P2 | ✅ Fixed |
| 12 | Correctness | Object URLs revoked synchronously after `click()` | 🟡 P2 | ✅ Fixed |
| 13 | Correctness | Imported images unvalidated, uncapped, failures silent | 🟡 P2 | ✅ Fixed |
| 14 | UX | Status message collides with the zoom control on phones | 🟡 P2 | ✅ Fixed |
| 15 | A11y | Unlabelled link-URL field and stroke-width slider | 🟡 P2 | ✅ Fixed |
| 16 | UX | Native `title` tooltip on link boxes, against convention | 🟢 P3 | ✅ Fixed |
| 17 | UX | No favicon, no description, theme-color ignores dark mode | 🟢 P3 | ✅ Fixed |
| 18 | Supply chain | `vite` / `esbuild` advisories (dev server only) | 🟡 P2 | ◑ Documented |
| 19 | Process | Test suite missed the load-bearing invariants (see correction) | 🟠 P1 | ✅ Fixed |
| 20 | Reliability | OCR language model fetched from one CDN, failure silent | 🟠 P1 | ✅ Fixed |
| 21 | UX | Find scrolls the page, not the match — matches stay off screen | 🟠 P1 | ✅ Fixed |
| 22 | Docs | README claims OCR doesn't exist | 🟢 P3 | ✅ Fixed |

Severity is about user impact: 🔴 breaks a promise or a whole class of
documents · 🟠 real exposure or failure for many users · 🟡 noticeable ·
🟢 polish.

---

## Privacy

### 1. 🔴 The app phoned home to Google on every page load

`index.html` carried two `preconnect` hints and a render-blocking stylesheet
request to `fonts.googleapis.com` / `fonts.gstatic.com`.

This is the most serious finding in the audit, because it isn't a bug in a
feature — it contradicts the product's entire premise. "No server, no uploads,
no accounts" is the headline; the README says the app is "self-contained … so
the UI renders fully even if web fonts are blocked or offline"; `CLAUDE.md`
says in bold that only self-contained assets are allowed. Meanwhile every
visitor's IP address, User-Agent and Referer went to a third party before the
first pixel was drawn. For the users this tool is *for* — someone redacting a
document precisely because they don't want it to travel — that's the difference
between a private tool and one that announces each use.

It was also a real functional defect in the offline and locked-down cases the
README claims to support: the font never arrives, so the request just costs a
blocking round trip on the critical path.

**Fixed** by deleting the CDN references and putting the system font stack
first in `theme.css`. Naming a web font first while loading none would have
produced exactly the silent fallback the README described, so the stack now
says what it means. The platform UI font is also the one the user has already
scaled to their preferred size.

### 2. 🟠 Nothing enforced the "never leaves your device" boundary

The claim held only because no code happened to call `fetch` to an external
host. Nothing prevented a dependency, a transitive package, or a future
refactor from doing so, and finding #1 shows the convention can quietly break.

**Fixed** by generating a Content-Security-Policy `<meta>` at build time
(`cspPlugin` in `vite.config.ts`). With `default-src 'self'` and
`connect-src 'self' data: blob:`, exfiltration of the open document is blocked
by the browser rather than by good intentions; `object-src 'none'` and
`base-uri 'none'` close the injection vectors a file parser invites.

Inline script is allowed by SHA-256 hash computed from the actual file, so the
theme bootstrap can be edited without silently breaking the policy — or
silently widening it. The relaxations that remain (`'wasm-unsafe-eval'` for
OCR and image compression, `style-src 'unsafe-inline'` for React's inline
positioning styles) are documented at the definition, because an unexplained
policy is one that gets deleted the first time it's inconvenient.

`frame-ancestors` is deliberately absent: it is ignored in a meta-tag policy
and needs a real response header, which GitHub Pages doesn't allow.

### 3. 🟠 An autosaved copy of the document, with no way to erase it

Autosave writes the full PDF plus the edit state to IndexedDB. That's a good
feature — a crash or accidental reload otherwise loses everything — but it is
also a real copy of a possibly sensitive file sitting on the device, and the
UI offered no way to remove it. `useAutosave` exported a `clear()` that nothing
called; the restore prompt's "Dismiss" only hid the prompt, leaving the
document recoverable indefinitely.

**Fixed** on both ends: the restore prompt now distinguishes "Not now" (keep
it, ask again later) from "Delete" (erase it), and an overflow-menu toggle,
*Save session on this device*, turns the behaviour off — erasing whatever is
already stored, since a switch that only stops future writes would miss the
point.

---

## Security

### 4. 🟠 Link URLs went into the PDF unvalidated

The Link tool took whatever the user typed and wrote it into a PDF `/URI`
action. A `/URI` action is a live capability in whatever reader opens the file,
and `javascript:` URIs in link annotations are acted on by a range of viewers —
every browser-based one included. So "add a link" could embed active content
into a document the user then sends to someone else, and `file:` URIs could be
used to probe the recipient's filesystem.

**Fixed** with an allow-list (`src/pdf/url.ts`): `http`, `https`, `mailto`,
`tel`. Anything else is refused rather than sanitised, because there's no safe
rewriting of `javascript:alert(1)`. Control characters are rejected outright —
they're the standard trick for smuggling a scheme past a naive check
(`java\0script:`). Bare input like `example.com/x` is coerced to `https://`,
which is the obvious intent and stops a scheme-less entry becoming a dead link.

Validation runs in two places on purpose: the properties panel explains *why* a
URL won't be exported rather than dropping it silently at download time, and
the exporter re-checks because it is the only path a URI can take into the
file — including values arriving from a restored session.

### 5. 🟠 The sanitiser named one dangerous action and missed the rest

`sanitizeDocument` removed annotation actions whose subtype was `/JavaScript`.
Every other executable action type survived on pages copied from the source
document: `/Launch` (run a program), `/SubmitForm` and `/ImportData` (send the
document's data to a URL — directly at odds with the no-upload promise, in a
file the user believes has been scrubbed), `/GoToR` and `/GoToE` (reach into
another file), and the embedded-media actions. A permitted action could also
tow a forbidden one behind it through `/Next`, which the check didn't look at
at all.

**Fixed** by inverting it: `/URI`, `/GoTo` and `/Named` are kept, everything
else is dropped, `/Next` chains are walked (with a depth cap for malformed
files), and a kept `/URI` has its scheme checked with the same allow-list as
finding #4. A viewer needs nothing more than that to make ordinary links work.

---

## Correctness and export integrity

### 6. 🟠 Replaced text stayed visible on redacted pages

When a page contains a real redaction the exporter rasterises it, so the raster
is the only thing that survives — whatever it shows is permanent, and whatever
it fails to cover is *not* removed. On that path, edited text runs were covered
with a white rectangle whose width was estimated as
`text.length * size * 0.2`.

That estimate under-reports badly for anything other than narrow lowercase
Latin: capitals, wide glyphs, and most non-Latin scripts. When the replacement
was wider than the guess, the cover fell short and the tail of the *original*
text stayed visible in the exported image. The user sees their replacement on
screen and a permanent artefact of the text they replaced in the file.

**Fixed** by measuring the replacement with `ctx.measureText` in the font
actually being drawn — the same information the vector path already used via
`widthOfTextAtSize`. The cover's height now also grows with line count, which
had the same shortfall for multi-line replacements.

### 11. 🟡 Redacted pages encoded through a base64 string

`rasterisePage` produced its image with `canvas.toDataURL("image/png")`. A
redacted A4 page at 3× is roughly 7 megapixels, whose PNG becomes a 10–30 MB
base64 *string* that pdf-lib then decodes straight back to bytes — two large
copies plus 33% base64 overhead, held simultaneously, on the main thread, per
page. On a document with several redacted pages that is the difference between
exporting and an out-of-memory tab.

**Fixed** with `canvas.toBlob` → `arrayBuffer`, which hands the encoded bytes
over directly. `toDataURL` remains as a fallback for browsers without `toBlob`.

### 12. 🟡 Downloads could be cancelled by their own cleanup

All three download paths built an object URL, clicked a detached anchor, and
called `URL.revokeObjectURL` on the next line. Revoking synchronously races the
browser's fetch of the blob: Chrome tolerates it, Firefox and Safari can cancel
the download outright. The failure mode is "clicking Download did nothing",
biased toward large files — exactly the ones users care most about.

**Fixed** in one place (`src/download.ts`): the anchor is attached to the
document before clicking (historically required by Firefox) and the URL is
revoked on a later task.

### 13. 🟡 Imported images: no validation, no cap, silent failure

`startImagePlacement` read any chosen file as a data URL and assigned it to an
`Image` with an `onload` handler and **no `onerror` handler at all**. An
unsupported or corrupt file (HEIC from an iPhone, an SVG, a renamed non-image)
therefore did nothing whatsoever — no stamp, no message, nothing to
distinguish it from a mis-tap. Full-resolution phone photos were also embedded
as-is, adding tens of megabytes to the PDF for something displayed two inches
across, and held in memory as a data URL for the rest of the session.

**Fixed** in `src/pdf/imageStamp.ts`: decode failures surface a real message,
formats pdf-lib can't embed are converted, oversized files are rejected before
decoding, and the longest edge is capped at 2000px — still beyond 300 dpi at
any size a stamp is placed at.

---

## Performance

### 7. 🔴 Memory and zoom cost scaled with document length

`App` rendered a `PageView` for every page, and each one rasterised itself to a
canvas immediately and unconditionally. Nothing was gated on visibility, so an
N-page document kept N full-page rasters alive at all times, and because
`scale` is in the render effect's dependencies, **every** page re-rasterised on
every zoom step — including a continuous pinch. Each page also mounted a DOM
node per text run.

Measured on a 150-page document (1280×820, `devicePixelRatio` 1):

| | Live canvases | Canvas backing store |
| --- | --- | --- |
| Before | 150 of 150 | **170.7 MP ≈ 680 MB** |
| After | 2–3 | **2.3–3.4 MP ≈ 9–14 MB** |

The "after" figure is the same at the top, middle and bottom of the document,
which is the actual point: cost is now a function of the viewport, not of the
file. On a phone at `devicePixelRatio` 3 the before-figure would be nine times
larger again.

**Fixed** with `useRenderWindow` — an IntersectionObserver that keeps a band of
pages around the viewport live. Layout stays eager, so the scrollbar, page
anchors and scroll position are untouched; only the expensive contents are
windowed. A page leaving the band has its canvas backing store released
(`width = 0`), which is what actually returns the memory.

One subtlety worth recording, because it looked like it worked when it didn't:
`rootMargin` only expands the *root* rect. With the default root (the viewport)
the intervening `.viewer__scroll` still clipped the observed area down to what
was literally on screen, so the margin was a no-op and pages resolved from
skeletons as the user scrolled onto them — 1 live page instead of 3. The
observer now uses the nearest scrolling ancestor as its root, found by computed
style so the same hook serves the page rail and the Organize grid.

### 8. 🟠 Opening the thumbnail rail rasterised the whole document

`PageNav` mounted a `Thumbnail` per page, each firing `renderPageToCanvas` on
mount with no queue or gating. Opening the rail on a long document therefore
queued hundreds of rasterisations back-to-back and stalled the app until the
last one finished — for thumbnails nobody had scrolled to.

**Fixed** with the same hook and a smaller margin.

### 9. 🟠 Autosave rewrote the whole PDF on every change

The debounced save stored one record containing the source bytes *and* the edit
state, so typing in a 60 MB document wrote 60 MB to IndexedDB every 1.2s — for
a delta of a few hundred bytes. It also called `bytes.slice(0)` each time,
copying the whole buffer in memory first.

**Fixed** by splitting the record: the bytes live under their own key and are
written once per opened document (tracked by buffer identity), while the small,
frequently-changing edit state is what the debounce actually rewrites.

### 10. 🟡 A keystroke re-rendered every page in the document

`PageView` wasn't memoised, and `App` passed it freshly-built arrays —
`textBoxes.filter(b => b.pageIndex === page.pageIndex)` and four more like it —
on every render. So any state change anywhere in `App` reconciled every overlay
of every page, and the filtering itself was O(pages × overlays).

**Fixed** by memoising `PageView` and bucketing overlays by page once per
change, with a shared empty array for pages that have none so their props stay
referentially equal. Two `?? []` / `?? {}` fallbacks for older `DocState`
shapes were also allocating fresh objects per render, which would have defeated
the memo on its own.

---

## UX and accessibility

### 14. 🟡 Status messages covered the zoom control on phones

The snackbar is top-anchored on phones (the bottom edge belongs to the tool
dock) and spans up to 92vw — the full width of a phone. The zoom pill is pinned
top-right in the same band. `App` already arbitrates the zoom pill against the
other top-centre bars (find, multi-select, selection) but not against the
snackbar, so any status message made the zoom percentage unreadable. Caught by
screenshot, not by reading the code.

**Fixed** by dropping the phone snackbar below the pill's band, and asserted
geometrically in `tests/phone.spec.ts` so it can't silently come back.

### 15. 🟡 Unlabelled controls

The link URL field's caption was a `<span>`, not a `<label>` — so screen
readers announced an unlabelled text field — and the annotation stroke-width
slider had no accessible name at all (the text-size slider next to it did).

**Fixed** with a real `<label for>` and an `aria-label` respectively. The URL
field also now carries `aria-invalid` and an `aria-describedby` note that
explains a rejected scheme, so finding #4's refusal is legible to assistive
tech rather than a silently red field.

### 16. 🟢 A native tooltip where the app has its own

`LinkItem` used `title=`, which `CLAUDE.md` explicitly rules out in favour of
`TooltipHost` + `data-tip`. Inconsistent styling and delay, and `title` never
appears on touch at all. **Fixed.**

### 17. 🟢 Document metadata

No favicon (a 404 and a blank tab icon), no `<meta name="description">`, a
`<title>` that named the product differently from every other surface, and a
single `theme-color` pinned to the light-theme primary so the browser chrome
clashed in dark mode. **All fixed**, including a per-scheme `theme-color`.

---

## Supply chain

### 18. 🟡 `vite` / `esbuild` advisories

`npm audit` reports one high and one moderate advisory, all in the dev server:
`server.fs.deny` bypasses via Windows alternate paths, a path traversal in
optimised-deps `.map` handling, and esbuild's dev server accepting cross-origin
requests.

**Not fixed here, deliberately.** None of it is in the deployed artifact — the
output is static files on GitHub Pages with no server at all — and the only
remediation `npm audit` offers is `vite@8`, three majors up from the pinned
`vite@5`, which also requires updating `@vitejs/plugin-react` and revalidating
the whole build. That's a dependency upgrade project with real regression risk,
not an audit fix, and doing it silently inside this change would make the
performance and privacy work harder to review.

The exposure meanwhile is: a developer running `npm run dev` while visiting a
hostile page in the same browser. Worth scheduling; not worth coupling to this.

---

## Process

### 19. 🟠 The test suite didn't cover the properties that carry the product

**Correction.** The first version of this document claimed there was "no
automated verification of any kind" and that type-checking "was the whole safety
net". That was wrong, and it is worth recording why rather than quietly editing
it: `tests/app.spec.ts` holds a six-test Playwright suite, `playwright.config.ts`
serves the production build for it, and `.github/workflows/ci.yml` runs
`npm run build` plus `npm test` on every push and every PR into `main`. The
repo's own `CLAUDE.md` said "no test runner / linter configured", and that stale
line was taken at face value instead of being checked against
`.github/workflows/` and the `test` script sitting in `package.json`.

The accurate finding is narrower and still real. The existing suite covers
*feature behaviour*: content-sniffing a non-PDF, opening a document, page numbers
as an undoable layer, undo/redo re-seeding a `contentEditable`, multi-page image
export bundling to one ZIP, and a modal suppressing global shortcuts. Every one
is worth having. But none of them looks at the things this audit turned on — no
test observed a network request, checked the CSP, measured canvas memory, or read
a single byte of an exported file. So the properties the product is *sold* on
were unguarded, which is exactly how a CDN font survived months against a written
rule forbidding it.

**Fixed** by extending that suite rather than standing up a parallel one. An
earlier iteration of this work added a separate `scripts/check.mjs` harness with
its own runner, fixtures and npm scripts; that was duplicated infrastructure and
a second thing to remember to run, so it has been folded into `tests/` where CI
already picks it up. `npm test` now runs **18** specs:

| Spec | Guards |
| --- | --- |
| `app.spec.ts` | the original six feature tests, unchanged |
| `privacy.spec.ts` | no off-origin request or `<link>`; CSP present, restrictive, and not silently widened; autosave stores a session and the toggle erases it |
| `rendering.spec.ts` | a 150-page document lays out fully but rasterises few pages; canvas memory doesn't grow while scrolling; the page scrolled to is actually painted |
| `export.spec.ts` | an unsafe URL is refused visibly and absent from the bytes; no authoring metadata; a redacted page has no text layer while its neighbour keeps one |
| `ocr.spec.ts` | a scan becomes recognised and findable, from same-origin assets only |
| `find.spec.ts` | the active match lands on screen and clear of the find bar |
| `phone.spec.ts` | the status message clears both the zoom pill and the tool dock |

CI also gained a `npm run setup-ocr` step before the build, so the OCR spec
exercises the feature instead of skipping itself — which is what it does locally
on a checkout without the assets.

Fixtures are generated at run time (`tests/fixtures.ts`) rather than committed,
so the specs can assert against known page contents.

## OCR (added after the first pass)

The initial pass couldn't exercise OCR — `npm run setup-ocr` downloads the
language model from `tessdata.projectnaptha.com`, which this network blocks — so
it was reviewed statically and recorded as a gap. Closing that gap turned up two
further findings.

### 20. 🟠 The OCR model came from one CDN, and its failure was silent

`setup-ocr` fetched `eng.traineddata.gz` from a single community host, and the
deploy workflow ran that step with `continue-on-error: true`. The combination is
the worst of both: any outage, rate limit, or network policy on that one host
produces a **green deploy in which OCR is simply dead**, with users told "Text
recognition isn't available in this version" and nothing in the build log
explaining why. It also meant the shipped model was unpinned — whatever the host
served that day.

**Fixed** by taking the model from `@tesseract.js-data/eng` (the same data,
published by the tesseract.js maintainer) as a devDependency: resolved through
the registry `npm ci` already requires, hash-pinned in the lockfile, and cached
by CI. The `4.0.0_best_int` variant is 2.9 MB against the old `_fast` model's
~2 MB and is more accurate. The direct download remains as a fallback for a
checkout without devDependencies, and `continue-on-error` is gone — a failure
now means something is genuinely wrong with the build rather than with someone
else's server.

With that in place, OCR was verified end-to-end against a new image-only fixture
(an image-only page with zero extractable text): it recovered all four rendered
words, requested only `tessdata/` and `tesseract/` paths on our own origin,
raised no CSP violations, and made the scan findable. The run also confirmed the
runtime picks the `relaxedsimd` core, which is why all three wasm variants have
to be shipped.

One note on the fixture: the first version drew its text with a hand-rolled 5×7
pixel font, and Tesseract read **1 of 3 words** from it. Tesseract is trained on
real type, so the fixture now renders the words in a real typeface via the
browser the checks already need. A fixture that a working feature fails is worse
than no fixture.

### 21. 🟠 Find scrolled the page, not the match

Caught in a screenshot of the OCR run: the sole match was reported as `1/1` and
highlighted — behind the find bar.

```js
document.querySelector(`[data-page-index="${activeMatch.pageIndex}"]`)
  ?.scrollIntoView({ block: "center" });
```

It centred the *page*, ignoring where on it the match sat. That's only correct
when a page is shorter than the viewport; at fit-width an A4 page is taller than
most, so a match near the top or bottom of a page stayed off screen entirely —
and stepping through several matches on the same page looked like *Next* doing
nothing at all. Since OCR makes scans searchable, this sits directly on the path
the previous finding just enabled.

**Fixed** by positioning the match itself a third of the way down the scroll
surface, which also keeps it clear of the find bar. Computed from the match's PDF
coordinates rather than by querying the highlight element, because a far-off
page's overlay isn't mounted under the render window — but its page *frame*
always is, so the rect is reliable.

### 22. 🟢 The README said OCR didn't exist

"**No password encryption or OCR.** … OCR would need a heavy WASM engine; both
are out of scope" — written before OCR shipped, and never updated. The
Limitations list also stated flatly that scanned PDFs have no text layer to
edit. Corrected, with OCR added to the feature list and the honest caveat that
recognition is good but not perfect, so anything being redacted on the strength
of it should be checked.

---

## Not changed, and why

- **Main-thread rasterisation.** `yieldToUI` turns the export freeze into
  per-page bursts but the work is still on the main thread. Moving it to a
  worker with `OffscreenCanvas` is the real fix and a substantial change;
  windowing the viewer (#7) removes the larger share of the felt cost.
- **`bakeCurrent()` resets edit history.** The finishing operations rebuild the
  document by design. Noted in `CLAUDE.md` as expected; not revisited.
