import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fixtures } from "./fixtures";
import { expectClean, open, pageTexts, pickTool, watch } from "./helpers";

/**
 * Text drawn in a standard font (Helvetica / Times / Courier) can only carry
 * WinAnsi characters. `@cantoo/pdf-lib` doesn't throw on the rest: it writes
 * "?" in their place, so a text box typed in Greek or Chinese downloaded as
 * "???? ??". The exporter now folds what has a plain-letter form (Ł→L, ő→o,
 * ﬁ→fi) and leaves out what has none — never a stand-in "?" — and the
 * status line names what it left out, since the page on screen still shows it.
 *
 * The sample fixture has no "?" of its own, so any "?" in the page's text
 * came from the export. Read through pdf.js: content streams are compressed,
 * so a byte search proves nothing.
 */

async function download(page: Page): Promise<Buffer> {
  const [dl] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Download", exact: true }).click(),
  ]);
  return readFileSync((await dl.path())!);
}

test("a text box in a standard font exports non-WinAnsi text without stand-in '?'", async ({ page }) => {
  const w = watch(page);
  await open(page, (await fixtures()).sample);
  await pickTool(page, "Add text");
  const pg = (await page.locator(".page").first().boundingBox())!;
  await page.mouse.click(pg.x + 80, pg.y + 40);
  // insertText, not type: a keyboard has no key for "中".
  await page.keyboard.insertText("Kappa κόσμε 中文 Łódź ﬁnal cafe\u0301");
  await page.keyboard.press("Escape");
  await expect(page.locator(".textbox").first()).toContainText("κόσμε");

  const [text] = await pageTexts(await download(page), [1]);
  expect(text, "the box reached the file").toContain("Kappa");
  expect(text, "no character was written as a stand-in '?'").not.toContain("?");
  // Letters with a plain form keep it rather than vanishing (ó is WinAnsi
  // already, so it stays as it is).
  expect(text).toContain("Lódz");
  expect(text).toContain("final");
  // A decomposed accent is composed, not dropped.
  expect(text).toContain("café");
  // The page showed what the file leaves out, so the user is told — each
  // character once, and not the ones that were folded or kept.
  const msg = page.locator(".snackbar__msg");
  await expect(msg).toContainText("Left out κ ό σ μ ε 中 文 — the built-in fonts can't write them.");
  await expect(msg).not.toContainText("Ł");
  expectClean(w);
});

test("a watermark in a standard font exports non-WinAnsi text without stand-in '?'", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  const w = watch(page);
  await open(page, (await fixtures()).sample);
  await page.locator("aside.inspector").getByRole("button", { name: "Add watermark" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.locator(".sigtype__input").fill("ΠΡΟΣΧΕΔΙΟ ΑΒ Łódź");
  await dialog.locator(".btn--filled").click();
  await expect(dialog).toHaveCount(0);

  const [text] = await pageTexts(await download(page), [1]);
  expect(text, "no character was written as a stand-in '?'").not.toContain("?");
  expect(text).toContain("Lódz");
  await expect(page.locator(".snackbar__msg")).toContainText("Left out Π Ρ Ο Σ Χ Ε Δ Ι …");
  expectClean(w);
});

test("an export that leaves nothing out says nothing about it", async ({ page }) => {
  const w = watch(page);
  await open(page, (await fixtures()).sample);
  await pickTool(page, "Add text");
  const pg = (await page.locator(".page").first().boundingBox())!;
  await page.mouse.click(pg.x + 80, pg.y + 40);
  // Folded, not left out: no warning for a letter that made it in.
  await page.keyboard.insertText("Łódź café");
  await page.keyboard.press("Escape");
  await download(page);
  const msg = page.locator(".snackbar__msg");
  await expect(msg).toContainText("Downloaded");
  await expect(msg).not.toContainText("Left out");
  expectClean(w);
});

/** A text box on page 1, typed with insertText (a keyboard has no key for "Ω"). */
async function addBox(page: Page, text: string) {
  await pickTool(page, "Add text");
  const pg = (await page.locator(".page").first().boundingBox())!;
  await page.mouse.click(pg.x + 80, pg.y + 40);
  await page.keyboard.insertText(text);
  await page.keyboard.press("Escape");
}

test("Download all names what it left out, and from which document", async ({ page }) => {
  const w = watch(page);
  const f = await fixtures();
  await open(page, f.sample);
  await addBox(page, "Ωmega");
  // A second tab, so Download all is offered; nothing in it to leave out.
  await page.setInputFiles("input[data-open-input]", f.typeset);
  await expect(page.locator(".doctab")).toHaveCount(2, { timeout: 30_000 });
  await page.waitForSelector(".page canvas");

  await page.locator('[aria-label="Export options"]').click();
  await Promise.all([
    page.waitForEvent("download"),
    page.locator(".menu__item", { hasText: "Download all (2) as ZIP" }).click(),
  ]);
  const msg = page.locator(".snackbar__msg");
  await expect(msg).toContainText("Downloaded 2 documents as a ZIP.");
  await expect(msg).toContainText("Left out Ω from sample.pdf — the built-in fonts can't write it.");
  expectClean(w);
});

test("Print names what it left out: the print is the file", async ({ page }) => {
  const w = watch(page);
  // Record that the dialog would open, instead of opening it.
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>).print = () => {
      (window as unknown as Record<string, unknown>).__printed = true;
    };
  });
  await open(page, (await fixtures()).sample);
  await addBox(page, "Ωmega");
  await page.keyboard.press("Control+p");
  await expect.poll(() => page.evaluate(() => !!(window as unknown as { __printed?: boolean }).__printed), { timeout: 60_000 }).toBe(true);
  await expect(page.locator(".snackbar__msg")).toContainText("Left out Ω — the built-in fonts can't write it.");
  expectClean(w);
});
