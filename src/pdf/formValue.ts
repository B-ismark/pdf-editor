import type { FormField, FormValue } from "./types";

// Form values, shared by the preview controls and the exporter's raster path.
// No pdf-lib here: the render path imports it.

/** A field's value now: what was typed, else what the file came with. */
export function fieldValue(f: FormField, values: Record<string, FormValue>): FormValue {
  return f.name in values ? values[f.name] : f.defaultValue;
}

/** Whether a value fills its field: text typed, a box ticked, an option chosen. */
export function hasValue(v: FormValue): boolean {
  return Array.isArray(v) ? v.length > 0 : v === true || (typeof v === "string" && v !== "" && v !== "Off");
}

/** Whether two values fill a field alike. */
export function sameValue(a: FormValue | undefined, b: FormValue | undefined): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    const x = Array.isArray(a) ? a : a ? [String(a)] : [];
    const y = Array.isArray(b) ? b : b ? [String(b)] : [];
    return x.length === y.length && [...x].sort().every((v, i) => v === [...y].sort()[i]);
  }
  return a === b;
}

/** A choice's chosen values as a list, whatever shape the value has. */
export function chosenValues(v: FormValue): string[] {
  return Array.isArray(v) ? v : typeof v === "string" && v !== "" ? [v] : [];
}

/** The text size a field's answer shows at, for a field this tall (in the
 * units it's drawn in): the preview's controls and the redacted page's
 * picture use the same. */
export function fieldFontSize(height: number): number {
  return Math.max(8, Math.min(16, height * 0.6));
}

/** What a field shows for a value, as lines of text: a text field's text (a
 * multi-line one split at its breaks — a file's are usually `\r`), a
 * dropdown's chosen option by its shown label. Empty for boxes and buttons. */
export function shownLines(f: FormField, v: FormValue): string[] {
  if (f.type === "text") {
    if (typeof v !== "string" || v === "") return [];
    return f.multiline ? v.split(/\r\n|\r|\n/) : [v.replace(/[\r\n]+/g, " ")];
  }
  if (f.type !== "choice") return [];
  return chosenValues(v).map((c) => f.options?.find((o) => o.value === c)?.label ?? c);
}
