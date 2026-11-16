# Rendering and bundle size

_Read before touching `PageView`, `useRenderWindow`, thumbnails, props passed from `App` into memo'd pages, or imports that might pull pdf-lib into the initial bundle._

Moved verbatim from `CLAUDE.md`; the index there links here.

## Gotchas

- **Per-page rendering is windowed.** `useRenderWindow` (IntersectionObserver)
  gates both the canvas raster and the overlay subtree in `PageView`, and the
  thumbnails in `Thumbnail`. Layout stays eager (page frames keep their true
  size, so scroll anchors are exact) — only the contents are windowed. Two
  traps: the observer's `root` must be the *scrolling ancestor*, since
  `rootMargin` doesn't expand an intervening clip; and `PageView` is `memo`'d,
  so props passed from `App` must be referentially stable (per-page overlay
  arrays are bucketed once via `bucketByPage`, and absent `DocState` fields use
  the shared `NO_LINKS` / `NO_FORM_VALUES` constants, never fresh literals).
- **pdf-lib is lazy-loaded.** `exporter.ts`, `finishOps.ts`, and the
  `Organize`/`FinishDialog`/`SignatureDialog` components are `import()`-ed /
  `React.lazy`-ed on demand so pdf-lib stays out of the initial bundle. **Keep
  the render path free of pdf-lib** — e.g. `isFragmentModified` lives in the
  pure `pdf/style.ts`, not `exporter.ts`. If you add code the initial render
  needs, don't import it from a pdf-lib module.
