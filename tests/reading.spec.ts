import { test, expect, type Page } from "@playwright/test";
import { fixtures } from "./fixtures";
import { open, watch } from "./helpers";

/**
 * A page at a reading width, with room around it.
 *
 * The fit used to stretch a page to the window, capped at 1100px: an A4 page
 * was 1052px wide at 1440, and the zoom pill sat on its top-right corner, over
 * the document's title. Opening the Pages sidebar narrowed the room without
 * refitting, so the page ran under the Inspector, its right edge out of reach.
 * And the first thing a file said on opening was "150 pages · 3750 text
 * fragments", over the page.
 *
 * Now a page fits the room it has but is never fitted larger than its printed
 * size (`ACTUAL_SIZE`, one point = 4/3 px); the fit follows the room as panels
 * open and close; the first page's opening lines are clear of every floating
 * control; and the opening message is plain.
 */

const A4_WIDTH_PX = (595 * 96) / 72;

const rect = (page: Page, sel: string) =>
  page.locator(sel).first().evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });

type R = { x: number; y: number; w: number; h: number };
const overlaps = (a: R, b: R) => !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);

/** The first page's top — its title and opening lines — as it opens. */
async function openingLines(page: Page): Promise<R> {
  const p = await rect(page, ".page");
  return { ...p, h: Math.min(p.h, 320) };
}

test("on a wide window a page sits at its printed size, centred", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const w = watch(page);
  await open(page, (await fixtures()).long);
  const p = await rect(page, ".page");
  const v = await page.locator(".viewer__scroll").evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, w: el.clientWidth };
  });
  expect(Math.abs(p.w - A4_WIDTH_PX), `page ${p.w}px, printed size ${A4_WIDTH_PX}px`).toBeLessThan(2);
  const left = p.x - v.x;
  const right = v.x + v.w - (p.x + p.w);
  expect(left, "room on the left").toBeGreaterThan(100);
  expect(Math.abs(left - right), `margins ${left} / ${right}`).toBeLessThan(2);
  expect(w.errors).toEqual([]);
});

test("opening the Pages sidebar refits a page that would run under the panel", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  const w = watch(page);
  await open(page, (await fixtures()).long);
  const scroller = page.locator(".viewer__scroll");
  // Read on to page 5, then open the sidebar.
  await scroller.evaluate((el) => (el.scrollTop = el.scrollHeight * (4.2 / 150)));
  await expect(page.locator(".zoombar__page")).toHaveText("5 / 150");
  const before = await rect(page, ".page");
  await page.locator('[aria-label="Show pages"]').first().click();
  await expect(page.locator(".pagenav")).toBeVisible();

  const v = await scroller.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, w: el.clientWidth };
  });
  await expect
    .poll(async () => {
      const p = await rect(page, ".page");
      return p.x + p.w <= v.x + v.w && p.x >= v.x;
    }, "the whole width of the page is inside the viewer")
    .toBe(true);
  expect((await rect(page, ".page")).w).toBeLessThan(before.w);
  // The reader is still where they were.
  await expect(page.locator(".zoombar__page")).toHaveText("5 / 150");
  expect(await scroller.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), "no sideways scroll at fit").toBe(true);

  // Closing it gives the room back.
  await page.locator('[aria-label="Hide pages"]').first().click();
  await expect.poll(async () => Math.round((await rect(page, ".page")).w)).toBe(Math.round(before.w));
  await expect(page.locator(".zoombar__page")).toHaveText("5 / 150");
  expect(w.errors).toEqual([]);
});

for (const [name, size, mobile] of [
  ["a wide window", { width: 1440, height: 900 }, false],
  ["a laptop window", { width: 1024, height: 768 }, false],
  ["a phone", { width: 390, height: 844 }, true],
] as const) {
  test(`on ${name}, the first page's opening lines are clear of every floating control`, async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: size, ...(mobile ? { hasTouch: true, isMobile: true } : {}) });
    const page = await ctx.newPage();
    const w = watch(page);
    await open(page, (await fixtures()).long);
    await expect(page.locator(".snackbar__msg")).toHaveText("Opened · 150 pages");
    const top = await openingLines(page);
    for (const sel of [".zoombar", ".snackbar", ".tooldock"]) {
      const r = await rect(page, sel);
      expect(overlaps(top, r), `${sel} ${JSON.stringify(r)} over the page's top ${JSON.stringify(top)}`).toBe(false);
    }
    // And they are clear of each other.
    const z = await rect(page, ".zoombar");
    const d = await rect(page, ".tooldock");
    const s = await rect(page, ".snackbar");
    expect(overlaps(z, d), "zoom pill vs dock").toBe(false);
    expect(overlaps(s, d), "toast vs dock").toBe(false);
    expect(overlaps(s, z), "toast vs zoom pill").toBe(false);
    expect(w.errors).toEqual([]);
    await ctx.close();
  });
}
