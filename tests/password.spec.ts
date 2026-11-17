import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fixtures, LOCKED_PASSWORD, LOCKED_TEXT } from "./fixtures";
import { open, pageTexts, watch, openOrganise } from "./helpers";

/**
 * Password-protected PDFs open, behind an in-app password prompt.
 *
 * They used to stop at "This PDF is password-protected or encrypted, so it
 * can't be opened here." Worse, a file with only an *owner* password (opens
 * without asking) did open — and its download came out unreadable, because
 * pdf-lib wrote its still-encrypted streams under a trailer that no longer
 * said how to decrypt them. Now the file is decrypted once at open, so what is
 * edited and downloaded is a plain PDF; the password is never kept, and a
 * document that needed one is never copied into the device's storage.
 */

const dialog = (page: Page) => page.getByRole("dialog", { name: "This PDF is password-protected" });

async function pick(page: Page, file: string) {
  await page.goto("/");
  await page.setInputFiles("input[type=file]", file);
}

async function waitForPage(page: Page) {
  await page.waitForSelector(".page canvas", { timeout: 30_000 });
  await page.waitForFunction(() => [...document.querySelectorAll("canvas")].some((c) => c.width > 1), null, {
    timeout: 30_000,
  });
}

/** What the session store holds right now. */
function storeKeys(page: Page): Promise<string[]> {
  return page.evaluate(
    () =>
      new Promise<string[]>((resolve) => {
        const req = indexedDB.open("pdf-editor", 1);
        req.onupgradeneeded = () => req.result.createObjectStore("session");
        req.onsuccess = () => {
          const all = req.result.transaction("session", "readonly").objectStore("session").getAllKeys();
          all.onsuccess = () => {
            resolve(all.result as string[]);
            req.result.close();
          };
        };
      }),
  );
}

/** An owner-locked PDF whose outline is one /Next chain `items` long. */
async function longOutlinePdf(items: number): Promise<Buffer> {
  const lib = await import("@cantoo/pdf-lib");
  const doc = await lib.PDFDocument.create();
  const font = await doc.embedFont(lib.StandardFonts.Helvetica);
  doc.addPage([595, 842]).drawText("Long outline", { x: 60, y: 760, size: 20, font });
  const ctx = doc.context;
  const outlines = ctx.nextRef();
  const refs = Array.from({ length: items }, () => ctx.nextRef());
  refs.forEach((ref, i) => {
    const item: Record<string, unknown> = { Title: lib.PDFString.of(`Item ${i + 1}`), Parent: outlines };
    if (i > 0) item.Prev = refs[i - 1];
    if (i < items - 1) item.Next = refs[i + 1];
    ctx.assign(ref, ctx.obj(item as never));
  });
  ctx.assign(outlines, ctx.obj({ Type: "Outlines", First: refs[0], Last: refs[items - 1], Count: items }));
  doc.catalog.set(lib.PDFName.of("Outlines"), outlines);
  doc.encrypt({ userPassword: "", ownerPassword: "owner-secret" });
  return Buffer.from(await doc.save());
}

async function downloadBytes(page: Page): Promise<Buffer> {
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click(".appbar__download")]);
  return readFileSync((await dl.path())!);
}

test.describe("password-protected PDFs", () => {
  test("asks for the password, says when it's wrong, then opens and downloads unlocked", async ({ page }) => {
    const w = watch(page);
    const f = await fixtures();
    await pick(page, f.locked);

    const d = dialog(page);
    await expect(d).toBeVisible({ timeout: 20_000 });
    await expect(d).toContainText("locked.pdf");
    const field = d.getByLabel("Password");
    await expect(field).toBeFocused();

    await field.fill("wrong guess");
    await field.press("Enter");
    await expect(d.getByRole("alert")).toContainText("didn't open it");
    await expect(field).toHaveAttribute("aria-invalid", "true");
    // Still there to correct, and selected so typing replaces it.
    await expect(field).toHaveValue("wrong guess");

    await field.fill(LOCKED_PASSWORD);
    await d.getByRole("button", { name: "Open" }).click();
    await expect(d).toHaveCount(0);
    await waitForPage(page);
    await expect(page.locator(".page").first()).toContainText(LOCKED_TEXT);

    // Edit, download: a plain PDF with the text, no encryption left in it.
    const ov = (await page.locator(".page__overlay").first().boundingBox())!;
    await page.locator('.tooldock__btn[aria-label="Add text"]').click();
    await page.mouse.click(ov.x + 150, ov.y + 300);
    await page.keyboard.type("Added", { delay: 15 });
    await page.locator('.tooldock__btn[aria-label="Select"]').click();
    const bytes = await downloadBytes(page);
    expect(bytes.toString("latin1")).not.toContain("/Encrypt");
    const [p1] = await pageTexts(bytes, [1]);
    expect(p1).toContain(`${LOCKED_TEXT} page 1`);
    expect(p1).toContain("Added");
    await expect(page.locator(".snackbar__msg").filter({ hasText: "This copy has no password." })).toBeVisible();
    expect(w.errors).toEqual([]);
    expect(w.external).toEqual([]);
  });

  test("cancelling opens nothing", async ({ page }) => {
    const f = await fixtures();
    await pick(page, f.locked);
    await expect(dialog(page)).toBeVisible({ timeout: 20_000 });
    await dialog(page).getByRole("button", { name: "Cancel" }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.locator(".page")).toHaveCount(0);
    await expect(page.locator(".doctab")).toHaveCount(0);
  });

  test("an owner-locked file opens without asking and downloads readable", async ({ page }) => {
    const f = await fixtures();
    await pick(page, f.ownerLocked);
    await waitForPage(page);
    await expect(dialog(page)).toHaveCount(0);
    const bytes = await downloadBytes(page);
    expect(bytes.toString("latin1")).not.toContain("/Encrypt");
    const [p1] = await pageTexts(bytes, [1]);
    expect(p1).toContain(`${LOCKED_TEXT} page 1`);
  });

  test("a document opened with a password is never stored on the device", async ({ page }) => {
    const f = await fixtures();
    await pick(page, f.locked);
    await dialog(page).getByLabel("Password").fill(LOCKED_PASSWORD);
    await dialog(page).getByLabel("Password").press("Enter");
    await waitForPage(page);
    const ov = (await page.locator(".page__overlay").first().boundingBox())!;
    await page.locator('.tooldock__btn[aria-label="Add text"]').click();
    await page.mouse.click(ov.x + 150, ov.y + 300);
    await page.keyboard.type("Edited", { delay: 15 });
    await page.locator('.tooldock__btn[aria-label="Select"]').click();
    await expect(page.locator(".appbar__changes")).toHaveText("1 change");
    // Give the debounced autosave more than its delay.
    await page.waitForTimeout(2500);
    expect(await storeKeys(page)).toEqual([]);
  });

  test("pages merged in from a password-opened tab aren't stored either", async ({ page }) => {
    // Organise can pull every page of another open tab into this one. When
    // that tab was opened with a password, the merged result carries its
    // pages, so it has to be just as unstored — or merging is a way round it.
    const f = await fixtures();
    await open(page, f.sample);
    await page.setInputFiles('input[accept="application/pdf,.pdf"][multiple]', f.locked);
    await dialog(page).getByLabel("Password").fill(LOCKED_PASSWORD);
    await dialog(page).getByLabel("Password").press("Enter");
    await expect(page.locator(".doctab")).toHaveCount(2, { timeout: 30_000 });
    await page.locator(".doctab").first().locator(".doctab__btn").click();
    await expect(page.locator(".doctab--active")).toContainText("sample.pdf");

    const before = await page.locator(".page").count();
    await openOrganise(page);
    await page.locator(".organize__docs .chip", { hasText: "locked.pdf" }).click();
    await page.locator(".organize .btn--filled").click();
    await expect(page.locator(".organize")).toHaveCount(0);
    await expect(page.locator(".page")).toHaveCount(before + 2, { timeout: 30_000 });
    await expect(page.locator(".doctab--active .doctab__dirty")).toHaveCount(1);
    await page.waitForTimeout(2500);
    expect(await storeKeys(page)).toEqual([]);
  });

  test("a file with a very long outline still opens", async ({ page }) => {
    // The unlocker walks the file to drop what the encryption left behind. A
    // recursive walk overflowed the stack on a long /Next chain and left the
    // app on a spinner that ignored every later open.
    const w = watch(page);
    await page.goto("/");
    await page.setInputFiles("input[type=file]", {
      name: "long-outline.pdf",
      mimeType: "application/pdf",
      buffer: await longOutlinePdf(30_000),
    });
    await waitForPage(page);
    await expect(page.locator(".page").first()).toContainText("Long outline");
    const bytes = await downloadBytes(page);
    expect(bytes.toString("latin1")).not.toContain("/Encrypt");
    expect(w.errors).toEqual([]);
  });

  test("Cancel while the password is being checked opens nothing", async ({ page }) => {
    const f = await fixtures();
    await pick(page, f.locked);
    const d = dialog(page);
    await d.getByLabel("Password").fill(LOCKED_PASSWORD);
    // Cancel the moment the dialog says "Checking…", before the check ends.
    await page.evaluate(() => {
      const dlg = document.querySelector('[role="dialog"]')!;
      const buttons = () => [...dlg.querySelectorAll("button")];
      new MutationObserver((_, obs) => {
        if (!buttons().some((b) => b.textContent === "Checking…")) return;
        obs.disconnect();
        buttons().find((b) => b.textContent === "Cancel")!.click();
      }).observe(dlg, { subtree: true, childList: true, characterData: true });
      dlg.querySelector("form")!.requestSubmit();
    });
    await expect(d).toHaveCount(0);
    await page.waitForTimeout(1500);
    await expect(page.locator(".page")).toHaveCount(0);
    await expect(page.locator(".doctab")).toHaveCount(0);
  });
});
