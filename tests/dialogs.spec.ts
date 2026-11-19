import { test, expect, type Page } from "@playwright/test";
import { fixtures } from "./fixtures";
import { open, watch } from "./helpers";

/**
 * Dialogs open where the work starts, and say what they are.
 *
 * - A dialog put focus on its first focusable, which is Close (it leads the
 *   markup): opened from the keyboard — the palette, a shortcut — the first
 *   thing it showed was a ring round "close", and Enter closed it. Focus goes to
 *   the first field, to a control marked for it (the crop frame), or else the
 *   dialog itself, never to Close.
 * - Titles were plain text at 16 or 22px. They are headings, at one size.
 * - A disabled primary button was the button at 55% opacity, the page showing
 *   through: washed out, not waiting.
 * - The command palette's right-hand column held shortcut keys (V, Ctrl+D) and,
 *   where a command had none, its category (Draw), as if they were one kind of
 *   thing. Categories are headings over their rows; the column is keys alone.
 */

async function fromMenu(page: Page, name: RegExp) {
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name }).click();
}

async function fromPalette(page: Page, query: string) {
  await page.keyboard.press("Control+k");
  await page.locator(".cmdk__input").fill(query);
  await page.keyboard.press("Enter");
}

const focused = (page: Page) =>
  page.evaluate(() => {
    const a = document.activeElement as HTMLElement | null;
    return {
      tag: a?.tagName ?? "",
      label: a?.getAttribute("aria-label") ?? "",
      role: a?.getAttribute("role") ?? "",
      ring: a ? getComputedStyle(a).outlineStyle !== "none" && a.matches(":focus-visible") : false,
    };
  });

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
});

test("a dialog opens on its first field, by mouse or by keyboard, never on Close", async ({ page }) => {
  const w = watch(page);
  await open(page, (await fixtures()).sample);

  // By mouse.
  await fromMenu(page, /^Watermark/);
  const d = page.getByRole("dialog", { name: "Finishing touches" });
  await expect(d).toBeVisible();
  await expect(d.getByLabel("Text")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(d).toBeHidden();

  // By keyboard: the palette, then Enter. A ring is right here — on the field.
  await fromPalette(page, "Header & footer");
  await expect(d).toBeVisible();
  const f = await focused(page);
  expect(f.tag, `focus on ${JSON.stringify(f)}`).toBe("INPUT");
  expect(f.label).not.toBe("Close");
  // And a stray Enter doesn't close the dialog it just opened.
  await page.keyboard.press("Enter");
  await expect(d).toBeVisible();
  expect(w.errors).toEqual([]);
});

test("a dialog with no field takes focus itself, with no ring round the box", async ({ page }) => {
  await open(page, (await fixtures()).sample);
  await fromPalette(page, "Hidden information");
  const d = page.getByRole("dialog", { name: "Hidden information" });
  await expect(d).toBeVisible();
  await expect(d).toBeFocused();
  expect(await d.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe("none");
  // Tab goes on into it.
  await page.keyboard.press("Tab");
  expect(await d.evaluate((el) => el.contains(document.activeElement) && el !== document.activeElement)).toBe(true);
});

test("Crop opens on its frame", async ({ page }) => {
  await open(page, (await fixtures()).sample);
  await fromMenu(page, /^Crop pages/);
  await expect(page.getByRole("group", { name: "Crop frame" })).toBeFocused();
});

test("dialog titles are headings, at one size", async ({ page }) => {
  await open(page, (await fixtures()).sample);
  const sizes: number[] = [];
  for (const [open, name] of [
    [() => fromMenu(page, /^Watermark/), "Finishing touches"],
    [() => fromPalette(page, "Hidden information"), "Hidden information"],
    [() => fromPalette(page, "Compress"), "Compress PDF"],
  ] as const) {
    await open();
    const d = page.getByRole("dialog", { name });
    await expect(d).toBeVisible();
    const h = d.getByRole("heading", { level: 2, name });
    await expect(h).toBeVisible();
    sizes.push(await h.evaluate((el) => parseFloat(getComputedStyle(el).fontSize)));
    await page.keyboard.press("Escape");
    await expect(d).toBeHidden();
  }
  for (const s of sizes) expect(s, `title sizes ${sizes}`).toBe(24);
});

test("a disabled primary button waits, rather than fading", async ({ page }) => {
  await open(page, (await fixtures()).sample);
  await page.click('[aria-label="Export options"]');
  await page.getByRole("menuitem", { name: /Split into files/ }).click();
  const d = page.getByRole("dialog", { name: "Split into files" });
  await d.getByLabel("Pages per file").fill("");
  const go = d.locator(".dialog__actions .btn--filled");
  await expect(go).toBeDisabled();
  const off = await go.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { opacity: cs.opacity, bg: cs.backgroundColor, color: cs.color };
  });
  expect(off.opacity, "not the button faded").toBe("1");
  await d.getByLabel("Pages per file").fill("6");
  await expect(go).toBeEnabled();
  const on = await go.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(off.bg, "not the primary colour, thinned").not.toBe(on);
  // A neutral fill: no hue of its own (r, g and b close together).
  const [r, g, b] = off.bg.match(/[\d.]+/g)!.map(Number);
  expect(Math.max(r, g, b) - Math.min(r, g, b), off.bg).toBeLessThan(24);
});

test("the palette files commands under headings and keeps its right column for keys", async ({ page }) => {
  await open(page, (await fixtures()).sample);
  await page.keyboard.press("Control+k");
  const list = page.locator(".cmdk__list");
  await expect(list).toBeVisible();
  const hints = await list.locator(".cmdk__hint").allInnerTexts();
  expect(hints.length).toBeGreaterThan(3);
  // Keys: a single key, or modifiers joined to one. Never a word like "Draw".
  for (const h of hints) expect(h, `"${h}" in the key column`).toMatch(/^((Ctrl|Shift|Alt|⌘)\+)*([A-Z0-9]|Del|Esc|Enter|Tab|F\d+|[+\-=?\/\[\]]|Arrow\w+|Page\w+|Home|End|Space|Backspace)$/);
  // Each group under a heading, the rows of a group together.
  const groups = await list.locator('[role="group"]').evaluateAll((gs) =>
    gs.map((g) => ({
      heading: g.querySelector(".cmdk__heading")?.textContent ?? "",
      rows: [...g.querySelectorAll(".cmdk__item")].map((r) => r.getAttribute("data-group")),
    })),
  );
  expect(groups.length).toBeGreaterThan(3);
  const seen = new Set<string>();
  for (const g of groups) {
    expect(g.heading).not.toBe("");
    expect(new Set(g.rows).size, `one group per heading: ${g.heading}`).toBe(1);
    expect(seen.has(g.rows[0]!), `${g.heading} appears once`).toBe(false);
    seen.add(g.rows[0]!);
  }
  // Arrows walk the rows in the order shown.
  const rows = list.locator(".cmdk__item");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(rows.nth(2)).toHaveAttribute("aria-selected", "true");
  // Filtering keeps the headings.
  await page.locator(".cmdk__input").fill("zoom");
  await expect(list.locator(".cmdk__heading").first()).toBeVisible();
});
