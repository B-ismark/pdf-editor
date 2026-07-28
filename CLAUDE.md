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
OCR/encryption, etc.). Don't duplicate that here.

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
npm run fixtures   # generate .fixtures/*.pdf for the checks (once)
npm run check      # end-to-end checks against dist/ (starts its own preview)
```

There is **no unit-test runner / linter** configured. Verification is
`npm run build` (which type-checks) plus **`npm run check`**
(`scripts/check.mjs`) — 31 end-to-end assertions in real Chromium against the
built bundle. **Run both before committing.** The checks cover the invariants
type-checking can't see, and each one exists because it broke once:

- no off-origin request or `<link>`; CSP present and restrictive;
- the render window stays bounded on a 150-page document and doesn't grow while
  scrolling, and the page you scroll to is actually painted;
- an unsafe link URL is flagged in the UI, a bare hostname is accepted, and
  neither a `javascript:` URI nor authoring metadata reaches the exported bytes;
- a redacted page has no extractable text while its neighbours keep theirs;
- autosave stores a session and the toggle erases it;
- OCR turns an image-only page into findable text, loading its engine and
  language model from our own origin only (skipped if assets aren't installed);
- the active Find match is scrolled on screen and clear of the find bar;
- on a phone, the status message clears the zoom pill and the tool dock.

If you add a feature that touches privacy, the export bytes, or per-page
rendering, add a check for it — that's where this project's real invariants live.
See `docs/PRODUCT-AUDIT.md` for the findings behind each of them.

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
  CDN font link had shipped for months against this exact rule; the CSP plus the
  `check` assertion is what stops that recurring. Icons are **Lucide**
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

`npm run check` exercises OCR end-to-end against `.fixtures/scanned.pdf` (an
image-only page with no text layer) whenever the assets are installed, and skips
those checks otherwise. The fixture's bitmap is rendered by a real browser in a
real typeface — a hand-rolled pixel font was tried and Tesseract read 1 of 3
words from it, which makes for a useless assertion.

Recognised words are
appended to a page's `fragments` as a transparent, selectable/searchable text
layer (so Find and search-and-redact work on scans).

## Testing (Playwright)

Start with the committed suite: `npm run build && npm run fixtures && npm run check`.
It starts its own preview server, generates its own PDFs, and covers the
invariants listed under "Commands". Extend `scripts/check.mjs` rather than
writing a throwaway script when the thing you're verifying should stay verified.

For one-off exploration (a new interaction, a screenshot in both themes):

- No browser download in the sandbox — use the **pre-installed Chromium**:
  `chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" })`.
  `scripts/check.mjs` probes a couple of known paths and falls back to
  Playwright's own lookup, so copy that if you need portability.
- `playwright` resolves transitively through the `@playwright/test`
  devDependency, so a plain `npm install` is enough — the old
  `npm install --no-save playwright` step is no longer needed. Node still
  resolves from the project's `node_modules`, so keep scripts inside the repo
  (`scripts/`), not in the scratchpad.
- `npm run build`, then `npx vite preview --port 4173`, and drive
  `http://localhost:4173/`. Load a PDF with
  `setInputFiles('input[type=file]', …)` — `npm run fixtures` writes usable ones
  to `.fixtures/` (git-ignored). Test desktop (e.g. 1280×820) *and* mobile
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
