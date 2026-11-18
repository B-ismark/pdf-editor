import { test, expect, type Page } from "@playwright/test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtures, PERSONAL } from "./fixtures";
import { open, setLossless } from "./helpers";
import { ibanValid, luhn } from "../src/pdf/patterns";

/**
 * "Redact patterns": find kinds of personal information, review each hit,
 * redact the ones left ticked.
 *
 * The leak check is the same as search redaction's: every real hit in the
 * fixture is the only red on the page, so after export, red means a hit was
 * missed or its box fell short of the ink.
 */

async function openPatterns(page: Page) {
  await page.keyboard.press("Control+k");
  await page.locator(".cmdk__input").fill("Redact patterns");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Redact patterns" })).toBeVisible();
}

const panel = (page: Page) => page.getByRole("dialog", { name: "Redact patterns" });
const listed = (page: Page) => panel(page).locator(".patterns__text").allTextContents();

async function downloadBytes(page: Page): Promise<Buffer> {
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 120_000 }),
    page.click(".appbar__download"),
  ]);
  return readFileSync((await download.path())!);
}

async function redPixels(page: Page): Promise<number> {
  await page.waitForFunction(() => {
    const c = document.querySelector(".page canvas") as HTMLCanvasElement | null;
    return !!c && c.width > 1;
  });
  await page.waitForTimeout(600);
  return page.evaluate(() => {
    const c = document.querySelector(".page canvas") as HTMLCanvasElement;
    const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
    let red = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] > 150 && d[i + 1] < 110 && d[i + 2] < 110) red++;
    return red;
  });
}

async function exportAndView(page: Page, browser: import("@playwright/test").Browser): Promise<Page> {
  const out = join(mkdtempSync(join(tmpdir(), "patterns-")), "out.pdf");
  writeFileSync(out, await downloadBytes(page));
  const view = await browser.newPage();
  await open(view, out);
  return view;
}

test("the checksums turn away look-alikes", () => {
  expect(luhn("4111 1111 1111 1111")).toBe(true);
  expect(luhn("4111 1111 1111 1112")).toBe(false);
  expect(luhn("1234")).toBe(false);
  expect(ibanValid("GB82 WEST 1234 5698 7654 32")).toBe(true);
  expect(ibanValid("GB82WEST12345698765432")).toBe(true);
  expect(ibanValid("GB00 WEST 1234 5698 7654 32")).toBe(false);
  expect(ibanValid("DE89 3704 0044 0532 0130 00")).toBe(true);
});

test("every kind is found, a number split across runs too, and nothing of them survives export", async ({ page, browser }) => {
  test.setTimeout(120_000);
  await open(page, (await fixtures()).personal);
  await setLossless(page);
  expect(await redPixels(page), "the fixture has red to remove").toBeGreaterThan(50);

  await openPatterns(page);
  const expected = [...PERSONAL.lines.map((l) => l.hit), PERSONAL.phoneText];
  await expect.poll(() => listed(page)).toEqual(expected);
  for (const d of PERSONAL.decoys) {
    for (const t of await listed(page)) expect(d, `the decoy "${d}" isn't listed`).not.toContain(t);
  }
  // Each hit is highlighted where it is.
  await expect(page.locator(".findhit")).toHaveCount(expected.length + 1); // the phone number is two runs, so two boxes

  await panel(page).getByRole("button", { name: `Redact ${expected.length}` }).click();
  await expect(panel(page)).toHaveCount(0);
  await expect(page.locator(".redaction")).toHaveCount(expected.length + 1);

  const view = await exportAndView(page, browser);
  expect(await redPixels(view), "no red left after export").toBe(0);
  await view.close();
});

test("an unticked hit is left alone, and the rest go in one undo step", async ({ page, browser }) => {
  test.setTimeout(120_000);
  await open(page, (await fixtures()).personal);
  await setLossless(page);
  await openPatterns(page);
  const email = PERSONAL.lines[0].hit;
  await expect.poll(() => listed(page)).toContain(email);
  const total = (await listed(page)).length;

  await panel(page).getByRole("checkbox", { name: new RegExp(`Redact Email: ${email.replace(/\./g, "\\.")}`) }).uncheck();
  await expect(panel(page).getByText(`${total - 1} of ${total} selected`)).toBeVisible();
  await expect(page.locator(".findhit--off"), "the unticked hit is still marked on the page").toHaveCount(1);
  await panel(page).getByRole("button", { name: `Redact ${total - 1}` }).click();
  await expect(page.locator(".redaction")).toHaveCount(total); // total - 1 hits, the phone in two boxes

  // One step back undoes the whole lot.
  await page.keyboard.press("Control+z");
  await expect(page.locator(".redaction")).toHaveCount(0);
  await page.keyboard.press("Control+y");
  await expect(page.locator(".redaction")).toHaveCount(total);

  const view = await exportAndView(page, browser);
  expect(await redPixels(view), "the email, unticked, is still there").toBeGreaterThan(20);
  await view.close();
});

test("dates are asked for, custom patterns are checked, and Escape leaves the page as it was", async ({ page }) => {
  await open(page, (await fixtures()).personal);
  await openPatterns(page);
  await expect.poll(() => listed(page)).not.toContain(PERSONAL.date.hit);

  await panel(page).getByRole("checkbox", { name: "Dates" }).check();
  await expect.poll(() => listed(page)).toContain(PERSONAL.date.hit);

  const input = panel(page).getByRole("textbox", { name: "Custom pattern" });
  await input.fill("(");
  await expect(panel(page).getByRole("alert")).toBeVisible();
  await expect(input).toHaveAttribute("aria-invalid", "true");
  await input.fill("x*");
  await expect(panel(page).getByRole("alert"), "a pattern that matches nothing at all is refused").toContainText("empty");
  await input.fill(PERSONAL.custom.pattern);
  await expect(panel(page).getByRole("alert")).toHaveCount(0);
  await expect.poll(() => listed(page)).toContain(PERSONAL.custom.hit);

  // Showing a hit marks its row and its box.
  await panel(page).locator(".patterns__show", { hasText: PERSONAL.custom.hit }).click();
  await expect(panel(page).locator(".patterns__hit--on")).toContainText(PERSONAL.custom.hit);
  await expect(page.locator(".findhit--active")).toHaveCount(1);

  await page.keyboard.press("Escape");
  await expect(panel(page)).toHaveCount(0);
  await expect(page.locator(".findhit")).toHaveCount(0);
  await expect(page.locator(".redaction")).toHaveCount(0);
});

test("the find bar leads to patterns, and the two never show at once", async ({ page }) => {
  await open(page, (await fixtures()).personal);
  await page.keyboard.press("Control+f");
  await page.locator(".findbar").getByRole("button", { name: "Redact patterns" }).click();
  await expect(panel(page)).toBeVisible();
  await expect(page.locator(".findbar")).toHaveCount(0);
  await page.keyboard.press("Control+f");
  await expect(page.locator(".findbar")).toBeVisible();
  await expect(panel(page)).toHaveCount(0);
});

test("on a phone the panel is a sheet that fits the screen", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  await open(page, (await fixtures()).personal);
  await openPatterns(page);
  await expect.poll(() => listed(page)).toContain(PERSONAL.phoneText);
  const box = (await panel(page).boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390 + 0.5);
  expect(box.y + box.height).toBeLessThanOrEqual(844 + 0.5);
  const overflow = await panel(page).evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(overflow, "nothing in the sheet runs off its side").toBeLessThanOrEqual(0);
  await expect(panel(page).getByRole("button", { name: /^Redact \d+$/ })).toBeInViewport();
  await ctx.close();
});
