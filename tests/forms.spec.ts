import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { PDFBool, PDFDocument, PDFName } from "pdf-lib";
import { fixtures, FORM } from "./fixtures";
import { expectClean, open, pageTexts, watch } from "./helpers";

/**
 * Forms: every kind of field filled in the preview reaches the file, and the
 * form leaves either still fillable (the default) or flattened into the page.
 *
 * The download is read back with upstream pdf-lib, which the app doesn't use,
 * so a value the app wrote in its own private shape wouldn't read back here.
 */

async function download(page: Page): Promise<Buffer> {
  const [d] = await Promise.all([page.waitForEvent("download", { timeout: 120_000 }), page.click(".appbar__download")]);
  return readFileSync((await d.path())!);
}

const field = (page: Page, name: string) => page.locator(`.formlayer [aria-label="${name}"]`);

async function fillEverything(page: Page) {
  await field(page, FORM.text.name).fill("Ada Lovelace");
  await field(page, FORM.multiline.name).fill("12 Analytical Row\nLondon");
  // Typed past its limit: the field stops at five, as the file says.
  await field(page, FORM.limited.name).pressSequentially("GA1234567");
  await field(page, FORM.checkbox.name).click();
  await field(page, FORM.radio.name).nth(1).click();
  await field(page, FORM.dropdown.name).selectOption({ label: "France" });
  await field(page, FORM.list.name).selectOption([{ label: "English" }, { label: "Twi" }]);
}

const formPanel = (page: Page) => page.locator("aside.inspector section", { has: page.locator("#docpanel-form") });

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
});

test("every kind of field fills in, and the file stays a form by default", async ({ page }) => {
  const w = watch(page);
  await open(page, (await fixtures()).form);

  // Each kind is offered as the control it is.
  await expect(field(page, FORM.text.name)).toHaveJSProperty("tagName", "INPUT");
  await expect(field(page, FORM.multiline.name)).toHaveJSProperty("tagName", "TEXTAREA");
  await expect(page.getByRole("checkbox", { name: FORM.checkbox.name })).toBeVisible();
  await expect(page.getByRole("radio", { name: FORM.radio.name })).toHaveCount(FORM.radio.options.length);
  await expect(field(page, FORM.dropdown.name).locator("option", { hasText: "Japan" })).toHaveCount(1);
  await expect(field(page, FORM.list.name)).toHaveJSProperty("multiple", true);

  const panel = formPanel(page);
  await expect(panel).toContainText(`0 of ${FORM.fields} fields filled`);
  await expect(panel.getByRole("radio", { name: "Keep fillable" })).toBeChecked();

  await fillEverything(page);
  await expect(field(page, FORM.limited.name)).toHaveValue("GA123");
  await expect(page.getByRole("radio", { name: FORM.radio.name }).nth(1)).toHaveAttribute("aria-checked", "true");
  await expect(panel).toContainText(`${FORM.fields} of ${FORM.fields} fields filled`);

  const out = await download(page);
  const form = (await PDFDocument.load(out)).getForm();
  expect(form.getFields(), "still a form").toHaveLength(FORM.fields);
  expect(form.getTextField(FORM.text.name).getText()).toBe("Ada Lovelace");
  expect(form.getTextField(FORM.multiline.name).getText()).toBe("12 Analytical Row\nLondon");
  expect(form.getTextField(FORM.limited.name).getText()).toBe("GA123");
  expect(form.getCheckBox(FORM.checkbox.name).isChecked()).toBe(true);
  expect(form.getRadioGroup(FORM.radio.name).getSelected(), "the button chosen, by the value it stands for").toBe("Medium");
  expect(form.getDropdown(FORM.dropdown.name).getSelected(), "the option's stored value, not its shown text").toEqual(["fr"]);
  expect(form.getOptionList(FORM.list.name).getSelected()).toEqual(["English", "Twi"]);
  expectClean(w);
});

test("flattening prints the answers into the page and removes the form", async ({ page }) => {
  const w = watch(page);
  await open(page, (await fixtures()).form);
  await fillEverything(page);
  await formPanel(page).getByRole("radio", { name: "Flatten into the page" }).check();

  const out = await download(page);
  const doc = await PDFDocument.load(out);
  expect(doc.getForm().getFields(), "no form left").toHaveLength(0);
  const [text] = await pageTexts(out, [1]);
  expect(text).toContain(FORM.label);
  for (const answer of ["Ada Lovelace", "London", "GA123", "France", "Twi"]) {
    expect(text, `"${answer}" is on the page`).toContain(answer);
  }
  expect(text, "only what was typed: the rest of the postcode was never accepted").not.toContain("GA1234");
  expectClean(w);
});

test("a field whose text can't be drawn stays fillable, and the user is told", async ({ page }) => {
  const w = watch(page);
  await open(page, (await fixtures()).form);
  await field(page, FORM.text.name).fill("Ωμέγα");
  await field(page, FORM.limited.name).fill("AB12");
  await formPanel(page).getByRole("radio", { name: "Flatten into the page" }).check();

  const out = await download(page);
  await expect(
    page.locator(".snackbar__msg").filter({ hasText: `“${FORM.text.name}” stays fillable` }).first(),
  ).toBeVisible();
  const doc = await PDFDocument.load(out);
  const form = doc.getForm();
  expect(form.getFields().map((f) => f.getName()), "only the field that couldn't be drawn").toEqual([FORM.text.name]);
  expect(form.getTextField(FORM.text.name).getText()).toBe("Ωμέγα");
  expect(form.acroForm.dict.get(PDFName.of("NeedAppearances")), "the viewer is asked to draw it").toBe(PDFBool.True);
  const [text] = await pageTexts(out, [1]);
  expect(text, "the others were flattened").toContain("AB12");
  expect(text, "never flattened as the font's stand-in").not.toContain("?????");
  expectClean(w);
});

test("the choice is part of the document: undo takes it back", async ({ page }) => {
  await open(page, (await fixtures()).form);
  const panel = formPanel(page);
  await panel.getByRole("radio", { name: "Flatten into the page" }).check();
  await expect(panel.getByRole("radio", { name: "Flatten into the page" })).toBeChecked();
  await page.getByRole("button", { name: "Undo" }).first().click();
  await expect(panel.getByRole("radio", { name: "Keep fillable" })).toBeChecked();
});
