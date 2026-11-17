import { test, expect, type Page } from "@playwright/test";
import { PDFDocument } from "pdf-lib";
import { readFileSync } from "node:fs";
import { fixtures } from "./fixtures";
import { open, watch, pickTool, pageTexts, expectClean } from "./helpers";

/**
 * The Pages sidebar is where page work happens: move, turn and delete pages
 * right next to the document, live, each one an undoable edit that keeps the
 * markup on its page. Before, the rail could only jump, and every change to the
 * pages meant a trip to the full-screen Organise grid.
 */

const heading = (n: number) => new RegExp(`Page ${n}(?!\\d)`);
const rows = (page: Page) => page.locator(".pagenav__item");
const row = (page: Page, pos: number) => rows(page).nth(pos);
/** Source page indices in the order the viewer shows them. */
const order = (page: Page) =>
  page.locator(".page").evaluateAll((els) => els.map((el) => Number((el as HTMLElement).dataset.pageIndex)));

async function download(page: Page): Promise<Buffer> {
  const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 120_000 }), page.click(".appbar__download")]);
  return readFileSync((await dl.path())!);
}

async function showPages(page: Page) {
  await page.getByRole("button", { name: "Show pages" }).click();
  await expect(rows(page)).toHaveCount(12);
}

test.beforeEach(async ({ page }, info) => {
  if (!info.titlePath.includes("on a phone")) await page.setViewportSize({ width: 1280, height: 860 });
});

test("pages move, turn and delete from the sidebar, live and undoable, and the file follows", async ({ page }) => {
  const w = watch(page);
  await open(page, (await fixtures()).sample);
  await pickTool(page, "Add text");
  const p1 = (await page.locator(".page").first().boundingBox())!;
  await page.mouse.click(p1.x + 120, p1.y + 140);
  await page.keyboard.type("Stays with page one");
  await pickTool(page, "Select");
  await page.keyboard.press("Escape");
  await showPages(page);

  // Alt+↓ moves the picked page down one; focus stays on it.
  await row(page, 0).click();
  await expect(row(page, 0)).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Alt+ArrowDown");
  await expect.poll(() => order(page)).toEqual([1, 0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  await expect(page.locator('.page[data-page-pos="1"] .textbox')).toHaveCount(1);
  await expect(page.locator(".pagenav__item:focus")).toHaveAttribute("aria-label", /^Page 2 of 12/);
  await expect(page.locator(".snackbar")).toContainText("Moved page 1 to position 2");

  // Turn the third page.
  await row(page, 2).click();
  await page.getByRole("button", { name: "Rotate selected pages" }).click();
  await expect(page.locator('.page[data-page-pos="2"]')).toHaveAttribute("data-turn", "90");

  // Delete the fourth from the keyboard.
  await row(page, 3).click();
  await page.keyboard.press("Delete");
  await expect(page.locator(".page")).toHaveCount(11);
  await expect(rows(page)).toHaveCount(11);
  // Focus lands on the page that took its place, so Delete can go again.
  await expect(page.locator(".pagenav__item:focus")).toHaveAttribute("aria-label", /^Page 4 of 11/);

  const bytes = await download(page);
  const doc = await PDFDocument.load(bytes);
  expect(doc.getPageCount()).toBe(11);
  const texts = await pageTexts(bytes, [1, 2, 3, 4]);
  expect(texts[0]).toMatch(heading(2));
  expect(texts[1]).toMatch(heading(1));
  expect(texts[1], "the text box went with its page").toContain("Stays with page one");
  expect(texts[2]).toMatch(heading(3));
  expect(texts[3], "page 4 was deleted").toMatch(heading(5));
  expect(doc.getPage(2).getRotation().angle).toBe(90);

  // Three edits, three undos: the delete, the turn, the move.
  await page.keyboard.press("Control+z");
  await expect(page.locator(".page")).toHaveCount(12);
  await page.keyboard.press("Control+z");
  await expect(page.locator('.page[data-page-pos="2"]')).not.toHaveAttribute("data-turn", "90");
  await page.keyboard.press("Control+z");
  await expect.poll(() => order(page)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  // Page 1 is off screen by now, and off-screen pages don't mount their markup.
  await page.locator(".viewer__scroll").evaluate((el) => (el.scrollTop = 0));
  await expect(page.locator('.page[data-page-pos="0"] .textbox')).toHaveCount(1);
  expectClean(w);
});

test("a page dragged to a new place lands in the gap the bar showed", async ({ page }) => {
  await open(page, (await fixtures()).sample);
  await showPages(page);
  const from = (await row(page, 0).boundingBox())!;
  const to = (await row(page, 2).boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  // Into the lower half of the third row: the gap after it.
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2 + ((to.y + to.height * 0.8 - from.y - from.height / 2) * i) / 8);
  }
  await expect(row(page, 0)).toHaveClass(/pagenav__item--lifted/);
  await expect(row(page, 3)).toHaveClass(/pagenav__item--drop/);
  await page.mouse.up();
  await expect.poll(() => order(page)).toEqual([1, 2, 0, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  await expect(page.locator(".pagenav__item--lifted")).toHaveCount(0);
  // A drag is not a click: nothing was picked, the view didn't jump.
  await expect(page.locator('.pagenav__item[aria-selected="true"]')).toHaveCount(0);

  // The whole selection travels together, in its order.
  await row(page, 4).click();
  await row(page, 6).click({ modifiers: ["Control"] });
  const a = (await row(page, 6).boundingBox())!;
  const b = (await row(page, 0).boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) {
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2 + ((b.y + 4 - a.y - a.height / 2) * i) / 10);
  }
  await page.mouse.up();
  await expect.poll(() => order(page)).toEqual([4, 6, 1, 2, 0, 3, 5, 7, 8, 9, 10, 11]);
});

test("Shift picks a run, and a document always keeps one page", async ({ page }) => {
  await open(page, (await fixtures()).sample);
  await showPages(page);
  await row(page, 1).click();
  await row(page, 4).click({ modifiers: ["Shift"] });
  await expect(page.locator('.pagenav__item[aria-selected="true"]')).toHaveCount(4);
  await expect(page.locator(".pagenav__picked")).toHaveText(/^4\s*4 pages selected$/);
  await page.getByRole("button", { name: "Delete selected pages" }).click();
  await expect(page.locator(".page")).toHaveCount(8);
  await expect(page.locator(".snackbar")).toContainText("Deleted 4 pages");

  // Every page picked: Delete is off, and the key does nothing either.
  await row(page, 0).click();
  await page.keyboard.press("Control+a");
  await expect(page.locator('.pagenav__item[aria-selected="true"]')).toHaveCount(8);
  await expect(page.getByRole("button", { name: "Delete selected pages" })).toBeDisabled();
  await page.keyboard.press("Delete");
  await expect(page.locator(".page")).toHaveCount(8);
  // Ctrl+A in the sidebar picked pages, not every object on the canvas.
  await expect(page.locator(".multibar")).toHaveCount(0);

  // Escape lets go of the selection before it does anything else.
  await page.keyboard.press("Escape");
  await expect(page.locator('.pagenav__item[aria-selected="true"]')).toHaveCount(0);
});

test("the grid view opens from the sidebar", async ({ page }) => {
  await open(page, (await fixtures()).sample);
  await showPages(page);
  await page.getByRole("button", { name: "Grid view" }).click();
  await expect(page.locator(".organize")).toBeVisible();
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("a tap goes to the page; press and hold picks it", async ({ page }) => {
    await open(page, (await fixtures()).sample);
    await page.getByRole("button", { name: "Show pages" }).click();
    await expect(rows(page)).toHaveCount(12);
    // The sidebar slides in: measure the row once it has stopped moving.
    await row(page, 1).tap({ trial: true });
    const r = (await row(page, 1).boundingBox())!;
    const cdp = await page.context().newCDPSession(page);
    const point = [{ x: r.x + r.width / 2, y: r.y + r.height / 2 }];
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: point });
    await page.waitForTimeout(600);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect(row(page, 1)).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(".pagenav")).toBeVisible();
    // With a page picked, a tap picks more instead of leaving.
    await row(page, 3).tap();
    await expect(page.locator('.pagenav__item[aria-selected="true"]')).toHaveCount(2);
    await page.getByRole("button", { name: "Delete selected pages" }).tap();
    await expect(page.locator(".page")).toHaveCount(10);
    // Nothing picked: a tap is "take me there".
    await row(page, 5).tap();
    await expect(page.locator(".pagenav")).toHaveCount(0);
  });
});
