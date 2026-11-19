import { expect, test, type Page } from "@playwright/test";
import { fixtures } from "./fixtures";
import { dragOnPage, open, openOrganise, pickSubTool, pickTool } from "./helpers";

/**
 * Show, don't tell (10f). The page, its handles and its cursors say how a
 * thing is edited; text is kept for what they can't show — a consequence, an
 * error, a state. Each surface here used to carry a sentence of instructions.
 * A word budget, not a string match, so a reworded paragraph can't sneak back.
 */

const words = (s: string) => (s.match(/\S+/g) ?? []).length;

/** Visible instruction notes in the Inspector (empty ones take no room). */
async function inspectorNotes(page: Page): Promise<string[]> {
  return page.locator("aside.inspector .props__empty:visible").allInnerTexts();
}

test.describe("show, don't tell", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 860 });
  });

  test("a selected image, note or link carries no how-to paragraph", async ({ page }) => {
    const f = await fixtures();
    await open(page, f.sample);
    const box = (await page.locator(".page").first().boundingBox())!;

    // A note: its text is edited where it sits.
    await pickSubTool(page, "Note");
    await page.mouse.click(box.x + 120, box.y + 300);
    await page.keyboard.type("Hi");
    await pickTool(page, "Select");
    await page.locator(".note").first().click({ position: { x: 4, y: 4 } });
    await expect(page.locator(".props__title")).toHaveText("Sticky note");
    expect(await inspectorNotes(page)).toEqual([]);

    // A link with a good address: the box on the page is the explanation.
    await pickTool(page, "Link");
    await dragOnPage(page, { x: 80, y: 420 }, { x: 280, y: 465 });
    await page.fill("#link-url", "https://example.com");
    expect(await inspectorNotes(page)).toEqual([]);
    // …and to a page: its tooltip on the page names the target.
    await page.getByRole("radio", { name: "Page" }).click();
    expect(await inspectorNotes(page)).toEqual([]);
    // A refused address still says why — errors stay words.
    await page.getByRole("radio", { name: "Web address" }).click();
    await page.fill("#link-url", "javascript:alert(1)");
    await expect(page.locator("#link-url-note")).toContainText("can't be used");
  });

  test("an image offers Delete, and its rotate ring has a turning cursor", async ({ page }) => {
    await open(page, (await fixtures()).sample);
    await page.locator('[aria-label="More actions"]').click();
    await page.locator('[role="menuitem"]', { hasText: "Add image" }).click();
    // A 64×64 square.
    await page.setInputFiles('input[accept="image/*"]', {
      name: "stamp.png",
      mimeType: "image/png",
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAT0lEQVR42u3PQQkAAAgEsItz/VMYywi+hcEKLO28FgEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQGBywLt4oEAvGaPlQAAAABJRU5ErkJggg==",
        "base64",
      ),
    });
    const box = (await page.locator(".page").first().boundingBox())!;
    await page.mouse.click(box.x + 120, box.y + 300);
    const stamp = (await page.locator(".stamp").first().boundingBox())!;
    await page.mouse.click(stamp.x + 8, stamp.y + stamp.height - 8);
    await expect(page.locator(".props__title")).toHaveText("Image");
    expect(await inspectorNotes(page)).toEqual([]);
    const words_ = await page.locator("aside.inspector .props").innerText();
    expect(words(words_), words_).toBeLessThanOrEqual(4); // "Image", "Delete", chrome

    const cursor = await page
      .locator(".rotate-zone")
      .first()
      .evaluate((el) => getComputedStyle(el).cursor);
    expect(cursor).toContain("url(");
    expect(cursor).toMatch(/grab$/); // a fallback if the image can't be used
  });

  test("several selected objects: a count, not a paragraph", async ({ page }) => {
    await open(page, (await fixtures()).sample);
    const box = (await page.locator(".page").first().boundingBox())!;
    await pickSubTool(page, "Pen");
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
    const panel = page.locator("aside.inspector .props");
    await expect(panel.getByRole("heading", { level: 2 })).toHaveText("2 objects selected");
    await expect(panel.locator("p")).toHaveCount(0);
  });

  test("Organise, a picture-only page and the document panel stay short", async ({ page }) => {
    const f = await fixtures();
    await open(page, f.sample);

    const doc = page.locator(".docpanel__note");
    expect(words(await doc.innerText())).toBeLessThanOrEqual(6);

    await openOrganise(page);
    const hint = page.locator(".organize__hint");
    await expect(hint).toContainText("new pages go at the end");
    // The file's name plus where a new page lands — nothing about how to drag.
    expect(words(await hint.innerText())).toBeLessThanOrEqual(8);
    await page.keyboard.press("Escape");

    await open(page, f.scanned);
    await page.locator(".page").first().click({ position: { x: 150, y: 150 } });
    const pic = page.locator(".picturehint__text");
    await expect(pic).toBeVisible();
    expect(words(await pic.innerText())).toBeLessThanOrEqual(7);
  });
});
