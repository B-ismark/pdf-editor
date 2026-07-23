# CLAUDE.md

Guidance for AI coding sessions working in this repo. Read this first — it
should save you from re-scanning everything.

## What this is

A **fully client-side, in-browser PDF editor** (React + TypeScript + Vite).
Upload a PDF and edit text in place, add text/notes/shapes, sign, redact,
organize pages, and download. **No server, no uploads** — privacy is the point.
Deployed as a static site to GitHub Pages: https://b-ismark.github.io/AI-repos/

See `README.md` for the user-facing feature list and the detailed
"Limitations" section (fonts approximated, redaction rasterizes the page, no
OCR/encryption, etc.). Don't duplicate that here.

## Commands

```bash
npm install
npm run dev        # Vite dev server
npm run build      # tsc -b && vite build  → dist/   (run this before committing)
npm run preview    # serve dist/ (defaults to :4173 with --port)
npm run typecheck  # tsc -b --noEmit
```

There is **no test runner / linter** configured. Verification is done with
ad-hoc Playwright scripts (see "Testing" below) plus `npm run build` (which
type-checks). Always `npm run build` before committing.

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

- **Self-contained assets only.** The sandbox proxy blocks external hosts, so
  web fonts / CDNs may not load. Icons are **Lucide** (`Icon.tsx` maps semantic
  names → Lucide components); fonts fall back to system. Don't add CDN/font
  dependencies.
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

## Testing (Playwright)

No browser download in the sandbox — use the **pre-installed Chromium**:

```js
chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" })
```

- `npm install` prunes the unsaved `playwright` package — after any install run
  `npm install --no-save playwright` again before testing.
- Playwright resolves `playwright` from the project's `node_modules`, so put the
  test script **in the project root** (not the scratchpad) or it won't resolve.
- `npm run build` then `npx vite preview --port 4173`; drive `http://localhost:4173/`.
  Load a PDF with `setInputFiles('input[type=file]', …)`; test PDFs live in the
  session scratchpad. Test both desktop (e.g. 1280×820) and mobile
  (390×844, `isMobile:true, hasTouch:true`) and both themes.

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
