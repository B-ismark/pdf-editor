import { test, expect } from "@playwright/test";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Fixtures are generated at runtime (no committed binaries): a valid two-page
// PDF and an HTML file masquerading as a .pdf.
let pdfPath = "";
let fakePath = "";

test.beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "pdf-editor-tests-"));
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([595, 842]).drawText("Test document", { x: 60, y: 760, size: 20, font });
  doc.addPage([595, 842]).drawText("Page two", { x: 60, y: 760, size: 20, font });
  pdfPath = join(dir, "sample.pdf");
  writeFileSync(pdfPath, await doc.save());
  fakePath = join(dir, "not-a-pdf.pdf");
  writeFileSync(fakePath, "<!doctype html><html><body><h1>Not a PDF</h1></body></html>");
});

async function openSample(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.setInputFiles("input[type=file]", pdfPath);
  await page.waitForSelector(".appbar__download", { timeout: 20_000 });
  await page.waitForTimeout(400);
}

test("rejects a non-PDF file by content, not extension", async ({ page }) => {
  await page.goto("/");
  await page.setInputFiles("input[type=file]", fakePath);
  await expect(page.locator(".dropzone__err")).toContainText(/isn.t a PDF/i);
});

test("opens a valid PDF", async ({ page }) => {
  await openSample(page);
  await expect(page.locator(".appbar__download")).toBeVisible();
});

test("page numbers are an undoable, previewed layer", async ({ page }) => {
  await openSample(page);
  await page.getByRole("button", { name: /Page numbers/ }).first().click();
  await page.waitForSelector('[aria-modal="true"]');
  await page.getByRole("button", { name: /^Apply$/ }).click();
  await expect(page.locator(".finishlayer__num").first()).toBeVisible();
  await page.keyboard.press("Control+z");
  await expect(page.locator(".finishlayer__num")).toHaveCount(0);
});

test("typing then undo/redo re-seeds the editable overlay", async ({ page }) => {
  await openSample(page);
  const ov = await page.locator(".page__overlay").first().boundingBox();
  await page.keyboard.press("t");
  await page.mouse.click(ov!.x + 150, ov!.y + 150);
  await page.waitForTimeout(200);
  await page.keyboard.type("Hello", { delay: 20 });
  await expect(page.locator(".textbox").first()).toHaveText("Hello");
  await page.keyboard.press("Control+z");
  await expect(page.locator(".textbox").first()).toHaveText("");
  await page.keyboard.press("Control+y");
  await expect(page.locator(".textbox").first()).toHaveText("Hello");
});

test("export as images downloads a single ZIP for a multi-page doc", async ({ page }) => {
  await openSample(page);
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 20_000 }),
    page.getByRole("button", { name: /Export as images/ }).first().click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.zip$/);
});

test("a modal suppresses global editing shortcuts", async ({ page }) => {
  await openSample(page);
  await page.getByRole("button", { name: /Organize pages/ }).first().click();
  await page.waitForSelector(".organize", { timeout: 5_000 });
  await page.keyboard.press("Control+z");
  await expect(page.locator(".organize")).toHaveCount(1);
});

test("the brand is the way out of a document", async ({ page }) => {
  await openSample(page);
  // Nothing edited yet: closing is not destructive, so it needs no prompt.
  await page.getByRole("button", { name: /return to the start screen/i }).click();
  await expect(page.locator(".dropzone__card")).toBeVisible();
  await expect(page.locator(".appbar__download")).toHaveCount(0);
});

test("closing a document with unsaved changes asks first", async ({ page }) => {
  await openSample(page);
  const ov = await page.locator(".page__overlay").first().boundingBox();
  await page.keyboard.press("t");
  await page.mouse.click(ov!.x + 150, ov!.y + 150);
  await page.keyboard.type("Hello", { delay: 20 });
  await page.locator(".appbar__brand--link").click();

  const dialog = page.locator('[aria-modal="true"]');
  await expect(dialog).toContainText(/Close this PDF/i);
  // Cancelling leaves the document exactly as it was.
  await dialog.getByRole("button", { name: /Cancel/i }).click();
  await expect(page.locator(".textbox").first()).toHaveText("Hello");

  await page.locator(".appbar__brand--link").click();
  await page.getByRole("button", { name: /Discard & close/i }).click();
  await expect(page.locator(".dropzone__card")).toBeVisible();
});
