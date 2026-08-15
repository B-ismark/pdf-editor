import { test, expect } from "@playwright/test";
import { PDFDocument, PDFName, PDFRawStream, PDFRef } from "pdf-lib";
import { readFileSync, statSync } from "node:fs";
import { fixtures, PHOTO_CAPTION } from "./fixtures";
import { open, watch, pickTool, dragOnPage, pageTexts } from "./helpers";
import type { Page } from "@playwright/test";

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

    await page.click('[aria-label="More actions"]');
    await page.locator('[role="menuitemcheckbox"]', { hasText: "Lossless redacted pages" }).click();

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

    await page.click('[aria-label="More actions"]');
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

    await page.click('[aria-label="More actions"]');
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

    await page.click('[aria-label="More actions"]');
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
});
