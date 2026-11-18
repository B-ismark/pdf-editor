import { expect, test } from "@playwright/test";
import { fixtures } from "./fixtures";
import { expectClean, open, watch } from "./helpers";

/**
 * The shape language.
 *
 * Two rules hold this together and neither is visible in the stylesheet on its
 * own:
 *
 * 1. **State is never carried by `corner-shape`.** It is Chromium-only and
 *    *silently* ignored elsewhere — a selected state drawn with it would simply
 *    not show on Safari, with nothing anywhere to say so. It is reserved for
 *    softening shapes the app already has.
 *
 * 2. **Chrome geometry never touches the document.** Every pixel inside a page
 *    is a claim about what the exporter will write. A squircled page corner is
 *    a shape the exported PDF does not have.
 */

test("no chrome geometry reaches the document", async ({ page }) => {
  const w = watch(page);
  const f = await fixtures();
  await open(page, f.sample);
  const shapes = await page.evaluate(() => {
    const out: Record<string, string> = {};
    for (const sel of [".page", ".page__canvas", ".page__overlay", ".pagenav__item"]) {
      const el = document.querySelector(sel);
      if (el) out[sel] = getComputedStyle(el).cornerShape || "round";
    }
    return out;
  });

  for (const [sel, shape] of Object.entries(shapes)) {
    // Newer Chromium serialises the initial value as its superellipse
    // equivalent: `round` *is* `superellipse(1)`, so both mean "untouched".
    expect(["round", "superellipse(1)"], `${sel} keeps an honest corner`).toContain(shape);
  }
  expectClean(w);
});
