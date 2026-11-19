import { expect, test, type Page } from "@playwright/test";
import { fixtures } from "./fixtures";
import { open } from "./helpers";

/**
 * Dark mode (10g).
 *
 * - A full-white page on the near-black surround was the brightest thing on a
 *   dark screen by far, and "Dim pages" was off unless you went looking for
 *   it. It now follows the theme until the person chooses: dim in dark, paper
 *   in light, and their choice — either way — holds in both. The old flag
 *   wrote its default ("0") on first run, so a stored "0" is not a choice; a
 *   stored "1" is.
 * - Every surface over the work is drawn from the dark tokens: no light
 *   panel, menu or dialog left behind from the light theme. The paper itself,
 *   the filled primary buttons and M3's inverse surfaces (tooltips, toasts)
 *   are light on purpose and are the only exceptions.
 */

const dimmed = (page: Page) => page.locator(".app--dim");

async function start(page: Page, theme: "light" | "dark" | "system", prefs: Record<string, string> = {}) {
  await page.addInitScript(
    ([t, p]) => {
      // Only on the first load: a reload must see what the app itself stored.
      if (sessionStorage.getItem("seeded")) return;
      sessionStorage.setItem("seeded", "1");
      localStorage.setItem("theme", t as string);
      for (const [k, v] of Object.entries(p as Record<string, string>)) localStorage.setItem(k, v);
    },
    [theme, prefs] as const,
  );
  await open(page, (await fixtures()).sample);
}

async function pickMenu(page: Page, label: string) {
  await page.locator('[aria-label="More actions"]').click();
  await page.locator('[role="menu"] [role^="menuitem"]', { hasText: label }).click();
  // Settings stay open to be flipped again; close it as a person would.
  if (await page.locator('[role="menu"]').count()) await page.keyboard.press("Escape");
  await expect(page.locator('[role="menu"]')).toHaveCount(0);
}

test.describe("dark mode", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 860 });
  });

  test("pages dim by themselves in dark, not in light", async ({ page }) => {
    await start(page, "dark");
    await expect(dimmed(page)).toHaveCount(1);
    // Switching theme takes the dim with it while no choice is made.
    await pickMenu(page, "Theme"); // dark → system (light here)
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await expect(dimmed(page)).toHaveCount(0);
  });

  test("the system theme counts: dark from the OS dims too", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await start(page, "system");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(dimmed(page)).toHaveCount(1);
  });

  test("a choice holds in either theme and survives a reload", async ({ page }) => {
    await start(page, "dark");
    await expect(dimmed(page)).toHaveCount(1);
    await pickMenu(page, "Dim pages"); // turned off, in dark
    await expect(dimmed(page)).toHaveCount(0);
    await page.reload();
    await page.setInputFiles("input[type=file]", (await fixtures()).sample);
    await page.waitForSelector(".page canvas");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(dimmed(page), "off stays off in dark").toHaveCount(0);
    // …and on, chosen in light, stays on there.
    await pickMenu(page, "Theme"); // dark → system (light)
    await pickMenu(page, "Dim pages");
    await expect(dimmed(page)).toHaveCount(1);
  });

  test("the old flag: its '1' was a choice, its '0' was a default", async ({ page }) => {
    await start(page, "light", { "pref.dimPages": "1" });
    await expect(dimmed(page), "chosen on, in light").toHaveCount(1);
  });

  test("an old stored '0' doesn't keep the glare in dark", async ({ page }) => {
    await start(page, "dark", { "pref.dimPages": "0" });
    await expect(dimmed(page)).toHaveCount(1);
  });

  test("menus, dialogs and panels are drawn from the dark tokens", async ({ page }) => {
    await start(page, "dark");
    const lightSurfaces = () =>
      page.evaluate(() => {
        const lum = (c: string) => {
          const m = c.match(/rgba?\(([^)]+)\)/);
          if (!m) return null;
          const [r, g, b, a = 1] = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
          if (a < 0.5) return null;
          const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
          return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
        };
        const css = getComputedStyle(document.documentElement);
        // Light by design: the primary fill and M3's inverse surface.
        const allowed = new Set(
          ["--primary", "--inverse-surface"].map((t) => {
            const probe = document.createElement("i");
            probe.style.color = css.getPropertyValue(t);
            document.body.append(probe);
            const v = getComputedStyle(probe).color;
            probe.remove();
            return v;
          }),
        );
        const out: string[] = [];
        for (const el of document.querySelectorAll<HTMLElement>("body *")) {
          // The paper, wherever it's shown, is white on purpose.
          if (el.closest(".page, .thumb, .pcard__thumb, .compare__page, .crop__page, svg, canvas, .skiplink, .is-leaving")) continue;
          const r = el.getBoundingClientRect();
          if (r.width < 8 || r.height < 8) continue;
          const cs = getComputedStyle(el);
          if (cs.visibility === "hidden" || +cs.opacity === 0) continue;
          if (allowed.has(cs.backgroundColor)) continue;
          const L = lum(cs.backgroundColor);
          if (L != null && L > 0.4) out.push(`${el.tagName.toLowerCase()}.${[...el.classList].join(".")} ${cs.backgroundColor}`);
        }
        return out;
      });

    expect(await lightSurfaces(), "the editor").toEqual([]);
    await page.locator('[aria-label="More actions"]').click();
    await expect(page.locator('[role="menu"]')).toBeVisible();
    expect(await lightSurfaces(), "the ⋯ menu").toEqual([]);
    await page.keyboard.press("Escape");
    // Every dialog the app opens over a document, reached the one way they all
    // share — the command palette — so none can be skipped.
    for (const label of [
      "Watermark",
      "Header & footer",
      "Hidden information",
      "Download with password",
      "Split into files",
      "Compress PDF",
      "Sign with certificate",
      "Crop pages",
    ]) {
      await page.keyboard.press("ControlOrMeta+k");
      await page.locator(".cmdk__input").fill(label);
      await expect(page.locator(".cmdk__item").first()).toContainText(label);
      await page.keyboard.press("Enter");
      await expect(page.locator('[role="dialog"]').first(), label).toBeVisible();
      await page.waitForTimeout(350); // past the opening motion
      expect(await lightSurfaces(), label).toEqual([]);
      await page.keyboard.press("Escape");
      await expect(page.locator('[role="dialog"]')).toHaveCount(0);
    }
    await page.keyboard.press("ControlOrMeta+k");
    await expect(page.locator(".cmdk")).toBeVisible();
    expect(await lightSurfaces(), "the command palette").toEqual([]);
  });
});
