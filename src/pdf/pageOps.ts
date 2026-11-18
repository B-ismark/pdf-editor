import { PDFDict, PDFDocument, PDFName, PDFRef, degrees, type PDFPage } from "@cantoo/pdf-lib";
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
): Promise<Uint8Array> {
  const out = await PDFDocument.create();

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
  if (stray.size > 0) {
    cutDeletedPages(out, stray);
    collectGarbage(out);
  }

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
): Promise<{ width: number; height: number }> {
  const doc = await loadSource(bytes);
  const page = doc.getPage(Math.min(index, doc.getPageCount() - 1));
  const { width, height } = page.getCropBox();
  const turn = (((page.getRotation().angle + extra) % 360) + 360) % 360;
  return turn % 180 === 0 ? { width, height } : { width: height, height: width };
}
