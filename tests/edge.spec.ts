import { test, expect, type Page } from "@playwright/test";
import { fixtures } from "./fixtures";
import { open, pickTool } from "./helpers";

/**
 * The exported page ends at its MediaBox: anything past it is cut off in the
 * file. These pin the preview to that — objects stop at the edge, and typed
 * text that runs over is marked rather than shown as if it would print.
 */

async function drag(page: Page, from: { x: number; y: number }, dx: number, dy: number) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 12 });
  await page.mouse.up();
}

test("a stamp dragged past the page edge stops at it", async ({ page }) => {
  await open(page, (await fixtures()).sample);
  await page.getByRole("button", { name: /^Sign/ }).first().click();
  await page.getByRole("button", { name: "Type", exact: true }).click();
  await page.getByPlaceholder("Type your name").fill("Jo Smith");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  const pg = (await page.locator(".page").first().boundingBox())!;
  await page.mouse.click(pg.x + pg.width / 2, pg.y + 200);
  const stamp = page.locator(".stamp");
  const sb = (await stamp.boundingBox())!;
  await drag(page, { x: sb.x + sb.width / 2, y: sb.y + sb.height / 2 }, pg.width, 0);
  const after = (await stamp.boundingBox())!;
  expect(after.x + after.width).toBeLessThanOrEqual(pg.x + pg.width + 1);
  // …and it got there: stopped at the edge, not left where it started.
  expect(after.x + after.width).toBeGreaterThan(pg.x + pg.width - 3);
});

test("a text box dragged past the page edge stops at it", async ({ page }) => {
  await open(page, (await fixtures()).sample);
  await pickTool(page, "Add text");
  const pg = (await page.locator(".page").first().boundingBox())!;
  await page.mouse.click(pg.x + pg.width / 2, pg.y + 200);
  await page.keyboard.type("Signed here");
  await page.keyboard.press("Escape");
  const tb = page.locator(".textbox").first();
  const move = page.locator(".tb-move").first();
  await tb.click();
  await expect(move).toBeVisible();
  const mb = (await move.boundingBox())!;
  await drag(page, { x: mb.x + mb.width / 2, y: mb.y + mb.height / 2 }, pg.width, 0);
  const after = (await tb.boundingBox())!;
  expect(after.x + after.width).toBeLessThanOrEqual(pg.x + pg.width + 1);
  // …and it got there: a drag that did nothing would pass the line above.
  expect(after.x + after.width).toBeGreaterThan(pg.x + pg.width - 6);
});

test("an edit that runs past the edge is marked, said once, and doesn't widen the page", async ({ page }) => {
  await open(page, (await fixtures()).sample);
  const scroll = page.locator(".viewer__scroll");
  const before = await scroll.evaluate((el) => el.scrollWidth);
  const frag = page.locator(".fragment").first();
  await frag.click();
  await page.keyboard.press("End");
  await expect(frag).not.toHaveClass(/is-spill/);
  await page.keyboard.type(" and a long run of extra words that goes well past the right edge of the page");
  await expect(frag).toHaveClass(/is-spill/);
  await expect(page.locator(".snackbar__msg")).toContainText("Text runs past the page edge");
  expect(await scroll.evaluate((el) => el.scrollWidth)).toBeLessThanOrEqual(before + 1);
  // Bringing it back inside clears the mark.
  await page.keyboard.press("ControlOrMeta+z");
  await expect(frag).not.toHaveClass(/is-spill/);
});
