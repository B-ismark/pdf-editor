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
    await page.locator(".page canvas").first().evaluate((c) => {
      (c as unknown as { __warm: boolean }).__warm = true;
      // And note any repaint: `renderPage` sets the canvas' size first, which
      // blanks it — kept, but painted again, would still flash white.
      const w = window as unknown as { __repaints: number };
      w.__repaints = 0;
      new MutationObserver((rs) => (w.__repaints += rs.length)).observe(c, { attributeFilter: ["width", "height"] });
    });

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
    await page.waitForTimeout(600);
    expect(await page.evaluate(() => (window as unknown as { __repaints: number }).__repaints), "and wasn't painted again").toBe(0);
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

  test("typing before and after a switch is two undo steps", async ({ page }) => {
    const f = await fixtures();
    await open(page, f.long);
    const ov = (await page.locator(".page__overlay").first().boundingBox())!;
    await page.locator('.tooldock__btn[aria-label="Add text"]').click();
    await page.mouse.click(ov.x + 150, ov.y + 150);
    await page.keyboard.type("Hello", { delay: 15 });
    await openMore(page, f.sample);
    await switchTo(page, "long.pdf");
    const box = page.locator(".textbox").first();
    await box.dblclick();
    await page.keyboard.press("End");
    await page.keyboard.type("World", { delay: 15 });
    await expect(box).toHaveText("HelloWorld");
    await page.locator('.icon-btn[aria-label="Undo"]').click();
    await expect(box).toHaveText("Hello");
  });

  test("coming back by keyboard leaves the keys on the tab strip", async ({ page }) => {
    // A text box being typed into when its document went behind took focus
    // (and scrolled to itself) again when it came back: the next arrow moved
    // the caret, not the tab, and Backspace edited the document.
    const f = await fixtures();
    await open(page, f.long);
    const ov = (await page.locator(".page__overlay").first().boundingBox())!;
    await page.locator('.tooldock__btn[aria-label="Add text"]').click();
    await page.mouse.click(ov.x + 150, ov.y + 150);
    await page.keyboard.type("Typing", { delay: 15 });
    await openMore(page, f.sample);
    await activeTab(page).locator(".doctab__btn").focus();
    await page.keyboard.press("ArrowLeft");
    await expect(activeTab(page)).toContainText("long.pdf");
    await page.waitForTimeout(400);
    expect(await page.evaluate(() => document.activeElement?.className)).toContain("doctab__btn");
    await page.keyboard.press("ArrowRight");
    await expect(activeTab(page)).toContainText("sample.pdf");
  });
});

test("on a phone, Back's entries belong to the document in front", async ({ browser }) => {
  // A selection on a phone adds a history entry so Back puts it away. Kept
  // warm behind another document, its entry stayed: Back in front popped it
  // for nothing, and putting the selection away later stepped out of the app.
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  const f = await fixtures();
  await open(page, f.long);
  await page.locator(".fragment").first().tap();
  await expect(page.locator(".selbar")).toBeVisible();
  const layer = () => page.evaluate(() => !!(history.state as { pdfEditorLayer?: boolean } | null)?.pdfEditorLayer);
  await expect.poll(layer).toBe(true);
  // One document on a phone shows no strip: wait for two tabs, not one more.
  await page.setInputFiles("input[data-open-input]", [f.sample]);
  await expect(tabs(page)).toHaveCount(2, { timeout: 30_000 });
  await expect(page.locator(".selbar")).toHaveCount(0);
  await expect.poll(layer, "nothing in front to put away: no entry for it").toBe(false);
  await switchTo(page, "long.pdf");
  await expect(page.locator(".selbar")).toBeVisible();
  await expect.poll(layer, "back with its selection: its entry again").toBe(true);
  await page.goBack();
  await expect(page.locator(".selbar")).toHaveCount(0);
  await expect(page.locator(".page").first(), "Back put the selection away, not the app").toBeVisible();
  await ctx.close();
});
