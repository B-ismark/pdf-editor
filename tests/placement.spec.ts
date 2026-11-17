import { test, expect, type Page } from "@playwright/test";
import { fixtures } from "./fixtures";
import { open } from "./helpers";

/** Type a signature and arm it for placement. */
async function armSignature(page: Page) {
  await page.getByRole("button", { name: /^Sign/ }).first().click();
  await page.getByRole("button", { name: "Type", exact: true }).click();
  await page.getByPlaceholder("Type your name").fill("Jo Smith");
  await page.getByRole("button", { name: "Add", exact: true }).click();
}

test("a signature lands on text: the click places it, centred, and doesn't select the fragment", async ({ page }) => {
  await open(page, (await fixtures()).sample);
  await armSignature(page);
  const frag = page.locator(".fragment").nth(3);
  const fb = (await frag.boundingBox())!;
  const cx = fb.x + fb.width / 2;
  const cy = fb.y + fb.height / 2;
  // A pointer sees where it would land before committing.
  await page.mouse.move(cx, cy);
  const ghost = page.locator(".placelayer__ghost");
  await expect(ghost).toBeVisible();
  const gb = (await ghost.boundingBox())!;
  await page.mouse.click(cx, cy);
  const stamp = page.locator(".stamp");
  await expect(stamp).toHaveCount(1);
  const sb = (await stamp.boundingBox())!;
  // Centred on the click, and exactly where the ghost promised.
  expect(Math.abs(sb.x + sb.width / 2 - cx)).toBeLessThan(2);
  expect(Math.abs(sb.y + sb.height / 2 - cy)).toBeLessThan(2);
  expect(Math.abs(sb.x - gb.x)).toBeLessThan(2);
  expect(Math.abs(sb.y - gb.y)).toBeLessThan(2);
  await expect(page.locator(".fragment[contenteditable=true]:focus")).toHaveCount(0);
  await expect(page.locator(".placelayer")).toHaveCount(0);
});

test("a signature placed at the page edge stays on the page", async ({ page }) => {
  await open(page, (await fixtures()).sample);
  await armSignature(page);
  const pg = (await page.locator(".page").first().boundingBox())!;
  await page.mouse.click(pg.x + pg.width - 3, pg.y + 200);
  const sb = (await page.locator(".stamp").boundingBox())!;
  expect(sb.x + sb.width).toBeLessThanOrEqual(pg.x + pg.width + 0.5);
  expect(sb.x).toBeGreaterThanOrEqual(pg.x - 0.5);
});

test("Esc backs out of placing", async ({ page }) => {
  await open(page, (await fixtures()).sample);
  await armSignature(page);
  await expect(page.locator(".placelayer").first()).toBeAttached();
  await page.keyboard.press("Escape");
  await expect(page.locator(".placelayer")).toHaveCount(0);
  const pg = (await page.locator(".page").first().boundingBox())!;
  await page.mouse.click(pg.x + pg.width / 2, pg.y + 200);
  await expect(page.locator(".stamp")).toHaveCount(0);
});
