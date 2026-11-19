import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { fixtures } from "./fixtures";

/**
 * The first screen: a welcome, not a form field (slice 10e).
 *
 * - It was a dashed box — the look of an upload field — with the privacy
 *   promise in the small print. Now nothing frames it at rest, and the promise
 *   is the headline.
 * - It said how to use it in a paragraph and two hint lines, one of which told
 *   a phone to "drag & drop". Few words now: a headline, one short line, the
 *   button. Dropping a file needs no sentence: the window shows where it lands
 *   while one is over it.
 * - Its lines wrapped one word onto a line of their own.
 */

const card = (page: Page) => page.locator(".dropzone__card");

/** Every line of text in the welcome holds more than one word. */
async function orphans(page: Page) {
  return card(page).evaluate((root) => {
    const bad: string[] = [];
    for (const el of root.querySelectorAll<HTMLElement>("h1, p")) {
      const tops: number[] = [];
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const text = n.textContent ?? "";
        for (const m of text.matchAll(/\S+/g)) {
          const r = document.createRange();
          r.setStart(n, m.index!);
          r.setEnd(n, m.index! + m[0].length);
          tops.push(Math.round(r.getBoundingClientRect().top));
        }
      }
      const last = tops[tops.length - 1];
      if (tops.length > 1 && tops.filter((t) => Math.abs(t - last) < 3).length < 2) bad.push(el.textContent!.trim());
    }
    return bad;
  });
}

async function drag(page: Page, type: "dragover" | "dragleave" | "drop", related?: string, file?: { name: string; b64: string }) {
  await page.evaluate(
    ([type, related, file]) => {
      const dt = new DataTransfer();
      if (file) {
        const bytes = Uint8Array.from(atob(file.b64), (c) => c.charCodeAt(0));
        dt.items.add(new File([bytes], file.name, { type: "application/pdf" }));
      }
      const target = document.querySelector(".dropzone")!;
      target.dispatchEvent(
        new DragEvent(type, {
          bubbles: true,
          cancelable: true,
          dataTransfer: dt,
          relatedTarget: related ? document.querySelector(related) : null,
        }),
      );
    },
    [type, related ?? null, file ?? null] as const,
  );
}

test("the welcome leads with the promise, in few words, with no box round it", async ({ page }) => {
  await page.goto("/");
  await expect(card(page)).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/stay on this device/i);
  const look = await card(page).evaluate((el) => {
    const s = getComputedStyle(el);
    return { border: s.borderTopStyle, bg: s.backgroundColor };
  });
  expect(look.border).not.toBe("dashed");
  expect(look.bg).toBe("rgba(0, 0, 0, 0)");
  const words = ((await card(page).innerText()).match(/\S+/g) ?? []).length;
  expect(words, "the welcome should read at a glance").toBeLessThanOrEqual(14);
  await expect(page.getByRole("button", { name: "Choose PDF" })).toBeVisible();
  expect(await orphans(page)).toEqual([]);
});

test("a file over the window shows where it will land, and dropping opens it", async ({ page }) => {
  await page.goto("/");
  const drop = page.locator(".dropzone__drop");
  await expect(drop).toHaveCount(0);
  await drag(page, "dragover");
  await expect(drop).toBeVisible();
  await expect(drop).toHaveText(/drop to open/i);
  // Crossing onto the welcome's own text is still over the window.
  await drag(page, "dragleave", ".dropzone__card h1");
  await expect(drop).toBeVisible();
  await drag(page, "dragleave");
  await expect(drop).toHaveCount(0);
  await drag(page, "dragover");
  const b64 = (await readFile((await fixtures()).sample)).toString("base64");
  await drag(page, "drop", undefined, { name: "sample.pdf", b64 });
  await expect(page.locator(".page__overlay").first()).toBeVisible({ timeout: 15_000 });
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test("nothing asks a finger to drag, and no line ends on one word", async ({ page }) => {
    await page.goto("/");
    await expect(card(page)).toBeVisible();
    await expect(card(page)).not.toContainText(/drag|drop/i);
    expect(await orphans(page)).toEqual([]);
    const box = (await page.getByRole("button", { name: "Choose PDF" }).boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);
  });
});
