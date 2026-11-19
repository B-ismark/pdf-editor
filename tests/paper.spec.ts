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
 *   icons. With a mouse they show for the page under the pointer, the picked
 *   pages and the card the keyboard is in, and the keyboard stays with a page
 *   it moves. Wherever touch may be used they stay in view: hidden, a touch
 *   laptop's tap still hit them, and a phone lost them after every move.
 * - In Dim mode an edit dims with its page.
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
  // An edit dims with its page: its cover was sampled from the undimmed paper
  // and sat on the page as a white sticker that isn't in the file.
  const frag = page.locator(".fragment").nth(3);
  await frag.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("An edited line, long enough to have paper around its words");
  await page.keyboard.press("Escape");
  await expect(frag).toContainText("An edited line");
  const cover = await paper(page, `.fragment >> nth=3`);
  expect(Math.abs(cover - v), `edit's paper ${cover}, page's ${v}`).toBeLessThan(8);
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
  await expect(cards.nth(3).locator(".pcard__check svg.lucide-check")).toHaveCount(1);
  // The page button says which page it is.
  await expect(cards.nth(3).getByRole("button", { name: "Page 4" })).toHaveAttribute("aria-pressed", "true");

  // The keyboard: tabbing into a card shows its controls, and reaches them.
  await cards.nth(5).locator(".pcard__thumb").focus();
  await expect.poll(() => shown(5)).toBe(true);
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("Rotate");
  await expect.poll(() => shown(5)).toBe(true);

  // Backwards too: Shift+Tab from a card's page lands on the controls of the
  // card before it, not on its page button.
  await cards.nth(6).locator(".pcard__thumb").focus();
  await page.keyboard.press("Shift+Tab");
  expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("Move later");
  await expect.poll(() => shown(5)).toBe(true);
});

test("after a move or a delete, the keyboard stays with the page", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await open(page, (await fixtures()).sample);
  await openOrganise(page);
  const cards = page.locator(".organize .pcard");
  await expect(cards.first()).toBeVisible();
  const focused = () => page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    const card = el?.closest(".pcard");
    return { label: el?.getAttribute("aria-label"), at: card ? [...card.parentElement!.children].indexOf(card) : -1 };
  });
  await cards.nth(1).getByRole("button", { name: "Move later" }).focus();
  await page.keyboard.press("Enter");
  expect(await focused()).toEqual({ label: "Move later", at: 2 });
  await page.keyboard.press("Enter");
  expect(await focused()).toEqual({ label: "Move later", at: 3 });
  await expect(cards.nth(3).locator(".pcard__no")).toHaveText("4");
  // Its controls stay in view while the keyboard is there.
  await expect.poll(() => cards.nth(3).locator(".pcard__actions").evaluate((el) => getComputedStyle(el).opacity)).toBe("1");

  await cards.nth(3).getByRole("button", { name: "Delete page" }).focus();
  await page.keyboard.press("Enter");
  await expect(cards).toHaveCount(11);
  expect(await focused()).toEqual({ label: "Page 4", at: 3 });
});

test("wherever a finger may be used, every page's controls are in view", async ({ browser }) => {
  // A phone, and a touch laptop: it hovers like a desktop, but a tap on an
  // invisible Delete still deleted the page.
  for (const opts of [
    { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true },
    { viewport: { width: 1280, height: 860 }, hasTouch: true },
  ]) {
    const ctx = await browser.newContext(opts);
    const page = await ctx.newPage();
    await open(page, (await fixtures()).sample);
    expect(await page.evaluate(() => matchMedia("(any-pointer: coarse)").matches), "a touch screen").toBe(true);
    await openOrganise(page);
    const cards = page.locator(".organize .pcard");
    await expect(cards.first()).toBeVisible();
    const actions = cards.nth(1).locator(".pcard__actions");
    expect(await actions.evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
    await expect(actions.getByRole("button", { name: "Rotate" })).toBeVisible();
    // And they stay after a move: a page moved three places is three taps.
    await actions.getByRole("button", { name: "Move later" }).tap();
    await expect(cards.nth(2).locator(".pcard__actions").getByRole("button", { name: "Move later" })).toBeVisible();
    expect(await cards.nth(2).locator(".pcard__actions").evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
    await ctx.close();
  }
});
