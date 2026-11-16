import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fixtures } from "./fixtures";
import { open, watch } from "./helpers";

/**
 * Several documents open at once, one tab each.
 *
 * Before tabs, opening a second PDF *replaced* the first — behind a "Discard &
 * open" confirmation — so the only way to work on two files was to finish and
 * download one before touching the other. These pin the things that make tabs
 * worth having: a parked document keeps its edits *and* its undo history, a
 * closed tab with work in it asks first, and a reload brings every edited
 * document back, not just the one that happened to be in front.
 */

const tabs = (page: Page) => page.locator(".doctab");
const activeTab = (page: Page) => page.locator(".doctab--active");

/** Open another file through the always-mounted picker (it accepts several). */
async function openMore(page: Page, ...files: string[]) {
  const before = await tabs(page).count();
  await page.setInputFiles('input[accept="application/pdf,.pdf"][multiple]', files);
  await expect(tabs(page)).toHaveCount(before + files.length, { timeout: 30_000 });
  await page.waitForSelector(".page canvas");
}

/** Add a text box saying `text` on the first page. */
async function addText(page: Page, text: string) {
  const ov = (await page.locator(".page__overlay").first().boundingBox())!;
  await page.locator('.tooldock__btn[aria-label="Add text"]').click();
  await page.mouse.click(ov.x + 150, ov.y + 150);
  await page.keyboard.type(text, { delay: 15 });
  // Leave the contentEditable so single-key shortcuts work again.
  await page.locator('.tooldock__btn[aria-label="Select"]').click();
}

test.describe("document tabs", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 820 });
  });

  test("a second PDF opens beside the first, and the first keeps its edits and its undo", async ({ page }) => {
    const w = watch(page);
    const f = await fixtures();
    await open(page, f.sample);
    await expect(tabs(page)).toHaveCount(1);
    await addText(page, "Kept");
    await expect(activeTab(page).locator(".doctab__dirty")).toHaveCount(1);

    // No "discard your changes?" gate any more: opening is not destructive.
    await openMore(page, f.typeset);
    await expect(page.locator('[aria-modal="true"]')).toHaveCount(0);
    await expect(activeTab(page)).toContainText("typeset.pdf");
    await expect(page.locator(".textbox")).toHaveCount(0);
    // The background tab still says it has unsaved work.
    await expect(tabs(page).first().locator(".doctab__dirty")).toHaveCount(1);

    await tabs(page).first().locator(".doctab__btn").click();
    await expect(activeTab(page)).toContainText("sample.pdf");
    await expect(page.locator(".textbox").first()).toHaveText("Kept");

    // The history came back too, not just the final state.
    // (Placing a box and typing into it are separate steps, so walk back to
    // the empty page, then forward again.)
    const undoBtn = page.locator('.icon-btn[aria-label="Undo"]');
    await expect(undoBtn).toBeEnabled();
    while (await undoBtn.isEnabled()) await undoBtn.click();
    await expect(page.locator(".textbox")).toHaveCount(0);
    const redoBtn = page.locator('.icon-btn[aria-label="Redo"]');
    while (await redoBtn.isEnabled()) await redoBtn.click();
    await expect(page.locator(".textbox").first()).toHaveText("Kept");

    expect(w.errors).toEqual([]);
  });

  test("closing a tab with work in it asks; closing a clean one doesn't", async ({ page }) => {
    const f = await fixtures();
    await open(page, f.sample);
    await addText(page, "Work");
    await openMore(page, f.typeset);

    // The clean one closes straight away and the edited one comes to the front.
    await activeTab(page).locator(".doctab__close").click();
    await expect(page.locator('[aria-modal="true"]')).toHaveCount(0);
    await expect(tabs(page)).toHaveCount(1);
    await expect(page.locator(".textbox").first()).toHaveText("Work");

    await openMore(page, f.typeset);
    await tabs(page).first().locator(".doctab__close").click();
    const dialog = page.locator('[aria-modal="true"]');
    await expect(dialog).toContainText("sample.pdf");
    await dialog.getByRole("button", { name: /Cancel/i }).click();
    await expect(tabs(page)).toHaveCount(2);

    await tabs(page).first().locator(".doctab__close").click();
    await page.getByRole("button", { name: /Discard & close/i }).click();
    await expect(tabs(page)).toHaveCount(1);
    await expect(activeTab(page)).toContainText("typeset.pdf");
  });

  test("a reload brings back every edited document, and only those", async ({ page }) => {
    const f = await fixtures();
    await open(page, f.sample);
    await addText(page, "First");
    await openMore(page, f.typeset);
    await addText(page, "Second");
    // A third, never edited: a copy of it on the device would be for nothing.
    await openMore(page, f.rotated);

    const keys = () =>
      page.evaluate(
        () =>
          new Promise<string[]>((resolve) => {
            const req = indexedDB.open("pdf-editor", 1);
            req.onsuccess = () => {
              const all = req.result.transaction("session", "readonly").objectStore("session").getAllKeys();
              all.onsuccess = () => resolve((all.result as string[]).sort());
            };
          }),
      );
    await expect.poll(async () => (await keys()).length, { timeout: 15_000 }).toBe(4);

    await page.reload();
    const banner = page.locator(".restore-banner");
    await expect(banner).toContainText("2 documents");
    await banner.getByRole("button", { name: "Restore" }).click();
    await expect(tabs(page)).toHaveCount(2, { timeout: 30_000 });
    // The one in front at save time (rotated.pdf) had nothing to keep, so the
    // last restored document is in front.
    await expect(activeTab(page)).toContainText("typeset.pdf");
    await expect(page.locator(".textbox").first()).toHaveText("Second");
    await tabs(page).first().locator(".doctab__btn").click();
    await expect(page.locator(".textbox").first()).toHaveText("First");
  });

  test("Download all bundles every tab, with each one's own edits", async ({ page }) => {
    const f = await fixtures();
    await open(page, f.sample);
    await addText(page, "Alpha");
    await openMore(page, f.typeset);

    await page.locator('.icon-btn[aria-label="More actions"]').click();
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.locator(".menu__item", { hasText: "Download all (2) as ZIP" }).click(),
    ]);
    expect(download.suggestedFilename()).toBe("documents-edited.zip");
    const zip = readFileSync((await download.path())!);
    const text = zip.toString("latin1");
    expect(text).toContain("sample-edited.pdf");
    expect(text).toContain("typeset-edited.pdf");
    // Two PDFs inside.
    expect(text.match(/%PDF-/g)?.length).toBe(2);
  });

  test("on a phone the strip only appears once there is something to switch to", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const f = await fixtures();
    await open(page, f.sample);
    await expect(page.locator(".doctabs")).toHaveCount(0);
    await page.setInputFiles('input[accept="application/pdf,.pdf"][multiple]', f.typeset);
    await expect(page.locator(".doctabs")).toBeVisible();
    await expect(tabs(page)).toHaveCount(2);
    // The status toast is fixed to the window, so it has to move down with the
    // strip or it lands on the zoom pill.
    const snack = await page.locator(".snackbar").boundingBox();
    const zoom = await page.locator(".zoombar").boundingBox();
    if (snack && zoom) expect(snack.y, "snackbar clears the zoom pill").toBeGreaterThanOrEqual(zoom.y + zoom.height);
    // The strip must not push the page sideways.
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(width).toBeLessThanOrEqual(390);
  });
});
