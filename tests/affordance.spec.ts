import { expect, test } from "@playwright/test";
import { fixtures } from "./fixtures";
import { expectClean, open, watch } from "./helpers";

/**
 * "This opens something."
 *
 * The failure this guards against isn't a missing chevron, it's a *drifting*
 * one. The ⋯ menu, the Export menu and the command palette all list the same
 * command registry, and they have already drifted apart once — the palette carried
 * a hand-written copy of the tool list that no longer matched. So the assertion
 * worth making is not "Watermark has a mark" but "every surface marks exactly
 * the same set", which fails the moment someone adds an action and only wires
 * some of them.
 *
 * The visual mark is decorative; `aria-haspopup` / `aria-expanded` is what
 * actually reaches assistive tech, so both are checked.
 */

/** The labels a surface marks as opening something. */
const marked = (rows: Element[]) =>
  rows
    .filter((r) => r.querySelector(".opens-mark"))
    // The label, not the whole row: a row can also show its shortcut.
    .map((r) => (r.querySelector(".menu__itemlabel, .cmdk__label")?.textContent ?? r.textContent ?? "").trim())
    .sort();

test("the ⋯ menu, the Export menu and the palette mark the same actions", async ({ page }) => {
  const w = watch(page);
  const f = await fixtures();
  await open(page, f.sample);

  await page.click('[aria-label="More actions"]');
  const menu = await page.locator(".menu__item").evaluateAll(marked);
  await page.keyboard.press("Escape");
  expect(menu, "the ⋯ menu marks what opens a dialog").toEqual(["Add image", "Crop pages", "Hidden information", "Organise pages", "Page numbers", "Redact patterns", "Search commands", "Watermark"]);
  // "Search commands" is the palette itself, which doesn't list itself.
  const panel = menu.filter((l) => l !== "Search commands");

  // The Export menu (Download's caret) marks its own the same way.
  await page.click('[aria-label="Export options"]');
  const exporting = await page.locator('[role="menu"][aria-label="Export"] .menu__item').evaluateAll(marked);
  await page.keyboard.press("Escape");
  expect(exporting).toEqual(["Compress PDF", "Download with password", "Sign with certificate", "Split into files"]);

  // The palette holds every command, not just these, and only renders the rows
  // matching the query — so it is searched one label at a time rather than
  // listed. Comparing its unfiltered rows is what made the first version of
  // this test fail on an action that was marked correctly but scrolled off.
  await page.keyboard.press("Control+k");
  await expect(page.locator(".cmdk")).toBeVisible();
  for (const label of [...panel, ...exporting]) {
    await page.fill(".cmdk input", label);
    const row = page.locator(".cmdk__item", { hasText: label }).first();
    await expect(row.locator(".opens-mark"), `palette marks "${label}"`).toHaveCount(1);
  }
  await page.fill(".cmdk input", "Copy all text");
  await expect(
    page.locator(".cmdk__item", { hasText: "Copy all text" }).first().locator(".opens-mark"),
    "and leaves the immediate ones unmarked",
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  expectClean(w);
});

test("an action that acts immediately carries no mark", async ({ page }) => {
  const w = watch(page);
  const f = await fixtures();
  await open(page, f.sample);

  const item = (label: string) => page.locator(".menu__item", { hasText: label });

  // Opens a dialog.
  await page.click('[aria-label="More actions"]');
  await expect(item("Page numbers").locator(".opens-mark")).toHaveCount(1);
  await expect(item("Page numbers")).toHaveAttribute("aria-haspopup", "dialog");
  // Runs there and then.
  await expect(item("Copy all text").locator(".opens-mark")).toHaveCount(0);
  await expect(item("Copy all text")).not.toHaveAttribute("aria-haspopup", /.*/);
  await page.keyboard.press("Escape");
  await page.click('[aria-label="Export options"]');
  await expect(item("Compress PDF").locator(".opens-mark")).toHaveCount(1);
  await expect(item("Compress PDF")).toHaveAttribute("aria-haspopup", "dialog");
  // Runs there and then. A mark here would promise a dialog that never comes,
  // which is worse than no mark at all.
  await expect(item("Export as images").locator(".opens-mark")).toHaveCount(0);
  await page.keyboard.press("Escape");
  // The Inspector's document settings mark their dialogs too.
  const add = page.getByRole("button", { name: "Add page numbers" });
  await expect(add.locator(".opens-mark")).toHaveCount(1);
  await expect(add).toHaveAttribute("aria-haspopup", "dialog");
  expectClean(w);
});

test("a tool that opens something says so, and says which kind", async ({ page }) => {
  const w = watch(page);
  const f = await fixtures();
  await open(page, f.sample);

  const tool = (label: string) => page.locator(`.tooldock__btn[aria-label="${label}"]`);

  // Draw discloses a toolbar it owns — a disclosure, not a popup. The state is
  // always declared; the *reference* only exists while the thing it names does,
  // the same rule the page-rail toggle follows (an `aria-controls` pointing at
  // an unmounted id is a dangling reference).
  await expect(tool("Draw")).toHaveClass(/tooldock__btn--opens/);
  await expect(tool("Draw")).toHaveAttribute("aria-expanded", "false");
  await expect(tool("Draw")).not.toHaveAttribute("aria-controls", "drawbar");
  await tool("Draw").click();
  await expect(tool("Draw")).toHaveAttribute("aria-expanded", "true");
  await expect(tool("Draw")).toHaveAttribute("aria-controls", "drawbar");
  await expect(page.locator("#drawbar")).toBeVisible();

  // Sign opens a dialog — a different relationship, a different attribute.
  await expect(tool("Sign")).toHaveAttribute("aria-haspopup", "dialog");
  await expect(tool("Sign")).not.toHaveAttribute("aria-expanded", /.*/);

  // A tool that just does its thing is left alone.
  await expect(tool("Select")).not.toHaveClass(/tooldock__btn--opens/);
  await expect(tool("Redact")).not.toHaveClass(/tooldock__btn--opens/);

  // The corner notch is drawn, not imagined.
  const notch = await tool("Draw").evaluate(
    (el) => getComputedStyle(el, "::after").borderBottomWidth,
  );
  expect(notch, "the corner marker actually renders").not.toBe("0px");
  expectClean(w);
});
