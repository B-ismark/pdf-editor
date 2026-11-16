import { PDFDocument, degrees, type PDFPage } from "pdf-lib";

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
 * Copies in as few `copyPages` calls as possible. Each call has its own object
 * copier, and the copier is what notices that two pages share a font or an
 * image — so one call per page deep-copied every shared resource once *per
 * page* (a twelve-page file sharing one image came out with twelve). One call
 * per source copies each shared object once.
 *
 * A page the plan uses twice can't come from the same call, though: the copier
 * caches by object, so it would hand back the *same* page both times, and one
 * page object in two slots of the page tree is a broken file (rotating one
 * would rotate both). Repeats go into a second (third, …) round, which is the
 * only case that copies shared resources more than once.
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

  // Group plan slots into rounds per source: a page's first use goes in round
  // 0, its second in round 1, and so on — so no round asks for a page twice.
  const rounds = new Map<string, number[][]>(); // source -> round -> plan slots
  const uses = new Map<string, number>(); // "source\0index" -> uses so far
  plan.forEach((entry, slot) => {
    const id = `${entry.sourceKey}\0${entry.index}`;
    const round = uses.get(id) ?? 0;
    uses.set(id, round + 1);
    const perSource = rounds.get(entry.sourceKey) ?? [];
    (perSource[round] ??= []).push(slot);
    rounds.set(entry.sourceKey, perSource);
  });

  const pages = new Array<PDFPage>(plan.length);
  for (const [key, perSource] of rounds) {
    const src = docs.get(key)!;
    for (const slots of perSource) {
      const copied = await out.copyPages(src, slots.map((s) => plan[s].index));
      slots.forEach((slot, i) => (pages[slot] = copied[i]));
    }
  }

  plan.forEach((entry, slot) => {
    const page = pages[slot];
    if (entry.rotation % 360 !== 0) {
      const current = page.getRotation().angle;
      page.setRotation(degrees((current + entry.rotation) % 360));
    }
    out.addPage(page);
  });

  return out.save();
}

/** Count the pages in a PDF (used when merging an added file). */
export async function pageCount(bytes: ArrayBuffer): Promise<number> {
  const doc = await loadSource(bytes);
  return doc.getPageCount();
}
