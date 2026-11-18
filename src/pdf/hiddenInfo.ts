import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFString } from "@cantoo/pdf-lib";
import { ANNOT_DROP, emptyScrubReport, sanitizeDocument, type ScrubReport } from "./sanitize";

/**
 * What a document carries that you can't see on the page, for the "Hidden
 * information" report.
 *
 * `removed` is what the export takes out. It comes from running the export's
 * own pass (`sanitizeDocument`) over a throwaway copy, so the report can't
 * describe a different clean-up from the one the download gets.
 *
 * `kept` is hidden in plain sight and survives export, because removing it would
 * change the document: comment authors' names, and content on layers that are
 * switched off. (Text covered by an edit is the editor's to count: see
 * `coveredCount` in `DocumentEditor`.)
 *
 * Loads pdf-lib, so call it lazily (`await import`) — never from the render path.
 */
export interface HiddenInfo {
  removed: ScrubReport;
  kept: {
    /** Comments and markup from the file, and the names they're signed with. */
    comments: number;
    authors: string[];
    /** Layers switched off, by name. Their content is in the file, unseen. */
    hiddenLayers: string[];
  };
}

/** Subtypes that aren't comments: links, form fields, a comment's pop-up. (And
 * the sanitiser's `ANNOT_DROP`: attachments and players, which export removes.) */
const NOT_COMMENTS = new Set(["/Link", "/Widget", "/Popup"]);

/**
 * @param ships whether a source page (0-based) keeps its own content in the
 *   download: false for a page deleted in the plan, or one a true redaction
 *   flattens to a picture. Its comments don't ship, so they aren't "kept".
 */
export async function inspectHidden(bytes: ArrayBuffer, ships: (pageIndex: number) => boolean = () => true): Promise<HiddenInfo> {
  const doc = await PDFDocument.load(bytes.slice(0), { updateMetadata: false });
  const ctx = doc.context;
  const deref = (obj: unknown) => (obj ? ctx.lookup(obj as never) : undefined);
  const text = (v: unknown) => (v instanceof PDFString || v instanceof PDFHexString ? v.decodeText().trim() : "");

  // Kept: read before the scrub, which doesn't touch either.
  let comments = 0;
  const authors = new Set<string>();
  for (const [index, page] of doc.getPages().entries()) {
    if (!ships(index)) continue;
    try {
      const annots = deref(page.node.get(PDFName.of("Annots")));
      if (!(annots instanceof PDFArray)) continue;
      for (let i = 0; i < annots.size(); i++) {
        const a = deref(annots.get(i));
        if (!(a instanceof PDFDict)) continue;
        const subtype = String(a.get(PDFName.of("Subtype")));
        if (NOT_COMMENTS.has(subtype) || ANNOT_DROP.has(subtype)) continue;
        comments++;
        const who = text(deref(a.get(PDFName.of("T"))));
        if (who) authors.add(who);
      }
    } catch {
      /* a malformed page: skip it */
    }
  }

  const hiddenLayers: string[] = [];
  try {
    const oc = deref(doc.catalog.get(PDFName.of("OCProperties")));
    const d = oc instanceof PDFDict ? deref(oc.get(PDFName.of("D"))) : undefined;
    const list = (key: string, from: unknown = d) => {
      const arr = from instanceof PDFDict ? deref(from.get(PDFName.of(key))) : undefined;
      const out: PDFDict[] = [];
      if (arr instanceof PDFArray) for (let i = 0; i < arr.size(); i++) {
        const g = deref(arr.get(i));
        if (g instanceof PDFDict && !out.includes(g)) out.push(g);
      }
      return out;
    };
    // `/BaseState /OFF` switches every layer off but those listed `/ON`.
    const base = d instanceof PDFDict ? d.get(PDFName.of("BaseState")) : undefined;
    const on = list("ON");
    const off = String(base) === "/OFF" ? list("OCGs", oc).filter((g) => !on.includes(g)) : list("OFF");
    for (const g of off) hiddenLayers.push(text(deref(g.get(PDFName.of("Name")))) || "Untitled layer");
  } catch {
    /* no layers */
  }

  const removed = sanitizeDocument(doc, emptyScrubReport());
  return { removed, kept: { comments, authors: [...authors], hiddenLayers } };
}

/** One row of the report. */
export interface HiddenRow {
  id: string;
  title: string;
  detail: string;
  /** Label and value pairs, shown as a list under the title (the properties). */
  facts?: { label: string; value: string }[];
}

/** Info keys in words. Anything else is a producer's own entry, named as is. */
const INFO_LABEL: Record<string, string> = {
  Title: "Title",
  Author: "Author",
  Subject: "Subject",
  Keywords: "Keywords",
  Creator: "Made with",
  Producer: "Converted by",
  CreationDate: "Created",
  ModDate: "Last changed",
  Trapped: "Print trapping",
};

/** "D:20240312143000+01'00'" → "12 Mar 2024, 14:30". Anything else as written. */
export function pdfDate(v: string): string {
  const m = /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?/.exec(v);
  if (!m) return v;
  const [, y, mo = "01", d = "01", h, mi] = m;
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][+mo - 1];
  if (!month) return v;
  return `${+d} ${month} ${y}${h ? `, ${h}:${mi ?? "00"}` : ""}`;
}

/** A key the table itself has (not one from Object's prototype, such as a
 * file's Info key `/constructor`). */
const own = (table: object, k: string) => Object.prototype.hasOwnProperty.call(table, k);

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Action types in words. */
const ACTION_LABEL: Record<string, string> = {
  JavaScript: "runs a script",
  Launch: "opens a program or file",
  SubmitForm: "sends form data to a website",
  ImportData: "loads data from another file",
  GoToR: "opens another PDF",
  GoToE: "opens an embedded PDF",
  URI: "opens an unsafe address",
  Named: "runs a menu command",
  ResetForm: "clears the form",
  Hide: "hides parts of the page",
  Other: "does something that can't be checked",
};

/** The report's rows: what export removes, then what it keeps. */
export function hiddenRows(info: HiddenInfo, covered: number): { removed: HiddenRow[]; kept: HiddenRow[] } {
  const r = info.removed;
  const removed: HiddenRow[] = [];
  // In the order a person reads them: what it is, who, then the tools and
  // dates. A producer's own entries go after the known ones.
  const order = Object.keys(INFO_LABEL);
  const rank = (k: string) => (own(INFO_LABEL, k) ? order.indexOf(k) : order.length);
  const fields = r.info.filter((e) => e.value.trim()).sort((a, b) => rank(a.key) - rank(b.key));
  if (fields.length) {
    removed.push({
      id: "info",
      title: "Document properties",
      detail: "",
      facts: fields.map((e) => ({
        label: own(INFO_LABEL, e.key) ? INFO_LABEL[e.key] : e.key,
        value: e.key.endsWith("Date") ? pdfDate(e.value) : e.value,
      })),
    });
  }
  if (r.xmp) removed.push({ id: "xmp", title: "Metadata packet", detail: "A second copy of the properties, often with the file's editing history" });
  if (r.fileId) removed.push({ id: "fileid", title: "File identifier", detail: "Links copies of this file back to the original" });
  if (r.attachments.length) {
    removed.push({ id: "attachments", title: plural(r.attachments.length, "attached file", "attached files"), detail: [...new Set(r.attachments)].join(", ") });
  }
  const scripts = r.scripts + (r.actions.JavaScript ?? 0);
  if (r.autoRun || scripts || r.triggers) {
    const parts = [
      r.autoRun && "something runs when the file opens",
      scripts && plural(scripts, "script", "scripts"),
      r.triggers && plural(r.triggers, "automatic action", "automatic actions"),
    ].filter(Boolean);
    removed.push({ id: "scripts", title: "Scripts and automatic actions", detail: cap(parts.join(" · ")) });
  }
  const acts = Object.entries(r.actions).filter(([k]) => k !== "JavaScript");
  if (acts.length) {
    const n = acts.reduce((t, [, c]) => t + c, 0);
    removed.push({
      id: "actions",
      title: plural(n, "link that does more than open a page", "links that do more than open a page"),
      detail: cap(acts.map(([k, c]) => `${c} ${own(ACTION_LABEL, k) ? ACTION_LABEL[k] : `runs a ${k} action`}`).join(" · ")),
    });
  }
  if (r.media) removed.push({ id: "media", title: plural(r.media, "embedded player", "embedded players"), detail: "Video, sound or 3D that plays inside the file" });
  if (r.xfa) removed.push({ id: "xfa", title: "Second form layer (XFA)", detail: "A scriptable copy of the form most viewers never show" });
  if (r.privateData) removed.push({ id: "private", title: "Private app data", detail: `Left by the apps that made the file, on ${plural(r.privateData, "page, image or drawing", "pages, images or drawings")}` });
  const other = [...new Set(r.other)];
  if (other.length) removed.push({ id: "other", title: "Other hidden entries", detail: other.join(", ") });

  const kept: HiddenRow[] = [];
  if (covered) {
    kept.push({
      id: "covered",
      title: "Text under your edits",
      detail: `${plural(covered, "place", "places")} where what you've edited or whited out is covered, not removed. Redact it to remove it for good.`,
    });
  }
  const k = info.kept;
  if (k.comments) {
    kept.push({
      id: "comments",
      title: plural(k.comments, "comment", "comments"),
      detail: k.authors.length ? `Signed by ${k.authors.join(", ")}` : "Unsigned",
    });
  }
  if (k.hiddenLayers.length) {
    kept.push({
      id: "layers",
      title: plural(k.hiddenLayers.length, "hidden layer", "hidden layers"),
      detail: `${k.hiddenLayers.join(", ")}. Switched off, but still in the file. Redacting a page keeps only what's shown.`,
    });
  }
  return { removed, kept };
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
