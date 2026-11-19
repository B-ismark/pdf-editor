import { test, expect, type Page } from "@playwright/test";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRef, PDFString, type PDFPage } from "pdf-lib";
import { readFileSync } from "node:fs";
import { fixtures, OUTLINED } from "./fixtures";
import { open, watch, pickTool, dragOnPage, expectClean, pageTexts } from "./helpers";
import { buildFromPlan, type PlanEntry } from "../src/pdf/pageOps";

/**
 * 8e: a document's own bookmarks are a way around it, and a link can go to a
 * page of the document rather than a web address.
 *
 * The outline is read from the file (pdf.js resolves `/Dest`, GoTo actions and
 * named destinations alike) and shown against the document *as arranged*: a
 * bookmark goes to where its page is now, says which page that is, and is shown
 * but can't be followed when its page was deleted. A link to a page names the
 * page itself, so it follows the page through moves, and lands on the raster
 * that replaces it when the page is redacted.
 */

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
});

const tree = (page: Page) => page.getByRole("tree", { name: "Outline" });
const item = (page: Page, title: string) => tree(page).getByRole("treeitem", { name: new RegExp(`^${title},`) });
/** The page the viewer is on, as the sidebar's page list marks it (the list
 * stays mounted, hidden, while the outline shows). */
const current = (page: Page) =>
  page.locator('.pagenav__item[aria-current="page"]').getAttribute("aria-label").then((l) => Number(/^Page (\d+)/.exec(l ?? "")?.[1]));
const order = (page: Page) =>
  page.locator(".page").evaluateAll((els) => els.map((el) => Number((el as HTMLElement).dataset.pageIndex)));

async function showOutline(page: Page) {
  await page.getByRole("button", { name: "Show pages" }).click();
  await page.getByRole("tab", { name: "Outline" }).click();
  await expect(tree(page)).toBeVisible();
}

async function download(page: Page): Promise<Buffer> {
  const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 120_000 }), page.click(".appbar__download")]);
  return readFileSync((await dl.path())!);
}

/** Each link annotation on a page of `doc`: the output page index its `/Dest`
 * (or GoTo action) lands on, or the URI it opens. */
function linksOn(doc: PDFDocument, pageIndex: number) {
  const pages = doc.getPages().map((p) => p.ref);
  const look = <T>(v: unknown) => (v instanceof PDFRef ? doc.context.lookup(v) : v) as T;
  const annots = look<PDFArray | undefined>(doc.getPage(pageIndex).node.get(PDFName.of("Annots")));
  const out: { to?: number; uri?: string }[] = [];
  for (let i = 0; i < (annots?.size() ?? 0); i++) {
    const a = look<PDFDict>(annots!.get(i));
    if (String(a.get(PDFName.of("Subtype"))) !== "/Link") continue;
    const action = look<PDFDict | undefined>(a.get(PDFName.of("A")));
    const dest = look<PDFArray | undefined>(a.get(PDFName.of("Dest")) ?? action?.get(PDFName.of("D")));
    const ref = dest instanceof PDFArray ? dest.get(0) : undefined;
    const uri = action?.get(PDFName.of("URI"));
    out.push({
      to: ref instanceof PDFRef ? pages.findIndex((p) => p === ref) : undefined,
      uri: uri instanceof PDFString ? uri.decodeText() : undefined,
    });
  }
  return out;
}

test.describe("the outline", () => {
  test("lists the bookmarks as a tree and goes to each one's page, as the pages are now arranged", async ({ page }) => {
    const w = watch(page);
    await open(page, (await fixtures()).outlined);
    await showOutline(page);

    // Top level first, closed; the web-address bookmark is shown but leads nowhere.
    await expect(tree(page).getByRole("treeitem")).toHaveCount(3);
    await expect(item(page, "Part one")).toHaveAttribute("aria-expanded", "false");
    await expect(item(page, "Part one")).toHaveAttribute("aria-label", "Part one, page 1");
    await expect(item(page, "Website")).toHaveAttribute("aria-disabled", "true");

    await item(page, "Part two").click();
    await expect.poll(() => current(page), "a GoTo bookmark goes to its page").toBe(4);

    // Open "Part one" by its arrow: the arrow opens, it doesn't go.
    await item(page, "Part one").locator(".outline__twisty").click();
    await expect(item(page, "Part one")).toHaveAttribute("aria-expanded", "true");
    await expect(tree(page).getByRole("treeitem")).toHaveCount(5);
    await expect(item(page, "Section A")).toHaveAttribute("aria-level", "2");
    await expect.poll(() => current(page)).toBe(4);

    await item(page, "Section B").click();
    await expect.poll(() => current(page), "a named destination resolves").toBe(3);

    // Move page 4 to the front: "Part two" now names page 1, and goes there.
    await page.getByRole("tab", { name: "Pages" }).click();
    await page.locator(".pagenav__item").nth(3).click();
    for (let i = 0; i < 3; i++) await page.keyboard.press("Alt+ArrowUp");
    await expect.poll(() => order(page)).toEqual([3, 0, 1, 2]);
    await page.locator(".pagenav__item").nth(3).click();
    await page.getByRole("tab", { name: "Outline" }).click();
    await expect(item(page, "Part two")).toHaveAttribute("aria-label", "Part two, page 1");
    await item(page, "Part two").click();
    await expect.poll(() => current(page)).toBe(1);

    // Delete the page "Section A" opens: it stays in the outline, can't be followed.
    await page.getByRole("tab", { name: "Pages" }).click();
    await page.locator(".pagenav__item").nth(2).click();
    await page.keyboard.press("Delete");
    await expect.poll(() => order(page)).toEqual([3, 0, 2]);
    await page.getByRole("tab", { name: "Outline" }).click();
    await expect(item(page, "Section A")).toHaveAttribute("aria-label", "Section A, page deleted");
    await expect(item(page, "Section A")).toHaveAttribute("aria-disabled", "true");
    await item(page, "Section A").click({ force: true });
    await expect.poll(() => current(page), "a deleted page's bookmark goes nowhere").toBe(1);
    expectClean(w);
  });

  test("works from the keyboard: arrows move, open and close, Enter goes", async ({ page }) => {
    await open(page, (await fixtures()).outlined);
    await showOutline(page);
    await item(page, "Part one").focus();
    await page.keyboard.press("ArrowRight");
    await expect(item(page, "Part one")).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("ArrowRight");
    await expect(item(page, "Section A")).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(item(page, "Section B")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect.poll(() => current(page)).toBe(3);
    await page.keyboard.press("ArrowLeft");
    await expect(item(page, "Part one")).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await expect(item(page, "Part one")).toHaveAttribute("aria-expanded", "false");
    await page.keyboard.press("End");
    await expect(item(page, "Website")).toBeFocused();
    // Arrows in the tree don't reach the editor (no page nudged, no tool picked).
    await expect(tree(page).getByRole("treeitem")).toHaveCount(3);
  });

  test("a document without bookmarks has no Outline switch", async ({ page }) => {
    await open(page, (await fixtures()).sample);
    await page.getByRole("button", { name: "Show pages" }).click();
    await expect(page.locator(".pagenav__item").first()).toBeVisible();
    await expect(page.getByRole("tab", { name: "Outline" })).toHaveCount(0);
  });
});

test.describe("a link to a page", () => {
  /** A page number takes on Enter (or on leaving the field). */
  async function setLinkPage(page: Page, n: string) {
    await page.fill("#link-page", n);
    await page.locator("#link-page").press("Enter");
  }

  async function linkOnFirstPage(page: Page) {
    await pickTool(page, "Link");
    await dragOnPage(page, { x: 80, y: 120 }, { x: 280, y: 165 });
    await page.getByRole("radio", { name: "Page" }).click();
    await expect(page.locator("#link-page")).toHaveValue("1");
  }

  test("follows its page through a move, and the file's link lands on it", async ({ page }) => {
    const w = watch(page);
    await open(page, (await fixtures()).outlined);
    await linkOnFirstPage(page);
    await setLinkPage(page, "3");
    await expect(page.locator("#link-page-note")).toHaveText("Follows the page if it moves.");
    await expect(page.locator(".linkbox")).toHaveAttribute("data-tip", "Page 3");

    // Out of range says so and changes nothing.
    await page.fill("#link-page", "9");
    await expect(page.locator("#link-page")).toHaveAttribute("aria-invalid", "true");
    await expect(page.locator("#link-page-note")).toContainText("from 1 to 4");
    await page.locator("#link-page").blur();
    await expect(page.locator("#link-page")).toHaveValue("3");

    // Move the target page (source 2) to the front: the link follows it.
    await page.getByRole("button", { name: "Show pages" }).click();
    await page.locator(".pagenav__item").nth(2).click();
    await page.keyboard.press("Alt+ArrowUp");
    await page.keyboard.press("Alt+ArrowUp");
    await expect.poll(() => order(page)).toEqual([2, 0, 1, 3]);
    await expect(page.locator(".linkbox")).toHaveAttribute("data-tip", "Page 1");

    const doc = await PDFDocument.load(await download(page));
    // The link sits on source page 0, now the second page; it opens the first.
    expect(linksOn(doc, 1)).toEqual([{ to: 0, uri: undefined }]);
    expectClean(w);
  });

  test("switching back to a web address keeps the address", async ({ page }) => {
    await open(page, (await fixtures()).outlined);
    await pickTool(page, "Link");
    await dragOnPage(page, { x: 80, y: 120 }, { x: 280, y: 165 });
    await page.fill("#link-url", "https://example.com/a");
    await page.getByRole("radio", { name: "Page" }).click();
    await setLinkPage(page, "2");
    await page.getByRole("radio", { name: "Web address" }).click();
    await expect(page.locator("#link-url")).toHaveValue("https://example.com/a");
    const doc = await PDFDocument.load(await download(page));
    expect(linksOn(doc, 0)).toEqual([{ to: undefined, uri: "https://example.com/a" }]);
  });

  test("to a deleted page is flagged and left out of the file", async ({ page }) => {
    await open(page, (await fixtures()).outlined);
    await linkOnFirstPage(page);
    await setLinkPage(page, "2");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Show pages" }).click();
    await page.locator(".pagenav__item").nth(1).click();
    await page.keyboard.press("Delete");
    await expect.poll(() => order(page)).toEqual([0, 2, 3]);
    await expect(page.locator(".linkbox")).toHaveAttribute("data-tip", "Its page was deleted");
    await expect(page.locator(".linkbox")).toHaveClass(/linkbox--empty/);
    await page.locator(".linkbox").click();
    await expect(page.locator("#link-page-note")).toContainText("was deleted");
    await expect(page.locator("#link-page")).toHaveAttribute("aria-invalid", "true");

    const doc = await PDFDocument.load(await download(page));
    expect(doc.getPageCount()).toBe(3);
    expect(linksOn(doc, 0)).toEqual([]);
  });

  test("lands on the raster that replaces a redacted page", async ({ page }) => {
    await open(page, (await fixtures()).outlined);
    await linkOnFirstPage(page);
    await setLinkPage(page, "2");
    await page.keyboard.press("Escape");
    // Redact on page 2, which is exported after the link is written.
    await pickTool(page, "Redact");
    await page.locator('.page[data-page-pos="1"]').evaluate((el) => el.scrollIntoView({ block: "start" }));
    await page.waitForTimeout(300);
    const p2 = (await page.locator('.page[data-page-pos="1"]').boundingBox())!;
    await page.mouse.move(p2.x + 40, p2.y + 40);
    await page.mouse.down();
    await page.mouse.move(p2.x + 400, p2.y + 120, { steps: 6 });
    await page.mouse.up();
    await expect(page.locator(".redaction")).toHaveCount(1);

    const bytes = await download(page);
    const [, second] = await pageTexts(bytes, [1, 2]);
    expect(second.trim(), "page 2 was rasterised").toBe("");
    const doc = await PDFDocument.load(bytes);
    expect(linksOn(doc, 0), "the link opens the raster, not the page it replaced").toEqual([{ to: 1, uri: undefined }]);
    expect(OUTLINED.pages).toBe(doc.getPageCount());
  });
});

/**
 * Merge, Extract and Split rebuild the file with `copyPages`, which copies a
 * page a link jumps to a second time, through the link, outside the page tree.
 * That copy was cut as a stray, and the link with it — even when the page it
 * goes to was kept. A link to a kept page must land on that page's copy.
 */
test.describe("a rebuild keeps links between kept pages", () => {
  async function linked(): Promise<ArrayBuffer> {
    const doc = await PDFDocument.create();
    const [a, b, c] = [doc.addPage([300, 300]), doc.addPage([300, 300]), doc.addPage([300, 300])];
    a.drawText("one", { x: 20, y: 200 });
    b.drawText("two", { x: 20, y: 200 });
    c.drawText("three", { x: 20, y: 200 });
    const link = (from: typeof a, to: typeof a) =>
      from.node.addAnnot(
        doc.context.register(
          doc.context.obj({ Type: "Annot", Subtype: "Link", Rect: [10, 10, 100, 40], Dest: [to.ref, PDFName.of("Fit")] }),
        ),
      );
    link(a, b);
    link(c, a);
    const bytes = await doc.save();
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  }
  const plan = (...idx: number[]): PlanEntry[] => idx.map((index) => ({ sourceKey: "main", index, rotation: 0 }));

  test("in order, reordered, and with the target left out", async () => {
    const sources = new Map([["main", await linked()]]);
    let doc = await PDFDocument.load(await buildFromPlan(plan(0, 1, 2), sources));
    expect(linksOn(doc, 0), "page 1 → page 2").toEqual([{ to: 1, uri: undefined }]);
    expect(linksOn(doc, 2), "page 3 → page 1").toEqual([{ to: 0, uri: undefined }]);

    doc = await PDFDocument.load(await buildFromPlan(plan(2, 1, 0), sources));
    expect(linksOn(doc, 2), "page 1, now last, → page 2, now second").toEqual([{ to: 1, uri: undefined }]);
    expect(linksOn(doc, 0)).toEqual([{ to: 2, uri: undefined }]);

    // Extract page 1 alone: its link's page isn't there, so the link goes —
    // and no copy of page 2 is left in the file.
    const bytes = await buildFromPlan(plan(0), sources);
    doc = await PDFDocument.load(bytes);
    expect(linksOn(doc, 0)).toEqual([]);
    expect(Buffer.from(bytes).toString("latin1").match(/\/Type\s*\/Page\b/g)?.length).toBe(1);
  });

  /** Three pages; `shape` sets each one up, then `from → to` links are added. */
  async function built(shape: (pages: PDFPage[], doc: PDFDocument) => void, links: [number, number][]) {
    const doc = await PDFDocument.create();
    const pages = [doc.addPage([300, 300]), doc.addPage([300, 300]), doc.addPage([300, 300])];
    shape(pages, doc);
    for (const [from, to] of links)
      pages[from].node.addAnnot(
        doc.context.register(
          doc.context.obj({ Type: "Annot", Subtype: "Link", Rect: [10, 10, 100, 40], Dest: [pages[to].ref, PDFName.of("Fit")] }),
        ),
      );
    const bytes = await doc.save();
    return new Map([["main", bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer]]);
  }

  test("two pages drawn from one content stream are still two pages", async () => {
    // Pages 1 and 2 share their drawing (a template); page 3 links to page 1.
    const sources = await built(([a, b, c]) => {
      a.drawText("same", { x: 20, y: 200 });
      // One stream, by reference from both pages.
      const drawn = a.node.get(PDFName.of("Contents"));
      const stream = drawn instanceof PDFArray ? drawn.get(0) : drawn!;
      a.node.set(PDFName.of("Contents"), stream);
      b.node.set(PDFName.of("Contents"), stream);
      c.drawText("three", { x: 20, y: 200 });
    }, [[2, 0]]);
    let doc = await PDFDocument.load(await buildFromPlan(plan(0, 1, 2), sources));
    expect(linksOn(doc, 2), "to page 1, not its look-alike").toEqual([{ to: 0, uri: undefined }]);
    doc = await PDFDocument.load(await buildFromPlan(plan(1, 2), sources));
    expect(linksOn(doc, 1), "page 1 left out: the link goes, not to page 2").toEqual([]);
  });

  test("a link to a blank page, and to a page used twice", async () => {
    // Page 2 is blank — no content stream at all.
    const sources = await built(([a, , c]) => {
      a.drawText("one", { x: 20, y: 200 });
      c.drawText("three", { x: 20, y: 200 });
    }, [[0, 1], [2, 0]]);
    let doc = await PDFDocument.load(await buildFromPlan(plan(0, 1, 2), sources));
    expect(linksOn(doc, 0), "to the blank page").toEqual([{ to: 1, uri: undefined }]);
    // Page 2 twice: its link goes to its first use.
    doc = await PDFDocument.load(await buildFromPlan(plan(0, 1, 1, 2), sources));
    expect(linksOn(doc, 0)).toEqual([{ to: 1, uri: undefined }]);
    expect(linksOn(doc, 3)).toEqual([{ to: 0, uri: undefined }]);
  });
});

test.describe("the link panel's controls", () => {
  test("typing a page number that's too long doesn't move the link on the way", async ({ page }) => {
    await open(page, (await fixtures()).outlined);
    await pickTool(page, "Link");
    await dragOnPage(page, { x: 80, y: 120 }, { x: 280, y: 165 });
    await page.getByRole("radio", { name: "Page" }).click();
    await page.fill("#link-page", "3");
    await page.locator("#link-page").press("Enter");
    await expect(page.locator(".linkbox")).toHaveAttribute("data-tip", "Page 3");
    // "1" on the way to "12" (out of range): the link stays on page 3.
    await page.fill("#link-page", "");
    await page.locator("#link-page").pressSequentially("12");
    await page.locator("#link-page").blur();
    await expect(page.locator("#link-page")).toHaveValue("3");
    await expect(page.locator(".linkbox")).toHaveAttribute("data-tip", "Page 3");
    // A valid number takes on Enter or on leaving the field.
    await page.fill("#link-page", "4");
    await page.locator("#link-page").blur();
    await expect(page.locator(".linkbox")).toHaveAttribute("data-tip", "Page 4");
  });

  test("the Goes to and Pages | Outline switches take arrow keys, one stop each", async ({ page }) => {
    await open(page, (await fixtures()).outlined);
    await pickTool(page, "Link");
    await dragOnPage(page, { x: 80, y: 120 }, { x: 280, y: 165 });
    const web = page.getByRole("radio", { name: "Web address" });
    const pg = page.getByRole("radio", { name: "Page" });
    await expect(web).toHaveAttribute("tabindex", "0");
    await expect(pg).toHaveAttribute("tabindex", "-1");
    await web.focus();
    await page.keyboard.press("ArrowRight");
    await expect(pg).toBeFocused();
    await expect(pg).toHaveAttribute("aria-checked", "true");
    await expect(page.locator("#link-page")).toBeVisible();
    await page.keyboard.press("ArrowLeft");
    await expect(web).toHaveAttribute("aria-checked", "true");

    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Show pages" }).click();
    const pagesTab = page.getByRole("tab", { name: "Pages" });
    const outlineTab = page.getByRole("tab", { name: "Outline" });
    await expect(outlineTab).toHaveAttribute("tabindex", "-1");
    await pagesTab.focus();
    await page.keyboard.press("ArrowRight");
    await expect(outlineTab).toBeFocused();
    await expect(tree(page)).toBeVisible();
  });

  test("arrowing between Web address and Page doesn't also nudge the link", async ({ page }) => {
    await open(page, (await fixtures()).outlined);
    await pickTool(page, "Link");
    await dragOnPage(page, { x: 80, y: 120 }, { x: 280, y: 165 });
    const before = await page.locator(".linkbox").boundingBox();
    await page.getByRole("radio", { name: "Web address" }).focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("radio", { name: "Web address" })).toHaveAttribute("aria-checked", "true");
    expect(await page.locator(".linkbox").boundingBox()).toEqual(before);
  });

  test("End on a link whose page was deleted leaves it flagged, not sent to page 1", async ({ page }) => {
    await open(page, (await fixtures()).outlined);
    await pickTool(page, "Link");
    await dragOnPage(page, { x: 80, y: 120 }, { x: 280, y: 165 });
    await page.getByRole("radio", { name: "Page" }).click();
    await page.fill("#link-page", "2");
    await page.locator("#link-page").press("Enter");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Show pages" }).click();
    await page.locator(".pagenav__item").nth(1).click();
    await page.keyboard.press("Delete");
    await expect.poll(() => order(page)).toEqual([0, 2, 3]);
    await page.locator(".linkbox").click();
    await page.getByRole("radio", { name: "Page" }).focus();
    await page.keyboard.press("End");
    await expect(page.locator("#link-page-note")).toContainText("was deleted");
    await expect(page.locator(".linkbox")).toHaveAttribute("data-tip", "Its page was deleted");
  });

  test("a page number typed and then left by clicking the page still takes", async ({ page }) => {
    await open(page, (await fixtures()).outlined);
    await pickTool(page, "Link");
    await dragOnPage(page, { x: 80, y: 120 }, { x: 280, y: 165 });
    await pickTool(page, "Select");
    await page.locator(".linkbox").click();
    await page.getByRole("radio", { name: "Page" }).click();
    await page.fill("#link-page", "4");
    // With Select, a click on bare page deselects the link before focus moves.
    const overlay = page.locator('.page[data-page-pos="0"] .page__overlay');
    const box = (await overlay.boundingBox())!;
    await overlay.click({ position: { x: box.width - 30, y: 300 } });
    await expect(page.locator("#link-page")).toHaveCount(0);
    await expect(page.locator(".linkbox").first()).toHaveAttribute("data-tip", "Page 4");
  });

  test("Ctrl or a field shortcut mid-number takes nothing; Escape still goes back", async ({ page }) => {
    await open(page, (await fixtures()).outlined);
    await pickTool(page, "Link");
    await dragOnPage(page, { x: 80, y: 120 }, { x: 280, y: 165 });
    await page.getByRole("radio", { name: "Page" }).click();
    await page.fill("#link-page", "3");
    await page.locator("#link-page").press("Enter");
    await page.fill("#link-page", "1");
    await page.keyboard.press("Control");
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("Escape");
    await expect(page.locator(".linkbox")).toHaveAttribute("data-tip", "Page 3");
  });

  test("Ctrl+Z mid-number undoes without taking the number, and Redo still works", async ({ page }) => {
    await open(page, (await fixtures()).outlined);
    await pickTool(page, "Link");
    await dragOnPage(page, { x: 80, y: 120 }, { x: 280, y: 165 });
    await page.getByRole("radio", { name: "Page" }).click();
    await page.fill("#link-page", "3");
    await page.locator("#link-page").press("Enter");
    await page.fill("#link-page", "4");
    await page.keyboard.press("ControlOrMeta+z");
    await expect(page.locator(".linkbox")).toHaveAttribute("data-tip", "No URL yet");
    await page.keyboard.press("ControlOrMeta+Shift+z");
    await expect(page.locator(".linkbox")).toHaveAttribute("data-tip", "Page 3");
  });

  test("closing a section by its arrow keeps focus in the tree", async ({ page }) => {
    await open(page, (await fixtures()).outlined);
    await showOutline(page);
    await item(page, "Part one").focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect(item(page, "Section A")).toBeFocused();
    await item(page, "Part one").locator(".outline__twisty").click();
    await expect(item(page, "Part one")).toBeFocused();
  });
});
