import { test, expect, type Page } from "@playwright/test";
import { PDFDict, PDFDocument, PDFName } from "pdf-lib";
import { readFileSync } from "node:fs";
import { fixtures, ROTATED_TEXT } from "./fixtures";
import { open, watch, pickTool, pageTexts, expectClean } from "./helpers";

/**
 * The page plan: reorder, rotate and delete are ordinary edits.
 *
 * Organise used to rebuild the file and throw every edit away. Now the page
 * order and turns live in the document state, so markup stays with its page,
 * undo puts the pages back, and only export applies the plan — which means the
 * file has to come out in the planned order, turned the planned way, with a
 * deleted page *gone* rather than merely unlisted.
 */

async function download(page: Page): Promise<Buffer> {
  const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 120_000 }), page.click(".appbar__download")]);
  return readFileSync((await dl.path())!);
}

async function organise(page: Page, steps: (org: ReturnType<Page["locator"]>) => Promise<void>) {
  await page.getByRole("button", { name: /Organise pages/ }).first().click();
  const org = page.locator(".organize");
  await expect(org.locator(".pcard").first()).toBeVisible();
  await steps(org);
  await org.locator(".btn--filled").click();
  await expect(org).toHaveCount(0);
}

const heading = (n: number) => new RegExp(`Page ${n}(?!\\d)`);

test("reorder, rotate and delete keep the edits, undo, and ship exactly the planned pages", async ({ page }) => {
  const w = watch(page);
  await open(page, (await fixtures()).sample);

  // A text box on source page 1.
  await pickTool(page, "Add text");
  const p1 = (await page.locator(".page").first().boundingBox())!;
  await page.mouse.click(p1.x + 120, p1.y + 140);
  await page.keyboard.type("Stays with page one");
  await pickTool(page, "Select");
  // Making the box turned the panel to Properties; the page tools are a tab away.
  await page.keyboard.press("Escape");
  await page.getByRole("tab", { name: "Document" }).click();

  await organise(page, async (org) => {
    // [1,2,3,…] → [2,1,3,…] → [2,1,4,…] (page 3 deleted) → page 1 turned.
    await org.locator(".pcard").nth(0).locator('[aria-label="Move later"]').click();
    await org.locator(".pcard").nth(2).locator('[aria-label="Delete page"]').click();
    await org.locator(".pcard").nth(1).locator('[aria-label="Rotate"]').click();
  });

  // No confirm, no rebuild: the edit is still there, and the viewer follows.
  await expect(page.locator(".page")).toHaveCount(11);
  await expect(page.locator(".textbox")).toHaveCount(1);
  await expect(page.locator('.page[data-page-pos="1"]')).toHaveAttribute("data-turn", "90");
  await expect(page.locator('.page[data-page-pos="1"] .textbox')).toHaveCount(1);

  const bytes = await download(page);
  const doc = await PDFDocument.load(bytes);
  expect(doc.getPageCount()).toBe(11);
  const texts = await pageTexts(bytes, Array.from({ length: 11 }, (_, i) => i + 1));
  expect(texts[0]).toMatch(heading(2));
  expect(texts[1]).toMatch(heading(1));
  expect(texts[1], "the text box went with its page").toContain("Stays with page one");
  expect(texts[2]).toMatch(heading(4));
  expect(texts.some((t) => heading(3).test(t)), "the deleted page isn't in the file").toBe(false);
  expect(doc.getPage(1).getRotation().angle).toBe(90);
  expect(doc.getPage(0).getRotation().angle).toBe(0);
  // Not just unlisted: no page object for it survives anywhere in the file.
  const pageObjects = doc.context
    .enumerateIndirectObjects()
    .filter(([, o]) => o instanceof PDFDict && String(o.get(PDFName.of("Type"))) === "/Page");
  expect(pageObjects.length).toBe(11);

  // One undo puts the pages back — and keeps the text box.
  await page.keyboard.press("Control+z");
  await expect(page.locator(".page")).toHaveCount(12);
  await expect(page.locator('.page[data-page-pos="0"] .textbox')).toHaveCount(1);
  await expect(page.locator('.page[data-page-pos="0"]')).not.toHaveAttribute("data-turn", "90");
  expectClean(w);
});

test("on a page with its own /Rotate, new text lands where it was placed and reads upright", async ({ page }) => {
  const w = watch(page);
  await open(page, (await fixtures()).rotated);
  const pg = page.locator(".page").first();
  const box = (await pg.boundingBox())!;
  const pxPerPt = box.width / 400;

  await pickTool(page, "Add text");
  const at = { x: 60, y: 200 }; // shown-page points from the top-left, on screen
  await page.mouse.click(box.x + at.x * pxPerPt, box.y + at.y * pxPerPt);
  await page.keyboard.type("UPRIGHT");
  await pickTool(page, "Select");

  // Upright on screen: wider than tall.
  const tb = (await page.locator(".textbox").first().boundingBox())!;
  expect(tb.width).toBeGreaterThan(tb.height * 2);

  const bytes = await download(page);
  const placed = await shownPositionOf(bytes, "UPRIGHT");
  expect(placed, "the text box is in the file").not.toBeNull();
  // Reads left to right on the page as shown.
  expect(placed!.dirX).toBeGreaterThan(0.99);
  expect(Math.abs(placed!.x - at.x)).toBeLessThan(4);
  // The click is the top of the line; its baseline sits one line below.
  expect(placed!.y).toBeGreaterThan(at.y);
  expect(placed!.y).toBeLessThan(at.y + 24);

  // And the page's own text is where it always was.
  const label = await shownPositionOf(bytes, ROTATED_TEXT);
  expect(label!.x).toBeGreaterThan(330);
  expect(label!.y).toBeLessThan(60);
  expectClean(w);
});

test("on a turned page, dragging a text box moves it the way the pointer went", async ({ page }) => {
  await open(page, (await fixtures()).sample);
  await organise(page, async (org) => {
    await org.locator(".pcard").nth(0).locator('[aria-label="Rotate"]').click();
  });
  const pg = page.locator(".page").first();
  await expect(pg).toHaveAttribute("data-turn", "90");
  const box = (await pg.boundingBox())!;

  await pickTool(page, "Add text");
  await page.mouse.click(box.x + 120, box.y + 120);
  await page.keyboard.type("Moved");
  await page.keyboard.press("Escape");
  const tb = page.locator(".textbox").first();
  await tb.click();
  const move = page.locator(".tb-move").first();
  await expect(move).toBeVisible();
  const before = (await tb.boundingBox())!;
  const mb = (await move.boundingBox())!;
  await page.mouse.move(mb.x + mb.width / 2, mb.y + mb.height / 2);
  await page.mouse.down();
  await page.mouse.move(mb.x + mb.width / 2 + 150, mb.y + mb.height / 2, { steps: 12 });
  await page.mouse.up();
  const after = (await tb.boundingBox())!;
  expect(after.x - before.x).toBeGreaterThan(130);
  expect(after.x - before.x).toBeLessThan(170);
  expect(Math.abs(after.y - before.y)).toBeLessThan(8);
});

/**
 * Where a string sits on its page *as a reader shows it* (points from the
 * top-left, after `/Rotate`), and which way it runs.
 */
async function shownPositionOf(bytes: Buffer, needle: string) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, stopAtErrors: false }).promise;
  for (let n = 1; n <= doc.numPages; n++) {
    const pg = await doc.getPage(n);
    const vp = pg.getViewport({ scale: 1 });
    const content = await pg.getTextContent();
    for (const item of content.items) {
      if (!("str" in item) || !item.str.includes(needle)) continue;
      const m = pdfjs.Util.transform(vp.transform, item.transform);
      const len = Math.hypot(m[0], m[1]);
      return { page: n, x: m[4], y: m[5], dirX: m[0] / len };
    }
  }
  return null;
}
