import { test, expect, type Page } from "@playwright/test";
import { fixtures } from "./fixtures";
import { open, watch } from "./helpers";

/**
 * The document before the one in front stays warm.
 *
 * A switch used to mount a fresh editor for the document coming forward:
 * every page painted again from nothing, the text re-read, the fit measured —
 * 150 ms or so of blank pages for a file you were looking at a moment ago. Now
 * the last document stays mounted behind the one in front (React's
 * `<Activity>`), held off the page, and a switch back shows it as it was left.
 *
 * What has to hold, beyond "it's quicker": it really is the same pages, not
 * repainted ones; the one behind is nowhere in the page, so nothing can find
 * or press its controls; nothing it listened for (keys) still reaches it; and
 * a window resized while it waited fits it when it returns.
 */

const tabs = (page: Page) => page.locator(".doctab");
const activeTab = (page: Page) => page.locator(".doctab--active");

async function openMore(page: Page, ...files: string[]) {
  const before = await tabs(page).count();
  await page.setInputFiles("input[data-open-input]", files);
  await expect(tabs(page)).toHaveCount(before + files.length, { timeout: 30_000 });
  await page.waitForSelector(".page canvas");
}

async function switchTo(page: Page, name: string) {
  await tabs(page).filter({ hasText: name }).locator(".doctab__btn").click();
  await expect(activeTab(page)).toContainText(name);
}

async function addText(page: Page, text: string) {
  const ov = (await page.locator(".page__overlay").first().boundingBox())!;
  await page.locator('.tooldock__btn[aria-label="Add text"]').click();
  await page.mouse.click(ov.x + 150, ov.y + 150);
  await page.keyboard.type(text, { delay: 15 });
  await page.locator('.tooldock__btn[aria-label="Select"]').click();
}

test.describe("the last document stays warm", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 820 });
  });

  test("switching back shows the same pages, with their undo, not a rebuild", async ({ page }) => {
    const w = watch(page);
    const f = await fixtures();
    await open(page, f.long);
    await addText(page, "KEPT-WARM");
    // Mark the first page's painted canvas: a rebuilt editor paints a new one.
    await page.locator(".page canvas").first().evaluate((c) => ((c as unknown as { __warm: boolean }).__warm = true));

    await openMore(page, f.sample);
    // Held off the page, not just hidden: one editor's worth of everything.
    await expect(page.locator(".doctabs")).toHaveCount(1);
    await expect(page.locator(".textbox", { hasText: "KEPT-WARM" })).toHaveCount(0);
    expect(
      await page.evaluate(() => [...document.querySelectorAll("canvas")].some((c) => (c as unknown as { __warm?: boolean }).__warm)),
      "the warm document's pages are not in the page",
    ).toBe(false);

    await switchTo(page, "long.pdf");
    expect(
      await page.locator(".page canvas").first().evaluate((c) => (c as unknown as { __warm?: boolean }).__warm === true),
      "the same canvas came back",
    ).toBe(true);
    await expect(page.locator(".textbox", { hasText: "KEPT-WARM" })).toHaveCount(1);
    const undo = page.locator('.icon-btn[aria-label="Undo"]');
    await expect(undo).toBeEnabled();
    await undo.click();
    await expect(page.locator(".textbox", { hasText: "KEPT-WARM" })).toHaveCount(0);
    expect(w.errors).toEqual([]);
  });

  test("keys reach only the document in front", async ({ page }) => {
    const f = await fixtures();
    await open(page, f.long);
    await addText(page, "BEHIND");
    await openMore(page, f.sample);
    await page.locator(".viewer__scroll").click({ position: { x: 5, y: 5 } });
    // The one behind has an undo to take; the one in front has none.
    await page.keyboard.press("Control+z");
    await page.keyboard.press("Control+z");
    await switchTo(page, "long.pdf");
    await expect(page.locator(".textbox", { hasText: "BEHIND" })).toHaveCount(1);
  });

  test("a window resized while a document waited fits it when it returns", async ({ page }) => {
    const f = await fixtures();
    await open(page, f.sample);
    await openMore(page, f.sample);
    await tabs(page).first().locator(".doctab__btn").click();
    await page.waitForTimeout(300);
    const width = () => page.locator(".page").first().evaluate((el) => el.getBoundingClientRect().width);
    const before = await width();
    await page.setViewportSize({ width: 1000, height: 820 });
    await expect.poll(width).toBeLessThan(before - 50);
    const fitted = await width();

    // The second, behind all this time, comes back fitted to the window it is
    // in now, as the first is — not at the width it had before.
    await tabs(page).last().locator(".doctab__btn").click();
    await page.waitForTimeout(300);
    expect(Math.abs((await width()) - fitted)).toBeLessThan(1);
  });
});
