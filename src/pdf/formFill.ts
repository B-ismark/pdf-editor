import {
  PDFCheckBox,
  PDFDropdown,
  PDFName,
  PDFOptionList,
  PDFRadioGroup,
  PDFTextField,
  PDFBool,
  PDFHexString,
  PDFNumber,
  PDFArray,
  PDFDict,
  PDFRef,
  PDFString,
  type PDFDocument,
  type PDFField,
  type PDFFont,
  type PDFForm,
} from "@cantoo/pdf-lib";
import type { FormValue } from "./types";

export interface FormResult {
  /** Fields that were to be flattened but kept fillable, by name. */
  keptFillable: string[];
}

/**
 * Put the values typed into the preview's form fields into the file, and
 * either keep the form fillable or flatten it into the page.
 *
 * Values are matched to fields by name, and to options by the value the file
 * stores — which is what pdf.js reports and the preview shows. pdf-lib picks
 * dropdown and list options by their *shown* text and radio buttons by their
 * export value, so each is translated here rather than trusted to line up.
 *
 * A field whose new look can't be drawn (pdf-lib's standard font has no
 * glyphs for, say, Greek or Chinese) still gets its value, and the file asks
 * the viewer to draw it (`/NeedAppearances`). Flattening can't do that — the
 * page would show the old value, or nothing — so such a field is left fillable
 * and named in the result, rather than flattened wrongly.
 */
export function applyForm(
  doc: PDFDocument,
  values: Record<string, FormValue>,
  flatten: boolean,
  font: PDFFont,
): FormResult {
  const result: FormResult = { keptFillable: [] };
  const names = Object.keys(values);
  if (names.length === 0 && !flatten) return result;
  if (!doc.catalog.has(PDFName.of("AcroForm"))) return result;
  // pdf-lib walks `/Parent` with no guard: one loop in the form overflows the
  // stack and every value in the document would be lost. pdf.js reads such a
  // form fine, so the preview filled it; cut the loop.
  breakParentCycles(doc);
  let form: PDFForm;
  let fields: PDFField[];
  try {
    form = doc.getForm();
    fields = form.getFields();
  } catch {
    // A form pdf-lib can't read: leave it exactly as it came.
    return result;
  }
  if (fields.length === 0) return result;

  // Fields whose look couldn't be drawn: the viewer has to.
  const undrawn = new Set<PDFField>();
  // Only the kinds the editor fills. A signature or push button is left as it
  // came, flattening or not: it has no value to draw.
  const fillable = fields.filter(
    (f) =>
      f instanceof PDFTextField ||
      f instanceof PDFCheckBox ||
      f instanceof PDFRadioGroup ||
      f instanceof PDFDropdown ||
      f instanceof PDFOptionList,
  );
  for (const field of fillable) {
    // The name as pdf.js gives it (and so the preview keys values by): an
    // ancestor without a `/T` is skipped, where pdf-lib writes "undefined.".
    const name = fieldKey(field.acroField.dict);
    const touched = name in values;
    // An untouched dropdown or list still holds what the file stored; drawn
    // again, it should show its options' text, not their stored values.
    const value: FormValue | undefined = touched ? values[name] : choiceValues(field);
    if (touched) {
      try {
        setValue(field, values[name]);
      } catch {
        // A value the field won't take (an option the file doesn't list): the
        // field keeps what it had.
        continue;
      }
    }
    // Draw the field's new look. When flattening, every field needs one — an
    // untouched field whose look the file left to the viewer would otherwise
    // flatten to nothing. Kept fillable, an untouched field is left alone.
    // A box or button keeps the file's own looks (its tick, its dot) when it
    // has them for every state: choosing one only switches between them.
    const toggle = field instanceof PDFCheckBox || field instanceof PDFRadioGroup;
    const redraw = toggle ? needsLook(field) : touched || (flatten && needsLook(field));
    if (redraw) {
      if (!touched && value !== undefined) {
        try {
          setValue(field, value);
        } catch {
          /* drawn as it is */
        }
      }
      const looks = keepLooks(field);
      try {
        if (!drawable(shownText(field), font)) throw new Error("no glyphs");
        field.defaultUpdateAppearances(font);
      } catch {
        undrawn.add(field);
      }
      // pdf-lib rewrites the field's default appearance (`/DA`) to name its own
      // font, which the form's resources don't have; a viewer that redraws the
      // field from it would find nothing. The look just drawn carries its own.
      looks();
    }
    // pdf-lib stores a chosen option by its shown text; the file format says
    // by its value. Put the value back once the look (which shows the text)
    // is drawn.
    if (value !== undefined) storeChoiceValues(field, value);
    try {
      form.markFieldAsClean(field.ref);
    } catch {
      /* nothing to mark */
    }
  }

  if (flatten) {
    for (const field of fillable) {
      // Kept fillable, whatever stopped its look being drawn (text the font
      // can't draw, a layout pdf-lib can't do): the user is told either way.
      if (undrawn.has(field)) {
        result.keptFillable.push(fieldKey(field.acroField.dict));
        continue;
      }
      flattenField(form, field);
    }
  }
  if (undrawn.size > 0) form.acroForm.dict.set(PDFName.of("NeedAppearances"), PDFBool.True);
  return result;
}

function setValue(field: PDFField, v: FormValue): void {
  if (field instanceof PDFTextField) {
    const text = typeof v === "string" ? v : "";
    // A value over the field's limit would throw; the preview stops typing at
    // the limit, so this only trims a value from an older session.
    const max = field.getMaxLength();
    field.setText(max !== undefined ? text.slice(0, max) : text);
  } else if (field instanceof PDFCheckBox) {
    if (v === true) field.check();
    else field.uncheck();
  } else if (field instanceof PDFRadioGroup) {
    if (typeof v !== "string" || v === "" || v === "Off") field.clear();
    else {
      // By the button's own on-state, not pdf-lib's `select`, which goes by
      // export value — and when two buttons share one (`/Opt [(Yes) (Yes)
      // (No)]`), picks the last.
      const on = field.acroField.getOnValues().find((n) => n.decodeText() === v || pdfDocText(n.decodeText()) === v);
      if (!on) throw new Error(`No button "${v}"`);
      field.acroField.setValue(on);
    }
  } else if (field instanceof PDFDropdown || field instanceof PDFOptionList) {
    const chosen = keptChoices(field, v).map((x) => optionText(field, x));
    if (chosen.length === 0) field.clear();
    else if (field instanceof PDFDropdown) {
      // A value no option holds (the preview shows it as it is) is drawn as
      // it is too. pdf-lib's `select` takes it by making the dropdown
      // editable; it isn't, so that's put back.
      const editable = field.isEditable();
      field.select(chosen[0]);
      if (!editable) field.disableEditing();
    } else field.select(chosen.length === 1 ? chosen[0] : chosen);
  }
}

/** The values a dropdown or list will hold: a list's `select` throws on a
 * value none of its options has (left from an older version of the file), so
 * a list drops it; a dropdown keeps it. */
function keptChoices(field: PDFDropdown | PDFOptionList, v: FormValue): string[] {
  const chosen = Array.isArray(v) ? v : typeof v === "string" && v !== "" ? [v] : [];
  return field instanceof PDFOptionList ? chosen.filter((x) => hasOption(field, x)) : chosen.slice(0, 1);
}

function hasOption(field: PDFDropdown | PDFOptionList, value: string): boolean {
  return field.acroField.getOptions().some(({ value: v }) => v.decodeText() === value);
}

/** The text pdf-lib selects an option by, for the value the file stores. */
function optionText(field: PDFDropdown | PDFOptionList, value: string): string {
  for (const { value: v, display } of field.acroField.getOptions()) {
    if (v.decodeText() === value) return (display ?? v).decodeText();
  }
  return value;
}

/** Write a dropdown's or list's chosen options as the values the file
 * stores, which pdf-lib's `select` writes as their shown text instead. */
function storeChoiceValues(field: PDFField, v: FormValue): void {
  if (!(field instanceof PDFDropdown || field instanceof PDFOptionList)) return;
  // The same values the look was drawn with.
  const chosen = keptChoices(field, v);
  if (chosen.length === 0) return;
  const stored = chosen.map((x) => PDFHexString.fromText(x));
  field.acroField.dict.set(PDFName.of("V"), stored.length === 1 ? stored[0] : field.acroField.dict.context.obj(stored));
}

/** All the text a field's look draws: a text field's value, a dropdown's
 * chosen option, and every option of a list (its look lists them all). */
function shownText(field: PDFField): string {
  if (field instanceof PDFTextField) return field.getText() ?? "";
  if (field instanceof PDFDropdown) return field.getSelected().join("");
  if (field instanceof PDFOptionList) return field.getOptions().join("");
  return "";
}

/** A dropdown's or list's chosen options as the file stores them. */
function choiceValues(field: PDFField): FormValue | undefined {
  if (!(field instanceof PDFDropdown || field instanceof PDFOptionList)) return undefined;
  try {
    return field.acroField.getValues().map((v) => v.decodeText());
  } catch {
    return undefined;
  }
}

/** Remember a field's `/DA` (on the field and each widget); the returned
 * function puts them back as they were. */
function keepLooks(field: PDFField): () => void {
  const DA = PDFName.of("DA");
  const dicts = [field.acroField.dict, ...field.acroField.getWidgets().map((w) => w.dict)];
  const saved = dicts.map((d) => d.get(DA));
  return () =>
    dicts.forEach((d, i) => {
      const was = saved[i];
      if (was === undefined) d.delete(DA);
      else d.set(DA, was);
    });
}

/** Whether the font can draw every character of `text`. The standard fonts
 * don't throw on a character they lack — they quietly draw "?" — so each one
 * is checked for coming back as a "?" it wasn't. */
function drawable(text: string, font: PDFFont): boolean {
  const question = font.encodeText("?").toString();
  for (const ch of text) {
    if (ch === "?" || ch === "\n" || ch === "\r") continue;
    try {
      if (font.encodeText(ch).toString() === question) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/** Whether any of a field's widgets lacks a normal appearance to flatten. */
function needsLook(field: PDFField): boolean {
  try {
    return field.acroField.getWidgets().some((w) => !w.getAppearances()?.normal);
  } catch {
    return true;
  }
}

/** What `PDFForm.flatten` does for one field: paint each widget's look onto
 * its page, then remove the field. (pdf-lib only flattens every field at once,
 * and a field it couldn't draw must stay.) */
function flattenField(form: PDFForm, field: PDFField): void {
  const f = form as unknown as {
    findWidgetPage(w: unknown): unknown;
    findWidgetAppearanceRef(field: PDFField, w: unknown): unknown;
    flattenWidgetOntoPage(page: unknown, w: unknown, ap: unknown): void;
  };
  for (const widget of field.acroField.getWidgets()) {
    // A widget the file hides (Hidden, NoView) never shows, so it isn't
    // printed into the page either — its field still goes.
    const flags = widget.dict.lookup(PDFName.of("F"));
    if (flags instanceof PDFNumber && (flags.asNumber() & (2 | 32)) !== 0) continue;
    try {
      const page = f.findWidgetPage(widget);
      f.flattenWidgetOntoPage(page, widget, f.findWidgetAppearanceRef(field, widget));
    } catch {
      /* a widget with no page or no look: nothing to paint */
    }
  }
  try {
    form.removeField(field);
  } catch {
    /* already gone */
  }
}

/** Every field name the file's form still has, as pdf.js names them: what a
 * "stays fillable" note may name once pages have been redacted or deleted. */
export function formFieldNames(doc: PDFDocument): Set<string> {
  const names = new Set<string>();
  const seen = new Set<PDFDict>();
  const acro = doc.catalog.lookup(PDFName.of("AcroForm"));
  const walk = (o: unknown) => {
    const d = o instanceof PDFRef ? doc.context.lookup(o) : o;
    if (!(d instanceof PDFDict) || seen.has(d)) return;
    seen.add(d);
    names.add(fieldKey(d));
    const kids = d.lookup(PDFName.of("Kids"));
    if (kids instanceof PDFArray) kids.asArray().forEach(walk);
  };
  if (acro instanceof PDFDict) {
    const fields = acro.lookup(PDFName.of("Fields"));
    if (fields instanceof PDFArray) fields.asArray().forEach(walk);
  }
  return names;
}

/** A field's full name as pdf.js builds it: each ancestor's `/T`, skipping any
 * without one, joined with ".". */
function fieldKey(dict: PDFDict): string {
  const parts: string[] = [];
  const seen = new Set<PDFDict>();
  let cur: PDFDict | undefined = dict;
  while (cur && !seen.has(cur) && seen.size < 64) {
    seen.add(cur);
    const t = cur.lookup(PDFName.of("T"));
    if (t instanceof PDFString || t instanceof PDFHexString) parts.unshift(t.decodeText());
    const up: unknown = cur.lookup(PDFName.of("Parent"));
    cur = up instanceof PDFDict ? up : undefined;
  }
  return parts.join(".");
}

/** Cut every `/Parent` loop among the form's fields and widgets. */
function breakParentCycles(doc: PDFDocument): void {
  const PARENT = PDFName.of("Parent");
  const isField = (d: PDFDict) =>
    d.has(PDFName.of("T")) || d.has(PDFName.of("FT")) || d.get(PDFName.of("Subtype")) === PDFName.of("Widget");
  // Widgets first: walking up from each, the link cut is the one pdf.js stops
  // at, so the name left matches the one the preview keyed the value by.
  const dicts = doc.context
    .enumerateIndirectObjects()
    .map(([, o]) => o)
    .filter((o): o is PDFDict => o instanceof PDFDict && isField(o));
  const widget = (d: PDFDict) => d.get(PDFName.of("Subtype")) === PDFName.of("Widget");
  for (const obj of [...dicts.filter(widget), ...dicts.filter((d) => !widget(d))]) {
    const seen = new Set<PDFDict>([obj]);
    let cur = obj;
    for (let depth = 0; ; depth++) {
      const ref = cur.get(PARENT);
      const up = ref instanceof PDFRef ? doc.context.lookup(ref) : ref;
      if (!(up instanceof PDFDict)) break;
      if (seen.has(up) || depth > 64) {
        cur.delete(PARENT);
        break;
      }
      seen.add(up);
      cur = up;
    }
  }
}

/** PDFDocEncoding's characters for the bytes where it differs from Latin-1. */
const PDF_DOC: Record<number, number> = {
  0x18: 0x02d8, 0x19: 0x02c7, 0x1a: 0x02c6, 0x1b: 0x02d9, 0x1c: 0x02dd, 0x1d: 0x02db, 0x1e: 0x02da, 0x1f: 0x02dc,
  0x80: 0x2022, 0x81: 0x2020, 0x82: 0x2021, 0x83: 0x2026, 0x84: 0x2014, 0x85: 0x2013, 0x86: 0x0192, 0x87: 0x2044,
  0x88: 0x2039, 0x89: 0x203a, 0x8a: 0x2212, 0x8b: 0x2030, 0x8c: 0x201e, 0x8d: 0x201c, 0x8e: 0x201d, 0x8f: 0x2018,
  0x90: 0x2019, 0x91: 0x201a, 0x92: 0x2122, 0x93: 0xfb01, 0x94: 0xfb02, 0x95: 0x0141, 0x96: 0x0152, 0x97: 0x0160,
  0x98: 0x0178, 0x99: 0x017d, 0x9a: 0x0131, 0x9b: 0x0142, 0x9c: 0x0153, 0x9d: 0x0161, 0x9e: 0x017e, 0xa0: 0x20ac,
};

/** A name's bytes (as pdf-lib decodes them, one character each) read as
 * PDFDocEncoding — which is how pdf.js reports a radio button's on-state, so
 * a Cyrillic or CJK name (UTF-8 bytes 0x80–0x9F) still matches. */
function pdfDocText(latin1: string): string {
  let out = "";
  for (const ch of latin1) {
    const c = ch.charCodeAt(0);
    out += String.fromCharCode(PDF_DOC[c] ?? c);
  }
  return out;
}
