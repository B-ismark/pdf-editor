# OCR (on-device, self-hosted) and the engine cache

_Read before touching `pdf/ocr.ts`, `pdf/engineCache.ts`, `public/sw.js`, `npm run setup-ocr`, or OCR fragments._

Moved verbatim from `CLAUDE.md`; the index there links here.

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

## The engine cache (`public/sw.js`)

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
  the class of bug the `PageView` memo note (`rendering.md`) warns about, one layer up.

Testing gotcha: **don't assert "no network response for the core"** to prove a
cache hit. Playwright attributes the service worker's own `fetch()` to the
worker, so `response.fromServiceWorker()` is true either way and the assertion
passes against a worker that never reads its cache. The spec instead
`route(...).abort()`s the core and requires OCR to succeed anyway.
