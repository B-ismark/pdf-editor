import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { PDFArray, PDFBool, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFTextField, decodePDFRawStream } from "pdf-lib";
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
    await expect(page.locator(".snackbar__msg").filter({ hasText: `“${E.script.name}”` }).first()).toBeVisible();
    // Not only text the font can't draw: any field whose look can't be drawn
    // (a comb field holding more than its boxes) stays, and is named.
    await expect(page.locator(".snackbar__msg").filter({ hasText: `“${E.comb.name}”` }).first()).toBeVisible();
    await expect(page.locator(".snackbar__msg").filter({ hasText: E.signature.name })).toHaveCount(0);

    const doc = await PDFDocument.load(out);
    const form = doc.getForm();
    expect(form.getFields().map((f) => f.getName()).sort()).toEqual([E.comb.name, E.script.name, E.signature.name]);
    expect(form.getOptionList(E.script.name).getSelected()).toEqual(["English"]);
    const [text] = await pageTexts(out, [1]);
    expect(text).toContain(E.city.value);
    expect(text, "a dropdown's value that isn't an option is printed, as the preview showed it").toContain(E.legacy.value);
    expect(text, "a hidden field is never printed").not.toContain(E.secret.value);
    expect(text, "never drawn as the font's stand-in").not.toContain("????");
    expectClean(w);
  });

  test("a redacted page shows the answers as they are now, not as the file came", async ({ page }, info) => {
    await open(page, (await fixtures()).formEdge);
    // The file says "Tamale"; cleared here. No answer was given; the third chosen.
    await page.getByRole("combobox", { name: E.city.tip }).selectOption("");
    await page.getByRole("radio", { name: `${E.answer.name}: option 3 of 3`, exact: true }).click();
    // Flattening: fields that couldn't be flattened are on this page, which
    // becomes a picture — nothing "stays fillable" to report.
    await formPanel(page).getByRole("radio", { name: "Flatten into the page" }).check();
    const box = (await page.locator(".page").first().boundingBox())!;
    // Over the heading only, nowhere near the fields.
    await pickTool(page, "Redact");
    await dragOnPage(page, { x: box.width * 0.06, y: box.height * 0.03 }, { x: box.width * 0.5, y: box.height * 0.09 });
    await expect(page.locator(".redaction"), "the box is drawn").toHaveCount(1);
    await pickTool(page, "Select");
    // Longer than a line of the box: it wraps, in the preview and the picture.
    // …and then a pasted run with no spaces, far longer than the box shows:
    // the export mustn't stall measuring it.
    await field(page, E.essay.name).fill(`A long answer that runs well past the edge of its box ${"x".repeat(20_000)}`);
    // The last option of a list showing two rows: the preview scrolls to it.
    await field(page, E.level.name).selectOption(E.level.options[2]);
    const out = await download(page);
    const file = info.outputPath("redacted-form.pdf");
    writeFileSync(file, out);
    expect((await PDFDocument.load(out)).getForm().getFields(), "the page is a picture now").toHaveLength(0);

    await open(page, file);
    await expect(page.locator(".formlayer [data-field]")).toHaveCount(0);
    const dark = (r: number[]) =>
      page.locator(".page canvas").first().evaluate((c: HTMLCanvasElement, r: number[]) => {
        const s = c.width / 500;
        const [x, y, w, h] = r;
        const data = c.getContext("2d")!.getImageData(x * s, (560 - y - h) * s, w * s, h * s).data;
        let n = 0;
        for (let i = 0; i < data.length; i += 4) if (data[i] < 110 && data[i + 1] < 110 && data[i + 2] < 110) n++;
        return n;
      }, r);
    expect(await dark(E.city.rect), `no "${E.city.value}": the answer was cleared`).toBe(0);
    expect(await dark([160, E.answer.y, 16, 16]), "the button chosen is drawn chosen").toBeGreaterThan(0);
    expect(await dark([40, E.answer.y, 16, 16]), "and the others not").toBe(0);
    // The bottom half of each multi-line box: its second line.
    const second = (r: number[]) => [r[0], r[1], r[2], r[3] * 0.48];
    expect(await dark(second(E.notes.rect)), "a \\r in the file's value breaks the line").toBeGreaterThan(0);
    expect(await dark(second(E.essay.rect)), "a long answer wraps").toBeGreaterThan(0);
    await expect(page.locator(".snackbar__msg").filter({ hasText: "fillable" })).toHaveCount(0);
    const [lx, ly, lw, lh] = E.level.rect;
    const marked = (fromTop: number, to: number) =>
      page.locator(".page canvas").first().evaluate((c: HTMLCanvasElement, r: number[]) => {
        const s = c.width / 500;
        const [x, y, w, h] = r;
        const data = c.getContext("2d")!.getImageData(x * s, (560 - y - h) * s, w * s, h * s).data;
        let n = 0;
        for (let i = 0; i < data.length; i += 4) if (data[i + 2] > 180 && data[i] < 180 && data[i + 1] > 160) n++;
        return n;
      }, [lx, ly + lh - to, lw, to - fromTop]);
    // Two rows show, scrolled just enough — "Intermediate", then "Expert"
    // marked — as the preview's list shows it: the mark is the second row.
    expect(await marked(23, 36), "the chosen option is shown, marked, in the second row").toBeGreaterThan(0);
    expect(await marked(4, 18), "not scrolled to the top of the box").toBe(0);
  });

  test("a dropdown shows its own unlisted value and stays untypeable; a locked field can't be changed", async ({ page }) => {
    await open(page, (await fixtures()).formEdge);
    await expect(field(page, E.locked.name)).toHaveAttribute("readonly", "");
    const legacy = field(page, E.legacy.name);
    // (Flattened untouched, it's printed: the flatten test reads it back.)
    await expect(legacy).toHaveValue(E.legacy.value);
    await legacy.selectOption(E.legacy.options[1]);
    const dd = (await PDFDocument.load(await download(page))).getForm().getDropdown(E.legacy.name);
    expect(dd.getSelected()).toEqual([E.legacy.options[1]]);
    expect(dd.isEditable(), "still takes no typing").toBe(false);
  });

  test("a radio button named in UTF-8 bytes is still the one saved", async ({ page }) => {
    await open(page, (await fixtures()).formEdge);
    await field(page, E.cyrillic.name).nth(1).click();
    const doc = await PDFDocument.load(await download(page));
    const f = doc.getForm().getRadioGroup(E.cyrillic.name).acroField;
    const as = f.getWidgets().map((w) => String(w.dict.get(PDFName.of("AS"))));
    expect(as[0]).toBe("/Off");
    expect(as[1]).not.toBe("/Off");
    expect(String(f.dict.get(PDFName.of("V")))).toBe(as[1]);
  });

  test("a field in a /Parent loop, or under an untitled parent, still gets its value", async ({ page }) => {
    await open(page, (await fixtures()).formEdge);
    await field(page, E.loop.name).fill("Looped");
    await field(page, E.leaf.name).fill("Leafy");
    await field(page, E.level.name).selectOption({ label: E.level.options[1] });
    const doc = await PDFDocument.load(await download(page));
    const form = doc.getForm();
    const text = (suffix: string) => form.getFields().find((f) => f.getName().endsWith(suffix));
    expect((text("top") as PDFTextField).getText()).toBe("Looped");
    expect((text(E.leaf.name) as PDFTextField).getText()).toBe("Leafy");
    expect(form.getOptionList(E.level.name).getSelected(), "and the rest of the form too").toEqual([E.level.options[1]]);
  });

  test("a clicked form box gives the keyboard back when a box on the page is selected", async ({ page }) => {
    await open(page, (await fixtures()).form);
    const box = (await page.locator(".page").first().boundingBox())!;
    await pickTool(page, "Redact");
    await dragOnPage(page, { x: box.width * 0.6, y: box.height * 0.03 }, { x: box.width * 0.9, y: box.height * 0.09 });
    await pickTool(page, "Select");
    await page.getByRole("checkbox", { name: FORM.checkbox.name }).click();
    await page.locator(".redaction").click();
    await expect(page.locator(".redaction--selected")).toHaveCount(1);
    await page.keyboard.press("Delete");
    await expect(page.locator(".redaction")).toHaveCount(0);
    await expect(page.getByRole("checkbox", { name: FORM.checkbox.name }), "still ticked").toHaveAttribute("aria-checked", "true");
  });

  test("Organise merging two forms keeps each one's defaults", async ({ page }) => {
    const f = await fixtures();
    await open(page, f.form);
    await openOrganise(page);
    const org = page.locator(".organize");
    await expect(org.locator(".pcard").first()).toBeVisible();
    await org.locator("input[type=file]").setInputFiles(f.formEdge);
    await expect.poll(() => org.locator(".pcard").count(), { timeout: 30_000 }).toBeGreaterThan(1);
    // Nothing edited yet, so there's nothing to confirm losing.
    await org.locator(".btn--filled").click();
    await expect(org).toHaveCount(0);
    await expect.poll(() => page.locator(".page").count(), { timeout: 30_000 }).toBe(2);

    // Read by hand: the second file's own `/Parent` loop is still there, and
    // pdf-lib's getForm() would walk it forever.
    const doc = await PDFDocument.load(await download(page));
    const acro = doc.catalog.lookup(PDFName.of("AcroForm"), PDFDict);
    expect(acro.get(PDFName.of("NeedAppearances")), "the second file asked viewers to draw").toBe(PDFBool.True);
    const fonts = acro.lookup(PDFName.of("DR"), PDFDict).lookup(PDFName.of("Font"), PDFDict);
    expect(fonts.has(PDFName.of("TiRo")), "the second file's font is in the merged resources").toBe(true);
    // A field of the second file that relied on its form's default keeps it.
    expect(String(acro.lookup(PDFName.of("DA"))), "the first file's default is the form's").not.toContain("TiRo");
    const roots = acro.lookup(PDFName.of("Fields"), PDFArray).asArray().map((r) => doc.context.lookup(r, PDFDict));
    const radio = roots.find((d) => d.lookup(PDFName.of("T"))?.toString() === `(${E.cyrillic.name})`)!;
    expect(radio.lookup(PDFName.of("DA"))?.toString()).toContain("TiRo");
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

/**
 * Every export that is still a PDF says which fields stayed fillable when the
 * form was to be flattened — not only Download. A picture of the page (Export
 * as images) shows the answer and has no form, so it says nothing of the kind.
 */
test.describe("the kept-fillable note on every export that is a PDF", () => {
  async function greekFlattened(page: Page) {
    await field(page, FORM.text.name).fill("Ωμέγα");
    await formPanel(page).getByRole("radio", { name: "Flatten into the page" }).check();
  }
  const kept = `“${FORM.text.name}” stays fillable`;

  test("Compress, keeping text", async ({ page }) => {
    const w = watch(page);
    await open(page, (await fixtures()).form);
    await greekFlattened(page);
    await page.click('[aria-label="Export options"]');
    await page.locator('[role="menuitem"]', { hasText: "Compress PDF" }).click();
    await page.locator(".compress__preset", { hasText: "Keep text" }).click();
    await expect(page.locator(".compress__estimate")).toContainText("text stays selectable", { timeout: 60_000 });
    const [d] = await Promise.all([page.waitForEvent("download"), page.click(".dialog__actions .btn--filled")]);
    const form = (await PDFDocument.load(readFileSync((await d.path())!))).getForm();
    expect(form.getFields().map((f) => f.getName()), "the file is still that form").toEqual([FORM.text.name]);
    await expect(page.locator(".snackbar__msg").filter({ hasText: kept }).first()).toBeVisible();
    expectClean(w);
  });

  test("Download all, naming the file in the ZIP each field is in", async ({ page }) => {
    const w = watch(page);
    const f = await fixtures();
    await open(page, f.form);
    // Three fields kept in the first: the one kept in the second falls past
    // the three named, and its file still has to be named.
    await field(page, FORM.multiline.name).fill("Οδός");
    await field(page, FORM.limited.name).fill("ΑΒΓ");
    await greekFlattened(page);
    // The same form again, in a second tab: two tabs, one file name, and two
    // entries in the ZIP. The first tab is parked, its choice with it.
    await page.setInputFiles("input[data-open-input]", f.form);
    await expect(page.locator(".doctab")).toHaveCount(2, { timeout: 30_000 });
    await page.waitForSelector(".formlayer");
    await greekFlattened(page);
    await page.locator('[aria-label="Export options"]').click();
    await Promise.all([
      page.waitForEvent("download"),
      page.locator(".menu__item", { hasText: "Download all (2) as ZIP" }).click(),
    ]);
    const msg = page.locator(".snackbar__msg");
    await expect(msg).toContainText(/“\w+”, “\w+” and “\w+” \(in form-edited\.pdf\) and 1 field \(in form-edited-2\.pdf\) stay fillable/);
    for (const name of [FORM.text.name, FORM.multiline.name, FORM.limited.name]) await expect(msg).toContainText(`“${name}”`);
    expectClean(w);
  });

  test("Export as images says nothing of a form: the picture shows the answer", async ({ page }) => {
    const w = watch(page);
    await open(page, (await fixtures()).form);
    await greekFlattened(page);
    await page.getByRole("button", { name: "Export options" }).click();
    await Promise.all([page.waitForEvent("download"), page.getByRole("menuitem", { name: /Export as images/ }).click()]);
    await expect(page.locator(".snackbar__msg").filter({ hasText: "Exported 1 image." })).toBeVisible();
    await expect(page.locator(".snackbar__msg").filter({ hasText: "fillable" })).toHaveCount(0);
    expectClean(w);
  });
});
