import { test, expect } from "@playwright/test";
import { fixtures } from "./fixtures";
import { open, watch, expectClean } from "./helpers";

/**
 * The product's central promise: the document never leaves the device.
 *
 * These assert it as observable behaviour rather than as an intention. A CDN font
 * link shipped for months against a written rule forbidding exactly that, so the
 * rule needed to become something a test can fail on.
 */
test.describe("privacy", () => {
  test("opening a document makes no off-origin request", async ({ page }) => {
    const w = watch(page);
    await open(page, (await fixtures()).sample);
    expectClean(w);
  });

  test("no off-origin stylesheet, font, or preconnect is referenced", async ({ page }) => {
    await page.goto("/");
    // `link.href` is always absolute, so compare origins — a same-origin bundled
    // stylesheet is expected, anything else is not.
    const offOrigin = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLLinkElement>("link[href]")]
        .map((l) => new URL(l.href, location.href))
        .filter((u) => u.origin !== location.origin)
        .map((u) => u.href),
    );
    expect(offOrigin).toEqual([]);
  });

  test("the CSP is present and restrictive", async ({ page }) => {
    await page.goto("/");
    const csp = await page.evaluate(
      () =>
        document.querySelector<HTMLMetaElement>('meta[http-equiv="Content-Security-Policy"]')
          ?.content ?? "",
    );
    expect(csp).toContain("default-src 'self'");
    // The directive that actually prevents the document being uploaded.
    expect(csp).toMatch(/connect-src 'self'/);
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    // A widened script policy would silently undo the rest.
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-eval'(?!.)/);
  });

  test("autosave stores a session locally, and the toggle erases it", async ({ page }) => {
    await open(page, (await fixtures()).sample);

    // Make a change so there is something worth persisting.
    await page.locator('.tooldock__btn[aria-label="Redact"]').click();
    const box = (await page.locator(".page").first().boundingBox())!;
    await page.mouse.move(box.x + 60, box.y + 300);
    await page.mouse.down();
    await page.mouse.move(box.x + 300, box.y + 340, { steps: 6 });
    await page.mouse.up();

    const keys = () =>
      page.evaluate(
        () =>
          new Promise<string[]>((resolve) => {
            const req = indexedDB.open("pdf-editor", 1);
            req.onsuccess = () => {
              const tx = req.result.transaction("session", "readonly");
              const all = tx.objectStore("session").getAllKeys();
              all.onsuccess = () => resolve(all.result as string[]);
              tx.onerror = () => resolve(["<error>"]);
            };
            req.onerror = () => resolve(["<no db>"]);
          }),
      );

    await expect.poll(keys, { timeout: 15_000 }).toHaveLength(2);

    // Turning the copy off must delete what's already stored — a switch that only
    // stopped future writes would leave the document on the device.
    await page.click('[aria-label="More actions"]');
    await page.locator('[role="menuitemcheckbox"]', { hasText: "Save session" }).click();
    await expect.poll(keys, { timeout: 15_000 }).toHaveLength(0);
  });
});
