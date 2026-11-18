import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fixtures } from "./fixtures";
import { open, watch, pageTexts, expectClean, seedStore, docRecord, restoreSeeded, EMPTY } from "./helpers";
import { batesNumber, labelsFor } from "../src/pdf/headerFooter";
import type { DocState, PageNumberOptions } from "../src/pdf/types";

/**
 * Header & footer: text in six places on every page, with tokens filled in per
 * page — page number, page count, date, file name, Bates number.
 *
 * It grew out of page numbers and is stored in the same place, so a session
 * from before reads as its one page number. One resolver fills the tokens for
 * the on-page preview and for the exporter, and the date and file name are
 * fixed when it's applied, so the page, the file and a later export agree.
 */

async function download(page: Page): Promise<Buffer> {
  const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 120_000 }), page.click(".appbar__download")]);
  return readFileSync((await dl.path())!);
}

async function restoreWith(page: Page, file: string, doc: Partial<DocState>, name = "doc.pdf") {
  await page.goto("/");
  await seedStore(page, [["doc:p", docRecord("p", name, 0, { doc: { ...EMPTY, ...doc } })]], [["bytes:p", file]]);
  await restoreSeeded(page);
}

/** Every text run on a page with where it starts, in PDF units. */
async function runs(bytes: Buffer, n: number) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), useWorkerFetch: false, isEvalSupported: false }).promise;
  const pg = await doc.getPage(n);
  const [, , w, h] = pg.view;
  const items = (await pg.getTextContent()).items.flatMap((i) => ("str" in i ? [{ str: i.str, x: i.transform[4], y: i.transform[5], width: i.width }] : []));
  return { w, h, items };
}

test.describe("the resolver", () => {
  const base: PageNumberOptions = { position: "bottom-center", start: 1, size: 11, color: "#000000" };

  test("a setting from before header & footer is its page number", () => {
    expect(labelsFor({ ...base, position: "top-right", start: 5 }, 2, 10)).toEqual([{ position: "top-right", text: "7" }]);
  });

  test("tokens fill in per page; anything else in braces is left as typed", () => {
    const o: PageNumberOptions = {
      ...base,
      start: 3,
      date: "2 March 2026",
      file: "brief.pdf",
      slots: { "top-left": "{FILE} · {date}", "bottom-center": "Page {page} of {pages}", "bottom-right": "{bates} {name}", "top-right": "   " },
      bates: { prefix: "ACME-", start: 40, digits: 5 },
    };
    // Reading order, top row first; a place with only spaces is no place.
    expect(labelsFor(o, 1, 7)).toEqual([
      { position: "top-left", text: "brief.pdf · 2 March 2026" },
      { position: "bottom-center", text: "Page 4 of 9" },
      { position: "bottom-right", text: "ACME-00041 {name}" },
    ]);
  });

  test("Bates numbers pad to their digits and keep counting past them", () => {
    expect(batesNumber({ prefix: "X", start: 1, digits: 3 }, 0)).toBe("X001");
    expect(batesNumber({ prefix: "X", start: 998, digits: 3 }, 5)).toBe("X1003");
    // Nonsense in a stored setting reads as something sensible, not "NaN".
    expect(batesNumber({ prefix: "", start: Number.NaN, digits: 99 }, 0)).toBe("000000000000");
  });
});

test("header & footer: places, tokens and Bates numbers, previewed and exported", async ({ page }) => {
  const w = watch(page);
  const f = await fixtures();
  await open(page, f.sample);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Add header & footer" }).click();
  const dialog = page.getByRole("dialog");
  // A new one starts as it always did: a page number, bottom centre.
  await expect(dialog.getByLabel("Footer, centre")).toHaveValue("{page}");
  await expect(dialog.locator(".hf__bates")).toHaveCount(0);

  await dialog.getByLabel("Footer, centre").fill("");
  await expect(dialog.getByRole("button", { name: "Apply" })).toBeDisabled();
  await dialog.getByLabel("Header, centre").fill("Page {page} of {pages}");
  // A chip types into the place last focused, at its caret.
  await dialog.getByLabel("Footer, right").click();
  await dialog.getByRole("button", { name: "Bates number" }).click();
  await expect(dialog.getByLabel("Footer, right")).toHaveValue("{bates}");
  await expect(dialog.getByLabel("Footer, right")).toBeFocused();

  // The Bates block shows once a place uses it, with the range it will run.
  await dialog.getByLabel("Bates prefix").fill("ACME-");
  await dialog.getByLabel("Bates start").fill("7");
  await dialog.getByLabel("Bates digits").fill("4");
  await expect(dialog.locator(".hf__range")).toHaveText("ACME-0007 – ACME-0018");
  await expect(dialog.locator(".hf__preview")).toContainText("Page 1 of 12");
  await expect(dialog.locator(".hf__preview")).toContainText("ACME-0007");
  await dialog.getByRole("button", { name: "Apply" }).click();
  await expect(dialog).toHaveCount(0);

  // On the page, from the same resolver the file uses.
  const first = page.locator(".page").first().locator(".finishlayer__num");
  await expect(first).toHaveText(["Page 1 of 12", "ACME-0007"]);
  await expect(first.first()).toHaveAttribute("data-place", "top-center");
  const layer = page.locator(".docpanel__layer", { hasText: "Header & footer" });
  await expect(layer).toContainText("Top centre, Bottom right · Bates ACME-0007");

  const bytes = await download(page);
  const [p1, p12] = await pageTexts(bytes, [1, 12]);
  expect(p1).toContain("Page 1 of 12");
  expect(p1).toContain("ACME-0007");
  expect(p12).toContain("Page 12 of 12");
  expect(p12).toContain("ACME-0018");
  // The cleared place is gone, not left as a bare number.
  const { w: width, items } = await runs(bytes, 12);
  expect(items.filter((i) => i.str.trim() === "12")).toEqual([]);
  // Right-aligned to the same margin as the preview.
  const bates = items.find((i) => i.str === "ACME-0018")!;
  expect(Math.abs(bates.x + bates.width - (width - 28))).toBeLessThan(1);

  // One undoable step, like any edit.
  await page.keyboard.press("Control+z");
  await expect(page.locator(".finishlayer__num")).toHaveCount(0);
  await expect(layer).toContainText("Off");
  expectClean(w);
});

test("a chip goes in at the caret, not at the end", async ({ page }) => {
  const f = await fixtures();
  await open(page, f.sample);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Add header & footer" }).click();
  const left = page.getByRole("dialog").getByLabel("Header, left");
  await left.fill("ab");
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowRight");
  await page.getByRole("dialog").getByRole("button", { name: "File name" }).click();
  await page.keyboard.type("x");
  await expect(left).toHaveValue("a{file}xb");
});

test("the date and file name are the ones applied, wherever and whenever it's exported", async ({ page }) => {
  const f = await fixtures();
  const pageNumbers: PageNumberOptions = {
    position: "top-left",
    start: 1,
    size: 11,
    color: "#000000",
    slots: { "top-left": "{file} {date}" },
    date: "1 January 2020",
    file: "brief.pdf",
  };
  await restoreWith(page, f.sample, { pageNumbers }, "renamed.pdf");
  await expect(page.locator(".page").first().locator(".finishlayer__num")).toHaveText("brief.pdf 1 January 2020");
  const bytes = await download(page);
  const { h, items } = await runs(bytes, 1);
  const label = items.find((i) => i.str === "brief.pdf 1 January 2020");
  expect(label, JSON.stringify(items.slice(0, 5))).toBeTruthy();
  expect(Math.abs(label!.x - 28)).toBeLessThan(1);
  expect(Math.abs(label!.y - (h - 28 - 11))).toBeLessThan(1);
});

test("a page-number setting from before opens as its one place", async ({ page }) => {
  const f = await fixtures();
  await restoreWith(page, f.sample, { pageNumbers: { position: "top-right", start: 101, size: 11, color: "#000000" } });
  await page.keyboard.press("Escape");
  const layer = page.locator(".docpanel__layer", { hasText: "Header & footer" });
  await expect(layer).toContainText("Top right · from 101");
  await expect(page.locator(".page").first().locator(".finishlayer__num")).toHaveText("101");
  await page.getByRole("button", { name: "Edit header & footer" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Header, right")).toHaveValue("{page}");
  await expect(dialog.getByLabel("Footer, centre")).toHaveValue("");
  await expect(dialog.getByLabel("Number pages from")).toHaveValue("101");
});
