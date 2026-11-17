import { test, expect, type Page } from "@playwright/test";
import { fixtures } from "./fixtures";
import { open } from "./helpers";

/**
 * Two things a user reported as "the app broke":
 *
 * 1. The site was redeployed while their page was open. The next on-demand part
 *    (Compress) was a file the deploy had deleted; the failed import unmounted
 *    the whole app — a blank screen, the document gone. Now the part simply
 *    doesn't open, the document stays, and a banner offers a reload.
 * 2. Their file was a printed-to-PDF picture with no text in it, so clicking
 *    the words did nothing. Now the click says why and offers OCR.
 */

/** Make one on-demand part of the app 404, as a deploy that replaced it would. */
async function dropPart(page: Page, name: string): Promise<void> {
  await page.route(new RegExp(`/assets/${name}-[\\w-]{8}\\.js$`), (r) =>
    r.fulfill({ status: 404, contentType: "text/plain", body: "Not found" }),
  );
}

async function ocrAssetsReady(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    try {
      const res = await fetch("./tessdata/eng.traineddata.gz", { method: "HEAD" });
      return res.ok && !(res.headers.get("content-type") ?? "").includes("text/html");
    } catch {
      return false;
    }
  });
}

test.describe("App updated underneath an open page", () => {
  test("a part that's gone doesn't open, the document stays, and a reload is offered", async ({
    page,
  }) => {
    const f = await fixtures();
    await dropPart(page, "CompressDialog");
    await open(page, f.sample);

    // An edit worth keeping.
    await page.keyboard.press("t");
    await page.locator(".page").first().click({ position: { x: 200, y: 500 } });
    await page.keyboard.type("Kept through the update");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await expect(page.locator(".page").first()).toContainText("Kept through the update");

    await page.getByRole("button", { name: "Export options" }).click();
    await page.getByRole("menuitem", { name: /compress/i }).click();

    const banner = page.locator(".update-banner");
    await expect(banner).toBeVisible({ timeout: 10_000 });
    await expect(banner).toContainText("PDF Editor was updated");
    // The edit is on this device's autosave, so the banner says it comes back.
    await expect(banner).toContainText("saved on this device");

    // Nothing unmounted: the page, the edit and the shell are all still there,
    // and no modal is left half-open over them.
    await expect(page.locator('[role="dialog"][aria-label="Compress PDF"]')).toHaveCount(0);
    await expect(page.locator(".crash")).toHaveCount(0);
    await expect(page.locator(".page canvas").first()).toBeVisible();
    await expect(page.locator(".page").first()).toContainText("Kept through the update");

    // A part that *is* still there keeps working.
    await page.getByRole("button", { name: "Export options" }).click();
    await page.keyboard.press("Escape");

    // "Not now" is honoured.
    await banner.getByRole("button", { name: "Not now" }).click();
    await expect(banner).toHaveCount(0);
  });

  test("Reload stores the latest edit first, so it's offered back after", async ({ page }) => {
    const f = await fixtures();
    await dropPart(page, "CompressDialog");
    await open(page, f.sample);

    await page.keyboard.press("t");
    await page.locator(".page").first().click({ position: { x: 200, y: 500 } });
    await page.keyboard.type("Typed just before reloading");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");

    // No waiting out the autosave debounce: Reload must flush it.
    await page.getByRole("button", { name: "Export options" }).click();
    await page.getByRole("menuitem", { name: /compress/i }).click();
    await page.locator(".update-banner").getByRole("button", { name: "Reload" }).click();

    await page.waitForLoadState("load");
    await expect(page.locator(".restore-banner")).toBeVisible({ timeout: 15_000 });
  });
});

test.describe("Picture-only pages", () => {
  test("clicking one says why its text can't be edited, clear of the zoom pill", async ({
    page,
  }) => {
    const f = await fixtures();
    for (const width of [1280, 820]) {
      await page.setViewportSize({ width, height: 900 });
      await open(page, f.scanned);
      const hint = page.locator(".picturehint");
      await expect(hint).toHaveCount(0); // not before the user tries

      await page.locator(".page").first().click({ position: { x: 150, y: 150 } });
      await expect(hint).toBeVisible();
      await expect(hint).toContainText("This page is an image");
      await expect(hint.getByRole("button", { name: "Recognise text", exact: true })).toBeVisible();

      const a = (await hint.boundingBox())!;
      const z = (await page.locator(".zoombar").boundingBox())!;
      const overlap =
        a.x < z.x + z.width && z.x < a.x + a.width && a.y < z.y + z.height && z.y < a.y + a.height;
      expect(overlap, `hint overlaps the zoom pill at ${width}px`).toBe(false);
      // One line on a wide page area; never squeezed into a tall column.
      expect(a.height).toBeLessThan(80);

      await hint.getByRole("button", { name: "Dismiss" }).click();
      await expect(hint).toHaveCount(0);
      // Dismissed means dismissed for this document.
      await page.locator(".page").first().click({ position: { x: 150, y: 150 } });
      await expect(hint).toHaveCount(0);
    }
  });

  test("a page with real text never shows it", async ({ page }) => {
    await open(page, (await fixtures()).sample);
    await page.locator(".page").first().click({ position: { x: 20, y: 20 } });
    await page.waitForTimeout(300);
    await expect(page.locator(".picturehint")).toHaveCount(0);
  });

  test("Recognise text turns the picture into editable words", async ({ page }) => {
    test.slow();
    await page.goto("/");
    test.skip(!(await ocrAssetsReady(page)), "OCR assets absent — run `npm run setup-ocr`");
    await open(page, (await fixtures()).scanned);
    await expect(page.locator('.page [role="textbox"]')).toHaveCount(0);

    await page.locator(".page").first().click({ position: { x: 150, y: 150 } });
    await page
      .locator(".picturehint")
      .getByRole("button", { name: "Recognise text", exact: true })
      .click();
    await expect(page.locator(".snackbar__msg")).toContainText(/OCR added \d+ words/, {
      timeout: 180_000,
    });
    await expect(page.locator(".picturehint")).toHaveCount(0);
    expect(await page.locator('.page [role="textbox"]').count()).toBeGreaterThan(0);
  });
});
