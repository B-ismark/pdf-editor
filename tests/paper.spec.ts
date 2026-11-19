import { test, expect, type Page } from "@playwright/test";
import { fixtures } from "./fixtures";
import { open, openOrganise, watch } from "./helpers";

/**
 * Thumbnails are white paper, and Organise is quiet until a page is in hand.
 *
 * - One CSS rule, run together with its neighbour, dimmed every thumbnail all
 *   the time (grey paper reads as disabled), and with "Dim pages" on it set the
 *   page canvas to `display: contents` — a canvas so set draws nothing, so the
 *   mode meant to soften the pages blanked them.
 * - Organise put four controls under every page: with 150 pages a field of
 *   icons. They show for the page under the pointer, the picked pages and the
 *   card the keyboard is in; on a touch screen a control nobody can see takes
 *   no tap.
 */

/** The thumbnail canvas' brightest pixel, as drawn on screen (filters included). */
async function paper(page: Page, sel: string) {
  const c = page.locator(sel).first();
  await expect(c).toBeVisible();
  const box = (await c.boundingBox())!;
  // The top-left corner of a page is margin: paper, whatever the page holds.
  const shot = await page.screenshot({ clip: { x: box.x + 3, y: box.y + 3, width: 4, height: 4 } });
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const cv = new OffscreenCanvas(img.width, img.height);
    const ctx = cv.getContext("2d")!;
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, img.width, img.height).data;
    let max = 0;
    for (let i = 0; i < d.length; i += 4) max = Math.max(max, Math.min(d[i], d[i + 1], d[i + 2]));
    return max;
  }, shot.toString("base64"));
}

test("thumbnails are white paper, in the sidebar and in Organise", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  const w = watch(page);
  await open(page, (await fixtures()).sample);
  await page.getByRole("button", { name: "Show pages" }).click();
  expect(await paper(page, ".pagenav .thumb__canvas"), "sidebar thumbnail").toBeGreaterThan(245);
  await page.getByRole("button", { name: "Grid view" }).click();
  expect(await paper(page, ".organize .thumb__canvas"), "Organise thumbnail").toBeGreaterThan(245);
  expect(w.errors).toEqual([]);
});

test("Dim pages softens the pages and still shows them", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.addInitScript(() => localStorage.setItem("pref.dimPages", "1"));
  await open(page, (await fixtures()).sample);
  await expect(page.locator(".app--dim")).toHaveCount(1);
  const canvas = page.locator(".page__canvas").first();
  await expect(canvas, "the page is drawn").toBeVisible();
  const box = (await canvas.boundingBox())!;
  expect(box.height).toBeGreaterThan(200);
  const v = await paper(page, ".page__canvas");
  expect(v, "softer than white").toBeLessThan(235);
  expect(v, "but paper, not a hole").toBeGreaterThan(150);
  // The thumbnails soften with it.
  await page.getByRole("button", { name: "Show pages" }).click();
  expect(await paper(page, ".pagenav .thumb__canvas")).toBeLessThan(235);
});

test("Organise shows a page's controls when it is in hand, and keeps every number", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await open(page, (await fixtures()).sample);
  await openOrganise(page);
  const org = page.locator(".organize");
  const cards = org.locator(".pcard");
  await expect(cards.first()).toBeVisible();
  await page.mouse.move(2, 2);
  const shown = (i: number) =>
    cards.nth(i).locator(".pcard__actions").evaluate((el) => {
      const cs = getComputedStyle(el);
      return cs.visibility !== "hidden" && parseFloat(cs.opacity) > 0.5;
    });
  await expect.poll(() => shown(1), "at rest, no controls").toBe(false);
  await expect(cards.nth(1).locator(".pcard__no")).toBeVisible();
  await expect(cards.nth(1).locator(".pcard__no")).toHaveText("2");

  // Under the pointer.
  const before = (await cards.nth(1).boundingBox())!;
  await cards.nth(1).hover();
  await expect.poll(() => shown(1)).toBe(true);
  expect(await shown(2)).toBe(false);
  // Nothing moved as they came.
  const after = (await cards.nth(1).boundingBox())!;
  expect(after.height).toBe(before.height);

  // Picked: stays shown after the pointer leaves.
  await cards.nth(3).locator(".pcard__thumb").click();
  await page.mouse.move(2, 2);
  await expect.poll(() => shown(3)).toBe(true);
  await expect.poll(() => shown(1)).toBe(false);
  // The pick mark is a tick, not a plus.
  await expect(cards.nth(3).locator(".pcard__check svg")).toHaveCount(1);

  // The keyboard: tabbing into a card shows its controls, and reaches them.
  await cards.nth(5).locator(".pcard__thumb").focus();
  await expect.poll(() => shown(5)).toBe(true);
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("Rotate");
  await expect.poll(() => shown(5)).toBe(true);
});

test("on a touch screen, an unpicked page's hidden controls take no tap", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  await open(page, (await fixtures()).sample);
  await openOrganise(page);
  const cards = page.locator(".organize .pcard");
  await expect(cards.first()).toBeVisible();
  // Hidden from everyone until the card is picked, assistive tech included.
  const rotate = cards.nth(1).getByRole("button", { name: "Rotate", includeHidden: true });
  expect(await rotate.evaluate((el) => getComputedStyle(el).visibility)).toBe("hidden");
  // Pick it: its controls appear and work.
  await cards.nth(1).locator(".pcard__thumb").tap();
  await expect(rotate).toBeVisible();
  await rotate.tap();
  await expect(cards.nth(1).locator(".thumb__frame")).toHaveAttribute("style", /rotate\(90deg\)/);
  await ctx.close();
});
