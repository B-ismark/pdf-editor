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

/** What a field shows for a value, as lines of text: a text field's text, a
 * choice's chosen options by their shown labels. Empty for boxes and buttons. */
export function shownLines(f: FormField, v: FormValue): string[] {
  if (f.type === "text") return typeof v === "string" && v !== "" ? (f.multiline ? v.split("\n") : [v]) : [];
  if (f.type !== "choice") return [];
  const chosen = Array.isArray(v) ? v : typeof v === "string" && v !== "" ? [v] : [];
  return chosen.map((c) => f.options?.find((o) => o.value === c)?.label ?? c);
}
