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
  allow-list) and copied annotation actions through `sanitize.ts` (also an
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
- **`optimizeImages.ts` decodes flate images itself.** `DCTDecode` goes to the
  browser's JPEG decoder; `FlateDecode` is inflated, un-predicted, and unpacked
  here — `/Predictor` is not optional, since ignoring it yields noise rather
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
- **Redact patterns searches a page's *joined* text** (`findPatternMatches`
  in `pdf/find.ts`, presets in `pdf/patterns.ts`). Runs on one line are joined
  (a space where the gap is wider than 0.15em) so a number a producer split
  into runs still matches; each hit becomes one box per run it touches,
  measured by the same code as Find. Presets never match `\s`, so a hit can't
  run on into the next line. Where two presets claim the same text, the earlier
  in `PATTERN_PRESETS` keeps it, so specific formats go first; checksums (Luhn,
  IBAN mod-97) turn away look-alikes. A custom pattern is the person's own
  regex, run on the main thread: a catastrophic one can hang the tab, and only
  their own. Picture-only pages have no text to search until Recognise text.
  Nothing is redacted until "Redact", and then in one history step.
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
  The download says "This copy has no password." Re-encrypting on export is
  package 7.
- **Download via `src/download.ts`.** It attaches the anchor before clicking and
  defers `revokeObjectURL`; revoking synchronously races the browser's fetch of
  the blob and cancels downloads on Firefox/Safari.
