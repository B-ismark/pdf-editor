import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { PDFBool, PDFDict, PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from "pdf-lib";
import { fixtures, FORM, FORM_EDGE } from "./fixtures";
import { dragOnPage, expectClean, open, openOrganise, pageTexts, pickTool, watch } from "./helpers";
import { writeFileSync } from "node:fs";

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

const field = (page: Page, name: string) => page.locator(`.formlayer [data-field="${name}"]`);

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

const E = FORM_EDGE;
const counter = (page: Page) => page.locator(".appbar__changes");

/** A widget's look for one state, as the bytes it draws. */
function look(doc: PDFDocument, widget: PDFDict, state: string): string {
  const ap = doc.context.lookup(widget.get(PDFName.of("AP")), PDFDict);
  const n = doc.context.lookup(ap.get(PDFName.of("N")), PDFDict);
  const stream = doc.context.lookup(n.get(PDFName.of(state))) as PDFRawStream;
  return Buffer.from(decodePDFRawStream(stream).decode()).toString("latin1");
}

const widgetsOf = (doc: PDFDocument, name: string) => doc.getForm().getField(name).acroField.getWidgets().map((w) => w.dict);
const da = (d: PDFDict) => d.get(PDFName.of("DA"))?.toString();

test.describe("the form layer and the page beneath it", () => {
  test("text on a form page can still be picked, around the fields", async ({ page }) => {
    await open(page, (await fixtures()).form);
    await page.locator(".fragment", { hasText: FORM.label }).click({ timeout: 5_000 });
    await expect(page.locator(".fragment__cover--sel")).toHaveCount(1);
  });

  test("typing in a field never deletes the box that's selected", async ({ page }) => {
    await open(page, (await fixtures()).form);
    const box = (await page.locator(".page").first().boundingBox())!;
    await pickTool(page, "Redact");
    // Right of the heading: clear of every field, and on screen.
    await dragOnPage(page, { x: box.width * 0.6, y: box.height * 0.03 }, { x: box.width * 0.9, y: box.height * 0.09 });
    await pickTool(page, "Select");
    await page.locator(".redaction").click();
    await expect(page.locator(".redaction--selected")).toHaveCount(1);
    await field(page, FORM.text.name).click();
    await page.keyboard.type("Ab");
    await page.keyboard.press("Backspace");
    await expect(field(page, FORM.text.name)).toHaveValue("A");
    await expect(page.locator(".redaction")).toHaveCount(1);
  });

  test("radio buttons say which they are, and arrow keys move the choice", async ({ page }) => {
    await open(page, (await fixtures()).form);
    const first = page.getByRole("radio", { name: `${FORM.radio.name}: option 1 of 3`, exact: true });
    const second = page.getByRole("radio", { name: `${FORM.radio.name}: option 2 of 3`, exact: true });
    await first.click();
    await expect(first).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("ArrowRight");
    await expect(second).toHaveAttribute("aria-checked", "true");
    await expect(second).toBeFocused();
    await expect(first).toHaveAttribute("aria-checked", "false");
  });

  test("each click is its own undo step, and putting a field back is no change", async ({ page }) => {
    await open(page, (await fixtures()).form);
    const box = page.getByRole("checkbox", { name: FORM.checkbox.name });
    await box.click();
    await expect(counter(page)).toHaveText("1 change");
    await box.click();
    await expect(box).toHaveAttribute("aria-checked", "false");
    await expect(counter(page), "ticked and unticked: the file is as it came").toHaveText("");
    await page.getByRole("button", { name: "Undo" }).first().click();
    await expect(box, "one click back, not both").toHaveAttribute("aria-checked", "true");
  });

  test("an editable dropdown shows its own value, a field is named by its tooltip, a single list starts empty", async ({ page }) => {
    await open(page, (await fixtures()).formEdge);
    await expect(page.getByRole("combobox", { name: E.city.tip })).toHaveValue(E.city.value);
    const level = field(page, E.level.name);
    await expect(level).toHaveValues([]);
    await level.selectOption({ label: E.level.options[0] });
    await expect(level).toHaveValues([E.level.options[0]]);
    await level.selectOption({ label: E.level.options[2] });
    await expect(level, "one at most").toHaveValues([E.level.options[2]]);
    await expect(field(page, E.secret.name), "a hidden field isn't offered").toHaveCount(0);

    const out = await download(page);
    const form = (await PDFDocument.load(out)).getForm();
    expect(form.getOptionList(E.level.name).getSelected()).toEqual([E.level.options[2]]);
    expect(form.getDropdown(E.city.name).getSelected(), "untouched, as it came").toEqual([E.city.value]);
  });
});

test.describe("what the file keeps", () => {
  test("a box or button keeps the file's own look and its default appearance", async ({ page }) => {
    const src = readFileSync((await fixtures()).form);
    const before = await PDFDocument.load(src);
    await open(page, (await fixtures()).form);
    await field(page, FORM.text.name).fill("Ada");
    await page.getByRole("checkbox", { name: FORM.checkbox.name }).click();
    await field(page, FORM.radio.name).nth(2).click();

    const after = await PDFDocument.load(await download(page));
    const [b0] = widgetsOf(before, FORM.checkbox.name);
    const [a0] = widgetsOf(after, FORM.checkbox.name);
    expect(look(after, a0, "Yes"), "the file's own tick").toBe(look(before, b0, "Yes"));
    expect(da(a0)).toBe(da(b0));
    const bRadio = widgetsOf(before, FORM.radio.name);
    widgetsOf(after, FORM.radio.name).forEach((w, i) => {
      expect(look(after, w, String(i)), "the file's own dot").toBe(look(before, bRadio[i], String(i)));
      expect(da(w)).toBe(da(bRadio[i]));
    });
    expect(String(after.getForm().getRadioGroup(FORM.radio.name).acroField.dict.get(PDFName.of("V")))).toBe("/2");
    // A text field's look is redrawn with its new value; its default
    // appearance — what a viewer redraws it from — is the file's, not pdf-lib's.
    const tb = before.getForm().getTextField(FORM.text.name).acroField;
    const ta = after.getForm().getTextField(FORM.text.name).acroField;
    expect(da(ta.dict)).toBe(da(tb.dict));
    ta.getWidgets().forEach((w, i) => expect(da(w.dict)).toBe(da(tb.getWidgets()[i].dict)));
  });

  test("of two buttons standing for the same value, the one clicked is chosen", async ({ page }) => {
    await open(page, (await fixtures()).formEdge);
    await page.getByRole("radio", { name: `${E.answer.name}: option 1 of 3`, exact: true }).click();
    const doc = await PDFDocument.load(await download(page));
    const f = doc.getForm().getRadioGroup(E.answer.name).acroField;
    expect(String(f.dict.get(PDFName.of("V")))).toBe("/0");
    expect(f.getWidgets().map((w) => String(w.dict.get(PDFName.of("AS"))))).toEqual(["/0", "/Off", "/Off"]);
  });

  test("flattening: hidden stays hidden, a list it can't draw stays fillable, a signature isn't touched", async ({ page }) => {
    const w = watch(page);
    await open(page, (await fixtures()).formEdge);
    await field(page, E.script.name).selectOption({ label: "English" });
    await formPanel(page).getByRole("radio", { name: "Flatten into the page" }).check();
    const out = await download(page);
    await expect(page.locator(".snackbar__msg").filter({ hasText: `“${E.script.name}” stays fillable` }).first()).toBeVisible();
    await expect(page.locator(".snackbar__msg").filter({ hasText: E.signature.name })).toHaveCount(0);

    const doc = await PDFDocument.load(out);
    const form = doc.getForm();
    expect(form.getFields().map((f) => f.getName()).sort()).toEqual([E.script.name, E.signature.name]);
    expect(form.getOptionList(E.script.name).getSelected()).toEqual(["English"]);
    const [text] = await pageTexts(out, [1]);
    expect(text).toContain(E.city.value);
    expect(text, "a hidden field is never printed").not.toContain(E.secret.value);
    expect(text, "never drawn as the font's stand-in").not.toContain("????");
    expectClean(w);
  });

  test("a redacted page doesn't carry the form's old answers in its picture", async ({ page }, info) => {
    await open(page, (await fixtures()).formEdge);
    const box = (await page.locator(".page").first().boundingBox())!;
    // Over the heading only, nowhere near the fields.
    await pickTool(page, "Redact");
    await dragOnPage(page, { x: box.width * 0.06, y: box.height * 0.03 }, { x: box.width * 0.5, y: box.height * 0.09 });
    await pickTool(page, "Select");
    const out = await download(page);
    const file = info.outputPath("redacted-form.pdf");
    writeFileSync(file, out);
    expect((await PDFDocument.load(out)).getForm().getFields(), "the page is a picture now").toHaveLength(0);

    await open(page, file);
    await expect(page.locator(".formlayer [data-field]")).toHaveCount(0);
    const dark = await page.locator(".page canvas").first().evaluate((c: HTMLCanvasElement, r: number[]) => {
      const s = c.width / 500;
      const [x, y, w, h] = r;
      const data = c.getContext("2d")!.getImageData(x * s, (560 - y - h) * s, w * s, h * s).data;
      let n = 0;
      for (let i = 0; i < data.length; i += 4) if (data[i] < 110 && data[i + 1] < 110 && data[i + 2] < 110) n++;
      return n;
    }, E.city.rect);
    expect(dark, `no "${E.city.value}" baked into the page`).toBe(0);
  });

  test("Organise keeps the form: a value typed before it still reaches the file", async ({ page }) => {
    const f = await fixtures();
    await open(page, f.form);
    await field(page, FORM.text.name).fill("Ada");
    await openOrganise(page);
    const org = page.locator(".organize");
    await expect(org.locator(".pcard").first()).toBeVisible();
    await org.locator("input[type=file]").setInputFiles(f.sample);
    await expect.poll(() => org.locator(".pcard").count(), { timeout: 30_000 }).toBeGreaterThan(1);
    await org.locator(".btn--filled").click();
    await page.locator(".dialog").getByRole("button", { name: "Apply" }).click();
    await expect(org).toHaveCount(0);
    // The rebuilt document is a fresh editor: wait for it, not the old one.
    await expect.poll(() => page.locator(".page").count(), { timeout: 30_000 }).toBeGreaterThan(1);
    await expect(field(page, FORM.text.name)).toHaveValue("Ada");
    await field(page, FORM.limited.name).fill("XY");

    const form = (await PDFDocument.load(await download(page))).getForm();
    expect(form.getFields(), "still a form").toHaveLength(FORM.fields);
    expect(form.getTextField(FORM.text.name).getText()).toBe("Ada");
    expect(form.getTextField(FORM.limited.name).getText()).toBe("XY");
  });
});
