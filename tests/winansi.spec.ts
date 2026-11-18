import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fixtures } from "./fixtures";
import { expectClean, open, pageTexts, pickTool, watch } from "./helpers";

/**
 * Text drawn in a standard font (Helvetica / Times / Courier) can only carry
 * WinAnsi characters. `@cantoo/pdf-lib` doesn't throw on the rest: it writes
 * "?" in their place, so a text box typed in Greek or Chinese downloaded as
 * "???? ??". The exporter now folds what has a plain-letter form (Ł→L, ő→o,
 * ﬁ→fi) and leaves out what has none — never a stand-in "?".
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
  expectClean(w);
});

test("a watermark in a standard font exports non-WinAnsi text without stand-in '?'", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  const w = watch(page);
  await open(page, (await fixtures()).sample);
  await page.locator("aside.inspector").getByRole("button", { name: "Add watermark" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.locator(".sigtype__input").fill("ΠΡΟΣΧΕΔΙΟ Łódź");
  await dialog.locator(".btn--filled").click();
  await expect(dialog).toHaveCount(0);

  const [text] = await pageTexts(await download(page), [1]);
  expect(text, "no character was written as a stand-in '?'").not.toContain("?");
  expect(text).toContain("Lódz");
  expectClean(w);
});
