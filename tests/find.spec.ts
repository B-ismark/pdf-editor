import { test, expect } from "@playwright/test";
import { fixtures } from "./fixtures";
import { open } from "./helpers";

test("the active find match lands on screen, clear of the find bar", async ({ page }) => {
  await open(page, (await fixtures()).sample);
  await page.keyboard.press("Control+f");

  // A phrase near the *bottom* of page 1. Centring the page — the old behaviour —
  // leaves this off screen, because at fit-width an A4 page is taller than the
  // viewport. That made stepping through several matches on one page look like
  // Next doing nothing at all.
  await page.locator(".findbar input").fill("Line 24");
  await page.waitForTimeout(1500);

  const geometry = await page.evaluate(() => {
    const hit = document.querySelector(".findhit--active");
    const scroller = document.querySelector(".viewer__scroll");
    if (!hit || !scroller) return null;
    const h = hit.getBoundingClientRect();
    const s = scroller.getBoundingClientRect();
    return {
      onScreen: h.top >= s.top && h.bottom <= s.bottom,
      clearOfFindBar: h.top > s.top + 60,
    };
  });

  expect(geometry, "an active match highlight exists").not.toBeNull();
  expect(geometry!.onScreen, "the match is inside the scroll surface").toBe(true);
  expect(geometry!.clearOfFindBar, "the match is not hidden behind the find bar").toBe(true);
});
