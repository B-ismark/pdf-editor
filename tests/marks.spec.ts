import { expect, test, type Page } from "@playwright/test";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtures } from "./fixtures";
import { expectClean, open, pickSubTool, pickTool, watch } from "./helpers";

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

/** Tight bounding box of the non-paper pixels in an overlay-relative rect,
 * returned in CSS pixels. */
async function inkBox(
  page: Page,
  rect: { x: number; y: number; w: number; h: number },
): Promise<{ w: number; h: number } | null> {
  return page.evaluate(({ x, y, w, h }) => {
    const canvas = document.querySelector<HTMLCanvasElement>(".page canvas")!;
    const overlay = canvas.closest(".page") as HTMLElement;
    const sx = canvas.width / overlay.clientWidth;
    const sy = canvas.height / overlay.clientHeight;
    const d = canvas.getContext("2d", { willReadFrequently: true })!.getImageData(
      Math.round(x * sx), Math.round(y * sy),
      Math.round(w * sx), Math.round(h * sy),
    );
    let mnX = Infinity, mxX = -1, mnY = Infinity, mxY = -1;
    for (let py = 0; py < d.height; py++) {
      for (let px = 0; px < d.width; px++) {
        const i = (py * d.width + px) * 4;
        const off = Math.max(255 - d.data[i], 255 - d.data[i + 1], 255 - d.data[i + 2]);
        if (off > 40) {
          if (px < mnX) mnX = px;
          if (px > mxX) mxX = px;
          if (py < mnY) mnY = py;
          if (py > mxY) mxY = py;
        }
      }
    }
    return mxX < 0 ? null : { w: (mxX - mnX + 1) / sx, h: (mxY - mnY + 1) / sy };
  }, rect);
}

/**
 * Wait until the first page has actually painted its content.
 *
 * `open()` waits for a canvas with a real backing store, which is enough for a
 * vector page but not for a redacted one: that page ships as a JPEG, and the
 * canvas exists and is blank for a while before the image decodes. Measuring in
 * that gap reports a perfectly good raster as an empty one.
 */
async function waitForPaint(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const c = document.querySelector<HTMLCanvasElement>(".page canvas");
      if (!c || c.width < 2) return false;
      const d = c.getContext("2d", { willReadFrequently: true })!
        .getImageData(0, 0, c.width, Math.min(c.height, 400)).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (Math.max(255 - d[i], 255 - d[i + 1], 255 - d[i + 2]) > 40) n++;
      }
      return n > 500;
    },
    null,
    { timeout: 30_000 },
  );
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
const pickMark = pickSubTool;

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

test("a rotated mark exports at the angle the overlay drew", async ({ page }) => {
  const w = watch(page);
  const f = await fixtures();
  await open(page, f.sample);
  const box = (await page.locator(".page").first().boundingBox())!;
  const dock = (await page.locator(".tooldock").boundingBox())!;

  // Blank paper big enough to hold the mark once it has been rotated.
  const WIN = { w: 190, h: 150 };
  let spot: { x: number; y: number } | null = null;
  outer: for (let y = 100; y < dock.y - box.y - WIN.h - 20; y += 15) {
    for (let x = 30; x < box.width - WIN.w; x += 30) {
      if ((await inkShare(page, { x, y, w: WIN.w, h: WIN.h })) < 0.0005) {
        spot = { x, y };
        break outer;
      }
    }
  }
  expect(spot, "found blank paper to draw on").not.toBeNull();
  const from = { x: spot!.x + 45, y: spot!.y + 60 };

  await pickMark(page, "Tick");
  await page.mouse.move(box.x + from.x, box.y + from.y);
  await page.mouse.down();
  await page.mouse.move(box.x + from.x + 90, box.y + from.y + 30, { steps: 6 });
  await page.mouse.up();

  await pickTool(page, "Select");
  await page.mouse.click(box.x + from.x + 45, box.y + from.y + 15);
  await expect(page.locator(".rotate-zone").first()).toBeAttached();

  // 35 degrees, not 90: a bounding box cannot tell +90 from -90, so a sign
  // error in the exporter's rotation would sail straight through a
  // right-angle test.
  const cx = box.x + from.x + 45;
  const cy = box.y + from.y + 15;
  const rz = (await page.locator(".rotate-zone").first().boundingBox())!;
  // The resize handle sits on the corner, covering the middle of the rotate
  // ring — press the ring's outer corner or the gesture silently becomes a
  // resize and the test "passes" against an unrotated mark.
  const hx = rz.x + 4;
  const hy = rz.y + 4;
  const r = Math.hypot(hx - cx, hy - cy);
  const a0 = Math.atan2(hy - cy, hx - cx);
  await page.mouse.move(hx, hy);
  await page.mouse.down();
  for (let k = 1; k <= 10; k++) {
    const a = a0 + ((35 * Math.PI) / 180) * (k / 10);
    await page.mouse.move(cx + r * Math.cos(a), cy + r * Math.sin(a));
    await page.waitForTimeout(15);
  }
  await page.mouse.up();
  await page.waitForTimeout(250);

  // What the overlay will look like once rotated, computed from its own
  // points. Note `getBoundingClientRect()` is NOT usable here: on a rotated
  // SVG element it returns the rotated *bounding box of the bounding box*, so
  // for a diagonal glyph it reports a shape half again too tall and quietly
  // disagrees with a correct exporter.
  const want = await page.locator(".annot-svg polyline").first().evaluate((el) => {
    const g = el.parentElement as SVGGElement;
    const m = /rotate\(([-\d.]+)/.exec(g.getAttribute("transform") ?? "");
    const deg = m ? parseFloat(m[1]) : 0;
    const pts = (el.getAttribute("points") ?? "").trim().split(/\s+/)
      .map((p) => p.split(",").map(Number));
    const sw = parseFloat(el.getAttribute("stroke-width") ?? "0");
    const cxs = pts.reduce((n, p) => n + p[0], 0) / pts.length;
    const cys = pts.reduce((n, p) => n + p[1], 0) / pts.length;
    // The centre of rotation is the box centre, which the transform carries.
    const c = /rotate\([-\d.]+ ([-\d.]+) ([-\d.]+)\)/.exec(g.getAttribute("transform") ?? "");
    const ox = c ? parseFloat(c[1]) : cxs;
    const oy = c ? parseFloat(c[2]) : cys;
    const th = (deg * Math.PI) / 180;
    const cos = Math.cos(th), sin = Math.sin(th);
    const xs: number[] = [], ys: number[] = [];
    for (const [px, py] of pts) {
      const dx = px - ox, dy = py - oy;
      xs.push(dx * cos - dy * sin);
      ys.push(dx * sin + dy * cos);
    }
    return {
      deg,
      w: Math.max(...xs) - Math.min(...xs) + sw,
      h: Math.max(...ys) - Math.min(...ys) + sw,
    };
  });
  expect(Math.abs(want.deg), "the overlay actually rotated").toBeGreaterThan(20);

  const path = await exportTo(page);
  await open(page, path);
  const got = await inkBox(page, { ...spot!, w: WIN.w, h: WIN.h });

  expect(got, "the mark is in the exported file").not.toBeNull();
  // Height first: it is the dimension that actually distinguishes a tilted
  // tick from a level one. Measured against the exporter before it learned
  // about rotation, height was 37% out while width was only 12% out — a tick
  // is long and thin, so rotating it barely changes how wide its bounding box
  // is. Asserting width first would have made this spec hang on a hair.
  expect(Math.abs(got!.h - want.h) / want.h, "exported height matches the overlay").toBeLessThan(0.12);
  expect(Math.abs(got!.w - want.w) / want.w, "exported width matches the overlay").toBeLessThan(0.12);
  expectClean(w);
});

test("a mark tool says how it is placed, and shows where", async ({ page }) => {
  const w = watch(page);
  await open(page, (await fixtures()).sample);
  await pickMark(page, "Tick");

  // The hint is the only thing that can tell you a tick is *tapped* — every
  // other sub-tool here is dragged. It shipped covered by the status snackbar,
  // which shares this band, so "is it in the DOM" is not the assertion: what
  // matters is whether anything is painted over it.
  const hint = page.locator(".drawbar__hint");
  await expect(hint).toBeVisible();
  const occluded = await hint.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return el.contains(top) ? null : (top as HTMLElement | null)?.className ?? "unknown";
  });
  expect(occluded, "something is painted over the mark hint").toBeNull();

  // And the ghost shows the size the tap commits to, before it commits.
  const box = (await page.locator(".page").first().boundingBox())!;
  const spot = await blankSpot(page);
  await page.mouse.move(box.x + spot.x, box.y + spot.y);
  const ghost = page.locator(".markghost");
  await expect(ghost).toHaveCount(1);
  // It must never take the tap it is advertising.
  await expect(ghost).toHaveCSS("pointer-events", "none");
  // Drawn from the same unit polylines as every other path — one for a tick, so
  // the preview is the same glyph the file will get, not a hand-drawn stand-in.
  await expect(ghost.locator("polyline")).toHaveCount(1);

  // Leaving the tool takes it with them.
  await pickTool(page, "Select");
  await expect(page.locator(".markghost")).toHaveCount(0);
  expectClean(w);
});

test("a mark survives a page being rasterised for redaction", async ({ page }) => {
  const w = watch(page);
  const f = await fixtures();
  await open(page, f.sample);
  const box = (await page.locator(".page").first().boundingBox())!;
  const spot = await blankSpot(page);
  const win = { x: spot.x - 24, y: spot.y - 24, w: 48, h: 48 };

  await pickMark(page, "Tick");
  await page.mouse.click(box.x + spot.x, box.y + spot.y);
  // `getBBox()` is the path's own extent and excludes the stroke, while a pixel
  // measurement necessarily includes it — on a glyph this small the stroke is
  // nearly half the height, so the two are not comparable until it is added
  // back.
  const overlay = await page.locator(".annot-svg polyline").first().evaluate((el) => {
    const b = (el as SVGGraphicsElement).getBBox();
    const sw = parseFloat(el.getAttribute("stroke-width") ?? "0");
    return { w: b.width + sw, h: b.height + sw };
  });

  // Redact something else on the same page. That switches the whole page onto
  // the raster path — a third place the glyph is drawn, with its own
  // coordinate system (y down, canvas-space) and its own rotation handling.
  // Nothing else exercises it, and a mark that vanished here would only ever
  // be noticed by someone redacting a filled-in form.
  await pickTool(page, "Redact");
  await page.mouse.move(box.x + 60, box.y + 60);
  await page.mouse.down();
  await page.mouse.move(box.x + 220, box.y + 88, { steps: 6 });
  await page.mouse.up();

  const path = await exportTo(page);
  await open(page, path);
  await waitForPaint(page);
  const got = await inkBox(page, win);

  expect(got, "the tick is still on the rasterised page").not.toBeNull();
  // And at the right size — a coordinate slip in the raster path would place
  // or scale it wrongly rather than lose it. The tolerance is loose because the
  // raster is JPEG-compressed after the mark is drawn onto it, which blurs the
  // stroke edges outward past the threshold this measures with.
  expect(Math.abs(got!.w - overlay.w) / overlay.w, "the raster kept the mark's width").toBeLessThan(0.3);
  expect(Math.abs(got!.h - overlay.h) / overlay.h, "the raster kept the mark's height").toBeLessThan(0.3);
  expectClean(w);
});
