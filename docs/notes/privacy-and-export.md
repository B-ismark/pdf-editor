# Privacy and export integrity

_Read before touching anything that loads assets, `vite.config.ts`'s CSP, `pdf/exporter.ts`, `pdf/url.ts`, `sanitize.ts`, the redaction raster, `optimizeImages.ts`, or `download.ts`._

Moved verbatim from `CLAUDE.md`; the index there links here.

## Gotchas

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
- **Anything that reaches the output file is validated at the exporter**, not
  only in the UI: link URLs go through `safeLinkUrl` (`pdf/url.ts`, an
  allow-list; a link to a page writes a plain `/Dest` and no action at all) and copied annotation actions through `sanitize.ts` (also an
  allow-list, `/Next` chains included). The exporter is the single choke point,
  so a value from a restored session can't bypass a UI check.
- **The redaction raster picks its own codec, and must never grow a page.**
  `embedPageRaster` encodes both PNG and JPEG and embeds the smaller. Neither
  wins everywhere — lossless is hopeless against scanner noise (a scanned A4
  page measured 5127 KB as PNG against 1056 KB as JPEG), but PNG is far smaller
  on a sparse vector page — so the comparison is the design, not a fallback.
  `pref.losslessRaster` (⋯ menu, and the Inspector with nothing selected) skips JPEG entirely for users who need the
  raster bit-exact. `docs/RASTER-CODEC-EVAL.md` has the measurements, and the
  reasons JBIG2 and MuPDF were evaluated and turned down.
- **The image codec runs off the page.** The redaction raster's encode (both
  codecs, keep the smaller), Compress's per-page JPEG and "Keep text"'s
  per-image decode/downsample/re-encode all live in `codecCore.ts`, which runs
  in `codecWorker.ts`; `codec.ts` is the page side. The page hands over an
  `ImageBitmap` (a few ms) instead of encoding it (a second per redacted page).
  Three things to keep:
  - **The worker is never a dependency.** No worker, no `OffscreenCanvas`, a
    script that won't load, a worker that dies: `codec.ts` fails what was
    waiting and runs the *same* `codecCore` functions on the page. Don't add a
    second encoder for the fallback — one implementation is what keeps the two
    paths' files the same. `onerror` is what stops a dead worker hanging an
    export; keep it.
  - **The lossless raster goes in as a raw flate stream, not a PNG.**
    `rgbaToFlate` (`pixelCodec.ts`) writes DeviceRGB rows behind PNG filters
    (`/Predictor 15`), deflated — the bytes of a PNG's IDAT, minus the PNG.
    `embedPng` would decode that PNG on the page and deflate the raw samples
    again on save, which cost as much as the encode did. Alpha is composited on
    white and dropped, so the page needs no `/SMask`.
  - **Nothing on the page may decode an image to look inside it.** The second
    half of the freeze was `isolatePageResources` (`structure.ts`) inflating
    every XObject without resources of its own — 13 MB of raster samples —
    looking for `Do` names only a *form* can hold. It checks `/Subtype /Form`
    now; any new walk over XObjects should too.
- **`optimizeImages.ts` decodes flate images itself.** `DCTDecode` goes to the
  browser's JPEG decoder; `FlateDecode` is inflated, un-predicted, and unpacked
  here (in the codec worker; `pixelCodec.ts`, with the checks that need
  pdf-lib's objects — `flateParms`, masks — still on the page) — `/Predictor` is not optional, since ignoring it yields noise rather
  than a slightly-off image, and `flateParms` therefore *bails* on anything it
  can't read rather than assuming the default. Every unsupported shape (chained
  filters, 1/16-bit depths, CMYK or indexed colour, masks, `/Decode`) returns
  null and leaves the image untouched, which is why the checks are an
  allow-list. Two traps worth keeping in mind:
  - **A soft mask is an image XObject too**, DeviceGray/8-bit/flate — i.e.
    indistinguishable from a candidate by its own contents, and only the
    `/SMask` reference *from the image that owns it* marks it. Rewriting one as
    a DeviceRGB JPEG is an invalid mask and lossy transparency, so `maskedRefs`
    pre-scans for those references. Accepting flate is what put masks in range;
    they were unreachable when only `DCTDecode` was.
  - **The rebuilt image dict is a fresh minimal one**, so any key that outlives
    the pixels has to be carried over by name — `/Interpolate` and `/Intent`,
    plus `/OC` (without which an image on a hidden optional-content layer
    becomes permanently visible) and `/StructParent` (which ties it to the
    tagged-PDF tree carrying its alt text).
  - **"Present but unreadable" is not "absent".** `flateParms` returns the
    no-prediction defaults *only* when `/DecodeParms` is missing outright; a
    dangling reference or a shape it doesn't model bails instead. Collapsing
    the two is how you unfilter predicted data as if it were raw, and nothing
    downstream can catch it — predictor-filtered data is always *larger* than
    the samples it encodes, so the short-data guard never fires. For the same
    reason the parms object is checked with `instanceof PDFDict`, not for a
    `.get` method: `PDFArray` has one of those too.
- **On the redaction raster path, anything not covered is permanent.** The
  raster is all that survives, so cover rectangles must be *measured*
  (`ctx.measureText` / `widthOfTextAtSize`), never estimated from character
  counts. That estimate shipped once and left original text visible past the
  cover for wide glyphs and non-Latin scripts.
- **Search matches are measured, then widened to the worst case**
  (`pdf/find.ts`). The stand-in font that measures a match doesn't know about
  `Tc`/`Tw`/`Tz`, so the leftover between measured and real fragment width is
  spread three ways (proportional, per-character, per-space) and the box takes
  the union. Text that isn't upright left-to-right (rotated by its matrix, or
  RTL) redacts the *whole fragment* — over-covering is a cosmetic cost,
  under-covering is a leak; boxes stay in user space on a `/Rotate` page, as
  every overlay does. Case folding keeps a
  map back to the original indices (Turkish "İ" lower-cases to two code
  points). Don't tighten any of this without `export.spec`'s hostile-text test.
- **The "Hidden information" report is the sanitiser's own record.**
  `sanitizeDocument` returns a `ScrubReport`, filled in at each place it
  removes something; `inspectHidden` (`pdf/hiddenInfo.ts`) runs it on a
  throwaway copy of the loaded bytes and words the result. Don't compute the
  "removed" list any other way (a second walk of the catalog, a list of keys
  to look for): it would drift from what the export really does, which is the
  one thing the report must never do. When you add a removal to the sanitiser,
  record it in the report in the same place. The "still in the file" list is
  what the export deliberately keeps: comment authors (`/T`), layers that are
  switched off, and text covered by an edit or a whiteout on a page that isn't
  flattened (counted in `DocumentEditor`, where the edits are). "Kept" counts
  only pages that ship their own content (in the plan, not flattened by a true
  redaction); whiteouts count only when `findUnsafeCovers` says they're over
  text, the same measure as the Download warning. Things the report must not
  get wrong, each with a test: an action type or Info key is whatever name the
  file gives (`actions` has no prototype; label tables are read with an own-key
  check); one file spec named twice is one attachment; `ANNOT_DROP` subtypes
  are never "comments"; a plain destination in `/OpenAction` isn't "something
  runs"; private data counts objects, not entries.
- **Redact patterns searches a page's *joined* text** (`joinPage` and
  `findPatternMatches` in `pdf/find.ts`; matching in `pdf/patternScan.ts`;
  presets in `pdf/patterns.ts`). Runs on one line, judged in the text's own
  direction so a turned line joins too, are joined (a space where the gap is
  wider than 0.15em) so a number a producer split into runs still matches;
  each hit becomes one box per run it touches, measured by the same code as
  Find. Presets never match `\s`, so a hit can't run on into the next line.
  - *A refused run is cut back, not dropped.* A regex takes the hit plus its
    neighbour (a card and its CVV, an IBAN and "BIC", two phone numbers) and
    the checksum refuses the lot, so `scanText` retries the shortest leading
    piece that passes. Each preset says how: cards and IBANs also look again
    from inside a refused run; phone numbers split only where the piece
    starts like one (`+`, `(`, a trunk `0`), or every 16-digit reference
    becomes two "phone numbers".
  - *Overlap decides the label, never the cover.* The earlier preset keeps
    shared text; whatever a later one (a custom pattern) found beyond it is
    kept as hits of its own.
  - *A custom pattern runs in a worker* (`patternWorker.ts`, via
    `useCustomPattern`), after typing settles, and is stopped after 2s: a
    catastrophic regex would otherwise freeze the tab and any unsaved work.
    Presets run on the page. Over `MAX_PATTERN_HITS` the panel asks for a
    narrower pattern instead of listing everything.
  - *Unticked hits are remembered by what they are* (`PatternHit.key`: kind,
    page, text, occurrence), not by offset, so an edit elsewhere on the line
    doesn't quietly re-tick one.
  Form fields, notes and added text aren't searched (the panel says so);
  picture-only pages need Recognise text first. Nothing is redacted until
  "Redact", and then in one history step.
- **Export edits the loaded file in place; it doesn't rebuild one.** That keeps
  catalog-level structure (outline, page labels, tags, `/Lang`, named
  destinations, layers, the form) and shares what the source shared. It also
  inverts the privacy default — a rebuild carried only what it copied, an
  in-place save carries everything still in the file — so three rules hold it
  together (`pdf/structure.ts`):
  - **A redacted page is replaced, never edited.** The raster page is inserted
    and the original removed; references to the old page are retargeted, form
    fields on it are pruned, and the structure tree is dropped outright when
    any page was replaced (its `/ActualText` and `/Alt` repeat page text, and
    partial pruning would trust every producer's bookkeeping with a redaction).
  - **`collectGarbage` must run last, after `flush()`.** pdf-lib writes *every*
    object in its context, reachable or not — so without it the replaced
    page's content stream, objects orphaned by old incremental saves, and
    whatever the sanitiser unhooked all ship in the file.
  - **The catalog is an allow-list** (`CATALOG_KEEP` in `sanitize.ts`), and so
    is `/Names` (only `/Dests`). Adding a key there ships it in every export;
    outline and form-field actions go through the same `scrubActions` as
    annotations.
  - **pdf-lib's page list is aligned to pdf.js's before anything else**
    (`alignPageTree` in `pdf/pageTree.ts`). On a malformed tree (an untyped
    `/Kids` entry, a wrong `/Count`) the two libraries disagree on which object
    is "page 2", and export rasterised the wrong page — shipping the redacted
    one intact. Export addresses pages by the refs pdf.js rendered
    (`PageData.ref`) and *fails* rather than guess; a failed export is
    recoverable, a misplaced redaction isn't.
  - **Everything that could carry a replaced page out is cut, not just the
    page:** resources a kept page shares or inherits are narrowed to the names
    its content draws (`isolatePageResources` — a shared `/XObject` dict
    otherwise keeps the redacted page's forms reachable, so GC keeps them);
    replies and popups on kept pages lose their link to the page's comments;
    bookmarks pointing at it are retitled "Page N" (a title often quotes the
    page); `/GoTo /SD` is dropped (it reaches the structure tree); and a final
    `assertNoStructureTree` fails the export if any tag survived.
  - **A deleted page is handled like a replaced one with no replacement**
    (`cutDeletedPages`), and pages are rearranged by rewriting the tree, never
    with `removePage`, whose fork version deletes the page object before its
    fields and threads can be found. See `pages.md`.
  - **Known limits, accepted:** layer names, named-destination keys and
    page-label prefixes may quote text; undecodable content and Type3/pattern/
    shading resources aren't narrowed; a page with no object of its own fails
    export. Listed in PR #45.
- **Organise copies pages in batches.** Each `copyPages` call has its own
  object copier, and only one copier can notice that two pages share a font or
  image — one call per page wrote a shared image once per page. A page the
  plan uses twice can share the call: the copier clones the page leaf on every
  request (only its resources are shared), so the two slots are two objects.
- **Encrypted files are decrypted once, at open — never later.** Upstream
  pdf-lib 1.17 couldn't read encryption (the app now writes with the fork,
  which can, but decrypting once still keeps every later step password-free): it saved an owner-locked file's still-encrypted
  streams under a trailer with no `/Encrypt`, so the download was unreadable.
  `openFile` scans for `/Encrypt` (`mayBeEncrypted`, in the loader so the scan
  doesn't pull the decrypter into the main chunk) and runs `pdf/decrypt.ts`,
  which lazy-loads `@cantoo/pdf-lib`, tries the empty password, and asks
  (`PasswordDialog`) only if that fails. Everything downstream — pdf.js, font
  extraction, the exporter, autosave — gets plain bytes and never sees a
  password. Three traps: `doc.isEncrypted` and the trailer's `/Encrypt` both
  read empty once the loader has decrypted, so "was it encrypted" is
  `context.isDecrypted`; the decrypted context still holds the old encrypt
  dictionary, object streams and xref stream, so everything unreachable from
  Root/Info is deleted before saving; and a document that took a real password
  is `locked` (per tab, carried through Organise/finishing rebuilds) and
  treated as clean by autosave, so no plain copy of it is left on the device.
  **Locked is contagious through Organise:** pulling a locked tab's pages in via
  "From open tabs" makes the result locked too (`organizeTookLocked`), or a
  merge would be a way round it. The reachability sweep is an explicit-stack
  loop, not recursion — outline `/Next` chains run thousands deep and a
  recursive walk overflowed, stranding the app on a spinner; any throw in the
  sweep or save is `failed`, and `openFile` catches whatever escapes `unlock`.
  Cancel during "Checking…" can't stop the decrypt, so its result is dropped.
  Known limits, invisible today because export rewrites metadata anyway: the
  Info dictionary and `/ID` of an xref-stream file aren't carried over, and XMP
  in a file with `EncryptMetadata false` comes out undecodable. Organise's "Add
  PDF" doesn't decrypt (open the file as a tab instead), and a session saved
  before this change restores without decryption.
  The download says "This copy has no password." **Download with password**
  (`ExportInput.password`) encrypts last, after `assertNoStructureTree`, with
  `@cantoo/pdf-lib`'s `encrypt` (AES-256, V5/R6). Every permission is granted
  and the owner password is 32 random bytes nobody is shown: permission flags
  are honour-system, and a known owner password would only be a second key to
  the same lock. The password is held in a ref across the whiteout warning and
  cleared the moment the export reads it — never in state, storage or a
  session copy; the dialog is no `<form>` and its fields are
  `autocomplete="off"`, so no browser offers to save it.
  **`@cantoo/pdf-lib` encrypts streams only.** Objects packed into object
  streams are covered by the stream's encryption, but the writer keeps the
  catalog, page tree, pages, `/Type /Sig` dicts, non-zero generations and
  every stream's dictionary out of them — and their strings (`/Lang`, page
  label prefixes, `/AcroForm /DA`, named destinations) went out in the clear
  and came back scrambled for the person with the password.
  `encryptLooseStrings` encrypts exactly those, mirroring `PDFStreamWriter`'s
  predicate (a signature's `/Contents` stays clear, per the standard). If the
  library's predicate changes, `protect.spec`'s dictionary test catches it.
  **Passwords are prepared** (`password.ts`: non-ASCII spaces → space,
  invisible joiners dropped, NFKC) before hashing, as R6 wants and Acrobat
  does; opening tries the password as typed, then prepared.
- **Download via `src/download.ts`.** It attaches the anchor before clicking and
  defers `revokeObjectURL`; revoking synchronously races the browser's fetch of
  the blob and cancels downloads on Firefox/Safari.
- **Forms (`formFill.ts`).** Every field kind is filled in the preview
  (`FormFieldLayer`) and written by `applyForm`, called from the exporter.
  The default is **keep fillable**; `DocState.formFlatten` (set from the
  Document panel's Form section, undoable) flattens. The traps, each with a
  spec in `forms.spec`:
  - **Stored value vs shown text.** pdf.js reports a choice by its export value
    and a radio button by its on-state; pdf-lib's `select` takes a dropdown's
    *shown* text and writes it as `/V`, and picks a radio by its `/Opt` export
    value (the last match, when two buttons share one). `applyForm` translates
    choices both ways (`optionText`) and, once the look is drawn, puts the
    export value back in `/V` (`storeChoiceValues`); a radio is set by the
    button's own on-state name (`acroField.setValue`), never by `select`.
  - **pdf-lib replaces looks it needn't.** `defaultUpdateAppearances` redraws a
    checkbox's tick and a radio's dot in its own style and rewrites every
    field's `/DA` to name a font the form's `/DR` lacks (`/dummy__noop` for
    buttons). A box or radio is redrawn only when a widget has no look at all;
    `/DA` on the field and its widgets is saved and put back (`keepLooks`).
  - **The standard font doesn't throw on a missing glyph** — the fork draws
    "?" instead. `drawable` checks each character first; a field it can't draw
    keeps its value, gets `/NeedAppearances`, and when flattening is *kept
    fillable* and reported (`onFormKept` → "“name” stays fillable", up to
    three named, by `keptNote.ts`), never flattened as "?????". Every export
    that is still a PDF reports it — Download, Save, Share, Sign, Compress
    keeping text, Download all (naming the file); one that is a picture of
    the page (Export as images, Print, a rasterising Compress) shows the
    answer, as pdf.js draws it from `/NeedAppearances`, and says nothing. Any other failure to draw a
    look (a comb field holding more than its boxes) is kept and reported the
    same way: whatever wasn't drawn is never flattened. The note is sent once
    pages are settled, naming only fields still in the file — one on a
    redacted or deleted page didn't stay anything.
  - **A value no option holds.** A list's `select` throws on one, so a list
    drops it (`keptChoices`; a redacted page's picture still lists it, as the
    preview does); a dropdown's `select` takes it by making the
    field editable, so it's drawn as the preview shows it and the editable
    flag put back. `/V` is written from the same kept values the look drew. A list's look draws *every* option, so all of them
    are checked, not just the chosen one. Signatures and push buttons are
    never touched, reported or flattened. The test for "can the standard
    font draw this?" is `standardText.drawable`, shared with the exporter's
    `sanitize`: other text has such characters folded or left out, while a
    form answer with one stays fillable, whole.
  - **Flattening per field.** `PDFForm.flatten` does every field or none; a
    field that must stay is skipped by copying its per-widget step
    (`flattenField`, which calls pdf-lib's private `findWidgetPage` /
    `findWidgetAppearanceRef` / `flattenWidgetOntoPage`). If the library
    renames them, `forms.spec`'s flatten tests fail. An untouched field without
    a normal appearance is drawn before flattening, or it would flatten to
    nothing (a choice from its stored values, so it shows option text). A
    hidden widget (`/F` Hidden or NoView) is not painted; its field still goes.
  - **Names are pdf.js's.** The preview keys values by pdf.js's field name,
    which skips an ancestor with no `/T`; pdf-lib's `getName` writes
    "undefined." there, so `applyForm` builds names itself (`fieldKey`). A
    radio's on-state is matched as pdf-lib decodes it *or* as PDFDocEncoding
    (`pdfDocText`) — pdf.js's reading, so a UTF-8 Cyrillic name still matches.
  - **`/Parent` loops hang pdf-lib.** Its `getFields` / `getName` recurse up
    `/Parent` with no guard. `breakParentCycles` cuts each loop before
    `getForm`, walking from widgets first so the link cut is the one pdf.js
    stops at and the name stays the preview's. (Two widgets on different
    members of one loop can still get different names from pdf.js; a loop
    through `/Kids` makes pdf-lib's read fail, caught, and the form goes out
    as it came.)
  - **Organise drops the form.** `copyPages` copies the widgets and fields but
    not `/AcroForm`; `pageOps.rebuildForm` gives the rebuilt file one from the
    kept pages' widgets, dropping widgets on pages left out. `/DA` and `/Q`
    come from the first source; `/DR` merges every source's by category (first
    name wins — two files' different `/F1` fonts resolve to the first's when a
    viewer redraws); `/NeedAppearances` is set if any source had it; and a later
    source's root field that leaned on its own form's different `/DA` or `/Q`
    gets it written onto itself. Two merged files with same-named fields stay
    two fields of one name.
  - **Known limits, not handled:** a checkbox with several on-states (only
    "on" or "off" is offered); a widget whose appearance `/BBox` isn't at the
    origin flattens offset (pdf-lib's placement); a field name in
    PDFDocEncoding that pdf.js and pdf-lib decode differently won't match.
  The preview controls are opaque: the canvas beneath shows the field as the
  file came, and a changed value mustn't sit over the old one. They take the
  pointer only themselves (the layer doesn't), so text and boxes around them
  stay reachable. Fields on a redacted (rasterised) page stop being fields:
  the raster is drawn *without* the form (`renderPageToCanvas(…,
  withoutForms)`), so the file's original answers aren't baked in, and then
  `drawRasterForm` paints the answers *as they are now* — a tick, a dot, the
  text (broken at `\r` or `\n` and wrapped to the box, at the preview's
  `fieldFontSize`; at most the lines the box shows, found by halving, so a
  huge unbroken value can't stall the export), a list with its options and
  the chosen ones marked, scrolled as Chromium scrolls the preview's list
  (just far enough that the first chosen shows, at the bottom) —
  before the redaction boxes go on, so a box over a field still covers it. A
  field pdf.js paints into the canvas itself even in forms mode (`painted`:
  read-only text, a widget locked with its contents) is left as the canvas
  drew it; a locked one is read-only in the preview too. (One with no look of
  its own and no `/NeedAppearances` is painted by neither: blank, a known
  limit; so is a wrap that cuts inside a word and splits an emoji.) Clicking out of a field onto the page
  blurs it, so Delete reaches the selected box rather than the field.
