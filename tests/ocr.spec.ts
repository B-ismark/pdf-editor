import { test, expect, type Page } from "@playwright/test";
import { fixtures, SCANNED_WORDS } from "./fixtures";
import { open, watch } from "./helpers";

/**
 * On-device OCR, end to end.
 *
 * Skipped rather than failed when the assets aren't installed, so the suite still
 * runs on a checkout that hasn't run `npm run setup-ocr`. CI runs that step, so
 * these do execute there.
 */
/** True when `npm run setup-ocr` has been run, so OCR can actually execute. */
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

/** Run OCR from the overflow menu and wait for the terminal snackbar. */
async function runOcr(page: Page): Promise<void> {
  await page.click('[aria-label="More actions"]');
  await page.locator('[role="menuitem"]', { hasText: "OCR" }).click();
  await expect(page.locator(".snackbar__msg")).toContainText(/OCR added \d+ words/, {
    timeout: 180_000,
  });
}

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

  /**
   * The wasm core has fixed filenames and GitHub Pages serves everything with
   * `Cache-Control: max-age=600`, so without `public/sw.js` a returning user
   * re-downloads ~1.4 MB of engine every ten minutes. tesseract.js already keeps
   * the language model in IndexedDB; this is the equivalent for the core.
   *
   * The second half of this test is the one that matters most. A service worker
   * is the only part of this app that keeps running with visibility into
   * requests, so "it caches the engine" is worth far less than "it caches
   * *nothing else*" — - not the app shell, and above all not the user's document.
   */
  test("the wasm core is cached for next time, and nothing else is", async ({ page }) => {
    test.slow(); // two full engine boots and a recognition pass each
    await page.goto("/");
    test.skip(!(await ocrAssetsReady(page)), "OCR assets absent — run `npm run setup-ocr`");

    await open(page, (await fixtures()).scanned);
    await runOcr(page);

    // Everything the service worker has stored, by path.
    const cached = await page.evaluate(async () => {
      const names = await caches.keys();
      const paths: string[] = [];
      for (const name of names) {
        const cache = await caches.open(name);
        for (const req of await cache.keys()) paths.push(new URL(req.url).pathname);
      }
      return { names, paths };
    });

    expect(cached.names.filter((n) => n.startsWith("ocr-core-"))).toHaveLength(1);
    expect(
      cached.paths.some((p) => /\/tesseract\/tesseract-core-.*-lstm\.wasm\.js$/.test(p)),
      `cached: ${cached.paths.join(", ")}`,
    ).toBe(true);
    // The whole privacy argument for allowing a service worker at all.
    expect(
      cached.paths.filter((p) => !p.includes("/tesseract/")),
      "the engine cache must hold engine assets and nothing else",
    ).toEqual([]);

    // Now the next visit. Asserting "no network response for the core" does not
    // work: Playwright attributes the service worker's *own* `fetch()` to the
    // worker too, so `fromServiceWorker()` is true either way and the check
    // passes even against a worker that never reads its cache (verified).
    // So make the network unable to supply the core and require the run to
    // succeed regardless — the only way it can is from the cache.
    await page.context().route(/tesseract-core-.*\.wasm\.js/, (route) => route.abort());
    await page.reload();
    await open(page, (await fixtures()).scanned);
    await runOcr(page);
  });

  /**
   * The cached engine is on-device storage, so "Save session on this device" has
   * to cover it. A switch that stops saving the document but silently leaves
   * 1.4 MB of wasm behind is a switch that lies.
   *
   * The second half is the part that's easy to get wrong: `unregister()` does not
   * stop an already-active worker from serving open pages, so without the
   * stand-down message the engine would be written straight back by the very next
   * OCR run in the same tab.
   */
  test("turning off the session copy erases the cached engine, and stops it coming back", async ({
    page,
  }) => {
    test.slow();
    await page.goto("/");
    test.skip(!(await ocrAssetsReady(page)), "OCR assets absent — run `npm run setup-ocr`");

    const engineCaches = () =>
      page.evaluate(async () => (await caches.keys()).filter((n) => n.startsWith("ocr-core-")));

    await open(page, (await fixtures()).scanned);
    await runOcr(page);
    expect(await engineCaches(), "the engine should be cached to begin with").toHaveLength(1);

    // Switch off the on-device copy.
    await page.click('[aria-label="More actions"]');
    await page.locator('[role="menuitemcheckbox"]', { hasText: "Save session" }).click();

    await expect
      .poll(engineCaches, { timeout: 15_000 })
      .toHaveLength(0);
    await expect
      .poll(async () => page.evaluate(() => navigator.serviceWorker.getRegistrations().then((r) => r.length)), {
        timeout: 15_000,
      })
      .toBe(0);

    // Still switched off, same tab, worker still controlling: a further OCR run
    // must not re-create the cache.
    await runOcr(page);
    expect(
      await engineCaches(),
      "OCR re-cached the engine after on-device storage was switched off",
    ).toHaveLength(0);
  });
});
