import { expect, test, type Page } from "@playwright/test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtures } from "./fixtures";
import { expectClean, open, openDrawbar, pickSubTool, pickTool, watch } from "./helpers";

/**
 * What you can do to objects that are already on the page: move a group of them,
 * and change which one is on top.
 *
 * A marquee selection could align, distribute, duplicate and delete — everything
 * except the obvious one. Dragging a member moved nothing and dropped the
 * selection, because the highlights drawn over the group were inert and the
 * press underneath them selected a single object instead.
 *
 * Stacking order had no control at all. Annotations paint in the order they were
 * made, in the SVG overlay *and* in the exporter (`for (const a of annots)`), so
 * anything drawn later buried what was under it permanently — and because both
 * paths walk the same array, the preview and the file can't disagree about the
 * fix.
 */

/** Draw a freehand stroke on the first page, in overlay-relative pixels. */
async function stroke(page: Page, y: number): Promise<void> {
  const box = (await page.locator(".page").first().boundingBox())!;
  await page.mouse.move(box.x + 80, box.y + y);
  await page.mouse.down();
  await page.mouse.move(box.x + 200, box.y + y + 16, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(150);
}

/** Rubber-band select over a region of the first page. */
async function marquee(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  const box = (await page.locator(".page").first().boundingBox())!;
  await page.mouse.move(box.x + from.x, box.y + from.y);
  await page.mouse.down();
  await page.mouse.move(box.x + to.x, box.y + to.y, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(250);
}

/** The `points` of every visible annotation polyline, in DOM (= paint) order. */
function strokePoints(page: Page) {
  return page.$$eval(".page .annot-svg polyline[stroke]:not([stroke='transparent'])", (els) =>
    els.map((e) => e.getAttribute("points") ?? ""),
  );
}

test("a group of strokes moves together, as one undo step", async ({ page }) => {
  const w = watch(page);
  await open(page, (await fixtures()).sample);

  await pickSubTool(page, "Pen");
  await stroke(page, 200);
  await stroke(page, 260);
  await pickTool(page, "Select");
  await marquee(page, { x: 40, y: 170 }, { x: 280, y: 300 });

  await expect(page.locator(".multisel")).toHaveCount(2);
  await expect(page.locator(".multibar")).toBeVisible();
  const before = await strokePoints(page);
  expect(before.length).toBe(2);

  // Drag one member: the whole group goes.
  const box = (await page.locator(".page").first().boundingBox())!;
  await page.mouse.move(box.x + 140, box.y + 208);
  await page.mouse.down();
  await page.mouse.move(box.x + 200, box.y + 268, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(250);

  const after = await strokePoints(page);
  expect(after[0], "the dragged stroke didn't move").not.toBe(before[0]);
  expect(after[1], "the other member of the group stayed behind").not.toBe(before[1]);
  // Same delta for both — a group move, not two independent ones.
  const delta = (a: string, b: string) => {
    const p = (s: string) => s.split(" ")[0].split(",").map(Number);
    const [ax, ay] = p(a);
    const [bx, by] = p(b);
    return [Math.round(bx - ax), Math.round(by - ay)];
  };
  expect(delta(before[0], after[0])).toEqual(delta(before[1], after[1]));
  // The selection survives the drag, so it can be dragged again.
  await expect(page.locator(".multisel")).toHaveCount(2);

  // One gesture, one history entry.
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(250);
  expect(await strokePoints(page), "one undo didn't restore the whole group").toEqual(before);
  expectClean(w);
});

test("a click on a member of a group selects just that one", async ({ page }) => {
  const w = watch(page);
  await open(page, (await fixtures()).sample);

  await pickSubTool(page, "Pen");
  await stroke(page, 200);
  await stroke(page, 260);
  await pickTool(page, "Select");
  await marquee(page, { x: 40, y: 170 }, { x: 280, y: 300 });
  await expect(page.locator(".multisel")).toHaveCount(2);

  // The highlights cover their objects, so they have to hand a plain press back
  // through — otherwise a group is a trap you can only leave by Escape.
  const box = (await page.locator(".page").first().boundingBox())!;
  await page.mouse.click(box.x + 140, box.y + 208);
  await page.waitForTimeout(250);
  await expect(page.locator(".multisel")).toHaveCount(0);
  await expect(page.locator(".props__arrange")).toBeVisible();
  expectClean(w);
});

test("arrow keys nudge the whole group", async ({ page }) => {
  const w = watch(page);
  await open(page, (await fixtures()).sample);

  await pickSubTool(page, "Pen");
  await stroke(page, 200);
  await stroke(page, 260);
  await pickTool(page, "Select");
  await marquee(page, { x: 40, y: 170 }, { x: 280, y: 300 });
  const before = await strokePoints(page);

  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(200);
  const after = await strokePoints(page);
  for (let i = 0; i < before.length; i++) expect(after[i]).not.toBe(before[i]);
  expectClean(w);
});

/** Set the draw stroke width, so a crossing is several pixels of solid colour
 * rather than a hairline the raster can blend away. */
async function setWidth(page: Page, width: number): Promise<void> {
  await openDrawbar(page);
  await page.locator(".drawbar__width input").fill(String(width));
}

/** Pick a preset colour from the swatch popover by its hex label. */
async function setColour(page: Page, hex: string): Promise<void> {
  await openDrawbar(page);
  await page.locator('.drawbar [aria-label="Choose colour"]').click();
  await page.locator(`.colorfield__chip[aria-label="${hex}"]`).click();
}

/**
 * Which of two colours dominates a patch of the *page raster*. Used on a
 * reopened export, so it answers "what did the file end up with", not "what did
 * the overlay draw".
 */
async function dominant(
  page: Page,
  rect: { x: number; y: number; w: number; h: number },
  a: [number, number, number],
  b: [number, number, number],
): Promise<"a" | "b" | "neither"> {
  return page.evaluate(
    ({ rect, a, b }) => {
      const canvas = document.querySelector<HTMLCanvasElement>(".page canvas")!;
      const el = canvas.closest(".page") as HTMLElement;
      const sx = canvas.width / el.clientWidth;
      const sy = canvas.height / el.clientHeight;
      const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
      const d = ctx.getImageData(
        Math.round(rect.x * sx),
        Math.round(rect.y * sy),
        Math.max(1, Math.round(rect.w * sx)),
        Math.max(1, Math.round(rect.h * sy)),
      ).data;
      const dist = (i: number, c: number[]) =>
        Math.abs(d[i] - c[0]) + Math.abs(d[i + 1] - c[1]) + Math.abs(d[i + 2] - c[2]);
      let na = 0;
      let nb = 0;
      for (let i = 0; i < d.length; i += 4) {
        const da = dist(i, a);
        const db = dist(i, b);
        // Only pixels that are actually one of the two colours get a vote.
        if (Math.min(da, db) > 90) continue;
        if (da < db) na++;
        else nb++;
      }
      if (na === 0 && nb === 0) return "neither";
      return na > nb ? "a" : "b";
    },
    { rect, a, b },
  );
}

test("a buried stroke can be brought to the front, in the overlay and the exported file", async ({
  page,
}) => {
  const w = watch(page);
  await open(page, (await fixtures()).sample);
  const box = (await page.locator(".page").first().boundingBox())!;

  // Two crossing strokes in different colours. The second one drawn wins the
  // crossing, which is the whole point: without a control, that is permanent.
  await pickSubTool(page, "Pen");
  await setWidth(page, 12);
  await setColour(page, "#000000");
  await page.mouse.move(box.x + 80, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(box.x + 220, box.y + 200, { steps: 8 });
  await page.mouse.up();

  await setColour(page, "#f4c400");
  await page.mouse.move(box.x + 150, box.y + 150);
  await page.mouse.down();
  await page.mouse.move(box.x + 150, box.y + 250, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(200);

  await pickTool(page, "Select");
  const first = await strokePoints(page);
  expect(first.length).toBe(2);

  // Select the black stroke — the one underneath — and raise it.
  await page.mouse.click(box.x + 100, box.y + 200);
  await page.waitForTimeout(250);
  await expect(page.locator(".props__arrange")).toBeVisible();
  await page.locator('[aria-label="Bring to front"]').first().click();
  await page.waitForTimeout(250);

  // DOM order in SVG *is* paint order, so this is the preview's stacking order.
  const raised = await strokePoints(page);
  expect(raised, "the raised stroke is still painted first").not.toEqual(first);
  expect(raised[raised.length - 1], "the raised stroke isn't painted last").toBe(first[0]);

  // And the file agrees: the exporter walks the same array, and this is the
  // assertion that says so rather than assuming it.
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 120_000 }),
    page.click(".appbar__download"),
  ]);
  const out = join(mkdtempSync(join(tmpdir(), "zorder-")), "out.pdf");
  writeFileSync(out, readFileSync((await download.path())!));
  await open(page, out);
  const crossing = { x: 144, y: 194, w: 12, h: 12 };
  expect(
    await dominant(page, crossing, [0, 0, 0], [244, 196, 0]),
    "the exported crossing kept the colour of the stroke that was sent behind",
  ).toBe("a");

  expectClean(w);
});

test("a note stays above the shapes in the exported file, as it does on screen", async ({
  page,
}) => {
  const w = watch(page);
  await open(page, (await fixtures()).sample);
  const box = (await page.locator(".page").first().boundingBox())!;

  // A note is an HTML element above the whole SVG layer, so on screen it is
  // always on top. The exporter drew strictly in array order, so a shape added
  // *after* a note covered it in the file and not in the preview.
  await pickSubTool(page, "Note");
  await setColour(page, "#000000");
  await page.mouse.click(box.x + 120, box.y + 300);
  // The new note takes focus, so this types into it — and a note wide enough to
  // sample needs some text (its exported box is sized to the string).
  await page.keyboard.type("NOTE");
  await page.waitForTimeout(200);

  await pickSubTool(page, "Highlight");
  await setColour(page, "#ffffff");
  await page.mouse.move(box.x + 100, box.y + 292);
  await page.mouse.down();
  await page.mouse.move(box.x + 260, box.y + 330, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(200);

  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 120_000 }),
    page.click(".appbar__download"),
  ]);
  const out = join(mkdtempSync(join(tmpdir(), "notes-")), "out.pdf");
  writeFileSync(out, readFileSync((await download.path())!));
  await open(page, out);

  // Inside the note. A black note is ~20 grey on paper (it draws at 0.92
  // opacity); the white highlight at 0.4 over that is ~114. So the two readings
  // are far apart and each says exactly which shape ended up on top.
  expect(
    await dominant(page, { x: 126, y: 308, w: 8, h: 5 }, [20, 20, 20], [114, 114, 114]),
    "the highlight was painted over the note, which the preview never showed",
  ).toBe("a");
  expectClean(w);
});

test("restacking something already at the front costs no undo step", async ({ page }) => {
  const w = watch(page);
  await open(page, (await fixtures()).sample);

  await pickSubTool(page, "Pen");
  await stroke(page, 200);
  await stroke(page, 260);
  await pickTool(page, "Select");

  // Select the frontmost stroke (the one drawn last) and raise it again.
  const box = (await page.locator(".page").first().boundingBox())!;
  await page.mouse.click(box.x + 140, box.y + 268);
  await page.waitForTimeout(250);
  await page.keyboard.press("]");
  await page.waitForTimeout(250);

  // One undo has to take the *stroke* back. A dead history entry would spend it
  // on restoring an order that never changed, so the stroke would still be here.
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(250);
  expect(await strokePoints(page), "the undo went to a no-op restack").toHaveLength(1);
  expectClean(w);
});

test("the keyboard sends a raised stroke back down", async ({ page }) => {
  const w = watch(page);
  await open(page, (await fixtures()).sample);

  await pickSubTool(page, "Pen");
  await stroke(page, 200);
  await stroke(page, 260);
  await pickTool(page, "Select");
  const first = await strokePoints(page);

  const box = (await page.locator(".page").first().boundingBox())!;
  await page.mouse.click(box.x + 140, box.y + 208);
  await page.waitForTimeout(250);
  await page.keyboard.press("]");
  await page.waitForTimeout(250);
  expect(await strokePoints(page), "] didn't raise the selected stroke").not.toEqual(first);
  await page.keyboard.press("[");
  await page.waitForTimeout(250);
  expect(await strokePoints(page)).toEqual(first);
  expectClean(w);
});
