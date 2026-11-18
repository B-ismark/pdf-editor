import type { CropRect } from "./types";
import {
  PDFArray,
  PDFBool,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFObjectCopier,
  PDFRef,
  degrees,
  type PDFObject,
  type PDFPage,
} from "@cantoo/pdf-lib";
import { sanitizeDocument } from "./sanitize";
import { collectGarbage, cutDeletedPages, retargetPageRefs } from "./structure";

/** One page slot in an organize plan: which source document, which page in it,
 * and how much extra rotation the user applied (added to the page's own). */
export interface PlanEntry {
  /** Key into the sources map (e.g. "main" or an added file id). */
  sourceKey: string;
  /** 0-based page index within that source. */
  index: number;
  /** Extra clockwise rotation in degrees (0/90/180/270). */
  rotation: number;
  /** The document's own crop for this page (`PageRef.crop`), carried so the
   * grid shows it and a plain rearrange keeps it. Never read by
   * `buildFromPlan`: a cropped document is baked first, crop included. */
  crop?: CropRect;
}

/** Cache of loaded pdf-lib source documents keyed by buffer identity. */
const srcCache = new WeakMap<ArrayBuffer, Promise<PDFDocument>>();

function loadSource(bytes: ArrayBuffer): Promise<PDFDocument> {
  let doc = srcCache.get(bytes);
  if (!doc) {
    doc = PDFDocument.load(bytes.slice(0));
    srcCache.set(bytes, doc);
  }
  return doc;
}

/**
 * Build a new PDF from an ordered page plan. Pages are copied from their
 * source documents in plan order, with the user's extra rotation added to
 * each page's existing rotation. Handles reorder, delete (omit), merge
 * (multiple sources), and extract (a subset plan).
 *
 * Copies with one `copyPages` call per source. Each call has its own object
 * copier, and the copier is what notices that two pages share a font or an
 * image — so one call per page deep-copied every shared resource once *per
 * page* (a twelve-page file sharing one image came out with twelve). A page
 * the plan uses twice is fine in one call: the copier clones the page itself
 * each time it's asked, and only its resources are shared.
 */
export async function buildFromPlan(
  plan: PlanEntry[],
  sources: Map<string, ArrayBuffer>,
  opts: {
    /** The result goes straight to a download (Extract, Split) rather than
     * back into the editor: it gets the exporter's scrub — scripts, launch
     * actions, attachments, page XMP — since nothing else will scrub it. */
    forDownload?: boolean;
  } = {},
): Promise<Uint8Array> {
  // No pdf-lib Producer / Creator / dates: the file says nothing of the tool.
  const out = await PDFDocument.create({ updateMetadata: false });

  // Load each distinct source once.
  const docs = new Map<string, PDFDocument>();
  for (const key of new Set(plan.map((p) => p.sourceKey))) {
    const bytes = sources.get(key);
    if (!bytes) throw new Error(`Missing source "${key}"`);
    docs.set(key, await loadSource(bytes));
  }

  const slotsBySource = new Map<string, number[]>();
  plan.forEach((entry, slot) => {
    const slots = slotsBySource.get(entry.sourceKey) ?? [];
    slots.push(slot);
    slotsBySource.set(entry.sourceKey, slots);
  });

  const pages = new Array<PDFPage>(plan.length);
  for (const [key, slots] of slotsBySource) {
    const copied = await out.copyPages(docs.get(key)!, slots.map((s) => plan[s].index));
    slots.forEach((slot, i) => (pages[slot] = copied[i]));
  }

  plan.forEach((entry, slot) => {
    const page = pages[slot];
    if (entry.rotation % 360 !== 0) {
      const current = page.getRotation().angle;
      page.setRotation(degrees((current + entry.rotation) % 360));
    }
    out.addPage(page);
  });

  // The copier follows every reference on a page, so a link (or any other
  // reference) to another page copies that page a second time, outside the
  // tree — whether or not the plan kept it. The copier clones each page dict
  // afresh but shares everything below it within one `copyPages` call, so a
  // stray and the kept copy of the same source page hold the very same
  // `/Contents`: such a stray is a twin, and what points at it is moved to the
  // kept copy. Only a page the plan left out has no twin; it's cut like a
  // deleted page — the link goes, and nothing reaches it.
  const inTree = new Set(out.getPages().map((p) => p.ref));
  const byContents = new Map<unknown, PDFRef>();
  for (const p of out.getPages()) {
    const c = p.node.get(PDFName.of("Contents"));
    if (c) byContents.set(c, p.ref);
  }
  const twins = new Map<PDFRef, PDFRef>();
  const stray = new Set<PDFRef>();
  for (const [ref, obj] of out.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFDict) || obj.get(PDFName.of("Type")) !== PDFName.of("Page") || inTree.has(ref)) continue;
    const c = obj.get(PDFName.of("Contents"));
    const twin = c ? byContents.get(c) : undefined;
    if (twin) twins.set(ref, twin);
    else stray.add(ref);
  }
  if (twins.size > 0) retargetPageRefs(out, twins);
  if (stray.size > 0) cutDeletedPages(out, stray);
  const prunedForm = rebuildForm(out, plan.map((p) => docs.get(p.sourceKey)!));
  if (opts.forDownload) sanitizeDocument(out);
  // What was cut or scrubbed is unreachable now; the copier had already
  // copied it (an attachment's bytes, a stray page), so drop it from the file.
  if (stray.size > 0 || twins.size > 0 || prunedForm || opts.forDownload) collectGarbage(out);

  return out.save();
}

/** Count the pages in a PDF (used when merging an added file). */
export async function pageCount(bytes: ArrayBuffer): Promise<number> {
  const doc = await loadSource(bytes);
  return doc.getPageCount();
}

/** A page's size as it shows — its crop box, turned by its own `/Rotate` plus
 * `extra` — for a blank page inserted beside it to match. */
export async function shownPageSize(
  bytes: ArrayBuffer,
  index: number,
  extra: number,
  /** The plan's crop of it, if any: the page shows that much. */
  crop?: CropRect,
): Promise<{ width: number; height: number }> {
  const doc = await loadSource(bytes);
  const page = doc.getPage(Math.min(index, doc.getPageCount() - 1));
  const { width, height } = crop ?? page.getCropBox();
  const turn = (((page.getRotation().angle + extra) % 360) + 360) % 360;
  return turn % 180 === 0 ? { width, height } : { width: height, height: width };
}

/**
 * Give the new document the form its pages' fields belong to.
 *
 * `copyPages` copies a page's field widgets (and, through `/Parent`, their
 * fields) but not the document's `/AcroForm`, which is what makes them a form:
 * without it the fields are inert drawings, and a value typed after Organise
 * had nowhere to go. The form is rebuilt from the fields the kept pages show.
 * A field's widgets on pages left out are dropped from it.
 *
 * Merged files each bring their own form defaults. The first one's `/DA` and
 * `/Q` become the form's; a field from another file whose defaults differ gets
 * its file's own, written onto it. Every file's `/DR` resources are merged (a
 * name already taken keeps the first), and `/NeedAppearances` holds if any
 * file asked for it.
 *
 * `pageSources[i]` is the document page `i` of `out` was copied from.
 * Returns whether anything was dropped (so it can be collected).
 */
function rebuildForm(out: PDFDocument, pageSources: PDFDocument[]): boolean {
  const ctx = out.context;
  const look = (o: PDFObject | undefined) => (o instanceof PDFRef ? ctx.lookup(o) : o);
  const KIDS = PDFName.of("Kids");
  const PARENT = PDFName.of("Parent");

  // The widgets the kept pages show, and the file each came from.
  const widgets = new Map<PDFRef, PDFDocument>();
  out.getPages().forEach((page, i) => {
    const annots = look(page.node.get(PDFName.of("Annots")));
    if (!(annots instanceof PDFArray)) return;
    for (let j = 0; j < annots.size(); j++) {
      const ref = annots.get(j);
      const a = look(ref);
      if (ref instanceof PDFRef && a instanceof PDFDict && a.get(PDFName.of("Subtype")) === PDFName.of("Widget")) {
        if (!widgets.has(ref)) widgets.set(ref, pageSources[i]);
      }
    }
  });
  if (widgets.size === 0) return false;

  // Their top-level fields, in page order, each with its file.
  const roots: PDFRef[] = [];
  const rootSource = new Map<PDFRef, PDFDocument>();
  for (const [w, src] of widgets) {
    let ref = w;
    const seen = new Set<PDFRef>([ref]);
    for (;;) {
      const up = (look(ref) as PDFDict).get(PARENT);
      if (!(up instanceof PDFRef) || seen.has(up) || !(look(up) instanceof PDFDict)) break;
      seen.add(up);
      ref = up;
    }
    if (!rootSource.has(ref)) {
      rootSource.set(ref, src);
      roots.push(ref);
    }
  }

  // Drop the widgets (and then empty fields) the plan left behind.
  let pruned = false;
  const keep = (ref: PDFRef, depth: number): boolean => {
    if (widgets.has(ref)) return true;
    const node = look(ref);
    if (!(node instanceof PDFDict) || depth > 32) return false;
    const kids = look(node.get(KIDS));
    if (!(kids instanceof PDFArray)) return false; // a widget on no kept page
    for (let i = kids.size() - 1; i >= 0; i--) {
      const k = kids.get(i);
      if (!(k instanceof PDFRef) || !keep(k, depth + 1)) {
        kids.remove(i);
        pruned = true;
      }
    }
    return kids.size() > 0;
  };
  const fields = roots.filter((r) => keep(r, 0));
  if (fields.length === 0) return pruned;

  const acro = ctx.obj({ Fields: ctx.obj(fields) }) as PDFDict;
  // Each source file's form, in the order its fields first appear.
  const forms = new Map<PDFDocument, { dict: PDFDict; copier: PDFObjectCopier }>();
  for (const r of fields) {
    const src = rootSource.get(r)!;
    if (forms.has(src)) continue;
    const f = src.catalog.lookup(PDFName.of("AcroForm"));
    if (f instanceof PDFDict) forms.set(src, { dict: f, copier: PDFObjectCopier.for(src.context, ctx) });
  }
  const DA = PDFName.of("DA");
  const Q = PDFName.of("Q");
  const DR = PDFName.of("DR");
  const NEED = PDFName.of("NeedAppearances");
  const same = (a: PDFObject | undefined, b: PDFObject | undefined) => String(a) === String(b);
  const first = [...forms.values()][0];
  if (first) {
    for (const key of [DA, Q]) {
      const v = first.dict.get(key);
      if (v !== undefined) acro.set(key, first.copier.copy(v));
    }
  }
  // Resources: every file's, by category; a name already taken keeps the first.
  const dr = ctx.obj({}) as PDFDict;
  let anyDr = false;
  let need = false;
  for (const { dict, copier } of forms.values()) {
    if (dict.lookup(NEED) === PDFBool.True) need = true;
    const res = dict.lookup(DR);
    if (!(res instanceof PDFDict)) continue;
    anyDr = true;
    for (const [cat, val] of res.entries()) {
      const group = res.context.lookup(val);
      if (group instanceof PDFDict) {
        const had = dr.lookup(cat);
        const into = had instanceof PDFDict ? had : (ctx.obj({}) as PDFDict);
        if (into !== had) dr.set(cat, into);
        for (const [name, item] of group.entries()) if (!into.has(name)) into.set(name, copier.copy(item));
      } else if (!dr.has(cat)) {
        dr.set(cat, copier.copy(val));
      }
    }
  }
  if (anyDr) acro.set(DR, dr);
  if (need) acro.set(NEED, PDFBool.True);
  // A field from a later file whose form defaults differ carries its own.
  for (const r of fields) {
    const own = forms.get(rootSource.get(r)!);
    if (!own || own === first) continue;
    const node = look(r) as PDFDict;
    for (const key of [DA, Q]) {
      const v = own.dict.get(key);
      if (v !== undefined && !node.has(key) && !same(own.dict.lookup(key), first?.dict.lookup(key))) {
        node.set(key, own.copier.copy(v));
      }
    }
  }
  out.catalog.set(PDFName.of("AcroForm"), ctx.register(acro));
  return pruned;
}
