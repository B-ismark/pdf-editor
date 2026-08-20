import { expect, test, type Page } from "@playwright/test";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtures } from "./fixtures";
import { expectClean, open, pickTool, watch } from "./helpers";

/**
 * Tick and cross marks — the tools for filling in a form.
 *
 * Two things are worth holding still here and neither is visible in the types.
 * The first is the *gesture*: every other draw sub-tool needs a drag, and a
 * checkbox is smaller than the drag threshold, so a mark that only appeared on
 * drag would be unusable for the one job it exists for. The second is that the
 * glyph is drawn three times over — SVG overlay, pdf-lib vector export, and the
 * canvas that rasterises a redacted page — from one definition in `pdf/marks.ts`.
 * A spec that only checked the overlay would pass against an exporter that drew
 * nothing at all.
 */

/** Fraction of non-paper pixels in an overlay-relative rect of the first page.
 * Deliberately "differs from white" rather than "is dark": the default draw
 * colour is amber, and a darkness test scores it the same as blank paper —
 * which is how the first draft of this spec reported a working exporter as
 * broken. */
async function inkShare(
  page: Page,
  rect: { x: number; y: number; w: number; h: number },
): Promise<number> {
  return page.evaluate(({ x, y, w, h }) => {
    const canvas = document.querySelector<HTMLCanvasElement>(".page canvas")!;
    const overlay = canvas.closest(".page") as HTMLElement;
    // The canvas backing store is larger than its CSS box on a HiDPI raster.
    const sx = canvas.width / overlay.clientWidth;
    const sy = canvas.height / overlay.clientHeight;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    const d = ctx.getImageData(
      Math.round(x * sx),
      Math.round(y * sy),
      Math.max(1, Math.round(w * sx)),
      Math.max(1, Math.round(h * sy)),
    ).data;
    let marked = 0;
    for (let i = 0; i < d.length; i += 4) {
      const off = Math.max(255 - d[i], 255 - d[i + 1], 255 - d[i + 2]);
      if (off > 40) marked++;
    }
    return marked / (d.length / 4);
  }, rect);
}

/** Download the current document and save it where the app can reopen it. */
async function exportTo(page: Page): Promise<string> {
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 120_000 }),
    page.click(".appbar__download"),
  ]);
  const bytes = readFileSync((await download.path())!);
  const path = join(mkdtempSync(join(tmpdir(), "marks-")), "out.pdf");
  writeFileSync(path, bytes);
  return path;
}

/**
 * Find a blank patch of the first page that is inside the viewport and clear of
 * the floating tool dock. Hard-coding a spot is how the first draft of this
 * spec failed: 82% down the page is under the dock on a 720px window, so every
 * click went to the toolbar instead of the document.
 */
async function blankSpot(page: Page): Promise<{ x: number; y: number }> {
  const box = (await page.locator(".page").first().boundingBox())!;
  const dock = (await page.locator(".tooldock").boundingBox())!;
  const size = 34;
  for (let y = 120; y < Math.min(box.height, dock.y - box.y - size * 2); y += 30) {
    for (let x = 40; x < box.width - size; x += 40) {
      const ink = await inkShare(page, { x: x - size / 2, y: y - size / 2, w: size, h: size });
      if (ink < 0.002) return { x, y };
    }
  }
  throw new Error("no blank patch found on the fixture page");
}

/** Pick one of the Draw sub-tools from the contextual toolbar. */
async function pickMark(page: Page, label: string): Promise<void> {
  await pickTool(page, "Draw");
  await page.locator(`#drawbar .icon-btn[aria-label="${label}"]`).click();
}

test("a tick is placed by a tap, not a drag, and reaches the exported page", async ({ page }) => {
  const w = watch(page);
  const f = await fixtures();
  await open(page, f.sample);

  const box = (await page.locator(".page").first().boundingBox())!;
  const spot = await blankSpot(page);
  const region = { x: spot.x - 14, y: spot.y - 14, w: 28, h: 28 };
  const before = await inkShare(page, region);

  await pickMark(page, "Tick");
  // A single click — no movement between down and up.
  await page.mouse.click(box.x + spot.x, box.y + spot.y);

  await expect(page.locator(".page").first().locator(".annot-svg polyline")).toHaveCount(1);

  const path = await exportTo(page);
  await open(page, path);
  const after = await inkShare(page, region);

  expect(after, "the tick is in the exported file, not just the overlay").toBeGreaterThan(before + 0.01);
  expectClean(w);
});

test("a cross draws both strokes and a drag sizes the mark", async ({ page }) => {
  const w = watch(page);
  const f = await fixtures();
  await open(page, f.sample);

  const box = (await page.locator(".page").first().boundingBox())!;
  const spot = await blankSpot(page);
  await pickMark(page, "Cross");

  // Tap: default size.
  await page.mouse.click(box.x + spot.x, box.y + spot.y);
  // Drag: a deliberately larger box, well clear of the first.
  await page.mouse.move(box.x + spot.x + 90, box.y + spot.y - 30);
  await page.mouse.down();
  await page.mouse.move(box.x + spot.x + 170, box.y + spot.y + 30, { steps: 8 });
  await page.mouse.up();

  const marks = page.locator(".page").first().locator(".annot-svg polyline");
  // Two strokes per cross, two crosses.
  await expect(marks).toHaveCount(4);

  const boxes = await marks.evaluateAll((els) =>
    els.map((e) => (e as SVGGraphicsElement).getBBox().width),
  );
  const tapped = Math.max(boxes[0], boxes[1]);
  const dragged = Math.max(boxes[2], boxes[3]);
  expect(dragged, "a drag sizes the mark rather than being ignored").toBeGreaterThan(tapped * 1.5);
  expectClean(w);
});

test("a placed mark can be selected and resized like any other box", async ({ page }) => {
  const w = watch(page);
  const f = await fixtures();
  await open(page, f.sample);

  const box = (await page.locator(".page").first().boundingBox())!;
  const spot = await blankSpot(page);
  await pickMark(page, "Tick");
  await page.mouse.click(box.x + spot.x, box.y + spot.y);

  await pickTool(page, "Select");
  await page.mouse.click(box.x + spot.x, box.y + spot.y);

  // Box annotations get the HTML resize/rotate frame; a mark that fell out of
  // `isBoxAnnotation` would still render but silently lose its handles.
  await expect(page.locator(".handle").first()).toBeVisible();
  expectClean(w);
});
