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
async function slowText(page: Page, pageIndex: number, holdMs = HOLD_MS) {
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
              const at = Date.now() + ${holdMs};
              held.set(d.streamId, at);
              setTimeout(() => fn(e), ${holdMs});
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

  test("the page indicator doesn't jump back to page one as text arrives", async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 700 });
    await slowText(page, 2);
    await page.goto("/");
    await page.setInputFiles("input[type=file]", await threePages());
    await painted(page);
    const chip = page.locator(".zoombar__page");
    await page.locator('.page[data-page-pos="1"]').scrollIntoViewIfNeeded();
    await page.evaluate(() => document.querySelector('.page[data-page-pos="1"]')!.scrollIntoView({ block: "start" }));
    await expect(chip).toHaveText("2 / 3");
    // Every reading the chip shows from here until the last page's text lands.
    await page.evaluate(() => {
      const seen: string[] = [];
      (window as unknown as { seen: string[] }).seen = seen;
      new MutationObserver(() => seen.push(document.querySelector(".zoombar__page")?.textContent ?? "")).observe(
        document.querySelector(".zoombar")!,
        { subtree: true, characterData: true, childList: true },
      );
    });
    await page.keyboard.press("Escape");
    await expect(page.locator(".docpanel")).toContainText("Searchable on every page", { timeout: HOLD_MS + 10_000 });
    await page.waitForTimeout(500);
    const seen = await page.evaluate(() => (window as unknown as { seen: string[] }).seen);
    expect(seen.filter((t) => t.startsWith("1 /"))).toEqual([]);
    await expect(chip).toHaveText("2 / 3");
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

    test("an edit made while the download waits isn't marked saved, and a second press makes no second file", async ({ page }) => {
      const path = await threePages();
      await slowText(page, 2);
      await page.goto("/");
      const edits = { "2:0": { text: "Third page rewritten Kilimanjaro.", style: {} } };
      await seedStore(page, [["doc:a", docRecord("a", "three.pdf", 0, { doc: { ...EMPTY, edits } })]], [["bytes:a", path]]);
      await restoreSeeded(page);
      await painted(page);
      await expect(page.locator(".docpanel")).toContainText("Reading text…");
      let downloads = 0;
      page.on("download", () => downloads++);
      const first = page.waitForEvent("download", { timeout: 3 * HOLD_MS + 10_000 });
      await page.click(".appbar__download");
      // Pressed again while the first is still waiting on page three's text.
      await page.click(".appbar__download");
      // And an edit on page one, made during the wait: the file is the
      // document as it was when Download was pressed, so this isn't in it.
      const frag = page.locator(".fragment", { hasText: "First page needle" }).first();
      await frag.click();
      await page.keyboard.press("End");
      await page.keyboard.type(" Serengeti", { delay: 20 });
      await page.waitForTimeout(300);
      const download = await first;
      const [one] = await pageTexts(readFileSync((await download.path())!), [1]);
      expect(one).not.toContain("Serengeti");
      // So the counter still owes that edit.
      await expect(page.locator(".appbar__changes")).toHaveText("2 changes");
      await page.waitForTimeout(3_000);
      expect(downloads).toBe(1);
    });

    test("Download all is busy from the press, while it waits for text", async ({ page }) => {
      const path = await threePages();
      // Two documents take a while to restore: a longer hold, so it's still
      // running when Download all is pressed.
      test.setTimeout(120_000);
      const hold = 25_000;
      await slowText(page, 2, hold);
      await page.goto("/");
      await seedStore(
        page,
        [
          ["doc:a", docRecord("a", "three.pdf", 0)],
          ["doc:b", docRecord("b", "three-again.pdf", 1)],
        ],
        [
          ["bytes:a", path],
          ["bytes:b", path],
        ],
      );
      await restoreSeeded(page);
      await painted(page);
      await expect(page.locator(".docpanel")).toContainText("Reading text…");
      let downloads = 0;
      page.on("download", () => downloads++);
      const zip = page.waitForEvent("download", { timeout: 2 * hold + 10_000 });
      await page.locator('[aria-label="Export options"]').click();
      await page.locator(".menu__item", { hasText: "Download all (2) as ZIP" }).click();
      // Still waiting on page three's text, and already busy: Export won't
      // open again, so there's no second press to make.
      const caret = page.locator('[aria-label="Export options"]');
      await expect(caret).toHaveAttribute("aria-disabled", "true");
      // (Forced: Playwright would otherwise wait for it to stop being busy.)
      await caret.click({ force: true });
      await expect(page.locator(".menu__item", { hasText: "Download all (2) as ZIP" })).toHaveCount(0);
      await zip;
      await page.waitForTimeout(2_000);
      expect(downloads).toBe(1);
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
