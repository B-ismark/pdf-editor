import { test, expect, type Page } from "@playwright/test";
import { fixtures } from "./fixtures";
import { dragOnPage, open, pickSubTool, pickTool, watch } from "./helpers";

/**
 * The chrome's hierarchy: what is the frame, what is a heading, what is a
 * control.
 *
 * - The app bar and the tab strip were two tinted bars with a rule between
 *   them. They are one surface, the tabs its lower row.
 * - The ⋯ menu's group labels were set in capitals at body size, louder than
 *   the items they head (the small label style they named was never defined),
 *   and nothing said the menu scrolled past the window's foot.
 * - The Inspector set some labels above their controls and some beside them,
 *   with controls pushed to either edge, a bold number in "Size 24", a
 *   centred "Reset style", and its group headings in tracked capitals.
 * - On a phone the filled Download chip stood taller than ⋯ beside it.
 */

const style = (page: Page, sel: string, props: string[]) =>
  page.locator(sel).first().evaluate((el, props) => {
    const cs = getComputedStyle(el);
    return Object.fromEntries(props.map((p) => [p, cs.getPropertyValue(p)]));
  }, props);

test("the app bar and the tab strip are one surface", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const w = watch(page);
  const f = await fixtures();
  await open(page, f.sample);
  await expect(page.locator(".doctabs")).toBeVisible();
  const bar = await style(page, ".appbar", ["background-color", "border-bottom-width", "border-bottom-color"]);
  const strip = await style(page, ".doctabs", ["background-color"]);
  expect(strip["background-color"]).toBe(bar["background-color"]);
  // No rule between them: none drawn, or one drawn in no colour.
  const ruled = bar["border-bottom-width"] !== "0px" && !/rgba\(.*,\s*0\)|transparent/.test(bar["border-bottom-color"]);
  expect(ruled, `app bar's bottom rule ${JSON.stringify(bar)}`).toBe(false);
  // And they touch: no gap of the workspace between them.
  const a = (await page.locator(".appbar").boundingBox())!;
  const t = (await page.locator(".doctabs").boundingBox())!;
  expect(Math.abs(a.y + a.height - t.y)).toBeLessThan(1);
  expect(w.errors).toEqual([]);
});

test("the ⋯ menu's group labels are quieter than its items, and it says when it scrolls", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 640 });
  await open(page, (await fixtures()).sample);
  await page.locator(".appbar__more").click();
  const list = page.locator(".menu__list").first();
  await expect(list).toBeVisible();
  const label = await style(page, ".menu__label", ["font-size", "text-transform", "font-weight"]);
  const item = await style(page, ".menu__list .menu__item", ["font-size"]);
  expect(parseFloat(label["font-size"]), `label ${label["font-size"]} vs item ${item["font-size"]}`).toBeLessThan(
    parseFloat(item["font-size"]),
  );
  expect(label["text-transform"]).toBe("none");

  // It fits the window, and what's below the fold is reachable.
  const box = (await list.boundingBox())!;
  expect(box.y + box.height).toBeLessThanOrEqual(640);
  const scrolls = await list.evaluate((el) => el.scrollHeight > el.clientHeight + 1);
  if (scrolls) {
    // A scrolling menu shows a shade at the foot (a background layer pinned
    // to the box, under covers that travel with the content).
    const bg = await list.evaluate((el) => getComputedStyle(el).backgroundAttachment);
    expect(bg, "a shade fixed to the box says there is more").toContain("scroll");
    expect(bg).toContain("local");
    const last = page.locator(".menu__list .menu__item").last();
    await last.scrollIntoViewIfNeeded();
    const lb = (await last.boundingBox())!;
    expect(lb.y + lb.height).toBeLessThanOrEqual(640);
  }
});

test("the Inspector's rows share one rhythm", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const w = watch(page);
  await open(page, (await fixtures()).sample);
  await page.locator(".fragment").first().click();
  await expect(page.locator(".props__title")).toHaveText("Text");

  // Every control starts on the same line, beside its label.
  const rows = await page.locator(".props .field").evaluateAll((fields) =>
    fields.map((f) => {
      const label = f.querySelector(".field__label")!.getBoundingClientRect();
      const control = [...f.children].find((c) => !c.classList.contains("field__label"))!.getBoundingClientRect();
      return { label: label.x, labelMid: label.y + label.height / 2, control: control.x, mid: control.y + control.height / 2 };
    }),
  );
  expect(rows.length).toBeGreaterThanOrEqual(4);
  for (const r of rows) {
    expect(Math.abs(r.control - rows[0].control), `controls start at ${rows.map((r) => r.control)}`).toBeLessThan(1);
    expect(r.control).toBeGreaterThan(r.label + 40);
    expect(Math.abs(r.labelMid - r.mid), "label beside its control, not above it").toBeLessThan(4);
  }

  // A value inside a label is in the label's weight.
  const size = page.locator(".props .field__label", { hasText: "Size" });
  const [lw, bw] = await size.evaluate((el) => [getComputedStyle(el).fontWeight, getComputedStyle(el.querySelector("b")!).fontWeight]);
  expect(bw).toBe(lw);

  // Reset style sits in the control column, not centred on its own.
  const reset = (await page.getByRole("button", { name: "Reset style" }).boundingBox())!;
  expect(Math.abs(reset.x + 12 - rows[0].control), `reset at ${reset.x}`).toBeLessThan(2);

  // The Document panel's group headings are in sentence case.
  await page.keyboard.press("Escape");
  await expect(page.locator(".props__title")).toHaveText("Document");
  expect((await style(page, ".docpanel__label", ["text-transform"]))["text-transform"]).toBe("none");
  expect(w.errors).toEqual([]);
});

test("on a phone, Download is the same size as its neighbours", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  await open(page, (await fixtures()).sample);
  // The painted chip: the box less the padding it is clipped inside.
  const chip = (sel: string) =>
    page.locator(sel).first().evaluate((el) => {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const clip = cs.backgroundClip === "content-box";
      const pt = clip ? parseFloat(cs.paddingTop) : 0;
      const pb = clip ? parseFloat(cs.paddingBottom) : 0;
      return { top: r.y + pt, h: r.height - pt - pb };
    });
  const d = await chip(".appbar__download");
  const m = await chip(".appbar__more");
  expect(Math.abs(d.h - m.h), `Download ${d.h}px, ⋯ ${m.h}px`).toBeLessThan(1);
  expect(Math.abs(d.top - m.top), "on the same line").toBeLessThan(1);
  // Still a full touch target.
  expect((await page.locator(".appbar__download").boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await ctx.close();
});

/** Each control in the Inspector's rows: where it starts, how wide it is. */
const controls = (page: Page) =>
  page.locator(".props .field").evaluateAll((fields) =>
    fields.map((f) => {
      const c = [...f.children].find((c) => !c.classList.contains("field__label"))!;
      const r = c.getBoundingClientRect();
      return { name: f.querySelector(".field__label")!.textContent!.trim(), x: r.x, w: r.width, right: r.right, field: f.getBoundingClientRect().right };
    }),
  );

test.describe("on a narrow window, where the Inspector is at its narrowest", () => {
  test.use({ viewport: { width: 700, height: 900 } });

  test("the text controls keep a usable width", async ({ page }) => {
    const w = watch(page);
    await open(page, (await fixtures()).sample);
    await page.locator(".fragment").first().click();
    await expect(page.locator(".props__title")).toHaveText("Text");
    // The size slider had shrunk to 75px: a nudge, not a control.
    const slider = (await page.locator(".props .slider").first().boundingBox())!;
    expect(slider.width, "size slider").toBeGreaterThanOrEqual(150);
    for (const c of await controls(page)) expect(c.right, `${c.name} overruns its row`).toBeLessThanOrEqual(c.field + 0.5);
    expect(w.errors).toEqual([]);
  });

  test("a link's choices read on one line", async ({ page }) => {
    await open(page, (await fixtures()).sample);
    await pickTool(page, "Link");
    await dragOnPage(page, { x: 80, y: 120 }, { x: 280, y: 165 });
    const radios = page.locator('.props [role="radio"]');
    await expect(radios).toHaveCount(2);
    for (const r of await radios.all()) {
      const lines = await r.evaluate((el) => {
        const lh = parseFloat(getComputedStyle(el).lineHeight) || 20;
        const range = document.createRange();
        range.selectNodeContents(el);
        return Math.round(range.getBoundingClientRect().height / lh);
      });
      expect(lines, `"${await r.textContent()}" wraps`).toBe(1);
    }
  });
});

test("a drawing's width slider starts on the control line", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, (await fixtures()).sample);
  await pickSubTool(page, "Rectangle");
  await dragOnPage(page, { x: 80, y: 120 }, { x: 280, y: 220 });
  await pickTool(page, "Select");
  const pb = (await page.locator(".page").first().boundingBox())!;
  await page.mouse.click(pb.x + 80, pb.y + 170);
  const slider = page.getByRole("slider", { name: "Stroke width" });
  await expect(slider).toBeVisible();
  const cs = await controls(page);
  const width = cs.find((c) => c.name.startsWith("Width"))!;
  const others = cs.filter((c) => c !== width);
  expect(others.length).toBeGreaterThan(0);
  expect(Math.abs(width.x - others[0].x), `width at ${width.x}, others at ${others[0].x}`).toBeLessThan(1);
  expect(width.right).toBeLessThanOrEqual(width.field + 0.5);
});

test("in dark, the ⋯ menu's shade can be seen", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.setViewportSize({ width: 1024, height: 560 });
  await open(page, (await fixtures()).sample);
  await page.locator(".appbar__more").click();
  const list = page.locator(".menu__list").first();
  await expect(list).toBeVisible();
  expect(await list.evaluate((el) => el.scrollHeight > el.clientHeight + 1)).toBe(true);
  // The foot of the box against the menu's own surface, in a gap between items.
  const shot = (await list.screenshot()).toString("base64");
  // Read the pixels in a blank page, outside the app's CSP.
  const scratch = await page.context().newPage();
  const { surface, foot } = await scratch.evaluate(async (b64) => {
    const img = new Image();
    img.src = "data:image/png;base64," + b64;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.width;
    c.height = img.height;
    const g = c.getContext("2d")!;
    g.drawImage(img, 0, 0);
    const lum = (x: number, y: number) => {
      const d = g.getImageData(x, y, 1, 1).data;
      return 0.2126 * d[0] + 0.7152 * d[1] + 0.0722 * d[2];
    };
    return { surface: lum(4, Math.round(img.height / 2)), foot: lum(Math.round(img.width / 2), img.height - 2) };
  }, shot);
  await scratch.close();
  expect(surface - foot, `surface ${surface}, foot ${foot}`).toBeGreaterThanOrEqual(10);
});

test("with no tab strip, the app bar keeps its rule", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  await open(page, (await fixtures()).sample);
  await expect(page.locator(".doctabs")).toHaveCount(0);
  const bar = await style(page, ".appbar", ["border-bottom-width", "border-bottom-color"]);
  expect(bar["border-bottom-width"]).not.toBe("0px");
  expect(bar["border-bottom-color"]).not.toMatch(/rgba\(.*,\s*0\)|transparent/);
  await ctx.close();
});

test("with scrollbars that take up room, a short window doesn't fold the desktop Inspector", async ({ playwright, baseURL }) => {
  // Headless Chromium hides scrollbars; a Windows or Linux desktop browser
  // gives them 15px, which took the 320px Inspector under the fold point.
  const browser = await playwright.chromium.launch({
    executablePath: process.env.PW_EXECUTABLE_PATH || undefined,
    ignoreDefaultArgs: ["--hide-scrollbars"],
  });
  const page = await browser.newPage({ baseURL, viewport: { width: 1440, height: 420 } });
  try {
    await open(page, (await fixtures()).sample);
    await page.locator(".fragment").first().click();
    await expect(page.locator(".props__title")).toHaveText("Text");
    const scrolls = await page.locator(".inspector").evaluate((el) => el.clientWidth < el.offsetWidth - 2);
    expect(scrolls, "the Inspector shows a scrollbar here").toBe(true);
    const beside = await page.locator(".props .field").evaluateAll((fields) =>
      fields.map((f) => {
        const l = f.querySelector(".field__label")!.getBoundingClientRect();
        const c = [...f.children].find((c) => !c.classList.contains("field__label"))!.getBoundingClientRect();
        return c.x > l.x + 40;
      }),
    );
    expect(beside.every(Boolean), "labels beside their controls").toBe(true);
  } finally {
    await browser.close();
  }
});

test("stacked, Reset style lines up with the controls above it", async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 900 });
  await open(page, (await fixtures()).sample);
  await page.locator(".fragment").first().click();
  const control = (await controls(page))[0].x;
  // Its icon, not its box: a text button pads its content 12px in.
  const icon = (await page.getByRole("button", { name: "Reset style" }).locator("svg").boundingBox())!;
  expect(Math.abs(icon.x - control), `icon at ${icon.x}, controls at ${control}`).toBeLessThan(2);
});
