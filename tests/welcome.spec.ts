import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { fixtures } from "./fixtures";
import { docRecord, seedStore } from "./helpers";

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

interface Drag {
  /** Where the event fires (default: the welcome's middle). */
  at?: string;
  related?: string;
  /** A file the drag carries; without one, it carries text (a selection). */
  file?: { name: string; b64: string };
}
const PDF = { name: "sample.pdf", b64: "" };

/** Two frames: long enough for a state change from the last event to paint. */
const settle = (page: Page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

async function drag(page: Page, type: "dragover" | "dragleave" | "drop", o: Drag = {}) {
  await page.evaluate(
    ([type, at, related, file]) => {
      const dt = new DataTransfer();
      if (file) {
        const bytes = Uint8Array.from(atob(file.b64), (c) => c.charCodeAt(0));
        dt.items.add(new File([bytes], file.name, { type: "application/pdf" }));
      } else dt.setData("text/plain", "a selection");
      document.querySelector(at)!.dispatchEvent(
        new DragEvent(type, {
          bubbles: true,
          cancelable: true,
          dataTransfer: dt,
          relatedTarget: related ? document.querySelector(related) : null,
        }),
      );
    },
    [type, o.at ?? ".dropzone__card h1", o.related ?? null, o.file ?? null] as const,
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
  const file = { ...PDF, b64: (await readFile((await fixtures()).sample)).toString("base64") };
  const drop = page.locator(".dropzone__drop");
  await expect(drop).toHaveCount(0);
  await drag(page, "dragover", { file });
  await expect(drop).toBeVisible();
  await expect(drop).toHaveText(/drop to open/i);
  // Crossing onto the welcome's own text is still over the window.
  await drag(page, "dragleave", { at: ".dropzone", related: ".dropzone__card h1", file });
  await expect(drop).toBeVisible();
  await drag(page, "dragleave", { at: ".dropzone", file });
  await expect(drop).toHaveCount(0);
  // The whole window: the app bar takes it too, and the surface covers it.
  await drag(page, "dragover", { at: ".appbar", file });
  await expect(drop).toBeVisible();
  const [bar, surface] = await Promise.all([page.locator(".appbar").boundingBox(), drop.boundingBox()]);
  expect(surface!.y).toBeLessThan(bar!.y + bar!.height);
  await drag(page, "drop", { at: ".appbar", file });
  await expect(page.locator(".page__overlay").first()).toBeVisible({ timeout: 15_000 });
});

test("dragging text over the welcome isn't an offer to open it", async ({ page }) => {
  await page.goto("/");
  await drag(page, "dragover");
  await settle(page);
  await expect(page.locator(".dropzone__drop")).toHaveCount(0);
});

test("the button says photos open too, and isn't an upload", async ({ page }) => {
  await page.goto("/");
  const btn = page.getByRole("button", { name: "Choose PDF or photos" });
  await expect(btn).toBeVisible();
  // The upload arrow sat right under "No uploads".
  await expect(btn.locator("svg")).toHaveClass(/\blucide\b/);
  await expect(btn.locator("svg")).not.toHaveClass(/lucide-upload\b/);
});

test("while a dialog is open, a file over the window isn't offered a drop", async ({ page }) => {
  await page.goto("/");
  const f = await fixtures();
  const locked = { name: "locked.pdf", b64: (await readFile(f.locked)).toString("base64") };
  await drag(page, "dragover", { file: locked });
  await drag(page, "drop", { file: locked });
  await expect(page.getByRole("dialog")).toBeVisible();
  const sample = { ...PDF, b64: (await readFile(f.sample)).toString("base64") };
  await drag(page, "dragover", { at: ".appbar", file: sample });
  await settle(page);
  await expect(page.locator(".dropzone__drop")).toHaveCount(0);
});

test("opening and failing are announced by live regions that were already there", async ({ page }) => {
  await page.goto("/");
  // Present, and empty, before anything happens: inserted with text, a region
  // often isn't read out.
  const alert = page.locator(".app [role=alert]");
  await expect(alert).toHaveCount(1);
  await expect(alert).toHaveText("");
  await expect(page.locator(".app [role=status]")).toHaveCount(1);
  await drag(page, "drop", { file: { name: "notes.pdf", b64: Buffer.from("not a pdf at all").toString("base64") } });
  await expect(alert).not.toHaveText("", { timeout: 15_000 });
  // Shown, but not read twice.
  await expect(page.locator(".dropzone__err")).toBeVisible();
  await expect(page.locator(".dropzone__err")).toHaveAttribute("aria-hidden", "true");
});

test("over an open document, a file is offered a new tab, but not behind a dialog", async ({ page }) => {
  await page.goto("/");
  const file = { ...PDF, b64: (await readFile((await fixtures()).sample)).toString("base64") };
  await drag(page, "drop", { file });
  await expect(page.locator(".page__overlay").first()).toBeVisible({ timeout: 15_000 });
  await drag(page, "dragover", { at: ".appbar", file });
  await expect(page.locator(".dropveil")).toBeVisible();
  await drag(page, "dragleave", { at: ".appbar", file });
  await expect(page.locator(".dropveil")).toHaveCount(0);
  await page.keyboard.press("Control+k");
  await expect(page.locator("[aria-modal=true]")).toBeVisible();
  const effect = await page.evaluate((b64) => {
    const dt = new DataTransfer();
    dt.items.add(new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], "x.pdf", { type: "application/pdf" }));
    const ev = new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt });
    document.querySelector(".appbar")!.dispatchEvent(ev);
    return { effect: dt.dropEffect, cancelled: ev.defaultPrevented };
  }, file.b64);
  // Cancelled, so the browser doesn't open the file itself; "none", so it says no.
  expect(effect).toEqual({ effect: "none", cancelled: true });
  await settle(page);
  await expect(page.locator(".dropveil")).toHaveCount(0);
});

test("a cut-short file name shows whole on hover; one that fits gets no tooltip", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  const sample = (await fixtures()).sample;
  const hover = async (name: string) => {
    await seedStore(page, [["doc:a", docRecord("a", name, 0)]], [["bytes:a", sample]]);
    await page.reload();
    await page.mouse.move(0, 0);
    await page.locator(".restore-banner__files").hover();
    await page.waitForTimeout(900);
  };
  // Short in characters, wide in letters: cut on a desktop banner.
  await hover("WWWWWWWWWWWWWWWWWWWW.pdf");
  await expect(page.getByRole("tooltip")).toHaveText("WWWWWWWWWWWWWWWWWWWW.pdf");
  await hover("notes.pdf");
  await expect(page.getByRole("tooltip")).toHaveCount(0);
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test("nothing asks a finger to drag, and no line ends on one word", async ({ page }) => {
    await page.goto("/");
    await expect(card(page)).toBeVisible();
    await expect(card(page)).not.toContainText(/drag|drop/i);
    expect(await orphans(page)).toEqual([]);
    const box = (await page.getByRole("button", { name: "Choose PDF or photos" }).boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);
  });

  test("the restore offer fits the phone; nothing scrolls sideways", async ({ page }) => {
    await page.goto("/");
    await seedStore(page, [["doc:a", docRecord("a", "a-rather-long-file-name-for-a-phone.pdf", 0)]], [["bytes:a", (await fixtures()).sample]]);
    await page.reload();
    await expect(page.locator(".restore-banner")).toBeVisible();
    const over = await page.locator(".dropzone").evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(over).toBeLessThanOrEqual(0);
    const boxes = [];
    for (const name of ["Restore", "Not now", "Delete"]) {
      const b = (await page.locator(".restore-banner").getByRole("button", { name }).boundingBox())!;
      expect(b.x + b.width, name).toBeLessThanOrEqual(390);
      boxes.push(b);
    }
    // The three choices stay together on one row, not Restore by the text and
    // the other two below it.
    expect(new Set(boxes.map((b) => Math.round(b.y))).size).toBe(1);
  });
});

test.describe("on the smallest phone", () => {
  test.use({ viewport: { width: 320, height: 640 }, hasTouch: true, isMobile: true });
  test("the restore offer's three choices still share one row", async ({ page }) => {
    await page.goto("/");
    await seedStore(page, [["doc:a", docRecord("a", "a-rather-long-file-name-for-a-phone.pdf", 0)]], [["bytes:a", (await fixtures()).sample]]);
    await page.reload();
    await expect(page.locator(".restore-banner")).toBeVisible();
    const ys = [];
    for (const name of ["Restore", "Not now", "Delete"]) {
      const b = (await page.locator(".restore-banner").getByRole("button", { name }).boundingBox())!;
      expect(b.x + b.width, name).toBeLessThanOrEqual(320);
      ys.push(Math.round(b.y));
    }
    expect(new Set(ys).size).toBe(1);
  });
});
