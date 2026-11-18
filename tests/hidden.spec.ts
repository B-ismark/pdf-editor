import { test, expect, type Page } from "@playwright/test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNull, PDFString, StandardFonts } from "pdf-lib";
import { hiddenRows, inspectHidden, type HiddenRow } from "../src/pdf/hiddenInfo";
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
  await expect(frag, "the body line, which the test then rewrites").toHaveText(HIDDEN.body);
  const pageBox = (await page.locator(".page").first().boundingBox())!;
  const fb = (await frag.boundingBox())!;
  const overBody = [
    { x: fb.x - pageBox.x - 4, y: fb.y - pageBox.y - 2 },
    { x: fb.x - pageBox.x + fb.width / 2, y: fb.y - pageBox.y + fb.height + 2 },
  ] as const;
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

  // A whiteout over empty paper covers nothing: it isn't counted (the same
  // measure as the warning on Download).
  await pickTool(page, "Whiteout");
  await dragOnPage(page, { x: 60, y: 450 }, { x: 200, y: 490 });
  dialog = await openReport(page);
  await expect(row(page, "covered"), "a whiteout over blank paper hides nothing").toContainText("1 place");
  await page.keyboard.press("Escape");

  await pickTool(page, "Whiteout");
  await dragOnPage(page, overBody[0], overBody[1]);
  dialog = await openReport(page);
  await expect(row(page, "covered"), "the edit and the whiteout over text").toContainText("2 places");
  await expect(row(page, "comments"), "the page still ships its comment").toBeVisible();
  await page.keyboard.press("Escape");

  // A true redaction flattens the page to a picture: nothing is left under the
  // edits, and the page's comment doesn't ship either.
  await pickTool(page, "Redact");
  await dragOnPage(page, { x: 60, y: 520 }, { x: 200, y: 550 });
  dialog = await openReport(page);
  await expect(dialog.locator('[data-row="covered"]')).toHaveCount(0);
  await expect(dialog.locator('[data-row="comments"]'), "a flattened page carries no comments").toHaveCount(0);
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

/**
 * The report must not lie about odd but real files. These read the report
 * straight from the code that builds it (no browser), over files made to trip
 * each way it once went wrong in review.
 */
test.describe("the report reads unusual files truthfully", () => {
  async function report(build: (doc: PDFDocument) => void | Promise<void>, ships?: (i: number) => boolean) {
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 300]);
    page.drawText("Body", { x: 20, y: 250, size: 12, font: await doc.embedFont(StandardFonts.Helvetica) });
    await build(doc);
    const bytes = await doc.save({ useObjectStreams: false });
    const info = await inspectHidden(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, ships);
    const rows = hiddenRows(info, 0);
    const find = (list: HiddenRow[], id: string) => list.find((r) => r.id === id);
    return { removed: (id: string) => find(rows.removed, id), kept: (id: string) => find(rows.kept, id) };
  }
  const annot = (doc: PDFDocument, o: Record<string, unknown>) =>
    doc.getPages()[0].node.addAnnot(doc.context.register(doc.context.obj({ Type: "Annot", Rect: [0, 0, 10, 10], ...o } as never)));

  test("an action or property named like a built-in is counted like any other", async () => {
    const r = await report((doc) => {
      annot(doc, { Subtype: "Link", A: { S: "toString" } });
      annot(doc, { Subtype: "Link", A: { S: "constructor" } });
      annot(doc, { Subtype: "Link", A: { S: "__proto__" } });
      (doc.context.lookup(doc.context.trailerInfo.Info) as PDFDict).set(PDFName.of("constructor"), PDFString.of("x"));
    });
    expect(r.removed("actions")?.title).toBe("3 links that do more than open a page");
    expect(r.removed("actions")?.detail).toContain("1 runs a toString action");
    expect(r.removed("actions")?.detail).toContain("1 runs a __proto__ action");
    expect(r.removed("info")?.facts).toContainEqual({ label: "constructor", value: "x" });
  });

  test("one file named twice (an e-invoice's /AF and its EmbeddedFiles) is one attachment", async () => {
    const r = await report((doc) => {
      const ctx = doc.context;
      const spec = ctx.register(ctx.obj({ Type: "Filespec", F: PDFString.of("factur-x.xml"), UF: PDFString.of("factur-x.xml") }));
      doc.catalog.set(PDFName.of("AF"), ctx.obj([spec]));
      doc.catalog.set(PDFName.of("Names"), ctx.obj({ EmbeddedFiles: { Names: [PDFString.of("factur-x.xml"), spec] } }));
    });
    expect(r.removed("attachments")?.title).toBe("1 attached file");
  });

  test("a player is removed, not kept as a comment", async () => {
    const r = await report((doc) => annot(doc, { Subtype: "Screen", T: PDFString.of("Someone") }));
    expect(r.removed("media")?.title).toBe("1 embedded player");
    expect(r.kept("comments")).toBeUndefined();
  });

  test("an opening view or an empty script list isn't 'something runs'", async () => {
    const r = await report((doc) => {
      const ctx = doc.context;
      doc.catalog.set(PDFName.of("OpenAction"), ctx.obj([doc.getPages()[0].ref, PDFName.of("Fit")]));
      doc.catalog.set(PDFName.of("Names"), ctx.obj({ JavaScript: { Names: [] } }));
    });
    expect(r.removed("scripts")).toBeUndefined();
  });

  test("a safe address with a broken chain is not called an unsafe address", async () => {
    const r = await report((doc) =>
      annot(doc, { Subtype: "Link", A: { S: "URI", URI: PDFString.of("https://example.com/"), Next: [PDFNull] } }),
    );
    expect(r.removed("actions")?.detail).not.toContain("unsafe address");
    expect(r.removed("actions")?.detail).toContain("can't be checked");
  });

  test("private data is counted by page, not by entry", async () => {
    const r = await report((doc) => {
      const node = doc.getPages()[0].node;
      node.set(PDFName.of("PieceInfo"), doc.context.obj({ App: { Private: PDFString.of("x") } }));
      node.set(PDFName.of("LastModified"), PDFString.of("D:20240101"));
      node.set(PDFName.of("Metadata"), doc.context.register(doc.context.stream("<x/>")));
    });
    expect(r.removed("private")?.detail).toContain("on 1 page, image or drawing");
  });

  test("layers switched off by default (/BaseState /OFF) are listed", async () => {
    const r = await report((doc) => {
      const ctx = doc.context;
      const a = ctx.register(ctx.obj({ Type: "OCG", Name: PDFString.of("Shown") }));
      const b = ctx.register(ctx.obj({ Type: "OCG", Name: PDFString.of("Off by default") }));
      doc.catalog.set(PDFName.of("OCProperties"), ctx.obj({ OCGs: [a, b], D: { BaseState: "OFF", ON: [a] } }));
    });
    expect(r.kept("layers")?.detail).toContain("Off by default");
    expect(r.kept("layers")?.detail).not.toContain("Shown");
  });

  test("comments on a page that doesn't ship aren't listed as kept", async () => {
    const build = (doc: PDFDocument) => {
      annot(doc, { Subtype: "Text", T: PDFString.of("Bob") });
    };
    expect((await report(build)).kept("comments")?.detail).toContain("Bob");
    expect((await report(build, () => false)).kept("comments")).toBeUndefined();
  });
});
