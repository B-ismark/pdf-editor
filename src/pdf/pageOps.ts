import type { CropRect } from "./types";
import {
  PDFArray,
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
import { collectGarbage, cutDeletedPages } from "./structure";

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

  // The copier follows every reference on a page, so a link to a page the plan
  // left out copies that page too (contents and all), reachable through the
  // link. Cut it like a deleted page: the link goes, and nothing reaches it.
  const inTree = new Set(out.getPages().map((p) => p.ref));
  const stray = new Set<PDFRef>();
  for (const [ref, obj] of out.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFDict && obj.get(PDFName.of("Type")) === PDFName.of("Page") && !inTree.has(ref)) stray.add(ref);
  }
  if (stray.size > 0) cutDeletedPages(out, stray);
  const prunedForm = rebuildForm(out, [...docs.values()]);
  if (opts.forDownload) sanitizeDocument(out);
  // What was cut or scrubbed is unreachable now; the copier had already
  // copied it (an attachment's bytes, a stray page), so drop it from the file.
  if (stray.size > 0 || prunedForm || opts.forDownload) collectGarbage(out);

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
 * without it the fields are inert drawings, and a value typed after Organize
 * had nowhere to go. The form is rebuilt from the fields the kept pages show,
 * with the first source form's defaults (`/DA`, `/DR`, `/NeedAppearances`).
 * A field's widgets on pages left out are dropped from it.
 *
 * Returns whether anything was dropped (so it can be collected).
 */
function rebuildForm(out: PDFDocument, sources: PDFDocument[]): boolean {
  const ctx = out.context;
  const look = (o: PDFObject | undefined) => (o instanceof PDFRef ? ctx.lookup(o) : o);
  const KIDS = PDFName.of("Kids");
  const PARENT = PDFName.of("Parent");

  // The widgets the kept pages show.
  const widgets = new Set<PDFRef>();
  for (const page of out.getPages()) {
    const annots = look(page.node.get(PDFName.of("Annots")));
    if (!(annots instanceof PDFArray)) continue;
    for (let i = 0; i < annots.size(); i++) {
      const ref = annots.get(i);
      const a = look(ref);
      if (ref instanceof PDFRef && a instanceof PDFDict && a.get(PDFName.of("Subtype")) === PDFName.of("Widget")) {
        widgets.add(ref);
      }
    }
  }
  if (widgets.size === 0) return false;

  // Their top-level fields, in page order.
  const roots: PDFRef[] = [];
  const rootSet = new Set<PDFRef>();
  for (const w of widgets) {
    let ref = w;
    const seen = new Set<PDFRef>([ref]);
    for (;;) {
      const up = (look(ref) as PDFDict).get(PARENT);
      if (!(up instanceof PDFRef) || seen.has(up) || !(look(up) instanceof PDFDict)) break;
      seen.add(up);
      ref = up;
    }
    if (!rootSet.has(ref)) {
      rootSet.add(ref);
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
  const from = sources.map((d) => look2(d, d.catalog.get(PDFName.of("AcroForm")))).find((f) => f instanceof PDFDict);
  if (from instanceof PDFDict) {
    const src = sources.find((d) => look2(d, d.catalog.get(PDFName.of("AcroForm"))) === from)!;
    const copier = PDFObjectCopier.for(src.context, ctx);
    for (const key of ["DA", "DR", "NeedAppearances", "Q"]) {
      const v = from.get(PDFName.of(key));
      if (v !== undefined) acro.set(PDFName.of(key), copier.copy(v));
    }
  }
  out.catalog.set(PDFName.of("AcroForm"), ctx.register(acro));
  return pruned;
}

function look2(doc: PDFDocument, o: PDFObject | undefined): PDFObject | undefined {
  return o instanceof PDFRef ? doc.context.lookup(o) : o;
}
