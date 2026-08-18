import { expect, test, type Page } from "@playwright/test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROTATED_TEXT, TYPESET_PAGE, TYPESET_PANELS, fixtures } from "./fixtures";
import { expectClean, open, pageTexts, watch } from "./helpers";

/**
 * Editing text must not cost the page its background, or the text its colour.
 *
 * A non-redacted page is copied verbatim and edits are drawn on top, so the
 * artwork was never at risk from the export itself. The two constants around the
 * edit were: the cover rectangle that hides the original glyphs was hardcoded
 * white (a hole through any coloured panel) and the replacement was drawn
 * hardcoded black (unreadable on a dark one). Both are now read off the raster.
 *
 * The fixture's two panels fail in opposite directions, so neither fix can be
 * mistaken for the other: near-white inside the dark-text panel is a hole,
 * dark inside the light-text panel is an edit in the wrong colour.
 */

type Panel = (typeof TYPESET_PANELS)[keyof typeof TYPESET_PANELS];

/** Classify pixels inside a panel on whatever page is currently rendered. Inset
 * so the panel's own antialiased edge (fill blending into white paper) can't be
 * mistaken for either failure. */
async function panelPixels(page: Page, panel: Panel) {
  return page.evaluate(
    ({ panel, pageW, pageH, inset }) => {
      const canvas = document.querySelector<HTMLCanvasElement>(".page__canvas")!;
      const ctx = canvas.getContext("2d")!;
      const s = canvas.width / pageW;
      const x = Math.round((panel.x + inset) * s);
      const y = Math.round((pageH - (panel.y + panel.height - inset)) * s);
      const w = Math.round((panel.width - inset * 2) * s);
      const h = Math.round((panel.height - inset * 2) * s);
      const d = ctx.getImageData(x, y, w, h).data;
      const [pr, pg, pb] = panel.rgb;
      let white = 0;
      let dark = 0;
      let fill = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] > 240 && d[i + 1] > 240 && d[i + 2] > 240) white++;
        if (d[i] < 90 && d[i + 1] < 90 && d[i + 2] < 90) dark++;
        if (
          Math.abs(d[i] - pr) < 6 &&
          Math.abs(d[i + 1] - pg) < 6 &&
          Math.abs(d[i + 2] - pb) < 6
        ) {
          fill++;
        }
      }
      return { white, dark, fill, total: d.length / 4 };
    },
    { panel, pageW: TYPESET_PAGE.width, pageH: TYPESET_PAGE.height, inset: 2 },
  );
}

/** Replace a fragment's text. Returns its fragment id. */
async function editText(page: Page, find: string, replacement: string): Promise<string> {
  const id = await page.locator(".fragment", { hasText: find }).first().getAttribute("data-id");
  expect(id, `no fragment for "${find}"`).toBeTruthy();
  const el = page.locator(`.fragment[data-id="${id}"]`);
  await el.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type(replacement);
  await expect(el).toHaveText(replacement);
  return id!;
}

/** Download the current document and save it where the app can reopen it. */
async function exportTo(page: Page): Promise<{ path: string; bytes: Buffer }> {
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 120_000 }),
    page.click(".appbar__download"),
  ]);
  const chunks: Buffer[] = [];
  for await (const c of await download.createReadStream()) chunks.push(c as Buffer);
  const bytes = Buffer.concat(chunks);
  const path = join(mkdtempSync(join(tmpdir(), "colors-")), "exported.pdf");
  writeFileSync(path, bytes);
  return { path, bytes };
}

test("the overlay takes both colours from the page", async ({ page }) => {
  const w = watch(page);
  const { typeset } = await fixtures();
  await open(page, typeset);

  // The overlay previews what the exporter writes, so it has to agree on both:
  // a white box or black text on screen is the same lie either way.
  const [pr, pg, pb] = TYPESET_PANELS.lightText.rgb;
  const light = await editText(page, TYPESET_PANELS.lightText.text, "EDITED-LIGHT");
  const lightEl = page.locator(`.fragment[data-id="${light}"]`);
  await expect(lightEl).toHaveCSS("color", "rgb(255, 255, 255)");
  await expect(lightEl).toHaveCSS("background-color", `rgb(${pr}, ${pg}, ${pb})`);

  const dark = await editText(page, TYPESET_PANELS.darkText.text, "EDITED-DARK");
  const darkEl = page.locator(`.fragment[data-id="${dark}"]`);
  await expect(darkEl).toHaveCSS("color", "rgb(0, 0, 0)");
  await expect(darkEl).toHaveCSS("background-color", `rgb(${pr}, ${pg}, ${pb})`);

  // Plain black text on paper keeps exactly what it always had — the reading has
  // to decline rather than wash it out to a near-black grey.
  const paper = await editText(page, "Hxplg-Times-18", "EDITED-PAPER");
  const paperEl = page.locator(`.fragment[data-id="${paper}"]`);
  await expect(paperEl).toHaveCSS("color", "rgb(0, 0, 0)");
  await expect(paperEl).toHaveCSS("background-color", "rgb(255, 255, 255)");
  expectClean(w);
});

test("an exported edit keeps the panel and the text colour", async ({ page }) => {
  const w = watch(page);
  const { typeset } = await fixtures();
  await open(page, typeset);

  const before = {
    dark: await panelPixels(page, TYPESET_PANELS.darkText),
    light: await panelPixels(page, TYPESET_PANELS.lightText),
  };
  expect(before.dark.white, "the dark-text panel starts solid").toBe(0);
  expect(before.light.dark, "the light-text panel starts free of dark pixels").toBe(0);

  await editText(page, TYPESET_PANELS.darkText.text, "EDITED-DARK");
  await editText(page, TYPESET_PANELS.lightText.text, "EDITED-LIGHT");
  const { path, bytes } = await exportTo(page);

  // The edits are really in the file...
  const text = (await pageTexts(bytes, [1]))[0];
  expect(text).toContain("EDITED-DARK");
  expect(text).toContain("EDITED-LIGHT");

  // ...and the file, reopened and rendered, has neither failure.
  await open(page, path);
  const after = {
    dark: await panelPixels(page, TYPESET_PANELS.darkText),
    light: await panelPixels(page, TYPESET_PANELS.lightText),
  };
  expect(after.dark.white, "the cover punched a white hole through the panel").toBe(0);
  expect(after.dark.fill).toBeGreaterThan(after.dark.total * 0.5);
  expect(after.light.dark, "the edit was redrawn in black on a dark panel").toBe(0);
  expect(after.light.white, "the edit is there, in the document's own white").toBeGreaterThan(0);
  expectClean(w);
});

test("a rotated page is left alone rather than sampled wrongly", async ({ page }) => {
  // The raster is rotated and the fragment transforms are not, so reading pixels
  // at a fragment's coordinates reads the wrong place. The fixture puts a solid
  // black band exactly there: before this was gated, black-on-white text came
  // back with a black background, and an edit would have painted a black
  // rectangle over white paper with black text on it. White and black is wrong
  // here in the same way the overlay's position already is — and no worse.
  const w = watch(page);
  const { rotated } = await fixtures();
  await open(page, rotated);

  const id = await editText(page, ROTATED_TEXT, "EDITED-ROTATED");
  const el = page.locator(`.fragment[data-id="${id}"]`);
  await expect(el).toHaveCSS("color", "rgb(0, 0, 0)");
  await expect(el.locator("xpath=preceding-sibling::div[1]")).toHaveCSS(
    "background-color",
    "rgb(255, 255, 255)",
  );
  expectClean(w);
});

test("scrolling a document nobody edits samples nothing", async ({ page }) => {
  // Sampling is a full-page `getImageData` plus per-fragment tallies: 18ms on a
  // 1.1M px canvas, 63ms median and 146ms worst on a 4.6M px one. It used to run
  // as each page painted, which spent that on every page scrolled past to serve
  // a case most of them never reach. Now it waits for a fragment to be shown.
  const w = watch(page);
  const { sample } = await fixtures();
  await open(page, sample);
  const reads = await page.evaluate(() => {
    let n = 0;
    const proto = CanvasRenderingContext2D.prototype;
    const real = proto.getImageData;
    proto.getImageData = function (...args: unknown[]) {
      n++;
      // @ts-expect-error forwarding to the real implementation
      return real.apply(this, args);
    };
    (window as unknown as { __reads: () => number }).__reads = () => n;
    return true;
  });
  expect(reads).toBe(true);

  for (let i = 0; i < 6; i++) {
    await page.mouse.move(640, 500);
    await page.mouse.wheel(0, 900);
    await page.waitForTimeout(300);
  }
  const afterScroll = await page.evaluate(() =>
    (window as unknown as { __reads: () => number }).__reads(),
  );
  expect(afterScroll, "scrolling read back pixels it did not need").toBe(0);

  // Selecting one fragment does sample — once.
  await page.locator(".fragment").first().click();
  await page.waitForTimeout(400);
  const afterSelect = await page.evaluate(() =>
    (window as unknown as { __reads: () => number }).__reads(),
  );
  expect(afterSelect).toBeGreaterThan(0);
  expectClean(w);
});
