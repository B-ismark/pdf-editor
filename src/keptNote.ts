import { plural } from "./plural";

/** "a", "a and b", "a, b and c". */
function andList(xs: string[]): string {
  return xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}` : xs[0];
}

/** How many fields are named before the rest are counted. */
const NAMED = 3;

/**
 * What to say when fields chosen to be flattened stayed a form: their look
 * couldn't be drawn (text the built-in font lacks, a layout it can't do).
 * Named, so the user knows which to check — up to three, then a count.
 *
 * `files`, when given, is the file each name is in, entry for entry — the
 * name in the ZIP for Download all, where two tabs can share a file name.
 * The names are grouped by file, and every file is named, even one whose
 * fields are all past the first three: it's the file the user has to open.
 *
 * Only for output that is still a PDF: a picture of the page (Export as
 * images, Print, a rasterising Compress) shows the answer and has no form.
 */
export function keptFillableNote(names: string[], files?: string[]): string {
  if (names.length === 0) return "";
  const quote = (n: string) => `“${n}”`;
  let list: string;
  if (!files) {
    const shown = names.slice(0, NAMED).map(quote);
    const rest = names.length - shown.length;
    list = andList(rest > 0 ? [...shown, plural(rest, "other")] : shown);
  } else {
    const byFile = new Map<string, string[]>();
    names.forEach((n, i) => {
      const group = byFile.get(files[i]) ?? [];
      group.push(n);
      byFile.set(files[i], group);
    });
    let room = NAMED;
    const groups: string[] = [];
    for (const [file, group] of byFile) {
      const shown = group.slice(0, room).map(quote);
      room -= shown.length;
      const rest = group.length - shown.length;
      const parts = rest > 0 ? [...shown, plural(rest, shown.length > 0 ? "other" : "field")] : shown;
      groups.push(`${andList(parts)} (in ${file})`);
    }
    list = andList(groups);
  }
  const one = names.length === 1;
  return ` ${list} ${one ? "stays" : "stay"} fillable — ${one ? "it" : "they"} couldn't be drawn into the page.`;
}
