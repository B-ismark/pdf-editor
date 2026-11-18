import { expect, test, type Page } from "@playwright/test";
import fontkit from "@pdf-lib/fontkit";
import { existsSync, readFileSync } from "node:fs";
import { LIGATURES, fixtures } from "./fixtures";
import { expectClean, open, watch } from "./helpers";

/**
 * A plain letter draws as itself in the document's own face, never as a
 * ligature that starts with it — on screen and in the exported file.
 *
 * pdf.js rebuilds each embedded font and gives it a Unicode cmap from the
 * ToUnicode, keyed on the first letter of each glyph's text. The "fi" glyph
 * (text "fi") was filed under "f" over the real one, so a selected run read
 * "firom" for "from", and an edit kept in the document's typeface was written
 * into the file the same way (the vector exporter embeds those same bytes). The
 * worker is patched at build time — see `pdfWorkerPlugin` in `vite.config.ts`.
 */

test.skip(!existsSync(LIGATURES.font), `needs ${LIGATURES.font}`);

const { size, lines } = LIGATURES;

/** The face's own advance for each character, in em. */
function advances(text: string): number[] {
  const kit = fontkit.create(readFileSync(LIGATURES.font)) as unknown as {
    unitsPerEm: number;
    glyphForCodePoint(cp: number): { advanceWidth: number };
  };
  return [...text].map((ch) => kit.glyphForCodePoint(ch.codePointAt(0)!).advanceWidth / kit.unitsPerEm);
}

/** Select the fragment showing `text`, and return the CSS family it is drawn in. */
async function selectRun(page: Page, text: string) {
  // By id: a locator filtered on the text stops matching once it's edited.
  const id = await page.locator(".fragment", { hasText: text }).first().getAttribute("data-id");
  const el = page.locator(`.fragment[data-id="${id}"]`);
  await el.click();
  // Drawn in the document's face once selected (pdf.js registers it as a
  // FontFace under its `loadedName`).
  await expect
    .poll(() => el.evaluate((n) => getComputedStyle(n).fontFamily))
    .toMatch(/^"?g_/);
  return { el, family: await el.evaluate((n) => getComputedStyle(n).fontFamily) };
}

test("a selected run draws each letter in the document's face, not a ligature", async ({ page }) => {
  const w = watch(page);
  await open(page, (await fixtures()).ligatures);
  const { family } = await selectRun(page, lines[1].text);

  const letters = "abcdefghijklmnopqrstuvwxyz";
  const measured = await page.evaluate(
    async ({ family, letters }) => {
      const name = family.split(",")[0].trim().replace(/^"|"$/g, "");
      await document.fonts.load(`100px ${family}`);
      // The face itself, not a fallback that happens to look alike.
      const loaded = [...document.fonts].some((f) => f.family.replace(/^"|"$/g, "") === name && f.status === "loaded");
      const ctx = document.createElement("canvas").getContext("2d")!;
      ctx.font = `100px ${family}`;
      return { loaded, widths: [...letters].map((ch) => ctx.measureText(ch).width / 100) };
    },
    { family, letters },
  );
  expect(measured.loaded, "the document's face never loaded").toBe(true);
  const expected = advances(letters);
  // Each letter at its own advance. "f" drawn as the "fi" glyph is 0.28em wide
  // too wide; any other letter claimed by a ligature shows up the same way.
  const off = [...letters].filter((ch, i) => Math.abs(measured.widths[i] - expected[i]) > 0.01);
  expect(off, "letters drawn as some other glyph").toEqual([]);
  expectClean(w);
});

test("an edit kept in the document's face is written with the right glyphs", async ({ page }) => {
  const w = watch(page);
  await open(page, (await fixtures()).ligatures);
  const { el } = await selectRun(page, lines[1].text);
  // No f-ligature in the new text: every "f" must be the plain glyph.
  const replacement = "for the floor";
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type(replacement);
  await expect(el).toHaveText(replacement);

  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 120_000 }),
    page.click(".appbar__download"),
  ]);
  const chunks: Buffer[] = [];
  for await (const c of await download.createReadStream()) chunks.push(c as Buffer);

  // The width the file's own font gives the run: the sum of its glyphs.
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(Buffer.concat(chunks)) }).promise;
  const content = await (await doc.getPage(1)).getTextContent();
  const item = content.items.find((i) => "str" in i && i.str === replacement) as { width: number } | undefined;
  const strs = content.items.map((i) => ("str" in i ? i.str : ""));
  expect(item, `the edit isn't in the exported text layer: ${JSON.stringify(strs)}`).toBeTruthy();
  const expected = advances(replacement).reduce((a, b) => a + b, 0) * size;
  expect(Math.abs(item!.width - expected), `width ${item!.width} vs ${expected}`).toBeLessThan(0.5);
  await doc.destroy();
  expectClean(w);
});
