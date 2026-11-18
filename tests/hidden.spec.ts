import { test, expect, type Page } from "@playwright/test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFString } from "pdf-lib";
import { fixtures, HIDDEN } from "./fixtures";
import { dragOnPage, open, pickTool, watch } from "./helpers";

/**
 * "Hidden information": what a file carries off the page, split into what the
 * export removes and what it keeps.
 *
 * The removed list is read from the export's own clean-up run on a copy, so
 * the checks here go both ways: everything listed is really gone from the
 * download, and the download, reopened, has nothing left to list.
 */

async function openReport(page: Page) {
  await page.keyboard.press("Control+k");
  await page.locator(".cmdk__input").fill("Hidden information");
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Hidden information" });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".hidden__body")).toHaveAttribute("aria-busy", "false", { timeout: 20_000 });
  return dialog;
}

const row = (page: Page, id: string) => page.getByRole("dialog", { name: "Hidden information" }).locator(`[data-row="${id}"]`);

async function download(page: Page): Promise<Buffer> {
  const [d] = await Promise.all([page.waitForEvent("download", { timeout: 120_000 }), page.click(".appbar__download")]);
  return readFileSync((await d.path())!);
}

test("lists what export removes and what it keeps", async ({ page }) => {
  const w = watch(page);
  await open(page, (await fixtures()).hidden);
  const dialog = await openReport(page);

  const removed = dialog.locator("section").filter({ hasText: "Removed when you export" });
  await expect(row(page, "info")).toContainText(`Author${HIDDEN.author}`);
  await expect(row(page, "info")).toContainText(`Made with${HIDDEN.creator}`);
  await expect(row(page, "info"), "a producer's own entry is named as it is").toContainText(`Company${HIDDEN.company}`);
  await expect(row(page, "xmp")).toBeVisible();
  await expect(row(page, "fileid")).toBeVisible();
  await expect(row(page, "attachments")).toContainText("2 attached files");
  await expect(row(page, "attachments")).toContainText(HIDDEN.embedded);
  await expect(row(page, "attachments")).toContainText(HIDDEN.attached);
  await expect(row(page, "scripts")).toContainText("Something runs when the file opens");
  await expect(row(page, "scripts"), "the name-tree script; the open action counts once as auto-run").toContainText("1 script");
  await expect(row(page, "scripts"), "the page's open trigger").toContainText("1 automatic action");
  await expect(row(page, "actions")).toContainText("1 opens a program or file");
  await expect(row(page, "actions")).toContainText("1 sends form data to a website");
  await expect(row(page, "private")).toBeVisible();
  await expect(removed.locator("[data-row]")).toHaveCount(7);

  const kept = dialog.locator("section").filter({ hasText: "Stays in the file" });
  await expect(kept.locator('[data-row="comments"]')).toContainText(`Signed by ${HIDDEN.reviewer}`);
  await expect(kept.locator('[data-row="layers"]')).toContainText(HIDDEN.layer);
  await expect(kept.locator('[data-row="covered"]'), "nothing edited yet").toHaveCount(0);

  // Escape closes it.
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  expect(w.errors).toEqual([]);
});

test("everything it says is removed is gone from the download, and the download has nothing left to list", async ({ page, browser }) => {
  await open(page, (await fixtures()).hidden);
  const bytes = await download(page);

  // Read the structure, not the bytes: the download packs objects into
  // compressed streams, where a text search finds nothing either way.
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const ctx = doc.context;
  const info = ctx.lookup(ctx.trailerInfo.Info);
  expect(info instanceof PDFDict ? info.keys().length : 0, "no document properties").toBe(0);
  expect(ctx.trailerInfo.ID, "no file identifier").toBeUndefined();
  for (const key of ["Metadata", "OpenAction", "AA"]) {
    expect(doc.catalog.get(PDFName.of(key)), `no catalog /${key}`).toBeUndefined();
  }
  const names = doc.catalog.lookupMaybe(PDFName.of("Names"), PDFDict);
  expect(names?.keys().map(String) ?? [], "no scripts or files in the name tree").toEqual([]);
  const pg = doc.getPages()[0].node;
  expect(pg.get(PDFName.of("AA")), "no page trigger").toBeUndefined();
  expect(pg.get(PDFName.of("PieceInfo")), "no private data").toBeUndefined();
  const annots = pg.lookup(PDFName.of("Annots"), PDFArray).asArray().map((a) => ctx.lookup(a) as PDFDict);
  const subtype = (a: PDFDict) => String(a.get(PDFName.of("Subtype")));
  expect(annots.map(subtype), "the attachment is gone").not.toContain("/FileAttachment");
  for (const a of annots) expect(a.get(PDFName.of("A")), `no action on ${subtype(a)}`).toBeUndefined();
  // Kept, as the report said: the comment and its author, the switched-off layer.
  const comment = annots.find((a) => subtype(a) === "/Text");
  expect(comment?.lookup(PDFName.of("T"), PDFString).decodeText()).toBe(HIDDEN.reviewer);
  const oc = doc.catalog.lookup(PDFName.of("OCProperties"), PDFDict);
  const off = oc.lookup(PDFName.of("D"), PDFDict).lookup(PDFName.of("OFF"), PDFArray);
  expect((ctx.lookup(off.get(0)) as PDFDict).lookup(PDFName.of("Name"), PDFString).decodeText()).toBe(HIDDEN.layer);

  const out = join(mkdtempSync(join(tmpdir(), "hidden-")), "out.pdf");
  writeFileSync(out, bytes);
  const view = await browser.newPage();
  await open(view, out);
  const dialog = await openReport(view);
  await expect(dialog.locator(".hidden__none"), "the exported copy carries nothing the export would remove").toBeVisible();
  await expect(dialog.locator('[data-row="comments"]')).toBeVisible();
  await view.close();
});

test("text under an edit or a whiteout is listed as still in the file, until the page is redacted", async ({ page }) => {
  await open(page, (await fixtures()).hidden);
  const frag = page.locator('.page [role="textbox"]').first();
  await frag.click();
  await frag.evaluate((el) => {
    (el as HTMLElement).focus();
    document.execCommand("selectAll");
  });
  await page.keyboard.type("Replaced");
  await frag.evaluate((el) => (el as HTMLElement).blur());

  let dialog = await openReport(page);
  await expect(row(page, "covered")).toContainText("1 place");
  await page.keyboard.press("Escape");

  await pickTool(page, "Whiteout");
  await dragOnPage(page, { x: 60, y: 300 }, { x: 200, y: 340 });
  dialog = await openReport(page);
  await expect(row(page, "covered"), "the edit and the whiteout").toContainText("2 places");
  await page.keyboard.press("Escape");

  // A true redaction flattens the page: nothing is left underneath.
  await pickTool(page, "Redact");
  await dragOnPage(page, { x: 60, y: 450 }, { x: 200, y: 480 });
  dialog = await openReport(page);
  await expect(dialog.locator('[data-row="covered"]')).toHaveCount(0);
});

test("is reachable from the ⋯ menu and opens over the page", async ({ page }) => {
  await open(page, (await fixtures()).hidden);
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: /Hidden information/ }).click();
  const dialog = page.getByRole("dialog", { name: "Hidden information" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Close", exact: true }).first().click();
  await expect(dialog).toBeHidden();
});
