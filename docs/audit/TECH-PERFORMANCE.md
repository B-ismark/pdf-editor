# Technology & Performance Audit: PDF Editor

**Date:** 2026-11-16  **Scope:** committed `HEAD` (`166c581`), built from a clean `git archive` copy and served on its own port.
Another session was editing the working tree while this audit ran (tabs work in `App.tsx`, `useAutosave.ts`, `useHistory.ts`, `loader.ts`), so nothing here was measured against those uncommitted changes.

**Environment:** headless Chromium 1243, 1280×820, DPR 1. Where noted, CDP throttling was 4× CPU and 10 Mbps / 40 ms.
**Fixtures** (generated with pdf-lib): `t12`, `t150` and `t600` are text-only Helvetica pages, the same shape as `tests/fixtures.ts`. `rich150` has 150 pages, an embedded subset TTF (Carlito regular and bold), and one 800×500 RGB image shared by every page (1.33 MB).
**Prior findings** in `docs/PRODUCT-AUDIT.md` were not re-reported, except #8, which has partly regressed (see §2.4).

---

## 1. Measurements

### 1.1 Bundle (`vite build`, HEAD)

| Chunk | What it is | Raw | gzip | When loaded |
|---|---|---|---|---|
| `index-*.js` | app code | 128 kB | 41 kB | **landing** |
| `react-*.js` | react-dom + react + **lucide-react** + rollup CJS helpers | 167 kB | 50 kB | **landing** |
| `pdfjs-*.js` | pdf.js display API | 357 kB | 106 kB | **landing** (modulepreload) |
| `index-*.css` | styles | 45 kB | 9 kB | **landing** |
| `pdf.worker.min-*.mjs` | pdf.js worker | 1,376 kB | 402 kB | first document open |
| `PDFButton-*.js` | **pdf-lib** (+ pako, standard-font AFM data). Rollup named the chunk after its first module. | 434 kB | 180 kB | lazy: export, organize, finish, compress, sign |
| `fontkit.es-*.js` | @pdf-lib/fontkit (Vite's report says "579 kB" because it counts characters; the file is 717 kB) | 717 kB | 331 kB | lazy: only when exporting edited *existing* text |
| `index-DwWk*.js` | node-forge | 284 kB | 75 kB | lazy: certificate signing |
| `mozjpeg_enc-*.wasm` + `encode-*.js` | @jsquash/jpeg | 252 + 19 kB | 59 + 8 kB | lazy: redaction export |

- **Initial load is 652 kB of JS (197 kB gz) plus 9 kB of CSS (gz).** The modulepreloads in `dist/index.html` are `react` and `pdfjs`. Neither the 434 kB pdf-lib chunk nor the 717 kB fontkit chunk is in the initial graph. Both are reached only through `import()` (from `exporter.ts`, `finishOps.ts` and the lazy dialogs), so the lazy-loading rule in `CLAUDE.md` holds.
- **`manualChunks` matches `id.includes("react")`.** That also pulls in `lucide-react` and Rollup's `commonjsHelpers`. Every lazy vendor chunk (pdf-lib, fontkit, node-forge) therefore imports from `react-*.js`, which you can see in the chunk heads (`import{ai as Xu}from"./react--…js"`). It costs nothing at runtime, but each icon change invalidates the long-lived React cache chunk.
- **pdf.js loads on the landing page** although nothing needs it until a file is chosen: 106 kB gz on the critical path.

### 1.2 Cold start (landing page)

| | DCL | FCP | JS heap |
|---|---|---|---|
| Unthrottled | 56 ms | 88 ms | 3.2 MB |
| 4× CPU, 10 Mbps / 40 ms | 355 ms | 456 ms | 3.2 MB |

Opening `t12` under the same throttling painted the first page in **717 ms**. That includes fetching and compiling the 402 kB-gz worker.

### 1.3 Opening a document (time from `setInputFiles` to the first painted canvas)

| Doc | First page painted | Long tasks | Longest | TBT | Heap after | DOM nodes after |
|---|---|---|---|---|---|---|
| t12 | 216 ms | 0 | – | 0 | 4.7 MB | 454 |
| t150 | 543 ms | 2 | 176 ms | 128 ms | 7.4 MB | 868 |
| rich150 | 632 ms | 2 | 175 ms | 137 ms | 7.0 MB | 828 |
| t600 | **1,584 ms** | 3 | **589–751 ms** | 660 ms | 16.3 MB | 2,218 |

- **First commit for t600:** 600/600 `PageView`s and **18,107 components rendered**, with a peak of **15,000 fragment overlays and 18,827 DOM nodes**. It then settled to 50 fragments and 2,081 nodes. The cause is in §2.4.
- **pdf.js cost split** (Node, same fixtures):

  | Doc | Page sizes only | Sequential `getTextContent` + `getAnnotations` | Same, run in parallel |
  |---|---|---|---|
  | t600 | 38 ms | 891 ms | 1,024 ms |
  | t150 | 8 ms | 305 ms | 267 ms |

  The worker is single-threaded, so parallel extraction doesn't help. Deferring extraction does (see §2.5).
- **Steady state is excellent.** Two live canvases, 2.3 MP, whatever the document length. The render window from finding #7 works.

### 1.4 Interaction (150 pages unless noted)

**Selecting a fragment.** Three commits, each rendering **150 of 150 `PageView`s** (281 components).

**Typing.** 31 commits for 31 characters, and **every commit re-renders 150 of 150 `PageView`s.** Keystroke-to-commit time:

| Doc | 1× CPU p50 / max | 4× CPU p50 / max |
|---|---|---|
| t12 | 2.1 / 4.5 ms | – |
| t150 | 3.8 / 4.4 ms | 17.7 / 23.6 ms |
| t600 | 10.2 / 14.4 ms | **61 / 123 ms** |

Cost is linear in page count, so the `memo` on `PageView` is not doing its job (§2.3).

**Scrolling.** The whole of t150 / rich150, 300 px per frame: 645 frames, p50 16.7 ms, p95 18.5–19.1 ms, max 27–30 ms, **0 long tasks**. Heap 10–11 MB afterwards, still two live canvases.

**Zoom.** Three steps produced 0 long tasks. Every commit re-rendered all 150 `PageView`s, which is expected here because `scale` changed.

**Page rail.** Opening it on t150 **created 150 canvases** and t600 **created 600**, but only 6 thumbnails stayed on screen. Long tasks totalled 257 ms on t150 and **1,437 ms on t600** (max 310 ms). This is finding #8 regressing (§2.4).

**Export**, using the Download button with one edited fragment:

| Doc | Path | Time | Output size | Main thread |
|---|---|---|---|---|
| t150 | vector | 1.18 s | 125 KB → 133 KB | 0 long tasks |
| rich150 | vector | 2.2 s | **1.33 MB → 182 MB (137×)** | max long task 95 ms |
| t150 | 1 redacted page | 1.57 s | 410 KB | **one 540 ms task** |
| rich150 | 1 redacted page | 3.1 s | 182 MB | **one 1,145 ms task** |

- The 182 MB file contains **150 image XObjects**; the source has **1** (§2.1).
- **Idle time in the export loop:** 150 chained `setTimeout(0)` calls take **599 ms** because of the 4 ms nesting clamp. A `MessageChannel` takes 2 ms for the same 150 hops. About half of t150's export time is this clamp (§2.6).

### 1.5 Opening several documents in sequence

Docs were opened through the app's own open input:

| Opened | pdf.js workers alive | `document.fonts.size` | Main JS heap |
|---|---|---|---|
| rich150 | 1 | 2 | 6.9 MB |
| t150 | **2** | 4 | 8.2 MB |
| rich150 | **3** | 6 | 9.0 MB |
| t12 | **4** | **8** | 6.8 MB |

One pdf.js worker thread, holding a full parsed copy of the file, and the document's FontFaces leak for every document ever opened. The main-thread heap looks flat because the leaked memory sits in worker heaps (§2.2).

---

## 2. Findings and recommendations

Each item gives **Impact / Effort / Risk**. Items 2.1–2.4 are bugs with measured cost and should come first. Items 2.2, 2.3, 2.8 and 2.9 also block the multi-document tabs feature.

### 2.1 Export duplicates shared resources once per page (P0, export integrity)
`exporter.ts:522` calls `out.copyPages(src, [i])` once per page, and `pageOps.ts:48` does the same for Organize, merge and extract. Every pdf-lib `copyPages` call builds a new `PDFObjectCopier`, so anything pages share (images, fonts, form XObjects, ICC profiles) is deep-copied **per page**. Measured: a 1.33 MB document exports at **182 MB**. Even standard-font-only t150 grows 6%. After Organize, the duplicated bytes become the working document, so autosave and later exports carry the blow-up too.
- **Fix:** copy every vector page in a **single** `copyPages(src, indices)` call before the loop, then place them in order (raster pages are inserted separately). Apply the same pattern in `pageOps.ts`, grouped by source document. Add an `export.spec.ts` assertion that a shared-image fixture stays within ~1.1× its source size.
- **Related loss** (from reading the code): because export builds a *new* `PDFDocument`, catalog-level structure is dropped. That includes outlines/bookmarks, named destinations (so `/Dest` links break), `/PageLabels`, `/StructTreeRoot` (tagged-PDF accessibility; copied pages keep dangling `/StructParent`s), `/OCProperties` (optional-content layers lose their definitions; `optimizeImages.ts` deliberately carries `/OC`) and `/Lang`. A medium-term option is to edit `src` in place (remove pages, insert raster pages, then sanitize) instead of rebuilding.
- **Impact:** very high (file size, memory, autosave quota). **Effort:** S for the batch copy; M for in-place export. **Risk:** low for the batch copy. In-place export needs the metadata-stripping and sanitize specs re-checked.

### 2.2 pdf.js documents are never destroyed, and each parse spawns a worker thread (P0, leak; blocks tabs)
- `getDocument()` without a `worker` parameter constructs a `new PDFWorker()`, which is a new `Worker` thread (pdf.js `api.js`: `workerParams.port ? PDFWorker.fromPort(...) : new PDFWorker(...)`).
- **Opening one document parses it twice.** `loadPdf` runs its own `getDocument` and destroys it. `getCachedDoc` then reparses with a second worker that is **never destroyed**. The `WeakMap<ArrayBuffer, …>` releases its key, but the worker's message handler keeps the proxy, the parsed document and the transferred bytes alive.
- **Export** creates a third worker and parse in `fontEmbed.ts`. That one is destroyed.
- **Measured:** workers go 1→2→3→4 and FontFaces 2→4→6→8 across four opens.
- **Fix:**
  1. Create **one shared `PDFWorker`** and pass it as `worker` to every `getDocument` (loader, fontEmbed). That saves worker start-up and 1.38 MB of script evaluation per parse.
  2. Replace the WeakMap with an explicit registry keyed by document id, with `destroy()` on close or replace (which also clears FontFaces).
  3. Make `loadPdf` reuse the cached proxy, so each document is parsed once.
- **Impact:** high for long sessions; mandatory for tabs. **Effort:** S–M. **Risk:** low. The font harvesting in `fontInfo.ts` must keep reading the *same* proxy that painted the canvas, and a registry preserves that.

### 2.3 `PageView` memo is defeated on every keystroke and selection (P0 perf; blocks tabs)
Measured: **150 of 150** `PageView`s render per keystroke and per selection change. There are three independent causes:
1. `useHistory` returns a **fresh object literal** every render. Twenty-two `useCallback`s list `[doc]` as a dependency, including every `on*` callback passed to `PageView`, so all of them change identity on every App render.
2. `edits` (the whole document's map) is passed to every page.
3. `selection` is passed to every page.

**React Compiler would not fix this by itself.** It would memoize the returned object on `h`, so `doc` would still change on every edit, and callbacks reading `doc.set` would still be rebuilt.
- **Fix:**
  - Have `useHistory` return a `useMemo`'d object, or destructure the stable `doc.set`, `undo` and `redo` and depend on those.
  - Bucket `edits` by page the way `bucketByPage` already does for the other overlays (fragment ids are `${page}:${item}`).
  - Pass each page `selectedId | null` (and `editingId` / `autoFocusId`) only when it belongs to that page.
  - Do the same for `multiIds`.
- **Expected result:** one `PageView` render per keystroke instead of N. The t600 4×-CPU keystroke goes from 61/123 ms to roughly what t12 costs today.
- **Impact:** high on long documents and phones. **Effort:** S. **Risk:** low. `fragment.spec` and `overlays.spec` cover the behaviour.

### 2.4 `useRenderWindow` starts every element "near" (P0; partly regresses #8)
`useState(true)` means the first commit treats **every** page as visible. The IntersectionObserver only corrects this a frame later:
- **Viewer:** on t600 all 600 overlays mount, which is 15,000 `EditableFragment`s and 18,827 nodes, inside a 589–751 ms long task. The canvas render is saved only by `PageView`'s 90 ms debounce.
- **Thumbnails** have no debounce, and `renderPageToCanvas` can't be cancelled. Opening the rail therefore **rasterises every page** (150 / 600 canvases created, 1.4 s of long tasks at 600 pages) and throws away all but six of them. The existing `rendering.spec.ts` checks the viewer, not the rail.
- **Fix:** start with `near = false` and seed it from a synchronous rect test in a layout effect, or have the parent pass `initiallyNear={index < 3}`. Make the thumbnail render cancellable (or debounce it like `PageView`) and release its canvas when it leaves the window. Add a rail case to `rendering.spec.ts`.
- **Impact:** high (−0.75 s first paint and −1.4 s rail jank at 600 pages). **Effort:** S. **Risk:** low.

### 2.5 Text extraction blocks first paint (P1)
`loadPdf` walks every page with `getPage`, `getTextContent` and `getAnnotations` **before** `setPdf`, so the first paint waits on the whole document. Layout only needs page sizes, which take 38 ms for 600 pages against 891 ms for text, and on real, text-dense documents text extraction is far slower than on these fixtures.
- **Fix:** resolve viewBoxes and rotation first, render, then fill `fragments` and `fields` in the background, page by page in idle time, prioritising pages inside the render window. Find and search-and-redact show "indexing n / N" until done.
- **Impact:** first paint becomes nearly independent of page count. **Effort:** M. `PageData.fragments` becomes progressively filled, and `fragmentById`, find, and the edited-count/`anyEdits` logic need to tolerate that. **Risk:** medium; this is the item that needs real spec work.

### 2.6 The export loop sleeps about 4 ms per page (P1, trivial)
`yieldToUI()` is `setTimeout(0)` and is called once per page in a promise chain, so the HTML nesting clamp makes it 4 ms per page. Measured: 599 ms of the 1.18 s t150 export.
- **Fix:** use `scheduler.yield()` (Chromium 129+) with a `MessageChannel` fallback, and yield only when more than ~12 ms has passed since the last yield.
- **Impact:** roughly halves vector export on long documents. **Effort:** XS. **Risk:** none.

### 2.7 Raster work stays on the main thread (P1)
> **Done (roadmap 9b).** Encoding moved to `codecWorker.ts`; the lossless raster is embedded as a raw flate stream; `isolatePageResources` stopped inflating images. One redacted page now exports with no main-thread task over 50 ms (was 1.0–1.2 s). Guarded by `codec.spec`.

A single redacted page froze the UI for **540 ms** (t150) and **1,145 ms** (rich150). The page is rendered at 3× (about 4.5 MP), then three things run on the main thread:
- `getImageData` for colour sampling;
- `getImageData` again plus the **mozjpeg WASM encode**;
- the PNG encode (`toBlob` is async in Chromium).

The fix is targeted:
- Move the JPEG encode, and the PNG-vs-JPEG size comparison, into a module Worker. `@jsquash/jpeg` works in workers. Transfer the `ImageData.data` buffer, or use `canvas.transferToImageBitmap` → `OffscreenCanvas.convertToBlob` for PNG.
- Treat `optimizeImages.ts` (flate inflate, un-predict, re-encode) the same way.
- Leave pdf.js page rendering where it is. Its display layer isn't supported off the main thread, and a per-page render is a few hundred ms at most.
- Don't move the whole exporter into a worker yet. After 2.1 and 2.6 the vector path is cheap. The remaining big main-thread cost is encoding, and the exporter is coupled to main-thread state (font/colour stores, canvas raster).
- **Impact:** removes the ~0.5–1 s freeze per redacted page. **Effort:** M. **Risk:** low–medium; the CSP already allows `worker-src 'self' blob:` and `'wasm-unsafe-eval'`.

### 2.8 Autosave: one slot, eager restore, silent failure (P1; blocks tabs)
- **Single slot.** It writes fixed keys `"current"` and `"current-bytes"`, so tabs need per-document keys plus an order/active manifest.
- **The restore check is eager.** On mount it reads the **whole PDF** out of IndexedDB just to *offer* a restore, which loads 100 MB into memory at startup for a large saved document. Read the meta record only, and fetch the bytes when the user picks Restore.
- **Every debounced save structured-clones the whole `DocState`,** including every stamp's base64 `dataUrl` (an image stamp can be up to 2000 px). Store stamp images once as Blobs, keyed by content hash, and keep only the hash in `DocState`.
- **Failures are silent.** Quota and transaction errors are swallowed, and `navigator.storage.persist()` is never requested, so the "Save session on this device" toggle can read *on* while nothing is stored, or after the browser has evicted it. Safari's 7-day script-storage cap for unvisited sites applies too. Request persistence when the toggle is turned on, and show a status when a write fails.
- **The OCR text layer is not persisted.** OCR words are appended to `pdf.pages` (ids `ocr:p:i`), not to `DocState`. After a restore those fragments are gone, and any **edits to OCR words become dangling ids that the exporter silently skips**, so the user's edits disappear. Persist the OCR words with the session, or re-run OCR on restore before applying edits.
- **Effort:** M. **Risk:** low.

### 2.9 Async operations write back into "whatever document is current" (P1 correctness; critical for tabs)
`runOcr` awaits recognition and then calls `setPdf({ ...pdf, pages })` with the `pdf` it **captured**. `bakeCurrent`, compress (the `compressBaked` ref), organize and export also capture `pdf`. If another document is opened while OCR runs (unless something in the UI prevents that), the old document's bytes come back under the new document's history. With tabs this becomes cross-tab corruption. Every long-running operation should carry a `docId` and apply a functional update to that document's record in a store.
- **Effort:** S once a per-document store exists.

### 2.10 pdf.js configuration gaps (P2)
- **No `cMapUrl` / `cMapPacked`.** PDFs that use predefined non-embedded CMaps (common in CJK documents) can't map their text: `getTextContent` returns garbage or nothing, and glyphs can fail to render. Copy `pdfjs-dist/cmaps` to `public/` (served same-origin, fetched only on demand) and pass `cMapUrl`. Add `standardFontDataUrl` the same way.
- **`isEvalSupported` is not set to `false`.** pdf.js's feature probe calls `new Function`, which the CSP blocks. This matters on the `disableFontFace: true` path in `fontEmbed.ts`. Set the flag explicitly so it never probes.
- **Effort:** XS–S.

---

## 3. Technology choices

| Choice | Verdict | Notes |
|---|---|---|
| **pdfjs-dist 4.10.38** → 5.x | **Upgrade, medium term, not for performance** | v5 brings WASM decoders (JPX/OpenJPEG, among others), which need a self-hosted `wasmUrl` and are CSP-compatible, plus ongoing fixes. 4.10 has the CVE-2024-4367 fix, so there's no urgency. **Risk lives in `fontInfo.ts` and `fontEmbed.ts`.** They read private internals (`page.commonObjs`, `loadedName`, `systemFontInfo`, `.data`), which are the likeliest thing to change; `font.spec` and `baseline.spec` will catch it. Do it together with 2.10. Effort S–M. |
| **pdf-lib 1.17.1** (last release Nov 2021) | **Switch to `@cantoo/pdf-lib`** | A maintained, API-compatible fork. It is effectively a drop-in import rename (verify the AcroForm flatten and `copyPages` behaviour with the export specs), and it adds **encryption**, which the README lists as a limitation. Fix 2.1 on either. Effort S, risk low–medium. |
| mupdf.js | **No** | AGPL; already reasoned out in `docs/RASTER-CODEC-EVAL.md`. |
| PDFium WASM | **Evaluate only if vector redaction becomes a goal** | It is permissively licensed. `FPDFText_GetFillColor` and the font-info APIs could replace the raster heuristics in `fragmentColors.ts` and `fontInfo.ts` entirely, which is real fragility the code works hard to contain. It still doesn't give partial-glyph vector redaction for free, and it is a second rendering engine of several MB. Large effort, so not now. |
| @pdf-lib/fontkit 1.1.1 | **Keep** | Also stale, but pdf-lib needs it for custom fonts. It is lazy (331 kB gz). Warm the `import()` during idle after the first text edit so export doesn't wait on it. |
| **React 18.3** → 19.2 | **Upgrade after fixing 2.3 by hand** | Small effort (types, ref-as-prop). The real prize for tabs is **`<Activity mode="hidden">`**: it keeps a background tab's component state while tearing down its effects (IntersectionObservers, renders, window listeners). The compiler is optional and does *not* replace 2.3. |
| **Vite 5.4** → 7 (or 8 / Rolldown) | **Upgrade, low priority** | It closes the dev-server advisories deferred in PRODUCT-AUDIT #18. Builds already take about 5 s, so Rolldown's speed isn't the reason. Fix the `manualChunks` matcher at the same time (`/node_modules\/(react|react-dom|scheduler)\//`) and check how the function-form `manualChunks` maps under Rolldown. Effort S, risk low–medium. |
| Lazy-load pdf.js on landing | Optional | Moves 106 kB gz off the critical path. Start the import (and `new PDFWorker()`) on file-picker open, drag-enter or hover. Small gain; do it if landing-page LCP matters. |
| tesseract.js 7 | Keep | Already off-thread, self-hosted and lazy. |
| State: 2,688-line `App.tsx` | **Refactor before tabs** (§4) | 31 `useState`, 72 `useCallback`, 14 `useMemo`, 17 `useEffect` and 13 refs in one component. Every state change re-runs that component and, through 2.3, every page. |

---

## 4. Multi-document (tabs) readiness

### 4.1 What is per-document today, all as App-level singletons

| State | Where | Notes |
|---|---|---|
| `pdf` (`LoadedPdf`: bytes + pages, **including OCR fragments**) | `useState` | |
| `fileName` | `useState` | |
| `doc`, the undo history (`DocState`: edits, textBoxes, redactions, annotations, stamps, links, formValues, pageNumbers, watermark) | `useHistory` | `useState` inside App, so it is lost when the tab or document changes |
| Selection and editing: `selection`, `editingId`, `autoFocusId`, `multi`, `coverWarn`, `pendingStamp` | `useState` | |
| Find: `findOpen`, `findQuery`, `findActive` | `useState` | |
| Viewport: `zoom`, `pageWidthPts`, scroll position (in the DOM) | one `useViewport()` | Reset on every open |
| UI: `panelTab` (the code comments call it "per-document"), `navOpen`, `organizeOpen`, `finishTab` | `useState` | |
| Compress caches | `compressBaked`, `compressOut`, `compressLossless` refs | Implicitly tied to the current `pdf` |
| `changeCount` and the `beforeunload` guard | derived | Would need to become "any tab dirty" |

### 4.2 What is global, and fine to stay global
`tool`, `drawTool`, `drawStyle`, `lastTextStyle`, prefs (`dimPages`, `autosaveOn`, `losslessRaster`), theme, signatures, `inspectorOpen`, `drawbarOpen`, menu/palette/sheet flags, `isWide`. The id counter (`counter`, `${prefix}-${n}`) is global, which keeps object ids unique across tabs. That is good, but its restore-time bump logic assumes one document.

### 4.3 Module-level caches and stores

| Store | Key | Collides across docs? | Leaks? |
|---|---|---|---|
| `loader.ts` `docCache` | `WeakMap<ArrayBuffer, Promise<PDFDocumentProxy>>` | No (buffer identity) | **Yes: worker, parsed doc and FontFaces are never destroyed (§2.2)** |
| `fontInfo.ts` | `WeakMap<ArrayBuffer, {ready, pending: Map<pageIndex,…>}>` + one global `listeners` Set | No | Freed with the buffer. Every publish runs every subscriber's snapshot across all mounted documents, which is cheap. |
| `fragmentColors.ts` | same shape as `fontInfo.ts` | No | Same |
| `textBaseline.ts` | `Map<cssFontShorthand, offset>`, max 512, cleared wholesale | No: the shorthand embeds pdf.js `loadedName` (`g_d<docId>_f<n>`), which is unique per parse | Bounded |
| `useSnap` guides, `useDrag` (`dragState`, last-tap, `tapSuppress`), `useModal` stack | module singletons | Only one editor may be *interactive* at a time | No |
| Window listeners in App (`keydown` ×3, `popstate`, `beforeunload`) | per App instance | If two editors are mounted, both receive shortcuts | Gate on the active tab |
| Global DOM queries (`.viewer__scroll`, `[data-page-index]`, `[data-el-id]`, `.panel`) | `document.querySelector` | **Yes, if more than one viewer is in the DOM** | Scope them to a ref |
| Fragment ids `${page}:${item}`, OCR ids `ocr:p:i` | content-derived | **Yes: every document has `0:0`** | Selection, clipboard and edits must be namespaced by document or strictly per-tab |

### 4.4 Autosave
Single slot, with IndexedDB keys `current` and `current-bytes`: the last document written wins (§2.8).

### 4.5 Recommended shape
1. **A `Workspace` store** (Zustand at about 1 kB, or a hand-rolled `useSyncExternalStore` store matching the `fontInfo` and `fragmentColors` pattern), holding `Map<DocId, DocSession>` and `activeId`. Each `DocSession` is:
   `{ id, fileName, bytes, pages, history: { entries, index, lastKey }, view: { zoom, scrollTop }, selection, multi, find, panelTab, pdfHandle }`.
   Move `useHistory`'s reducer into the store so history survives a tab switch.
2. **Extract `<DocumentEditor session>` from `App`** (viewer, overlays, Inspector bindings). Keep the app bar, tabs, prefs and dialogs in `App`. Render **only the active editor**, keyed by `id`, and restore its scroll on activation. Background tabs then cost their history plus bytes (~2× the file, including the worker copy) and **no canvases**. With React 19.2, `<Activity>` gives instant switching without remounting.
3. **Give every async operation (OCR, export, compress, organize, sign) a `docId`** and write back into that session (§2.9).
4. **On tab close:** call `pdfHandle.destroy()` (frees the worker document and FontFaces) and delete the session's IndexedDB keys.
5. **Land 2.2 and 2.3 first.** Without them every tab leaks a worker, and every keystroke re-renders every page of the active document.

---

## 5. Suggested order

| # | Item | Impact | Effort | Risk |
|---|---|---|---|---|
| 1 | 2.1 Batch `copyPages` (exporter + pageOps) + size spec | Very high | S | Low |
| 2 | 2.4 `useRenderWindow` initial state + cancellable thumbnails | High | S | Low |
| 3 | 2.3 Stable `doc` callbacks, per-page `edits`/selection props | High | S | Low |
| 4 | 2.2 Shared `PDFWorker`, single parse, explicit destroy | High (tabs) | S–M | Low |
| 5 | 2.6 Time-sliced yield | Medium | XS | None |
| 6 | 2.8 / 2.9 Autosave restore laziness, OCR persistence, docId-scoped async ops | High (tabs) | M | Low |
| 7 | §4 Workspace store + `DocumentEditor` extraction | Enables tabs | M–L | Medium |
| 8 | 2.5 Background text extraction | High on large docs | M | Medium |
| 9 | 2.7 JPEG/PNG encode and image optimiser in a Worker | Medium | M | Low–Med |
| 10 | `@cantoo/pdf-lib`, React 19.2, pdf.js 5 + cMaps, Vite 7 | Maintenance / features | S each | Low–Med |

*Measurement scripts lived in `scripts/perf-audit/` and were deleted after the run, as instructed.*
