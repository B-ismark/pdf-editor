import { expect, test, type Page } from "@playwright/test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { SPLIT_LINE, fixtures } from "./fixtures";
import { dragOnPage, expectClean, open, pageTexts, pickTool, watch } from "./helpers";

/**
 * An edited run keeps to its line — see `src/pdf/lineFit.ts`.
 *
 * Word processors write a line as several runs, each at its own x. Editing one
 * grew it in place while the next kept its x, so "50% from both" → "…bothy"
 * printed "bothymployer": the replacement and the opaque box hiding the original
 * glyphs both ran over the next run's word space and first letter. Reported on
 * screen; it was in the exported file too. The edit now keeps to the room before
 * the next run (less the word space) and is condensed when it needs more — on
 * screen and in the file, by the same rule.
 */

const { size, baseline, runs, tab, page: PAGE } = SPLIT_LINE;

/** Where each run of the split line starts, and where the middle one ends. */
async function geometry() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const w = (t: string) => font.widthOfTextAtSize(t, size);
  const middleX = SPLIT_LINE.x + w(runs[0]) + w(" ");
  const middleEnd = middleX + w(runs[1]);
  const nextX = middleEnd + w(" ");
  return { middleX, middleEnd, nextX };
}

/** Replace a run's text by typing over it. */
async function retype(page: Page, find: string, replacement: string) {
  // By id: a locator filtered on the old text stops matching once it changes.
  const id = await page.locator(".fragment", { hasText: find }).first().getAttribute("data-id");
  const el = page.locator(`.fragment[data-id="${id}"]`);
  await el.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type(replacement);
  await expect(el).toHaveText(replacement);
  return el;
}

/** Dark pixels on the first page's canvas inside a box given in PDF units. */
function inkIn(page: Page, box: { x0: number; x1: number; y0: number; y1: number }) {
  return page.evaluate(
    ({ box, PAGE }) => {
      const c = document.querySelector<HTMLCanvasElement>(".page canvas")!;
      const sx = c.width / PAGE.width;
      const sy = c.height / PAGE.height;
      const x = Math.round(box.x0 * sx);
      const y = Math.round((PAGE.height - box.y1) * sy);
      const w = Math.max(1, Math.round((box.x1 - box.x0) * sx));
      const h = Math.max(1, Math.round((box.y1 - box.y0) * sy));
      const d = c.getContext("2d")!.getImageData(x, y, w, h).data;
      let dark = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] < 3 * 128) dark++;
      return dark;
    },
    { box, PAGE },
  );
}

test("an edited run stops short of the next run on its line, on screen", async ({ page }) => {
  const w = watch(page);
  await open(page, (await fixtures()).splitLine);

  const next = page.locator(".fragment", { hasText: runs[2] }).first();
  const nextLeft = (await next.boundingBox())!.x;
  const el = await retype(page, runs[1], `${runs[1]}y and a good deal more`);
  await page.waitForTimeout(200);

  // The rendered box — after any condensing — ends before the next run, and
  // leaves the word space the document had between them.
  const right = await el.evaluate((n) => n.getBoundingClientRect().right);
  const scale = await page.evaluate(
    (W) => document.querySelector<HTMLElement>(".page")!.getBoundingClientRect().width / W,
    PAGE.width,
  );
  const { middleEnd, nextX } = await geometry();
  const space = (nextX - middleEnd) * scale;
  expect(right, "the edit runs into the next word").toBeLessThanOrEqual(nextLeft - space + 0.5);
  // The next run itself is untouched: still where it was, still its own text.
  expect((await next.boundingBox())!.x).toBeCloseTo(nextLeft, 1);
  await expect(next).toHaveText(runs[2]);
  expectClean(w);
});

test("a run with room to spare grows into it, and the last run grows freely", async ({ page }) => {
  const w = watch(page);
  await open(page, (await fixtures()).splitLine);

  // A label a tab stop away from its value has room: no condensing.
  const label = await retype(page, tab.label, "Amount due today:");
  await page.waitForTimeout(200);
  expect(await label.evaluate((n) => n.style.transform)).toBe("");
  const value = page.locator(".fragment", { hasText: tab.value }).first();
  expect(await label.evaluate((n) => n.getBoundingClientRect().right)).toBeLessThan((await value.boundingBox())!.x);

  // Nothing after it on its line: nothing to run into.
  const last = await retype(page, tab.value, "120,000,000.00");
  await page.waitForTimeout(200);
  expect(await last.evaluate((n) => n.style.transform)).toBe("");
  expectClean(w);
});

// Both export paths draw edits with their own code: pdf-lib operators on a
// vector page, a 2D canvas on a page a redaction rasterises.
for (const path of ["vector", "raster"] as const) {
  test(`the exported file keeps the next word whole too (${path} path)`, async ({ page }) => {
    const w = watch(page);
    const { splitLine } = await fixtures();
    await open(page, splitLine);
    const { middleEnd, nextX } = await geometry();
    // The next run's first letter, and the word space before it.
    const firstLetter = { x0: nextX, x1: nextX + size * 0.45, y0: baseline, y1: baseline + size * 0.5 };
    const wordSpace = { x0: middleEnd + size * 0.06, x1: nextX - 0.3, y0: baseline, y1: baseline + size * 0.7 };
    const letterBefore = await inkIn(page, firstLetter);
    expect(letterBefore, "the fixture's next run has no ink where expected").toBeGreaterThan(5);
    expect(await inkIn(page, wordSpace)).toBe(0);

    await retype(page, runs[1], `${runs[1]}y and a good deal more`);
    if (path === "raster") {
      // A redaction anywhere on the page sends it down the raster path. On
      // bare paper at the top left, clear of every run.
      await pickTool(page, "Redact");
      await dragOnPage(page, { x: 20, y: 8 }, { x: 160, y: 30 });
      await expect(page.locator(".redaction")).toHaveCount(1);
    }
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 120_000 }),
      page.click(".appbar__download"),
    ]);
    const chunks: Buffer[] = [];
    for await (const c of await download.createReadStream()) chunks.push(c as Buffer);
    const bytes = Buffer.concat(chunks);
    // Proof of the path taken: a rasterised page keeps no text layer.
    const [text] = await pageTexts(bytes, [1]);
    if (path === "raster") expect(text.trim()).toBe("");
    else expect(text).toContain(runs[2]);
    const out = join(mkdtempSync(join(tmpdir(), "line-")), "exported.pdf");
    writeFileSync(out, bytes);

    await open(page, out);
    // The cover and the replacement stop before the next word: its first letter
    // has all its ink, and the word space is still empty.
    expect(await inkIn(page, firstLetter)).toBeGreaterThanOrEqual(letterBefore - 2);
    expect(await inkIn(page, wordSpace), "the edit was drawn into the word space").toBe(0);
    expectClean(w);
  });
}
