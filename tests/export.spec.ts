import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fixtures } from "./fixtures";
import { open, watch, pickTool, dragOnPage, pageTexts } from "./helpers";

/**
 * What actually ends up in the file the user hands to someone else.
 *
 * Several of this product's most important claims are only observable in the
 * exported bytes — that a redaction removed the content, that no active link
 * survived, that no authoring metadata was written. So these specs read the
 * bytes rather than trusting the UI.
 */
test.describe("export integrity", () => {
  test("an unsafe link URL is refused in the UI and never reaches the file", async ({ page }) => {
    const w = watch(page);
    await open(page, (await fixtures()).sample);

    await pickTool(page, "Link");
    await dragOnPage(page, { x: 80, y: 120 }, { x: 280, y: 165 });
    await page.waitForSelector("#link-url");

    // A `/URI` action is a live capability in the reader that opens the file, so
    // `javascript:` must be refused — and refused visibly, not dropped silently
    // at download time.
    await page.fill("#link-url", "javascript:alert(1)");
    await expect(page.locator("#link-url")).toHaveAttribute("aria-invalid", "true");
    await expect(page.locator("#link-url-note")).toContainText(/can.t be used/i);

    // A bare hostname is the common case and must still work.
    await page.fill("#link-url", "example.com/report");
    await expect(page.locator("#link-url")).not.toHaveAttribute("aria-invalid", "true");

    // Leave an unsafe value in place: the exporter is the real choke point, since
    // a value could also arrive from a restored session.
    await page.fill("#link-url", "javascript:alert('pwned')");
    await page.waitForTimeout(200);

    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 60_000 }),
      page.click(".appbar__download"),
    ]);
    const path = (await download.path())!;
    const raw = readFileSync(path, "latin1");

    expect(raw.startsWith("%PDF-")).toBe(true);
    expect(raw).not.toMatch(/javascript\s*:/i);
    // Privacy: a downloaded copy should not say who made it, when, or with what.
    expect(raw).not.toMatch(/\/Producer|\/Creator|\/ModDate|\/CreationDate/);
    expect(w.errors).toEqual([]);
  });

  test("a redaction removes the text; other pages keep theirs", async ({ page }) => {
    await open(page, (await fixtures()).sample);

    // Edit a text run first: on the raster path the white cover over replaced
    // text must be *measured*, or the original shows past it — permanently, since
    // the raster is all that survives.
    const frag = page.locator('.page [role="textbox"]').first();
    await frag.click();
    await frag.evaluate((el) => {
      (el as HTMLElement).focus();
      document.execCommand("selectAll");
    });
    await page.keyboard.type("WWWWWWWWWWWWWWWWWWWWWWWWWWWWWW");
    await page.waitForTimeout(300);

    // Leave the overlay before switching tools (a focused contentEditable
    // correctly swallows the single-key shortcut). Blur it outright rather
    // than clicking "somewhere neutral" in the app bar — the brand there is
    // the close-document control now, and the rest is a zero-width spacer.
    await frag.evaluate((el) => (el as HTMLElement).blur());
    await pickTool(page, "Redact");
    await dragOnPage(page, { x: 60, y: 400 }, { x: 420, y: 445 });
    await expect(page.locator(".redaction")).toHaveCount(1);

    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 120_000 }),
      page.click(".appbar__download"),
    ]);
    const bytes = readFileSync((await download.path())!);

    const [first, second] = await pageTexts(bytes, [1, 2]);
    expect(first.trim(), "the redacted page is rasterised — no text layer").toBe("");
    expect(second, "untouched pages keep selectable vector text").toContain("quick brown fox");
  });
});
