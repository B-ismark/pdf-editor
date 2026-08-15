# Raster codec evaluation: MuPDF, JBIG2, JPEG

The question was whether MuPDF, JBIG2, JPEG as a fallback, and stream
re-encoding would be useful here. Short version: the JPEG part is a clear win,
stream re-encoding already existed but skipped the formats that needed it most,
and JBIG2 should be dropped. MuPDF is worth a conversation, but about vector
redaction and licensing — not about compression.

**Status:** the two recommendations below marked *safe bets* are implemented —
the redaction raster now picks the smaller of JPEG and PNG (`exporter.ts`), and
the image optimiser handles `FlateDecode` (`optimizeImages.ts`). JBIG2 and
MuPDF were not pursued; the reasoning is kept here because it is the kind of
thing that gets re-proposed.

Numbers below are reproducible with `node scripts/measure-raster-codecs.mjs`
(see the header of that file for the browser flag).

## Where rasters come from today

- **Redaction** — `pdf/exporter.ts` always calls `embedPng`. There is no JPEG
  path and no fallback. This is the raster that matters most, because on a
  redacted page it is the only thing that survives.
- **Compress** — `pdf/finishOps.ts` already encodes JPEG through `pdf/jpeg.ts`,
  which prefers MozJPEG (`@jsquash/jpeg`, self-hosted WASM) and falls back to
  the browser encoder.
- **Stream re-encoding** — `pdf/optimizeImages.ts` already does this: it walks
  indirect objects, downsamples oversized image streams, re-encodes them in
  place with MozJPEG, keeps the original whenever re-encoding wouldn't shrink
  it, and skips anything it can't reproduce faithfully.

So the two encoders disagree about the same problem: the compress path uses
MozJPEG, the redaction path uses PNG.

## Measurements

A dense A4 text page, drawn in a real browser, at the exporter's scale. "scan"
adds sensor noise to model a scanned document — the case PNG handles worst and
the one people most often redact.

| page  | scale | MP  | **PNG (today)** | JPEG q85 | JPEG q70 | 1-bit PNG |
|-------|-------|-----|-----------------|----------|----------|-----------|
| clean | 2×    | 2.0 | 452 KB          | 393 KB   | 306 KB   | 198 KB    |
| clean | 3×    | 4.5 | 775 KB          | 690 KB   | 537 KB   | 340 KB    |
| scan  | 2×    | 2.0 | **2304 KB**     | 546 KB   | 372 KB   | 203 KB    |
| scan  | 3×    | 4.5 | **5127 KB**     | 1056 KB  | 693 KB   | 347 KB    |

The scan rows are the finding: a redacted scanned page costs **5 MB** today
where JPEG q70 costs 693 KB. Lossless PNG has no defence against scanner noise,
and it is spent on content whose fidelity nobody is relying on at that level.

The "1-bit PNG" column is not a proposal — it is the input a JBIG2 encoder would
take, included so the JBIG2 upside can be sized honestly. Lossless JBIG2
(generic region) lands roughly 2–3× below it.

## JPEG on the redaction raster — *safe bet, done*

Highest return here, and a small diff: `exporter.ts` is already lazy-loaded, so
it imports `loadJpegEncoder` without pulling anything into the render path.

Two constraints, both implemented:

- **Encode both and embed the smaller**, per page (`embedPageRaster`).
  `optimizeImages.ts` already established this discipline ("never grow a
  stream"), and a sparse vector page is a case where PNG legitimately wins — so
  neither codec can be picked up front. It also means turning this on cannot
  make any page larger than it was.
- **Lossless stays reachable.** JPEG rings around text, and a redacted page is
  often evidence. *Lossless redacted pages* (`pref.losslessRaster`, ⋯ menu)
  skips the JPEG encode entirely. A full quality slider was not added: the
  compress dialog already owns quality-vs-size, and a second control for it
  here would be a worse version of that one.

`tests/export.spec.ts` covers both halves — the default raster is a
`/DCTDecode` stream with no recoverable text, and the lossless switch produces
no `/DCTDecode` at more than twice the size.

## Stream re-encoding — *safe bet, done*

`isSafeJpeg` required a single `DCTDecode` filter, so `FlateDecode` images were
skipped entirely — and flate is where scans, screenshots, and anything embedded
from a PNG end up. Exactly the heaviest documents got nothing from "Keep text".

`classify` now accepts both, and flate streams are inflated, un-predicted, and
unpacked in `optimizeImages.ts`. `/Predictor` handling is the load-bearing part:
it isn't a refinement, since ignoring it yields noise rather than a
slightly-wrong image. The existing safety allow-list is unchanged and now gates
both formats (no masks, no `/Decode`, no CMYK or indexed colour, 8 bits per
component), so anything unrecognised is left exactly as it was.

Re-encoding flate as JPEG is a lossy step on content that may be crisp line art,
which is why it stays behind the existing size thresholds and the never-grow
rule: an image changes only if it is genuinely large *and* the result is
genuinely smaller.

## JBIG2 — recommend against

The premise has a hole: **MuPDF bundles jbig2dec, which decodes JBIG2 and does
not encode it.** MuPDF cannot produce JBIG2 output, so pairing them doesn't get
us an encoder. That would mean `jbig2enc` (C++/Leptonica) compiled to WASM
ourselves, with no maintained JS port to lean on.

Setting the encoder problem aside, three reasons not to:

- **Lossy JBIG2 is the Xerox scanner bug.** Symbol-matching mode substitutes
  visually similar glyphs; the documented failure changed digits in scanned
  invoices. In an app whose headline invariant is redaction integrity, silently
  altering numbers in the one raster that survives is close to the worst
  available failure mode. Lossless generic-region mode avoids it and gives up
  most of the advertised ratio.
- **It only applies to bilevel content.** Getting there means binarising the
  page, which is a visible, destructive change to all the *non-redacted* content
  on it. Most redacted pages are born-digital colour or greyscale.
- **Viewer support is uneven** outside Acrobat and pdf.js, which matters for a
  tool whose output is meant to be sent to someone else.

## MuPDF — a licensing conversation, not a codec one

The interesting capability isn't compression. `pdf_redact_page` removes content
from the content stream natively, so a redacted page could stay vector,
searchable, and small, with no raster at all. That would retire the "anything
not covered is permanent" hazard in `CLAUDE.md` outright — a much bigger prize
than any encoding choice.

The blocker is licensing. `mupdf@1.28.0` is **AGPL-3.0-or-later**, 14.3 MB
unpacked. Size is manageable — it would lazy-load like tesseract.js does — but
the licence doesn't lazy-load: it would place the whole project under AGPL, and
this repo currently carries no licence file at all. Artifex sells a commercial
licence. That decision should be settled before anyone spends time on a
prototype.

## Recommendation

1. ✅ JPEG-or-PNG-whichever-is-smaller on the redaction raster, with a lossless
   setting.
2. ✅ Extend `optimizeImages.ts` to `FlateDecode` images.
3. ❌ Drop JBIG2.
4. ⏸ Treat MuPDF separately, as vector redaction plus a licence decision.
