import { test, expect, type Page } from "@playwright/test";
import { fixtures } from "./fixtures";
import { open, watch } from "./helpers";

/**
 * A download is a save.
 *
 * The change counter used to count edits since the file was *opened*, and it
 * was the only thing the leave/close prompts asked. So downloading did
 * nothing to it: the tab kept its unsaved dot, closing it warned that the work
 * would be lost, and leaving the page raised the browser's "changes may not be
 * saved" — about changes sitting in the user's Downloads folder. A warning
 * that is wrong every time trains people to click through the one time it's
 * right. These pin the saved state: a download clears every warning, the next
 * edit brings them back, and undoing to what was downloaded clears them again.
 */

const tabs = (page: Page) => page.locator(".doctab");
const activeTab = (page: Page) => page.locator(".doctab--active");
const counter = (page: Page) => page.locator(".appbar__changes");
const modal = (page: Page) => page.locator('[aria-modal="true"]');

/** Closing a downloaded document still asks — the page can't know the
 * download finished — but as a plain "Close", not "Discard & close". */
async function closeDownloaded(page: Page, tab = activeTab(page)) {
  await tab.locator(".doctab__close").click();
  const d = modal(page);
  await expect(d).toContainText("You downloaded");
  await expect(d.getByRole("button", { name: /Discard/ })).toHaveCount(0);
  await d.getByRole("button", { name: "Close", exact: true }).click();
  await expect(d).toHaveCount(0);
}

async function addText(page: Page, text: string) {
  const ov = (await page.locator(".page__overlay").first().boundingBox())!;
  await page.locator('.tooldock__btn[aria-label="Add text"]').click();
  await page.mouse.click(ov.x + 150, ov.y + 150);
  await page.keyboard.type(text, { delay: 15 });
  await page.locator('.tooldock__btn[aria-label="Select"]').click();
}

async function download(page: Page) {
  await Promise.all([page.waitForEvent("download"), page.click(".appbar__download")]);
}

async function openMore(page: Page, file: string) {
  const before = await tabs(page).count();
  await page.setInputFiles('input[accept="application/pdf,.pdf"][multiple]', file);
  await expect(tabs(page)).toHaveCount(before + 1, { timeout: 30_000 });
  await page.waitForSelector(".page canvas");
}

/** Whether leaving the page right now would raise the browser's prompt. */
async function wouldPromptOnLeave(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const ev = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(ev);
    return ev.defaultPrevented;
  });
}

test.describe("saved means saved", () => {
  test("a download clears the warnings; the next edit brings them back", async ({ page }) => {
    const w = watch(page);
    const f = await fixtures();
    await open(page, f.sample);
    await addText(page, "Hello");
    await expect(counter(page)).toHaveText("1 change");
    await expect(activeTab(page).locator(".doctab__dirty")).toHaveCount(1);
    expect(await wouldPromptOnLeave(page)).toBe(true);

    await download(page);
    await expect(counter(page)).toHaveText("Downloaded");
    await expect(activeTab(page).locator(".doctab__dirty")).toHaveCount(0);
    expect(await wouldPromptOnLeave(page)).toBe(false);

    // Another edit: unsaved again, everywhere.
    await addText(page, "More");
    await expect(counter(page)).toHaveText("2 changes");
    await expect(activeTab(page).locator(".doctab__dirty")).toHaveCount(1);
    expect(await wouldPromptOnLeave(page)).toBe(true);

    // Undo back to exactly what was downloaded: saved again.
    // (A new box is two steps: the box, then its typing.)
    for (let i = 0; i < 5 && (await page.locator(".textbox").count()) > 1; i++) {
      await page.locator('.icon-btn[aria-label="Undo"]').click();
    }
    await expect(page.locator(".textbox")).toHaveCount(1);
    await expect(counter(page)).toHaveText("Downloaded");
    expect(await wouldPromptOnLeave(page)).toBe(false);

    // And closing it asks the gentle question, not the discard one.
    await closeDownloaded(page);
    await expect(page.locator(".appbar__download")).toHaveCount(0);
    expect(w.errors).toEqual([]);
  });

  test("the saved state goes with the document to the background and back", async ({ page }) => {
    const f = await fixtures();
    await open(page, f.sample);
    await addText(page, "Kept");
    await download(page);
    await openMore(page, f.typeset);
    // The downloaded one in the background is clean: no dot, no leave prompt.
    await expect(tabs(page).first().locator(".doctab__dirty")).toHaveCount(0);
    expect(await wouldPromptOnLeave(page)).toBe(false);

    await tabs(page).first().locator(".doctab__btn").click();
    await expect(counter(page)).toHaveText("Downloaded");
    await closeDownloaded(page);
    await expect(tabs(page)).toHaveCount(1);
  });

  test("Download all saves every document it bundled", async ({ page }) => {
    const f = await fixtures();
    await open(page, f.sample);
    await addText(page, "Alpha");
    await openMore(page, f.typeset);
    await addText(page, "Beta");
    await expect(page.locator(".doctab__dirty")).toHaveCount(2);

    await page.locator('[aria-label="Export options"]').click();
    await Promise.all([
      page.waitForEvent("download"),
      page.locator(".menu__item", { hasText: "Download all (2) as ZIP" }).click(),
    ]);
    await expect(page.locator(".doctab__dirty")).toHaveCount(0);
    expect(await wouldPromptOnLeave(page)).toBe(false);
    await closeDownloaded(page);
    await closeDownloaded(page);
  });

  test("a download the browser didn't finish can't lose the work", async ({ page }) => {
    // The page only clicks a link; a cancelled "Save as…" looks exactly like a
    // finished download from here. Closing must still ask, and with the
    // session copy off, leaving must still raise the browser's prompt.
    const f = await fixtures();
    await open(page, f.sample);
    await addText(page, "Work");
    page.on("download", (d) => void d.cancel());
    await download(page);
    await activeTab(page).locator(".doctab__close").click();
    await expect(modal(page)).toContainText("didn't finish");
    await modal(page).getByRole("button", { name: "Cancel" }).click();
    await expect(page.locator(".textbox").first()).toHaveText("Work");

    await page.locator('.icon-btn[aria-label="More actions"]').click();
    await page.getByRole("menuitemcheckbox", { name: /Save session on this device/ }).click();
    expect(await wouldPromptOnLeave(page)).toBe(true);
  });
});

/**
 * A signature is only kept on the device when the user says so.
 *
 * Every signature made in the dialog used to go straight into localStorage,
 * silently and for good — a likeness of someone's hand left in a browser that
 * might be a shared or borrowed one, in an app whose whole promise is that
 * nothing stays behind. Keeping it is now a choice made in the dialog, off by
 * default.
 */
test.describe("signature consent", () => {
  const stored = (page: Page) =>
    page.evaluate(() => JSON.parse(localStorage.getItem("signatures") ?? "[]").length as number);

  async function typeSignature(page: Page, name: string, remember: boolean) {
    await page.locator('.tooldock__btn[aria-label="Sign"]').click();
    const dialog = page.getByRole("dialog", { name: "Add signature" });
    await dialog.getByRole("button", { name: "Type" }).click();
    await dialog.getByPlaceholder("Type your name").fill(name);
    const box = dialog.getByRole("checkbox", { name: /Remember this signature/ });
    await expect(box).not.toBeChecked();
    // Unticked isn't "nothing on this device" while the session copy is on —
    // the signature is part of the document — and the dialog says so.
    await expect(dialog).toContainText("session copy");
    if (remember) await box.check();
    await dialog.getByRole("button", { name: "Add", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await page.keyboard.press("Escape");
  }

  test("nothing is stored unless asked; what is stored can be removed", async ({ page }) => {
    const f = await fixtures();
    await open(page, f.sample);

    await typeSignature(page, "Ada", false);
    expect(await stored(page)).toBe(0);

    await typeSignature(page, "Grace", true);
    expect(await stored(page)).toBe(1);

    await page.locator('.tooldock__btn[aria-label="Sign"]').click();
    const dialog = page.getByRole("dialog", { name: "Add signature" });
    await expect(dialog.getByRole("button", { name: "Use saved signature" })).toHaveCount(1);
    await dialog.getByRole("button", { name: "Remove saved signature" }).click();
    await expect(dialog.getByRole("button", { name: "Use saved signature" })).toHaveCount(0);
    expect(await stored(page)).toBe(0);
  });
});
