import { test, expect, type Page } from "@playwright/test";
import { fixtures } from "./fixtures";
import { open, watch } from "./helpers";

/**
 * Edited text has to keep looking like the text around it.
 *
 * The only font information `getTextContent()` gives a fragment is pdf.js's
 * generic `fallbackName` — "sans-serif", "serif" or "monospace". Two things
 * went wrong with that: `/serif/` matched inside "sans-serif", so every sans
 * document's edited text was redrawn in Times; and a generic name carries no
 * weight, so an edited bold heading came back regular. Both are invisible to
 * type-checking and obvious the moment something reads the computed style.
 */

/** The font stack actually applied to an element, minus the "sans-serif"
 * token — which is exactly the string that fooled the original detection. */
async function faceOf(page: Page, selector: string) {
  return page.locator(selector).first().evaluate((el) => {
    const cs = getComputedStyle(el);
    return {
      family: cs.fontFamily.replace(/sans-serif/g, "").toLowerCase(),
      weight: Number(cs.fontWeight),
    };
  });
}

/** Click a fragment by its text and type at the end of it. */
async function editFragment(page: Page, text: RegExp, typed: string) {
  const frag = page.locator(".fragment", { hasText: text }).first();
  await frag.click();
  await page.keyboard.press("End");
  await page.keyboard.type(typed, { delay: 20 });
  await expect(frag).toHaveClass(/fragment/);
  await page.waitForTimeout(200);
}

test("editing keeps the document's typeface and weight", async ({ page }) => {
  const f = await fixtures();
  const w = watch(page);
  await open(page, f.sample);

  // The fixture's heading is Helvetica-Bold; its body is Helvetica.
  await editFragment(page, /Confidential Report/, " v2");
  const heading = await faceOf(page, ".fragment[data-id]:has-text('Confidential Report')");
  expect(heading.family).not.toMatch(/serif|times|georgia/);
  expect(heading.weight).toBeGreaterThanOrEqual(700);

  // And the *detected* style agrees — this is the standard font the exporter
  // falls back to, and the one the properties panel offers to change.
  await expect(page.locator(".props__section .segmented__btn--on").first()).toHaveText("Sans");

  expect(w.errors).toEqual([]);
});

test("a regular fragment doesn't come back bold", async ({ page }) => {
  const f = await fixtures();
  await open(page, f.sample);

  await editFragment(page, /Line 1:/, " ok");
  const body = await faceOf(page, ".fragment[data-id]:has-text('Line 1:')");
  expect(body.family).not.toMatch(/serif|times|georgia/);
  expect(body.weight).toBeLessThan(700);
});

test("choosing a font overrides the document's own", async ({ page }) => {
  const f = await fixtures();
  await open(page, f.sample);

  await editFragment(page, /Confidential Report/, " v3");
  // The properties panel's font control replaces the source typeface — at
  // which point the overlay must stop previewing it, because the exporter
  // stops embedding it.
  await page.getByRole("button", { name: "Serif", exact: true }).first().click();
  await page.waitForTimeout(200);
  const heading = await faceOf(page, ".fragment[data-id]:has-text('Confidential Report')");
  expect(heading.family).toMatch(/times|serif/);
});
