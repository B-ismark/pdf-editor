import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fixtures } from "./fixtures";
import { open, watch, seedStore, docRecord, EMPTY } from "./helpers";

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

/** Every key in the autosave store. */
function storeKeys(page: Page): Promise<string[]> {
  return page.evaluate(
    () =>
      new Promise<string[]>((resolve) => {
        const req = indexedDB.open("pdf-editor", 1);
        req.onupgradeneeded = () => req.result.createObjectStore("session");
        req.onsuccess = () => {
          const all = req.result.transaction("session", "readonly").objectStore("session").getAllKeys();
          all.onsuccess = () => {
            resolve((all.result as string[]).sort());
            req.result.close();
          };
        };
      }),
  );
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

    await page.locator('[aria-label="Export options"]').click();
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

  test("a file dropped on an open dialog doesn't slip in behind it", async ({ page }) => {
    // Organise acts on whatever is in front when Apply is pressed. A drop used
    // to open a tab behind the dialog, and Apply then wrote this document's
    // pages into the dropped one — under its name.
    const f = await fixtures();
    await open(page, f.sample);
    await page.getByRole("button", { name: /Organise pages/ }).first().click();
    await page.waitForSelector(".organize");
    const bytes = [...readFileSync(f.typeset)];
    await page.evaluate((bytes) => {
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array(bytes)], "typeset.pdf", { type: "application/pdf" }));
      document.querySelector(".organize")!.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
    }, bytes);
    await page.waitForTimeout(800);
    await expect(tabs(page)).toHaveCount(1);
    await expect(activeTab(page)).toContainText("sample.pdf");
  });

  test("an organised document is still unsaved work", async ({ page }) => {
    const f = await fixtures();
    await open(page, f.sample);
    await page.getByRole("button", { name: /Organise pages/ }).first().click();
    await page.locator('.organize [aria-label="Rotate"]').first().click();
    await page.locator(".organize .btn--filled").click();
    await expect(page.locator(".organize")).toHaveCount(0);
    // The turn is a page plan in the doc state now, not new bytes, and still a change.
    await expect(activeTab(page).locator(".doctab__dirty")).toHaveCount(1);
    await expect.poll(async () => (await storeKeys(page)).length, { timeout: 15_000 }).toBe(2);
  });

  test("restoring more documents than fit keeps the rest on the device", async ({ page }) => {
    const f = await fixtures();
    await page.goto("/");
    const n = 12;
    await seedStore(
      page,
      Array.from({ length: n }, (_, i) => [`doc:s${i}`, docRecord(`s${i}`, `doc${i}.pdf`, i, { baked: 1 })]),
      Array.from({ length: n }, (_, i) => [`bytes:s${i}`, f.sample]),
    );
    await page.reload();
    await page.locator(".restore-banner").getByRole("button", { name: "Restore" }).click();
    await expect(tabs(page)).toHaveCount(10, { timeout: 60_000 });
    await expect(page.locator(".snackbar")).toContainText("couldn't be opened");
    // Give the autosave time to run (and, before the fix, delete).
    await page.waitForTimeout(2500);
    expect((await storeKeys(page)).filter((k) => k.startsWith("doc:")).length).toBe(n);
  });

  test("Delete on another window's restore prompt doesn't lose this window's work", async ({ page, context }) => {
    const f = await fixtures();
    await open(page, f.sample);
    await addText(page, "Live");
    await expect.poll(async () => (await storeKeys(page)).length, { timeout: 15_000 }).toBe(2);

    const other = await context.newPage();
    await other.goto("/");
    await other.locator(".restore-banner").getByRole("button", { name: /Delete/ }).click();
    // The editing window puts its copy back; it must not go on believing it's saved.
    await expect.poll(async () => (await storeKeys(page)).length, { timeout: 15_000 }).toBe(2);
    await other.close();
  });

  test("a pre-tabs session stays on offer after editing something else", async ({ page }) => {
    const f = await fixtures();
    await page.goto("/");
    await seedStore(page, [["current", { fileName: "old.pdf", doc: EMPTY, savedAt: Date.now() }]], [["current-bytes", f.sample]]);
    await page.reload();
    await page.locator(".restore-banner").getByRole("button", { name: "Not now" }).click();
    await open(page, f.typeset);
    await addText(page, "New");
    await expect.poll(async () => (await storeKeys(page)).filter((k) => k.startsWith("doc:")).length, { timeout: 15_000 }).toBe(1);
    await page.reload();
    await expect(page.locator(".restore-banner")).toContainText("old.pdf");
  });

  test("a discarded document is gone from the device at once", async ({ page }) => {
    const f = await fixtures();
    await open(page, f.sample);
    await addText(page, "Discard me");
    await expect.poll(async () => (await storeKeys(page)).length, { timeout: 15_000 }).toBe(2);
    await activeTab(page).locator(".doctab__close").click();
    await page.getByRole("button", { name: /Discard & close/i }).click();
    // Well inside the autosave's debounce.
    await page.waitForTimeout(300);
    await page.reload();
    await page.waitForTimeout(800);
    await expect(page.locator(".restore-banner")).toHaveCount(0);
    expect(await storeKeys(page)).toEqual([]);
  });

  test("Download all checks every document for whiteout over live text", async ({ page }) => {
    const f = await fixtures();
    await page.goto("/");
    const cover = { id: "r-1", pageIndex: 0, x: 0, y: 0, width: 2000, height: 2000, color: "#ffffff", cover: true };
    await seedStore(
      page,
      [["doc:w", docRecord("w", "covered.pdf", 0, { doc: { ...EMPTY, redactions: [cover] } })]],
      [["bytes:w", f.sample]],
    );
    await page.reload();
    await page.locator(".restore-banner").getByRole("button", { name: "Restore" }).click();
    await expect(tabs(page)).toHaveCount(1, { timeout: 30_000 });
    await openMore(page, f.typeset);

    let downloaded = false;
    page.on("download", () => (downloaded = true));
    await page.locator('[aria-label="Export options"]').click();
    await page.locator(".menu__item", { hasText: "Download all (2) as ZIP" }).click();
    await expect(page.locator(".snackbar")).toContainText("covered.pdf");
    await page.waitForTimeout(500);
    expect(downloaded, "no ZIP built").toBe(false);
  });

  test("a batch with a bad file says so, instead of claiming every file opened", async ({ page }) => {
    const f = await fixtures();
    await open(page, f.sample);
    await page.locator('input[accept="application/pdf,.pdf"][multiple]').setInputFiles([
      { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("not a pdf") },
      { name: "typeset.pdf", mimeType: "application/pdf", buffer: readFileSync(f.typeset) },
    ]);
    await expect(tabs(page)).toHaveCount(2, { timeout: 15_000 });
    await expect(page.locator(".snackbar")).toContainText("couldn't open \"notes.txt\"");
  });

  test("closing a tab from the keyboard leaves focus on the strip", async ({ page }) => {
    const f = await fixtures();
    await open(page, f.sample);
    await openMore(page, f.typeset);
    await expect(tabs(page)).toHaveCount(2);
    await activeTab(page).locator(".doctab__btn").focus();
    await page.keyboard.press("Delete");
    await expect(tabs(page)).toHaveCount(1);
    await expect.poll(() => page.evaluate(() => document.activeElement?.className ?? "")).toContain("doctab__btn");
  });

  test("arrowing between tabs keeps focus on the tab in front", async ({ page }) => {
    // Each document gets its own editor, strip included: focus has to follow
    // the switch into the new strip rather than fall to <body> with the old one.
    const f = await fixtures();
    await open(page, f.sample);
    await openMore(page, f.typeset);
    await expect(tabs(page)).toHaveCount(2);
    await activeTab(page).locator(".doctab__btn").focus();
    await page.keyboard.press("ArrowLeft");
    const focusedTab = () =>
      page.evaluate(() => (document.activeElement as HTMLElement | null)?.getAttribute("data-doc-tab") ?? "");
    await expect.poll(focusedTab).not.toBe("");
    const first = await focusedTab();
    expect(await activeTab(page).locator(".doctab__btn").getAttribute("data-doc-tab")).toBe(first);
    // And the next arrow still moves, which it can't from <body>.
    await page.keyboard.press("ArrowRight");
    await expect.poll(focusedTab).not.toBe(first);
    expect(await activeTab(page).locator(".doctab__btn").getAttribute("data-doc-tab")).toBe(await focusedTab());
  });

  test("coming back to a document lands where it was left", async ({ page }) => {
    // Each switch mounts a fresh editor. Measuring the page fit afresh drew a
    // frame at the unmeasured scale and restored the position against that
    // height: half-way down came back about a third of the way down.
    const f = await fixtures();
    await open(page, f.long);
    const scroller = page.locator(".viewer__scroll");
    await scroller.evaluate((el) => (el.scrollTop = el.scrollHeight * 0.5));
    await openMore(page, f.sample);
    await tabs(page).first().locator(".doctab__btn").click();
    await expect(activeTab(page)).toContainText("long.pdf");
    await page.waitForTimeout(600);
    const at = await scroller.evaluate((el) => el.scrollTop / el.scrollHeight);
    expect(Math.abs(at - 0.5)).toBeLessThan(0.02);
  });

  test("switching tabs keeps the page at the size it was shown", async ({ page }) => {
    // Hiding the panel deliberately leaves the page at its size. A switch used
    // to re-measure the fit and blow the page up to the wider surface.
    const f = await fixtures();
    await open(page, f.sample);
    await openMore(page, f.sample);
    await page.locator('.icon-btn[aria-label="Hide panel"]').click();
    const width = () => page.locator(".page").first().evaluate((el) => el.getBoundingClientRect().width);
    const before = await width();
    await tabs(page).first().locator(".doctab__btn").click();
    await page.waitForSelector(".page canvas");
    await page.waitForTimeout(400);
    expect(Math.abs((await width()) - before)).toBeLessThan(1);
  });

  test("Ctrl+O closes the menu it was pressed over", async ({ page }) => {
    const f = await fixtures();
    await open(page, f.sample);
    const more = page.locator('.icon-btn[aria-label="More actions"]');
    await more.click();
    await expect(more).toHaveAttribute("aria-expanded", "true");
    const chooser = page.waitForEvent("filechooser");
    await page.keyboard.press("Control+o");
    await chooser;
    await expect(more).toHaveAttribute("aria-expanded", "false");
  });

  test("a newly opened document starts at its first page", async ({ page }) => {
    const f = await fixtures();
    await open(page, f.long);
    await page.locator(".viewer__scroll").evaluate((el) => (el.scrollTop = el.scrollHeight * 0.5));
    await openMore(page, f.sample);
    await expect(tabs(page)).toHaveCount(2);
    await page.waitForTimeout(500);
    expect(await page.locator(".viewer__scroll").evaluate((el) => el.scrollTop)).toBeLessThan(50);
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
