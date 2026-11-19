import { test, expect, type Page } from "@playwright/test";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { fixtures } from "./fixtures";
import { open, watch, expectClean, pickTool, pickSubTool, dragOnPage, openOrganise } from "./helpers";

/**
 * The app shell — app bar, page rail, Inspector, overflow menu.
 *
 * Each assertion here is a defect that type-checking and the feature specs both
 * passed straight over, because every one of them was a *geometry* or *identity*
 * problem rather than a broken function call: a primary action that still worked at
 * 14px wide, a menu whose last group was painted past the bottom of the window, a
 * panel that swapped its contents without saying so.
 */

/** True when `npm run setup-ocr` has been run, so OCR can actually execute. */
async function ocrReady(page: Page): Promise<boolean> {
  await page.goto("/");
  return page.evaluate(async () => {
    try {
      const res = await fetch("./tessdata/eng.traineddata.gz", { method: "HEAD" });
      return res.ok && !(res.headers.get("content-type") ?? "").includes("text/html");
    } catch {
      return false;
    }
  });
}

/** The first page of each file, in order, as one new PDF on disk. */
async function merge(paths: string[]): Promise<string> {
  const out = await PDFDocument.create();
  for (const p of paths) {
    const src = await PDFDocument.load(readFileSync(p));
    out.addPage((await out.copyPages(src, [0]))[0]);
  }
  const path = join(mkdtempSync(join(tmpdir(), "inspector-")), "merged.pdf");
  writeFileSync(path, await out.save());
  return path;
}

/** Widths and content-widths of the app bar's children. */
function barMetrics(page: Page) {
  return page.evaluate(() => {
    const bar = document.querySelector<HTMLElement>(".appbar")!;
    const dl = document.querySelector<HTMLElement>(".appbar__download")!;
    return {
      width: bar.getBoundingClientRect().width,
      scrollWidth: bar.scrollWidth,
      download: dl.getBoundingClientRect().width,
      downloadHeight: dl.getBoundingClientRect().height,
      /** The right edge of the last visible control. */
      lastRight: Math.max(
        ...[...bar.querySelectorAll<HTMLElement>("button")].map(
          (b) => b.getBoundingClientRect().right,
        ),
      ),
    };
  });
}

test.describe("app bar", () => {
  // 360px is the narrowest mainstream phone; every control has to fit inside it,
  // because the row's only shrinkable member was the primary action and *all* of
  // the overflow came out of it. Reproduced against the previous code: Download
  // measured 14×44 at 390px and 0×44 at 360px, where the row overflowed by 8px
  // anyway — a primary action under WCAG 2.5.8's 24×24 minimum, then absent.
  // `flex: none` alone would only have moved the clipping onto the overflow menu,
  // so the fix was to size the row to its contents (the theme control went into
  // that menu, where the other preferences already live).
  for (const width of [360, 390, 430]) {
    test(`fits its controls at ${width}px, primary action at full size`, async ({ browser }) => {
      const ctx = await browser.newContext({
        viewport: { width, height: 780 },
        isMobile: true,
        hasTouch: true,
      });
      const page = await ctx.newPage();
      await open(page, (await fixtures()).sample);

      const m = await barMetrics(page);
      expect(m.scrollWidth, "the app bar overflows its own width").toBeLessThanOrEqual(m.width);
      expect(m.lastRight, "a control is pushed off the right edge").toBeLessThanOrEqual(m.width);
      // 44px is the floor the rest of this UI is built to (Apple 44pt).
      expect(m.download, "the Download button is crushed").toBeGreaterThanOrEqual(44);
      expect(m.downloadHeight).toBeGreaterThanOrEqual(44);
      await ctx.close();
    });
  }

  // ...and on a desktop the opposite failure: a 44px-tall, 130px-wide filled pill
  // in a 52px bar, beside a bare glyph for the menu that holds every document
  // action there is. The primary action outgrew its slot and the way into
  // everything else was the quietest thing in the row.
  test("the primary action fits the bar, and the menu reads as a control", async ({ page }) => {
    await open(page, (await fixtures()).sample);
    const m = await page.evaluate(() => {
      const bar = document.querySelector<HTMLElement>(".appbar")!;
      const dl = document.querySelector<HTMLElement>(".appbar__download")!;
      const more = document.querySelector<HTMLElement>(".appbar__more")!;
      const cs = getComputedStyle(more);
      return {
        bar: bar.getBoundingClientRect().height,
        download: dl.getBoundingClientRect().height,
        more: more.getBoundingClientRect(),
        moreBg: cs.backgroundColor,
        barBg: getComputedStyle(bar).backgroundColor,
      };
    });
    expect(m.download, "the primary action fills the bar it sits in").toBeLessThanOrEqual(
      m.bar - 10,
    );
    // WCAG 2.5.8 wants 24×24; this UI's own floor is higher than that anyway.
    expect(m.download).toBeGreaterThanOrEqual(32);
    expect(m.more.width, "the menu control is below the touch minimum").toBeGreaterThanOrEqual(44);
    expect(m.moreBg, "the overflow menu has no container to read as a control").not.toBe(
      "rgba(0, 0, 0, 0)",
    );
    expect(m.moreBg, "the menu's container is invisible against the bar").not.toBe(m.barBg);
  });

  test("the page-rail toggle says what it will do", async ({ page }) => {
    await open(page, (await fixtures()).sample);
    // Named by outcome, not "Toggle page thumbnails" — and the name changes with
    // the state, so it never describes the opposite of what will happen. Its
    // tooltip used to read "Pages", the same word as the heading of the rail it
    // opened, which it then covered.
    await expect(page.locator('.icon-btn[aria-label="Show pages"]')).toBeVisible();
    await page.locator('.icon-btn[aria-label="Show pages"]').click();
    await expect(page.locator('.icon-btn[aria-label="Hide pages"]')).toBeVisible();
    await expect(page.locator(".pagenav")).toBeVisible();
  });
});

test.describe("overflow menu", () => {
  test("every item is reachable and none of them wraps", async ({ page }) => {
    // A 900px-tall window is ordinary, and the menu was taller than that with no
    // scroll of its own: the File group (Open another PDF / Close document) was
    // painted past the bottom edge and could not be reached at all.
    await page.setViewportSize({ width: 1280, height: 820 });
    await open(page, (await fixtures()).sample);
    await page.locator('.icon-btn[aria-label="More actions"]').click();

    const list = page.locator(".menu__list");
    await expect(list).toBeVisible();
    const items = page.locator(".menu__item");
    const n = await items.count();
    expect(n).toBeGreaterThan(10);

    const box = (await list.boundingBox())!;
    expect(box.y + box.height, "the menu is drawn past the bottom of the window").toBeLessThanOrEqual(
      820,
    );

    // Scroll to the last item and require it to actually land inside the menu.
    const last = items.nth(n - 1);
    await last.scrollIntoViewIfNeeded();
    await expect(last).toBeInViewport();

    // One line per row: labels that wrap make a list of uneven blocks that can no
    // longer be scanned down the left edge.
    const heights = await items.evaluateAll((els) =>
      els.map((el) => Math.round(el.getBoundingClientRect().height)),
    );
    expect(Math.max(...heights) - Math.min(...heights), `row heights: ${heights.join()}`).toBeLessThanOrEqual(
      2,
    );
  });
});

/** A 64×64 solid PNG. Deliberately not a 1×1 one: a stamp is placed at its
 * natural size, and on a stamp that small the delete badge covers the whole
 * thing — the first draft of this spec clicked the badge and asserted against a
 * stamp it had just deleted. */
const PNG_SQUARE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAT0lEQVR42u3PQQkAAAgEsItz/VMYywi+hcEKLO28FgEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQGBywLt4oEAvGaPlQAAAABJRU5ErkJggg==",
  "base64",
);

test.describe("inspector", () => {
  test("with nothing selected it describes the document; selecting swaps in the selection", async ({ page }) => {
    const w = watch(page);
    await page.setViewportSize({ width: 1280, height: 860 });
    await open(page, (await fixtures()).sample);
    const panel = page.locator("aside.inspector");

    // One job, no tabs to choose between.
    await expect(page.getByRole("tab")).toHaveCount(0);
    await expect(panel).toHaveAccessibleName("Document");
    await expect(panel.locator(".props__title")).toHaveText("Document");
    const fact = (name: string) => panel.locator(".docpanel__fact", { has: page.locator(`dt:text-is("${name}")`) }).locator("dd");
    await expect(fact("File")).toHaveText("sample.pdf");
    await expect(fact("Pages")).toHaveText("12");
    await expect(fact("Page size")).toHaveText("A4 · 210 × 297 mm");
    await expect(fact("Text")).toContainText("Searchable on every page");
    // Commands live where they act, not here.
    await expect(panel.getByRole("button", { name: /Compress|Organise|Copy all text/ })).toHaveCount(0);

    await page.locator(".fragment").first().click();
    await expect(panel).toHaveAccessibleName("Properties");
    await expect(panel.locator(".props__title")).toHaveText("Text");
    await expect(panel.locator(".props__section").first()).toBeVisible();

    // Deselecting is the way back.
    await page.locator(".fragment").first().blur();
    await page.keyboard.press("Escape");
    await expect(panel.locator(".props__title")).toHaveText("Document");
    expectClean(w);
  });

  test("header & footer and watermark are set, shown and removed from here, and undo", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 860 });
    await open(page, (await fixtures()).sample);
    const panel = page.locator("aside.inspector");
    const layer = (name: string) => panel.locator(".docpanel__layer", { hasText: name });
    await expect(layer("Header & footer")).toContainText("Off");

    await panel.getByRole("button", { name: "Add header & footer" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.locator(".btn--filled").click();
    await expect(dialog).toHaveCount(0);
    await expect(layer("Header & footer")).toContainText("Bottom centre · from 1");
    await expect(panel.getByRole("button", { name: "Edit header & footer" })).toBeVisible();

    await panel.getByRole("button", { name: "Remove header & footer" }).click();
    await expect(layer("Header & footer")).toContainText("Off");
    // The button that had focus is gone; focus lands on the one replacing it,
    // not on the page body.
    await expect(panel.getByRole("button", { name: "Add header & footer" })).toBeFocused();
    await page.keyboard.press("Control+z");
    await expect(layer("Header & footer")).toContainText("Bottom centre");

    // The watermark opens the same dialog on its own tab.
    await panel.getByRole("button", { name: "Add watermark" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(layer("Watermark")).toContainText("Off");
  });

  test("a scanned document offers to recognise its text", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 860 });
    await open(page, (await fixtures()).scanned);
    const panel = page.locator("aside.inspector");
    await expect(panel.locator(".docpanel__fact", { hasText: "Text" })).toContainText("No text layer");
    // Never "scanned": a blank or vector-only page has no text either.
    await expect(panel.locator(".docpanel__fact", { hasText: "Text" })).not.toContainText(/scan/i);
    await expect(panel.getByRole("button", { name: "Recognise text (OCR)" })).toBeVisible();
  });

  test("lossless is an app setting: one switch, in the ⋯ menu on every screen and mirrored in the Inspector", async ({ browser }) => {
    const desk = await browser.newPage({ viewport: { width: 1280, height: 860 } });
    await open(desk, (await fixtures()).sample);
    const box = desk.getByRole("checkbox", { name: /Lossless redacted pages/ });
    await expect(box).not.toBeChecked();
    // Says what it is: a device-wide setting, not this file's.
    await expect(box).toHaveAccessibleDescription(/every document you export on this device/);
    await expect(desk.locator("#docpanel-device")).toContainText("this device");
    await box.check();
    // Reachable on a desktop from the ⋯ menu too (the Inspector can be hidden),
    // and it is the same switch.
    await desk.getByRole("button", { name: "More actions" }).click();
    const item = desk.getByRole("menuitemcheckbox", { name: /Lossless/ });
    await expect(item).toHaveAttribute("aria-checked", "true");
    await item.click();
    await expect(box).not.toBeChecked();
    // And from the command palette.
    await desk.keyboard.press("Control+k");
    await desk.keyboard.type("lossless");
    const option = desk.getByRole("option", { name: /Lossless redacted pages/ });
    await expect(option).not.toHaveAttribute("aria-checked", "true");
    await option.click();
    await expect(box).toBeChecked();
    await desk.close();

    const ctx = await browser.newContext({ viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true });
    const phone = await ctx.newPage();
    await open(phone, (await fixtures()).sample);
    await phone.getByRole("button", { name: "More actions" }).click();
    await expect(phone.getByRole("menuitemcheckbox", { name: /Lossless/ })).toHaveCount(1);
    await ctx.close();
  });

  test("pages that differ only in orientation are one size, and a one-page file reads in the singular", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 860 });
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    doc.addPage([595.28, 841.89]).drawText("Portrait page", { x: 72, y: 700, size: 14, font });
    doc.addPage([841.89, 595.28]).drawText("Landscape page", { x: 72, y: 500, size: 14, font });
    const dir = mkdtempSync(join(tmpdir(), "inspector-"));
    const turned = join(dir, "turned.pdf");
    writeFileSync(turned, await doc.save());
    await open(page, turned);
    const panel = page.locator("aside.inspector");
    const fact = (name: string) => panel.locator(".docpanel__fact", { has: page.locator(`dt:text-is("${name}")`) }).locator("dd");
    await expect(fact("Page size")).toHaveText("A4, portrait and landscape · 210 × 297 mm");

    // Pages a point or two apart are one size, and all-portrait says nothing
    // about landscape — named paper or not.
    const near = async (sizes: [number, number][]) => {
      const d = await PDFDocument.create();
      for (const sz of sizes) d.addPage(sz);
      const path = join(dir, `near-${sizes.map((x) => x.join("x")).join("-")}.pdf`);
      writeFileSync(path, await d.save());
      await page.setInputFiles('input[data-open-input]', path);
      await expect(fact("Pages")).toHaveText(String(sizes.length));
    };
    await near([[595, 842], [597.6, 842]]);
    await expect(fact("Page size")).toHaveText("A4 · 210 × 297 mm");
    await near([[568.06, 800], [568.63, 800], [569, 801]]);
    await expect(fact("Page size")).toHaveText("200 × 282 mm");

    await page.setInputFiles('input[data-open-input]', (await fixtures()).typeset);
    await expect(fact("Pages")).toHaveText("1");
    await expect(fact("Text")).toHaveText("Searchable");
  });

  test("the Document heading is a heading, and the file name has a tooltip rather than a native title", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 860 });
    await open(page, (await fixtures()).sample);
    const panel = page.locator("aside.inspector");
    await expect(panel.getByRole("heading", { level: 2, name: "Document" })).toBeVisible();
    const file = panel.locator(".docpanel__file");
    await expect(file).toHaveAttribute("data-tip", "sample.pdf");
    await expect(file).not.toHaveAttribute("title", /./);
    // The privacy note lines up with every other row.
    const [note, facts] = await Promise.all([
      panel.locator(".docpanel__note").boundingBox(),
      panel.locator(".docpanel__facts").boundingBox(),
    ]);
    expect(Math.abs(note!.x - facts!.x)).toBeLessThan(1);
    expect(Math.abs(note!.width - facts!.width)).toBeLessThan(1);
  });

  test("focus moving up a long panel stops below the sticky heading", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 500 });
    await open(page, (await fixtures()).sample);
    await pickTool(page, "Add text");
    const box = (await page.locator(".page").first().boundingBox())!;
    await page.mouse.click(box.x + 150, box.y + 200);
    await expect(page.locator(".props__title")).toHaveText("Text box");
    const inspector = page.locator("aside.inspector");
    const controls = inspector.locator("button:visible, input:visible, select:visible");
    // Start at the bottom, then walk focus up through every control.
    await controls.last().focus();
    const n = await controls.count();
    for (let i = 0; i < n - 1; i++) {
      await page.keyboard.press("Shift+Tab");
      const inside = await inspector.evaluate((el) => el.contains(document.activeElement));
      if (!inside) break;
      const [header, focused] = await Promise.all([
        inspector.locator(".props__header").boundingBox(),
        page.evaluate(() => {
          const r = document.activeElement!.getBoundingClientRect();
          return { top: r.top, sticky: !!document.activeElement!.closest(".props__header") };
        }),
      ]);
      if (focused.sticky) continue;
      expect(focused.top).toBeGreaterThanOrEqual(header!.y + header!.height - 0.5);
    }
  });

  test("OCR reads only shown pages without text, keeps focus, and stops being offered once it has", async ({ page }) => {
    test.slow();
    await page.setViewportSize({ width: 1280, height: 860 });
    test.skip(!(await ocrReady(page)), "OCR assets not installed (npm run setup-ocr)");
    const f = await fixtures();
    // A scan, a page with its own text, and a second scan.
    const mixed = await merge([f.scanned, f.typeset, f.scanned]);
    await open(page, mixed);
    const panel = page.locator("aside.inspector");
    const textPage = page.locator(".page").nth(1);
    const before = await textPage.locator(".fragment").count();
    expect(before).toBeGreaterThan(0);

    // The second scan is deleted: OCR has no business reading it.
    await openOrganise(page);
    const org = page.locator(".organize");
    await org.locator(".pcard").nth(2).locator('[aria-label="Delete page"]').click();
    await org.locator(".btn--filled").click();
    await expect(page.locator(".page")).toHaveCount(2);

    // From the keyboard, so focus is what's being checked.
    await panel.getByRole("button", { name: "Recognise text (OCR)" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.locator(".snackbar__msg")).toContainText(/OCR added \d+ words/, { timeout: 180_000 });
    // Page 2 keeps its own text and gains no second, recognised copy of it.
    await expect(textPage.locator(".fragment")).toHaveCount(before);
    await expect(textPage.locator('.fragment[data-id^="ocr:"]')).toHaveCount(0);
    // Nothing left to read: the offer goes, and focus goes to the panel's
    // heading rather than falling to the page body.
    await expect(panel.getByRole("button", { name: "Recognise text (OCR)" })).toHaveCount(0);
    await expect(panel.getByRole("heading", { name: "Document" })).toBeFocused();

    // The deleted page comes back unread, so the offer comes back with it.
    await page.keyboard.press("Control+z");
    await expect(page.locator(".page")).toHaveCount(3);
    await expect(page.locator(".page").nth(2).locator('.fragment[data-id^="ocr:"]')).toHaveCount(0);
    await expect(panel.getByRole("button", { name: "Recognise text (OCR)" })).toBeVisible();
  });

  test("a page OCR couldn't read stays offered; a page OCR found nothing on says so", async ({ page }) => {
    test.slow();
    await page.setViewportSize({ width: 1280, height: 860 });
    test.skip(!(await ocrReady(page)), "OCR assets not installed (npm run setup-ocr)");
    // The engine is handed an unreadable image for the second page it reads.
    await page.addInitScript(() => {
      const post = Worker.prototype.postMessage;
      let n = 0;
      Worker.prototype.postMessage = function (this: Worker, msg: unknown, ...rest: unknown[]) {
        const m = msg as { action?: string; payload?: Record<string, unknown> } | null;
        if (m && m.action === "recognize" && ++n === 2) {
          msg = { ...m, payload: { ...m.payload, image: "data:image/png;base64,AAAA" } };
        }
        return (post as (...a: unknown[]) => void).call(this, msg, ...rest);
      } as typeof Worker.prototype.postMessage;
    });
    const f = await fixtures();
    await open(page, await merge([f.scanned, f.scanned]));
    const panel = page.locator("aside.inspector");
    const fact = panel.locator(".docpanel__fact", { has: page.locator('dt:text-is("Text")') });
    await panel.getByRole("button", { name: "Recognise text (OCR)" }).click();
    await expect(page.locator(".snackbar__msg")).toContainText("couldn't be read", { timeout: 180_000 });
    await expect(fact).toContainText("Searchable on 1 of 2 pages");
    await expect(panel.getByRole("button", { name: "Recognise text (OCR)" })).toBeVisible();

    // A blank page: OCR runs, finds nothing, and the panel says so — not
    // "no text layer", as if OCR were still worth a try.
    const blank = await PDFDocument.create();
    blank.addPage([595.28, 841.89]);
    const path = join(mkdtempSync(join(tmpdir(), "inspector-")), "blank.pdf");
    writeFileSync(path, await blank.save());
    await page.setInputFiles('input[data-open-input]', path);
    await expect(fact).toContainText("No text layer");
    await panel.getByRole("button", { name: "Recognise text (OCR)" }).click();
    await expect(page.locator(".snackbar__msg")).toContainText("No recognisable text found", { timeout: 180_000 });
    await expect(fact.locator("dd")).toHaveText("No text found, even by OCR");
    await expect(panel.getByRole("button", { name: "Recognise text (OCR)" })).toHaveCount(0);
  });

  test("several objects selected is a selection, not the document, and every panel title is a heading", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 860 });
    await open(page, (await fixtures()).sample);
    const panel = page.locator("aside.inspector");
    await pickSubTool(page, "Pen");
    const box = (await page.locator(".page").first().boundingBox())!;
    for (const y of [200, 260]) {
      await page.mouse.move(box.x + 80, box.y + y);
      await page.mouse.down();
      await page.mouse.move(box.x + 200, box.y + y + 16, { steps: 8 });
      await page.mouse.up();
    }
    await pickTool(page, "Select");
    await page.mouse.move(box.x + 40, box.y + 170);
    await page.mouse.down();
    await page.mouse.move(box.x + 280, box.y + 300, { steps: 12 });
    await page.mouse.up();
    await expect(page.locator(".multisel")).toHaveCount(2);
    await expect(panel).toHaveAccessibleName("Properties");
    await expect(panel.getByRole("heading", { level: 2 })).toHaveText("2 objects selected");

    await page.keyboard.press("Escape");
    await page.locator(".fragment").first().click();
    await expect(panel.getByRole("heading", { level: 2 })).toHaveText("Text");
  });

  test("clicking an image says what it is", async ({ page }) => {
    const w = watch(page);
    await page.setViewportSize({ width: 1280, height: 860 });
    await open(page, (await fixtures()).sample);
    await page.locator('[aria-label="More actions"]').click();
    await page.locator('[role="menuitem"]', { hasText: "Add image" }).click();
    await page.setInputFiles('input[accept="image/*"]', {
      name: "stamp.png",
      mimeType: "image/png",
      buffer: PNG_SQUARE,
    });
    const box = (await page.locator(".page").first().boundingBox())!;
    await page.mouse.click(box.x + 120, box.y + 300);
    await expect(page.locator(".stamp")).toHaveCount(1);
    // Low-left of the stamp: the delete badge and the resize handle live on the
    // right-hand corners, and both are bigger than a small stamp's centre.
    const stamp = (await page.locator(".stamp").first().boundingBox())!;
    await page.mouse.click(stamp.x + 8, stamp.y + stamp.height - 8);
    await expect(page.locator(".props__title")).toHaveText("Image");
    // The page shows how an image is edited; the panel offers a labelled
    // Delete rather than a paragraph of instructions (see show.spec).
    await page.locator(".props").getByRole("button", { name: "Delete" }).click();
    await expect(page.locator(".stamp")).toHaveCount(0);
    expectClean(w);
  });

  test("a new document starts on its own properties", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 860 });
    const f = await fixtures();
    await open(page, f.sample);
    await page.locator(".fragment").first().click();
    await expect(page.locator(".props__title")).toHaveText("Text");
    await page.setInputFiles('input[data-open-input]', f.typeset);
    await expect(page.locator(".snackbar__msg")).toHaveText("Opened · 1 page");
    await expect(page.locator(".props__title")).toHaveText("Document");
    await expect(page.locator(".docpanel__fact", { hasText: "Pages" }).locator("dd")).toHaveText("1");
  });

  test("collapses to an edge control with a readable name, from either view", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 860 });
    await open(page, (await fixtures()).sample);
    const hide = page.getByRole("button", { name: "Hide panel" });
    const show = page.locator(".inspector__tab");
    await hide.click();
    await expect(show).toBeVisible();
    await expect(page.locator(".inspector__tablabel")).toHaveCount(0);
    await show.click();
    await expect(page.locator(".props__title")).toHaveText("Document");
    // The selection's view carries the same control.
    await page.locator(".fragment").first().click();
    await hide.click();
    await expect(show).toBeVisible();
  });
});

test("the page rail toggle controls a region that exists", async ({ page }) => {
  await open(page, (await fixtures()).sample);
  // `aria-expanded` says something expands; `aria-controls` says what. The rail is
  // unmounted while closed, so the reference is only set while it can resolve —
  // a dangling IDREF is worse than none.
  await expect(page.locator('.icon-btn[aria-label="Show pages"]')).not.toHaveAttribute(
    "aria-controls",
    /./,
  );
  await page.locator('.icon-btn[aria-label="Show pages"]').click();
  const id = await page.locator('.icon-btn[aria-label="Hide pages"]').getAttribute("aria-controls");
  expect(id).toBe("page-rail");
  await expect(page.locator(`#${id}`)).toBeVisible();
});

test("the page rail states the document's length", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await open(page, (await fixtures()).sample);
  await page.locator('.icon-btn[aria-label="Show pages"]').click();

  // The page count was nowhere in the UI: "how long is this?" meant scrolling the
  // rail to its end.
  await expect(page.locator(".pagenav__count")).toHaveText("12");

  // Each page is one object — the number is a chip *on* its thumbnail. Set below
  // the thumb, it sat nearer the next page than its own.
  const chip = page.locator(".pagenav__item").first().locator(".pagenav__num");
  const thumb = page.locator(".pagenav__item").first().locator(".pagenav__thumb");
  const [c, t] = [(await chip.boundingBox())!, (await thumb.boundingBox())!];
  expect(c.y).toBeGreaterThanOrEqual(t.y);
  expect(c.y + c.height).toBeLessThanOrEqual(t.y + t.height + 1);

  // The count is decorative; the accessible name has to carry the position.
  await expect(page.locator(".pagenav__item").first()).toHaveAttribute(
    "aria-label",
    /Page 1 of 12/,
  );
});

test("a tooltip on an edge control stays on screen", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await open(page, (await fixtures()).sample);
  // The collapsed Inspector tab sits *at* the right edge, and the bubble is
  // centred on its anchor — so it used to be drawn half outside the window.
  await page.locator('.icon-btn[aria-label="Hide panel"]').click();
  await page.locator(".inspector__tab").hover();
  const tip = page.locator(".tooltip");
  await expect(tip).toBeVisible();
  const b = (await tip.boundingBox())!;
  expect(b.x, "the tooltip starts off the left edge").toBeGreaterThanOrEqual(0);
  expect(b.x + b.width, "the tooltip runs off the right edge").toBeLessThanOrEqual(1280);
  await expect(tip).toHaveText("Show panel");
});

test("user-facing counts are written as English", async ({ page }) => {
  await open(page, (await fixtures()).sample);
  // "1 page(s)" — a placeholder for copy, not copy; nor "9 text fragments",
  // which is how the app reads a file, not how a reader thinks of one.
  await expect(page.locator(".snackbar__msg")).toHaveText("Opened · 12 pages");
});

/**
 * Download is a split button. The main half is the one-click download it always
 * was; the caret opens Export, which holds every action that makes a file
 * without changing the document. Those used to be scattered across "Text" and
 * "Finish" in the ⋯ menu and the Inspector, filed beside actions that edit the
 * document, so "make me a file" had no one place to look.
 */
test.describe("Export split button", () => {
  // "Save as…" is there because Chromium can pick where a file goes; "Save to
  // <file>" and "Share" only show with an opened-in-place file / a share sheet
  // (`saveto.spec`).
  const OUTPUTS = ["Save as…", "Print", "Download with password", "Split into files", "Compress PDF", "Sign with certificate", "Export as images", "Export text (.txt)"];

  test("the caret opens Export, which holds every way to make a file", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 860 });
    const w = watch(page);
    const f = await fixtures();
    await open(page, f.sample);
    const caret = page.getByRole("button", { name: "Export options" });
    await expect(caret).toHaveAttribute("aria-haspopup", "menu");
    await caret.click();
    await expect(caret).toHaveAttribute("aria-expanded", "true");
    const menu = page.getByRole("menu", { name: "Export" });
    const items = menu.getByRole("menuitem");
    // A row's shortcut ("Ctrl+P") is shown after its label on a desktop.
    const starts = (l: string) => new RegExp(`^${l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
    await expect(items).toHaveText(["Download PDF", ...OUTPUTS].map(starts));
    // Focus goes in, the arrows walk it, Escape gives it back to the caret.
    await expect(items.first()).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(items.nth(1)).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowUp");
    await expect(items.last()).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(caret).toBeFocused();

    // Each output has one home: not the ⋯ menu, not the Inspector.
    for (const label of OUTPUTS) {
      await expect(page.locator("aside.inspector").getByRole("button", { name: label })).toHaveCount(0);
    }
    await page.getByRole("button", { name: "More actions" }).click();
    for (const label of OUTPUTS) {
      await expect(page.locator(".menu__item", { hasText: label })).toHaveCount(0);
    }
    await page.keyboard.press("Escape");
    await caret.click();

    // "Download PDF" in the menu is the main half's action.
    await Promise.all([page.waitForEvent("download"), menu.getByRole("menuitem", { name: "Download PDF" }).click()]);
    await expect(menu).toHaveCount(0);
    expectClean(w);
  });

  test("with several documents open, Download all is an export too", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 860 });
    const f = await fixtures();
    await open(page, f.sample);
    await page.setInputFiles('input[data-open-input]', f.typeset);
    await expect(page.locator(".doctab")).toHaveCount(2, { timeout: 30_000 });
    await page.getByRole("button", { name: "More actions" }).click();
    await expect(page.locator(".menu__item", { hasText: "Download all" })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Export options" }).click();
    await expect(page.getByRole("menu", { name: "Export" }).getByRole("menuitem").last()).toHaveText("Download all (2) as ZIP");
  });

  test("on a phone there's no second control: Export heads the ⋯ menu", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    await open(page, (await fixtures()).sample);
    await expect(page.getByRole("button", { name: "Export options" })).toHaveCount(0);
    await page.getByRole("button", { name: "More actions" }).click();
    const group = page.getByRole("group", { name: "Export" });
    await expect(group.getByRole("menuitem")).toHaveText(OUTPUTS);
    await expect(page.locator('[role="menu"] [role="group"]').first()).toHaveAccessibleName("Export");
    await ctx.close();
  });

  test("on a phone, Download all is in the Export group, not File", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    const f = await fixtures();
    await open(page, f.sample);
    await page.setInputFiles('input[data-open-input]', f.typeset);
    await expect(page.locator(".doctab")).toHaveCount(2, { timeout: 30_000 });
    await page.getByRole("button", { name: "More actions" }).click();
    await expect(page.getByRole("group", { name: "Export" }).getByRole("menuitem").last()).toHaveText("Download all (2) as ZIP");
    await expect(page.getByRole("group", { name: "File" }).getByRole("menuitem", { name: /Download all/ })).toHaveCount(0);
    await ctx.close();
  });

  test("an open Export menu keeps the keyboard: nothing reaches the page under it", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 860 });
    await open(page, (await fixtures()).sample);
    await pickTool(page, "Redact");
    await dragOnPage(page, { x: 60, y: 400 }, { x: 420, y: 445 });
    const box = page.locator(".redaction");
    await expect(box).toHaveCount(1);
    const at = await box.boundingBox();
    await page.getByRole("button", { name: "Export options" }).click();
    await expect(page.getByRole("menu", { name: "Export" })).toBeVisible();
    // Delete and the arrows mean "remove / nudge the selection" on the canvas.
    await page.keyboard.press("Delete");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowLeft");
    await expect(box).toHaveCount(1);
    expect(await box.boundingBox()).toEqual(at);
  });

  test("the zoom pill doesn't sit over the open Export menu", async ({ page }) => {
    // Narrow enough that the menu's left edge drops over the pill's right end.
    await page.setViewportSize({ width: 700, height: 860 });
    await open(page, (await fixtures()).sample);
    await page.getByRole("button", { name: "Export options" }).click();
    const items = page.getByRole("menu", { name: "Export" }).getByRole("menuitem");
    for (const item of await items.all()) {
      const hit = await item.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const pts = [[r.left + 4, r.top + r.height / 2], [r.right - 4, r.top + r.height / 2], [r.left + r.width / 2, r.top + r.height / 2]];
        return pts.every(([x, y]) => el.contains(document.elementFromPoint(x, y)));
      });
      expect(hit, `${await item.textContent()} is on top`).toBe(true);
    }
  });

  test("picking an item gives focus back to the caret", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 860 });
    await open(page, (await fixtures()).sample);
    const caret = page.getByRole("button", { name: "Export options" });
    const menu = page.getByRole("menu", { name: "Export" });
    // A dialog it opens hands focus back to where it came from on close.
    await caret.click();
    await menu.getByRole("menuitem", { name: "Compress PDF" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(caret).toBeFocused();
    // A download keeps it too, though nothing can be exported while it runs.
    await page.keyboard.press("Enter");
    await expect(menu.getByRole("menuitem").first()).toBeFocused();
    await Promise.all([page.waitForEvent("download"), page.keyboard.press("Enter")]);
    await expect(caret).toBeFocused();
    await expect(caret).not.toHaveAttribute("aria-disabled", "true");
  });

  test("while a file is being made, the caret won't open a menu of dead items", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 860 });
    await open(page, (await fixtures()).long);
    const caret = page.getByRole("button", { name: "Export options" });
    await caret.click();
    const done = page.waitForEvent("download", { timeout: 120_000 });
    await page.getByRole("menu", { name: "Export" }).getByRole("menuitem", { name: "Export as images" }).click();
    await expect(caret).toHaveAttribute("aria-disabled", "true");
    // Click and read back within a frame: the export is quick enough that a
    // second round trip can land after it finishes.
    const opened = await caret.evaluate(async (el) => {
      if (el.getAttribute("aria-disabled") !== "true") return "finished first";
      (el as HTMLElement).click();
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
      return el.getAttribute("aria-expanded");
    });
    expect(["false", "finished first"]).toContain(opened);
    await done;
  });

  test("the menu doesn't outlive the palette or the breakpoint", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 860 });
    await open(page, (await fixtures()).sample);
    const caret = page.getByRole("button", { name: "Export options" });
    const menu = page.getByRole("menu", { name: "Export" });
    await caret.click();
    await expect(menu).toBeVisible();
    await page.keyboard.press("Control+k");
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(menu).toHaveCount(0);
    await page.keyboard.press("Escape");
    await caret.click();
    await expect(menu).toBeVisible();
    await page.setViewportSize({ width: 500, height: 860 });
    await expect(caret).toHaveCount(0);
    await page.setViewportSize({ width: 1280, height: 860 });
    await expect(caret).toHaveAttribute("aria-expanded", "false");
    await expect(menu).toHaveCount(0);
  });
});

/**
 * The command palette, the ⋯ menu and the Export menu all render from one
 * command registry (`commands` in `DocumentEditor.tsx`). Before that the palette
 * was a hand-kept second list: zoom, the panel toggle, align/distribute and the
 * "Save session" setting existed in the app and not in it, and labels drifted
 * ("Show page thumbnails" there, "Show pages" on the button it mirrors).
 */
test.describe("command registry", () => {
  /** Every row of an open menu — any menuitem, whatever its class, so a
   * hand-made row can't hide from this — as [id, label, icon, mark, checked, group].
   * Switched-off rows are left out: the palette lists only what can run now
   * (Split, say, with a one-page document in front). */
  const rowsOf = (page: Page, menu: string) =>
    page.locator(`${menu} [role^="menuitem"]:not(:disabled)`).evaluateAll((els) =>
      els.map((el) => [
        el.getAttribute("data-cmd") ?? "",
        el.querySelector(".menu__itemlabel")?.textContent?.trim() ?? "",
        el.querySelector("svg")?.getAttribute("class") ?? "",
        el.querySelector(".opens-mark") ? "opens" : "",
        el.getAttribute("aria-checked") ?? "",
        el.getAttribute("data-group") ?? "",
      ]),
    );

  /** Every command the palette lists with an empty query, as [id, group]. */
  async function paletteAll(page: Page) {
    await page.fill(".cmdk input", "");
    return page.locator(".cmdk__item").evaluateAll((els) =>
      els.map((el) => [el.getAttribute("data-cmd") ?? "", el.getAttribute("data-group") ?? ""]),
    );
  }

  /** Each group a menu shows holds exactly the palette's commands of that
   * group — both ways, so a menu that drops one is caught as surely as a row
   * the palette lacks. `except` are rows a menu leaves out on purpose. */
  function sameGroups(menuRows: string[][], palette: string[][], except: string[] = []) {
    const groups = new Set(menuRows.map((r) => r[5]));
    for (const g of groups) {
      const inMenu = menuRows.filter((r) => r[5] === g).map((r) => r[0]).filter((id) => id !== "palette").sort();
      const inPalette = palette.filter(([, pg]) => pg === g).map(([id]) => id).filter((id) => !except.includes(id)).sort();
      expect(inMenu, `the "${g}" group`).toEqual(inPalette);
    }
  }

  /** Search the palette for `label` and return the row for command `id`. */
  async function paletteRow(page: Page, id: string, label: string) {
    await page.fill(".cmdk input", label);
    // Not the row in a palette still fading out from the last command.
    return page.locator(`.cmdk-scrim:not(.is-leaving) .cmdk__item[data-cmd="${id}"]`);
  }

  test("every menu row is a palette command, with the same name, icon and mark", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 860 });
    const w = watch(page);
    const f = await fixtures();
    await open(page, f.sample);
    await page.setInputFiles('input[data-open-input]', f.typeset);
    await expect(page.locator(".doctab")).toHaveCount(2, { timeout: 30_000 });

    await page.getByRole("button", { name: "More actions" }).click();
    const more = await rowsOf(page, '[role="menu"]');
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Export options" }).click();
    const exporting = await rowsOf(page, '[role="menu"][aria-label="Export"]');
    await page.keyboard.press("Escape");

    const rows = [...more, ...exporting].filter(([id]) => id !== "palette");
    expect(new Set(more.map((r) => r[5]))).toEqual(new Set(["organise", "text", "finish", "settings", "file"]));
    // Every row carries its command id: a row without one is hand-made again.
    expect(rows.every(([id, label]) => id && label), JSON.stringify(rows)).toBe(true);
    expect(rows.map(([id]) => id)).toEqual(expect.arrayContaining([
      "organize", "ocr", "numbers", "theme", "dim", "autosave", "lossless", "open", "close",
      "download", "compress", "eximg", "download-all",
    ]));

    await page.keyboard.press("Control+k");
    await expect(page.locator(".cmdk")).toBeVisible();
    sameGroups([...more, ...exporting], await paletteAll(page));
    for (const [id, label, icon, mark, checked] of rows) {
      const row = await paletteRow(page, id, label);
      await expect(row, `"${label}" (${id}) is in the palette`).toHaveCount(1);
      await expect(row.locator(".cmdk__label")).toHaveText(label);
      // Named by its label alone: the hint beside it is not part of the name.
      await expect(row).toHaveAccessibleName(new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
      if (checked) await expect(row).toHaveAttribute("aria-checked", checked);
      await expect(row.locator("svg").first(), `"${label}" has the same icon`).toHaveAttribute("class", icon);
      await expect(row.locator(".opens-mark"), `"${label}" is marked the same`).toHaveCount(mark ? 1 : 0);
    }
    await page.keyboard.press("Escape");
    expectClean(w);
  });

  test("on a phone, the ⋯ menu (Export first) is the palette's groups too", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    await open(page, (await fixtures()).sample);
    await page.getByRole("button", { name: "More actions" }).click();
    const more = await rowsOf(page, '[role="menu"]');
    expect(more[0][5]).toBe("export");
    await page.getByRole("menuitem", { name: /Search commands/ }).click();
    await expect(page.locator(".cmdk")).toBeVisible();
    // Download PDF is the bar's own button on a phone, so the menu leaves it out.
    sameGroups(more, await paletteAll(page), ["download"]);
    await ctx.close();
  });

  test("commands that only lived on buttons are in the palette, and run", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 860 });
    await open(page, (await fixtures()).sample);
    const zoom = page.locator(".zoombar__label:not(.zoombar__page)");
    const before = await zoom.textContent();

    await page.keyboard.press("Control+k");
    await (await paletteRow(page, "zoom-in", "zoom in")).click();
    await expect(zoom).not.toHaveText(before ?? "");
    await page.keyboard.press("Control+k");
    await (await paletteRow(page, "zoom-fit", "fit to width")).click();
    await expect(zoom).toHaveText(before ?? "");

    // The panel toggle, named as its own button is.
    await expect(page.locator("aside.inspector")).toBeVisible();
    await page.keyboard.press("Control+k");
    await (await paletteRow(page, "panel", "Hide panel")).click();
    await expect(page.locator("aside.inspector")).toHaveCount(0);
    await page.keyboard.press("Control+k");
    await (await paletteRow(page, "panel", "Show panel")).click();
    await expect(page.locator("aside.inspector")).toBeVisible();

    // The pages toggle says what its button says.
    const pagesBtn = page.locator(".appbar").getByRole("button", { name: /(Show|Hide) pages/ });
    const pagesName = await pagesBtn.getAttribute("aria-label");
    await page.keyboard.press("Control+k");
    await page.fill(".cmdk input", "pages");
    await expect(page.locator('.cmdk__item[data-cmd="pages"] .cmdk__label')).toHaveText(pagesName ?? "");
    await page.keyboard.press("Escape");

    // A device setting shows its state, and switching it there is the same switch.
    await page.keyboard.press("Control+k");
    const save = await paletteRow(page, "autosave", "Save session");
    const was = (await save.getAttribute("aria-checked")) === "true";
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "More actions" }).click();
    const item = page.getByRole("menuitemcheckbox", { name: /Save session on this device/ });
    await expect(item).toHaveAttribute("aria-checked", String(was));
    await item.click();
    await page.keyboard.press("Control+k");
    const again = await paletteRow(page, "autosave", "Save session");
    await expect(again).toHaveAttribute("aria-checked", String(!was));
    // And the other way: switched from the palette, the menu shows it.
    await again.click();
    await page.getByRole("button", { name: "More actions" }).click();
    await expect(item).toHaveAttribute("aria-checked", String(was));
    await page.keyboard.press("Escape");
  });

  test("a group selection's actions are commands too, and only while there is one", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 860 });
    await open(page, (await fixtures()).sample);
    await page.keyboard.press("Control+k");
    await page.fill(".cmdk input", "align");
    await expect(page.locator(".cmdk__item")).toHaveCount(0);
    await page.keyboard.press("Escape");

    // Two strokes, one above the other, then a marquee round both.
    await pickSubTool(page, "Pen");
    const box = (await page.locator(".page").first().boundingBox())!;
    for (const [x, y] of [[80, 200], [140, 260]]) {
      await page.mouse.move(box.x + x, box.y + y);
      await page.mouse.down();
      await page.mouse.move(box.x + x + 100, box.y + y + 10, { steps: 8 });
      await page.mouse.up();
      await page.waitForTimeout(150);
    }
    await pickTool(page, "Select");
    await page.mouse.move(box.x + 40, box.y + 170);
    await page.mouse.down();
    await page.mouse.move(box.x + 300, box.y + 300, { steps: 12 });
    await page.mouse.up();
    await expect(page.locator(".multisel")).toHaveCount(2);

    const lefts = () => page.locator(".multisel").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().left)));
    const [a, b] = await lefts();
    expect(a).not.toBe(b);
    await page.keyboard.press("Control+k");
    await (await paletteRow(page, "align-left", "Align left")).click();
    await expect.poll(async () => new Set(await lefts()).size).toBe(1);
    // Distributing needs three; with two it isn't offered (while the group,
    // and so aligning, still is — otherwise this would pass on a lost selection).
    await page.keyboard.press("Control+k");
    await expect(await paletteRow(page, "align-right", "Align right")).toHaveCount(1);
    await page.fill(".cmdk input", "distribute");
    await expect(page.locator(".cmdk__item")).toHaveCount(0);
    await page.keyboard.press("Escape");
  });

  /** Two pen strokes on the first page, then a marquee round both. */
  async function groupOfTwo(page: Page) {
    await pickSubTool(page, "Pen");
    const box = (await page.locator(".page").first().boundingBox())!;
    for (const [x, y] of [[80, 200], [140, 260]]) {
      await page.mouse.move(box.x + x, box.y + y);
      await page.mouse.down();
      await page.mouse.move(box.x + x + 100, box.y + y + 10, { steps: 8 });
      await page.mouse.up();
      await page.waitForTimeout(150);
    }
    await pickTool(page, "Select");
    await page.mouse.move(box.x + 40, box.y + 170);
    await page.mouse.down();
    await page.mouse.move(box.x + 300, box.y + 300, { steps: 12 });
    await page.mouse.up();
    await expect(page.locator(".multisel")).toHaveCount(2);
  }
  const strokes = (page: Page) => page.locator(".page .annot-svg polyline[stroke]:not([stroke='transparent'])");

  test("a shortcut the palette shows is one the app honours", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 860 });
    await open(page, (await fixtures()).sample);
    await groupOfTwo(page);

    // "Duplicate · Ctrl+D" on a group: the key does what the row says, and the
    // browser doesn't get it (it offered to bookmark the page).
    await page.keyboard.press("Control+k");
    await expect((await paletteRow(page, "duplicate", "Duplicate")).locator(".cmdk__hint")).toHaveText("Ctrl+D");
    await page.keyboard.press("Escape");
    // Backing out of the palette leaves the selection it was opened over.
    await expect(page.locator(".multisel")).toHaveCount(2);
    const prevented = page.evaluate(
      () =>
        new Promise<boolean>((done) => {
          const h = (e: KeyboardEvent) => {
            if (e.key.toLowerCase() !== "d") return; // not the Control press before it
            window.removeEventListener("keydown", h);
            setTimeout(() => done(e.defaultPrevented));
          };
          window.addEventListener("keydown", h);
        }),
    );
    await page.keyboard.press("Control+d");
    expect(await prevented, "Ctrl+D reached the browser").toBe(true);
    await expect(strokes(page)).toHaveCount(4);

    // A text box keeps Del for its text, so Delete offers no Del there.
    await page.keyboard.press("Escape");
    await pickTool(page, "Add text");
    const box = (await page.locator(".page").first().boundingBox())!;
    await page.mouse.click(box.x + 150, box.y + 420);
    await expect(page.locator(".props__title")).toHaveText("Text box");
    await page.keyboard.press("Control+k");
    await expect((await paletteRow(page, "delete", "Delete")).locator(".cmdk__hint", { hasText: "Del" })).toHaveCount(0);
    await page.keyboard.press("Escape");
  });

  test("a Draw sub-tool picked from the palette behaves as picked from the strip, and isn't marked as a dialog", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 860 });
    await open(page, (await fixtures()).sample);
    await page.keyboard.press("Control+k");
    await expect((await paletteRow(page, "tool-draw", "Draw")).locator(".opens-mark")).toHaveCount(0);
    await expect((await paletteRow(page, "goto", "Go to page")).locator(".opens-mark")).toHaveCount(0);
    await (await paletteRow(page, "draw-arrow", "Arrow")).click();
    await expect(page.locator('.tooldock__btn[aria-label="Draw"]')).toHaveAttribute("aria-pressed", "true");
    // The strip stands down so the page is there to draw on, and says which.
    await expect(page.locator(".drawbar--closed")).toHaveCount(1);
    await expect(page.locator(".drawbar__handle")).toContainText("Arrow");
  });

  test("a command that doesn't move focus leaves it where it was", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 860 });
    await open(page, (await fixtures()).sample);
    const zoomIn = page.getByRole("button", { name: "Zoom in" });
    await zoomIn.focus();
    await page.keyboard.press("Control+k");
    await (await paletteRow(page, "zoom-out", "Zoom out")).click();
    await expect(zoomIn).toBeFocused();
    await page.keyboard.press("Control+k");
    await page.keyboard.press("Escape");
    await expect(zoomIn).toBeFocused();
    // One that does move it still gets to.
    await page.keyboard.press("Control+k");
    await (await paletteRow(page, "find", "Find in document")).click();
    await expect(page.locator(".findbar__input")).toBeFocused();
  });

  test("the ⋯ menu says where to find everything: Search commands opens the palette", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 860 });
    await open(page, (await fixtures()).sample);
    await page.getByRole("button", { name: "More actions" }).click();
    const item = page.getByRole("menuitem", { name: /Search commands/ });
    await expect(item).toContainText("Ctrl+K");
    await item.click();
    await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
    await expect(page.locator(".cmdk input")).toBeFocused();
    // And the palette doesn't offer itself.
    await page.fill(".cmdk input", "search commands");
    await expect(page.locator(".cmdk__item")).toHaveCount(0);
  });
});
