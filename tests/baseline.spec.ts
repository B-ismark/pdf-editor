import { expect, test, type Page } from "@playwright/test";
import { TYPESET_PAGE, TYPESET_RUNS, fixtures } from "./fixtures";
import { expectClean, open, watch } from "./helpers";

/**
 * The overlay has to sit on the document's own baseline.
 *
 * `pdf-lib`'s `drawText` y and canvas `textBaseline: "alphabetic"` are both
 * baselines, so the exporter puts a replacement exactly where the original text
 * was — the export was never the problem. The *overlay* placed its box top a
 * whole font size above the baseline, but CSS puts the baseline at ~0.76–0.85em
 * from the top of a `line-height: 1` box, so every edited fragment previewed
 * 0.15–0.24em too high: proportional to the font size (so worse the further you
 * zoomed in) and different per typeface (so unfixable with a constant).
 *
 * Since what you edit has to look like what you download, the invariant is
 * measurable and belongs here: the glyphs the user sees must sit on the baseline
 * the exporter will write to.
 */

/** Viewport-space y of the text baseline inside `el`.
 *
 * A zero-size `inline-block` is aligned to the baseline of the line it's in and
 * its bottom margin edge *is* that baseline, so appending one and reading its
 * rect asks the layout engine where the glyphs really ended up. */
async function renderedBaseline(page: Page, id: string): Promise<number> {
  return page.evaluate((fid) => {
    const el = document.querySelector<HTMLElement>(`.fragment[data-id="${fid}"]`)!;
    const strut = document.createElement("span");
    strut.style.cssText = "display:inline-block;width:0;height:0";
    el.appendChild(strut);
    const y = strut.getBoundingClientRect().bottom;
    strut.remove();
    return y;
  }, id);
}

/** Where the exporter will draw: the fragment's PDF baseline, in viewport y. */
async function expectedBaseline(page: Page, pdfBaseline: number): Promise<number> {
  const box = await page.locator(".page__overlay").first().boundingBox();
  const scale = box!.width / TYPESET_PAGE.width;
  return box!.y + (TYPESET_PAGE.height - pdfBaseline) * scale;
}

/** Tolerance: sub-pixel rounding is invisible, a lifted line is not. The bug
 * this guards against was 4–12px at ordinary zoom and grew from there. */
const TOLERANCE = 1.5;

for (const width of [1280, 900]) {
  test(`edited text sits on the document's baseline (viewport ${width})`, async ({ page }) => {
    // Two viewport widths mean two fit-to-width scales, so a placement error
    // that scales with zoom can't hide behind one lucky measurement.
    await page.setViewportSize({ width, height: 900 });
    const w = watch(page);
    const { typeset } = await fixtures();
    await open(page, typeset);

    for (const run of TYPESET_RUNS) {
      const id = await page
        .locator(".fragment", { hasText: run.text })
        .first()
        .getAttribute("data-id");
      expect(id, `no fragment for "${run.text}"`).toBeTruthy();
      // Address it by id from here on: the text is about to change, so a
      // text-based locator would stop matching halfway through the test.
      const el = page.locator(`.fragment[data-id="${id}"]`);

      // Select it: that's what makes the overlay text visible ("click to edit"),
      // and it's the state the misplacement appeared in.
      await el.click();
      await expect(page.locator(`.fragment__cover`).first()).toBeVisible();

      const expected = await expectedBaseline(page, run.baseline);
      expect(
        Math.abs((await renderedBaseline(page, id!)) - expected),
        `"${run.text}" while selected`,
      ).toBeLessThan(TOLERANCE);

      // ...and after actually editing it, since the overlay stays visible for a
      // modified fragment and is then the only thing the user can judge by.
      await el.click();
      await page.keyboard.press("ControlOrMeta+a");
      await page.keyboard.type("Replaced");
      await expect(el).toHaveText("Replaced");
      expect(
        Math.abs((await renderedBaseline(page, id!)) - expected),
        `"${run.text}" after editing`,
      ).toBeLessThan(TOLERANCE);
    }
    expectClean(w);
  });
}
