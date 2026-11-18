import { getCachedDoc } from "./loader";

/** One bookmark of the document's own outline. */
export interface OutlineEntry {
  title: string;
  /** The source page it opens (0-based), or null when it opens nothing in
   * this document: a web address, a script, a destination that doesn't
   * resolve. */
  page: number | null;
  items: OutlineEntry[];
}

/** Past these the rest is left out: a crafted file can nest or loop its
 * outline without end, and a sidebar of ten thousand rows helps no one. */
const MAX_ENTRIES = 2000;
const MAX_DEPTH = 32;

type RawItem = { title?: string; dest?: unknown; items?: RawItem[] };

/**
 * The document's outline (bookmarks), each entry resolved to the source page it
 * opens. Read with pdf.js from the parse the pages already use, so it costs no
 * second parse. Empty when the document has no outline or it can't be read.
 */
export async function readOutline(bytes: ArrayBuffer): Promise<OutlineEntry[]> {
  try {
    const doc = await getCachedDoc(bytes);
    const raw = (await doc.getOutline()) as RawItem[] | null;
    if (!raw || raw.length === 0) return [];
    let count = 0;
    const named = new Map<string, Promise<unknown>>();

    const pageOf = async (dest: unknown): Promise<number | null> => {
      try {
        let explicit = dest;
        if (typeof dest === "string") {
          let p = named.get(dest);
          if (!p) named.set(dest, (p = doc.getDestination(dest)));
          explicit = await p;
        }
        if (!Array.isArray(explicit) || explicit.length === 0) return null;
        const head = explicit[0];
        let index: number | null = null;
        if (typeof head === "number") index = head;
        else if (head && typeof head === "object" && "num" in head) {
          index = await doc.getPageIndex(head as { num: number; gen: number });
        }
        return index != null && Number.isInteger(index) && index >= 0 && index < doc.numPages ? index : null;
      } catch {
        return null;
      }
    };

    const walk = async (items: RawItem[], depth: number): Promise<OutlineEntry[]> => {
      const out: OutlineEntry[] = [];
      for (const it of items) {
        if (count >= MAX_ENTRIES) break;
        count++;
        out.push({
          title: (it.title ?? "").replace(/\s+/g, " ").trim() || "Untitled",
          page: await pageOf(it.dest),
          items: depth + 1 < MAX_DEPTH && it.items?.length ? await walk(it.items, depth + 1) : [],
        });
      }
      return out;
    };
    return await walk(raw, 0);
  } catch {
    return [];
  }
}
