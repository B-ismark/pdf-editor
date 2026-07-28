import { test, expect } from "@playwright/test";
import { fixtures } from "./fixtures";
import { open, canvasStats } from "./helpers";

/**
 * Per-page rendering must cost the viewport, not the document.
 *
 * Every page used to rasterise itself on mount, so a 150-page file held ~170 MP
 * of canvas backing store (about 680 MB) at all times and re-rasterised all of it
 * on every zoom step. Layout stays eager — page frames keep their true size so
 * scroll anchors and the scrollbar are exact — and only the contents are windowed.
 */
test.describe("render window", () => {
  test("a long document lays out every page but rasterises few", async ({ page }) => {
    await open(page, (await fixtures()).long);
    const stats = await canvasStats(page);
    expect(stats.pages, "every page frame is laid out").toBe(150);
    expect(stats.live, "only a band around the viewport is rasterised").toBeGreaterThan(0);
    expect(stats.live).toBeLessThanOrEqual(8);
  });

  test("canvas memory does not grow while scrolling", async ({ page }) => {
    await open(page, (await fixtures()).long);
    const top = await canvasStats(page);

    await page.evaluate(() => {
      const s = document.querySelector(".viewer__scroll")!;
      s.scrollTop = s.scrollHeight / 2;
    });
    await page.waitForTimeout(1500);
    const middle = await canvasStats(page);

    await page.evaluate(() => {
      const s = document.querySelector(".viewer__scroll")!;
      s.scrollTop = s.scrollHeight;
    });
    await page.waitForTimeout(1500);
    const bottom = await canvasStats(page);

    // The window should slide, not accumulate. Generous factor: the band size
    // varies with where in the document you are, but not with how far you went.
    expect(middle.megapixels).toBeLessThanOrEqual(top.megapixels * 2.5);
    expect(bottom.megapixels).toBeLessThanOrEqual(top.megapixels * 2.5);
  });

  test("the page you scroll to is actually painted", async ({ page }) => {
    await open(page, (await fixtures()).long);
    await page.evaluate(() => {
      const s = document.querySelector(".viewer__scroll")!;
      s.scrollTop = s.scrollHeight;
    });
    // Guards the trap that made this look like it worked: `rootMargin` doesn't
    // expand an intervening scroll clip, so with the wrong observer root only the
    // page literally on screen renders and the user watches skeletons resolve.
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const pages = [...document.querySelectorAll(".page")];
            const last = pages[pages.length - 1];
            return (
              (last.querySelector("canvas") as HTMLCanvasElement).width > 1 &&
              !!last.querySelector(".page__overlay")
            );
          }),
        { timeout: 20_000 },
      )
      .toBe(true);
  });
});
