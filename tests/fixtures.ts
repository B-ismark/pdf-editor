import { PDFBool, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFString, StandardFonts, degrees, rgb } from "pdf-lib";
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
  /** Two pages of known text that open only with {@link LOCKED_PASSWORD}. */
  locked: string;
  /** Opens without a password but is encrypted (owner password only). */
  ownerLocked: string;
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
  /** One line set as separately positioned runs, the way word processors
   * write it — see {@link SPLIT_LINE}. */
  splitLine: string;
  /** Body text in an embedded TrueType face with ligatures — see {@link LIGATURES}. */
  ligatures: string;
  /** One page of personal details for pattern redaction — see {@link PERSONAL}. */
  personal: string;
  /** The hard cases for pattern redaction — see {@link TRICKY}. */
  tricky: string;
  /** One page carrying every kind of hidden information — see {@link HIDDEN}. */
  hidden: string;
  /** One page with one form field of every kind — see {@link FORM}. */
  form: string;
  /** One page of form fields the write path gets wrong easily — see {@link FORM_EDGE}. */
  formEdge: string;
  /** HTML pretending to be a PDF. */
  fake: string;
}

/**
 * One line of body text written as three runs, each placed at its own x, plus a
 * label and a value a tab stop apart — see `line.spec.ts`.
 *
 * pdf.js reports each run as a fragment of its own (and the word space between
 * them as a whitespace item the loader drops), so editing the middle run grows it
 * in place while the next keeps its x. That printed "both" → "bothy" as
 * "bothymployer", on screen and in the file.
 */
export const SPLIT_LINE = {
  page: { width: 640, height: 400 },
  size: 14,
  x: 40,
  baseline: 300,
  runs: ["Employees can withdraw another", "50% from both", "employer and employee"],
  /** On a line of their own: a label, then a value at a tab stop. */
  tab: { label: "Amount:", value: "120", baseline: 240, valueX: 220 },
};

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
    locked: write("locked.pdf", await lockedPdf(LOCKED_PASSWORD)),
    ownerLocked: write("owner-locked.pdf", await lockedPdf("")),
    splitLine: write("split-line.pdf", await splitLinePdf()),
    ligatures: write("ligatures.pdf", await ligaturesPdf()),
    personal: write("personal.pdf", await personalPdf()),
    tricky: write("tricky.pdf", await trickyPdf()),
    hidden: write("hidden.pdf", await hiddenPdf()),
    form: write("form.pdf", await formPdf()),
    formEdge: write("form-edge.pdf", await formEdgePdf()),
    fake: write("not-a-pdf.pdf", "<!doctype html><html><body><h1>Not a PDF</h1></body></html>"),
  };
}

/**
 * Personal details for "Redact patterns", one per line. Every `hit` is drawn
 * pure red and is the only red on the page, so after redacting and exporting,
 * any red pixel left is a leak (the same test as {@link SEARCH_HOSTILE}).
 *
 * The phone number is two runs with the word space between them a run of its
 * own, the way word processors write a line: a pattern that only looked inside one run at a time
 * would find neither half. The `decoys` are black and look like matches but
 * fail a checksum or a sanity check, so they must not be listed; `date` and
 * `custom` are black too and only listed once asked for.
 */
export const PERSONAL = {
  page: { width: 600, height: 460 },
  size: 14,
  x: 40,
  lines: [
    { pre: "Contact ", hit: "jane.doe@example.org", post: " for details" },
    { pre: "Card ", hit: "4111 1111 1111 1111", post: " on file" },
    { pre: "IBAN ", hit: "GB82 WEST 1234 5698 7654 32", post: "" },
    { pre: "SSN ", hit: "123-45-6789", post: "" },
  ],
  /** Drawn as two runs: "Call " + first, then second a space further on. */
  phone: { pre: "Call ", first: "+44 20", second: "7946 0958" },
  decoys: ["Invoice 4111 1111 1111 1112", "Years 2019-2024", "Ref 12345", "Account GB00WEST12345698765432"],
  date: { pre: "Signed ", hit: "31 Jan 2024" },
  custom: { pre: "Order ", hit: "INV-004211", pattern: String.raw`INV-\d{6}` },
  /** The phone number as the review list shows it. */
  phoneText: "+44 20 7946 0958",
};

async function personalPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const { page: dims, size, x } = PERSONAL;
  const page = doc.addPage([dims.width, dims.height]);
  const f = page.node.newFontDictionary("F", font.ref).asString();
  const enc = (s: string) => (s ? `${font.encodeText(s).toString()} Tj` : "");
  const runs: string[] = [];
  const line = (y: number, parts: Array<[string, boolean]>, at = x) =>
    runs.push(`q BT ${f} ${size} Tf 1 0 0 1 ${at} ${y} Tm ${parts.map(([t, red]) => `${red ? "1 0 0 rg" : "0 g"} ${enc(t)}`).join(" ")} ET Q`);
  let y = dims.height - 50;
  for (const l of PERSONAL.lines) {
    line(y, [[l.pre, false], [l.hit, true], [l.post, false]]);
    y -= 32;
  }
  const p = PERSONAL.phone;
  line(y, [[p.pre, false], [p.first, true]]);
  // The word space is a run of its own, as Word writes it (see SPLIT_LINE):
  // pdf.js then reports two fragments and the loader drops the space.
  const after = x + font.widthOfTextAtSize(p.pre + p.first, size);
  line(y, [[" ", false]], after);
  line(y, [[p.second, true]], after + font.widthOfTextAtSize(" ", size));
  y -= 32;
  for (const d of PERSONAL.decoys) {
    line(y, [[d, false]]);
    y -= 32;
  }
  line(y, [[PERSONAL.date.pre + PERSONAL.date.hit, false]]);
  y -= 32;
  line(y, [[PERSONAL.custom.pre + PERSONAL.custom.hit, false]]);
  page.node.set(PDFName.of("Contents"), doc.context.register(doc.context.flateStream(runs.join("\n"))));
  return doc.save();
}

/**
 * Pattern hits a first version missed or cut short, each drawn in red (and
 * nothing else red), so red left after export is a leak. From review:
 * - a real hit next to a neighbour the checksum refuses together with it
 *   (a card and its security code, an IBAN and "BIC", two phone numbers);
 * - a phone number's one-digit first group or its leading "1-";
 * - an IBAN in lower case;
 * - a custom pattern overlapping a preset's hit (it kept only the email);
 * - digits drawn one to a box, as on a form's comb field;
 * - a number split across two runs of a turned line.
 */
export const TRICKY = {
  page: { width: 600, height: 520 },
  size: 14,
  x: 40,
  lines: [
    { pre: "Card ", hit: "4111 1111 1111 1111", post: " 123" },
    { pre: "IBAN ", hit: "AT61 1904 3002 3457 3201", post: " BIC BKAUATWW" },
    { pre: "Tel ", hit: "+33 1 23 45 67 89", post: "" },
    { pre: "Toll free ", hit: "1-800-555-1234", post: "" },
    { pre: "iban: ", hit: "gb82 west 1234 5698 7654 32", post: "" },
    { pre: "Lines ", hit: "020 7946 0958 020 7946 0959", post: "" },
    { pre: "", hit: "Patient: John Smith <john@example.com", post: ">" },
  ],
  custom: "Patient: .+",
  /** Drawn one digit to a run, 1.5em apart. */
  comb: { pre: "Member", digits: "123456789" },
  /** Drawn turned a quarter, as two runs with a space run between. */
  turned: { first: "555 123", second: "4567" },
};

async function trickyPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const { page: dims, size, x } = TRICKY;
  const page = doc.addPage([dims.width, dims.height]);
  const f = page.node.newFontDictionary("F", font.ref).asString();
  const enc = (t: string) => (t ? `${font.encodeText(t).toString()} Tj` : "");
  const runs: string[] = [];
  const run = (m: string, parts: Array<[string, boolean]>) =>
    runs.push(`q BT ${f} ${size} Tf ${m} Tm ${parts.map(([t, red]) => `${red ? "1 0 0 rg" : "0 g"} ${enc(t)}`).join(" ")} ET Q`);
  let y = dims.height - 50;
  for (const l of TRICKY.lines) {
    run(`1 0 0 1 ${x} ${y}`, [[l.pre, false], [l.hit, true], [l.post, false]]);
    y -= 32;
  }
  run(`1 0 0 1 ${x} ${y}`, [[TRICKY.comb.pre, false]]);
  [...TRICKY.comb.digits].forEach((d, i) => run(`1 0 0 1 ${x + 80 + i * size * 1.5} ${y}`, [[d, true]]));
  // Turned a quarter anticlockwise, reading upwards along the right edge.
  const { first, second } = TRICKY.turned;
  const tx = dims.width - 40;
  const w1 = font.widthOfTextAtSize(first, size);
  run(`0 1 -1 0 ${tx} 60`, [[first, true]]);
  run(`0 1 -1 0 ${tx} ${60 + w1}`, [[" ", false]]);
  run(`0 1 -1 0 ${tx} ${60 + w1 + font.widthOfTextAtSize(" ", size)}`, [[second, true]]);
  page.node.set(PDFName.of("Contents"), doc.context.register(doc.context.flateStream(runs.join("\n"))));
  return doc.save();
}

export const LOCKED_PASSWORD = "open sesame";
export const LOCKED_TEXT = "Locked statement";

/** A small text PDF encrypted with `userPassword` (empty: owner password only,
 * so it opens without asking but is still encrypted). Made with the same
 * library the app decrypts with — pdf-lib 1.17 can't encrypt. */
async function lockedPdf(userPassword: string): Promise<Uint8Array> {
  const lib = await import("@cantoo/pdf-lib");
  const doc = await lib.PDFDocument.create();
  const font = await doc.embedFont(lib.StandardFonts.Helvetica);
  for (let p = 0; p < 2; p++) {
    doc.addPage([595, 842]).drawText(`${LOCKED_TEXT} page ${p + 1}`, { x: 60, y: 760, size: 20, font });
  }
  doc.encrypt({ userPassword, ownerPassword: "owner-secret" });
  return doc.save();
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
/**
 * Text in an embedded TrueType face whose ToUnicode includes ligatures — see
 * `ligature.spec.ts`.
 *
 * pdf-lib lays text out with the face's `liga` feature, so "fifty office" is
 * drawn with the "fi" and "ffi" glyphs, and the ToUnicode it writes maps each to
 * its letters — as Word and most writers do. pdf.js filed those glyphs under
 * their *first* letter when it rebuilt the face, so every "f" drawn in it came
 * out "fi" ("from" → "firom"). DejaVu ships with most Linux images, the CI
 * runner's included; where it's missing the PDF is written in Helvetica and the
 * spec skips.
 */
export const LIGATURES = {
  font: SEARCH_HOSTILE_FONT,
  size: 14,
  lines: [
    { text: "fifty office staff", baseline: 300 },
    { text: "from the floor", baseline: 260 },
  ],
};

async function ligaturesPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = existsSync(LIGATURES.font)
    ? await doc.embedFont(readFileSync(LIGATURES.font), { subset: false })
    : await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([640, 400]);
  for (const line of LIGATURES.lines) page.drawText(line.text, { x: 40, y: line.baseline, size: LIGATURES.size, font });
  return doc.save();
}

async function splitLinePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([SPLIT_LINE.page.width, SPLIT_LINE.page.height]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const { size, baseline, runs, tab } = SPLIT_LINE;
  // Each run where the previous one (and a word space) ended, as its own text
  // object — the space between them is a run of its own, as Word writes it.
  let x = SPLIT_LINE.x;
  runs.forEach((run, i) => {
    if (i > 0) {
      page.drawText(" ", { x, y: baseline, size, font });
      x += font.widthOfTextAtSize(" ", size);
    }
    page.drawText(run, { x, y: baseline, size, font });
    x += font.widthOfTextAtSize(run, size);
  });
  page.drawText(tab.label, { x: SPLIT_LINE.x, y: tab.baseline, size, font });
  page.drawText(tab.value, { x: tab.valueX, y: tab.baseline, size, font });
  return doc.save();
}

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

/**
 * Every kind of thing a PDF carries off the page, for the "Hidden information"
 * report: properties (standard and a producer's own), an XMP packet, a file
 * identifier, scripts (on open, in the name tree, on a page), attached files
 * (in the name tree and as an annotation), links that launch a program or send
 * form data, a producer's private data — all removed on export — and a signed
 * comment and a switched-off layer with text on it, which stay.
 */
export const HIDDEN = {
  body: "Visible body text",
  author: "Carol Author",
  creator: "SecretWriter 9",
  company: "HIDDEN-CO-PRIVATE",
  embedded: "salary.xlsx",
  attached: "notes.txt",
  reviewer: "Bob Reviewer",
  layer: "Draft notes",
  layerText: "HIDDEN-LAYER-TEXT",
} as const;

async function hiddenPdf(): Promise<Uint8Array> {
  const H = HIDDEN;
  const doc = await PDFDocument.create();
  const ctx = doc.context;
  const str = (t: string) => PDFString.of(t);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  page.drawText(H.body, { x: 60, y: 760, size: 14, font });

  // A layer that's switched off, with text on it.
  const ocg = ctx.register(ctx.obj({ Type: "OCG", Name: str(H.layer) }));
  doc.catalog.set(PDFName.of("OCProperties"), ctx.obj({ OCGs: [ocg], D: { Order: [ocg], OFF: [ocg] } }));
  const fontName = page.node.newFontDictionary("FL", font.ref);
  const props = ctx.obj({ L1: ocg });
  (page.node.Resources() as PDFDict).set(PDFName.of("Properties"), props);
  page.node.addContentStream(
    ctx.register(ctx.flateStream(`/OC /L1 BDC BT /${fontName.decodeText()} 14 Tf 60 700 Td (${H.layerText}) Tj ET EMC`)),
  );

  const file = (name: string) =>
    ctx.obj({ Type: "Filespec", F: str(name), UF: str(name), EF: { F: ctx.register(ctx.flateStream("secret,data", { Type: "EmbeddedFile" })) } });
  doc.catalog.set(
    PDFName.of("Names"),
    ctx.obj({
      JavaScript: { Names: [str("init"), { S: "JavaScript", JS: str("app.alert('names')") }] },
      EmbeddedFiles: { Names: [str(H.embedded), file(H.embedded)] },
    }),
  );
  doc.catalog.set(PDFName.of("OpenAction"), ctx.obj({ S: "JavaScript", JS: str("app.alert('open')") }));
  doc.catalog.set(
    PDFName.of("Metadata"),
    ctx.register(ctx.stream(`<x:xmpmeta xmlns:x="adobe:ns:meta/"><dc:creator>${H.author}</dc:creator></x:xmpmeta>`, { Type: "Metadata", Subtype: "XML" })),
  );

  const annot = (o: Record<string, unknown>) => page.node.addAnnot(ctx.register(ctx.obj({ Type: "Annot", Border: [0, 0, 0], ...o } as never)));
  annot({ Subtype: "FileAttachment", Rect: [400, 760, 420, 780], FS: file(H.attached), Contents: str("attached") });
  annot({ Subtype: "Link", Rect: [60, 600, 200, 620], A: { S: "Launch", F: str("calc.exe") } });
  annot({ Subtype: "Link", Rect: [60, 560, 200, 580], A: { S: "SubmitForm", F: { FS: "URL", F: str("https://example.com/collect") } } });
  annot({ Subtype: "Text", Rect: [450, 760, 470, 780], T: str(H.reviewer), Contents: str("Check this figure") });
  page.node.set(PDFName.of("AA"), ctx.obj({ O: { S: "JavaScript", JS: str("app.alert('page')") } }));
  page.node.set(PDFName.of("PieceInfo"), ctx.obj({ SecretWriter: { Private: str(H.company) } }));

  doc.setAuthor(H.author);
  doc.setCreator(H.creator);
  const info = ctx.lookup(ctx.trailerInfo.Info) as PDFDict;
  info.set(PDFName.of("Company"), str(H.company));
  ctx.trailerInfo.ID = ctx.obj([PDFHexString.of("00112233445566778899aabbccddeeff"), PDFHexString.of("00112233445566778899aabbccddeeff")]);
  return doc.save({ useObjectStreams: false });
}

/**
 * A form with one field of every kind the editor fills.
 *
 * Two of them store a different value from the one they show, which is what a
 * real form does and what the export has to translate: the dropdown's options
 * are `[export, shown]` pairs, and pdf-lib names its radio buttons' on-states
 * "0", "1", "2" with the shown values in `/Opt`.
 */
export const FORM = {
  page: { width: 500, height: 560 },
  label: "APPLICATION FORM",
  text: { name: "fullName", rect: [40, 470, 240, 22] },
  multiline: { name: "address", rect: [40, 400, 240, 50] },
  limited: { name: "postcode", rect: [300, 470, 80, 22], maxLength: 5 },
  checkbox: { name: "agree", rect: [40, 360, 16, 16] },
  radio: { name: "size", options: ["Small", "Medium", "Large"], y: 320 },
  dropdown: {
    name: "country",
    rect: [40, 260, 160, 22],
    options: [
      ["gh", "Ghana"],
      ["fr", "France"],
      ["jp", "Japan"],
    ] as [string, string][],
  },
  list: { name: "languages", rect: [240, 200, 140, 70], options: ["English", "French", "Twi", "Japanese"] },
  fields: 7,
};

async function formPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([FORM.page.width, FORM.page.height]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText(FORM.label, { x: 40, y: 520, size: 16, font });
  const form = doc.getForm();
  const at = (r: number[]) => ({ x: r[0], y: r[1], width: r[2], height: r[3] });

  form.createTextField(FORM.text.name).addToPage(page, at(FORM.text.rect));
  const address = form.createTextField(FORM.multiline.name);
  address.enableMultiline();
  address.addToPage(page, at(FORM.multiline.rect));
  const postcode = form.createTextField(FORM.limited.name);
  postcode.setMaxLength(FORM.limited.maxLength);
  postcode.addToPage(page, at(FORM.limited.rect));
  form.createCheckBox(FORM.checkbox.name).addToPage(page, at(FORM.checkbox.rect));

  const size = form.createRadioGroup(FORM.radio.name);
  FORM.radio.options.forEach((o, i) => size.addOptionToPage(o, page, { x: 40 + i * 60, y: FORM.radio.y, width: 16, height: 16 }));

  const country = form.createDropdown(FORM.dropdown.name);
  country.addToPage(page, at(FORM.dropdown.rect));
  country.acroField.dict.set(
    PDFName.of("Opt"),
    doc.context.obj(FORM.dropdown.options.map(([v, shown]) => [PDFString.of(v), PDFString.of(shown)])),
  );

  const langs = form.createOptionList(FORM.list.name);
  langs.addOptions(FORM.list.options);
  langs.enableMultiselect();
  langs.addToPage(page, at(FORM.list.rect));

  return doc.save();
}

/**
 * The form fields that are easy to get wrong, one page:
 * - `city`: an editable dropdown holding a value that isn't one of its options,
 *   with a tooltip (`/TU`) that names it, and a look that shows the value;
 * - `answer`: radio buttons where two stand for the same value (`/Opt [Yes Yes No]`);
 * - `secret`: a hidden text field with a value — never to be printed;
 * - `script`: a list one of whose options the standard font can't draw;
 * - `level`: a single-choice list with nothing chosen;
 * - `signature`: an unsigned signature field.
 */
export const FORM_EDGE = {
  page: { width: 500, height: 560 },
  label: "EDGE CASES",
  city: { name: "city", tip: "Home city", rect: [40, 460, 160, 22], options: ["Accra", "Kumasi"], value: "Tamale" },
  answer: { name: "answer", options: ["Yes", "Yes", "No"], y: 400 },
  secret: { name: "secret", rect: [40, 340, 200, 22], value: "HIDDENVALUE" },
  script: { name: "script", rect: [40, 250, 140, 50], options: ["English", "Ελληνικά"] },
  level: { name: "level", rect: [240, 250, 140, 50], options: ["Beginner", "Intermediate", "Expert"] },
  signature: { name: "signature", rect: [300, 40, 160, 40] },
  /** Radio buttons whose on-states are Cyrillic names, UTF-8 in the file
   * ("Да", "Нет"): pdf.js reads their bytes as PDFDocEncoding. */
  cyrillic: { name: "da", states: ["\u00D0\u0094\u00D0\u00B0", "\u00D0\u009D\u00D0\u00B5\u00D1\u0082"], y: 190 },
  /** A text field in a `/Parent` loop with its parent (pdf.js reads it fine). */
  loop: { name: "mid.top", rect: [240, 180, 140, 22] },
  /** A text field under a parent with no `/T`: pdf.js names it "leaf". */
  leaf: { name: "leaf", rect: [240, 140, 140, 22] },
  /** A comb text field holding more than its boxes (`/MaxLen` 2, value
   * "ABCDE"): pdf-lib can't lay it out, so it can't be flattened. */
  comb: { name: "comb", rect: [40, 140, 140, 22], value: "ABCDE", maxLength: 2 },
  /** A dropdown that takes no typing, holding a value none of its options
   * has, with no look: flattened, it must still show the value. */
  legacy: { name: "legacy", rect: [40, 100, 140, 22], options: ["Alpha", "Beta"], value: "Gamma" },
  /** A multi-line field whose value breaks lines the PDF way (`\r`). */
  notes: { name: "notes", rect: [40, 40, 200, 50], value: "First line\rSecond line" },
  /** An empty multi-line field, for a long answer that must wrap. */
  essay: { name: "essay", rect: [300, 85, 160, 50] },
  /** A text field locked along with its contents (`/F` 4+128+512). */
  locked: { name: "locked", rect: [300, 340, 160, 22], value: "Fixed" },
  /** The form's own defaults, unlike pdf-lib's: Times, and asks viewers to draw. */
  da: "/TiRo 0 Tf 0 g",
};

async function formEdgePdf(): Promise<Uint8Array> {
  const E = FORM_EDGE;
  const doc = await PDFDocument.create();
  const page = doc.addPage([E.page.width, E.page.height]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText(E.label, { x: 40, y: 520, size: 16, font });
  const form = doc.getForm();
  const at = (r: number[]) => ({ x: r[0], y: r[1], width: r[2], height: r[3] });

  const city = form.createDropdown(E.city.name);
  city.addOptions(E.city.options);
  city.enableEditing();
  city.select(E.city.value);
  city.addToPage(page, at(E.city.rect));
  // On the field and its one widget, as a field drawn once usually is (merged):
  // pdf.js reads a tooltip from the widget only.
  city.acroField.dict.set(PDFName.of("TU"), PDFString.of(E.city.tip));
  city.acroField.getWidgets()[0].dict.set(PDFName.of("TU"), PDFString.of(E.city.tip));

  const answer = form.createRadioGroup(E.answer.name);
  E.answer.options.forEach((o, i) => answer.addOptionToPage(o, page, { x: 40 + i * 60, y: E.answer.y, width: 16, height: 16 }));

  const secret = form.createTextField(E.secret.name);
  secret.setText(E.secret.value);
  secret.addToPage(page, { ...at(E.secret.rect), hidden: true });

  // Options set after the look is drawn: this pdf-lib can't draw the Greek.
  const script = form.createOptionList(E.script.name);
  script.addOptions(["English", "French"]);
  script.addToPage(page, at(E.script.rect));
  script.acroField.dict.set(PDFName.of("Opt"), doc.context.obj(E.script.options.map((o) => PDFHexString.fromText(o))));
  form.markFieldAsClean(script.ref);

  const level = form.createOptionList(E.level.name);
  level.addOptions(E.level.options);
  level.addToPage(page, at(E.level.rect));

  const sig = doc.context.register(
    doc.context.obj({
      Type: "Annot",
      Subtype: "Widget",
      FT: "Sig",
      T: PDFString.of(E.signature.name),
      Rect: [E.signature.rect[0], E.signature.rect[1], E.signature.rect[0] + E.signature.rect[2], E.signature.rect[1] + E.signature.rect[3]],
      F: 4,
      P: page.ref,
    }),
  );
  page.node.addAnnot(sig);
  form.acroForm.addField(sig);

  // Every look drawn now: pdf-lib's own redraw at save would walk the loop below.
  form.updateFieldAppearances();

  const ctx = doc.context;
  const box = (r: number[]) => [r[0], r[1], r[0] + r[2], r[1] + r[3]];
  const look = (ops: string) => ctx.register(ctx.stream(ops, { Type: "XObject", Subtype: "Form", BBox: [0, 0, 16, 16] }));
  const widget = (extra: Record<string, unknown>) => {
    const ref = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Widget", F: 4, P: page.ref, ...extra }));
    page.node.addAnnot(ref);
    return ref;
  };

  // Radio buttons named in UTF-8 bytes.
  const daRef = ctx.nextRef();
  const daKids = E.cyrillic.states.map((state, i) =>
    widget({
      Parent: daRef,
      Rect: box([40 + i * 60, E.cyrillic.y, 16, 16]),
      AS: PDFName.of("Off"),
      AP: { N: { [state]: look("0 g 4 4 8 8 re f"), Off: look("") } },
    }),
  );
  ctx.assign(daRef, ctx.obj({ FT: "Btn", Ff: (1 << 15) | (1 << 14), T: PDFString.of(E.cyrillic.name), Kids: daKids, V: PDFName.of("Off") }));
  form.acroForm.addField(daRef);

  // A field and its parent, each the other's parent.
  const midRef = ctx.nextRef();
  const topRef = widget({ FT: "Tx", T: PDFString.of("top"), Parent: midRef, Rect: box(E.loop.rect), DA: PDFString.of("0 g /Helv 10 Tf") });
  ctx.assign(midRef, ctx.obj({ T: PDFString.of("mid"), Kids: [topRef], Parent: topRef }));
  form.acroForm.addField(midRef);

  // A field under an untitled parent.
  const anonRef = ctx.nextRef();
  const leafRef = widget({ T: PDFString.of(E.leaf.name), Parent: anonRef, Rect: box(E.leaf.rect) });
  ctx.assign(anonRef, ctx.obj({ FT: "Tx", Kids: [leafRef], DA: PDFString.of("0 g /Helv 10 Tf") }));
  form.acroForm.addField(anonRef);

  // A comb field holding more than it has boxes for.
  const comb = form.createTextField(E.comb.name);
  comb.addToPage(page, at(E.comb.rect));
  comb.acroField.setFlagTo(1 << 24, true);
  comb.acroField.setMaxLength(E.comb.maxLength);
  comb.acroField.dict.set(PDFName.of("V"), PDFString.of(E.comb.value));
  // No look of its own, so flattening has to draw one — and can't.
  for (const w of comb.acroField.getWidgets()) w.dict.delete(PDFName.of("AP"));
  form.markFieldAsClean(comb.ref);

  const legacy = form.createDropdown(E.legacy.name);
  legacy.addOptions(E.legacy.options);
  legacy.addToPage(page, at(E.legacy.rect));
  legacy.acroField.dict.set(PDFName.of("V"), PDFString.of(E.legacy.value));
  for (const w of legacy.acroField.getWidgets()) w.dict.delete(PDFName.of("AP"));
  form.markFieldAsClean(legacy.ref);

  const notes = form.createTextField(E.notes.name);
  notes.enableMultiline();
  notes.addToPage(page, at(E.notes.rect));
  notes.acroField.dict.set(PDFName.of("V"), PDFString.of(E.notes.value));
  form.markFieldAsClean(notes.ref);

  const essay = form.createTextField(E.essay.name);
  essay.enableMultiline();
  essay.addToPage(page, at(E.essay.rect));
  form.markFieldAsClean(essay.ref);

  const locked = form.createTextField(E.locked.name);
  locked.setText(E.locked.value);
  locked.addToPage(page, at(E.locked.rect));
  locked.updateAppearances(font);
  for (const w of locked.acroField.getWidgets()) w.dict.set(PDFName.of("F"), PDFNumber.of(4 | 128 | 512));
  form.markFieldAsClean(locked.ref);

  // The form's defaults: Times, in its resources, and drawn by the viewer.
  const times = doc.context.register(doc.context.obj({ Type: "Font", Subtype: "Type1", BaseFont: "Times-Roman" }));
  const acro = form.acroForm.dict;
  acro.set(PDFName.of("DR"), ctx.obj({ Font: { TiRo: times } }));
  acro.set(PDFName.of("DA"), PDFString.of(E.da));
  acro.set(PDFName.of("NeedAppearances"), PDFBool.True);

  return doc.save({ updateFieldAppearances: false });
}
