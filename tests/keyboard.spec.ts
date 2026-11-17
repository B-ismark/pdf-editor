import { test, expect, type Page } from "@playwright/test";
import { fixtures } from "./fixtures";
import { open } from "./helpers";

/** What has focus, in a form a failure message can show. */
const focused = (page: Page) =>
  page.evaluate(() => {
    const a = document.activeElement as HTMLElement | null;
    return { cls: a?.className ?? "", label: a?.getAttribute("aria-label") ?? a?.textContent?.slice(0, 20) ?? "" };
  });

test("Tab reaches the tools after one stop per page, not every fragment", async ({ page }) => {
  await open(page, (await fixtures()).sample);
  await page.locator(".appbar").click({ position: { x: 2, y: 2 } });
  let fragments = 0;
  let reached = false;
  for (let i = 0; i < 80 && !reached; i++) {
    await page.keyboard.press("Tab");
    const f = await focused(page);
    if (f.cls.split(" ").includes("fragment")) fragments++;
    reached = f.cls.includes("tooldock__btn");
  }
  expect(reached, "Tab never reached the tool dock").toBe(true);
  // One stop per page that has rendered its text — not per page in the file,
  // most of which are windowed out and have no fragments at all.
  const rendered = await page.locator(".page:has(.fragment[tabindex])").count();
  expect(rendered).toBeGreaterThan(0);
  expect(fragments).toBeGreaterThan(0);
  expect(fragments).toBeLessThanOrEqual(rendered);
});

test("Skip to tools is the first Tab stop and lands on the active tool", async ({ page }) => {
  await open(page, (await fixtures()).sample);
  await page.getByRole("button", { name: "Redact" }).first().click();
  // Start from the top of the page, as a fresh visit would.
  await page.evaluate(() => {
    const b = document.body;
    b.tabIndex = -1;
    b.focus();
    b.removeAttribute("tabindex");
  });
  await page.keyboard.press("Tab");
  const skip = page.getByRole("button", { name: "Skip to tools" });
  await expect(skip).toBeFocused();
  await expect(skip).toBeInViewport();
  await page.keyboard.press("Enter");
  const f = await focused(page);
  expect(f.cls).toContain("tooldock__btn--on");
  expect(f.label).toMatch(/Redact/);
});

test("arrow keys walk the fragments; Tab leaves from the one you were on", async ({ page }) => {
  await open(page, (await fixtures()).sample);
  const frags = page.locator('.page[data-page-index="0"] .fragment');
  await frags.first().focus();
  await page.keyboard.press("ArrowDown");
  await expect(frags.nth(1)).toBeFocused();
  // Right at the end of a fragment carries on into the next.
  await page.keyboard.press("End");
  await page.keyboard.press("ArrowRight");
  await expect(frags.nth(2)).toBeFocused();
  // Left at its start comes back, caret at the end.
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowLeft");
  await expect(frags.nth(1)).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(frags.first()).toBeFocused();
  // Only one fragment per page is in the Tab order, and it follows you.
  await page.keyboard.press("ArrowDown");
  await expect(frags.nth(1)).toHaveAttribute("tabindex", "0");
  await expect(frags.first()).toHaveAttribute("tabindex", "-1");
  expect(await page.locator('.page[data-page-index="0"] .fragment[tabindex="0"]').count()).toBe(1);
});

test("arrowing away from the selected fragment takes the selection along", async ({ page }) => {
  await open(page, (await fixtures()).sample);
  const frags = page.locator('.page[data-page-index="0"] .fragment');
  await frags.first().click();
  await page.keyboard.press("ArrowDown");
  await expect(frags.nth(1)).toBeFocused();
  // The selection cover sits right before its fragment; it must have followed,
  // or the Inspector styles one fragment while you type in another.
  const selectedId = await page.evaluate(
    () => (document.querySelector(".fragment__cover--sel")?.nextElementSibling as HTMLElement | null)?.dataset.id,
  );
  expect(selectedId).toBe(await frags.nth(1).getAttribute("data-id"));
});

test("the zoom pill names the page and goes to one", async ({ page }) => {
  await open(page, (await fixtures()).sample);
  const pages = await page.locator(".page").count();
  const chip = page.locator(".zoombar__page");
  await expect(chip).toHaveText(`1 / ${pages}`);
  await chip.click();
  const field = page.getByRole("textbox", { name: /Go to page/ });
  await expect(field).toBeFocused();
  await page.keyboard.type("7");
  await page.keyboard.press("Enter");
  await expect(page.locator('.page[data-page-index="6"]')).toBeInViewport({ ratio: 0.4 });
  await expect(chip).toHaveText(`7 / ${pages}`);
  // Closing the field hands focus back to the chip, not to <body>.
  await expect(chip).toBeFocused();
  // Out of range means "the end", not an error.
  await chip.click();
  await page.keyboard.type("999");
  await page.keyboard.press("Enter");
  await expect(chip).toHaveText(`${pages} / ${pages}`);
  // Esc puts the chip back without moving.
  await chip.click();
  await page.keyboard.type("1");
  await page.keyboard.press("Escape");
  await expect(chip).toHaveText(`${pages} / ${pages}`);
  await expect(chip).toBeFocused();
});

test("Go to page… from the command palette opens the same field", async ({ page }) => {
  await open(page, (await fixtures()).sample);
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type("go to page");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("textbox", { name: /Go to page/ })).toBeFocused();
});
