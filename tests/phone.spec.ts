import { test, expect, type Page } from "@playwright/test";
import { fixtures } from "./fixtures";
import { open, watch } from "./helpers";

// A phone viewport with touch. Set at the top level rather than inside a
// describe: Playwright forbids per-group options that would force a new worker.
test.use({
  viewport: { width: 393, height: 851 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  colorScheme: "dark",
});

/** Rects of two selectors, and whether they overlap. */
function collision(page: Page, a: string, b: string) {
  return page.evaluate(
    ([selA, selB]) => {
      const rect = (sel: string) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      };
      const ra = rect(selA);
      const rb = rect(selB);
      if (!ra || !rb) return { present: false, overlap: false };
      const overlap = !(
        ra.x + ra.w <= rb.x ||
        rb.x + rb.w <= ra.x ||
        ra.y + ra.h <= rb.y ||
        rb.y + rb.h <= ra.y
      );
      return { present: true, overlap, ra, rb };
    },
    [a, b],
  );
}

test("phone: floating surfaces do not overlap each other", async ({ page }) => {
  const w = watch(page);
  await open(page, (await fixtures()).sample);

  // The status snackbar is top-anchored on phones (the bottom edge belongs to the
  // tool dock) and spans most of the width; the zoom pill is pinned top-right in
  // the same band, so the two collided and the zoom percentage became unreadable
  // whenever a status message showed.
  const vsZoom = await collision(page, ".snackbar", ".zoombar");
  expect(vsZoom.present, "both the snackbar and the zoom pill are showing").toBe(true);
  expect(
    vsZoom.overlap,
    `snackbar ${JSON.stringify(vsZoom.ra)} vs zoom ${JSON.stringify(vsZoom.rb)}`,
  ).toBe(false);

  const vsDock = await collision(page, ".snackbar", ".tooldock");
  expect(vsDock.overlap).toBe(false);

  expect(w.errors, `errors: ${w.errors.slice(0, 3).join(" | ")}`).toEqual([]);
});
