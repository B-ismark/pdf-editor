import { test, expect, type Page } from "@playwright/test";
import { fixtures } from "./fixtures";
import { open, watch, expectClean } from "./helpers";

/**
 * The app shell — app bar, page rail, Inspector, overflow menu.
 *
 * Each assertion here is a defect that type-checking and the feature specs both
 * passed straight over, because every one of them was a *geometry* or *identity*
 * problem rather than a broken function call: a button that still worked at 15px
 * wide, a menu whose last group was painted past the bottom of the window, a
 * panel that swapped its contents without saying so.
 */

/** Widths and content-widths of the app bar's children. */
function barMetrics(page: Page) {
  return page.evaluate(() => {
    const bar = document.querySelector<HTMLElement>(".appbar")!;
    const dl = document.querySelector<HTMLElement>(".appbar__download")!;
    return {
      width: bar.getBoundingClientRect().width,
      scrollWidth: bar.scrollWidth,
      download: dl.getBoundingClientRect().width,
      downloadHeight: dl.getBoundingClientRect().height,
      /** The right edge of the last visible control. */
      lastRight: Math.max(
        ...[...bar.querySelectorAll<HTMLElement>("button")].map(
          (b) => b.getBoundingClientRect().right,
        ),
      ),
    };
  });
}

test.describe("app bar", () => {
  // 360px is the narrowest mainstream phone; every control has to fit inside it,
  // because the row's only shrinkable member was the primary action and *all* of
  // the overflow came out of it — Download collapsed to a 15px sliver of a pill,
  // still clickable, no longer readable as a button, and far under any touch
  // minimum. `flex: none` alone would just have clipped the overflow menu
  // instead, so the fix was to size the row to its contents (the theme control
  // moved into that menu, where the other preferences already live).
  for (const width of [360, 390, 430]) {
    test(`fits its controls at ${width}px, primary action at full size`, async ({ browser }) => {
      const ctx = await browser.newContext({
        viewport: { width, height: 780 },
        isMobile: true,
        hasTouch: true,
      });
      const page = await ctx.newPage();
      await open(page, (await fixtures()).sample);

      const m = await barMetrics(page);
      expect(m.scrollWidth, "the app bar overflows its own width").toBeLessThanOrEqual(m.width);
      expect(m.lastRight, "a control is pushed off the right edge").toBeLessThanOrEqual(m.width);
      // 44px is the floor the rest of this UI is built to (Apple 44pt).
      expect(m.download, "the Download button is crushed").toBeGreaterThanOrEqual(44);
      expect(m.downloadHeight).toBeGreaterThanOrEqual(44);
      await ctx.close();
    });
  }

  test("the page-rail toggle says what it will do", async ({ page }) => {
    await open(page, (await fixtures()).sample);
    // Named by outcome, not "Toggle page thumbnails" — and the name changes with
    // the state, so it never describes the opposite of what will happen. Its
    // tooltip used to read "Pages", the same word as the heading of the rail it
    // opened, which it then covered.
    await expect(page.locator('.icon-btn[aria-label="Show pages"]')).toBeVisible();
    await page.locator('.icon-btn[aria-label="Show pages"]').click();
    await expect(page.locator('.icon-btn[aria-label="Hide pages"]')).toBeVisible();
    await expect(page.locator(".pagenav")).toBeVisible();
  });
});

test.describe("overflow menu", () => {
  test("every item is reachable and none of them wraps", async ({ page }) => {
    // A 900px-tall window is ordinary, and the menu was taller than that with no
    // scroll of its own: the File group (Open another PDF / Close document) was
    // painted past the bottom edge and could not be reached at all.
    await page.setViewportSize({ width: 1280, height: 820 });
    await open(page, (await fixtures()).sample);
    await page.locator('.icon-btn[aria-label="More actions"]').click();

    const list = page.locator(".menu__list");
    await expect(list).toBeVisible();
    const items = page.locator(".menu__item");
    const n = await items.count();
    expect(n).toBeGreaterThan(10);

    const box = (await list.boundingBox())!;
    expect(box.y + box.height, "the menu is drawn past the bottom of the window").toBeLessThanOrEqual(
      820,
    );

    // Scroll to the last item and require it to actually land inside the menu.
    const last = items.nth(n - 1);
    await last.scrollIntoViewIfNeeded();
    await expect(last).toBeInViewport();

    // One line per row: labels that wrap make a list of uneven blocks that can no
    // longer be scanned down the left edge.
    const heights = await items.evaluateAll((els) =>
      els.map((el) => Math.round(el.getBoundingClientRect().height)),
    );
    expect(Math.max(...heights) - Math.min(...heights), `row heights: ${heights.join()}`).toBeLessThanOrEqual(
      2,
    );
  });
});

test.describe("inspector", () => {
  test("names both of its jobs, and selecting something does not lose the other", async ({
    page,
  }) => {
    const w = watch(page);
    await page.setViewportSize({ width: 1280, height: 860 });
    await open(page, (await fixtures()).sample);

    const tabs = page.locator(".inspector__tabbtn");
    await expect(tabs).toHaveCount(2);
    await expect(tabs.nth(0)).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(".doclist__item").first()).toBeVisible();

    // Clicking the page used to replace the document actions with the selection's
    // properties, with nothing anywhere to say the surface had changed identity —
    // and no way back without deselecting.
    await page.locator(".fragment").first().click();
    await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(".props__section").first()).toBeVisible();

    await tabs.nth(0).click();
    await expect(page.locator(".doclist__item").first()).toBeVisible();
    // Still selected — switching tabs reads the panel, it doesn't edit the page.
    await expect(page.locator(".fragment__cover--sel")).toHaveCount(1);

    // The Properties empty state shipped unreachable: with nothing selected the
    // panel showed the document actions instead, so the one text explaining how
    // to get properties only appeared once you no longer needed it.
    await tabs.nth(1).click();
    await page.keyboard.press("Escape");
    await expect(page.locator(".props__empty")).toContainText(/Nothing selected/);

    expectClean(w);
  });

  test("tabs are keyboard-operable", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 860 });
    await open(page, (await fixtures()).sample);
    const tabs = page.locator(".inspector__tabbtn");
    await tabs.nth(0).focus();
    await page.keyboard.press("ArrowRight");
    await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("ArrowRight"); // wraps
    await expect(tabs.nth(0)).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("End");
    await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
  });

  test("collapses to an edge control with a readable name", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 860 });
    await open(page, (await fixtures()).sample);
    await page.locator('.icon-btn[aria-label="Hide panel"]').click();
    const tab = page.locator(".inspector__tab");
    await expect(tab).toBeVisible();
    // The label used to be a `writing-mode: vertical-rl` word on the edge.
    await expect(page.locator(".inspector__tablabel")).toHaveCount(0);
    await tab.click();
    await expect(page.locator(".inspector__tabbtn")).toHaveCount(2);
  });
});

test("the page rail states the document's length", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await open(page, (await fixtures()).sample);
  await page.locator('.icon-btn[aria-label="Show pages"]').click();

  // The page count was nowhere in the UI: "how long is this?" meant scrolling the
  // rail to its end.
  await expect(page.locator(".pagenav__count")).toHaveText("12");

  // Each page is one object — the number is a chip *on* its thumbnail. Set below
  // the thumb, it sat nearer the next page than its own.
  const chip = page.locator(".pagenav__item").first().locator(".pagenav__num");
  const thumb = page.locator(".pagenav__item").first().locator(".pagenav__thumb");
  const [c, t] = [(await chip.boundingBox())!, (await thumb.boundingBox())!];
  expect(c.y).toBeGreaterThanOrEqual(t.y);
  expect(c.y + c.height).toBeLessThanOrEqual(t.y + t.height + 1);

  // The count is decorative; the accessible name has to carry the position.
  await expect(page.locator(".pagenav__item").first()).toHaveAttribute(
    "aria-label",
    /Page 1 of 12/,
  );
});

test("a tooltip on an edge control stays on screen", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await open(page, (await fixtures()).sample);
  // The collapsed Inspector tab sits *at* the right edge, and the bubble is
  // centred on its anchor — so it used to be drawn half outside the window.
  await page.locator('.icon-btn[aria-label="Hide panel"]').click();
  await page.locator(".inspector__tab").hover();
  const tip = page.locator(".tooltip");
  await expect(tip).toBeVisible();
  const b = (await tip.boundingBox())!;
  expect(b.x, "the tooltip starts off the left edge").toBeGreaterThanOrEqual(0);
  expect(b.x + b.width, "the tooltip runs off the right edge").toBeLessThanOrEqual(1280);
  await expect(tip).toHaveText("Show panel");
});

test("user-facing counts are written as English", async ({ page }) => {
  await open(page, (await fixtures()).sample);
  // "1 page(s) · 9 text fragments" — a placeholder for copy, not copy.
  await expect(page.locator(".snackbar__msg")).toHaveText(/^12 pages · \d+ text fragments$/);
});
