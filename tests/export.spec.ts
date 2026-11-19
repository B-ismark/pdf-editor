import { test, expect } from "@playwright/test";
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRawStream, PDFRef, PDFString, StandardFonts, decodePDFRawStream, type PDFObject } from "pdf-lib";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtures, PHOTO_CAPTION, SEARCH_HOSTILE, SEARCH_HOSTILE_FONT, SEARCH_REDACT, STRUCTURED } from "./fixtures";
import { open, watch, pickTool, dragOnPage, pageTexts, setLossless } from "./helpers";
import type { Page } from "@playwright/test";
import { buildFromPlan, type PlanEntry } from "../src/pdf/pageOps";

/** Click a control that produces a download and return the bytes. */
async function downloadFrom(page: Page, selector: string): Promise<Buffer> {
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 180_000 }),
    page.click(selector),
  ]);
  return readFileSync((await download.path())!);
}

/**
 * What actually ends up in the file the user hands to someone else.
 *
 * Several of this product's most important claims are only observable in the
 * exported bytes — that a redaction removed the content, that no active link
 * survived, that no authoring metadata was written. So these specs read the
 * bytes rather than trusting the UI.
 */
test.describe("export integrity", () => {
  test("an unsafe link URL is refused in the UI and never reaches the file", async ({ page }) => {
    const w = watch(page);
    await open(page, (await fixtures()).sample);

    await pickTool(page, "Link");
    await dragOnPage(page, { x: 80, y: 120 }, { x: 280, y: 165 });
    await page.waitForSelector("#link-url");

    // A `/URI` action is a live capability in the reader that opens the file, so
    // `javascript:` must be refused — and refused visibly, not dropped silently
    // at download time.
    await page.fill("#link-url", "javascript:alert(1)");
    await expect(page.locator("#link-url")).toHaveAttribute("aria-invalid", "true");
    await expect(page.locator("#link-url-note")).toContainText(/can.t be used/i);

    // A bare hostname is the common case and must still work.
    await page.fill("#link-url", "example.com/report");
    await expect(page.locator("#link-url")).not.toHaveAttribute("aria-invalid", "true");

    // Leave an unsafe value in place: the exporter is the real choke point, since
    // a value could also arrive from a restored session.
    await page.fill("#link-url", "javascript:alert('pwned')");
    await page.waitForTimeout(200);

    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 60_000 }),
      page.click(".appbar__download"),
    ]);
    const path = (await download.path())!;
    const raw = readFileSync(path, "latin1");

    expect(raw.startsWith("%PDF-")).toBe(true);
    expect(raw).not.toMatch(/javascript\s*:/i);
    // Privacy: a downloaded copy should not say who made it, when, or with what.
    expect(raw).not.toMatch(/\/Producer|\/Creator|\/ModDate|\/CreationDate/);
    expect(w.errors).toEqual([]);
  });

  test("a redaction removes the text; other pages keep theirs", async ({ page }) => {
    await open(page, (await fixtures()).sample);

    // Edit a text run first: on the raster path the white cover over replaced
    // text must be *measured*, or the original shows past it — permanently, since
    // the raster is all that survives.
    const frag = page.locator('.page [role="textbox"]').first();
    await frag.click();
    await frag.evaluate((el) => {
      (el as HTMLElement).focus();
      document.execCommand("selectAll");
    });
    await page.keyboard.type("WWWWWWWWWWWWWWWWWWWWWWWWWWWWWW");
    await page.waitForTimeout(300);

    // Leave the overlay before switching tools (a focused contentEditable
    // correctly swallows the single-key shortcut). Blur it outright rather
    // than clicking "somewhere neutral" in the app bar — the brand there is
    // the close-document control now, and the rest is a zero-width spacer.
    await frag.evaluate((el) => (el as HTMLElement).blur());
    await pickTool(page, "Redact");
    await dragOnPage(page, { x: 60, y: 400 }, { x: 420, y: 445 });
    await expect(page.locator(".redaction")).toHaveCount(1);

    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 120_000 }),
      page.click(".appbar__download"),
    ]);
    const bytes = readFileSync((await download.path())!);

    const [first, second] = await pageTexts(bytes, [1, 2]);
    expect(first.trim(), "the redacted page is rasterised — no text layer").toBe("");
    expect(second, "untouched pages keep selectable vector text").toContain("quick brown fox");
  });

  /**
   * The redaction raster is the whole page, so its encoding is the whole file
   * size. PNG alone used to ship here, which is the worst possible choice for
   * the scans people most often redact — lossless has no answer to sensor
   * noise. What has to hold is both halves of the trade: the default is
   * dramatically smaller, and asking for lossless actually gets lossless.
   */
  test("a redacted page ships as JPEG, and the lossless switch turns that off", async ({ page }) => {
    const w = watch(page);
    await open(page, (await fixtures()).photo);

    await pickTool(page, "Redact");
    await dragOnPage(page, { x: 80, y: 200 }, { x: 320, y: 260 });
    await expect(page.locator(".redaction")).toHaveCount(1);

    const lossy = await downloadFrom(page, ".appbar__download");
    // An image XObject is always a top-level stream (streams can't live inside
    // object streams), so its filter is readable straight out of the bytes.
    expect(lossy.toString("latin1"), "the raster is a JPEG").toMatch(/\/DCTDecode/);
    expect((await pageTexts(lossy, [1]))[0].trim(), "still no recoverable text").toBe("");

    await setLossless(page);

    const lossless = await downloadFrom(page, ".appbar__download");
    expect(lossless.toString("latin1"), "no lossy raster once asked for lossless").not.toMatch(/\/DCTDecode/);
    // The whole reason the default exists. A noisy page is several times larger
    // lossless; anything close to parity means the JPEG path silently stopped.
    expect(lossless.length).toBeGreaterThan(lossy.length * 2);
    expect(w.errors).toEqual([]);
  });

  /**
   * "Keep text" re-encodes oversized images in place. It only understood
   * `DCTDecode`, so a document whose bulk arrived as flate — scans, screenshots,
   * anything embedded from a PNG — got nothing at all from it, which is exactly
   * the document heavy enough to need it.
   */
  test("Keep text shrinks a flate-compressed image and leaves the text selectable", async ({ page }) => {
    const photo = (await fixtures()).photo;
    const before = statSync(photo).size;
    await open(page, photo);

    await page.click('[aria-label="Export options"]');
    await page.locator('[role="menuitem"]', { hasText: "Compress PDF" }).click();
    await page.locator(".compress__preset", { hasText: "Keep text" }).click();
    // The estimate is computed by actually running the optimisation, so waiting
    // for it to settle is waiting for the real result.
    await expect(page.locator(".compress__estimate")).toContainText("text stays selectable", {
      timeout: 180_000,
    });

    const bytes = await downloadFrom(page, ".dialog__actions .btn--filled");
    expect(bytes.length, `${before} → ${bytes.length} bytes`).toBeLessThan(before * 0.6);
    expect(
      (await pageTexts(bytes, [1]))[0],
      "the point of this preset — the page is still text",
    ).toContain(PHOTO_CAPTION);
  });

  /**
   * A soft mask is an image XObject too, and nothing on the stream says so —
   * it's DeviceGray, 8-bit, flate, which is exactly the shape the optimiser now
   * looks for. Rewriting one as a DeviceRGB JPEG makes it an invalid mask and
   * makes the transparency lossy, and only the *reference* from the image it
   * belongs to distinguishes it.
   */
  test("Keep text never rewrites a soft mask", async ({ page }) => {
    await open(page, (await fixtures()).masked);

    await page.click('[aria-label="Export options"]');
    await page.locator('[role="menuitem"]', { hasText: "Compress PDF" }).click();
    await page.locator(".compress__preset", { hasText: "Keep text" }).click();
    await expect(page.locator(".compress__estimate")).toContainText("text stays selectable", {
      timeout: 180_000,
    });
    const bytes = await downloadFrom(page, ".dialog__actions .btn--filled");

    const doc = await PDFDocument.load(bytes);
    let checked = 0;
    for (const [, obj] of doc.context.enumerateIndirectObjects()) {
      if (!(obj instanceof PDFRawStream)) continue;
      const ref = obj.dict.get(PDFName.of("SMask"));
      if (!(ref instanceof PDFRef)) continue;
      const mask = doc.context.lookup(ref);
      expect(mask, "the mask stream still exists").toBeInstanceOf(PDFRawStream);
      const dict = (mask as PDFRawStream).dict;
      expect(String(dict.get(PDFName.of("ColorSpace"))), "a mask must stay single-component")
        .toBe("/DeviceGray");
      expect(String(dict.get(PDFName.of("Filter"))), "and must not be re-encoded as JPEG")
        .not.toContain("DCTDecode");
      checked++;
    }
    expect(checked, "the fixture is supposed to have a soft mask").toBeGreaterThan(0);
  });

  /**
   * `/DecodeParms` that can't be read must stop the optimiser, not fall back to
   * "no prediction". Getting the predictor wrong writes a sheared noise field
   * over a real image, and nothing downstream can notice: predictor-filtered
   * data is *larger* than the samples it encodes, so the short-data guard never
   * fires. Refusing the image is the only safe answer.
   */
  test("an unreadable /DecodeParms leaves the image untouched", async ({ page }) => {
    await open(page, (await fixtures()).brokenParms);

    await page.click('[aria-label="Export options"]');
    await page.locator('[role="menuitem"]', { hasText: "Compress PDF" }).click();
    await page.locator(".compress__preset", { hasText: "Keep text" }).click();
    await expect(page.locator(".compress__estimate")).toContainText("text stays selectable", {
      timeout: 180_000,
    });
    const bytes = await downloadFrom(page, ".dialog__actions .btn--filled");

    const doc = await PDFDocument.load(bytes);
    let images = 0;
    for (const [, obj] of doc.context.enumerateIndirectObjects()) {
      if (!(obj instanceof PDFRawStream)) continue;
      if (String(obj.dict.get(PDFName.of("Subtype"))) !== "/Image") continue;
      images++;
      expect(
        String(obj.dict.get(PDFName.of("Filter"))),
        "an image we couldn't read the layout of must not be re-encoded",
      ).toContain("FlateDecode");
    }
    expect(images, "the fixture is supposed to carry two images").toBe(2);
  });

  /**
   * "Redact all matches" used to size each box by giving every character the
   * fragment's *average* advance. On an ordinary line that put the box about two
   * characters right of the match, and the leading "Ac" of "Account 4111"
   * survived into the exported raster — permanently, since the raster is all
   * that ships. Here the target sits behind narrow glyphs, is itself wide, and
   * has an accent above the cap height and descenders below the baseline.
   *
   * The ink is located in the *original* rendering, so this checks coverage of
   * what was actually drawn rather than of where we think it was; then every
   * pixel inside that ink box must be redaction-black in the export.
   */
  test("Redact all covers every glyph of every match", async ({ page, browser }) => {
    test.setTimeout(240_000);
    const file = (await fixtures()).searchRedact;
    await open(page, file);

    // Lossless, so a light pixel is a leak and not a JPEG artefact.
    await setLossless(page);

    // Where the target really is, read off the rendering rather than computed
    // from any font's metrics (which is the very thing under test): split each
    // line's ink into words at the gaps between them and take the target's words.
    const { size, x: runX } = SEARCH_REDACT;
    const targets = SEARCH_REDACT.runs.map((run) => {
      const at = run.text.indexOf(run.query);
      return {
        query: run.query,
        firstWord: run.text.slice(0, at).split(" ").length - 1,
        words: run.query.split(" ").length,
        line: { x0: runX - 2, x1: SEARCH_REDACT.page.width - 2, y0: run.baseline - size * 0.4, y1: run.baseline + size * 1.2 },
        wordCount: run.text.split(" ").length,
      };
    });

    const ink: PtRect[] = [];
    for (const t of targets) {
      const words = await wordBoxes(page, t.line, size * 0.18);
      expect(words.length, `"${t.query}": the line splits into its words`).toBe(t.wordCount);
      const mine = words.slice(t.firstWord, t.firstWord + t.words);
      ink.push({
        x0: Math.min(...mine.map((w) => w.x0)),
        x1: Math.max(...mine.map((w) => w.x1)),
        y0: Math.min(...mine.map((w) => w.y0)),
        y1: Math.max(...mine.map((w) => w.y1)),
      });
    }

    for (const t of targets) {
      await page.keyboard.press("Control+f");
      await page.locator(".findbar input").fill(t.query);
      await page.waitForTimeout(400);
      await page.locator(".findbar button", { hasText: "Redact all" }).click();
      await page.waitForTimeout(200);
    }
    await expect(page.locator(".redaction")).toHaveCount(targets.length);

    const bytes = await downloadFrom(page, ".appbar__download");
    expect((await pageTexts(bytes, [1]))[0].trim(), "the page is rasterised").toBe("");
    const out = join(mkdtempSync(join(tmpdir(), "search-redact-")), "out.pdf");
    writeFileSync(out, bytes);

    const view = await browser.newPage();
    await open(view, out);
    for (const [i, box] of ink.entries()) {
      const lightest = await lightestIn(view, box);
      expect(lightest, `every pixel of "${targets[i].query}" is covered (lightest ${lightest})`).toBeLessThan(80);
    }
    await view.close();
  });
});

/**
 * The adversarial review's cases for search redaction, kept: every way the
 * match box was found to fall short of the ink (stretched, spaced, rotated,
 * case-folded to a different length, right-to-left, or on a page whose fonts
 * hadn't been read yet). Each target is the only red on its page, so the
 * assertion is just "no red survives the export" — no geometry to argue with.
 */
test("Redact all leaves no trace of the match however the text is set", async ({ page, browser }) => {
  test.setTimeout(120_000);
  const file = (await fixtures()).searchHostile;
  const nonLatin = existsSync(SEARCH_HOSTILE_FONT);
  // Pages carrying a target: five Latin cases, two non-Latin if the font was
  // there, then the far page after the fillers.
  const targets = [0, 1, 2, 3, 4, ...(nonLatin ? [5, 6] : [])];
  targets.push(targets.length + SEARCH_HOSTILE.fillerPages);
  if (!nonLatin) test.info().annotations.push({ type: "note", description: "DejaVu not installed: Turkish and Hebrew cases skipped" });

  await open(page, file);
  await setLossless(page);
  // The fixture is honest: there is red to remove (the first page is in view).
  expect(await redPixels(page, 0), "the target is drawn in red").toBeGreaterThan(50);

  let found = 0;
  for (const q of [SEARCH_HOSTILE.query, ...(nonLatin ? [SEARCH_HOSTILE.hebrewQuery] : [])]) {
    await page.keyboard.press("Control+f");
    await page.locator(".findbar input").fill(q);
    await page.waitForTimeout(500);
    found += Number((await page.locator(".findbar__count").textContent())?.match(/\/(\d+)/)?.[1] ?? 0);
    await page.locator(".findbar button", { hasText: "Redact all" }).click();
    await page.waitForTimeout(200);
  }
  // Overlays mount only near the viewport, so count matches, not boxes.
  expect(found, "every case is found").toBe(targets.length);

  const bytes = await downloadFrom(page, ".appbar__download");
  const out = join(mkdtempSync(join(tmpdir(), "search-hostile-")), "out.pdf");
  writeFileSync(out, bytes);
  const view = await browser.newPage();
  await open(view, out);
  for (const n of targets) {
    expect(await redPixels(view, n), `page ${n + 1}: no red left after export`).toBe(0);
  }
  await view.close();
});

/**
 * The first adversarial review's worst find: on a page tree pdf.js and pdf-lib
 * walk differently, export redacted the *wrong* page and shipped the one the
 * user had redacted, text intact. The exporter now lines pdf-lib's pages up
 * with the ones pdf.js showed before touching anything.
 */
test("a damaged page list still redacts the page the user saw", async ({ page }) => {
  await open(page, (await fixtures()).damagedTree);
  await expect(page.locator(".page")).toHaveCount(3);
  await page.keyboard.press("Control+f");
  await page.locator(".findbar input").fill("SECRET");
  await page.waitForTimeout(500);
  await page.locator(".findbar button", { hasText: "Redact all" }).click();
  const bytes = await downloadFrom(page, ".appbar__download");

  expect((await pageTexts(bytes, [1, 2, 3])).map((t) => t.trim()), "page 2, and only page 2, is rasterised").toEqual(["P1", "", "P3"]);
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  expect(doc.getPageCount(), "the pages the user saw, no more").toBe(3);
  const text = allText(doc);
  expect(text, "the redacted text is gone").not.toContain("SECRET");
  expect(text, "the page the viewer never showed isn't shipped").not.toContain("UNSEEN");
});

/**
 * A kept page that shares its resource list with a redacted one must not carry
 * the redacted page's drawings along by name — and must still draw its own.
 */
test("a redacted page's drawings don't ride out on a page that shares its resources", async ({ page }) => {
  await open(page, (await fixtures()).sharedResources);
  await page.keyboard.press("Control+f");
  await page.locator(".findbar input").fill("SECRET");
  await page.waitForTimeout(500);
  await page.locator(".findbar button", { hasText: "Redact all" }).click();
  const bytes = await downloadFrom(page, ".appbar__download");

  expect((await pageTexts(bytes, [1, 2])).map((t) => t.trim())).toEqual(["", "FORM_KEPT"]);
  expect(allText(await PDFDocument.load(bytes, { updateMetadata: false })), "the redacted page's form is gone").not.toContain("SECRET");
});

/**
 * The same, through a form with no resources of its own — it paints from the
 * page's — whose `/Subtype` is an indirect reference. Narrowing has to read
 * that form to see what it paints; taking the unresolved reference for "not a
 * form" cut the page's own drawing out of the file (9b's image-skip check).
 */
test("a resourceless form with an indirect /Subtype keeps what it paints", async ({ page }) => {
  const doc = await PDFDocument.create();
  const ctx = doc.context;
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const text = (t: string) =>
    ctx.register(ctx.flateStream(`BT /F1 24 Tf 72 700 Td (${t}) Tj ET`, {
      Type: "XObject", Subtype: "Form", BBox: [0, 0, 612, 792], Resources: { Font: { F1: font.ref } },
    }));
  const wrapper = ctx.flateStream("/Fk Do", { Type: "XObject", BBox: [0, 0, 612, 792] });
  wrapper.dict.set(PDFName.of("Subtype"), ctx.register(PDFName.of("Form")));
  const res = ctx.register(ctx.obj({
    Font: { F1: font.ref },
    XObject: { Fs: text("FORM_SECRET"), Fk: text("FORM_KEPT"), Fw: ctx.register(wrapper) },
  }));
  for (const name of ["Fs", "Fw"]) {
    const p = doc.addPage([612, 792]);
    p.node.set(PDFName.of("Resources"), res);
    p.node.set(PDFName.of("Contents"), ctx.register(ctx.flateStream(`/${name} Do`)));
  }
  const file = join(mkdtempSync(join(tmpdir(), "subtype-")), "indirect-subtype.pdf");
  writeFileSync(file, await doc.save());

  await open(page, file);
  await page.keyboard.press("Control+f");
  await page.locator(".findbar input").fill("SECRET");
  await page.waitForTimeout(500);
  await page.locator(".findbar button", { hasText: "Redact all" }).click();
  const bytes = await downloadFrom(page, ".appbar__download");
  expect((await pageTexts(bytes, [1, 2])).map((t) => t.trim())).toEqual(["", "FORM_KEPT"]);
});

/** Strongly red pixels on page `n`'s canvas, once it has scrolled in and painted. */
async function redPixels(page: Page, n: number): Promise<number> {
  await page.evaluate((n) => document.querySelectorAll(".page")[n].scrollIntoView(), n);
  await page.waitForFunction((n) => {
    const c = document.querySelectorAll(".page")[n]?.querySelector("canvas");
    return !!c && c.width > 1;
  }, n);
  await page.waitForTimeout(600);
  return page.evaluate((n) => {
    const c = document.querySelectorAll(".page")[n].querySelector("canvas")!;
    const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
    let red = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] > 150 && d[i + 1] < 110 && d[i + 2] < 110) red++;
    return red;
  }, n);
}

/**
 * Everything a document carries at catalog level, through an export.
 *
 * Export used to rebuild into a new document with one `copyPages` per page,
 * which dropped all of this silently: bookmarks, page labels, the tagged
 * structure (screen readers) and `/Lang`, named destinations (so links broke),
 * layers, and the form. Editing in place keeps it — and the second half of this
 * describe block is about what editing in place must *not* keep.
 */
test.describe("export keeps the document's structure", () => {
  test("outline, labels, tags, destinations, layers and form all survive", async ({ page }) => {
    const w = watch(page);
    await open(page, (await fixtures()).structured);
    const raw = await downloadFrom(page, ".appbar__download");
    // updateMetadata: false, or pdf-lib stamps its own Producer on *our* read.
    const doc = await PDFDocument.load(raw, { updateMetadata: false });
    expect(raw.toString("latin1"), "no Info keys in the bytes either").not.toMatch(/\/Producer|\/Author|\/ModDate/);
    const S = STRUCTURED;
    const pages = doc.getPages().map((p) => p.ref);
    expect(pages.length).toBe(S.pages);

    const outline = outlineItems(doc);
    expect(outline.map((o) => o.title), "bookmarks, in order").toEqual(S.outlineTitles);
    expect(outline[0].target, "a /Dest bookmark lands on page 1").toBe(pages[0]);
    expect(outline[1].target, "...page 2").toBe(pages[1]);
    expect(outline[2].target, "a GoTo-action bookmark lands on page 3").toBe(pages[2]);
    expect(outline[3].action, "a JavaScript bookmark keeps its title, loses its script").toBeUndefined();

    expect(String(get(doc, doc.catalog, "PageLabels")), "page labels").toContain("/Nums");
    expect(text(get(doc, doc.catalog, "Lang")), "document language").toBe(S.lang);
    expect(get(doc, doc.catalog, "StructTreeRoot"), "the tag tree").toBeInstanceOf(PDFDict);

    const dests = get(doc, get(doc, doc.catalog, "Names") as PDFDict, "Dests") as PDFDict;
    const names = get(doc, dests, "Names") as PDFArray;
    expect(text(names.get(0)), "the named destination").toBe(S.namedDest);
    expect((doc.context.lookup(names.get(1)) as PDFArray).get(0), "...still points at page 2").toBe(pages[1]);
    expect(get(doc, get(doc, doc.catalog, "Names") as PDFDict, "JavaScript"), "but no document JavaScript").toBeUndefined();

    const links = pageLinks(doc, 0);
    expect(links.some((l) => l.named === S.namedDest), "the link by name").toBe(true);
    expect(links.some((l) => l.target === pages[2]), "the link to page 3 points at an output page").toBe(true);

    const oc = get(doc, doc.catalog, "OCProperties") as PDFDict;
    const ocg = doc.context.lookup((get(doc, oc, "OCGs") as PDFArray).get(0)) as PDFDict;
    expect(text(ocg.get(PDFName.of("Name"))), "the layer").toBe(S.layer);

    const fieldNames = formFields(doc).map((f) => f.name);
    expect(fieldNames, "the (unfilled) form").toEqual([S.publicField, S.secretField]);

    // ...and none of what a shared copy shouldn't carry.
    expect(get(doc, doc.catalog, "OpenAction"), "no auto-run action").toBeUndefined();
    const info = doc.context.lookup(doc.context.trailerInfo.Info) as PDFDict | undefined;
    expect(info?.keys() ?? [], "an empty Info dictionary, custom keys included").toEqual([]);
    const all = allText(doc);
    expect(all).not.toContain(S.author);
    expect(all).not.toContain(S.company);
    expect(all, "an orphaned object isn't carried along").not.toContain(S.orphanSecret);
    expect(all).not.toMatch(/app\.alert/);
    expect(w.errors).toEqual([]);
  });

  /**
   * Editing in place carries everything that is still reachable, so a redacted
   * page could survive by any route that leads to it. Page 1 holds the text, a
   * tag whose /ActualText repeats it, and a form field whose value does; all
   * three must be gone, while links *to* page 1 follow it to its replacement.
   */
  test("a redacted page leaves nothing behind, and links to it follow the replacement", async ({ page }) => {
    await open(page, (await fixtures()).structured);
    await pickTool(page, "Redact");
    await dragOnPage(page, { x: 40, y: 40 }, { x: 300, y: 120 });
    await expect(page.locator(".redaction")).toHaveCount(1);
    const bytes = await downloadFrom(page, ".appbar__download");
    const doc = await PDFDocument.load(bytes);
    const S = STRUCTURED;
    const pages = doc.getPages().map((p) => p.ref);
    expect(pages.length).toBe(S.pages);

    const [first, second] = await pageTexts(bytes, [1, 2]);
    expect(first.trim(), "page 1 is a raster").toBe("");
    expect(second).toContain(S.bodyText(2));

    const outline = outlineItems(doc);
    expect(outline[0].target, "the bookmark to page 1 now lands on its replacement").toBe(pages[0]);
    expect(outline[1].target).toBe(pages[1]);
    expect(pageLinks(doc, 1).some((l) => l.target === pages[0]), "page 2's link to page 1 follows it").toBe(true);

    const all = allText(doc);
    expect(all, "the tag's /ActualText went with the page").not.toContain(S.taggedSecret);
    expect(all, "the field on the page went with it").not.toContain(S.secretValue);
    expect(get(doc, doc.catalog, "StructTreeRoot"), "the tag tree is dropped once a page is a raster").toBeUndefined();
    expect(formFields(doc).map((f) => f.name), "fields on other pages stay").toEqual([S.publicField]);
    expect(text(get(doc, doc.catalog, "Lang")), "/Lang isn't part of the tree").toBe(S.lang);
    expect(String(doc.getPage(0).node.get(PDFName.of("Rotate")) ?? "0"), "the raster isn't rotated by inheritance").toBe("0");

    // Nothing in the file may still point at an object that isn't in it.
    expect(danglingRefs(doc), "no reference to a deleted object").toEqual([]);
  });

  /**
   * Every `copyPages` call has its own object copier, so one call per page
   * deep-copied every shared resource per page: a 1.33 MB file exported at
   * 182 MB. Twelve pages draw one incompressible image here.
   */
  test("a shared image is written once, not once per page", async ({ page }) => {
    const file = (await fixtures()).sharedImage;
    const before = statSync(file).size;
    await open(page, file);
    // An edit, so the vector path really draws on a page.
    const frag = page.locator('.page [role="textbox"]').first();
    await frag.click();
    await page.keyboard.type(" edited");
    await frag.evaluate((el) => (el as HTMLElement).blur());
    const bytes = await downloadFrom(page, ".appbar__download");
    const doc = await PDFDocument.load(bytes);
    let images = 0;
    for (const [, obj] of doc.context.enumerateIndirectObjects()) {
      if (obj instanceof PDFRawStream && String(obj.dict.get(PDFName.of("Subtype"))) === "/Image") images++;
    }
    expect(images, "one image object for twelve pages").toBe(1);
    expect(bytes.length, `${before} → ${bytes.length} bytes`).toBeLessThan(before * 1.1);
  });
});

/**
 * Exporting gives the browser a turn between pages so progress paints. It used
 * to do that with `setTimeout(0)` on *every* page — clamped to ≥4 ms, so a
 * 150-page export slept for over half a second doing nothing. Now it yields
 * only once a burst has run for a frame's worth of time. Counted rather than
 * timed: a timing threshold is flaky on a shared runner, a count isn't.
 */
test("export yields to the browser per slice of work, not per page", async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __yields: number; __counting: boolean };
    w.__yields = 0;
    w.__counting = false;
    const count = () => {
      if (w.__counting) w.__yields++;
    };
    const s = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
    if (s?.yield) {
      const orig = s.yield.bind(s);
      s.yield = () => (count(), orig());
    }
    const origPost = MessagePort.prototype.postMessage;
    MessagePort.prototype.postMessage = function (this: MessagePort, ...args: Parameters<MessagePort["postMessage"]>) {
      count();
      return origPost.apply(this, args);
    } as MessagePort["postMessage"];
    const origTimeout = window.setTimeout;
    window.setTimeout = ((fn: TimerHandler, ms?: number, ...rest: unknown[]) => {
      if (!ms) count();
      return origTimeout(fn, ms, ...rest);
    }) as typeof window.setTimeout;
  });
  await open(page, (await fixtures()).long);
  const frag = page.locator('.page [role="textbox"]').first();
  await frag.click();
  await page.keyboard.type(" edited");
  await frag.evaluate((el) => (el as HTMLElement).blur());
  await page.evaluate(() => ((window as unknown as { __counting: boolean }).__counting = true));
  const bytes = await downloadFrom(page, ".appbar__download");
  const yields = await page.evaluate(() => (window as unknown as { __yields: number }).__yields);
  expect((await PDFDocument.load(bytes)).getPageCount()).toBe(150);
  expect(yields, `${yields} yields for 150 pages`).toBeLessThan(50);
});

/**
 * Organise (reorder / rotate / extract / merge) rebuilds the file from a page
 * plan. It used to copy one page per `copyPages` call, and each call deep-copies
 * shared fonts and images afresh — so the shared image here was written once
 * per page. Calls `buildFromPlan` directly: the plan is the whole input.
 */
test.describe("organising pages", () => {
  const imagesIn = (doc: PDFDocument) => {
    let n = 0;
    for (const [, obj] of doc.context.enumerateIndirectObjects()) {
      if (obj instanceof PDFRawStream && String(obj.dict.get(PDFName.of("Subtype"))) === "/Image") n++;
    }
    return n;
  };
  const sourceOf = async () => {
    const buf = readFileSync((await fixtures()).sharedImage);
    return new Map([["main", buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer]]);
  };

  test("a reordered document shares its image instead of copying it per page", async () => {
    const sources = await sourceOf();
    const before = sources.get("main")!.byteLength;
    const plan: PlanEntry[] = Array.from({ length: 12 }, (_, i) => ({ sourceKey: "main", index: 11 - i, rotation: i === 3 ? 90 : 0 }));
    const bytes = await buildFromPlan(plan, sources);
    const doc = await PDFDocument.load(bytes);
    expect(imagesIn(doc), "one image object for twelve pages").toBe(1);
    expect(bytes.length, `${before} → ${bytes.length} bytes`).toBeLessThan(before * 1.1);
    // Order and rotation still follow the plan.
    const texts = await pageTexts(Buffer.from(bytes), [1, 4, 12]);
    expect(texts).toEqual(["Shared image page 12", "Shared image page 9", "Shared image page 1"]);
    expect(doc.getPages().map((p) => p.getRotation().angle)).toEqual([0, 0, 0, 90, 0, 0, 0, 0, 0, 0, 0, 0]);
  });

  test("a page used twice becomes two pages, rotated independently", async () => {
    const plan: PlanEntry[] = [
      { sourceKey: "main", index: 0, rotation: 0 },
      { sourceKey: "main", index: 1, rotation: 0 },
      { sourceKey: "main", index: 0, rotation: 180 },
    ];
    const doc = await PDFDocument.load(await buildFromPlan(plan, await sourceOf()));
    const pages = doc.getPages();
    expect(pages).toHaveLength(3);
    expect(new Set(pages.map((p) => p.ref.toString())).size, "three distinct page objects").toBe(3);
    expect(pages.map((p) => p.getRotation().angle)).toEqual([0, 0, 180]);
  });
});

// ---- reading structure back out of exported bytes ----

function get(doc: PDFDocument, dict: PDFDict | undefined, key: string): PDFObject | undefined {
  const v = dict?.get(PDFName.of(key));
  return v instanceof PDFRef ? doc.context.lookup(v) : v;
}

function text(v: PDFObject | undefined): string | undefined {
  return v instanceof PDFString || v instanceof PDFHexString ? v.decodeText() : undefined;
}

/** A destination or GoTo action's target page ref. */
function destTarget(doc: PDFDocument, dest: PDFObject | undefined): PDFRef | undefined {
  const d = dest instanceof PDFRef ? doc.context.lookup(dest) : dest;
  if (d instanceof PDFArray) {
    const p = d.get(0);
    return p instanceof PDFRef ? p : undefined;
  }
  return undefined;
}

function outlineItems(doc: PDFDocument) {
  const out: { title?: string; target?: PDFRef; action?: string }[] = [];
  let item = get(doc, get(doc, doc.catalog, "Outlines") as PDFDict, "First") as PDFDict | undefined;
  while (item instanceof PDFDict && out.length < 50) {
    const a = get(doc, item, "A") as PDFDict | undefined;
    out.push({
      title: text(get(doc, item, "Title")),
      target: destTarget(doc, item.get(PDFName.of("Dest"))) ?? (a ? destTarget(doc, a.get(PDFName.of("D"))) : undefined),
      action: a ? String(a.get(PDFName.of("S"))) : undefined,
    });
    item = get(doc, item, "Next") as PDFDict | undefined;
  }
  return out;
}

function pageLinks(doc: PDFDocument, pageIndex: number) {
  const annots = get(doc, doc.getPage(pageIndex).node, "Annots") as PDFArray | undefined;
  const out: { named?: string; target?: PDFRef }[] = [];
  for (let i = 0; i < (annots?.size() ?? 0); i++) {
    const a = doc.context.lookup(annots!.get(i)) as PDFDict;
    if (String(a.get(PDFName.of("Subtype"))) !== "/Link") continue;
    const dest = a.get(PDFName.of("Dest"));
    const action = get(doc, a, "A") as PDFDict | undefined;
    out.push({ named: text(dest), target: destTarget(doc, dest) ?? (action ? destTarget(doc, action.get(PDFName.of("D"))) : undefined) });
  }
  return out;
}

function formFields(doc: PDFDocument) {
  const fields = get(doc, get(doc, doc.catalog, "AcroForm") as PDFDict, "Fields") as PDFArray | undefined;
  const out: { name?: string }[] = [];
  for (let i = 0; i < (fields?.size() ?? 0); i++) {
    out.push({ name: text(get(doc, doc.context.lookup(fields!.get(i)) as PDFDict, "T")) });
  }
  return out;
}

/** Every string in the file, object dictionaries and decoded streams alike. */
function allText(doc: PDFDocument): string {
  const parts: string[] = [];
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    parts.push(obj.toString());
    if (obj instanceof PDFRawStream) {
      try {
        parts.push(Buffer.from(decodePDFRawStream(obj).decode()).toString("latin1"));
      } catch {
        /* an image codec pdf-lib can't decode — not text */
      }
    }
  }
  return parts.join("\n");
}

function danglingRefs(doc: PDFDocument): string[] {
  const out: string[] = [];
  const visit = (o: PDFObject | undefined, depth = 0) => {
    if (!o || depth > 64) return;
    if (o instanceof PDFRef) {
      if (!doc.context.lookup(o)) out.push(o.toString());
      return;
    }
    const dict = o instanceof PDFRawStream ? o.dict : o;
    if (dict instanceof PDFDict) for (const [, v] of dict.entries()) visit(v, depth + 1);
    else if (dict instanceof PDFArray) for (let i = 0; i < dict.size(); i++) visit(dict.get(i), depth + 1);
  };
  for (const [, obj] of doc.context.enumerateIndirectObjects()) visit(obj);
  return out;
}

type PtRect = { x0: number; x1: number; y0: number; y1: number };

/** Page 1's canvas, mapped to PDF points for a page of the fixture's size. */
function readPage1(page: Page, rect: PtRect, mode: "words" | "lightest", gapPt = 0) {
  const { width: ptW, height: ptH } = SEARCH_REDACT.page;
  return page.evaluate(
    ({ ptW, ptH, rect, mode, gapPt }) => {
      const c = document.querySelector<HTMLCanvasElement>(".page canvas")!;
      const k = c.width / ptW;
      // PDF y grows upward; canvas y grows downward.
      const px0 = Math.floor(rect.x0 * k);
      const px1 = Math.ceil(rect.x1 * k);
      const py0 = Math.floor((ptH - rect.y1) * k);
      const py1 = Math.ceil((ptH - rect.y0) * k);
      const w = px1 - px0;
      const h = py1 - py0;
      const data = c.getContext("2d")!.getImageData(px0, py0, w, h).data;
      const lum = (x: number, y: number) => {
        const i = (y * w + x) * 4;
        return 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      };
      if (mode === "lightest") {
        let max = 0;
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) max = Math.max(max, lum(x, y));
        return max;
      }
      // Any visible ink at all counts (anti-aliased edges included), since a
      // leaked sliver of a glyph is exactly what this is looking for.
      const inked = (x: number, y: number) => lum(x, y) < 235;
      const words: { x0: number; x1: number; y0: number; y1: number }[] = [];
      const gap = Math.max(1, Math.round(gapPt * k));
      let cur: { a: number; b: number; top: number; bottom: number } | null = null;
      let blank = 0;
      for (let x = 0; x < w; x++) {
        let top = -1;
        let bottom = -1;
        for (let y = 0; y < h; y++) {
          if (!inked(x, y)) continue;
          if (top < 0) top = y;
          bottom = y;
        }
        if (top < 0) {
          if (cur && ++blank >= gap) {
            words.push({ x0: (px0 + cur.a) / k, x1: (px0 + cur.b + 1) / k, y1: ptH - (py0 + cur.top) / k, y0: ptH - (py0 + cur.bottom + 1) / k });
            cur = null;
          }
          continue;
        }
        blank = 0;
        if (!cur) cur = { a: x, b: x, top, bottom };
        else {
          cur.b = x;
          cur.top = Math.min(cur.top, top);
          cur.bottom = Math.max(cur.bottom, bottom);
        }
      }
      if (cur) words.push({ x0: (px0 + cur.a) / k, x1: (px0 + cur.b + 1) / k, y1: ptH - (py0 + cur.top) / k, y0: ptH - (py0 + cur.bottom + 1) / k });
      return words;
    },
    { ptW, ptH, rect, mode, gapPt },
  );
}

/** Ink boxes, in PDF points, of the words on one line of page 1: runs of inked
 * columns separated by at least `gapPt` of clean paper. */
async function wordBoxes(page: Page, line: PtRect, gapPt: number): Promise<PtRect[]> {
  return (await readPage1(page, line, "words", gapPt)) as PtRect[];
}

/** The lightest luminance inside `rect` on page 1 (0 = black). */
async function lightestIn(page: Page, rect: PtRect): Promise<number> {
  return (await readPage1(page, rect, "lightest")) as number;
}
