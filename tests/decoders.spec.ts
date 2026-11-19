import { test, expect, type Page } from "@playwright/test";
import { CODECS, fixtures } from "./fixtures";
import { open, watch } from "./helpers";

/**
 * Scans and JPEG 2000 images paint.
 *
 * pdf.js 5 decodes fax-coded scans (`CCITTFaxDecode`, and JBIG2 with them) and
 * JPEG 2000 with WebAssembly modules it fetches at runtime from `wasmUrl`
 * rather than with script in its worker as pdf.js 4 did. Left unset, the fetch
 * fails, the fallback (fetched from the same place) fails too, and the image is
 * quietly not painted: a scanned contract opens as a blank page. The modules
 * ship with the app, from its own origin.
 */

/** The page canvas' colour at a point given in PDF units (origin bottom-left). */
function pixelAt(page: Page, x: number, y: number) {
  return page.locator(".page canvas").first().evaluate(
    (c, [x, y, w, h]) => {
      const canvas = c as HTMLCanvasElement;
      const sx = canvas.width / w;
      const sy = canvas.height / h;
      const d = canvas.getContext("2d")!.getImageData(Math.round(x * sx), Math.round((h - y) * sy), 1, 1).data;
      return [d[0], d[1], d[2]];
    },
    [x, y, CODECS.page.width, CODECS.page.height],
  );
}

test("a fax-coded scan and a JPEG 2000 image paint, decoded from the app's own files", async ({ page, context }) => {
  const w = watch(page);
  const wasm: string[] = [];
  // The context, not the page: these are fetched by pdf.js's worker.
  context.on("request", (r) => {
    if (/\.wasm(\?|$)|nowasm_fallback/.test(r.url())) wasm.push(r.url());
  });
  const f = await fixtures();
  await open(page, f.codecs);

  const { ccitt: a, jpx: b, red } = CODECS;
  // The scan's middle is its black square; its edge is white paper.
  await expect.poll(() => pixelAt(page, a.x + a.size / 2, a.y + a.size / 2), { timeout: 10_000 }).toEqual([0, 0, 0]);
  expect(await pixelAt(page, a.x + 8, a.y + 8)).toEqual([255, 255, 255]);
  // The JPEG 2000 is red all over.
  const px = await pixelAt(page, b.x + b.size / 2, b.y + b.size / 2);
  for (let i = 0; i < 3; i++) expect(Math.abs(px[i] - red[i]), `channel ${i} of ${px}`).toBeLessThan(6);

  // From this origin, and only the decoders actually needed.
  const origin = new URL(page.url()).origin;
  expect(wasm.length).toBeGreaterThan(0);
  for (const u of wasm) expect(new URL(u).origin).toBe(origin);
  expect(wasm.some((u) => u.includes("nowasm_fallback")), "the WebAssembly loaded; no script fallback").toBe(false);
  expect(w.external).toEqual([]);
  expect(w.errors).toEqual([]);
});

test("a browser without the newest built-ins still opens a file", async ({ page }) => {
  // pdf.js 5's modern build calls these unguarded — on the page and in its
  // worker — and only the newest browsers have them: elsewhere every file
  // failed to open. The app uses the legacy build, which brings its own.
  const strip = `
    delete Uint8Array.prototype.toHex; delete Uint8Array.prototype.toBase64;
    delete Uint8Array.fromHex; delete Uint8Array.fromBase64;
    delete Promise.try; delete Math.sumPrecise;
    delete Map.prototype.getOrInsertComputed; delete Map.prototype.getOrInsert;
    delete WeakMap.prototype.getOrInsertComputed; delete WeakMap.prototype.getOrInsert;
  `;
  await page.addInitScript(strip);
  await page.route(/pdf\.worker[^/]*\.mjs$/, async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, body: strip + (await res.text()) });
  });
  const w = watch(page);
  const f = await fixtures();
  await open(page, f.sample);
  await expect(page.locator(".fragment").first()).toBeVisible();
  expect(
    await page.locator(".page canvas").first().evaluate((c) => {
      const canvas = c as HTMLCanvasElement;
      const d = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
      for (let i = 0; i < d.length; i += 4) if (d[i] < 128) return true;
      return false;
    }),
    "the page painted its text",
  ).toBe(true);
  expect(w.errors).toEqual([]);
});
