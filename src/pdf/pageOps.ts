import { PDFDocument, degrees } from "pdf-lib";

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

  for (const entry of plan) {
    const src = docs.get(entry.sourceKey)!;
    const [copied] = await out.copyPages(src, [entry.index]);
    if (entry.rotation % 360 !== 0) {
      const current = copied.getRotation().angle;
      copied.setRotation(degrees((current + entry.rotation) % 360));
    }
    out.addPage(copied);
  }

  return out.save();
}

/** Count the pages in a PDF (used when merging an added file). */
export async function pageCount(bytes: ArrayBuffer): Promise<number> {
  const doc = await loadSource(bytes);
  return doc.getPageCount();
}
