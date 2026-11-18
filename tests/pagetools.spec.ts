import { test, expect, type Page } from "@playwright/test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFRef, PDFString } from "pdf-lib";
import { fixtures } from "./fixtures";
import { expectClean, open, openOrganise, pageTexts, pickTool, watch } from "./helpers";

/**
 * Page tools: pictures become a PDF (upright, with what the camera recorded
 * taken out), Organise inserts pages where you point, and Split cuts the
 * document as shown — redactions burned in — into several files.
 *
 * Every download is read back by readers independent of the app: upstream
 * pdf-lib for the structure, pdf.js in Node for the text.
 */

const dir = mkdtempSync(join(tmpdir(), "pagetools-"));

/** A `w × h` picture drawn by the browser: red in the top-left quarter, blue
 * everywhere else — so where red lands shows which way up it was placed. */
async function drawPicture(page: Page, type: "image/jpeg" | "image/png", w: number, h: number): Promise<Buffer> {
  const b64 = await page.evaluate(
    ({ type, w, h }) => {
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const g = c.getContext("2d")!;
      g.fillStyle = "#0000ff";
      g.fillRect(0, 0, w, h);
      g.fillStyle = "#ff0000";
      g.fillRect(0, 0, w / 2, h / 2);
      return c.toDataURL(type, 0.95).split(",")[1];
    },
    { type, w, h },
  );
  return Buffer.from(b64, "base64");
}

const SECRETS = ["GPS-51.5007N-0.1246W", "XMP-CreatorTool-Secret", "Comment-Serial-0042", "IPTC-Byline-Secret"];

/** A segment: marker, big-endian length (counting itself), payload. */
function segment(marker: number, payload: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head[0] = 0xff;
  head[1] = marker;
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
}

/**
 * The JPEG a phone hands over: EXIF saying "turn me a quarter clockwise"
 * (orientation 6) with a GPS string in it, XMP, a comment and IPTC — each
 * carrying text that must not reach the PDF.
 */
function phonePhoto(jpeg: Buffer): Buffer {
  // TIFF, little-endian: one IFD with Orientation = 6 and an ImageDescription
  // (ASCII, stored out of line) holding the "GPS" text.
  const desc = Buffer.from(SECRETS[0] + "\0", "latin1");
  const tiff = Buffer.alloc(8 + 2 + 12 * 2 + 4);
  tiff.write("II", 0, "latin1");
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(2, 8);
  // 0x010E ImageDescription, ASCII
  tiff.writeUInt16LE(0x010e, 10);
  tiff.writeUInt16LE(2, 12);
  tiff.writeUInt32LE(desc.length, 14);
  tiff.writeUInt32LE(tiff.length, 18);
  // 0x0112 Orientation, SHORT, 6
  tiff.writeUInt16LE(0x0112, 22);
  tiff.writeUInt16LE(3, 24);
  tiff.writeUInt32LE(1, 26);
  tiff.writeUInt16LE(6, 30);
  tiff.writeUInt32LE(0, 34);
  const exif = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff, desc]);
  const xmp = Buffer.from(`http://ns.adobe.com/xap/1.0/\0<x:xmpmeta><xmp:CreatorTool>${SECRETS[1]}</xmp:CreatorTool></x:xmpmeta>`, "latin1");
  const iptc = Buffer.concat([Buffer.from("Photoshop 3.0\u00008BIM\u0004\u0004\u0000\u0000\u0000\u0000\u0000\u0020", "latin1"), Buffer.from(SECRETS[3], "latin1")]);
  return Buffer.concat([
    jpeg.subarray(0, 2),
    segment(0xe1, exif),
    segment(0xe1, xmp),
    segment(0xfe, Buffer.from(SECRETS[2], "latin1")),
    segment(0xed, iptc),
    jpeg.subarray(2),
  ]);
}

/** Colour at a fraction of the first page's rendered canvas. */
async function colourAt(page: Page, fx: number, fy: number): Promise<"red" | "blue" | "other"> {
  return page.evaluate(
    ({ fx, fy }) => {
      const c = document.querySelector<HTMLCanvasElement>(".page canvas")!;
      const [r, g, b] = c.getContext("2d")!.getImageData(Math.floor(c.width * fx), Math.floor(c.height * fy), 1, 1).data;
      if (r > 180 && g < 80 && b < 80) return "red";
      if (b > 180 && r < 80 && g < 80) return "blue";
      return "other";
    },
    { fx, fy },
  );
}

async function download(page: Page, click: () => Promise<void>): Promise<{ name: string; bytes: Buffer }> {
  const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 120_000 }), click()]);
  return { name: dl.suggestedFilename(), bytes: readFileSync((await dl.path())!) };
}

/** The entries of a stored (uncompressed) zip, as the app writes them. */
function unzip(zip: Buffer): { name: string; data: Buffer; flags: number }[] {
  const out: { name: string; data: Buffer; flags: number }[] = [];
  let at = 0;
  while (zip.readUInt32LE(at) === 0x04034b50) {
    expect(zip.readUInt16LE(at + 8), "stored, not deflated").toBe(0);
    const size = zip.readUInt32LE(at + 18);
    const nameLen = zip.readUInt16LE(at + 26);
    const extra = zip.readUInt16LE(at + 28);
    const name = zip.subarray(at + 30, at + 30 + nameLen).toString("utf8");
    const start = at + 30 + nameLen + extra;
    out.push({ name, data: zip.subarray(start, start + size), flags: zip.readUInt16LE(at + 6) });
    at = start + size;
  }
  return out;
}

test.describe("pictures become a PDF", () => {
  test("a phone photo opens upright, sized to fit, with its metadata gone, and counts as unsaved", async ({ page }) => {
    const w = watch(page);
    await page.goto("/");
    // Stored landscape (400 × 200), meant to be turned a quarter clockwise.
    const photo = phonePhoto(await drawPicture(page, "image/jpeg", 400, 200));
    const file = join(dir, "holiday.jpg");
    writeFileSync(file, photo);
    await page.setInputFiles("input[type=file]", file);
    await page.waitForFunction(() => [...document.querySelectorAll(".page canvas")].some((c) => (c as HTMLCanvasElement).width > 1), null, { timeout: 30_000 });
    await expect(page.locator(".doctab__btn", { hasText: "holiday.pdf" })).toBeVisible();

    // Upright: portrait, and the stored top-left (red) now at the top-right.
    const size = await page.evaluate(() => {
      const c = document.querySelector<HTMLCanvasElement>(".page canvas")!;
      return { w: c.width, h: c.height };
    });
    expect(size.h / size.w).toBeCloseTo(2, 1);
    // The canvas is sized before it's painted.
    await expect.poll(() => colourAt(page, 0.75, 0.25), { timeout: 15_000 }).toBe("red");
    expect(await colourAt(page, 0.25, 0.25)).toBe("blue");
    expect(await colourAt(page, 0.75, 0.75)).toBe("blue");

    const { name, bytes } = await download(page, () => page.click(".appbar__download"));
    expect(name).toMatch(/^holiday(-edited)?\.pdf$/);
    const raw = bytes.toString("latin1");
    for (const s of SECRETS) expect(raw, `"${s}" reached the file`).not.toContain(s);
    expect(raw).not.toContain("Exif");
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    expect(doc.getPageCount()).toBe(1);
    // 96 per inch: 200 × 400 pixels → 150 × 300 points.
    const { width, height } = doc.getPage(0).getSize();
    expect(Math.round(width)).toBe(150);
    expect(Math.round(height)).toBe(300);
    expect(doc.getProducer() ?? "").toBe("");
    expectClean(w);
  });

  test("the file isn't anywhere yet, so closing its tab asks first", async ({ page }) => {
    await page.goto("/");
    const file = join(dir, "scan.png");
    writeFileSync(file, await drawPicture(page, "image/png", 300, 300));
    await page.setInputFiles("input[type=file]", file);
    const tab = page.locator(".doctab__btn", { hasText: "scan.pdf" });
    await expect(tab).toBeVisible({ timeout: 30_000 });
    await expect(tab.getByRole("img", { name: "unsaved changes" })).toBeVisible();
    await page.getByRole("button", { name: "Close scan.pdf" }).click();
    await expect(page.getByRole("alertdialog")).toContainText("scan.pdf");
  });

  test("pictures picked together make one PDF in the order picked; a PDF beside them gets its own tab", async ({ page }) => {
    await page.goto("/");
    const a = join(dir, "first.png");
    const b = join(dir, "second.jpg");
    writeFileSync(a, await drawPicture(page, "image/png", 600, 300));
    writeFileSync(b, await drawPicture(page, "image/jpeg", 300, 600));
    const f = await fixtures();
    await page.setInputFiles("input[type=file]", [a, f.sample, b]);
    await expect(page.locator(".doctab")).toHaveCount(2, { timeout: 30_000 });
    await expect(page.getByRole("status").filter({ hasText: "Opened 2 documents in tabs, one made from 2 pictures." })).toHaveCount(1);
    await page.locator(".doctab__btn", { hasText: "first.pdf" }).click();
    const { bytes } = await download(page, () => page.click(".appbar__download"));
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPages().map((p) => p.getSize().width > p.getSize().height)).toEqual([true, false]);
  });

  test("something that only claims to be a picture is refused by name", async ({ page }) => {
    await page.goto("/");
    const fake = join(dir, "fake.jpg");
    writeFileSync(fake, Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]), Buffer.from("not really")]));
    await page.setInputFiles("input[type=file]", fake);
    await expect(page.getByText(/"fake\.jpg" isn't a JPEG or PNG picture this can read/)).toBeVisible();
  });
});

test.describe("Organise inserts where you point", () => {
  test("a blank page and a picture go after the picked page, sized like it", async ({ page }) => {
    const w = watch(page);
    await open(page, (await fixtures()).sample);
    const pic = join(dir, "inserted.png");
    writeFileSync(pic, await drawPicture(page, "image/png", 200, 100));
    await openOrganise(page);
    const org = page.locator(".organize");
    await expect(org.locator(".pcard")).toHaveCount(12);
    await expect(org).toContainText("new pages go at the end");

    // Pick page 3: new pages go after it.
    await org.locator(".pcard__thumb").nth(2).click();
    await expect(org).toContainText("new pages go after page 3");
    await org.getByRole("button", { name: "Add blank page" }).click();
    await expect(org.locator(".pcard")).toHaveCount(13);
    // Adding picks nothing — that would change what Extract and Split do —
    // but the next insert still follows the page just added.
    await expect(org.locator(".pcard--sel")).toHaveCount(0);
    await expect(org.getByRole("button", { name: /^Extract/ })).toHaveCount(0);
    await expect(org).toContainText("new pages go after page 4");
    await org.locator("input[type=file]").setInputFiles(pic);
    await expect(org.locator(".pcard")).toHaveCount(14, { timeout: 30_000 });
    await expect(org.locator(".pcard--sel")).toHaveCount(0);
    await expect(org).toContainText("new pages go after page 5");

    await org.getByRole("button", { name: "Apply" }).click();
    await expect(org).toBeHidden();
    const { bytes } = await download(page, () => page.click(".appbar__download"));
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(14);
    const sizes = doc.getPages().map((p) => p.getSize());
    expect(sizes[3]).toEqual({ width: 595, height: 842 });
    expect(Math.round(sizes[4].width)).toBe(150);
    const texts = await pageTexts(bytes, [3, 4, 5, 6]);
    expect(texts[0]).toContain("Page 3");
    expect(texts[1].trim()).toBe("");
    expect(texts[2].trim()).toBe("");
    expect(texts[3]).toContain("Page 4");
    expectClean(w);
  });

  test("a blank page beside a turned page takes its turned shape", async ({ page }) => {
    await open(page, (await fixtures()).sample);
    await openOrganise(page);
    const org = page.locator(".organize");
    await org.locator(".pcard").first().getByRole("button", { name: "Rotate" }).click();
    await org.locator(".pcard__thumb").first().click();
    await org.getByRole("button", { name: "Add blank page" }).click();
    await expect(org.locator(".pcard")).toHaveCount(13);
    await org.getByRole("button", { name: "Apply" }).click();
    const { bytes } = await download(page, () => page.click(".appbar__download"));
    const doc = await PDFDocument.load(bytes);
    const p = doc.getPage(1);
    expect(p.getRotation().angle % 360).toBe(0);
    expect(p.getSize()).toEqual({ width: 842, height: 595 });
  });
});

test.describe("Split into files", () => {
  test("from the Export menu: every N pages, as shown — redactions burned in — and Cancel goes back to the page", async ({ page }) => {
    const w = watch(page);
    await open(page, (await fixtures()).sample);
    // Redact page 1's heading.
    await pickTool(page, "Redact");
    const box = (await page.locator(".page").first().boundingBox())!;
    const y0 = box.height * ((842 - 790) / 842);
    const y1 = box.height * ((842 - 745) / 842);
    await page.mouse.move(box.x + box.width * 0.05, box.y + y0);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.95, box.y + y1, { steps: 10 });
    await page.mouse.up();
    await page.keyboard.press("Escape");

    // Cancel: straight back to the document, not left in Organise.
    await page.click('[aria-label="Export options"]');
    await page.getByRole("menuitem", { name: /Split into files/ }).click();
    let d = page.getByRole("dialog", { name: "Split into files" });
    await expect(d).toBeVisible();
    await d.getByRole("button", { name: "Cancel" }).click();
    await expect(d).toBeHidden();
    await expect(page.locator(".organize")).toBeHidden();

    await page.click('[aria-label="Export options"]');
    await page.getByRole("menuitem", { name: /Split into files/ }).click();
    d = page.getByRole("dialog", { name: "Split into files" });
    // Nothing picked in the grid yet, so only "Every N" is on offer.
    await expect(d.getByRole("radio", { name: "Before each picked page" })).toBeDisabled();
    await d.getByLabel("Pages per file").fill("5");
    await expect(d).toContainText("3 files: pages 1–5, 6–10, 11–12.");
    await d.getByLabel("Pages per file").fill("12");
    await expect(d).toContainText("nothing to split");
    await expect(d.getByRole("button", { name: /Download/ })).toBeDisabled();
    await d.getByLabel("Pages per file").fill("5");
    const { name, bytes } = await download(page, () => d.getByRole("button", { name: "Download 3 files" }).click());
    expect(name).toBe("sample-split.zip");
    await expect(page.locator(".organize")).toBeHidden();

    const files = unzip(bytes);
    expect(files.map((f) => f.name)).toEqual(["sample-pages-1-5.pdf", "sample-pages-6-10.pdf", "sample-pages-11-12.pdf"]);
    const counts = await Promise.all(files.map(async (f) => (await PDFDocument.load(f.data)).getPageCount()));
    expect(counts).toEqual([5, 5, 2]);
    const [first, second] = await pageTexts(files[0].data, [1, 2]);
    expect(first, "the redacted page went out redacted").not.toContain("Confidential");
    expect(second).toContain("Page 2");
    expect((await pageTexts(files[2].data, [1]))[0]).toContain("Page 11");
    // The document here is untouched.
    await expect(page.locator(".page")).toHaveCount(12);
    expectClean(w);
  });

  test("in Organise: a new file starts at each picked page, in the order Organise shows", async ({ page }) => {
    await open(page, (await fixtures()).sample);
    await openOrganise(page);
    const org = page.locator(".organize");
    // Move page 2 after page 3 first: Split cuts the order shown.
    await org.locator(".pcard").nth(1).getByRole("button", { name: "Move later" }).click();
    await org.locator(".pcard__thumb").nth(3).click();
    await org.locator(".pcard__thumb").nth(8).click();
    await org.getByRole("button", { name: "Split into files" }).click();
    const d = page.getByRole("dialog", { name: "Split into files" });
    await expect(d.getByRole("radio", { name: "Before each picked page" })).toBeChecked();
    await expect(d).toContainText("3 files: pages 1–3, 4–8, 9–12.");
    const { bytes } = await download(page, () => d.getByRole("button", { name: "Download 3 files" }).click());
    // Back in Organise, which was where Split was asked for.
    await expect(d).toBeHidden();
    await expect(org).toBeVisible();
    const files = unzip(bytes);
    const firstPart = await pageTexts(files[0].data, [1, 2, 3]);
    expect(firstPart.map((t) => /Page (\d+)/.exec(t)?.[1])).toEqual(["1", "3", "2"]);
    expect((await pageTexts(files[1].data, [1]))[0]).toContain("Page 4");
  });
});

/** Redact page 1's heading, so exporting it has real work to do. */
async function redactHeading(page: Page): Promise<void> {
  await pickTool(page, "Redact");
  const box = (await page.locator(".page").first().boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.05, box.y + box.height * (52 / 842));
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.95, box.y + box.height * (97 / 842), { steps: 10 });
  await page.mouse.up();
  await page.keyboard.press("Escape");
}

/** Every indirect object of a PDF, written out as text, and the raw bytes:
 * what a reader could find in it. */
function everything(bytes: Buffer, doc: PDFDocument): string {
  const objs = doc.context.enumerateIndirectObjects().map(([, o]) => o.toString());
  return bytes.toString("latin1") + "\n" + objs.join("\n");
}

test.describe("what Split, Extract and pictures leave out", () => {
  test("Split and Extract of an unedited document scrub it like Download does, and name files in UTF-8", async ({ page }) => {
    // A two-page file whose first page carries everything Download takes
    // out: a script that runs when the page opens, a link that launches a
    // program, an attached file, the page's own XMP and private data.
    const d = await PDFDocument.create();
    const p1 = d.addPage([300, 300]);
    d.addPage([300, 300]);
    const ctx = d.context;
    p1.node.set(PDFName.of("AA"), ctx.obj({ O: { S: "JavaScript", JS: PDFString.of('app.alert("PAGE-JS-SECRET")') } }));
    const attached = ctx.register(ctx.stream("ATTACHED-FILE-SECRET-BYTES", { Type: "EmbeddedFile" }));
    const launch = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Link", Rect: [0, 0, 50, 50], A: { S: "Launch", F: PDFString.of("evil-LAUNCH.exe") } }));
    const fileAnnot = ctx.register(
      ctx.obj({ Type: "Annot", Subtype: "FileAttachment", Rect: [60, 0, 80, 20], FS: { Type: "Filespec", F: PDFString.of("a.txt"), EF: { F: attached } } }),
    );
    p1.node.set(PDFName.of("Annots"), ctx.obj([launch, fileAnnot]));
    p1.node.set(PDFName.of("Metadata"), ctx.register(ctx.stream("<x:xmpmeta>PAGE-XMP-SECRET</x:xmpmeta>", { Type: "Metadata", Subtype: "XML" })));
    p1.node.set(PDFName.of("PieceInfo"), ctx.obj({ App: { Private: PDFString.of("PIECE-SECRET") } }));
    const pdf = Buffer.from(await d.save({ useObjectStreams: false }));
    const SCRUBBED = ["PAGE-JS-SECRET", "JavaScript", "Launch", "evil-LAUNCH", "ATTACHED-FILE-SECRET-BYTES", "EmbeddedFile", "PAGE-XMP-SECRET", "PIECE-SECRET", "pdf-lib"];
    const check = async (bytes: Buffer, what: string) => {
      const doc = await PDFDocument.load(bytes, { updateMetadata: false });
      const all = everything(bytes, doc);
      for (const s of SCRUBBED) expect(all, `${what}: "${s}" reached the file`).not.toContain(s);
      expect(doc.getProducer(), `${what}: a producer`).toBeUndefined();
      expect(doc.getCreationDate(), `${what}: a creation date`).toBeUndefined();
    };

    // Handed over as bytes: Playwright can't pick a file whose path has an accent.
    await page.goto("/");
    await page.setInputFiles("input[data-open-input]", { name: "Résumé.pdf", mimeType: "application/pdf", buffer: pdf });
    await expect(page.locator(".page")).toHaveCount(2, { timeout: 30_000 });
    await page.click('[aria-label="Export options"]');
    await page.getByRole("menuitem", { name: /Split into files/ }).click();
    const dlg = page.getByRole("dialog", { name: "Split into files" });
    await dlg.getByLabel("Pages per file").fill("1");
    const zip = await download(page, () => dlg.getByRole("button", { name: "Download 2 files" }).click());
    // (The zip's own name isn't checked: headless Chromium saves a download
    // with an accented name as "download".)
    const parts = unzip(zip.bytes);
    expect(parts.map((f) => f.name)).toEqual(["Résumé-pages-1.pdf", "Résumé-pages-2.pdf"]);
    // Bit 11: the names are UTF-8. Without it, Windows reads them as CP437.
    for (const f of parts) expect(f.flags & 0x0800, `${f.name} flagged UTF-8`).toBe(0x0800);
    await check(parts[0].data, "split");

    await openOrganise(page);
    const org = page.locator(".organize");
    await org.locator(".pcard__thumb").first().click();
    const ex = await download(page, () => org.getByRole("button", { name: "Extract 1 page" }).click());
    await check(ex.bytes, "extract");
  });

  test("a photo brings only its picture: no second picture, video, thumbnail or late comment after it", async ({ page }) => {
    await page.goto("/");
    const jpeg = await drawPicture(page, "image/jpeg", 200, 100);
    const small = await drawPicture(page, "image/jpeg", 20, 10);
    // A JFIF header carrying a thumbnail (6 × 1 RGB pixels of text), and a
    // JFXX extension segment — another thumbnail.
    const thumbText = Buffer.from("JFIF-THUMB-SECRET!", "latin1");
    const jfif = Buffer.concat([Buffer.from("JFIF\0", "latin1"), Buffer.from([1, 2, 0, 0, 1, 0, 1, 6, 1]), thumbText]);
    const jfxx = Buffer.concat([Buffer.from("JFXX\0", "latin1"), Buffer.from([0x10]), Buffer.from("JFXX-THUMB-SECRET", "latin1")]);
    // After the picture ends: a second picture with EXIF of its own (as MPF
    // and Ultra HDR append), then a motion photo's video.
    const second = Buffer.concat([
      small.subarray(0, 2),
      segment(0xe1, Buffer.concat([Buffer.from("Exif\0\0", "latin1"), Buffer.from("SECOND-IMAGE-GPS-SECRET", "latin1")])),
      small.subarray(2),
    ]);
    const body = jpeg.subarray(2, jpeg.length - 2); // without SOI and EOI
    const photo = Buffer.concat([
      jpeg.subarray(0, 2),
      segment(0xe0, jfif),
      segment(0xe0, jfxx),
      body,
      // A comment between the scan and the end marker.
      segment(0xfe, Buffer.from("LATE-COMMENT-SECRET", "latin1")),
      Buffer.from([0xff, 0xd9]),
      second,
      Buffer.from("\0\0\0\x18ftypmp42MOTION-VIDEO-SECRET", "latin1"),
    ]);
    const file = join(dir, "motion.jpg");
    writeFileSync(file, photo);
    await page.setInputFiles("input[type=file]", file);
    await page.waitForFunction(() => [...document.querySelectorAll(".page canvas")].some((c) => (c as HTMLCanvasElement).width > 1), null, { timeout: 30_000 });
    // Still the picture: red top-left, blue elsewhere.
    await expect.poll(() => colourAt(page, 0.25, 0.25), { timeout: 15_000 }).toBe("red");
    expect(await colourAt(page, 0.75, 0.75)).toBe("blue");
    const { bytes } = await download(page, () => page.click(".appbar__download"));
    const raw = bytes.toString("latin1");
    for (const s of ["JFIF-THUMB-SECRET", "JFXX", "LATE-COMMENT-SECRET", "SECOND-IMAGE-GPS-SECRET", "Exif", "ftypmp42", "MOTION-VIDEO-SECRET"]) {
      expect(raw, `"${s}" reached the file`).not.toContain(s);
    }
    // The picture's stream is one JPEG: one start, one end.
    const doc = await PDFDocument.load(bytes);
    const img = doc.context.enumerateIndirectObjects().map(([, o]) => o).find((o): o is PDFRawStream => o instanceof PDFRawStream && o.dict.get(PDFName.of("Subtype")) === PDFName.of("Image"))!;
    const c = Buffer.from(img.contents);
    expect(c.subarray(-2)).toEqual(Buffer.from([0xff, 0xd9]));
    expect(c.indexOf(Buffer.from([0xff, 0xd8]), 2)).toBe(-1);
  });
});

test.describe("Split and Organise behave while they work", () => {
  test("Split from the Export menu holds focus, and can't be dismissed halfway through", async ({ page }) => {
    await open(page, (await fixtures()).sample);
    // An edit, so the split has to draw the document first — it takes a while.
    await redactHeading(page);
    await page.click('[aria-label="Export options"]');
    await page.getByRole("menuitem", { name: /Split into files/ }).click();
    const d = page.getByRole("dialog", { name: "Split into files" });
    await expect(d).toBeVisible();
    // Focus is in the dialog, not on Organise behind it, and Tab keeps it there.
    await expect.poll(() => d.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press("Tab");
      expect(await d.evaluate((el) => el.contains(document.activeElement)), `Tab ${i + 1} left the dialog`).toBe(true);
    }
    await d.getByLabel("Pages per file").fill("6");
    // Start the split, then — while it works — press Escape, Cancel and the
    // scrim. None may close it: the files would download from nowhere.
    const [dl, during] = await Promise.all([
      page.waitForEvent("download", { timeout: 120_000 }),
      page.evaluate(async () => {
        const dialog = () => [...document.querySelectorAll<HTMLElement>("[role=dialog]")].find((e) => e.textContent?.includes("Split into files") && !e.classList.contains("organize"));
        const btn = (t: string) => [...dialog()!.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.includes(t))!;
        btn("Download 2 files").click();
        await new Promise((r) => setTimeout(r, 0));
        const cancelOff = btn("Cancel").disabled;
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        btn("Cancel").click();
        document.querySelector(".dialog-scrim")!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
        await new Promise((r) => setTimeout(r, 50));
        return { cancelOff, open: !!dialog() };
      }),
    ]);
    expect(during.cancelOff, "Cancel while splitting").toBe(true);
    expect(during.open, "the dialog closed while splitting").toBe(true);
    expect(dl.suggestedFilename()).toBe("sample-split.zip");
    await expect(d).toBeHidden();
    await expect(page.locator(".organize")).toBeHidden();
  });

  test("pages are locked while pages are added, and added pages aren't picked", async ({ page }) => {
    await open(page, (await fixtures()).sample);
    await openOrganise(page);
    const org = page.locator(".organize");
    await expect(org.locator(".pcard")).toHaveCount(12);
    // The visible label is the start of the accessible name (WCAG 2.5.3).
    expect(await org.locator("button", { hasText: "Add file" }).getAttribute("aria-label")).toMatch(/^Add file/);
    // Watch the grid's records: adding a page must lock it (inert) and then
    // unlock it. The add can be over before an observer looks at the page, so
    // it's the records that are read, not the page.
    await page.evaluate(() => {
      const w = window as unknown as { inert?: (string | null)[] };
      w.inert = [];
      const grid = document.querySelector(".organize__grid")!;
      new MutationObserver((records) => {
        for (const r of records) if (r.attributeName === "inert") w.inert!.push(r.oldValue);
      }).observe(grid, { attributes: true, attributeOldValue: true });
    });
    await org.getByRole("button", { name: "Add blank page" }).click();
    await expect(org.locator(".pcard")).toHaveCount(13);
    // null → "" (locked), then "" → removed (unlocked).
    expect(await page.evaluate(() => (window as unknown as { inert: (string | null)[] }).inert), "the grid was locked while adding").toEqual([null, ""]);
    expect(await org.locator(".organize__grid").getAttribute("inert")).toBeNull();
    // Nothing picked, so Split still offers "every N" by default.
    await expect(org.locator(".pcard--sel")).toHaveCount(0);
    await org.getByRole("button", { name: "Split into files" }).click();
    const d = page.getByRole("dialog", { name: "Split into files" });
    await expect(d.getByRole("radio", { name: /^Every/ })).toBeChecked();
    await d.getByRole("button", { name: "Cancel" }).click();
    // Pick only page 1: the hint says why that doesn't split.
    await org.locator(".pcard__thumb").first().click();
    await org.getByRole("button", { name: "Split into files" }).click();
    await expect(d).toContainText("page 1 already does");
    await d.getByLabel("Pages per file").fill("2.5");
    await expect(d).toContainText("Type a whole number of pages");
    await expect(d.getByRole("button", { name: /Download/ })).toBeDisabled();
  });

  test("adding several files in Organise is all or nothing, and says which file is to blame", async ({ page }) => {
    await open(page, (await fixtures()).sample);
    const pic = join(dir, "ok.png");
    writeFileSync(pic, await drawPicture(page, "image/png", 100, 100));
    const notes = join(dir, "notes.txt");
    writeFileSync(notes, "just some notes");
    await openOrganise(page);
    const org = page.locator(".organize");
    await org.locator("input[type=file]").setInputFiles([pic, notes, (await fixtures()).typeset]);
    await expect(org.getByRole("alert")).toContainText('"notes.txt" isn\'t a PDF or a picture');
    await expect(org.getByRole("alert")).toContainText("Nothing was added");
    await expect(org.locator(".pcard")).toHaveCount(12);
  });
});

test.describe("opening pictures: names and reasons", () => {
  test("a batch names the picture to blame; a nameless picture gets a name; other files hear what's accepted", async ({ page }) => {
    await page.goto("/");
    const good = join(dir, "good.png");
    writeFileSync(good, await drawPicture(page, "image/png", 100, 100));
    const broken = join(dir, "broken.jpg");
    writeFileSync(broken, Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]), Buffer.from("not really")]));
    await page.setInputFiles("input[data-open-input]", [good, broken, (await fixtures()).sample]);
    const status = page.getByRole("alert").filter({ hasText: "Opened 1 document" });
    await expect(status).toContainText(`"broken.jpg" isn't a JPEG or PNG picture this can read`, { timeout: 30_000 });
    await expect(status).not.toContainText('"good.png"');

    const nameless = join(mkdtempSync(join(tmpdir(), "dot-")), ".png");
    writeFileSync(nameless, await drawPicture(page, "image/png", 100, 100));
    await page.setInputFiles("input[data-open-input]", nameless);
    await expect(page.locator(".doctab__btn", { hasText: "Pictures.pdf" })).toBeVisible({ timeout: 30_000 });

    const txt = join(dir, "readme.txt");
    writeFileSync(txt, "hello");
    await page.setInputFiles("input[data-open-input]", txt);
    await expect(page.getByRole("alert").filter({ hasText: `"readme.txt" isn't a PDF or a picture (JPEG, PNG)` })).toHaveCount(1);
  });
});
