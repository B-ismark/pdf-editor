import { expect, test } from "@playwright/test";
import { fixtures } from "./fixtures";
import { expectClean, open, pickTool, watch } from "./helpers";

/**
 * The editable-text overlay against the glyphs underneath it.
 *
 * Both assertions here are one bug: chrome and text that hug a fragment so
 * tightly they get read as part of the document. Selecting the run ending in
 * "Most of" drew a 1.5px ring around the glyph box, and because the box hugs the
 * glyphs, the ring's *vertical* edge landed in the gap before the next word and
 * read as a letter — "Most of" rendered as "Most ofl". Separately the overlay
 * carried `padding: 0 1px`, so the replacement text started a pixel to the right
 * of both the original glyphs and the x the exporter writes: every click nudged
 * the line sideways, and the preview disagreed with the file it was previewing.
 */

test("the overlay's text starts exactly where the exporter draws it", async ({ page }) => {
  const w = watch(page);
  await open(page, (await fixtures()).sample);

  await page.locator(".fragment").first().click();
  const m = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>(".fragment")!;
    // A Range over the contents reports where the glyphs actually land, which
    // is what padding moves and the element's own rect does not.
    const r = document.createRange();
    r.selectNodeContents(el);
    const cs = getComputedStyle(el);
    return {
      inset: r.getBoundingClientRect().left - el.getBoundingClientRect().left,
      padLeft: cs.paddingLeft,
      padRight: cs.paddingRight,
      padTop: cs.paddingTop,
      padBottom: cs.paddingBottom,
    };
  });

  expect(m.inset, "the overlay text is inset from the fragment's own x").toBeLessThan(0.01);
  expect(m.padLeft).toBe("0px");
  expect(m.padRight).toBe("0px");
  // Zero *vertical* padding is a separate invariant the baseline probe depends
  // on (see textBaseline.ts); assert it here too, since it's one declaration.
  expect(m.padTop).toBe("0px");
  expect(m.padBottom).toBe("0px");
  expectClean(w);
});

test("a text box's own text starts where the exporter draws it too", async ({ page }) => {
  const w = watch(page);
  await open(page, (await fixtures()).sample);

  // Same defect, the other text overlay: `.textbox` sits inside a wrapper placed
  // at `box.x * scale`, and the exporter draws the string at exactly `box.x`.
  await pickTool(page, "Add text");
  const box = (await page.locator(".page").first().boundingBox())!;
  await page.mouse.click(box.x + 90, box.y + 260);
  await page.keyboard.type("Placed");
  await page.waitForTimeout(200);

  const m = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>(".textbox")!;
    const wrap = el.closest(".tb-wrap") as HTMLElement;
    const r = document.createRange();
    r.selectNodeContents(el);
    const cs = getComputedStyle(el);
    return {
      // Measured against the *wrapper*, which is the element carrying the
      // exporter's x — so this catches an inset anywhere in the chain.
      inset: r.getBoundingClientRect().left - wrap.getBoundingClientRect().left,
      padLeft: cs.paddingLeft,
      padRight: cs.paddingRight,
      padTop: cs.paddingTop,
      padBottom: cs.paddingBottom,
    };
  });

  expect(m.inset, "the text box's text is inset from the x it exports at").toBeLessThan(0.01);
  expect(m.padLeft).toBe("0px");
  expect(m.padRight).toBe("0px");
  expect(m.padTop).toBe("0px");
  expect(m.padBottom).toBe("0px");
  expectClean(w);
});

test("a selected fragment is marked without putting chrome beside its glyphs", async ({ page }) => {
  const w = watch(page);
  await open(page, (await fixtures()).sample);

  await page.locator(".fragment").first().click();
  const cover = page.locator(".fragment__cover--sel");
  await expect(cover).toHaveCount(1);

  const marks = await cover.evaluate((el) => {
    const read = (which: "::before" | "::after") => {
      const cs = getComputedStyle(el, which);
      return { height: cs.height, left: cs.left, right: cs.right, top: cs.top, bottom: cs.bottom };
    };
    return {
      // The mechanism that produced the phantom letter: any shadow/outline
      // around the box has vertical edges hugging the glyphs. Ask for the
      // *style*, not the width: with `outline-style: none` the computed width is
      // "0px" in some Chromium versions and the specified "medium"/"3px" in
      // others, so a width test says nothing about whether a ring is painted.
      boxShadow: getComputedStyle(el).boxShadow,
      outlineStyle: getComputedStyle(el).outlineStyle,
      before: read("::before"),
      after: read("::after"),
    };
  });

  expect(marks.boxShadow, "a ring around the glyph box reads as a glyph").toBe("none");
  expect(marks.outlineStyle, "an outline ring reads as a glyph the same way").toBe("none");
  // What's left is two horizontal rules, above and below the run. A rule can't
  // be mistaken for a letter — that's why the indicator is these two edges.
  for (const rule of [marks.before, marks.after]) {
    expect(rule.height, "the selection mark is not a thin horizontal rule").toBe("2px");
    // Negative offsets: outside the glyph box, not across it.
    expect(parseFloat(rule.left)).toBeLessThanOrEqual(0);
    expect(parseFloat(rule.right)).toBeLessThanOrEqual(0);
  }
  expect(parseFloat(marks.before.top)).toBeLessThan(0);
  expect(parseFloat(marks.after.bottom)).toBeLessThan(0);
  expectClean(w);
});
