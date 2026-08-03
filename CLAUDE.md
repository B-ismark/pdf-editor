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
touched: `docs/UI-UX-AUDIT.md` (usability, accessibility, platform conformance)
and `docs/PRODUCT-AUDIT.md` (privacy, security, performance, export integrity —
including measurements, and the one finding deliberately left open).

## Commands

```bash
npm install
npm run dev        # Vite dev server
npm run build      # tsc -b && vite build  → dist/   (run this before committing)
npm run preview    # serve dist/ (defaults to :4173 with --port)
npm run typecheck  # tsc -b --noEmit
npm test           # Playwright end-to-end suite against dist/ (18 specs)
```

There is **no unit-test runner / linter** configured. Verification is
`npm run build` (which type-checks) plus **`npm test`** — a Playwright suite
(`tests/`, `playwright.config.ts`) that serves `dist/` and drives it in real
Chromium. `.github/workflows/ci.yml` runs both on every push and PR;
`deploy.yml` handles Pages separately. **Run both before committing.**

`tests/app.spec.ts` covers feature behaviour. The rest cover the invariants
type-checking can't see, and each exists because it broke once:

- `privacy.spec.ts` — no off-origin request or `<link>`; CSP present, restrictive,
  and not silently widened; autosave stores a session and the toggle erases it;
- `rendering.spec.ts` — the render window stays bounded on a 150-page document,
  doesn't grow while scrolling, and the page you scroll to is actually painted;
- `export.spec.ts` — an unsafe link URL is flagged in the UI and absent from the
  exported bytes, no authoring metadata is written, and a redacted page has no
  extractable text while its neighbour keeps its own;
- `ocr.spec.ts` — an image-only page becomes findable text, with the engine and
  language model loaded from our own origin only; and the engine cache holds the
  wasm core and *nothing else* (skips if assets are absent);
- `find.spec.ts` — the active match is on screen and clear of the find bar;
- `phone.spec.ts` — the status message clears the zoom pill and the tool dock.

If you add a feature that touches privacy, the export bytes, or per-page
rendering, add a spec for it — that's where this project's real invariants live.
Fixtures are generated at run time in `tests/fixtures.ts`; shared page helpers
(request/error watching, opening a doc, canvas stats) are in `tests/helpers.ts`.
See `docs/PRODUCT-AUDIT.md` for the findings behind each spec.

## Architecture

- **Render path** — `pdf/loader.ts` uses **PDF.js** (`pdfjs-dist`) to rasterize
  each page to a `<canvas>` and extract text fragments (position + font). The
  pdf.js worker is bundled via `?url` and set as `GlobalWorkerOptions.workerSrc`.
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
- **Anything that reaches the output file is validated at the exporter**, not
  only in the UI: link URLs go through `safeLinkUrl` (`pdf/url.ts`, an
  allow-list) and copied annotation actions through `sanitize.ts` (also an
  allow-list, `/Next` chains included). The exporter is the single choke point,
  so a value from a restored session can't bypass a UI check.
- **On the redaction raster path, anything not covered is permanent.** The
  raster is all that survives, so cover rectangles must be *measured*
  (`ctx.measureText` / `widthOfTextAtSize`), never estimated from character
  counts. That estimate shipped once and left original text visible past the
  cover for wide glyphs and non-Latin scripts.
- **Download via `src/download.ts`.** It attaches the anchor before clicking and
  defers `revokeObjectURL`; revoking synchronously races the browser's fetch of
  the blob and cancels downloads on Firefox/Safari.
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
