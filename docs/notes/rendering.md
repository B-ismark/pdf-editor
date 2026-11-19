# Rendering and bundle size

_Read before touching `PageView`, `useRenderWindow`, thumbnails, props passed from `DocumentEditor` into memo'd pages, or imports that might pull pdf-lib into the initial bundle._

Moved verbatim from `CLAUDE.md`; the index there links here.

## Gotchas

- **Per-page rendering is windowed.** `useRenderWindow` (IntersectionObserver)
  gates both the canvas raster and the overlay subtree in `PageView`, and the
  thumbnails in `Thumbnail`. Layout stays eager (page frames keep their true
  size, so scroll anchors are exact) — only the contents are windowed. Two
  traps: the observer's `root` must be the *scrolling ancestor*, since
  `rootMargin` doesn't expand an intervening clip; and `PageView` is `memo`'d,
  so props passed from `DocumentEditor` must be referentially stable — see the next point.
- **A page re-renders only when *its* props change. Keep it that way.** On a
  150-page file one stray prop means 150 page renders per keystroke, and
  `rendering.spec.ts` ("page memo") counts them. The rules:
  - **Per-page data comes from `hooks/usePageBuckets.ts`.** `usePageArrays`
    (overlays), `usePageRecords` (fragment `edits`) and `usePageSets` (the
    multi-selection) keep each page's bucket object until that page's contents
    change. A plain re-bucket hands every page a fresh array per change. Pages
    with nothing get the shared `NO_ITEMS` / `NO_EDITS` / `NO_IDS`; absent
    `DocState` fields use `NO_LINKS` / `NO_FORM_VALUES`. Never a fresh literal.
  - **Selection-shaped props go only to their own page.** `selection`,
    `editingId`, `autoFocusId` and `activeFindId` are passed as `null` to every
    page but the one the id lives on (`pageOf`). Don't pass a global value.
  - **`doc` in `DocumentEditor` is the history's verbs only, and is stable.** Callbacks that
    write the document depend on `[doc]`. Anything that *reads* it uses
    `docHistory.state` and lists that as a dependency, or goes stale. (`history`
    is taken: it's the browser's, used for the phone Back guard.)
  - **A callback handed to pages must not depend on state that's replaced on
    every click.** `moveMulti` reads `multi` through a ref because each selection
    change resets `multi` to a fresh `[]`.
  - `formValues` is still one record for the document: typing in a form field
    re-renders every page. Bucket it if that ever matters.
- **`useRenderWindow` starts `near = false`** and seeds the true value in a
  layout effect (one rect check before first paint). Starting at `true` mounted
  every page's content for one frame. Elements that aren't rendered at all
  (`display: none`) are skipped by the seed: their 0×0 rect at the origin reads
  as on screen.
- **Thumbnails give everything back.** A thumbnail waits `SETTLE_MS` in the
  window before rendering, so a fling doesn't queue every page it passes.
  Leaving the window aborts an in-flight render (`renderPageToCanvas` takes an
  `AbortSignal` and cancels the pdf.js task), and removes and zeroes a finished
  canvas. Their slots have a fixed aspect ratio, so this doesn't move layout.
  Thumbnails visible when they mount skip the settle (opening the rail, an
  Organize card remounted by a move), and a new image replaces the old one
  only once it's ready, so nothing flashes empty.
- **Never put an imperatively-made canvas into a node React renders children
  into.** The thumbnail's canvas lives in `.thumb__host`, which React leaves
  empty, with the error mark beside it. When the canvas shared a parent with
  the mark, clearing the mark after a retry threw `removeChild`
  NotFoundError and unmounted the whole app (there is no error boundary).
- **pdf-lib is lazy-loaded.** `exporter.ts`, `finishOps.ts`, and the
  `Organize`/`FinishDialog`/`SignatureDialog` components are `import()`-ed /
  `React.lazy`-ed on demand so pdf-lib stays out of the initial bundle. **Keep
  the render path free of pdf-lib** — e.g. `isFragmentModified` lives in the
  pure `pdf/style.ts`, not `exporter.ts`. If you add code the initial render
  needs, don't import it from a pdf-lib module.
- **One PDF engine: `@cantoo/pdf-lib`.** Every `src/` import names the fork.
  `@signpdf/placeholder-pdf-lib` imports `"pdf-lib"` itself, and objects from
  two copies of the library can't share a document — the writer's `instanceof`
  checks fail and signing never produced a file. `vite.config.ts` aliases
  `pdf-lib` to the fork; `sign.spec.ts` verifies a real signature and fails if
  the alias goes. Upstream `pdf-lib` stays only as a devDependency for the
  tests, which deliberately read the output with a different library.
- **A page's text arrives after the page.** `loadLayout` (`loader.ts`) reads
  page sizes, turns and references only, and every page starts `textPending`
  with no fragments or fields. `textIndex.ts` then reads the text one page at a
  time from the same parse the pages render from, hands it over in batches
  (the first page at once, the rest on a ~120 ms timer), and `App` merges each
  batch into every tab showing those bytes with `fillPages`, which keeps OCR's
  words and leaves unchanged pages the same objects. A page scrolled into view
  is read next (`wantText`, from `PageView`). The rules:
  - **Anything that reads the whole document goes through `completeText`
    first**: export (the exporter does it itself, so every caller is covered),
    the whiteout check (`findUnsafeCovers` throws on a pending page, so a
    missed caller fails loudly), copy/export text, OCR, Compare, Download all.
    Reading a half-read document directly treats unread pages as having no text.
  - **A page that won't read stays unread**, in the walk and in
    `completeText` (which rejects): calling it "no text" would let a whiteout
    over it pass the check. A download that waits on the text is busy from the
    press, takes its saved mark at the press, and stops if the editor unmounts.
  - **No text *yet* isn't no text.** The Inspector says "Reading text…", the
    picture-page hint skips pending pages, and an edit restored onto an unread
    page counts as a change until its fragment can be compared.
  - **Live views keep up instead of waiting**: Find and the patterns search
    what has arrived; Redact all and the patterns' Redact wait for every page.
  - Fragment ids are `page:item`, so they're the same whenever a page is read.
- **Long loops yield through `yieldToUI` (`pdf/yield.ts`), never `setTimeout(0)`.**
  Nested timeouts clamp to ≥4 ms, which made a 150-page export spend most of
  its time asleep. `yieldToUI` only gives the browser a turn once ~12 ms of work
  has run, and posts a `MessageChannel` message, which isn't clamped. Not
  `scheduler.yield`: it resumes ahead of React's queued render, so progress
  never painted. Call it as often as you like; most calls return immediately.
