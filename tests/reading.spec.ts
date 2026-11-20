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

/** Zoom in one step: the pill's button, or on a phone (no pill, 11a) ⋯ → View. */
async function zoomIn(page: Page) {
  const btn = page.locator('.zoombar .icon-btn[aria-label="Zoom in"]');
  if (await btn.count()) return btn.click();
  await page.locator(".appbar__more").click();
  await page.locator('.menu__list:not(.is-leaving) [role^="menuitem"]', { hasText: "Zoom in" }).click();
  await expect(page.locator(".menu__list:not(.is-leaving)")).toHaveCount(0);
}

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
    await expect(page.locator(".snackbar__msg")).toHaveText("Opened a 150-page document.");
    const top = await openingLines(page);
    // A phone has no zoom pill (11a): pinch zooms, and the corner is the page's.
    await expect(page.locator(".zoombar")).toHaveCount(mobile ? 0 : 1);
    const floating = mobile ? [".snackbar", ".tooldock"] : [".zoombar", ".snackbar", ".tooldock"];
    for (const sel of floating) {
      const r = await rect(page, sel);
      expect(overlaps(top, r), `${sel} ${JSON.stringify(r)} over the page's top ${JSON.stringify(top)}`).toBe(false);
    }
    // And they are clear of each other.
    const d = await rect(page, ".tooldock");
    const s = await rect(page, ".snackbar");
    expect(overlaps(s, d), "toast vs dock").toBe(false);
    if (!mobile) {
      const z = await rect(page, ".zoombar");
      expect(overlaps(z, d), "zoom pill vs dock").toBe(false);
      expect(overlaps(s, z), "toast vs zoom pill").toBe(false);
    }
    expect(w.errors).toEqual([]);
    await ctx.close();
  });
}

test("on a phone, the opening toast stays off an open draw bar", async ({ browser }) => {
  // Bottom-anchored on phones, the toast sat on the draw bar's first row: the
  // phone's bar is two rows tall.
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  await open(page, (await fixtures()).sample);
  await page.locator('.tooldock__btn[aria-label="Draw"]').tap();
  await expect(page.locator(".drawbar:not(.drawbar--closed)")).toBeVisible();
  await expect(page.locator(".snackbar")).toBeVisible();
  const s = await rect(page, ".snackbar");
  const d = await rect(page, ".drawbar");
  expect(overlaps(s, d), `toast ${JSON.stringify(s)} vs draw bar ${JSON.stringify(d)}`).toBe(false);
  await ctx.close();
});

test("on a wide window, the toast stays off the Pages sidebar", async ({ page }) => {
  // Fixed to the window's bottom-left, it covered the sidebar's last
  // thumbnail — and a busy toast (with Cancel) takes clicks.
  await page.setViewportSize({ width: 1440, height: 900 });
  const f = await fixtures();
  await open(page, f.long);
  await page.locator('[aria-label="Show pages"]').first().click();
  await expect(page.locator(".pagenav")).toBeVisible();
  await page.setInputFiles("input[data-open-input]", f.sample);
  await expect(page.locator(".snackbar__msg")).toHaveText("Opened a 12-page document.");
  const s = await rect(page, ".snackbar");
  for (const sel of [".pagenav", ".tooldock", ".zoombar"]) {
    const r = await rect(page, sel);
    expect(overlaps(s, r), `toast ${JSON.stringify(s)} vs ${sel} ${JSON.stringify(r)}`).toBe(false);
  }
});

test("zoomed in, a panel opening and closing leaves the view where it was across", async ({ page }) => {
  // The browser clamps the sideways scroll as the room narrows before the
  // refit sees it, so the refit anchored to the clamped place: open and close
  // Pages and the view had drifted left.
  await page.setViewportSize({ width: 1024, height: 768 });
  await open(page, (await fixtures()).long);
  const scroller = page.locator(".viewer__scroll");
  await page.locator('.icon-btn[aria-label="Zoom in"]').click();
  await page.locator('.icon-btn[aria-label="Zoom in"]').click();
  await expect.poll(() => scroller.evaluate((el) => el.scrollWidth > el.clientWidth + 100)).toBe(true);
  // Most of the way across, where a narrower room would have to clamp.
  await scroller.evaluate((el) => (el.scrollLeft = el.scrollWidth - el.clientWidth - 10));
  await page.waitForTimeout(200);
  const across = () => scroller.evaluate((el) => (el.scrollLeft + el.clientWidth / 2) / el.scrollWidth);
  const before = await across();
  await page.locator('[aria-label="Show pages"]').first().click();
  await expect(page.locator(".pagenav")).toBeVisible();
  await page.waitForTimeout(300);
  await page.locator('[aria-label="Hide pages"]').first().click();
  await expect(page.locator(".pagenav")).toHaveCount(0);
  await page.waitForTimeout(300);
  expect(Math.abs((await across()) - before), `across ${before} → ${await across()}`).toBeLessThan(0.02);
});

test("on the narrowest phones, the toast stays off a three-row draw bar", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 320, height: 740 }, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  await open(page, (await fixtures()).sample);
  await page.locator('.tooldock__btn[aria-label="Draw"]').tap();
  await expect(page.locator(".drawbar:not(.drawbar--closed)")).toBeVisible();
  await expect(page.locator(".snackbar")).toBeVisible();
  const s = await rect(page, ".snackbar");
  const d = await rect(page, ".drawbar");
  expect(overlaps(s, d), `toast ${JSON.stringify(s)} vs draw bar ${JSON.stringify(d)}`).toBe(false);
  await ctx.close();
});

test("back from another tab, a resize anchors to where the view is now, not before", async ({ page }) => {
  // A document kept warm behind another comes back scrolled to its start,
  // with no scroll event to say so: the sideways anchor was the old one.
  await page.setViewportSize({ width: 1024, height: 768 });
  const f = await fixtures();
  await open(page, f.sample);
  const scroller = page.locator(".viewer__scroll");
  for (let i = 0; i < 4; i++) await page.locator('.icon-btn[aria-label="Zoom in"]').click();
  await expect.poll(() => scroller.evaluate((el) => el.scrollWidth > el.clientWidth + 200)).toBe(true);
  await scroller.evaluate((el) => {
    el.scrollLeft = el.scrollWidth;
    el.scrollTop = 0;
  });
  await page.waitForTimeout(200);
  await page.setInputFiles("input[data-open-input]", f.long);
  await expect(page.locator(".doctab")).toHaveCount(2, { timeout: 30_000 });
  await page.locator(".doctab").first().locator(".doctab__btn").click();
  await page.waitForTimeout(400);
  const across = () => scroller.evaluate((el) => el.scrollLeft / el.scrollWidth);
  const now = await across();
  await page.setViewportSize({ width: 760, height: 768 });
  await page.waitForTimeout(400);
  expect(Math.abs((await across()) - now), `across ${now} → ${await across()}`).toBeLessThan(0.02);
});

for (const [name, size, mobile, grow] of [
  ["a panel closing", { width: 1024, height: 768 }, false, "pages"],
  ["a phone turned on its side", { width: 390, height: 844 }, true, "rotate"],
] as const) {
  test(`zoomed in, more room from ${name} keeps the view across`, async ({ browser }) => {
    // Given more room than the zoomed page needs, the scroll width reads the
    // room, not the page: the check that the content hadn't changed failed,
    // and the view went back to the left edge.
    const ctx = await browser.newContext({ viewport: size, ...(mobile ? { hasTouch: true, isMobile: true } : {}) });
    const page = await ctx.newPage();
    await open(page, (await fixtures()).long);
    const scroller = page.locator(".viewer__scroll");
    if (grow === "pages") {
      await page.locator('[aria-label="Show pages"]').first().click();
      await expect(page.locator(".pagenav")).toBeVisible();
    }
    await zoomIn(page);
    await expect.poll(() => scroller.evaluate((el) => el.scrollWidth > el.clientWidth + 20)).toBe(true);
    await scroller.evaluate((el) => (el.scrollLeft = el.scrollWidth));
    await page.waitForTimeout(200);
    // Where the view's left edge is across the document: what a refit keeps.
    const across = () => scroller.evaluate((el) => el.scrollLeft / el.scrollWidth);
    const before = await across();
    if (grow === "pages") await page.locator('[aria-label="Hide pages"]').first().click();
    else await page.setViewportSize({ width: 844, height: 390 });
    await page.waitForTimeout(400);
    expect(await scroller.evaluate((el) => el.scrollLeft), "not back at the left edge").toBeGreaterThan(20);
    expect(Math.abs((await across()) - before), `across ${before} → ${await across()}`).toBeLessThan(0.03);
    await ctx.close();
  });
}

for (const [name, size, mobile, to] of [
  ["a phone turned on its side", { width: 390, height: 844 }, true, { width: 844, height: 390 }],
  ["a window widened past 840px", { width: 700, height: 800 }, false, { width: 1000, height: 800 }],
  ["a window widened a long way", { width: 700, height: 800 }, false, { width: 1400, height: 800 }],
] as const) {
  test(`zoomed well in, ${name} keeps the view across`, async ({ browser }) => {
    // The margin round the pages steps up at 840px, so the scroll width moved
    // with the room; a check that the content hadn't changed read that as a
    // change and threw the place away: the view went to the left edge.
    const ctx = await browser.newContext({ viewport: size, ...(mobile ? { hasTouch: true, isMobile: true } : {}) });
    const page = await ctx.newPage();
    await open(page, (await fixtures()).long);
    const scroller = page.locator(".viewer__scroll");
    for (let i = 0; i < 3; i++) await zoomIn(page);
    await expect.poll(() => scroller.evaluate((el) => el.scrollWidth > el.clientWidth * 1.5)).toBe(true);
    await scroller.evaluate((el) => (el.scrollLeft = (el.scrollWidth - el.clientWidth) / 2));
    await page.waitForTimeout(200);
    const across = () => scroller.evaluate((el) => el.scrollLeft / el.scrollWidth);
    const before = await across();
    await page.setViewportSize(to);
    await page.waitForTimeout(400);
    expect(Math.abs((await across()) - before), `across ${before} → ${await across()}`).toBeLessThan(0.02);
    await ctx.close();
  });
}
