import { expect, test, type Page } from "@playwright/test";
import { fixtures } from "./fixtures";
import { expectClean, open, pickTool, watch } from "./helpers";

/**
 * Floating chrome at the bottom of the window: the draw sub-toolbar, the colour
 * popover it contains, and the status snackbar that shares that band.
 *
 * All three of these were measured, not guessed. The colour popover's top was
 * `min(anchor.bottom + 6, innerHeight - 200)` — a magic height and no flip — so
 * it covered 11,760px² of the toolbar it belongs to and up to 10,976px² of the
 * tool dock beneath it, i.e. the two controls a user reaches for next. The
 * snackbar sat at `bottom: 88px` against a toolbar at `bottom: 76px`, which hid
 * the one line telling a first-time user how the tick tool is placed. And the
 * toolbar itself never went away: 60px of chrome across the page, with nothing
 * left to say once you'd picked what to draw with.
 */

/** Overlap area, in px², between two elements (0 if either is absent). */
function overlap(page: Page, a: string, b: string) {
  return page.evaluate(([sa, sb]) => {
    const ra = document.querySelector(sa)?.getBoundingClientRect();
    const rb = document.querySelector(sb)?.getBoundingClientRect();
    if (!ra || !rb) return 0;
    const w = Math.max(0, Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left));
    const h = Math.max(0, Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top));
    return Math.round(w * h);
  }, [a, b]);
}

test.describe("the draw sub-toolbar is a disclosure", () => {
  test("it opens with the tool, folds away on a pick, and comes back", async ({ page }) => {
    const w = watch(page);
    await open(page, (await fixtures()).sample);
    const draw = page.locator('.tooldock__btn[aria-label="Draw"]');

    await draw.click();
    await expect(page.locator(".drawbar:not(.drawbar--closed)")).toHaveCount(1);
    await expect(draw).toHaveAttribute("aria-expanded", "true");

    // Picking a sub-tool is the end of this toolbar's job.
    await page.locator('#drawbar .icon-btn[aria-label="Arrow"]').click();
    await expect(page.locator(".drawbar--closed")).toHaveCount(1);
    await expect(draw).toHaveAttribute("aria-expanded", "false");
    // ...and the handle says which sub-tool is live, so the strip isn't the
    // only way to find out.
    await expect(page.locator(".drawbar__handle")).toContainText("Arrow");

    await page.locator(".drawbar__handle").click();
    await expect(page.locator(".drawbar:not(.drawbar--closed)")).toHaveCount(1);

    // The dock's Draw button toggles it too, without leaving the tool.
    await draw.click();
    await expect(page.locator(".drawbar--closed")).toHaveCount(1);
    await expect(draw).toHaveAttribute("aria-pressed", "true");
    expectClean(w);
  });

  test("the arrow puts it away entirely", async ({ page }) => {
    const w = watch(page);
    await open(page, (await fixtures()).sample);
    await pickTool(page, "Draw");
    await expect(page.locator("#drawbar")).toHaveCount(1);

    await pickTool(page, "Select");
    await expect(page.locator("#drawbar")).toHaveCount(0);
    // No dangling reference once the thing it names is gone.
    await expect(page.locator('.tooldock__btn[aria-label="Draw"]')).not.toHaveAttribute(
      "aria-controls",
      "drawbar",
    );
    expectClean(w);
  });
});

for (const [label, viewport] of [
  ["desktop", { width: 1280, height: 820 }],
  ["phone", { width: 390, height: 844 }],
  ["narrow phone", { width: 360, height: 780 }],
] as const) {
  test(`the colour popover stays on screen and clear of both bars (${label})`, async ({
    browser,
  }) => {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    const w = watch(page);
    await open(page, (await fixtures()).sample);

    await pickTool(page, "Draw");
    await page.locator('.drawbar [aria-label="Choose colour"]').click();
    await expect(page.locator(".colorfield__pop")).toBeVisible();

    const box = await page.locator(".colorfield__pop").boundingBox();
    expect(box!.y, "the palette starts above the top of the window").toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height, "the palette runs off the bottom").toBeLessThanOrEqual(
      viewport.height,
    );
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);

    expect(await overlap(page, ".colorfield__pop", ".drawbar"), "covers its own toolbar").toBe(0);
    expect(await overlap(page, ".colorfield__pop", ".tooldock"), "covers the tool dock").toBe(0);
    expectClean(w);
    await ctx.close();
  });
}

test("the status message clears the draw toolbar", async ({ page }) => {
  const w = watch(page);
  await open(page, (await fixtures()).sample);
  await pickTool(page, "Draw");

  // Any status message would do; this one is instant and needs no permission.
  // The message that first exposed the collision was the "N pages · M text
  // fragments" one shown on open — i.e. it covered the tick tool's hint at
  // exactly the moment a new user was reading the toolbar.
  await page.locator('[aria-label="More actions"]').click();
  await page.locator('[role="menuitemcheckbox"]', { hasText: "Save session on this device" }).click();
  await expect(page.locator(".snackbar")).toBeVisible();

  expect(await overlap(page, ".snackbar", ".drawbar")).toBe(0);
  expect(await overlap(page, ".snackbar", ".tooldock")).toBe(0);
  expectClean(w);
});
