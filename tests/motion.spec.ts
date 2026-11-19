import { expect, test, type Page } from "@playwright/test";
import { fixtures } from "./fixtures";
import { open, pickSubTool, pickTool } from "./helpers";

/**
 * Open and close (10g).
 *
 * Dialogs and menus appeared and vanished in a single frame; only the
 * Inspector, the phone sheet, the palette and toasts had an entrance, and
 * nothing had an exit, because React removes a closed surface outright. Now
 * every surface over the work arrives with a short settle, and the floating
 * ones leave: a copy of the closed surface plays the exit (src/leave.ts).
 *
 * The copy is a picture, never a second surface: inert, hidden from assistive
 * tech, with no ids or roles for a locator, a label or a screen reader to
 * find, and gone when the motion ends. Under reduced motion there is none.
 * A docked panel makes none either — a copy in the layout would shove the
 * page sideways for the length of the exit.
 */

/** Count every exit copy the page makes from here on. */
const countCopies = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __copies: string[] };
    w.__copies = [];
    new MutationObserver((records) => {
      for (const r of records)
        for (const n of r.addedNodes)
          if (n instanceof HTMLElement && n.classList.contains("is-leaving")) w.__copies.push(n.className.replace(" is-leaving", ""));
    }).observe(document.body, { subtree: true, childList: true });
  });
const copies = (page: Page) => page.evaluate(() => (window as unknown as { __copies: string[] }).__copies);

async function openWatermark(page: Page) {
  await page.locator('[aria-label="More actions"]').click();
  await page.locator('[role="menu"] [role^="menuitem"]', { hasText: "Watermark" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
}

test.describe("open and close", () => {
  test("a dialog settles in and leaves as a picture nothing can reach", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 860 });
    await open(page, (await fixtures()).sample);
    await countCopies(page);

    await page.locator('[aria-label="More actions"]').click();
    const menuIn = await page.locator('[role="menu"]').evaluate((el) => el.getAnimations().map((a) => (a as CSSAnimation).animationName));
    expect(menuIn, "the menu arrives").toContain("menu-in");
    await page.locator('[role="menu"] [role^="menuitem"]', { hasText: "Watermark" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    const dialogIn = await dialog.evaluate((el) => el.getAnimations().map((a) => (a as CSSAnimation).animationName));
    expect(dialogIn, "the dialog arrives").toContain("dialog-in");
    expect(await copies(page), "the menu left as the dialog came").toEqual(["menu__list"]);

    // Fill a field so the copy has something it must carry.
    await page.locator(".dialog input[type=text], .dialog input:not([type])").first().fill("CONFIDENTIAL");
    await page.keyboard.press("Escape");

    // At once: the dialog is gone for everything that reads the page…
    await expect(page.getByRole("dialog")).toHaveCount(0);
    const ghost = await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>(".dialog-scrim.is-leaving");
      if (!el) return null;
      return {
        inert: el.inert,
        hidden: el.getAttribute("aria-hidden"),
        ids: el.querySelectorAll("[id]").length,
        roles: el.querySelectorAll("[role]").length,
        labelled: el.querySelectorAll("[aria-label], [aria-labelledby], [aria-modal]").length,
        typed: [...el.querySelectorAll("input")].some((i) => i.value === "CONFIDENTIAL"),
        clickThrough: getComputedStyle(el).pointerEvents,
        animation: el.getAnimations().map((a) => (a as CSSAnimation).animationName),
      };
    });
    // …while its picture leaves.
    expect(ghost).toEqual({
      inert: true,
      hidden: "true",
      ids: 0,
      roles: 0,
      labelled: 0,
      typed: true,
      clickThrough: "none",
      animation: ["scrim-out"],
    });
    // Focus went back where it came from, not into the picture.
    await expect(page.locator('[aria-label="More actions"]')).toBeFocused();
    await expect(page.locator(".is-leaving")).toHaveCount(0, { timeout: 1000 });
  });

  test("a click during the exit goes to what's under it", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 860 });
    await open(page, (await fixtures()).sample);
    await openWatermark(page);
    await page.keyboard.press("Escape");
    // Straight away, on the button the leaving scrim still covers.
    await page.locator('[aria-label="More actions"]').click({ timeout: 500 });
    await expect(page.locator('[role="menu"]')).toBeVisible();
  });

  test("the phone sheet slides away, its scrim fades", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await open(page, (await fixtures()).sample);
    const box = (await page.locator(".page").first().boundingBox())!;
    await pickSubTool(page, "Note");
    await page.mouse.click(box.x + 120, box.y + 300);
    await page.keyboard.type("Hi");
    await pickTool(page, "Select");
    await page.locator(".note").first().click({ position: { x: 4, y: 4 } });
    // On a phone a selection brings its bar; Style raises the sheet.
    await page.locator(".selbar__btn", { hasNotText: "Edit" }).first().click();
    await expect(page.locator("aside.panel")).toBeVisible();
    await countCopies(page);
    await page.keyboard.press("Escape");
    await expect(page.locator("aside.panel")).toHaveCount(0);
    expect((await copies(page)).sort()).toEqual(["panel", "scrim"]);
    await expect(page.locator(".is-leaving")).toHaveCount(0, { timeout: 1000 });
  });

  test("a docked panel leaves no copy in the layout", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 860 });
    await open(page, (await fixtures()).sample);
    await page.getByRole("button", { name: "Show pages" }).click();
    await expect(page.locator(".pagenav")).toBeVisible();
    await countCopies(page);
    await page.getByRole("button", { name: "Hide pages" }).click();
    await expect(page.locator(".pagenav")).toHaveCount(0);
    await page.waitForTimeout(100);
    expect(await copies(page)).toEqual([]);
  });

  test("reduced motion: nothing moves and no copy is made", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1280, height: 860 });
    await open(page, (await fixtures()).sample);
    await countCopies(page);
    await openWatermark(page);
    const running = await page.getByRole("dialog").evaluate((el) =>
      el.getAnimations().filter((a) => a.effect?.getComputedTiming().duration !== 0).length,
    );
    expect(running).toBe(0);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(await copies(page)).toEqual([]);
  });
});
