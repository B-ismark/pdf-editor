import { test, expect, type Page } from "@playwright/test";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRef, PDFString } from "pdf-lib";
import { readFileSync } from "node:fs";
import { fixtures, OUTLINED } from "./fixtures";
import { open, watch, pickTool, dragOnPage, expectClean, pageTexts } from "./helpers";

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
    await page.fill("#link-page", "3");
    await expect(page.locator("#link-page-note")).toContainText("opens page 3");
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
    await page.fill("#link-page", "2");
    await page.getByRole("radio", { name: "Web address" }).click();
    await expect(page.locator("#link-url")).toHaveValue("https://example.com/a");
    const doc = await PDFDocument.load(await download(page));
    expect(linksOn(doc, 0)).toEqual([{ to: undefined, uri: "https://example.com/a" }]);
  });

  test("to a deleted page is flagged and left out of the file", async ({ page }) => {
    await open(page, (await fixtures()).outlined);
    await linkOnFirstPage(page);
    await page.fill("#link-page", "2");
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
    await page.fill("#link-page", "2");
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
