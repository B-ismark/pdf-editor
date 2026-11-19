import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { open, watch, expectClean, pickTool, dragOnPage, seedStore, docRecord, restoreSeeded, EMPTY } from "./helpers";
import { fixtures } from "./fixtures";
import { compareText, docText, matchPairs } from "../src/pdf/compare";
import type { PageData } from "../src/pdf/types";

/**
 * Compare two documents: what was added, removed and replaced, word by word,
 * marked on both versions' pages, with an overlay of the pages themselves for
 * what isn't text.
 *
 * The diff reads text the way Find does, then lines up lines before words, so a
 * paragraph that reflowed after one added word is one change, not a block of
 * them. A document with unsaved changes is compared as it would download.
 */

/** A PDF with these lines on each page, 14 pt Helvetica, 24 pt apart. */
async function makePdf(name: string, pages: string[][], box?: { x: number }): Promise<string> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const lines of pages) {
    const p = doc.addPage([612, 792]);
    lines.forEach((l, i) => p.drawText(l, { x: 60, y: 720 - i * 24, size: 14, font }));
    if (box) p.drawRectangle({ x: box.x, y: 300, width: 120, height: 120, color: rgb(0, 0, 0) });
  }
  const dir = test.info().outputDir;
  mkdirSync(dir, { recursive: true });
  const path = `${dir}/${name}`;
  writeFileSync(path, await doc.save());
  return path;
}

const BEFORE = [
  ["The quick brown fox jumps", "over the lazy dog today.", "Nothing else changes here."],
  ["Second page stays the same."],
];
const AFTER = [
  ["The quick red fox jumps", "over the dog today.", "Nothing else changes here.", "A new line was added."],
  ["Second page stays the same."],
];

async function openBoth(page: Page, a: string, b: string) {
  await open(page, a);
  await page.setInputFiles("input[data-open-input]", b);
  await expect(page.locator(".doctab")).toHaveCount(2, { timeout: 30_000 });
  await page.waitForSelector(".page canvas");
}

async function openCompare(page: Page) {
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: /Compare documents/ }).click();
  await expect(page.getByRole("dialog", { name: "Compare" })).toBeVisible();
  await expect(summary(page)).not.toHaveText(/Comparing/, { timeout: 60_000 });
}

const summary = (page: Page) => page.locator(".compare__summary");
const items = (page: Page) => page.locator(".compare__item");

test("lists each change, marks it on both versions, and steps through them", async ({ page }) => {
  const w = watch(page);
  await openBoth(page, await makePdf("before.pdf", BEFORE), await makePdf("after.pdf", AFTER));
  await openCompare(page);

  await expect(summary(page)).toHaveText("3 changes on 1 page");
  await expect(items(page)).toHaveCount(3);
  await expect(items(page).nth(0)).toContainText("Replaced · page 1");
  await expect(items(page).nth(0).locator("del")).toHaveText("brown");
  await expect(items(page).nth(0).locator("ins")).toHaveText("red");
  await expect(items(page).nth(1)).toContainText("Removed · page 1");
  await expect(items(page).nth(1).locator("del")).toHaveText("lazy");
  await expect(items(page).nth(2)).toContainText("Added · page 1");
  await expect(items(page).nth(2).locator("ins")).toHaveText("A new line was added.");

  // Removed words are marked on Before's page, added ones on After's; the page
  // that didn't change has none.
  const before = page.locator('.compare__page[data-side="before"]').first();
  const after = page.locator('.compare__page[data-side="after"]').first();
  await expect(before.locator(".compare__mark--removed")).toHaveCount(2);
  await expect(before.locator(".compare__mark--added")).toHaveCount(0);
  await expect(after.locator(".compare__mark--added")).toHaveCount(6);
  await expect(page.locator('.compare__row[data-row="1"] .compare__mark--removed, .compare__row[data-row="1"] .compare__mark--added')).toHaveCount(0);

  // The mark sits over the word: "brown" is the third word of the first line.
  const mark = (await before.locator('.compare__mark--removed[data-change="0"]').boundingBox())!;
  const pageBox = (await before.boundingBox())!;
  const top = (792 - 720 - 14) / 792; // the line's cap height, from the top
  expect(Math.abs((mark.y - pageBox.y) / pageBox.height - top)).toBeLessThan(0.02);
  expect((mark.x - pageBox.x) / pageBox.width).toBeGreaterThan(60 / 612);

  // Next change walks the list.
  await page.getByRole("button", { name: "Next change" }).click();
  await expect(page.locator(".compare__count")).toHaveText("1 of 3");
  await expect(items(page).nth(0)).toHaveAttribute("aria-current", "true");
  await page.getByRole("button", { name: "Next change" }).click();
  await page.getByRole("button", { name: "Next change" }).click();
  await expect(page.locator(".compare__count")).toHaveText("3 of 3");
  await page.getByRole("button", { name: "Previous change" }).click();
  await expect(page.locator(".compare__count")).toHaveText("2 of 3");

  // Swap: what was added is now what was removed.
  await page.getByRole("button", { name: "Swap before and after" }).click();
  await expect(summary(page)).toHaveText("3 changes on 1 page");
  await expect(items(page).nth(2)).toContainText("Removed · page 1");
  await expect(items(page).nth(2).locator("del")).toHaveText("A new line was added.");
  await expect(page.locator('.compare__page[data-side="before"]').first().locator(".compare__mark--removed")).toHaveCount(6);

  await page.getByRole("dialog", { name: "Compare" }).getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Compare" })).toBeHidden();
  expectClean(w);
});

test("Overlay shows what moved on the page, even with the same text", async ({ page }) => {
  const lines = [["Exactly the same words."]];
  await openBoth(page, await makePdf("a.pdf", lines, { x: 100 }), await makePdf("b.pdf", lines, { x: 400 }));
  await openCompare(page);
  await expect(summary(page)).toHaveText(/The text is the same/);
  await expect(items(page)).toHaveCount(0);

  await page.getByRole("radio", { name: "Overlay" }).click();
  const canvas = page.locator(".compare__row canvas").first();
  await expect(canvas).toBeVisible();
  // The square that's only in a.pdf is drawn in the removed colour, the one
  // only in b.pdf in the added colour.
  // Light theme: removed #b3261e (red), added #146c2e (green). Polled: the
  // overlay composes once both pages have drawn.
  await expect
    .poll(
      () =>
        canvas.evaluate((c: HTMLCanvasElement) => {
          const ctx = c.getContext("2d")!;
          const at = (fx: number, fy: number) => ctx.getImageData(Math.round(c.width * fx), Math.round(c.height * fy), 1, 1).data;
          // Square centres: x 160 / 460 of 612, y 360 of 792 from the bottom.
          const a = at(160 / 612, 1 - 360 / 792);
          const b = at(460 / 612, 1 - 360 / 792);
          return { aRed: a[0] > a[1] + 60, bGreen: b[1] > b[0] + 40 };
        }),
      { timeout: 20_000 },
    )
    .toEqual({ aRed: true, bGreen: true });
});

test("a document's unsaved edits are part of what's compared", async ({ page }) => {
  const lines = [["Exactly the same words."]];
  await openBoth(page, await makePdf("a.pdf", lines), await makePdf("b.pdf", lines));
  // Add a text box to the one in front (After).
  const ov = (await page.locator(".page__overlay").first().boundingBox())!;
  await page.locator('.tooldock__btn[aria-label="Add text"]').click();
  await page.mouse.click(ov.x + 150, ov.y + 300);
  await page.keyboard.type("Freshly typed", { delay: 15 });
  await page.locator('.tooldock__btn[aria-label="Select"]').click();

  await openCompare(page);
  await expect(page.locator(".compare__edited")).toHaveCount(1);
  await expect(summary(page)).toHaveText("1 change on 1 page");
  await expect(items(page).nth(0)).toContainText("Added · page 1");
  await expect(items(page).nth(0).locator("ins")).toHaveText("Freshly typed");
});

test("a small redaction removes only the words under it", async ({ page }) => {
  const words = "Keep this secret word here";
  const path = await makePdf("r.pdf", [[words]]);
  await openBoth(page, path, path);
  // A redaction over "secret" alone, on the copy in front.
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const x0 = 60 + font.widthOfTextAtSize("Keep this ", 14);
  const x1 = x0 + font.widthOfTextAtSize("secret", 14);
  const box = (await page.locator(".page").first().boundingBox())!;
  const k = box.width / 612;
  await pickTool(page, "Redact");
  await dragOnPage(page, { x: (x0 + 1) * k, y: (792 - 720 - 12) * k }, { x: (x1 - 1) * k, y: (792 - 720 + 3) * k });
  await pickTool(page, "Select");

  await openCompare(page);
  // The exporter turns a redacted page into a picture; the comparison still
  // reads the rest of its words.
  await expect(summary(page)).toHaveText("1 change on 1 page");
  await expect(items(page).nth(0)).toContainText("Removed · page 1");
  await expect(items(page).nth(0).locator("del")).toHaveText("secret");
});

for (const [what, crop] of [
  ["a cropped page", { x: 40, y: 600, width: 500, height: 150 }],
  // Stored state can hold a crop past the page's edge; the exporter fits it
  // (here to x 0), and the text must be read through the same fitted crop.
  ["a crop stored past the page's edge", { x: -50, y: 600, width: 600, height: 150 }],
] as const) {
test(`on ${what}, a redaction still hides just its own words`, async ({ page }) => {
  const path = await makePdf("c.pdf", [["Keep this secret word here", "And a second line"]]);
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const x0 = 60 + font.widthOfTextAtSize("Keep this ", 14);
  const x1 = x0 + font.widthOfTextAtSize("secret", 14);
  await page.goto("/");
  // The crop moves the exported page's corner to (40, 600); the redaction is
  // stored in the uncropped page's space.
  const edited = {
    ...EMPTY,
    pages: [{ index: 0, rotate: 0, crop }],
    redactions: [{ id: "r1", pageIndex: 0, x: x0 + 1, y: 716, width: x1 - x0 - 2, height: 14, color: "#000000" }],
  };
  await seedStore(
    page,
    [
      ["doc:a", docRecord("a", "plain.pdf", 0)],
      ["doc:b", docRecord("b", "cropped.pdf", 1, { doc: edited })],
    ],
    [
      ["bytes:a", path],
      ["bytes:b", path],
    ],
  );
  await restoreSeeded(page);
  await expect(page.locator(".doctab")).toHaveCount(2, { timeout: 30_000 });
  await page.locator(".doctab", { hasText: "cropped.pdf" }).click();
  await page.waitForSelector(".page canvas");
  await openCompare(page);
  await expect(page.locator(".compare__edited")).toHaveCount(1);
  await expect(summary(page)).toHaveText("1 change on 1 page");
  await expect(items(page).nth(0).locator("del")).toHaveText("secret");
});
}

test("the word marks and Overlay stay legible in dark theme", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await openBoth(page, await makePdf("a.pdf", [["One removed word."]], { x: 100 }), await makePdf("b.pdf", [["One word."]], { x: 400 }));
  await openCompare(page);
  const mark = page.locator(".compare__mark--removed").first();
  const light = await mark.evaluate((n) => getComputedStyle(n).backgroundColor);
  await page.emulateMedia({ colorScheme: "dark" });
  // The page is white in both themes, so what's drawn on it keeps its colours.
  await expect.poll(() => mark.evaluate((n) => getComputedStyle(n).backgroundColor)).toBe(light);
  // So does the ring round the current change.
  await page.emulateMedia({ colorScheme: "light" });
  await page.getByRole("button", { name: "Next change" }).click();
  const on = page.locator(".compare__mark--on").first();
  const ring = await on.evaluate((n) => getComputedStyle(n).outlineColor);
  await page.emulateMedia({ colorScheme: "dark" });
  await expect.poll(() => on.evaluate((n) => getComputedStyle(n).outlineColor)).toBe(ring);

  await page.getByRole("radio", { name: "Overlay" }).click();
  const canvas = page.locator(".compare__row canvas").first();
  await expect
    .poll(
      () =>
        canvas.evaluate((c: HTMLCanvasElement) => {
          const ctx = c.getContext("2d")!;
          const at = (fx: number, fy: number) => ctx.getImageData(Math.round(c.width * fx), Math.round(c.height * fy), 1, 1).data;
          const lum = (d: Uint8ClampedArray) => (d[0] * 299 + d[1] * 587 + d[2] * 114) / 1000;
          const a = at(160 / 612, 1 - 360 / 792);
          const b = at(460 / 612, 1 - 360 / 792);
          // At least 3:1 against white is a luminance well under ~150.
          return { aRed: a[0] > a[1] + 60 && lum(a) < 120, bGreen: b[1] > b[0] + 40 && lum(b) < 120 };
        }),
      { timeout: 20_000 },
    )
    .toEqual({ aRed: true, bGreen: true });
});

test("closing Compare leaves a background tab's own fonts alone", async ({ page }) => {
  const f = await fixtures();
  await openBoth(page, f.ligatures, f.sample);
  await openCompare(page);
  await page.getByRole("dialog", { name: "Compare" }).getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Compare" })).toBeHidden();

  // Back to the first tab: a selected run still draws in the document's face.
  await page.locator(".doctab").first().click();
  await page.waitForSelector(".page canvas");
  const run = page.locator(".fragment").first();
  const id = await run.getAttribute("data-id");
  const el = page.locator(`.fragment[data-id="${id}"]`);
  await el.click();
  await expect.poll(() => el.evaluate((n) => getComputedStyle(n).fontFamily)).toMatch(/^"?g_/);
  const family = await el.evaluate((n) => getComputedStyle(n).fontFamily);
  const loaded = await page.evaluate(async (family) => {
    const name = family.split(",")[0].trim().replace(/^"|"$/g, "");
    await document.fonts.load(`20px ${family}`);
    return [...document.fonts].some((ff) => ff.family.replace(/^"|"$/g, "") === name && ff.status === "loaded");
  }, family);
  expect(loaded, `${family} is no longer loaded`).toBe(true);
});

test("Compare waits for a second document", async ({ page }) => {
  await open(page, (await fixtures()).sample);
  await page.getByRole("button", { name: "More actions" }).click();
  await expect(page.getByRole("menuitem", { name: /Compare documents/ })).toBeDisabled();
});

/** Pages with one run per line, as the loader would read them. */
function pages(...texts: string[][]): PageData[] {
  return texts.map((lines, pageIndex) => ({
    pageIndex,
    viewBox: { width: 612, height: 792 },
    rotation: 0,
    fields: [],
    fragments: lines.map((t, i) => ({
      id: `${pageIndex}:${i}`,
      pageIndex,
      itemIndex: i,
      original: t,
      transform: [12, 0, 0, 12, 60, 720 - i * 20],
      width: t.length * 6,
      height: 12,
      fontFamily: "sans-serif",
    })),
  })) as unknown as PageData[];
}

test("a reflowed paragraph is one change, not every line after it", async () => {
  const before = docText(pages(["one two three four", "five six seven eight", "nine ten eleven twelve", "Unchanged last line"]));
  const after = docText(pages(["one two NEW three", "four five six seven", "eight nine ten eleven", "twelve", "Unchanged last line"]));
  const { changes, rough } = await compareText(before, after);
  expect(rough).toBe(false);
  expect(changes.map((c) => [c.kind, c.removed.map((w) => w.text), c.added.map((w) => w.text)])).toEqual([["added", [], ["NEW"]]]);
});

test("typographic quotes and soft hyphens don't count as changes", async () => {
  const before = docText(pages(["It’s “quoted” co­operate"]));
  const after = docText(pages(["It's \"quoted\" cooperate"]));
  expect((await compareText(before, after)).changes).toEqual([]);
});

test("the word matcher finds a longest common subsequence", () => {
  // Checked against plain dynamic programming on random small inputs.
  let seed = 7;
  const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
  for (let t = 0; t < 400; t++) {
    const a = Array.from({ length: rnd(12) }, () => "abcd"[rnd(4)]);
    const b = Array.from({ length: rnd(12) }, () => "abcd"[rnd(4)]);
    const pairs = matchPairs(a, b, 1000)!;
    for (let i = 1; i < pairs.length; i++) {
      expect(pairs[i][0]).toBeGreaterThan(pairs[i - 1][0]);
      expect(pairs[i][1]).toBeGreaterThan(pairs[i - 1][1]);
    }
    for (const [i, j] of pairs) expect(a[i]).toBe(b[j]);
    const L = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
    for (let i = a.length - 1; i >= 0; i--)
      for (let j = b.length - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    expect(pairs.length).toBe(L[0][0]);
  }
  // Past the cap it gives up rather than grinding.
  expect(matchPairs(["a", "b", "c"], ["x", "y", "z"], 2)).toBeNull();
});
