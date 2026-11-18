import { test, expect, type Page } from "@playwright/test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtures, PERSONAL, TRICKY } from "./fixtures";
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

/* ---- From review ---- */

/** Wait until the custom pattern's search (in its worker) has answered. */
async function settled(page: Page) {
  await expect(panel(page).locator(".patterns__summary")).not.toContainText(/searching/i);
}

test("the hard cases are covered: neighbours a checksum refuses, short first groups, comb digits, a turned line, a custom pattern over an email", async ({ page, browser }) => {
  test.setTimeout(120_000);
  await open(page, (await fixtures()).tricky);
  await setLossless(page);
  expect(await redPixels(page), "the fixture has red to remove").toBeGreaterThan(50);

  await openPatterns(page);
  await panel(page).getByRole("textbox", { name: "Custom pattern" }).fill(TRICKY.custom);
  await settled(page);
  const list = await listed(page);
  // The real hit, not the hit plus its neighbour (and not nothing at all).
  expect(list).toContain(TRICKY.lines[0].hit);
  expect(list).toContain(TRICKY.lines[1].hit);
  expect(list, "the country code is part of the number").toContain(TRICKY.lines[2].hit);
  expect(list, "the leading 1- is part of the number").toContain(TRICKY.lines[3].hit);
  expect(list, "an IBAN in lower case").toContain(TRICKY.lines[4].hit);
  expect(list, "the patient's name isn't lost to the email beside it").toContain("Patient: John Smith <");

  await panel(page).getByRole("button", { name: /^Redact \d+$/ }).click();
  const view = await exportAndView(page, browser);
  expect(await redPixels(view), "no red left after export").toBe(0);
  await view.close();
});

test("a custom pattern that would hang the tab is stopped, and the tab stays responsive", async ({ page }) => {
  await open(page, (await fixtures()).personal);
  await openPatterns(page);
  const input = panel(page).getByRole("textbox", { name: "Custom pattern" });
  // Exponential on a long word: "GB00WEST12345698765432" is on the page.
  await input.fill(String.raw`((\w+)+)+;`);
  const t0 = Date.now();
  expect(await page.evaluate(() => 1 + 1), "the page still answers").toBe(2);
  expect(Date.now() - t0, "and answers at once").toBeLessThan(1000);
  await expect(panel(page).getByRole("alert")).toContainText("too long", { timeout: 8000 });
  // The presets' hits are still there, and a sensible pattern works again.
  await expect.poll(() => listed(page)).toContain(PERSONAL.lines[0].hit);
  await input.fill(String.raw`INV\-\d{6}`); // an escape the unicode mode refuses
  await expect(panel(page).getByRole("alert")).toHaveCount(0);
  await expect.poll(() => listed(page)).toContain(PERSONAL.custom.hit);
});

test("a pattern that matches too much asks to be narrowed rather than listing it all", async ({ page }) => {
  await open(page, (await fixtures()).sample);
  await openPatterns(page);
  await panel(page).getByRole("textbox", { name: "Custom pattern" }).fill(".");
  await expect(panel(page).getByText(/Too many matches/)).toBeVisible();
  await expect(panel(page).locator(".patterns__hit")).toHaveCount(0);
  await expect(panel(page).getByRole("button", { name: "Redact", exact: true })).toBeDisabled();
});

test("what was unticked stays unticked: through picking the command again, and through an edit to the line", async ({ page }) => {
  await open(page, (await fixtures()).tricky);
  await openPatterns(page);
  await panel(page).getByRole("textbox", { name: "Custom pattern" }).fill(TRICKY.custom);
  await settled(page);
  const email = panel(page).getByRole("checkbox", { name: "Redact Email: john@example.com" });
  await email.uncheck();
  const summary = panel(page).locator(".patterns__summary");
  const before = await summary.textContent();

  // The command picked again from the ⋯ menu, beside the open panel.
  await page.click('[aria-label="More actions"]');
  await page.locator(".menu__item", { hasText: "Redact patterns" }).click();
  await expect(email).not.toBeChecked();
  await expect(summary).toHaveText(before!);

  // Text typed before the email on its own line moves it along the line.
  await page.locator(".fragment", { hasText: "Patient" }).click();
  await page.keyboard.press("Home");
  await page.keyboard.type("Re ");
  await expect(panel(page).getByRole("checkbox", { name: "Redact Email: john@example.com" })).not.toBeChecked();
});

test("opening leaves the view where it was; Show always goes to the hit, the active one too", async ({ page }) => {
  await open(page, (await fixtures()).sample);
  const scroller = page.locator(".viewer__scroll");
  await scroller.evaluate((el) => (el.scrollTop = 2400));
  await page.waitForTimeout(300);
  const at = await scroller.evaluate((el) => el.scrollTop);
  await openPatterns(page);
  await expect(panel(page).locator(".patterns__hit").first()).toBeVisible();
  await page.waitForTimeout(600);
  expect(Math.abs((await scroller.evaluate((el) => el.scrollTop)) - at), "opening didn't move the page").toBeLessThan(2);

  const first = panel(page).locator(".patterns__show").first();
  await first.click();
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeLessThan(400);
  await scroller.evaluate((el) => (el.scrollTop = 5000));
  await first.click();
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop), { message: "Show on the active hit goes back to it" }).toBeLessThan(400);
});

test("closing hands focus back; a selection made beside the panel has its controls and its own Escape", async ({ page }) => {
  await open(page, (await fixtures()).personal);
  await page.click('[aria-label="More actions"]');
  await page.locator(".menu__item", { hasText: "Redact patterns" }).click();
  await expect(panel(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel(page)).toHaveCount(0);
  await expect(page.locator('[aria-label="More actions"]'), "focus isn't dropped on the page body").toBeFocused();

  // Redact one hit, then open the panel again and pick that redaction.
  await openPatterns(page);
  await panel(page).getByRole("button", { name: /^Redact \d+$/ }).click();
  await openPatterns(page);
  await page.locator(".redaction").first().click();
  await expect(page.locator(".selbar"), "the selection's controls show while the panel has the column").toBeVisible();
  await page.locator(".viewer__scroll").focus();
  await page.keyboard.press("Escape");
  await expect(page.locator(".selbar")).toHaveCount(0);
  await expect(panel(page), "the first Escape deselects; the panel stays").toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel(page)).toHaveCount(0);
});

test("on a phone the sheet never hides the hit it shows, and Back closes it", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  // The last hit of a long document: near the foot of its last page, where
  // the view can't scroll any further to bring it out from under the sheet
  // unless the sheet makes room for itself.
  await open(page, (await fixtures()).sample);
  await openPatterns(page);
  const rows = panel(page).locator(".patterns__show");
  await expect(rows.first()).toBeVisible();
  await rows.last().click();
  const sheet = (await panel(page).boundingBox())!;
  // The view scrolls smoothly across the whole document: wait for it to land.
  await expect
    .poll(
      async () => {
        const hit = await page.locator(".findhit--active").first().boundingBox();
        return hit ? hit.y + hit.height : Infinity;
      },
      { message: "the hit lands above the sheet", timeout: 6000 },
    )
    .toBeLessThanOrEqual(sheet.y + 0.5);

  await page.goBack();
  await expect(panel(page)).toHaveCount(0);
  await expect(page.locator(".page").first(), "Back closed the sheet, not the app").toBeVisible();
  await ctx.close();
});
