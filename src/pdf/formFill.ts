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

  // Fields whose look couldn't be drawn: the viewer has to. `unreadable` are
  // the ones that couldn't because of their text — the user is told.
  const undrawn = new Set<PDFField>();
  const unreadable = new Set<PDFField>();
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
    let name: string;
    try {
      name = field.getName();
    } catch {
      continue;
    }
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
        if (!drawable(shownText(field), font)) {
          unreadable.add(field);
          throw new Error("no glyphs");
        }
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
      if (undrawn.has(field)) {
        if (unreadable.has(field)) {
          try {
            result.keptFillable.push(field.getName());
          } catch {
            /* unnamed */
          }
        }
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
      const on = field.acroField.getOnValues().find((n) => n.decodeText() === v);
      if (!on) throw new Error(`No button "${v}"`);
      field.acroField.setValue(on);
    }
  } else if (field instanceof PDFDropdown || field instanceof PDFOptionList) {
    const chosen = (Array.isArray(v) ? v : typeof v === "string" && v !== "" ? [v] : []).map((x) => optionText(field, x));
    if (chosen.length === 0) field.clear();
    else field.select(chosen.length === 1 ? chosen[0] : chosen);
  }
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
  const chosen = Array.isArray(v) ? v : typeof v === "string" && v !== "" ? [v] : [];
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
    const flags = widget.dict.get(PDFName.of("F"));
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
