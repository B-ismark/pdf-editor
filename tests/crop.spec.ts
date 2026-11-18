import { test, expect, type Page } from "@playwright/test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, StandardFonts } from "pdf-lib";
import { fixtures } from "./fixtures";
import { dragOnPage, expectClean, open, openOrganise, pickTool, watch } from "./helpers";

/**
 * Crop, and the ground it stands on: a page whose visible box doesn't start at
 * the sheet's corner.
 *
 * Downloads are read back by readers independent of the app: upstream pdf-lib
 * for the page boxes, pdf.js in Node for where the text is.
 */

const dir = mkdtempSync(join(tmpdir(), "crop-"));
const MM = 72 / 25.4;

/** One page whose CropBox starts at 100,200 — the view's corner is not the
 * user-space origin. A heading inside it, and a stray word outside it. */
const OFFSET = { x: 100, y: 200, width: 300, height: 400, heading: "Offset heading", hx: 130, hy: 540 };
async function offsetPdf(): Promise<string> {
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.Helvetica);
  const p = d.addPage([595, 842]);
  p.drawText(OFFSET.heading, { x: OFFSET.hx, y: OFFSET.hy, size: 24, font: f });
  p.drawText("Outside", { x: 20, y: 20, size: 12, font: f });
  p.setCropBox(OFFSET.x, OFFSET.y, OFFSET.width, OFFSET.height);
  const file = join(dir, "offset.pdf");
  writeFileSync(file, await d.save());
  return file;
}

/** Where each text run is in a PDF, in its page's user space. */
async function runs(bytes: Buffer, n = 1): Promise<{ str: string; x: number; y: number }[]> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), useWorkerFetch: false, isEvalSupported: false, stopAtErrors: false }).promise;
  const content = await (await doc.getPage(n)).getTextContent();
  return content.items
    .filter((i) => "str" in i && i.str.trim())
    .map((i) => {
      const t = i as { str: string; transform: number[] };
      return { str: t.str, x: t.transform[4], y: t.transform[5] };
    });
}

async function boxes(bytes: Buffer) {
  const d = await PDFDocument.load(bytes);
  return d.getPages().map((p) => ({ crop: p.getCropBox(), rotate: p.getRotation().angle }));
}

async function download(page: Page): Promise<Buffer> {
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download", exact: true }).click()]);
  return readFileSync((await dl.path())!);
}

async function openCrop(page: Page) {
  await page.keyboard.press("Control+k");
  await page.keyboard.type("crop");
  await page.getByRole("option", { name: /Crop pages/ }).click();
  await expect(page.getByRole("dialog", { name: /Crop page/ })).toBeVisible();
}

async function margins(page: Page, m: Partial<Record<"Top" | "Bottom" | "Left" | "Right", number>>) {
  for (const [side, mm] of Object.entries(m)) await page.getByLabel(`${side} margin, millimetres`).fill(String(mm));
}

const near = (a: number, b: number, tol = 0.6) => Math.abs(a - b) <= tol;

test("a page whose view starts off the corner: text sits on its glyphs, and edits land where they were", async ({ page }) => {
  const w = watch(page);
  await open(page, await offsetPdf());
  // The overlay for the heading is on the page, over the heading — not
  // 200 points above it, off the page.
  const frag = page.locator(".fragment", { hasText: OFFSET.heading });
  const pageBox = (await page.locator(".page").boundingBox())!;
  const fragBox = (await frag.boundingBox())!;
  const scale = pageBox.width / OFFSET.width;
  expect(fragBox.y).toBeGreaterThan(pageBox.y);
  // The heading's baseline is 60pt below the view's top; the run's box ends
  // a little under it.
  const baseline = pageBox.y + (OFFSET.y + OFFSET.height - OFFSET.hy) * scale;
  expect(fragBox.y).toBeLessThan(baseline);
  expect(fragBox.y + fragBox.height).toBeGreaterThan(baseline - 4 * scale);
  expect(near(fragBox.x, pageBox.x + (OFFSET.hx - OFFSET.x) * scale, 3 * scale)).toBe(true);

  // Edited, it's redrawn where it was in the file — and page numbers land
  // inside what the reader sees.
  await frag.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" v2", { delay: 20 });
  const bytes = await download(page);
  const found = await runs(bytes);
  const edited = found.find((r) => r.str.includes("v2"));
  expect(edited, `runs: ${JSON.stringify(found)}`).toBeTruthy();
  expect(near(edited!.x, OFFSET.hx)).toBe(true);
  expect(near(edited!.y, OFFSET.hy)).toBe(true);
  expectClean(w);
});

test("a link drawn on an off-corner page points at the same place in the file", async ({ page }) => {
  await open(page, await offsetPdf());
  await pickTool(page, "Link");
  const pg = (await page.locator(".page").boundingBox())!;
  const scale = pg.width / OFFSET.width;
  // A box from 20,20 to 120,60 points in from the view's top-left.
  await dragOnPage(page, { x: 20 * scale, y: 20 * scale }, { x: 120 * scale, y: 60 * scale });
  await page.fill("#link-url", "https://example.com/");
  await page.waitForTimeout(200);
  const bytes = await download(page);
  const d = await PDFDocument.load(bytes);
  const annots = d.getPage(0).node.Annots()!;
  expect(annots.size()).toBe(1);
  const dict = d.context.lookup(annots.get(0), PDFDict);
  const arr = dict.lookup(PDFName.of("Rect"), PDFArray).asArray().map((n) => (n as PDFNumber).asNumber());
  // View 20..120 across, 20..60 down from the top → user space.
  expect(near(arr[0], OFFSET.x + 20, 1)).toBe(true);
  expect(near(arr[2], OFFSET.x + 120, 1)).toBe(true);
  expect(near(arr[3], OFFSET.y + OFFSET.height - 20, 1)).toBe(true);
  expect(near(arr[1], OFFSET.y + OFFSET.height - 60, 1)).toBe(true);
});

test("crop a page: the preview shows the kept part, the file gets it as its CropBox, and undo puts it back", async ({ page }) => {
  const w = watch(page);
  const f = await fixtures();
  await open(page, f.sample);
  const before = (await page.locator(".page").first().boundingBox())!;
  await openCrop(page);
  await margins(page, { Top: 20, Left: 30 });
  await page.getByRole("dialog").getByRole("button", { name: "Crop", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Cropped page 1." })).toBeVisible();

  // The page shows only what's kept: its shape is the crop's.
  const after = page.locator(".page").first();
  await expect(after).toHaveAttribute("data-cropped", "");
  const box = (await after.boundingBox())!;
  const keptW = 595 - 30 * MM;
  const keptH = 842 - 20 * MM;
  expect(Math.abs(box.width / box.height - keptW / keptH)).toBeLessThan(0.01);
  // Its text moved with it: the heading's left edge was 30mm in; now it's
  // cut, so the run starts left of the page's edge.
  const heading = (await page.locator(".fragment", { hasText: /Confidential Report — Page 1/ }).boundingBox())!;
  expect(heading.x).toBeLessThan(box.x);

  const bytes = await download(page);
  const b = await boxes(bytes);
  expect(near(b[0].crop.x, 30 * MM, 0.05)).toBe(true);
  expect(near(b[0].crop.y, 0, 0.05)).toBe(true);
  expect(near(b[0].crop.width, keptW, 0.05)).toBe(true);
  expect(near(b[0].crop.height, keptH, 0.05)).toBe(true);
  // Only that page.
  expect(b[1].crop).toEqual({ x: 0, y: 0, width: 595, height: 842 });

  await page.keyboard.press("Control+z");
  await expect(page.locator(".page").first()).not.toHaveAttribute("data-cropped", "");
  const back = (await page.locator(".page").first().boundingBox())!;
  expect(near(back.width / back.height, before.width / before.height, 0.005)).toBe(true);
  expectClean(w);
});

test("all pages by the same margins; the whole-page button uncrops them", async ({ page }) => {
  const f = await fixtures();
  await open(page, f.sample);
  await openCrop(page);
  await margins(page, { Bottom: 50 });
  await page.getByRole("radio", { name: /All 12 pages/ }).check();
  await page.getByRole("dialog").getByRole("button", { name: "Crop", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Cropped all 12 pages." })).toBeVisible();
  const b = await boxes(await download(page));
  for (const p of b) {
    expect(near(p.crop.y, 50 * MM, 0.05)).toBe(true);
    expect(near(p.crop.height, 842 - 50 * MM, 0.05)).toBe(true);
  }

  await openCrop(page);
  // The dialog opens on the page's current crop.
  await expect(page.getByLabel("Bottom margin, millimetres")).toHaveValue("50");
  await page.getByRole("button", { name: "Whole page" }).click();
  await page.getByRole("radio", { name: /All 12 pages/ }).check();
  await page.getByRole("dialog").getByRole("button", { name: "Uncrop" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Every page shows in full again." })).toBeVisible();
  await expect(page.locator(".page[data-cropped]")).toHaveCount(0);
});

test("on a turned page the margins are the sides you see", async ({ page }) => {
  const f = await fixtures();
  await open(page, f.rotated);
  const pdf = await PDFDocument.load(readFileSync(f.rotated));
  const { width, height } = pdf.getPage(0).getMediaBox();
  expect(pdf.getPage(0).getRotation().angle).toBe(90);
  await openCrop(page);
  // Shown turned a quarter clockwise: the top you see is the page's left
  // side (x = 0) in its own space.
  await margins(page, { Top: 20 });
  await page.getByRole("dialog").getByRole("button", { name: "Crop", exact: true }).click();
  const b = await boxes(await download(page));
  expect(b[0].rotate).toBe(90);
  expect(near(b[0].crop.x, 20 * MM, 0.05)).toBe(true);
  expect(near(b[0].crop.width, width - 20 * MM, 0.05)).toBe(true);
  expect(b[0].crop.y).toBe(0);
  expect(b[0].crop.height).toBe(height);
});

test("Organise keeps a page's crop when it moves, and the grid shows it cropped", async ({ page }) => {
  const f = await fixtures();
  await open(page, f.sample);
  await openCrop(page);
  await margins(page, { Right: 100 });
  await page.getByRole("dialog").getByRole("button", { name: "Crop", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Cropped page 1." })).toBeVisible();

  await openOrganise(page);
  const org = page.getByRole("dialog", { name: "Organise pages" });
  const first = org.locator(".pcard").first();
  await expect(first.locator("canvas")).toHaveCount(1);
  const c = (await first.locator("canvas").boundingBox())!;
  // Narrower than A4 by the crop.
  expect(Math.abs(c.width / c.height - (595 - 100 * MM) / 842)).toBeLessThan(0.03);
  // Move page 1 one later and apply: a plain rearrange of the document's own
  // pages, which must keep the crop with the page.
  await first.getByRole("button", { name: "Move later" }).click();
  await org.getByRole("button", { name: "Apply" }).click();
  await expect(org).toBeHidden();
  await expect(page.locator(".page[data-page-pos='1']")).toHaveAttribute("data-cropped", "");
  const b = await boxes(await download(page));
  const cropped = b.findIndex((p) => p.crop.width < 595 - 1);
  expect(cropped).toBe(1);
  expect(near(b[cropped].crop.width, 595 - 100 * MM, 0.05)).toBe(true);
});
