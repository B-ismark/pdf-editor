import { test, expect, type Page } from "@playwright/test";
import { PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream } from "pdf-lib";
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { fixtures, PHOTO_CAPTION } from "./fixtures";
import { open, watch, pickTool, dragOnPage, pageTexts, setLossless } from "./helpers";

/**
 * Image encoding runs off the page (`codecWorker.ts`).
 *
 * Squeezing a redacted page — a ~7 MP raster, encoded as both JPEG and
 * lossless to keep the smaller — used to run on the main thread and froze the
 * tab for a second or more per page, with the progress line stuck and every
 * click queued behind it. Compress and "Keep text" did the same per page and
 * per image. What has to hold: no long main-thread task while it happens, the
 * work really is in the codec worker, and the file is what it was.
 *
 * "Long" is measured with the Long Tasks API. The bound is generous — before
 * this the export of one page measured 1.0–1.2 s in a single task, and after it
 * nothing over the API's own 50 ms floor — so a slow CI machine doesn't flake it.
 */
const LONG_MS = 250;

/** Start recording main-thread long tasks; call before `page.goto`. */
async function recordLongTasks(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __longTasks: number[] };
    w.__longTasks = [];
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) w.__longTasks.push(Math.round(e.duration));
    }).observe({ type: "longtask" });
  });
}
const resetLongTasks = (page: Page) =>
  page.evaluate(() => ((window as unknown as { __longTasks: number[] }).__longTasks = []));
const longestTask = (page: Page) =>
  page.evaluate(() => Math.max(0, ...(window as unknown as { __longTasks: number[] }).__longTasks));

/** Whether the codec worker has been started on this page. */
function codecWorkerSeen(page: Page) {
  const seen = { started: false };
  page.on("worker", (w) => {
    if (/codecWorker/.test(w.url())) seen.started = true;
  });
  return seen;
}

async function download(page: Page, selector: string): Promise<Buffer> {
  const [d] = await Promise.all([page.waitForEvent("download", { timeout: 180_000 }), page.click(selector)]);
  return readFileSync((await d.path())!);
}

async function redactPhoto(page: Page) {
  await open(page, (await fixtures()).photo);
  await pickTool(page, "Redact");
  await dragOnPage(page, { x: 80, y: 200 }, { x: 320, y: 260 });
  await expect(page.locator(".redaction")).toHaveCount(1);
  // Let the opening paint and text read settle; only the export is measured.
  await page.waitForTimeout(800);
}

/** The image XObjects in a file, with their dictionaries and raw bytes. */
async function images(bytes: Buffer) {
  const doc = await PDFDocument.load(bytes);
  const out: { dict: PDFDict; contents: Uint8Array }[] = [];
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream && String(obj.dict.get(PDFName.of("Subtype"))) === "/Image") {
      out.push({ dict: obj.dict, contents: obj.contents });
    }
  }
  return out;
}

test.describe("image encoding off the page", () => {
  test.setTimeout(180_000);

  for (const lossless of [false, true]) {
    test(`a redacted page exports without freezing the tab (${lossless ? "lossless" : "smaller of JPEG and lossless"})`, async ({ page }) => {
      const w = watch(page);
      const codec = codecWorkerSeen(page);
      await recordLongTasks(page);
      await redactPhoto(page);
      if (lossless) await setLossless(page);
      await resetLongTasks(page);

      const bytes = await download(page, ".appbar__download");

      expect(await longestTask(page), "the longest main-thread task while exporting (ms)").toBeLessThan(LONG_MS);
      expect(codec.started, "the raster was encoded in the codec worker").toBe(true);
      // Still the file it was: rasterised, and the codec the setting asks for.
      expect((await pageTexts(bytes, [1]))[0].trim(), "no recoverable text").toBe("");
      const filters = (await images(bytes)).map((i) => String(i.dict.get(PDFName.of("Filter"))));
      if (lossless) expect(filters).not.toContain("/DCTDecode");
      else expect(filters, "the photo page is smaller as JPEG").toContain("/DCTDecode");
      expect(w.errors).toEqual([]);
    });
  }

  /**
   * The lossless raster goes into the file as the codec made it — DeviceRGB
   * samples behind PNG row filters (`/Predictor 15`), deflated — rather than as
   * a PNG pdf-lib unpacks and packs again on the page. Read back independently
   * here: every row's filter is one PNG defines, the samples fill the page
   * exactly, the redaction is solid black in them, and the photo is not.
   */
  test("the lossless raster is the page's own pixels, losslessly", async ({ page }) => {
    await redactPhoto(page);
    await setLossless(page);
    const bytes = await download(page, ".appbar__download");

    const [img] = await images(bytes);
    const num = (d: PDFDict, k: string) => (d.get(PDFName.of(k)) as PDFNumber).asNumber();
    const W = num(img.dict, "Width");
    const H = num(img.dict, "Height");
    expect(String(img.dict.get(PDFName.of("Filter")))).toBe("/FlateDecode");
    expect(String(img.dict.get(PDFName.of("ColorSpace")))).toBe("/DeviceRGB");
    expect(img.dict.get(PDFName.of("SMask")), "an opaque page needs no mask").toBeUndefined();
    const parms = img.dict.get(PDFName.of("DecodeParms")) as PDFDict;
    expect(num(parms, "Predictor")).toBe(15);
    expect(num(parms, "Colors")).toBe(3);
    expect(num(parms, "Columns")).toBe(W);

    const raw = inflateSync(Buffer.from(img.contents));
    const rowLen = W * 3;
    expect(raw.length, "one filter byte plus a row of samples per row").toBe(H * (rowLen + 1));
    // Undo the PNG row filters (written out again here, not imported).
    const px = new Uint8Array(W * H * 3);
    for (let y = 0; y < H; y++) {
      const type = raw[y * (rowLen + 1)];
      expect(type, `row ${y}'s filter`).toBeLessThanOrEqual(4);
      for (let i = 0; i < rowLen; i++) {
        const a = i >= 3 ? px[y * rowLen + i - 3] : 0;
        const b = y > 0 ? px[(y - 1) * rowLen + i] : 0;
        const c = i >= 3 && y > 0 ? px[(y - 1) * rowLen + i - 3] : 0;
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        const pred = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][type];
        px[y * rowLen + i] = (raw[y * (rowLen + 1) + 1 + i] + pred) & 0xff;
      }
    }

    // The redaction, found by where it is on screen: its middle, in raster pixels.
    const box = await page.locator(".redaction").boundingBox();
    const pageBox = await page.locator(".page").first().boundingBox();
    const cx = Math.round(((box!.x + box!.width / 2 - pageBox!.x) / pageBox!.width) * W);
    const cy = Math.round(((box!.y + box!.height / 2 - pageBox!.y) / pageBox!.height) * H);
    const at = (x: number, y: number) => Array.from(px.subarray((y * W + x) * 3, (y * W + x) * 3 + 3));
    expect(at(cx, cy), "solid black under the redaction").toEqual([0, 0, 0]);
    const distinct = new Set<number>();
    for (let i = 0; i < px.length; i += 3 * 997) distinct.add((px[i] << 16) | (px[i + 1] << 8) | px[i + 2]);
    expect(distinct.size, "the rest is the page, not a blank").toBeGreaterThan(50);
  });

  test("Compress and Keep text encode off the page", async ({ page }) => {
    const codec = codecWorkerSeen(page);
    await recordLongTasks(page);
    await open(page, (await fixtures()).photo);
    await page.waitForTimeout(800);
    await resetLongTasks(page);

    // Opening the dialog runs the Balanced (rasterising) preset to estimate it.
    await page.click('[aria-label="Export options"]');
    await page.locator('[role="menuitem"]', { hasText: "Compress PDF" }).click();
    await expect(page.locator(".compress__estimate")).toContainText(/MB|KB/, { timeout: 180_000 });
    await page.locator(".compress__preset", { hasText: "Keep text" }).click();
    await expect(page.locator(".compress__estimate")).toContainText("text stays selectable", { timeout: 180_000 });
    const bytes = await download(page, ".dialog__actions .btn--filled");

    expect(await longestTask(page), "the longest main-thread task while compressing (ms)").toBeLessThan(LONG_MS);
    expect(codec.started).toBe(true);
    expect((await pageTexts(bytes, [1]))[0]).toContain(PHOTO_CAPTION);
  });

  /**
   * The worker is an optimisation, never a dependency: if it can't load (a
   * blocked script, an old browser) the same code runs on the page, and the
   * export still finishes — it must not wait for a reply that never comes.
   */
  test("if the codec worker can't start, the export still completes on the page", async ({ page }) => {
    const w = watch(page);
    let fetched = 0;
    await page.route(/codecWorker[^/]*\.js/, (route) => (fetched++, route.abort()));
    await redactPhoto(page);
    const bytes = await download(page, ".appbar__download");
    // And it isn't asked for again: a worker that can't load once won't the
    // next time either, and "Keep text" would otherwise retry it per image.
    await download(page, ".appbar__download");
    expect(fetched, "the worker script was tried once, not once per encode").toBe(1);
    expect((await pageTexts(bytes, [1]))[0].trim()).toBe("");
    const filters = (await images(bytes)).map((i) => String(i.dict.get(PDFName.of("Filter"))));
    expect(filters, "MozJPEG still ran, on the page").toContain("/DCTDecode");
    expect(w.errors.filter((e) => !/codecWorker|Failed to load/.test(e))).toEqual([]);
  });
});
