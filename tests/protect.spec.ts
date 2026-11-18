import { test, expect, type Page } from "@playwright/test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDict, PDFDocument, PDFName, PDFNumber, PDFString } from "pdf-lib";
import { fixtures, HIDDEN } from "./fixtures";
import { dragOnPage, open, pickTool, watch } from "./helpers";

/**
 * "Download with password": the copy is encrypted (AES-256) and opens only with
 * the password; the document here is unchanged; the password is used for that
 * one file and kept nowhere — not in storage, and not for the next download.
 *
 * The download is read by readers independent of the app: upstream pdf-lib
 * for the encryption dictionary, pdf.js (in Node) to open it with and without
 * the password.
 */

const PASSWORD = "correct horse 7";

async function openProtect(page: Page) {
  await page.click('[aria-label="Export options"]');
  await page.getByRole("menuitem", { name: /Download with password/ }).click();
  const d = page.getByRole("dialog", { name: "Download with password" });
  await expect(d).toBeVisible();
  return d;
}

async function protectedDownload(page: Page, d = page.getByRole("dialog", { name: "Download with password" })): Promise<Buffer> {
  await d.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await d.getByLabel("Type it again").fill(PASSWORD);
  const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 120_000 }), d.getByRole("button", { name: "Download" }).click()]);
  return readFileSync((await dl.path())!);
}

async function plainDownload(page: Page): Promise<Buffer> {
  const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 120_000 }), page.click(".appbar__download")]);
  return readFileSync((await dl.path())!);
}

/** The text of page 1, opened by pdf.js with `password` (or none). */
async function readWith(bytes: Buffer, password?: string): Promise<string> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), password, useWorkerFetch: false, isEvalSupported: false }).promise;
  const content = await (await doc.getPage(1)).getTextContent();
  const text = content.items.map((i) => ("str" in i ? i.str : "")).join(" ");
  await doc.destroy();
  return text;
}

test("the copy needs the password to open, is AES-256, and still has everything export removes taken out", async ({ page }) => {
  const w = watch(page);
  await open(page, (await fixtures()).hidden);
  const d = await openProtect(page);

  // Nothing typed: Enter answers, rather than doing nothing.
  await d.getByLabel("Password", { exact: true }).press("Enter");
  await expect(d.getByRole("alert")).toHaveText("Type a password first.");
  await expect(d.getByLabel("Password", { exact: true })).toHaveAttribute("aria-invalid", "true");
  // Typed twice. Halfway through the second, nothing is called wrong yet…
  await d.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await d.getByLabel("Type it again").pressSequentially("corr");
  await expect(d.getByRole("alert")).toBeHidden();
  await expect(d.getByLabel("Type it again")).not.toHaveAttribute("aria-invalid", "true");
  // …finished and different, it says so, and Download makes nothing.
  await d.getByLabel("Type it again").fill(PASSWORD + "x");
  let downloads = 0;
  page.on("download", () => downloads++);
  await d.getByRole("button", { name: "Download" }).click();
  await expect(d.getByRole("alert")).toHaveText("The two passwords don't match.");
  await expect(d.getByLabel("Type it again")).toHaveAttribute("aria-invalid", "true");
  await d.getByLabel("Type it again").press("Enter");
  await expect(d).toBeVisible();
  expect(downloads).toBe(0);
  // Nothing invites the browser to save the password: no form is submitted,
  // and no field asks to be remembered as a new password.
  await expect(d.locator("form")).toHaveCount(0);
  for (const input of await d.locator('input:not([type="checkbox"])').all()) {
    await expect(input).toHaveAttribute("autocomplete", "off");
  }
  // Show password turns both fields to text.
  await d.getByLabel("Show password").check();
  await expect(d.getByLabel("Type it again")).toHaveAttribute("type", "text");

  const bytes = await protectedDownload(page, d);
  await expect(d).toBeHidden();
  await expect(page.locator(".snackbar__msg")).toContainText("opens only with the password you set");

  // Encrypted, AES-256 (V 5, R 6).
  const raw = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const enc = raw.context.lookup(raw.context.trailerInfo.Encrypt) as PDFDict;
  expect(enc, "an encryption dictionary").toBeInstanceOf(PDFDict);
  expect((enc.get(PDFName.of("V")) as PDFNumber).asNumber()).toBe(5);
  expect((enc.get(PDFName.of("R")) as PDFNumber).asNumber()).toBe(6);

  // pdf.js won't open it without the password, or with a wrong one…
  await expect(readWith(bytes)).rejects.toThrow(/password/i);
  await expect(readWith(bytes, "wrong")).rejects.toThrow(/password/i);
  // …and with it, the page is all there.
  expect(await readWith(bytes, PASSWORD)).toContain(HIDDEN.body);

  // Encrypting comes after the clean-up, not instead of it.
  const lib = await import("@cantoo/pdf-lib");
  const open2 = await lib.PDFDocument.load(bytes, { password: PASSWORD, updateMetadata: false });
  const info = open2.context.lookup(open2.context.trailerInfo.Info);
  expect(info instanceof lib.PDFDict ? info.keys().length : 0, "no document properties").toBe(0);
  expect(open2.catalog.get(lib.PDFName.of("Metadata")), "no XMP").toBeUndefined();
  expect(w.errors).toEqual([]);
  expect(w.external).toEqual([]);
});

test("the app's own password prompt opens the copy", async ({ page, browser }) => {
  await open(page, (await fixtures()).hidden);
  await openProtect(page);
  const bytes = await protectedDownload(page);
  const out = join(mkdtempSync(join(tmpdir(), "protect-")), "protected.pdf");
  writeFileSync(out, bytes);

  const view = await browser.newPage();
  await view.goto("/");
  await view.setInputFiles("input[type=file]", out);
  const prompt = view.getByRole("dialog", { name: "This PDF is password-protected" });
  await expect(prompt).toBeVisible({ timeout: 20_000 });
  await prompt.getByLabel("Password").fill(PASSWORD);
  await prompt.getByRole("button", { name: "Open" }).click();
  await expect(view.locator(".page").first()).toContainText(HIDDEN.body, { timeout: 30_000 });
  await view.close();
});

test("the password is kept nowhere: not in storage, not for the next download", async ({ page }) => {
  await open(page, (await fixtures()).hidden);
  await openProtect(page);
  await protectedDownload(page);

  const stored = await page.evaluate(
    () =>
      new Promise<string>((resolve) => {
        const parts: string[] = [];
        for (const s of [localStorage, sessionStorage]) for (let i = 0; i < s.length; i++) parts.push(s.key(i)!, s.getItem(s.key(i)!)!);
        const req = indexedDB.open("pdf-editor", 1);
        req.onupgradeneeded = () => req.result.createObjectStore("session");
        req.onsuccess = () => {
          const all = req.result.transaction("session", "readonly").objectStore("session").getAll();
          all.onsuccess = () => {
            const dec = new TextDecoder("latin1");
            const flat = (v: unknown): string =>
              v instanceof ArrayBuffer ? dec.decode(v) : ArrayBuffer.isView(v) ? dec.decode(v as Uint8Array) : v && typeof v === "object" ? Object.values(v).map(flat).join("\n") : String(v);
            parts.push(...all.result.map(flat));
            req.result.close();
            resolve(parts.join("\n"));
          };
        };
      }),
  );
  expect(stored).not.toContain(PASSWORD);

  // A plain Download afterwards is plain.
  const next = await plainDownload(page);
  const raw = await PDFDocument.load(next, { ignoreEncryption: true, updateMetadata: false });
  expect(raw.context.trailerInfo.Encrypt, "the next download has no password").toBeUndefined();
  expect(raw.isEncrypted).toBe(false);
});

test("going through the whiteout warning still makes the protected copy", async ({ page }) => {
  await open(page, (await fixtures()).hidden);
  const frag = page.locator('.page [role="textbox"]').first();
  await expect(frag).toHaveText(HIDDEN.body);
  const pg = (await page.locator(".page").first().boundingBox())!;
  const fb = (await frag.boundingBox())!;
  await pickTool(page, "Whiteout");
  await dragOnPage(page, { x: fb.x - pg.x - 4, y: fb.y - pg.y - 2 }, { x: fb.x - pg.x + fb.width / 2, y: fb.y - pg.y + fb.height + 2 });

  const d = await openProtect(page);
  await d.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await d.getByLabel("Type it again").fill(PASSWORD);
  await d.getByRole("button", { name: "Download" }).click();
  const warn = page.getByRole("alertdialog").or(page.getByRole("dialog", { name: "Whiteout doesn't remove the text" }));
  await expect(warn).toBeVisible();
  const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 120_000 }), warn.getByRole("button", { name: "Download anyway" }).click()]);
  const bytes = readFileSync((await dl.path())!);
  const raw = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  expect(raw.isEncrypted, "the copy asked for is the copy made").toBe(true);
});

// One dialog handing over to another in the same moment (the password form
// closing as the whiteout warning opens) used to lose the warning's history
// step — so closing the warning stepped the browser out of the app.
test("closing the whiteout warning after the password form stays in the app", async ({ page }) => {
  await open(page, (await fixtures()).hidden);
  const url = page.url();
  const frag = page.locator('.page [role="textbox"]').first();
  const pg = (await page.locator(".page").first().boundingBox())!;
  const fb = (await frag.boundingBox())!;
  await pickTool(page, "Whiteout");
  await dragOnPage(page, { x: fb.x - pg.x - 4, y: fb.y - pg.y - 2 }, { x: fb.x - pg.x + fb.width / 2, y: fb.y - pg.y + fb.height + 2 });
  const d = await openProtect(page);
  await d.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await d.getByLabel("Type it again").fill(PASSWORD);
  await d.getByRole("button", { name: "Download" }).click();
  const warn = page.getByRole("alertdialog", { name: "Whiteout doesn't remove the text" });
  await warn.getByRole("button", { name: "Go back" }).click();
  await expect(warn).toBeHidden();
  await page.waitForTimeout(500);
  expect(page.url()).toBe(url);
  await expect(page.locator(".page").first()).toBeVisible();
  // And the next modal still answers the Back gesture instead of leaving.
  await openProtect(page);
  await page.goBack();
  await expect(page.getByRole("dialog", { name: "Download with password" })).toBeHidden();
  expect(page.url()).toBe(url);
  await expect(page.locator(".page").first()).toBeVisible();
});

// pdf-lib encrypts streams only; strings in the objects it keeps out of
// object streams (the catalog, pages, stream dictionaries) went out in the
// clear — readable without the password, scrambled with it.
test("text on the document's own dictionaries is encrypted too, and reads back right", async ({ page }) => {
  const src = await PDFDocument.create();
  const p = src.addPage([300, 300]);
  p.drawText("Body", { x: 40, y: 200, size: 20 });
  const cat = src.catalog;
  cat.set(PDFName.of("Lang"), PDFString.of("xx-SECRETLANG"));
  cat.set(
    PDFName.of("PageLabels"),
    src.context.obj({ Nums: [0, src.context.obj({ S: "D", P: PDFString.of("SECRETLABEL-") })] }),
  );
  const file = join(mkdtempSync(join(tmpdir(), "protect-")), "labels.pdf");
  writeFileSync(file, await src.save({ useObjectStreams: false }));

  await open(page, file);
  const bytes = await protectedDownload(page, await openProtect(page));
  const raw = bytes.toString("latin1");
  expect(raw, "the language tag isn't readable without the password").not.toContain("SECRETLANG");
  expect(raw, "the page label isn't readable without the password").not.toContain("SECRETLABEL");

  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), password: PASSWORD, useWorkerFetch: false, isEvalSupported: false }).promise;
  expect(await doc.getPageLabels(), "the label reads back with the password").toEqual(["SECRETLABEL-1"]);
  await doc.destroy();
});

// On a phone, something selected holds a history entry of the editor's own
// (Back puts it away). Opening the dialog clears the selection — removing
// that entry — in the same moment the dialog adds its own; and a dialog's
// own removal used to be taken by the editor for Back.
test("phone: with something selected, the dialog still closes on Back and the app stays", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await open(page, (await fixtures()).sample);
  const url = page.url();
  const dialog = page.getByRole("dialog", { name: "Download with password" });
  const openIt = async () => {
    await page.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: /Download with password/ }).click();
    await expect(dialog).toBeVisible();
  };
  // Once with nothing selected, so the dialog's code is loaded and the next
  // open lands in the same render as the deselect.
  await openIt();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();

  await page.locator(".fragment").nth(2).tap();
  await expect(page.locator(".zoombar"), "something is selected").toHaveCount(0);
  await openIt();
  await page.waitForTimeout(300);
  await page.goBack();
  await expect(dialog, "Back closed the dialog").toBeHidden();
  await page.waitForTimeout(300);
  expect(page.url()).toBe(url);
  await expect(page.locator(".page").first(), "and not the app").toBeVisible();

  await ctx.close();
});

// AES-256 hashes the password after SASLprep, as Acrobat does with what's
// typed. A full-width password from an IME, or one with a no-break space,
// would otherwise make a copy that opens here and not there.
test("a password typed with full-width letters or a no-break space opens the copy everywhere", async ({ page }) => {
  await open(page, (await fixtures()).hidden);
  const typed = "ｐａｓｓ ｗｏｒｄ";
  const d = await openProtect(page);
  await d.getByLabel("Password", { exact: true }).fill(typed);
  await d.getByLabel("Type it again").fill(typed);
  const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 120_000 }), d.getByRole("button", { name: "Download" }).click()]);
  const bytes = readFileSync((await dl.path())!);
  // What a standard reader hashes: the prepared form.
  expect(await readWith(bytes, "pass word")).toContain(HIDDEN.body);
  // And typed as it was into this app's own prompt, it still opens.
  const file = join(mkdtempSync(join(tmpdir(), "protect-")), "fullwidth.pdf");
  writeFileSync(file, bytes);
  await page.setInputFiles('input[data-open-input]', file);
  const prompt = page.getByRole("dialog", { name: /password/i }).last();
  await prompt.getByLabel(/password/i).first().fill(typed);
  await prompt.getByRole("button", { name: /Open|Unlock/ }).click();
  await expect(page.locator(".doctab")).toHaveCount(2, { timeout: 30_000 });
  await expect(page.locator('.page [role="textbox"]').first()).toHaveText(HIDDEN.body, { timeout: 30_000 });
});
