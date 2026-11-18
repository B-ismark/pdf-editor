import { PDFArray, PDFDict, PDFDocument, PDFName, PDFStream, PDFString, PDFHexString } from "@cantoo/pdf-lib";
import { isSafeExistingUri } from "./url";

/**
 * Action types allowed to survive on a copied annotation.
 *
 * Everything else is dropped, because the alternative — naming the dangerous
 * ones — misses a long tail that all execute something on the recipient's
 * machine: `/Launch` (run a program), `/SubmitForm` and `/ImportData` (send the
 * document's data to a URL), `/GoToR` and `/GoToE` (reach into another file),
 * `/Movie`, `/Sound`, `/Rendition`, `/RichMedia` (embedded players), and
 * `/JavaScript`. A viewer only needs `/URI` and the in-document jumps to make
 * ordinary links work, so that's the whole list.
 */
const ALLOWED_ACTIONS = new Set(["/URI", "/GoTo", "/Named"]);

/**
 * Catalog entries an exported document may keep. Everything else is removed.
 *
 * An allow-list, for the same reason as {@link ALLOWED_ACTIONS}: the exporter
 * edits the source in place now (so the outline, page labels, tags, named
 * destinations, layers and form survive), which means the output starts with
 * *everything* the source had — and the catalog's long tail is mostly things
 * this app promises not to carry: `/Metadata` (XMP: author, tool, history),
 * `/OpenAction` and `/AA` (auto-run), `/URI` base, `/Threads` (article beads
 * that quote page text), `/PieceInfo` (a producer's private data), `/Perms`,
 * `/DSS`, `/Collection`, `/AF`, and whatever the next spec version adds.
 */
const CATALOG_KEEP = new Set([
  "Type",
  "Version",
  "Extensions",
  "Pages",
  "PageLabels",
  "Names",
  "Dests",
  "ViewerPreferences",
  "PageLayout",
  "PageMode",
  "Outlines",
  "StructTreeRoot",
  "MarkInfo",
  "Lang",
  "OCProperties",
  "AcroForm",
  "OutputIntents",
]);

/** Name trees an exported document may keep: only destinations. JavaScript,
 * EmbeddedFiles, and the rest are either active content or hidden payloads. */
const NAMES_KEEP = new Set(["Dests"]);

/** Page entries that are hidden data rather than the page: a producer's private
 * dictionary, the page's own XMP packet and modification time, its associated
 * files (`/AF` — embedded files by another name), and article beads (`/B`, whose
 * thread carries its own info dictionary). */
const PAGE_DROP = ["AA", "PieceInfo", "Metadata", "LastModified", "AF", "B"];

/**
 * What {@link sanitizeDocument} took out, recorded where it takes it out, so the
 * "Hidden information" report can't describe a different pass from the one the
 * export runs (see `hiddenInfo.ts`).
 */
export interface ScrubReport {
  /** The Info dictionary, entry by entry, as text. */
  info: { key: string; value: string }[];
  /** An XMP metadata packet on the catalog. */
  xmp: boolean;
  /** The file identifier in the trailer. */
  fileId: boolean;
  /** Something runs when the file opens (`/OpenAction` or the catalog's `/AA`). */
  autoRun: boolean;
  /** Document-level scripts (the JavaScript name tree). */
  scripts: number;
  /** Trigger dictionaries (`/AA`) on pages, fields, annotations and bookmarks:
   * things that run when you focus, type, open a page… */
  triggers: number;
  /** Actions taken off links, bookmarks and fields, by type (`JavaScript`,
   * `Launch`, `SubmitForm`, an unsafe `URI`…). */
  actions: Record<string, number>;
  /** Embedded files, by name (the name tree and attachment annotations). */
  attachments: string[];
  /** Media, 3D and screen annotations. */
  media: number;
  /** An XFA form (a second, scriptable form alongside the visible one). */
  xfa: boolean;
  /** Private data and per-object metadata on pages, images and drawings. */
  privateData: number;
  /** Other catalog entries dropped (by name, e.g. `Threads`, `PieceInfo`). */
  other: string[];
}

export const emptyScrubReport = (): ScrubReport => ({
  info: [],
  xmp: false,
  fileId: false,
  autoRun: false,
  scripts: 0,
  triggers: 0,
  actions: {},
  attachments: [],
  media: 0,
  xfa: false,
  privateData: 0,
  other: [],
});

/** Same idea for image and form XObjects, which carry their own copies. */
const XOBJECT_DROP = ["PieceInfo", "Metadata", "LastModified", "AF"];

/** Annotations that *are* a payload or a player rather than a mark on the page:
 * an attached file, embedded media, 3D (whose stream can carry JavaScript). */
const ANNOT_DROP = new Set(["/FileAttachment", "/RichMedia", "/3D", "/Movie", "/Sound", "/Screen"]);

/** `/Named` actions that only move around the document. Viewers also accept
 * menu items here (Print, SaveAs, …), which is not something a link should do. */
const SAFE_NAMED = new Set(["/NextPage", "/PrevPage", "/FirstPage", "/LastPage"]);

/** What a form may carry: its fields and the defaults for drawing them. `/DR`
 * is cut down to fonts and encodings, since an XObject parked in it is reachable
 * from the catalog without being on any page. */
const ACROFORM_KEEP = new Set(["Fields", "DR", "DA", "Q", "NeedAppearances", "SigFlags", "CO"]);
const DR_KEEP = new Set(["Font", "Encoding"]);

/**
 * Strip identifying and potentially-active hidden data from a document before
 * it leaves the browser: document metadata (Info dictionary + XMP), creation/
 * modification timestamps, the file identifier, embedded JavaScript, embedded
 * files, auto-run actions, and any catalog entry not on {@link CATALOG_KEEP}.
 *
 * This makes the app's privacy promise concrete — a downloaded copy should not
 * silently carry who made it, when, or with what tool, nor any active content
 * that runs when the file is opened. The exporter edits the *source* document
 * in place (to keep its structure), so this pass is the whole defence: nothing
 * about the input is assumed clean. Actions are checked everywhere a viewer
 * will run one — annotations, outline items, and form fields.
 *
 * Best-effort and defensive: a malformed object anywhere is skipped rather than
 * failing the whole export. Callers MUST save with `updateMetadata: false` so
 * pdf-lib doesn't re-stamp Producer/CreationDate/ModDate afterwards.
 */
export function sanitizeDocument(doc: PDFDocument, report: ScrubReport = emptyScrubReport()): ScrubReport {
  const ctx = doc.context;
  const catalog = doc.catalog;
  const deref = (obj: unknown) => (obj ? ctx.lookup(obj as never) : undefined);

  // 1) Empty the Info dictionary — author/tool/timestamps and all. pdf-lib
  //    stamps its own Producer + CreationDate/ModDate when the output document
  //    is created, so deleting these here (just before save) is what actually
  //    keeps them out of the downloaded file.
  try {
    // Every key, not a list of the standard ones: producers add their own
    // (`/Company`, `/SourceModified`, a DMS document number), and those are
    // exactly the identifying kind.
    const info = deref(ctx.trailerInfo.Info);
    if (info instanceof PDFDict) {
      for (const key of info.keys()) {
        report.info.push({ key: key.decodeText(), value: textOf(deref(info.get(key))) });
        info.delete(key);
      }
    }
  } catch {
    /* no / malformed Info dict */
  }
  // The file identifier ties the copy to the original it was made from.
  if ((ctx.trailerInfo as { ID?: unknown }).ID) report.fileId = true;
  delete (ctx.trailerInfo as { ID?: unknown }).ID;

  // 2) Remove the XMP metadata stream and any document-level auto-run/extra
  //    actions (OpenAction and AA are common JavaScript triggers).
  for (const key of catalog.keys()) {
    const name = key.decodeText();
    if (CATALOG_KEEP.has(name)) continue;
    if (name === "Metadata") report.xmp = true;
    else if (name === "OpenAction" || name === "AA") report.autoRun = true;
    else if (name === "PieceInfo") report.privateData++;
    else if (name === "AF") countFiles(deref(catalog.get(key)), deref, report);
    else report.other.push(name);
    catalog.delete(key);
  }

  // 3) Remove embedded JavaScript + embedded files from the Names tree, and XFA
  //    (which can carry active content) from any AcroForm.
  try {
    const names = deref(catalog.get(PDFName.of("Names")));
    if (names instanceof PDFDict) {
      for (const key of names.keys()) {
        const name = key.decodeText();
        if (NAMES_KEEP.has(name)) continue;
        const leaves = nameTreeLeaves(deref(names.get(key)), deref);
        if (name === "JavaScript") report.scripts += Math.max(1, leaves.length);
        else if (name === "EmbeddedFiles") for (const [n, spec] of leaves) report.attachments.push(fileName(spec, deref) || n);
        else report.other.push(`Names/${name}`);
        names.delete(key);
      }
    }
  } catch {
    /* ignore */
  }
  try {
    const acro = deref(catalog.get(PDFName.of("AcroForm")));
    if (acro instanceof PDFDict) {
      // XFA (active content) goes with everything else not on the list.
      for (const key of acro.keys()) {
        const name = key.decodeText();
        if (ACROFORM_KEEP.has(name)) continue;
        if (name === "XFA") report.xfa = true;
        else report.other.push(`AcroForm/${name}`);
        acro.delete(key);
      }
      const dr = deref(acro.get(PDFName.of("DR")));
      if (dr instanceof PDFDict) {
        const kept = ctx.obj({});
        for (const [key, value] of dr.entries()) if (DR_KEEP.has(key.decodeText())) kept.set(key, value);
        acro.set(PDFName.of("DR"), kept);
      }
      // Field-level actions: format/keystroke/calculate scripts live in /AA on
      // the *field*, which for a non-terminal field is not an annotation and so
      // not reached by step 4.
      const seen = new Set<PDFDict>();
      const walk = (arr: unknown, depth: number) => {
        if (!(arr instanceof PDFArray) || depth > 32) return;
        for (let i = 0; i < arr.size(); i++) {
          const node = deref(arr.get(i));
          if (!(node instanceof PDFDict) || seen.has(node)) continue;
          seen.add(node);
          scrubActions(node, deref, report);
          walk(deref(node.get(PDFName.of("Kids"))), depth + 1);
        }
      };
      walk(deref(acro.get(PDFName.of("Fields"))), 0);
    }
  } catch {
    /* ignore */
  }

  // 3b) Outline items run actions too (a bookmark can be `/JavaScript` or
  //     `/Launch`); keep the safe ones, which is what makes bookmarks work.
  try {
    const root = deref(catalog.get(PDFName.of("Outlines")));
    const seen = new Set<PDFDict>();
    const stack: unknown[] = root instanceof PDFDict ? [root.get(PDFName.of("First"))] : [];
    while (stack.length && seen.size < 100_000) {
      const item = deref(stack.pop());
      if (!(item instanceof PDFDict) || seen.has(item)) continue;
      seen.add(item);
      scrubActions(item, deref, report);
      stack.push(item.get(PDFName.of("Next")), item.get(PDFName.of("First")));
    }
  } catch {
    /* ignore */
  }

  // 4) Scrub page-level additional actions and every annotation action that
  //    isn't a plain link. Ordinary URI/GoTo links are preserved (and their
  //    URIs scheme-checked) so real links keep working.
  for (const page of doc.getPages()) {
    for (const key of PAGE_DROP) {
      try {
        const name = PDFName.of(key);
        const value = page.node.get(name);
        if (value === undefined) continue;
        if (key === "AA") report.triggers++;
        else if (key === "AF") countFiles(deref(value), deref, report);
        else if (key === "B") report.other.push("B");
        else report.privateData++;
        page.node.delete(name);
      } catch {
        /* ignore */
      }
    }
    let annots: unknown;
    try {
      annots = deref(page.node.get(PDFName.of("Annots")));
    } catch {
      annots = undefined;
    }
    if (!(annots instanceof PDFArray)) continue;
    for (let i = annots.size() - 1; i >= 0; i--) {
      let annot: unknown;
      try {
        annot = ctx.lookup(annots.get(i));
      } catch {
        continue;
      }
      if (!(annot instanceof PDFDict)) continue;
      const subtype = String(annot.get(PDFName.of("Subtype")));
      if (ANNOT_DROP.has(subtype)) {
        if (subtype === "/FileAttachment") report.attachments.push(fileName(deref(annot.get(PDFName.of("FS"))), deref) || "Attachment");
        else report.media++;
        annots.remove(i);
        continue;
      }
      scrubActions(annot, deref, report);
    }
  }

  // 5) Private data riding on images and forms.
  for (const [, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFStream)) continue;
    const subtype = String(obj.dict.get(PDFName.of("Subtype")));
    if (subtype !== "/Image" && subtype !== "/Form") continue;
    for (const key of XOBJECT_DROP) {
      const name = PDFName.of(key);
      if (!obj.dict.has(name)) continue;
      if (key === "AF") countFiles(deref(obj.dict.get(name)), deref, report);
      else report.privateData++;
      obj.dict.delete(name);
    }
  }
  return report;
}

/** A PDF string, name, number or date as plain text. */
function textOf(v: unknown): string {
  if (v instanceof PDFString || v instanceof PDFHexString) return v.decodeText();
  if (v instanceof PDFName) return v.decodeText();
  if (v === undefined || v === null) return "";
  return String(v);
}

/** The file name a file specification gives (`/UF`, then `/F`). */
function fileName(spec: unknown, deref: (obj: unknown) => unknown): string {
  if (spec instanceof PDFString || spec instanceof PDFHexString) return spec.decodeText();
  if (!(spec instanceof PDFDict)) return "";
  return textOf(deref(spec.get(PDFName.of("UF")))) || textOf(deref(spec.get(PDFName.of("F"))));
}

/** Associated files (`/AF`, an array of file specifications). */
function countFiles(arr: unknown, deref: (obj: unknown) => unknown, report: ScrubReport) {
  if (!(arr instanceof PDFArray)) return;
  for (let i = 0; i < arr.size(); i++) report.attachments.push(fileName(deref(arr.get(i)), deref) || "Attachment");
}

/** A name tree's leaves as [key, value] pairs (with a cap, for a malformed
 * tree that loops). */
function nameTreeLeaves(root: unknown, deref: (obj: unknown) => unknown): [string, unknown][] {
  const out: [string, unknown][] = [];
  const seen = new Set<unknown>();
  const stack = [root];
  while (stack.length && seen.size < 10_000) {
    const node = stack.pop();
    if (!(node instanceof PDFDict) || seen.has(node)) continue;
    seen.add(node);
    const names = deref(node.get(PDFName.of("Names")));
    if (names instanceof PDFArray) {
      for (let i = 0; i + 1 < names.size(); i += 2) out.push([textOf(deref(names.get(i))), deref(names.get(i + 1))]);
    }
    const kids = deref(node.get(PDFName.of("Kids")));
    if (kids instanceof PDFArray) for (let i = 0; i < kids.size(); i++) stack.push(deref(kids.get(i)));
  }
  return out;
}

/** Drop `/AA` outright and `/A` unless it's a plain, inert link. */
function scrubActions(dict: PDFDict, deref: (obj: unknown) => unknown, report: ScrubReport): void {
  try {
    if (dict.has(PDFName.of("AA"))) report.triggers++;
    dict.delete(PDFName.of("AA"));
  } catch {
    /* ignore */
  }
  try {
    const action = deref(dict.get(PDFName.of("A")));
    if (action !== undefined && !(action instanceof PDFDict && isSafeAction(action, deref))) {
      const kind = action instanceof PDFDict ? unsafeKind(action, deref) : "Other";
      report.actions[kind] = (report.actions[kind] ?? 0) + 1;
      dict.delete(PDFName.of("A"));
    }
  } catch {
    /* ignore */
  }
}

/** Why an action was refused: the type of the first link in its chain that
 * isn't allowed ("JavaScript", "Launch"…), or "URI" for a link whose address
 * isn't safe, or "Named" for a menu command. */
function unsafeKind(action: PDFDict, deref: (obj: unknown) => unknown, depth = 0): string {
  const s = action.get(PDFName.of("S"));
  const name = s instanceof PDFName ? s.decodeText() : "Other";
  if (depth > 8 || !ALLOWED_ACTIONS.has(`/${name}`)) return name;
  if (!isSafeAction(shallow(action), deref)) return name;
  const next = deref(action.get(PDFName.of("Next")));
  const items = next instanceof PDFArray ? Array.from({ length: next.size() }, (_, i) => deref(next.get(i))) : [next];
  for (const n of items) if (n instanceof PDFDict && !isSafeAction(n, deref)) return unsafeKind(n, deref, depth + 1);
  return name;
}

/** The action without its chain, to judge it on its own. */
function shallow(action: PDFDict): PDFDict {
  const copy = action.clone();
  copy.delete(PDFName.of("Next"));
  return copy;
}

/**
 * True when an action dictionary is a plain, inert link we're happy to keep.
 *
 * Three things have to hold, and the third is the one that's easy to miss: an
 * action can chain to further actions through `/Next`, so a permitted `/URI`
 * can tow a `/JavaScript` behind it. The chain is walked (with a depth cap, in
 * case a malformed file loops back on itself) and any disallowed link in it
 * rejects the whole action.
 */
function isSafeAction(
  action: PDFDict,
  deref: (obj: unknown) => unknown,
  depth = 0,
): boolean {
  if (depth > 8) return false;

  const s = action.get(PDFName.of("S"));
  if (!(s instanceof PDFName) || !ALLOWED_ACTIONS.has(s.toString())) return false;

  if (s.toString() === "/Named") {
    const n = action.get(PDFName.of("N"));
    if (!(n instanceof PDFName) || !SAFE_NAMED.has(n.toString())) return false;
  }
  // A /GoTo's structure destination (/SD) points into the tagged-PDF tree,
  // which would keep the whole tree — and its /ActualText for every page —
  // reachable after the exporter dropped it. /D is the destination that
  // matters; /SD only refines it. (A side effect in a predicate, but the
  // alternative is a second walk of the same /Next chain.)
  if (s.toString() === "/GoTo") action.delete(PDFName.of("SD"));

  // A kept /URI must also point somewhere harmless.
  if (s.toString() === "/URI") {
    const uri = action.get(PDFName.of("URI"));
    const text =
      uri instanceof PDFString || uri instanceof PDFHexString
        ? uri.decodeText()
        : null;
    if (text === null || !isSafeExistingUri(text)) return false;
  }

  const next = deref(action.get(PDFName.of("Next")));
  if (next instanceof PDFDict) return isSafeAction(next, deref, depth + 1);
  if (next instanceof PDFArray) {
    for (let i = 0; i < next.size(); i++) {
      const item = deref(next.get(i));
      if (!(item instanceof PDFDict) || !isSafeAction(item, deref, depth + 1)) {
        return false;
      }
    }
  }
  return true;
}
