import { test, expect, type Page } from "@playwright/test";
import { PDFDict, PDFDocument, PDFName } from "pdf-lib";
import { readFileSync } from "node:fs";
import { fixtures, ROTATED_TEXT, STRUCTURED } from "./fixtures";
import { open, watch, pickTool, pickSubTool, pageTexts, expectClean, seedStore, docRecord, restoreSeeded, EMPTY, openOrganise } from "./helpers";
import type { DocState } from "../src/pdf/types";

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
  await openOrganise(page);
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
  await page.keyboard.press("Escape");

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

/** Open `file` as a restored session holding `doc`. */
async function restoreWith(page: Page, file: string, doc: Partial<DocState>) {
  await page.goto("/");
  await seedStore(page, [["doc:p", docRecord("p", "doc.pdf", 0, { doc: { ...EMPTY, ...doc } })]], [["bytes:p", file]]);
  await restoreSeeded(page);
}

/** Organise → Add PDF → Apply → confirm the rebuild. */
async function mergeIn(page: Page, file: string) {
  await openOrganise(page);
  const org = page.locator(".organize");
  await expect(org.locator(".pcard").first()).toBeVisible();
  const before = await org.locator(".pcard").count();
  await org.locator("input[type=file]").setInputFiles(file);
  await expect.poll(() => org.locator(".pcard").count(), { timeout: 30_000 }).toBeGreaterThan(before);
  await org.locator(".btn--filled").click();
  await page.locator(".dialog").getByRole("button", { name: "Apply" }).click();
  return org;
}

/** Every `/Type /Page` object in the file, in the page tree or not. */
function pageObjects(doc: PDFDocument) {
  return doc.context.enumerateIndirectObjects().filter(([, o]) => o instanceof PDFDict && String(o.get(PDFName.of("Type"))) === "/Page");
}

const quarter = (rotate: number, n = 12) => Array.from({ length: n }, (_, index) => ({ index, rotate: index === 0 ? rotate : 0 }));

test.describe("Organise rebuilds keep what the plan says", () => {
  test("a merge after deleting a page doesn't bring it back through a link", async ({ page }) => {
    const f = await fixtures();
    // Page 3 deleted; page 1 has a link that jumps to it.
    await restoreWith(page, f.structured, { pages: [{ index: 0, rotate: 0 }, { index: 1, rotate: 0 }] });
    const org = await mergeIn(page, f.typeset);
    await expect(org).toHaveCount(0, { timeout: 60_000 });
    const doc = await PDFDocument.load(await download(page));
    expect(pageObjects(doc).length, "no copy of the deleted page rides along").toBe(doc.getPageCount());
    const texts = await pageTexts(await doc.save().then(Buffer.from), Array.from({ length: doc.getPageCount() }, (_, i) => i + 1));
    expect(texts.join(" ")).not.toContain(STRUCTURED.bodyText(3));
  });

  test("a merge won't bake whiteout over live text into the pages", async ({ page }) => {
    const f = await fixtures();
    const cover = { id: "r-1", pageIndex: 0, x: 0, y: 0, width: 2000, height: 2000, color: "#ffffff", cover: true };
    await restoreWith(page, f.sample, { redactions: [cover] });
    const org = await mergeIn(page, f.typeset);
    await expect(org).toContainText("Whiteout sits over live text");
    await expect(page.locator(".page")).toHaveCount(12);
  });

  test("page numbers number the merged document in its new order", async ({ page }) => {
    const f = await fixtures();
    const pages = Array.from({ length: 12 }, (_, i) => ({ index: i === 0 ? 1 : i === 1 ? 0 : i, rotate: 0 }));
    await restoreWith(page, f.sample, { pages, pageNumbers: { position: "bottom-center", start: 101, size: 10, color: "#000000" } });
    const org = await mergeIn(page, f.typeset);
    await expect(org).toHaveCount(0, { timeout: 60_000 });
    const bytes = await download(page);
    const n = (await PDFDocument.load(bytes)).getPageCount();
    const texts = await pageTexts(bytes, [1, 2, n]);
    expect(texts[0]).toMatch(heading(2));
    expect(texts[0]).toMatch(/\b101\b/);
    expect(texts[1]).toMatch(/\b102\b/);
    expect(texts[2], "the merged-in pages are numbered too").toMatch(new RegExp(`\\b${100 + n}\\b`));
  });

  test("Extract hands back the pages as edited, not the original", async ({ page }) => {
    const f = await fixtures();
    const redaction = { id: "r-1", pageIndex: 0, x: 0, y: 0, width: 595, height: 842, color: "#000000" };
    await restoreWith(page, f.sample, { redactions: [redaction] });
    await openOrganise(page);
    const org = page.locator(".organize");
    await org.locator(".pcard__thumb").first().click();
    const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 120_000 }), org.getByRole("button", { name: /Extract 1/ }).click()]);
    const bytes = readFileSync((await dl.path())!);
    const [text] = await pageTexts(bytes, [1]);
    expect(text).not.toContain("Confidential Report");
    expect(text).not.toContain("4111");
  });
});

test("page labels follow their pages when one is deleted", async ({ page }) => {
  const f = await fixtures();
  await restoreWith(page, f.structured, { pages: [{ index: 1, rotate: 0 }, { index: 2, rotate: 0 }] });
  const bytes = await download(page);
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false }).promise;
  expect(await doc.getPageLabels()).toEqual([STRUCTURED.labels[1], STRUCTURED.labels[2]]);
});

test.describe("editing a turned page", () => {
  // Two squares in the bottom margin, which on a page turned 90° is the left.
  const rects = [
    { id: "a-1", pageIndex: 0, kind: "rect", x: 100, y: 30, width: 40, height: 40, color: "#d00000", strokeWidth: 2 },
    { id: "a-2", pageIndex: 0, kind: "rect", x: 300, y: 70, width: 40, height: 40, color: "#d00000", strokeWidth: 2 },
  ];
  const shapes = (page: Page) => page.locator('.page[data-page-pos="0"] .annot-svg rect[stroke="#d00000"]');

  test("Align left lines things up on the left as you see it", async ({ page }) => {
    const f = await fixtures();
    await restoreWith(page, f.sample, { pages: quarter(90), annotations: rects as DocState["annotations"] });
    const pg = page.locator(".page").first();
    await expect(pg).toHaveAttribute("data-turn", "90");
    const box = (await pg.boundingBox())!;
    const k = box.width / 842;
    // Marquee in the empty margin, shown-page points from the top-left.
    await page.mouse.move(box.x + 5 * k, box.y + 80 * k);
    await page.mouse.down();
    await page.mouse.move(box.x + 130 * k, box.y + 400 * k, { steps: 12 });
    await page.mouse.up();
    await expect(page.locator(".multisel")).toHaveCount(2);
    const before = await Promise.all([0, 1].map(async (i) => (await shapes(page).nth(i).boundingBox())!));
    expect(Math.abs(before[0].x - before[1].x)).toBeGreaterThan(20);
    await page.getByRole("button", { name: "Align left" }).click();
    const after = await Promise.all([0, 1].map(async (i) => (await shapes(page).nth(i).boundingBox())!));
    expect(Math.abs(after[0].x - after[1].x), "lefts line up on screen").toBeLessThan(2);
    expect(Math.abs(after[0].y - before[0].y) + Math.abs(after[1].y - before[1].y), "nothing moved up or down").toBeLessThan(2);
  });

  test("a duplicate lands down and to the right, as on any page", async ({ page }) => {
    const f = await fixtures();
    await restoreWith(page, f.sample, { pages: quarter(90), annotations: [rects[0]] as DocState["annotations"] });
    const orig = (await shapes(page).first().boundingBox())!;
    await page.mouse.click(orig.x + orig.width / 2, orig.y + 1);
    await page.keyboard.press("ControlOrMeta+d");
    await expect(shapes(page)).toHaveCount(2);
    const copy = (await shapes(page).nth(1).boundingBox())!;
    expect(copy.x).toBeGreaterThan(orig.x + 5);
    expect(copy.y).toBeGreaterThan(orig.y + 5);
  });

  test("turning a page refits the width, and its thumbnail fits its slot", async ({ page }) => {
    await open(page, (await fixtures()).sample);
    await organise(page, async (org) => {
      await org.locator(".pcard").nth(0).locator('[aria-label="Rotate"]').click();
    });
    const pg = page.locator(".page").first();
    await expect(pg).toHaveAttribute("data-turn", "90");
    const scroller = await page.locator(".viewer__scroll").evaluate((e) => ({ w: e.clientWidth, sw: e.scrollWidth }));
    expect(scroller.sw, "no sideways scroll at fit").toBeLessThanOrEqual(scroller.w + 1);
    await page.getByRole("button", { name: "Show pages" }).click();
    const slot = page.locator(".pagenav__thumb").first();
    await expect(slot.locator("canvas")).toBeVisible({ timeout: 15_000 });
    const s = (await slot.boundingBox())!;
    await expect.poll(async () => {
      const c = (await slot.locator("canvas").boundingBox())!;
      return c.x >= s.x - 1 && c.y >= s.y - 1 && c.x + c.width <= s.x + s.width + 1 && c.y + c.height <= s.y + s.height + 1;
    }).toBe(true);
  });

  test("the tick preview reads upright, as the tick it places does", async ({ page }) => {
    const f = await fixtures();
    await restoreWith(page, f.sample, { pages: quarter(90) });
    await pickSubTool(page, "Tick");
    const box = (await page.locator(".page").first().boundingBox())!;
    await page.mouse.move(box.x + 200, box.y + 200);
    await page.mouse.move(box.x + 210, box.y + 210);
    await expect(page.locator(".markghost g")).toHaveAttribute("transform", /rotate\(270 /);
  });
});

test("markup on a deleted page can't be selected, copied back or counted", async ({ page }) => {
  const f = await fixtures();
  const rect = { id: "a-1", pageIndex: 0, kind: "rect", x: 540, y: 400, width: 40, height: 40, color: "#d00000", strokeWidth: 2 };
  await restoreWith(page, f.sample, { annotations: [rect] as DocState["annotations"] });
  const shape = page.locator('.annot-svg rect[stroke="#d00000"]');
  await pickTool(page, "Select");
  await shape.scrollIntoViewIfNeeded();
  const b = (await shape.boundingBox())!;
  // Clear of the text, in the right margin; the box is filled for hits.
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  await expect(page.locator(".handle").first()).toBeVisible();
  await page.keyboard.press("ControlOrMeta+c");
  await organise(page, async (org) => {
    await org.locator(".pcard").nth(0).locator('[aria-label="Delete page"]').click();
  });
  await expect(page.locator(".page")).toHaveCount(11);
  await page.keyboard.press("ControlOrMeta+v");
  await expect(page.locator(".handle")).toHaveCount(0);
  await expect(shape).toHaveCount(0);
  // One page plan, nothing else: the rectangle won't ship.
  await expect(page.locator(".doctab__dirty")).toHaveCount(1);
  await page.keyboard.press("Control+z");
  await expect(page.locator(".page")).toHaveCount(12);
  await expect(shape).toHaveCount(1);
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
