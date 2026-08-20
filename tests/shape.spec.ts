import { expect, test } from "@playwright/test";
import { fixtures } from "./fixtures";
import { expectClean, open, watch } from "./helpers";

/**
 * The shape language.
 *
 * Two rules hold this together and neither is visible in the stylesheet on its
 * own:
 *
 * 1. **State that depends on a cut corner is masked, never `corner-shape`.**
 *    `corner-shape` is Chromium-only and is *silently* ignored elsewhere — so a
 *    selected tab drawn with `corner-shape: scoop` would simply not be marked
 *    as selected on Safari, with nothing anywhere to say so. The Inspector's
 *    joint therefore uses a radial-gradient mask, which renders everywhere.
 *    `corner-shape` is reserved for softening shapes the app already has.
 *
 * 2. **Chrome geometry never touches the document.** Every pixel inside a page
 *    is a claim about what the exporter will write. A squircled page corner is
 *    a shape the exported PDF does not have.
 */

test("the selected tab is joined to the panel, and the join is not Chromium-only", async ({ page }) => {
  const w = watch(page);
  const f = await fixtures();
  await open(page, f.sample);

  const on = page.locator(".inspector__tabbtn--on");
  await expect(on).toHaveCount(1);

  const joint = await on.evaluate((el) => {
    const read = (side: "::before" | "::after") => {
      const s = getComputedStyle(el, side);
      return { mask: s.maskImage, bg: s.backgroundColor, w: s.width, content: s.content };
    };
    const panel = getComputedStyle(el.closest(".inspector")!).backgroundColor;
    const strip = getComputedStyle(el.closest(".inspector__tabs")!).backgroundColor;
    return { left: read("::before"), right: read("::after"), panel, strip };
  });

  // Both fillets exist and are painted, not merely declared.
  for (const side of [joint.left, joint.right]) {
    expect(side.content, "the fillet is rendered").not.toBe("none");
    expect(parseFloat(side.w), "the fillet has width").toBeGreaterThan(0);
    // The join only reads if the fillet is the *panel's* colour. In the strip's
    // colour it is an ordinary rounded corner and the tab stops looking
    // attached to anything, which is the failure this whole shape exists to
    // prevent — so it is asserted against both, not just against transparent.
    expect(side.bg, "the fillet is painted in the panel's colour").toBe(joint.panel);
    expect(side.bg).not.toBe(joint.strip);
    // Masked, so Safari and Firefox get the same shape rather than nothing.
    expect(side.mask, "the joint is masked, not corner-shape").toContain("gradient");
  }

  // The unselected tab carries no joint — otherwise both would look owned.
  const off = page.locator(".inspector__tabbtn:not(.inspector__tabbtn--on)").first();
  const offContent = await off.evaluate((el) => getComputedStyle(el, "::before").content);
  expect(offContent).toBe("none");
  expectClean(w);
});

test("shape carries the tab's state, not just colour", async ({ page }) => {
  const w = watch(page);
  const f = await fixtures();
  await open(page, f.sample);

  const radii = () =>
    page.locator(".inspector__tabbtn").evaluateAll((els) =>
      els.map((e) => ({
        on: e.classList.contains("inspector__tabbtn--on"),
        r: parseFloat(getComputedStyle(e).borderTopLeftRadius),
      })),
    );

  const before = await radii();
  const onR = before.find((t) => t.on)!.r;
  const offR = before.find((t) => !t.on)!.r;
  expect(onR, "the selected tab rounds up, the unselected rounds down").toBeGreaterThan(offR);

  // And it follows the selection rather than being baked into the first tab.
  await page.locator('.inspector__tabbtn:has-text("Properties")').click();
  await page.waitForTimeout(500);
  const after = await radii();
  expect(after.find((t) => t.on)!.r).toBeGreaterThan(after.find((t) => !t.on)!.r);
  expect(after[1].on, "Properties is now the selected one").toBe(true);
  expectClean(w);
});

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
    expect(shape, `${sel} keeps an honest corner`).toBe("round");
  }
  expectClean(w);
});
