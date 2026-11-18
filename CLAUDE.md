# CLAUDE.md

Guidance for AI coding sessions working in this repo. Read this first — it
should save you from re-scanning everything. This file is an **index**: the
long per-area gotchas live in `docs/notes/`, and each is linked below with
when to read it. Open only the note for the area you're touching.

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

In the sandbox, point the suite at the preinstalled browser:
`PW_EXECUTABLE_PATH=/opt/pw-browsers/chromium-<build>/chrome-linux64/chrome npm test`
(`ls /opt/pw-browsers` for the build). Details in `docs/notes/testing.md`.

**Which spec guards what** — the list mapping each spec in `tests/` to the
invariant it protects (and why it exists) is in
[`docs/notes/testing.md`](docs/notes/testing.md#which-spec-guards-what). Read it
when a spec fails or before you add one. Specs: `app`, `privacy`, `rendering`,
`export`, `ocr`, `font`, `baseline`, `colors`, `find`, `phone`, `shell`,
`icons`, `marks`, `affordance`, `shape`, `fragment`, `line`, `ligature`, `chrome`, `tabs`,
`overlays`, `placement`, `edge`, `keyboard`, `saved`, `password`, `sign`, `pages`, `sidebar`, `patterns`, `hidden`, `update`, `protect`. If you add a feature that touches privacy, the export bytes, or
per-page rendering, add a spec for it.

## Architecture

- **Render path** — `pdf/loader.ts` uses **PDF.js** (`pdfjs-dist`) to rasterize
  each page to a `<canvas>` and extract text fragments (position + a *generic*
  font family). The pdf.js worker is bundled via `?url` and set as
  `GlobalWorkerOptions.workerSrc`. The document's real per-fragment fonts come
  from `pdf/fontInfo.ts` after the page paints — see `docs/notes/text-fidelity.md`.
- **Write path** — `pdf/exporter.ts` uses **pdf-lib** to produce the output.
  "pdf-lib" here means the maintained fork **`@cantoo/pdf-lib`**: import it by
  that name, never `"pdf-lib"` (upstream 1.17 is a devDependency only, the
  tests' independent reader). Vite aliases `pdf-lib` to the fork so
  `@signpdf`'s own import gets the same engine — see `rendering.md`.
  Non-redacted pages keep vector content (edits/text/annotations/stamps drawn on
  top); **redacted pages are rasterized to an image** so content is truly
  removed. `pageOps.ts` (reorder/rotate/merge/extract) and `finishOps.ts` (page
  numbers/watermark/export-as-images) also use pdf-lib.
- **Workspace (tabs)** — several PDFs can be open at once, one `DocTabs` tab
  each. `App.tsx` is the *workspace shell*: the tab list, opening/closing,
  password prompt, restore, autosave, prefs, the status line. The document *in
  front* is a `DocumentEditor.tsx`, mounted fresh per document (keyed by tab id
  and a load generation), so nothing that edits it knows tabs exist. The others
  are *parked* in `tabs: OpenDoc[]` (`workspace.ts`) with their whole undo
  history, their scroll position and zoom, and their change count. See
  `docs/notes/tabs.md` before touching `openBytes` or the split.
- **State** — `hooks/useHistory.ts` holds a single `DocState`
  (`edits, textBoxes, redactions, annotations, stamps`, and the page plan
  `pages` — see `docs/notes/pages.md`) with undo/redo and
  gesture coalescing (pass a stable `key` to `doc.set` to collapse a continuous
  drag/type into one history step). A `revision` counter re-seeds
  `contentEditable` overlays on undo/redo. `DocumentEditor.tsx` orchestrates
  the document; `App.tsx` the workspace around it.
- **Viewport** — `hooks/useViewport.ts`: fit-to-width base scale + zoom
  multiplier, app-managed pan/pinch/double-tap/⌘-wheel. The scroll surface is
  `.viewer__scroll` inside a non-scrolling `.viewer` frame so the zoom control
  stays pinned. Fit-scale is measured only on mount / doc load / window resize
  (NOT on panel toggles) so opening the properties panel doesn't rescale-jump.
- **Overlays** — one absolutely-positioned overlay per page (`PageView.tsx`)
  holds `EditableFragment`, `TextBoxItem`, `RedactionItem`, `AnnotationLayer`
  (SVG), `NoteItem`, `StampItem`. All coordinates are PDF units (origin
  bottom-left) converted to screen via `scale`.


## Rules every session needs

The one-line version; the reasoning (and the bug each rule came from) is in the
linked note.

- **No off-origin anything.** A build-time CSP (`default-src 'self'`) enforces
  it; no CDN/font dependencies, never `'unsafe-*'`. → privacy-and-export
- **The exporter is the single choke point.** Anything reaching the output file
  is validated there (`safeLinkUrl`, `sanitize.ts`), not only in the UI.
  → privacy-and-export
- **The preview must not lie about the file.** Overlays, colours, fonts, marks
  and stacking are computed by the same code the exporter uses; never keep a
  second copy. → text-fidelity, canvas-tools
- **On the redaction raster path, cover rectangles are measured, never
  estimated.** → privacy-and-export
- **Keep the render path free of pdf-lib**, and keep props into memo'd
  `PageView` referentially stable. → rendering
- **No native UI**: `ConfirmDialog`, `ColorField`, `TooltipHost` + `data-tip=`.
  → shell
- **Every icon name is mapped and means one thing.** → shell
- **`corner-shape` never touches the document.** → shell

## Notes by area — read before touching…

| Note | Read before touching |
| --- | --- |
| [`docs/notes/testing.md`](docs/notes/testing.md) | any spec in `tests/`, fixtures/helpers, or a one-off Playwright exploration — and it's the spec → invariant map |
| [`docs/notes/privacy-and-export.md`](docs/notes/privacy-and-export.md) | the CSP / asset loading, `exporter.ts`, link/action sanitising, the redaction raster codec, `optimizeImages.ts`, `download.ts` |
| [`docs/notes/rendering.md`](docs/notes/rendering.md) | `PageView`, `useRenderWindow`, thumbnails, memo'd props, and lazy-loading pdf-lib |
| [`docs/notes/text-fidelity.md`](docs/notes/text-fidelity.md) | fonts (`fontInfo.ts`, `style.ts`), baselines (`textBaseline.ts`), overlay insets and the selection mark, sampled edit colours (`fragmentColors.ts`) |
| [`docs/notes/tabs.md`](docs/notes/tabs.md) | `openBytes`, parking/unparking documents, the `App` / `DocumentEditor` split, `releaseDoc`, autosave keys |
| [`docs/notes/shell.md`](docs/notes/shell.md) | icons, the app bar, the Inspector, floating chrome, `corner-shape`, motion tokens, `opens` marks, native-UI replacements, prefs, theme, finishing ops |
| [`docs/notes/canvas-tools.md`](docs/notes/canvas-tools.md) | the Draw tool and drawbar, `AnnotationLayer`, stacking order, multi-select drag, tick/cross marks, touch select-first |
| [`docs/notes/pages.md`](docs/notes/pages.md) | the page plan (`DocState.pages`, `pagePlan.ts`), turned pages and pointer maths (`toLocal`), Organise's apply, page order/deletion in export |
| [`docs/notes/ocr.md`](docs/notes/ocr.md) | tesseract.js, `setup-ocr`, OCR fragments, the engine-cache service worker |

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
