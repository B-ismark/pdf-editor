import { test, expect } from "@playwright/test";
import { fixtures, SCANNED_WORDS } from "./fixtures";
import { open, watch } from "./helpers";

/**
 * On-device OCR, end to end.
 *
 * Skipped rather than failed when the assets aren't installed, so the suite still
 * runs on a checkout that hasn't run `npm run setup-ocr`. CI runs that step, so
 * these do execute there.
 */
test.describe("OCR", () => {
  test("recognises a scan, from same-origin assets only, and makes it findable", async ({
    page,
  }) => {
    test.slow(); // engine start-up plus a full-page recognition pass
    const w = watch(page);

    await page.goto("/");
    const assetsReady = await page.evaluate(async () => {
      try {
        const res = await fetch("./tessdata/eng.traineddata.gz", { method: "HEAD" });
        return res.ok && !(res.headers.get("content-type") ?? "").includes("text/html");
      } catch {
        return false;
      }
    });
    test.skip(!assetsReady, "OCR assets absent — run `npm run setup-ocr`");

    await open(page, (await fixtures()).scanned);
    // The premise: nothing to find until OCR runs.
    await expect(page.locator('.page [role="textbox"]')).toHaveCount(0);

    await page.click('[aria-label="More actions"]');
    await page.locator('[role="menuitem"]', { hasText: "OCR" }).click();
    await expect(page.locator(".snackbar__msg")).toContainText(/OCR added \d+ words/, {
      timeout: 180_000,
    });

    const words = await page.evaluate(() =>
      [...document.querySelectorAll('.page [role="textbox"]')]
        .map((e) => e.textContent?.trim())
        .filter(Boolean),
    );
    expect(words).toEqual(expect.arrayContaining(SCANNED_WORDS));

    // The whole point of the layer: the scan is now searchable (and redactable).
    await page.keyboard.press("Control+f");
    await page.locator(".findbar input").fill(SCANNED_WORDS[0]);
    await expect(page.locator(".findbar")).toContainText("1/1");

    // The engine, the wasm core and the language model must all come from us —
    // that is the difference between on-device OCR and uploading the page.
    expect(w.external, `off-origin: ${w.external.join(", ")}`).toEqual([]);
    expect(w.errors, `errors: ${w.errors.slice(0, 3).join(" | ")}`).toEqual([]);
    expect(
      w.requests.filter((u) => /tesseract|tessdata/.test(u)).length,
      "OCR assets were actually fetched",
    ).toBeGreaterThan(0);
  });
});
