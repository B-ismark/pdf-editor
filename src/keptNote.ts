import { plural } from "./plural";

/**
 * What to say when fields chosen to be flattened stayed a form: their look
 * couldn't be drawn (text the built-in font lacks, a layout it can't do).
 * Named, so the user knows which to check — up to three, then a count.
 * `files`, when given, is the file each name is in, entry for entry — the
 * name in the ZIP for Download all, where two tabs can share a file name.
 *
 * Only for output that is still a PDF: a picture of the page (Export as
 * images, Print, a rasterising Compress) shows the answer and has no form.
 */
export function keptFillableNote(names: string[], files?: string[]): string {
  if (names.length === 0) return "";
  const shown = names.slice(0, 3).map((n, i) => `“${n}”${files ? ` in ${files[i]}` : ""}`);
  const rest = names.length - shown.length;
  const list =
    rest > 0
      ? `${shown.join(", ")} and ${plural(rest, "other")}`
      : shown.length > 1
        ? `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`
        : shown[0];
  const one = names.length === 1;
  return ` ${list} ${one ? "stays" : "stay"} fillable — ${one ? "it" : "they"} couldn't be drawn into the page.`;
}
