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

test("opening a dialog changes nothing in it", async ({ page }) => {
  // Header & footer's chips type into the slot last focused, which starts as
  // Footer, centre. Opening on the first slot moved that to Header, left, so a
  // chip clicked straight away landed in the header.
  await open(page, (await fixtures()).sample);
  await fromPalette(page, "Header & footer");
  const d = page.getByRole("dialog", { name: "Finishing touches" });
  await expect(d.getByLabel("Footer, centre")).toBeFocused();
  const before = await d.getByLabel("Footer, centre").inputValue();
  await d.getByRole("button", { name: "File name" }).click();
  await expect(d.getByLabel("Header, left")).toHaveValue("");
  await expect(d.getByLabel("Footer, centre")).toHaveValue(`${before}{file}`);
  await page.keyboard.press("Escape");

  // Split with pages picked: its page-count box switches to "Every" on focus.
  // It opens on the choice made, and a screen reader hears that choice.
  await open(page, (await fixtures()).long);
  await fromMenu(page, /Organise pages/);
  const org = page.getByRole("dialog", { name: /Organi[sz]e/ });
  await expect(org).toBeVisible();
  await org.getByRole("button", { name: "Page 3", exact: true }).click();
  await org.getByRole("button", { name: "Split into files" }).click();
  const s = page.getByRole("dialog", { name: "Split into files" });
  await expect(s).toBeVisible();
  const radios = s.getByRole("radio");
  await expect(radios.nth(1)).toBeChecked();
  await expect(radios.nth(1)).toBeFocused();
  await expect(radios.nth(0)).not.toBeChecked();
});

test("a dialog opens on its work, not a setting under it", async ({ page }) => {
  // Sign's Draw tab has nowhere to type; "first field" found "Remember this
  // signature", below the pad, and Tab went from there to Cancel.
  await open(page, (await fixtures()).sample);
  await page.locator('.tooldock__btn[aria-label="Sign"]').click();
  const d = page.locator('[role="dialog"][aria-modal="true"]');
  await expect(d).toBeVisible();
  const f = await page.evaluate(() => {
    const a = document.activeElement as HTMLInputElement;
    return { tag: a.tagName, type: a.type ?? "", dialog: a.getAttribute("role") };
  });
  expect(f.type, JSON.stringify(f)).not.toBe("checkbox");
  expect(f.dialog, JSON.stringify(f)).toBe("dialog");
});

test("closing a dialog gives focus back to what opened it", async ({ page }) => {
  // A dialog whose field takes focus itself (Download with password's) was
  // recorded as its own opener: by the time the dialog looked, focus was
  // already inside. Closing handed focus to that field, now gone — the page.
  await open(page, (await fixtures()).sample);
  const caret = page.getByRole("button", { name: "Export options" });
  await caret.click();
  await page.getByRole("menuitem", { name: /Download with password/ }).click();
  const d = page.getByRole("dialog");
  await expect(d).toBeVisible();
  await expect(d.locator('input[type="password"]').first()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(d).toBeHidden();
  await expect(caret).toBeFocused();
});

test("a button at work keeps its colour, and its spinner shows", async ({ page }) => {
  await open(page, (await fixtures()).sample);
  // Hold the exporter back so the Download stays at work long enough to look at.
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route(/exporter-[^/]*\.js$/, async (route) => {
    await held;
    await route.continue();
  });
  const dl = page.locator(".appbar__download");
  const idle = await dl.evaluate((el) => getComputedStyle(el).backgroundColor);
  await dl.click();
  await expect(dl).toHaveAccessibleName("Exporting…");
  const busy = await page.evaluate(() => {
    const b = document.querySelector(".appbar__download")!;
    const sp = b.querySelector(".spinner")!;
    const caret = document.querySelector(".splitbtn__caret")!;
    const cs = getComputedStyle(sp);
    return {
      bg: getComputedStyle(b).backgroundColor,
      spinner: cs.borderTopColor || cs.color,
      caretBg: getComputedStyle(caret).backgroundColor,
      caretOpacity: getComputedStyle(caret).opacity,
    };
  });
  release();
  expect(busy.bg, "at work, not unavailable").toBe(idle);
  expect(busy.spinner, "the spinner stands out from its button").not.toBe(busy.bg);
  expect(busy.caretBg, "the caret reads as part of the same button").toBe(idle);
  expect(busy.caretOpacity).toBe("1");
});

test("walking up into a group of commands shows its heading", async ({ page }) => {
  await open(page, (await fixtures()).sample);
  await page.keyboard.press("Control+k");
  const list = page.locator(".cmdk__list");
  await expect(list).toBeVisible();
  const n = await list.getByRole("option").count();
  for (let i = 0; i < n; i++) await page.keyboard.press("ArrowDown");
  for (let i = 0; i < n; i++) await page.keyboard.press("ArrowUp");
  const gap = await list.evaluate((l) => {
    const h = l.querySelector(".cmdk__heading")!;
    return h.getBoundingClientRect().top - l.getBoundingClientRect().top;
  });
  expect(gap, "the first heading is in view").toBeGreaterThanOrEqual(0);
  // The active row is announced from the search box.
  const input = page.getByRole("combobox", { name: "Search commands" });
  const id = await input.getAttribute("aria-activedescendant");
  expect(id).toBeTruthy();
  await expect(page.locator(`[id="${id}"]`)).toHaveAttribute("aria-selected", "true");
});

test.describe("with a finger", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test("a dialog doesn't raise the keyboard before it's begun", async ({ page }) => {
    await open(page, (await fixtures()).sample);
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
    await fromPalette(page, "Watermark");
    const d = page.getByRole("dialog", { name: "Finishing touches" });
    await expect(d).toBeVisible();
    const tag = await page.evaluate(() => {
      const a = document.activeElement as HTMLInputElement;
      return `${a.tagName}${a.type ? `:${a.type}` : ""}`;
    });
    expect(["INPUT:text", "TEXTAREA"]).not.toContain(tag);
  });
});
