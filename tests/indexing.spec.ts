import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { watch, expectClean, seedStore, docRecord, restoreSeeded, EMPTY, pageTexts } from "./helpers";

/**
 * A document's text is read in the background: a file opens with its page
 * layout only, so the first page paints without waiting for every page's text,
 * and the text fills in page by page behind it.
 *
 * Anything that reads the *whole* document — export, the whiteout warning,
 * Export text, the change count — must not mistake a page not read yet for a
 * page with no text. These tests hold one page's text back inside pdf.js's
 * worker (`slowText`), so "not read yet" lasts long enough to act in, instead of
 * hoping to catch a few milliseconds.
 */

/** How long the held-back page's text takes. */
const HOLD_MS = 8_000;

/**
 * Serve pdf.js's worker with one page's text held back: its `GetTextContent`
 * request (and whatever follows on the same stream) is handed to the worker
 * `HOLD_MS` late. Everything else — layout, rendering, other pages' text — is
 * untouched.
 */
async function slowText(page: Page, pageIndex: number) {
  await page.route(/\/assets\/pdf\.worker\.min-[\w-]{8}\.mjs$/, async (route) => {
    const res = await route.fetch();
    const prefix = `
      {
        const add = self.addEventListener.bind(self);
        const held = new Map();
        self.addEventListener = (type, fn, opts) => {
          if (type !== "message") return add(type, fn, opts);
          return add(type, (e) => {
            const d = e.data;
            const until = d && d.streamId != null ? held.get(d.streamId) : undefined;
            if (d && d.action === "GetTextContent" && d.data && d.data.pageIndex === ${pageIndex}) {
              const at = Date.now() + ${HOLD_MS};
              held.set(d.streamId, at);
              setTimeout(() => fn(e), ${HOLD_MS});
            } else if (until !== undefined) {
              setTimeout(() => fn(e), Math.max(0, until - Date.now()));
            } else fn(e);
          }, opts);
        };
      }
    `;
    await route.fulfill({ response: res, body: prefix + (await res.text()) });
  });
}

/** Three pages of Helvetica, one line each. */
async function threePages(): Promise<string> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const line of ["First page needle here.", "Second page plain.", "Third page needle Zanzibar."]) {
    doc.addPage([612, 792]).drawText(line, { x: 60, y: 700, size: 18, font });
  }
  const dir = test.info().outputDir;
  mkdirSync(dir, { recursive: true });
  const path = `${dir}/three.pdf`;
  writeFileSync(path, await doc.save());
  return path;
}

const painted = (page: Page) =>
  page.waitForFunction(() => [...document.querySelectorAll(".page canvas")].some((c) => (c as HTMLCanvasElement).width > 1), null, {
    timeout: 4_000,
  });

test.describe("background text", () => {
  test("the first page paints before every page's text is read", async ({ page }) => {
    const w = watch(page);
    await slowText(page, 2);
    await page.goto("/");
    const t0 = Date.now();
    await page.setInputFiles("input[type=file]", await threePages());
    // Well inside the held page's delay: opening didn't wait for it.
    await painted(page);
    expect(Date.now() - t0).toBeLessThan(HOLD_MS / 2);
    // Page one's text is there to edit already.
    await expect(page.locator(".fragment").first()).toBeAttached();
    // The Inspector says the text is still coming, not that there isn't any.
    // (All three pages are in view, so the held one was asked for first, and
    // page two waits behind it.)
    await page.keyboard.press("Escape");
    await expect(page.locator(".docpanel")).toContainText(/Reading text… [12] of 3 pages/);
    await expect(page.locator(".docpanel")).not.toContainText("No text layer");
    await expect(page.locator(".snackbar__msg")).toHaveText("3 pages");
    // Then it all arrives.
    await expect(page.locator(".docpanel")).toContainText("Searchable on every page", { timeout: HOLD_MS + 10_000 });
    expectClean(w);
  });

  test("Find keeps up as text arrives, and Redact all waits for every page", async ({ page }) => {
    await slowText(page, 2);
    await page.goto("/");
    await page.setInputFiles("input[type=file]", await threePages());
    await painted(page);
    await page.keyboard.press("Control+f");
    await page.getByRole("textbox", { name: "Find in document" }).fill("needle");
    // Page one's match, and a sign that more may come.
    await expect(page.locator(".findbar__count")).toHaveText("1/1…");
    const redactAll = page.locator(".findbar__redact");
    await expect(redactAll).toBeDisabled();
    await expect(page.locator(".findbar__count")).toHaveText("1/2", { timeout: HOLD_MS + 10_000 });
    await expect(redactAll).toBeEnabled();
  });

  test("Export text includes pages not read yet", async ({ page }) => {
    await slowText(page, 2);
    await page.goto("/");
    await page.setInputFiles("input[type=file]", await threePages());
    await painted(page);
    await expect(page.locator(".docpanel")).toContainText("Reading text…");
    await page.locator('[aria-label="Export options"]').click();
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: HOLD_MS + 10_000 }),
      page.locator(".menu__item", { hasText: "Export text (.txt)" }).click(),
    ]);
    const text = readFileSync((await download.path())!, "utf8");
    expect(text).toContain("Zanzibar");
  });

  test.describe("a restored session", () => {
    test("an edit on a page not read yet still counts, and still downloads", async ({ page }) => {
      const path = await threePages();
      await slowText(page, 2);
      await page.goto("/");
      // Page three's only line, rewritten.
      const edits = { "2:0": { text: "Third page rewritten Kilimanjaro.", style: {} } };
      await seedStore(page, [["doc:a", docRecord("a", "three.pdf", 0, { doc: { ...EMPTY, edits } })]], [["bytes:a", path]]);
      await restoreSeeded(page);
      await painted(page);
      await expect(page.locator(".docpanel")).toContainText("Reading text…");
      // Not "unchanged" just because the edited page hasn't been read.
      await expect(page.locator(".appbar__changes")).toHaveText("1 change");
      // Two waits on the held page: its text, then its fonts for the redraw.
      const [download] = await Promise.all([
        page.waitForEvent("download", { timeout: 3 * HOLD_MS + 10_000 }),
        page.click(".appbar__download"),
      ]);
      const [third] = await pageTexts(readFileSync((await download.path())!), [3]);
      // The replacement is drawn (over the original, as every vector edit is).
      expect(third).toContain("Kilimanjaro");
    });

    test("whiteout over a page not read yet still warns before download", async ({ page }) => {
      const path = await threePages();
      await slowText(page, 2);
      await page.goto("/");
      const cover = { id: "r-1", pageIndex: 2, x: 0, y: 0, width: 2000, height: 2000, color: "#ffffff", cover: true };
      await seedStore(page, [["doc:a", docRecord("a", "three.pdf", 0, { doc: { ...EMPTY, redactions: [cover] } })]], [["bytes:a", path]]);
      await restoreSeeded(page);
      await painted(page);
      await expect(page.locator(".docpanel")).toContainText("Reading text…");
      let downloaded = false;
      page.on("download", () => (downloaded = true));
      await page.click(".appbar__download");
      await expect(page.getByRole("alertdialog")).toContainText("page 3", { timeout: HOLD_MS + 10_000 });
      expect(downloaded).toBe(false);
    });
  });
});
