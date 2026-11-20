import { test, expect, type Page } from "@playwright/test";
import { PDFDocument } from "pdf-lib";
import { fixtures } from "./fixtures";
import { open, watch, expectClean, pickSubTool, dragOnPage } from "./helpers";

// 11a — on a phone, what floats over what. A phone with touch, set at the top
// level (Playwright won't take per-group device options in one worker); the one
// desktop check resizes the window itself.
test.use({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});

const menuItem = (page: Page, label: string) =>
  page.locator(`[role="menu"]:not(.is-leaving) [role^="menuitem"]`, { hasText: label }).first();

async function openMore(page: Page) {
  await page.locator(".appbar__more").tap();
  await expect(page.locator(".menu__list:not(.is-leaving)")).toBeVisible();
  // Let the sheet finish rising before measuring it.
  await page.waitForTimeout(400);
}

test("phone: the zoom pill gives its corner back; zoom and Go to page live in ⋯", async ({ page }) => {
  const w = watch(page);
  await open(page, (await fixtures()).long);

  // Pinch already zooms; the pill sat over the first lines of the page.
  await expect(page.locator(".zoombar")).toHaveCount(0);

  // ⋯ has a View group with zoom in it, and it works.
  const before = (await page.locator(".page").first().boundingBox())!.width;
  await openMore(page);
  await expect(page.locator(".menu__list .menu__label", { hasText: "View" })).toBeVisible();
  await menuItem(page, "Zoom in").tap();
  await expect.poll(async () => (await page.locator(".page").first().boundingBox())!.width).toBeGreaterThan(before + 10);

  // "Go to page…" brings the pill back only to hold the page field…
  await openMore(page);
  await menuItem(page, "Go to page").tap();
  const field = page.locator(".zoombar .zoombar__input");
  await expect(field).toBeFocused();
  await field.fill("40");
  await field.press("Enter");
  // …and it goes again once the field closes.
  await expect(page.locator(".zoombar")).toHaveCount(0);
  expectClean(w);
});

test("phone: every floating control sits under every dim", async ({ page }) => {
  await open(page, (await fixtures()).long);
  // Bring the pill up (the page field), then compare its layer and the dock's
  // with each dim's: the drawer's, the sheet's, a menu's, a dialog's.
  await openMore(page);
  await menuItem(page, "Go to page").tap();
  await expect(page.locator(".zoombar")).toBeVisible();
  const layers = await page.evaluate(() => {
    const z = (el: Element) => Number(getComputedStyle(el).zIndex) || 0;
    const probe = (cls: string) => {
      const d = document.createElement("div");
      d.className = cls;
      document.body.append(d);
      const v = z(d);
      d.remove();
      return v;
    };
    return {
      controls: { zoombar: z(document.querySelector(".zoombar")!), tooldock: z(document.querySelector(".tooldock")!) },
      dims: {
        drawer: probe("pagenav__scrim"),
        sheet: probe("scrim"),
        menu: probe("menu__scrim"),
        dialog: probe("dialog-scrim"),
      },
    };
  });
  const lowestDim = Math.min(...Object.values(layers.dims));
  for (const [name, z] of Object.entries(layers.controls)) {
    expect(z, `${name} (${z}) under every dim ${JSON.stringify(layers.dims)}`).toBeLessThan(lowestDim);
  }
});

test("phone: ⋯ is a sheet from the bottom edge, over a dim", async ({ page }) => {
  await open(page, (await fixtures()).sample);
  await openMore(page);
  const r = await page.evaluate(() => {
    const list = document.querySelector(".menu__list:not(.is-leaving)")!.getBoundingClientRect();
    const scrim = getComputedStyle(document.querySelector(".menu__scrim")!).backgroundColor;
    return { left: list.left, right: list.right, bottom: list.bottom, top: list.top, vw: innerWidth, vh: innerHeight, scrim };
  });
  expect(r.left).toBe(0);
  expect(r.right).toBe(r.vw);
  expect(Math.abs(r.bottom - r.vh)).toBeLessThan(1);
  // It leaves the app bar showing (dimmed), rather than hanging over it.
  expect(r.top).toBeGreaterThan(52);
  expect(r.scrim).not.toBe("rgba(0, 0, 0, 0)");
  // A tap on the dim puts it away.
  await page.mouse.click(r.vw / 2, 30);
  await expect(page.locator(".menu__list:not(.is-leaving)")).toHaveCount(0);
});

test("phone: a tap on a tool shows no shortcut tip; the keyboard still gets one", async ({ page }) => {
  await open(page, (await fixtures()).sample);
  await page.locator('.tooldock__btn[aria-label="Draw"]').tap();
  await page.waitForTimeout(400);
  await expect(page.locator(".tooltip")).toHaveCount(0);
  // Focus by keyboard still explains the control.
  await page.keyboard.press("Shift+Tab");
  await expect(page.locator(".tooltip")).toHaveCount(1);
});

test("phone: the draw bar is one row, every control reachable, the fold handle always showing", async ({ page }) => {
  await open(page, (await fixtures()).sample);
  await page.locator('.tooldock__btn[aria-label="Draw"]').tap();
  const bar = page.locator(".drawbar:not(.drawbar--closed)");
  await expect(bar).toBeVisible();
  const m = await bar.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { h: r.height, left: r.left, right: r.right, vw: innerWidth, sw: el.scrollWidth, cw: el.clientWidth };
  });
  // One row: a 48px control and the bar's padding, not two rows (~110px).
  expect(m.h).toBeLessThan(64);
  expect(m.left).toBeGreaterThanOrEqual(0);
  expect(m.right).toBeLessThanOrEqual(m.vw);
  // It runs past the screen, so it scrolls: Note is reachable that way…
  expect(m.sw).toBeGreaterThan(m.cw);
  await bar.locator('.icon-btn[aria-label="Note"]').scrollIntoViewIfNeeded();
  await expect(bar.locator('.icon-btn[aria-label="Note"]')).toBeInViewport({ ratio: 1 });
  // …and the way out stays pinned to the end of the bar.
  const fold = await bar.locator(".drawbar__collapse").boundingBox();
  const barBox = (await bar.boundingBox())!;
  expect(fold!.x + fold!.width).toBeLessThanOrEqual(barBox.x + barBox.width);
});

test("phone: the toast is one line, and the first edit sends it away", async ({ page }) => {
  await open(page, (await fixtures()).typeset);
  const toast = page.locator(".snackbar");
  await expect(toast).toHaveText("Opened a 1-page document.");
  const box = (await toast.boundingBox())!;
  // One line (13px padding twice and a 20px line), and not squeezed to half
  // the screen by its own centring.
  expect(box.height).toBeLessThan(52);
  expect(box.width).toBeGreaterThanOrEqual(240);
  // Working on the document is the cue it has said its piece, well before 4s.
  await pickSubTool(page, "Rectangle");
  await dragOnPage(page, { x: 40, y: 200 }, { x: 140, y: 260 });
  await expect(toast).toHaveCount(0, { timeout: 1000 });
});

test("desktop: with the draw options open, the page's foot scrolls clear of them", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await open(page, (await fixtures()).typeset);
  await page.locator('.tooldock__btn[aria-label="Draw"]').click();
  await expect(page.locator(".drawbar:not(.drawbar--closed)")).toBeVisible();
  await page.locator(".viewer__scroll").evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await page.waitForTimeout(200);
  const { pageBottom, barTop } = await page.evaluate(() => ({
    pageBottom: document.querySelector(".page")!.getBoundingClientRect().bottom,
    barTop: document.querySelector(".drawbar")!.getBoundingClientRect().top,
  }));
  expect(pageBottom, "the page's last line is above the draw options").toBeLessThanOrEqual(barTop);
});

test("phone: Go to page closed with Enter hands focus to ⋯, not the page body", async ({ page }) => {
  await open(page, (await fixtures()).long);
  await openMore(page);
  await menuItem(page, "Go to page").tap();
  const field = page.locator(".zoombar .zoombar__input");
  await expect(field).toBeFocused();
  await field.fill("40");
  await field.press("Enter");
  await expect(page.locator(".zoombar")).toHaveCount(0);
  // The chip that takes focus back on a wide screen went with the pill.
  await expect(page.locator(".appbar__more")).toBeFocused();
});

test("phone: scrolling shows which page you're on, then it fades", async ({ page }) => {
  await open(page, (await fixtures()).long);
  const hint = page.locator(".pagehint");
  await page.locator(".viewer__scroll").evaluate((el) => el.scrollTo(0, el.scrollHeight * 0.46));
  await expect(hint).toHaveClass(/pagehint--shown/);
  await expect(hint).toHaveText(/^\d+ \/ 150$/);
  const n = Number((await hint.textContent())!.split("/")[0]);
  expect(n).toBeGreaterThan(50);
  expect(n).toBeLessThan(90);
  // A readout, never a target; and it goes once you stop.
  expect(await hint.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe("none");
  await expect(hint).not.toHaveClass(/pagehint--shown/, { timeout: 3000 });
});

test("phone: the ⋯ sheet's dim fades out with it", async ({ page }) => {
  await open(page, (await fixtures()).sample);
  await openMore(page);
  await page.mouse.click(195, 30);
  // The frame after closing: the sheet is sliding away over a fading dim.
  const ghosts = await page.evaluate(() => new Promise<{ list: number; scrim: number; bar: number }>((res) =>
    requestAnimationFrame(() => res({
      list: document.querySelectorAll(".menu__list.is-leaving").length,
      scrim: document.querySelectorAll(".menu__scrim.is-leaving").length,
      bar: Number(getComputedStyle(document.querySelector(".appbar")!).zIndex),
    }))));
  expect(ghosts.list).toBe(1);
  expect(ghosts.scrim).toBe(1);
  // …still above the toast (50) while it does.
  expect(ghosts.bar).toBeGreaterThan(50);
});

test("an 8-page document is “an 8-page document”", async ({ page }) => {
  const doc = await PDFDocument.create();
  for (let i = 0; i < 8; i++) doc.addPage([300, 400]);
  await page.goto("/");
  await page.setInputFiles("input[type=file]", { name: "eight.pdf", mimeType: "application/pdf", buffer: Buffer.from(await doc.save()) });
  await expect(page.locator(".snackbar")).toHaveText("Opened an 8-page document.", { timeout: 30_000 });
});
