import { test, expect, type Page } from "@playwright/test";
import { fixtures } from "./fixtures";
import { open, watch } from "./helpers";

// A phone viewport with touch. Set at the top level rather than inside a
// describe: Playwright forbids per-group options that would force a new worker.
test.use({
  viewport: { width: 393, height: 851 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  colorScheme: "dark",
});

/** Rects of two selectors, and whether they overlap. */
function collision(page: Page, a: string, b: string) {
  return page.evaluate(
    ([selA, selB]) => {
      const rect = (sel: string) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      };
      const ra = rect(selA);
      const rb = rect(selB);
      if (!ra || !rb) return { present: false, overlap: false };
      const overlap = !(
        ra.x + ra.w <= rb.x ||
        rb.x + rb.w <= ra.x ||
        ra.y + ra.h <= rb.y ||
        rb.y + rb.h <= ra.y
      );
      return { present: true, overlap, ra, rb };
    },
    [a, b],
  );
}

test("phone: floating surfaces do not overlap each other", async ({ page }) => {
  const w = watch(page);
  await open(page, (await fixtures()).sample);

  // The status snackbar is top-anchored on phones (the bottom edge belongs to the
  // tool dock) and spans most of the width; the zoom pill is pinned top-right in
  // the same band, so the two collided and the zoom percentage became unreadable
  // whenever a status message showed.
  const vsZoom = await collision(page, ".snackbar", ".zoombar");
  expect(vsZoom.present, "both the snackbar and the zoom pill are showing").toBe(true);
  expect(
    vsZoom.overlap,
    `snackbar ${JSON.stringify(vsZoom.ra)} vs zoom ${JSON.stringify(vsZoom.rb)}`,
  ).toBe(false);

  const vsDock = await collision(page, ".snackbar", ".tooldock");
  expect(vsDock.overlap).toBe(false);

  expect(w.errors, `errors: ${w.errors.slice(0, 3).join(" | ")}`).toEqual([]);
});

test("phone: every ⋯ menu item takes its own tap (the zoom pill doesn't cover the first)", async ({ page }) => {
  await open(page, (await fixtures()).sample);
  await page.getByRole("button", { name: "More actions" }).click();
  const items = page.getByRole("menuitem");
  const n = await items.count();
  expect(n).toBeGreaterThan(3);
  for (let i = 0; i < n; i++) {
    const hit = await items.nth(i).evaluate((el) => {
      el.scrollIntoView({ block: "nearest" });
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return el.contains(top) ? "ok" : `${el.textContent} covered by ${top?.className}`;
    });
    expect(hit).toBe("ok");
  }
});

test("phone: the draw options fit the screen with every control reachable", async ({ page }) => {
  await open(page, (await fixtures()).sample);
  await page.locator('.tooldock__btn[aria-label="Draw"]').click();
  const bar = page.locator(".drawbar");
  await expect(bar).toBeVisible();
  const subtools = page.locator(".drawbar__tools button");
  const n = await subtools.count();
  expect(n).toBeGreaterThan(5);
  // The narrowest phones are where it overflowed, and stroke tools (with the
  // width slider) are wider than highlight/note — check every pair.
  for (const width of [320, 360, 393]) {
    await page.setViewportSize({ width, height: 851 });
    for (let i = 0; i < n; i++) {
      await subtools.nth(i).click(); // picking folds the bar away…
      await page.locator(".drawbar__handle").click(); // …so open it again
      const geo = await bar.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const out = Array.from(el.querySelectorAll<HTMLElement>("button, input"))
          .filter((c) => {
            const b = c.getBoundingClientRect();
            if (b.width === 0) return false;
            return b.left < 0 || b.right > window.innerWidth || b.left < r.left - 1 || b.right > r.right + 1;
          })
          .map((c) => c.getAttribute("aria-label") ?? c.className);
        return { sw: el.scrollWidth, cw: el.clientWidth, right: r.right, vw: window.innerWidth, out };
      });
      const where = `${width}px, sub-tool ${i}`;
      expect(geo.sw, where).toBeLessThanOrEqual(geo.cw + 1);
      expect(geo.right, where).toBeLessThanOrEqual(geo.vw);
      expect(geo.out, where).toEqual([]);
    }
  }
  // Sub-tool buttons keep a full touch target.
  const b = (await page.locator("#drawbar .icon-btn").first().boundingBox())!;
  expect(b.height).toBeGreaterThanOrEqual(44);
});

test("phone: the icon-only Download button has an accessible name", async ({ page }) => {
  await open(page, (await fixtures()).sample);
  await expect(page.getByRole("button", { name: "Download", exact: true })).toBeVisible();
});

/** Type a signature and arm it for placement (the phone's Sign tool). */
async function armSignature(page: Page) {
  await page.getByRole("button", { name: /^Sign/ }).first().click();
  await page.getByRole("button", { name: "Type", exact: true }).click();
  await page.getByPlaceholder("Type your name").fill("Jo Smith");
  await page.getByRole("button", { name: "Add", exact: true }).click();
}

/** A one-finger swipe through CDP — Playwright's touchscreen only taps. */
async function swipe(page: Page, x: number, y0: number, y1: number) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: y0 }] });
  for (let i = 1; i <= 10; i++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y0 + ((y1 - y0) * i) / 10 }] });
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

test("phone: while a signature waits to be placed, a swipe scrolls and a tap places", async ({ page }) => {
  await open(page, (await fixtures()).sample);
  await armSignature(page);
  await expect(page.locator(".placelayer").first()).toBeAttached();
  const scroll = page.locator(".viewer__scroll");
  const top0 = await scroll.evaluate((el) => el.scrollTop);
  // Swiping is how you get to the page the signature belongs on.
  await swipe(page, 200, 600, 300);
  await expect.poll(() => scroll.evaluate((el) => el.scrollTop)).toBeGreaterThan(top0 + 100);
  await expect(page.locator(".stamp")).toHaveCount(0);
  await page.touchscreen.tap(200, 400);
  await expect(page.locator(".stamp")).toHaveCount(1);
});

test("phone: Go to page… works with something selected (the pill is hidden then)", async ({ page }) => {
  await open(page, (await fixtures()).sample);
  await page.locator(".fragment").nth(2).tap();
  await expect(page.locator(".zoombar")).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type("go to page");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("textbox", { name: /Go to page/ })).toBeFocused();
});

test("phone: arrow keys on a text fragment don't nudge a selected stamp", async ({ page }) => {
  await open(page, (await fixtures()).sample);
  await armSignature(page);
  await page.touchscreen.tap(200, 400);
  const stamp = page.locator(".stamp");
  await expect(stamp).toHaveCount(1);
  await stamp.tap();
  const before = (await stamp.boundingBox())!;
  await page.locator(".fragment").first().focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowRight");
  const after = (await stamp.boundingBox())!;
  expect(after.x).toBeCloseTo(before.x, 0);
});
