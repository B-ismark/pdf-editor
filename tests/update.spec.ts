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

/** Add a text box on the first page and leave it. */
async function addText(page: Page, text: string): Promise<void> {
  await page.keyboard.press("t");
  await page.locator(".page").first().click({ position: { x: 200, y: 500 } });
  await page.keyboard.type(text);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
}

async function openCompress(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Export options" }).click();
  await page.getByRole("menuitem", { name: /compress/i }).click();
}

const overlaps = (
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

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

  test("the banner pushes the app down instead of covering it, and Reload asks nothing more", async ({
    page,
  }) => {
    const f = await fixtures();
    await dropPart(page, "CompressDialog");
    await open(page, f.sample);
    await addText(page, "Stored edit");
    const dialogs: string[] = [];
    page.on("dialog", (d) => {
      dialogs.push(d.type());
      void d.accept();
    });
    await openCompress(page);
    const banner = page.locator(".update-banner");
    await expect(banner).toBeVisible({ timeout: 10_000 });
    const b = (await banner.boundingBox())!;
    for (const sel of [".appbar", ".doctabs", ".zoombar"]) {
      const el = page.locator(sel).first();
      if (!(await el.isVisible())) continue;
      expect(overlaps(b, (await el.boundingBox())!), `banner covers ${sel}`).toBe(false);
    }
    // Stored on this device, as the banner says: no "Leave site?" on top.
    await banner.getByRole("button", { name: "Reload" }).click();
    await page.waitForLoadState("load");
    await expect(page.locator(".restore-banner")).toBeVisible({ timeout: 15_000 });
    expect(dialogs).toEqual([]);
  });

  test("a dropped connection isn't called an update", async ({ page }) => {
    const f = await fixtures();
    // The chunk exists (a fresh request for it succeeds); only the first
    // fetch fails, as on a flaky connection.
    let failed = false;
    await page.route(/\/assets\/CompressDialog-[\w-]{8}\.js$/, (r) => {
      if (!failed && r.request().method() === "GET") {
        failed = true;
        return r.abort("internetdisconnected");
      }
      return r.continue();
    });
    await open(page, f.sample);
    await openCompress(page);
    const banner = page.locator(".update-banner");
    await expect(banner).toBeVisible({ timeout: 10_000 });
    await expect(banner).toContainText("couldn't load");
    await expect(banner).not.toContainText("was updated");
    await expect(page.locator(".page canvas").first()).toBeVisible();
  });

  test("a part that fails for its own reasons doesn't claim an update", async ({ page }) => {
    const f = await fixtures();
    // The exporter's file is there but throws as it starts: a bug, not a deploy.
    await page.route(/\/assets\/exporter-[\w-]{8}\.js$/, (r) =>
      r.fulfill({ status: 200, contentType: "text/javascript", body: 'throw new TypeError("boom");' }),
    );
    await open(page, f.sample);
    await addText(page, "x");
    await page.locator(".appbar__download").click();
    await expect(page.locator(".snackbar__msg")).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(500);
    await expect(page.locator(".update-banner")).toHaveCount(0);
  });

  test("the crash screen stores the last edit before reloading, and doesn't over-promise", async ({
    page,
  }) => {
    const f = await fixtures();
    // A dialog whose code throws as it loads takes the app to the crash screen.
    await page.route(/\/assets\/CompressDialog-[\w-]{8}\.js$/, (r) =>
      r.fulfill({ status: 200, contentType: "text/javascript", body: 'throw new TypeError("boom");' }),
    );
    await open(page, f.sample);
    // Inside autosave's one-second wait: only a flush on Reload saves this.
    await addText(page, "Typed just before the crash");
    await openCompress(page);
    const crash = page.locator(".crash");
    await expect(crash).toBeVisible({ timeout: 10_000 });
    await expect(crash).toContainText("If “Save session on this device” is on");
    await crash.getByRole("button", { name: "Reload" }).click();
    await page.waitForLoadState("load");
    await expect(page.locator(".restore-banner")).toBeVisible({ timeout: 15_000 });
  });

  test("with saving on this device off, the banner says to download first", async ({ page }) => {
    const f = await fixtures();
    await page.addInitScript(() => localStorage.setItem("pref.autosave", "0"));
    await dropPart(page, "CompressDialog");
    await open(page, f.sample);
    await addText(page, "Only on this page");
    await openCompress(page);
    const banner = page.locator(".update-banner");
    await expect(banner).toBeVisible({ timeout: 10_000 });
    await expect(banner).toContainText("download it first");
    await expect(banner).not.toContainText("saved on this device");
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
      await expect(hint).toContainText("no text to edit");
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

  test("scrolling or dragging across a picture page doesn't raise it", async ({ page }) => {
    await open(page, (await fixtures()).scanned);
    const box = (await page.locator(".page").first().boundingBox())!;
    await page.mouse.move(box.x + 150, box.y + 150);
    await page.mouse.down();
    await page.mouse.move(box.x + 150, box.y + 260, { steps: 6 });
    await page.mouse.up();
    await page.mouse.click(box.x + 150, box.y + 150, { button: "right" });
    await page.waitForTimeout(300);
    await expect(page.locator(".picturehint")).toHaveCount(0);
  });

  test("dismissed stays dismissed after switching tabs", async ({ page }) => {
    const f = await fixtures();
    await open(page, f.scanned);
    const hint = page.locator(".picturehint");
    await page.locator(".page").first().click({ position: { x: 150, y: 150 } });
    await hint.getByRole("button", { name: "Dismiss" }).click();

    await page.setInputFiles('input[data-open-input]', f.sample);
    await expect(page.locator(".doctab")).toHaveCount(2, { timeout: 30_000 });
    await page.locator(".doctab").first().locator(".doctab__btn").click();
    await page.waitForSelector(".page canvas");
    await page.waitForTimeout(400);
    await page.locator(".page").first().click({ position: { x: 150, y: 150 } });
    await page.waitForTimeout(300);
    await expect(hint).toHaveCount(0);
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
