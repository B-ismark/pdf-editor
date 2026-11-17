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

test("a right-click while placing doesn't drop the signature", async ({ page }) => {
  await open(page, (await fixtures()).sample);
  await armSignature(page);
  const pg = (await page.locator(".page").first().boundingBox())!;
  await page.mouse.click(pg.x + pg.width / 2, pg.y + 200, { button: "right" });
  await expect(page.locator(".stamp")).toHaveCount(0);
  await expect(page.locator(".placelayer").first()).toBeAttached();
});

test("duplicating or group-moving a stamp at the edge keeps it on the page", async ({ page }) => {
  await open(page, (await fixtures()).sample);
  const pg = (await page.locator(".page").first().boundingBox())!;
  await armSignature(page);
  await page.mouse.click(pg.x + pg.width - 3, pg.y + 200);
  // Duplicate offsets the copy; at the right edge that pushed it off.
  await page.locator(".stamp").first().click();
  await page.keyboard.press("ControlOrMeta+d");
  await expect(page.locator(".stamp")).toHaveCount(2);
  for (const b of await page.locator(".stamp").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().right))) {
    expect(b).toBeLessThanOrEqual(pg.x + pg.width + 1);
  }
  // A second stamp in the middle; marquee both and nudge right as a group.
  await armSignature(page);
  await page.mouse.click(pg.x + pg.width / 2, pg.y + 420);
  await page.keyboard.press("Escape");
  await page.mouse.move(pg.x + 8, pg.y + 120);
  await page.mouse.down();
  await page.mouse.move(pg.x + pg.width - 8, pg.y + 520, { steps: 10 });
  await page.mouse.up();
  await expect(page.locator(".multibar, [data-multi]").first()).toBeVisible();
  const mid = page.locator(".stamp").nth(2);
  const before = (await mid.boundingBox())!;
  for (let i = 0; i < 5; i++) await page.keyboard.press("Shift+ArrowRight");
  for (const r of await page.locator(".stamp").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().right))) {
    expect(r).toBeLessThanOrEqual(pg.x + pg.width + 1);
  }
  // The group moved as a block: it stopped when its first stamp hit the edge,
  // so the middle one didn't run on by itself.
  expect(Math.abs((await mid.boundingBox())!.x - before.x)).toBeLessThan(3);
});
