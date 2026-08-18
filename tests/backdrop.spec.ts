import { expect, test, type Page } from "@playwright/test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TYPESET_PAGE, TYPESET_PANEL, fixtures } from "./fixtures";
import { expectClean, open, pageTexts, watch } from "./helpers";

/**
 * Editing text must not cost the page its background.
 *
 * A non-redacted page is copied verbatim and edits are drawn on top, so the
 * artwork was never at risk from the export itself — the cover rectangle that
 * hides the original glyphs was, because it was hardcoded white. Inside a
 * coloured pill, table cell, or banner that is a white hole through the design.
 *
 * The fixture's panel carries *black* text, so any near-white pixel inside the
 * panel is that hole and nothing else.
 */

/** Count near-white and panel-coloured pixels inside the panel, off whatever
 * page is currently rendered. Inset so the panel's own antialiased edge (green
 * blending into white paper) can't be mistaken for a hole. */
async function panelPixels(page: Page) {
  return page.evaluate(
    ({ panel, pageW, pageH, inset }) => {
      const canvas = document.querySelector<HTMLCanvasElement>(".page__canvas")!;
      const ctx = canvas.getContext("2d")!;
      const s = canvas.width / pageW;
      const x = Math.round((panel.x + inset) * s);
      const y = Math.round((pageH - (panel.y + panel.height - inset)) * s);
      const w = Math.round((panel.width - inset * 2) * s);
      const h = Math.round((panel.height - inset * 2) * s);
      const d = ctx.getImageData(x, y, w, h).data;
      const [pr, pg, pb] = panel.rgb;
      let white = 0;
      let fill = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] > 240 && d[i + 1] > 240 && d[i + 2] > 240) white++;
        if (
          Math.abs(d[i] - pr) < 6 &&
          Math.abs(d[i + 1] - pg) < 6 &&
          Math.abs(d[i + 2] - pb) < 6
        ) {
          fill++;
        }
      }
      return { white, fill, total: d.length / 4 };
    },
    {
      panel: TYPESET_PANEL,
      pageW: TYPESET_PAGE.width,
      pageH: TYPESET_PAGE.height,
      inset: 2,
    },
  );
}

/** Select the panel's text and replace it. Returns its fragment id. */
async function editPanelText(page: Page, replacement: string): Promise<string> {
  const id = await page
    .locator(".fragment", { hasText: TYPESET_PANEL.text })
    .first()
    .getAttribute("data-id");
  expect(id, "no fragment for the panel text").toBeTruthy();
  const el = page.locator(`.fragment[data-id="${id}"]`);
  await el.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type(replacement);
  await expect(el).toHaveText(replacement);
  return id!;
}

test("the on-screen cover takes the colour behind the text", async ({ page }) => {
  const w = watch(page);
  const { typeset } = await fixtures();
  await open(page, typeset);

  const id = await editPanelText(page, "EDITED-ON-PANEL");
  // The overlay previews what the exporter writes, so it has to be the sampled
  // colour here too — a white box on screen is the same lie either way.
  const [r, g, b] = TYPESET_PANEL.rgb;
  const cover = page.locator(".fragment__cover").first();
  await expect(cover).toHaveCSS("background-color", `rgb(${r}, ${g}, ${b})`);

  // A fragment on plain paper keeps the white it always had. Its cover is the
  // sibling rendered just before it (the panel's edited fragment keeps a cover
  // of its own, so neither first() nor last() picks this one out).
  const onPaper = page.locator(".fragment").filter({ hasText: "Hxplg-Times-18" }).first();
  await onPaper.click();
  await expect(page.locator(`.fragment[data-id="${id}"]`)).toBeVisible();
  await expect(onPaper.locator("xpath=preceding-sibling::div[1]")).toHaveCSS(
    "background-color",
    "rgb(255, 255, 255)",
  );
  expectClean(w);
});

test("an exported edit keeps the panel it sits on", async ({ page }) => {
  const w = watch(page);
  const { typeset } = await fixtures();
  await open(page, typeset);

  const before = await panelPixels(page);
  expect(before.white, "the unedited panel is solid to begin with").toBe(0);
  expect(before.fill).toBeGreaterThan(before.total * 0.5);

  await editPanelText(page, "EDITED-ON-PANEL");
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 120_000 }),
    page.click(".appbar__download"),
  ]);
  const bytes = await download.createReadStream().then(async (stream) => {
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(c as Buffer);
    return Buffer.concat(chunks);
  });

  // The edit is really in the file...
  expect((await pageTexts(bytes, [1]))[0]).toContain("EDITED-ON-PANEL");

  // ...and the file, reopened and rendered, has no white hole in the panel.
  const out = join(mkdtempSync(join(tmpdir(), "backdrop-")), "exported.pdf");
  writeFileSync(out, bytes);
  await open(page, out);
  const after = await panelPixels(page);
  expect(after.white, "the cover punched a white hole through the panel").toBe(0);
  expect(after.fill).toBeGreaterThan(after.total * 0.5);
  expectClean(w);
});
