import { PDFDict, PDFDocument, PDFName, PDFRawStream, PDFRef, PDFString, StandardFonts, degrees, rgb } from "pdf-lib";
import { chromium } from "@playwright/test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import fontkit from "@pdf-lib/fontkit";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

/**
 * Test PDFs, generated on demand rather than committed as binaries.
 *
 * Generated so the specs can depend on knowing exactly what text is on which
 * page — that's what makes "a redacted page no longer has this text, its
 * neighbour still does" assertable — and so the long document is long enough
 * that unbounded page rendering would show up.
 */
export interface Fixtures {
  /** 12 pages of known text. */
  sample: string;
  /** 150 pages: rendering them all would allocate hundreds of MB of canvas. */
  long: string;
  /** One page, image only, no text layer at all — the input OCR exists for. */
  scanned: string;
  /** One page: a large photographic (flate-compressed) image plus real text. */
  photo: string;
  /** One page: a transparent image, so the file carries a soft-mask stream. */
  masked: string;
  /** Two images whose `/DecodeParms` can't be read — must be left alone. */
  brokenParms: string;
  /** One page of known typesetting: several faces at known baselines, and text
   * on a solid-colour panel. */
  typeset: string;
  /** `/Rotate 90`, with a solid black band where the *unrotated* coordinates of
   * its black-on-white text land. */
  rotated: string;
  /** One page of runs where a search target sits behind narrow, wide or
   * accented glyphs — see {@link SEARCH_REDACT}. */
  searchRedact: string;
  /** Three pages carrying every catalog-level structure export must keep — see
   * {@link STRUCTURED}. */
  structured: string;
  /** One page per way a search box can be mis-estimated — see
   * {@link SEARCH_HOSTILE}. Each target is painted pure red. */
  searchHostile: string;
  /** A page list pdf.js and pdf-lib read differently — see {@link damagedTreePdf}. */
  damagedTree: string;
  /** Two pages drawing through one shared resource list — see {@link sharedResourcesPdf}. */
  sharedResources: string;
  /** Twelve pages that all draw the *same* image XObject. */
  sharedImage: string;
  /** HTML pretending to be a PDF. */
  fake: string;
}

/**
 * Search targets whose position a per-character *average* gets wrong.
 *
 * The first run is the sample document's own line, where the audit saw "Ac"
 * survive a "Redact all"; the others put the target behind a run of narrow
 * glyphs, make the target itself wide, and give it an accent above the cap
 * height and a descender below the baseline.
 */
export const SEARCH_REDACT = {
  page: { width: 600, height: 300 },
  size: 14,
  x: 40,
  runs: [
    { text: "Line 1: the quick brown fox jumps over the lazy dog. Account 4111", query: "Account 4111", baseline: 240 },
    { text: "iiiiiiiiii lllllll tttt fill: WWWWWW end", query: "WWWWWW", baseline: 180 },
    { text: "il fill till ijl Åçg end", query: "Åçg", baseline: 120 },
  ],
} as const;

/**
 * Everything a document carries at catalog level that a rebuild used to drop.
 * Page 1 holds things that must *not* survive a redaction of it: a structure
 * element whose `/ActualText` and a form field whose value both repeat the
 * page's text.
 */
export const STRUCTURED = {
  pages: 3,
  bodyText: (n: number) => `Structured body text on page ${n}`,
  lang: "en-GB",
  outlineTitles: ["Opening", "Chapter two", "Chapter three", "Evil"],
  labels: ["i", "ii", "1"],
  namedDest: "chap2",
  layer: "Layer A",
  publicField: "name",
  secretField: "secretField",
  secretValue: "FIELD-SECRET-VALUE",
  taggedSecret: "TAGGED-SECRET-ALT",
  orphanSecret: "ORPHAN-SECRET-OBJECT",
  author: "Alice Example",
  company: "ACME-CORP-PRIVATE",
} as const;

/** The single text run in the `rotated` fixture. */
export const ROTATED_TEXT = "ROTATED-LABEL";

/** Page size of the `typeset` fixture, in PDF units. */
export const TYPESET_PAGE = { width: 460, height: 520 };

/**
 * Text running off the edge of a panel, so half of it sits on the panel and half
 * on paper.
 *
 * There is no single colour behind this, and the reading has to say so: filling
 * half a boundary with the wrong colour is worse than the white it replaces. It's
 * the case that keeps the pure-patch reading honest — two pure patches of panel
 * against two of paper is a 50% split, under the agreement floor.
 */
export const TYPESET_STRADDLE = {
  text: "STRADDLES-EDGE",
  x: 30,
  baseline: 480,
  size: 16,
  /** The panel covers only the first part of the text. */
  panel: { x: 20, y: 472, width: 70, height: 26, rgb: [26, 127, 55] as [number, number, number] },
};

/**
 * Mid-tone text with a darker rule just under its baseline.
 *
 * Ink is the colour furthest from the background, so a rule more extreme than
 * the text wins it: this read `#000000` for `#878787` text until ink stopped
 * being sampled from the descender band. Underlines, table rules and cell
 * borders all live there, and grey-on-white with a black rule is the cheapest
 * way to state the case.
 */
export const TYPESET_RULED = {
  text: "GREY-WITH-RULE",
  x: 30,
  baseline: 430,
  size: 16,
  textRgb: [135, 135, 135] as [number, number, number],
  /** The rule: below the baseline, inside the glyph box, wider than the text. */
  ruleY: 426,
  ruleHeight: 2,
  ruleWidth: 220,
};

/**
 * Text runs in `typeset`, at baselines the specs can assert against.
 *
 * Deliberately a spread of faces and sizes: the baseline-placement bug this
 * fixture exists for was proportional to the font size and different per
 * typeface, so a single run at a single size would have passed against it.
 */
export const TYPESET_RUNS = [
  { text: "Hxplg-Helvetica-24", x: 30, baseline: 370, size: 24, font: StandardFonts.Helvetica },
  { text: "Hxplg-Helvetica-11", x: 30, baseline: 330, size: 11, font: StandardFonts.Helvetica },
  { text: "Hxplg-Times-18", x: 30, baseline: 290, size: 18, font: StandardFonts.TimesRoman },
  { text: "Hxplg-Courier-24", x: 30, baseline: 240, size: 24, font: StandardFonts.Courier },
  { text: "Hxplg-Bold-20", x: 30, baseline: 190, size: 20, font: StandardFonts.HelveticaBold },
];

/**
 * Two solid-colour panels in `typeset`, one with dark text and one with light.
 *
 * They test opposite failures of the same cover. On `darkText`, any near-white
 * pixel is a hole the cover punched through the panel. On `lightText`, any dark
 * pixel is an edit redrawn in a colour the document never used — the ink default
 * was black, so light-on-dark text came back black and unreadable.
 */
export const TYPESET_PANELS = {
  darkText: {
    x: 24,
    y: 60,
    width: 260,
    height: 56,
    /** Fill colour, 0-255 per channel, as the raster should show it. */
    rgb: [26, 127, 55] as [number, number, number],
    /** One token: pdf.js breaks a text item at spacing changes, so a phrase with
     * spaces arrives as several fragments and no single overlay carries it. */
    text: "ON-A-PANEL",
    textRgb: [0, 0, 0] as [number, number, number],
    textX: 44,
    baseline: 80,
    size: 18,
  },
  lightText: {
    x: 24,
    y: 126,
    width: 260,
    height: 40,
    rgb: [26, 127, 55] as [number, number, number],
    text: "WHITE-ON-PANEL",
    textRgb: [255, 255, 255] as [number, number, number],
    textX: 44,
    baseline: 138,
    size: 14,
  },
};

/** Text repeated on every page of `sample`/`long`. */
export const MARKER = "the quick brown fox jumps over the lazy dog";
/** Words the `scanned` fixture renders as pixels, for OCR to recover. */
export const SCANNED_WORDS = ["INVOICE", "Total", "Amount", "Due"];
/** Caption under the `photo` fixture's image — must survive "Keep text". */
export const PHOTO_CAPTION = "Figure 1 — site survey photograph";

let cached: Promise<Fixtures> | null = null;

/** Build the fixtures once per test run (workers: 1, so one cache suffices). */
export function fixtures(): Promise<Fixtures> {
  cached ??= build();
  return cached;
}

async function build(): Promise<Fixtures> {
  const dir = mkdtempSync(join(tmpdir(), "pdf-editor-fixtures-"));
  const write = (name: string, bytes: Uint8Array | string) => {
    const path = join(dir, name);
    writeFileSync(path, bytes);
    return path;
  };
  return {
    sample: write("sample.pdf", await textPdf(12)),
    long: write("long.pdf", await textPdf(150)),
    scanned: write("scanned.pdf", await scannedPdf()),
    photo: write("photo.pdf", await photoPdf()),
    masked: write("masked.pdf", await maskedPdf()),
    brokenParms: write("broken-parms.pdf", await brokenParmsPdf()),
    typeset: write("typeset.pdf", await typesetPdf()),
    rotated: write("rotated.pdf", await rotatedPdf()),
    searchRedact: write("search-redact.pdf", await searchRedactPdf()),
    structured: write("structured.pdf", await structuredPdf()),
    searchHostile: write("search-hostile.pdf", await searchHostilePdf()),
    damagedTree: write("damaged-tree.pdf", damagedTreePdf()),
    sharedResources: write("shared-resources.pdf", await sharedResourcesPdf()),
    sharedImage: write("shared-image.pdf", await sharedImagePdf()),
    fake: write("not-a-pdf.pdf", "<!doctype html><html><body><h1>Not a PDF</h1></body></html>"),
  };
}

async function textPdf(pageCount: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const body = await doc.embedFont(StandardFonts.Helvetica);
  const heading = await doc.embedFont(StandardFonts.HelveticaBold);
  for (let p = 0; p < pageCount; p++) {
    const page = doc.addPage([595, 842]);
    page.drawText(`Confidential Report — Page ${p + 1}`, { x: 60, y: 760, size: 20, font: heading });
    for (let line = 0; line < 24; line++) {
      page.drawText(`Line ${line + 1}: ${MARKER}. Account 4111-1111-1111-1111.`, {
        x: 60,
        y: 700 - line * 24,
        size: 10,
        font: body,
        color: rgb(0.1, 0.1, 0.1),
      });
    }
  }
  return doc.save();
}

async function searchRedactPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([SEARCH_REDACT.page.width, SEARCH_REDACT.page.height]);
  for (const run of SEARCH_REDACT.runs) {
    page.drawText(run.text, { x: SEARCH_REDACT.x, y: run.baseline, size: SEARCH_REDACT.size, font });
  }
  return doc.save();
}

/**
 * Text set in ways that make a search match's box easy to get wrong, one case
 * per page, each drawn in one `BT` block as black prefix + pure-red target +
 * black suffix, so pdf.js reports one fragment and the target's ink is the only
 * red on the page. After "Redact all" and export, any red pixel left is a leak.
 *
 * `Tz`/`Tc`/`Tw` stretch the run in ways the fragment's width absorbs but a
 * measured stand-in font doesn't; a rotated `Tm` and a `/Rotate` page break the
 * left-to-right assumption; the Turkish dotted İ changes length when lower-
 * cased; Hebrew runs right to left; and the last page is far enough down that
 * its fonts haven't been read when the search runs. The two non-Latin cases
 * need a real TTF; they're left out (and the spec says so) where DejaVu isn't
 * installed.
 */
export const SEARCH_HOSTILE_FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";
export const SEARCH_HOSTILE = {
  query: "SECRET",
  hebrewQuery: "דוס",
  fillerPages: 20,
};

async function searchHostilePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const dejavu = existsSync(SEARCH_HOSTILE_FONT)
    ? await doc.embedFont(readFileSync(SEARCH_HOSTILE_FONT), { subset: false })
    : null;
  type Line = { pre: string; t: string; post: string; size?: number; x?: number; y?: number; m?: number[]; ops?: string };
  const add = (font: typeof helv, line: Line, opts: { rotate?: number; h?: number } = {}) => {
    const page = doc.addPage([600, opts.h ?? 300]);
    if (opts.rotate) page.setRotation(degrees(opts.rotate));
    const f = page.node.newFontDictionary("F", font.ref).asString();
    const enc = (s: string) => (s ? `${font.encodeText(s).toString()} Tj` : "");
    const tm = (line.m ?? [1, 0, 0, 1, line.x ?? 40, line.y ?? 150]).join(" ");
    const ops = `BT ${f} ${line.size ?? 20} Tf ${line.ops ?? ""} ${tm} Tm 0 g ${enc(line.pre)} 1 0 0 rg ${enc(line.t)} 0 g ${enc(line.post)} ET`;
    page.node.set(PDFName.of("Contents"), doc.context.register(doc.context.flateStream(ops)));
  };
  const T = SEARCH_HOSTILE.query;
  add(helv, { pre: "Line one has words ", t: T, post: " and a tail", ops: "50 Tz" });
  add(helv, { pre: "iiiiiiiiiiiiiiiiiiiiiiiiiiiiii ", t: T, post: " WWWWWWWWWWWWWWW", size: 14, x: 20, ops: "1.2 Tc" });
  add(helv, { pre: "a b c d e f g h i j k l m n o p q r ", t: T, post: " WWWWWWWWWW", size: 14, x: 20, ops: "6 Tw" });
  add(helv, { pre: "Line one has words ", t: T, post: " and a tail", m: [0, 1, -1, 0, 300, 20] }, { h: 400 });
  add(helv, { pre: "Line one has words ", t: T, post: " and a tail" }, { rotate: 90 });
  if (dejavu) {
    add(dejavu, { pre: "İİİİİİİİİİİİ İSTANBUL ", t: T, post: " tail" });
    // Drawn in visual order; pdf.js gives it back in logical order.
    const rev = (s: string) => [...s].reverse().join("");
    add(dejavu, { pre: rev(" בבבבבבבבבבבבבבבב"), t: rev("סוד"), post: rev("א ") });
  }
  for (let i = 0; i < SEARCH_HOSTILE.fillerPages; i++) add(helv, { pre: `filler page ${i + 1}`, t: "", post: "" });
  add(dejavu ?? helv, { pre: "iiiiiiiiiiiiiiii llllllll WWWWWWWW mmmm ", t: T, post: " ...." });
  return doc.save();
}

/**
 * Three pages as a viewer shows them — "P1", "P2_SECRET", "P3" — in a page tree
 * that's quietly wrong: page 2 has no `/Type`, and a fourth page ("P4_UNSEEN")
 * sits in `/Kids` beyond what `/Count` admits. pdf.js shows pages 1–3; pdf-lib,
 * left to itself, skipped the untyped page and counted the hidden one, so
 * redacting page 2 rasterised page 3 and shipped page 2's text — plus a page the
 * user never saw. Hand-written bytes, because pdf-lib won't write a broken tree.
 */
function damagedTreePdf(): string {
  const page = (content: number, typed = true) =>
    `<< ${typed ? "/Type /Page " : ""}/Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${content} 0 R >>`;
  const stream = (t: string) => {
    const c = `BT /F1 24 Tf 72 700 Td (${t}) Tj ET`;
    return `<< /Length ${c.length} >>\nstream\n${c}\nendstream`;
  };
  const objs: Record<number, string> = {
    1: "<< /Type /Catalog /Pages 2 0 R >>",
    2: "<< /Type /Pages /Kids [6 0 R 7 0 R 8 0 R 12 0 R] /Count 3 >>",
    3: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    6: page(9),
    7: page(10, false),
    8: page(11),
    12: page(13),
    9: stream("P1"),
    10: stream("P2_SECRET"),
    11: stream("P3"),
    13: stream("P4_UNSEEN"),
  };
  let s = "%PDF-1.7\n";
  const off: Record<number, number> = {};
  for (const [n, body] of Object.entries(objs)) {
    off[+n] = s.length;
    s += `${n} 0 obj\n${body}\nendobj\n`;
  }
  const xref = s.length;
  s += "xref\n0 14\n0000000000 65535 f \n";
  for (let i = 1; i <= 13; i++) s += off[i] != null ? `${String(off[i]).padStart(10, "0")} 00000 n \n` : "0000000000 65535 f \n";
  return s + `trailer\n<< /Size 14 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}

/**
 * Two pages sharing one `/Resources` dictionary, as many producers write them.
 * Each page draws its text through a form XObject in it: page 1 through `/Fs`
 * ("FORM_SECRET"), page 2 through `/Fk` ("FORM_KEPT"). Replacing page 1 with a
 * raster leaves page 2's resources still naming `/Fs` — undrawn, but reachable,
 * so garbage collection kept it and the redacted text shipped.
 */
async function sharedResourcesPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const form = (text: string) =>
    doc.context.register(
      doc.context.flateStream(`BT /F1 24 Tf 72 700 Td (${text}) Tj ET`, {
        Type: "XObject",
        Subtype: "Form",
        BBox: [0, 0, 612, 792],
        Resources: { Font: { F1: font.ref } },
      }),
    );
  const res = doc.context.register(doc.context.obj({ Font: { F1: font.ref }, XObject: { Fs: form("FORM_SECRET"), Fk: form("FORM_KEPT") } }));
  for (const name of ["Fs", "Fk"]) {
    const page = doc.addPage([612, 792]);
    page.node.set(PDFName.of("Resources"), res);
    page.node.set(PDFName.of("Contents"), doc.context.register(doc.context.flateStream(`/${name} Do`)));
  }
  return doc.save();
}

/** See {@link STRUCTURED}. Built by hand, because pdf-lib has no API for most
 * of these — which is also why nothing in the app ever wrote them. */
async function structuredPdf(): Promise<Uint8Array> {
  const S = STRUCTURED;
  const doc = await PDFDocument.create();
  const ctx = doc.context;
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = Array.from({ length: S.pages }, (_, i) => {
    const p = doc.addPage([595, 842]);
    p.drawText(S.bodyText(i + 1), { x: 60, y: 760, size: 14, font });
    return p;
  });
  const refs = pages.map((p) => p.ref);
  const str = (t: string) => PDFString.of(t);

  // Outline: a /Dest to page 1, a /Dest to page 2, a GoTo action to page 3,
  // and an item whose action is JavaScript (must be stripped, not kept).
  const outlinesRef = ctx.nextRef();
  const itemRefs = S.outlineTitles.map(() => ctx.nextRef());
  const actions = [
    { Dest: [refs[0], PDFName.of("Fit")] },
    { Dest: [refs[1], PDFName.of("Fit")] },
    { A: { S: "GoTo", D: [refs[2], PDFName.of("Fit")] } },
    { A: { S: "JavaScript", JS: str("app.alert('outline')") } },
  ];
  itemRefs.forEach((ref, i) => {
    ctx.assign(
      ref,
      ctx.obj({
        Title: str(S.outlineTitles[i]),
        Parent: outlinesRef,
        ...(i > 0 ? { Prev: itemRefs[i - 1] } : {}),
        ...(i < itemRefs.length - 1 ? { Next: itemRefs[i + 1] } : {}),
        ...actions[i],
      } as never),
    );
  });
  ctx.assign(
    outlinesRef,
    ctx.obj({ Type: "Outlines", First: itemRefs[0], Last: itemRefs[itemRefs.length - 1], Count: itemRefs.length }),
  );
  doc.catalog.set(PDFName.of("Outlines"), outlinesRef);

  doc.catalog.set(
    PDFName.of("PageLabels"),
    ctx.obj({ Nums: [0, { S: "r" }, 2, { S: "D", St: 1 }] }),
  );
  doc.catalog.set(PDFName.of("Lang"), str(S.lang));
  doc.catalog.set(PDFName.of("MarkInfo"), ctx.obj({ Marked: true }));

  // A tagged structure: Document → P (on page 1, with /ActualText) and P (page 2).
  const rootRef = ctx.nextRef();
  const docElRef = ctx.nextRef();
  const p1 = ctx.register(ctx.obj({ Type: "StructElem", S: "P", P: docElRef, Pg: refs[0], K: 0, ActualText: str(S.taggedSecret) }));
  const p2 = ctx.register(ctx.obj({ Type: "StructElem", S: "P", P: docElRef, Pg: refs[1], K: 0 }));
  ctx.assign(docElRef, ctx.obj({ Type: "StructElem", S: "Document", P: rootRef, K: [p1, p2] }));
  ctx.assign(rootRef, ctx.obj({ Type: "StructTreeRoot", K: docElRef }));
  doc.catalog.set(PDFName.of("StructTreeRoot"), rootRef);

  // Named destination, plus two internal links on page 1: one by name, one by
  // explicit page reference.
  doc.catalog.set(
    PDFName.of("Names"),
    ctx.obj({
      Dests: { Names: [str(S.namedDest), [refs[1], PDFName.of("Fit")]] },
      JavaScript: { Names: [str("init"), { S: "JavaScript", JS: str("app.alert('names')") }] },
    }),
  );
  const named = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Link", Rect: [60, 700, 200, 720], Border: [0, 0, 0], Dest: str(S.namedDest) }));
  const direct = ctx.register(
    ctx.obj({ Type: "Annot", Subtype: "Link", Rect: [60, 660, 200, 680], Border: [0, 0, 0], A: { S: "GoTo", D: [refs[2], PDFName.of("Fit")] } }),
  );
  pages[0].node.addAnnot(named);
  pages[0].node.addAnnot(direct);
  // ...and a link on page 2 that points *at* page 1, which a redaction of page 1
  // replaces — the reference has to follow the replacement.
  pages[1].node.addAnnot(
    ctx.register(ctx.obj({ Type: "Annot", Subtype: "Link", Rect: [60, 660, 200, 680], Border: [0, 0, 0], Dest: [refs[0], PDFName.of("Fit")] })),
  );

  const ocg = ctx.register(ctx.obj({ Type: "OCG", Name: str(S.layer) }));
  doc.catalog.set(PDFName.of("OCProperties"), ctx.obj({ OCGs: [ocg], D: { Order: [ocg], ON: [ocg] } }));

  // An unfilled form: one field on page 3, one on page 1 whose value repeats
  // page 1's text.
  const field = (name: string, pageIdx: number, value?: string) => {
    const ref = ctx.register(
      ctx.obj({
        Type: "Annot",
        Subtype: "Widget",
        FT: "Tx",
        T: str(name),
        Rect: [60, 600, 260, 620],
        P: refs[pageIdx],
        F: 4,
        ...(value ? { V: str(value) } : {}),
      } as never),
    );
    pages[pageIdx].node.addAnnot(ref);
    return ref;
  };
  const fields = [field(S.publicField, 2), field(S.secretField, 0, S.secretValue)];
  doc.catalog.set(PDFName.of("AcroForm"), ctx.obj({ Fields: fields, DA: str("/Helv 0 Tf 0 g") }));

  doc.catalog.set(PDFName.of("OpenAction"), ctx.obj({ S: "JavaScript", JS: str("app.alert('open')") }));
  doc.setAuthor(S.author);
  const info = ctx.lookup(ctx.trailerInfo.Info) as PDFDict;
  info.set(PDFName.of("Company"), str(S.company));
  // Not reachable from anything: a leftover a rewrite must not carry along.
  ctx.register(ctx.obj({ Leftover: str(S.orphanSecret) }));
  return doc.save({ useObjectStreams: false });
}

/** Twelve pages drawing one shared noisy image (incompressible, so duplicating
 * it shows up as file size immediately). */
async function sharedImagePdf(): Promise<Uint8Array> {
  const w = 300;
  const h = 300;
  const px = new Uint8Array(w * h * 3);
  let seed = 0x1234567;
  for (let i = 0; i < px.length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    px[i] = (seed >>> 24) & 0xff;
  }
  const doc = await PDFDocument.create();
  const img = await doc.embedPng(encodePng(px, w, h));
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let p = 0; p < 12; p++) {
    const page = doc.addPage([595, 842]);
    page.drawImage(img, { x: 100, y: 300, width: 300, height: 300 });
    page.drawText(`Shared image page ${p + 1}`, { x: 60, y: 760, size: 14, font });
  }
  return doc.save();
}

/**
 * One page of text at known baselines, plus a solid-colour panel with text on
 * it. Used by `baseline.spec.ts` (does the overlay sit on the document's
 * baseline?) and `export.spec.ts` (does an edit keep the panel's colour?).
 */
async function typesetPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([TYPESET_PAGE.width, TYPESET_PAGE.height]);
  for (const run of TYPESET_RUNS) {
    page.drawText(run.text, {
      x: run.x,
      y: run.baseline,
      size: run.size,
      font: await doc.embedFont(run.font),
    });
  }
  const [sr, sg, sb] = TYPESET_STRADDLE.panel.rgb;
  page.drawRectangle({
    x: TYPESET_STRADDLE.panel.x,
    y: TYPESET_STRADDLE.panel.y,
    width: TYPESET_STRADDLE.panel.width,
    height: TYPESET_STRADDLE.panel.height,
    color: rgb(sr / 255, sg / 255, sb / 255),
  });
  page.drawText(TYPESET_STRADDLE.text, {
    x: TYPESET_STRADDLE.x,
    y: TYPESET_STRADDLE.baseline,
    size: TYPESET_STRADDLE.size,
    font: await doc.embedFont(StandardFonts.HelveticaBold),
    color: rgb(0, 0, 0),
  });

  const [gr, gg, gb] = TYPESET_RULED.textRgb;
  page.drawText(TYPESET_RULED.text, {
    x: TYPESET_RULED.x,
    y: TYPESET_RULED.baseline,
    size: TYPESET_RULED.size,
    font: await doc.embedFont(StandardFonts.Helvetica),
    color: rgb(gr / 255, gg / 255, gb / 255),
  });
  page.drawRectangle({
    x: TYPESET_RULED.x - 10,
    y: TYPESET_RULED.ruleY,
    width: TYPESET_RULED.ruleWidth,
    height: TYPESET_RULED.ruleHeight,
    color: rgb(0, 0, 0),
  });

  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  for (const panel of Object.values(TYPESET_PANELS)) {
    const [r, g, b] = panel.rgb;
    page.drawRectangle({
      x: panel.x,
      y: panel.y,
      width: panel.width,
      height: panel.height,
      color: rgb(r / 255, g / 255, b / 255),
    });
    const [tr, tg, tb] = panel.textRgb;
    page.drawText(panel.text, {
      x: panel.textX,
      y: panel.baseline,
      size: panel.size,
      font: bold,
      color: rgb(tr / 255, tg / 255, tb / 255),
    });
  }
  return doc.save();
}

/**
 * A rotated page laid out to catch a coordinate mix-up rather than survive one.
 *
 * `viewBox` is the rotated viewport but a fragment's `transform` is unrotated
 * text space, so anything reading pixels at a fragment's coordinates reads the
 * wrong place here. The black band sits exactly where the text's unrotated
 * coordinates land, so a sampler that ignores `/Rotate` reports black as the
 * background of black-on-white text — confidently, and with no way to tell.
 */
async function rotatedPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 400]);
  page.drawText(ROTATED_TEXT, {
    x: 40,
    y: 340,
    size: 18,
    font: await doc.embedFont(StandardFonts.HelveticaBold),
    color: rgb(0, 0, 0),
  });
  page.drawRectangle({ x: 0, y: 0, width: 400, height: 300, color: rgb(0, 0, 0) });
  page.setRotation(degrees(90));
  return doc.save();
}

/**
 * A "scan": one page whose only content is a bitmap of rendered text.
 *
 * The bitmap is drawn on a canvas in a real browser, in a real typeface, at a
 * size and weight a scanner would produce. A hand-rolled pixel font was tried
 * first and is a poor target — Tesseract is trained on actual type and read 1 of
 * 3 words from blocky 1px-stroke glyphs. A fixture a working feature fails is
 * worse than no fixture.
 */
async function scannedPdf(): Promise<Uint8Array> {
  const exec = [
    "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
    "/opt/pw-browsers/chromium-1243/chrome-linux64/chrome",
    process.env.PW_EXECUTABLE_PATH ?? "",
  ].find((p) => p && existsSync(p));

  const browser = await chromium.launch(exec ? { executablePath: exec } : {});
  try {
    const page = await browser.newPage();
    const dataUrl = await page.evaluate((words) => {
      // 1240x1754 ≈ A4 at 150 dpi, a typical scan resolution.
      const canvas = document.createElement("canvas");
      canvas.width = 1240;
      canvas.height = 1754;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#111";
      ctx.textBaseline = "top";
      ctx.font = "bold 96px Helvetica, Arial, sans-serif";
      ctx.fillText(words[0], 120, 200);
      ctx.font = "64px Helvetica, Arial, sans-serif";
      words.slice(1).forEach((w, i) => ctx.fillText(w, 120, 400 + i * 110));
      return canvas.toDataURL("image/png");
    }, SCANNED_WORDS);

    const doc = await PDFDocument.create();
    const png = await doc.embedPng(dataUrl);
    doc.addPage([595, 842]).drawImage(png, { x: 0, y: 0, width: 595, height: 842 });
    return doc.save();
  } finally {
    await browser.close();
  }
}

/**
 * A page carrying a large photographic image and a caption.
 *
 * The image is written as a colour-type-2 (no alpha) PNG, so pdf-lib embeds it
 * as a plain `FlateDecode` DeviceRGB stream with no soft mask — the shape scans,
 * screenshots, and anything that arrived as a PNG actually take, and the one the
 * image optimiser used to skip entirely.
 *
 * The pixels are a gradient plus noise from a seeded generator. Noise is the
 * point: it is what lossless compression cannot do anything with, so it's what
 * makes both "flate is a bad fit for this" and "JPEG is dramatically smaller"
 * true here the way they're true of a real scan. The seed keeps the size
 * assertions stable from run to run.
 */
async function photoPdf(): Promise<Uint8Array> {
  const w = 800;
  const h = 1000;
  const px = new Uint8Array(w * h * 3);
  let seed = 0x2f6e2b1;
  const rand = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return (seed >>> 24) & 0xff;
  };
  const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i += 3) {
      const base = 60 + (x / w) * 120 + (y / h) * 60;
      const n = (rand() % 80) - 40;
      px[i] = clamp(base + n);
      px[i + 1] = clamp(base * 0.85 + n);
      px[i + 2] = clamp(base * 0.7 + n);
    }
  }

  const doc = await PDFDocument.create();
  const img = await doc.embedPng(encodePng(px, w, h));
  const page = doc.addPage([595, 842]);
  page.drawImage(img, { x: 47, y: 220, width: 500, height: 560 });
  page.drawText(PHOTO_CAPTION, {
    x: 47,
    y: 180,
    size: 12,
    font: await doc.embedFont(StandardFonts.Helvetica),
  });
  return doc.save();
}

/**
 * A page whose image is transparent, so the PDF carries a **soft-mask stream**.
 *
 * A soft mask is an image XObject in its own right — DeviceGray, 8-bit, flate —
 * so from the inside it looks exactly like something the optimiser should
 * shrink, and nothing on the stream says "I am a mask". Re-encoding one as a
 * DeviceRGB JPEG makes it an invalid mask and makes the transparency lossy.
 *
 * pdf-lib happens to write `/Decode [0 1]` on its masks, which the optimiser's
 * `/Decode` guard would refuse for the wrong reason — so the fixture strips it
 * afterwards. That's not making the test easier; it's making it *representative*,
 * since most producers emit a mask with no `/Decode` at all.
 */
async function maskedPdf(): Promise<Uint8Array> {
  const w = 700;
  const h = 900;
  const px = new Uint8Array(w * h * 4);
  let seed = 0x51f3a7c;
  const rand = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return (seed >>> 24) & 0xff;
  };
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    px[o] = rand();
    px[o + 1] = rand();
    px[o + 2] = rand();
    // Noisy alpha, so the mask stream is too big for flate to shrink and lands
    // well over the optimiser's size threshold.
    px[o + 3] = rand();
  }

  const doc = await PDFDocument.create();
  const img = await doc.embedPng(encodePng(px, w, h, 4));
  doc.addPage([595, 842]).drawImage(img, { x: 47, y: 120, width: 500, height: 600 });
  return stripMaskDecode(await doc.save());
}

/**
 * Two images whose `/DecodeParms` the optimiser cannot read: one a reference to
 * an object that isn't there, one a single-element array holding another array.
 *
 * Both are shapes where the honest answer is "I don't know how these samples are
 * laid out". The dangerous failure isn't refusing them — it's treating either as
 * *no prediction* and unfiltering anyway, which writes a sheared noise field
 * over a real image, and which the short-data guard cannot catch because
 * predictor-filtered data is larger than the samples it encodes, never smaller.
 * So what this fixture asserts is the policy: an unreadable `/DecodeParms`
 * leaves the image exactly as it was.
 */
async function brokenParmsPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const refs: PDFRef[] = [];
  for (let i = 0; i < 2; i++) {
    const img = await doc.embedPng(encodePng(noisePixels(600, 500, 3, 0x9e21b + i), 600, 500));
    page.drawImage(img, { x: 47, y: 440 - i * 320, width: 480, height: 280 });
    refs.push((img as unknown as { ref: PDFRef }).ref);
  }
  // pdf-lib embeds lazily — the image streams don't exist until the document is
  // flushed, so mutating them before this point silently does nothing.
  await doc.flush();

  for (const [i, kind] of (["dangling", "nested"] as const).entries()) {
    const stream = doc.context.lookup(refs[i]);
    if (!(stream instanceof PDFRawStream)) throw new Error("fixture: image stream missing");
    stream.dict.set(
      PDFName.of("DecodeParms"),
      kind === "dangling"
        ? // points at an object that was never written
          PDFRef.of(9999, 0)
        : // a single-element array whose element is itself an array: passes a
          // duck-typed "has .get" check, answers every lookup with a fallback
          doc.context.obj([[]]),
    );
  }
  return doc.save();
}

/** Deterministic pure noise, `channels` bytes per pixel. Noise (rather than
 *  `photoPdf`'s gradient-plus-noise) because these images exist to be *refused*
 *  — all that matters is that they're incompressible enough to clear the
 *  optimiser's size threshold and become candidates in the first place. */
function noisePixels(w: number, h: number, channels: 3 | 4, seed0: number): Uint8Array {
  const px = new Uint8Array(w * h * channels);
  let seed = seed0 >>> 0 || 1;
  for (let i = 0; i < px.length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    px[i] = (seed >>> 24) & 0xff;
  }
  return px;
}

/** Remove `/Decode` from every soft-mask stream, so the fixture matches the
 *  shape a typical PDF producer emits rather than pdf-lib's own. */
async function stripMaskDecode(bytes: Uint8Array): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes);
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    const smask = obj.dict.get(PDFName.of("SMask"));
    if (!(smask instanceof PDFRef)) continue;
    const mask = doc.context.lookup(smask);
    if (mask instanceof PDFRawStream) mask.dict.delete(PDFName.of("Decode"));
  }
  return doc.save();
}

/** Minimal PNG encoder (8-bit, no interlacing), truecolour with or without an
 *  alpha channel. Hand-rolled so a fixture can guarantee which of the two it
 *  gets: a canvas `toDataURL` always emits RGBA, and whether an alpha channel
 *  is present decides whether pdf-lib writes a soft mask — which is the
 *  difference between the two images these fixtures need. */
function encodePng(pixels: Uint8Array, w: number, h: number, channels: 3 | 4 = 3): Uint8Array {
  const rowBytes = w * channels;
  const stride = rowBytes + 1;
  const raw = new Uint8Array(stride * h);
  for (let y = 0; y < h; y++) {
    raw[y * stride] = 0; // per-row filter: none
    raw.set(pixels.subarray(y * rowBytes, (y + 1) * rowBytes), y * stride + 1);
  }
  const ihdr = new Uint8Array(13);
  const head = new DataView(ihdr.buffer);
  head.setUint32(0, w);
  head.setUint32(4, h);
  ihdr[8] = 8; // bit depth
  ihdr[9] = channels === 4 ? 6 : 2; // truecolour, with or without alpha
  return concatBytes([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", new Uint8Array(deflateSync(raw))),
    pngChunk("IEND", new Uint8Array(0)),
  ]);
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
