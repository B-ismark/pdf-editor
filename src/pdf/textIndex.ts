import { readPageText, type PageText } from "./loader";
import type { LoadedPdf, PageData } from "./types";

/**
 * Reading a document's text in the background.
 *
 * A file opens with its layout only (`loadLayout`), so its first page paints
 * without waiting for every page's text. This module then reads the text page
 * by page and hands it over in batches, to be merged into the document with
 * `fillPages`. Pages scrolled into view jump the queue (`wantText`).
 *
 * Each page is read once per parse: the result is kept, keyed by the document's
 * bytes, so the background walk, a page that asked early and `completeText`
 * share one read. Anything that needs the *whole* document's text — export,
 * the whiteout check, copying or saving the text, OCR, Compare — must go through
 * `completeText`, which reads whatever is still missing and returns the
 * document filled in. Reading a half-read document directly would treat its
 * unread pages as having no text at all.
 */

interface Index {
  /** One read per page, shared by everyone who asks. */
  reads: Map<number, Promise<PageText>>;
  /** Pages the walk hasn't reached, in the order it will take them. */
  queue: number[];
  /** Set by `stopIndexing`: the walk ends at the next page. */
  stopped: boolean;
  /** Running, so a second `indexText` for the same bytes doesn't start another. */
  walking: boolean;
}

const indexes = new WeakMap<ArrayBuffer, Index>();

function indexFor(bytes: ArrayBuffer, pageCount: number): Index {
  let ix = indexes.get(bytes);
  if (!ix) {
    ix = { reads: new Map(), queue: Array.from({ length: pageCount }, (_, i) => i), stopped: false, walking: false };
    indexes.set(bytes, ix);
  }
  return ix;
}

/** A page's text, read once. A failed read isn't kept, so asking again retries. */
function textOf(bytes: ArrayBuffer, ix: Index, pageIndex: number): Promise<PageText> {
  let read = ix.reads.get(pageIndex);
  if (!read) {
    read = readPageText(bytes, pageIndex);
    ix.reads.set(pageIndex, read);
    read.catch(() => {
      if (ix.reads.get(pageIndex) === read) ix.reads.delete(pageIndex);
    });
  }
  return read;
}

/** How long the walk gathers pages before handing them over. Each hand-over
 * re-renders the document's pages that changed, so one per page on a long file
 * would be hundreds of renders for no visible gain. */
const BATCH_MS = 120;

/**
 * Read every page of `pdf` that is still `textPending`, in the background,
 * calling `onBatch` with what has been read every so often, and with `done`
 * once every page has been read.
 * Pages are read one at a time, so a page render waits on at most one page's
 * text in pdf.js's worker. Safe to call more than once for the same bytes.
 */
export function indexText(pdf: LoadedPdf, onBatch: (read: Map<number, PageText>, done: boolean) => void): void {
  const ix = indexFor(pdf.bytes, pdf.pages.length);
  if (ix.walking || ix.stopped) return;
  const pending = new Set(pdf.pages.filter((p) => p.textPending).map((p) => p.pageIndex));
  ix.queue = ix.queue.filter((i) => pending.has(i));
  if (ix.queue.length === 0) return;
  ix.walking = true;
  void (async () => {
    let batch = new Map<number, PageText>();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let first = true;
    const flush = (done = false) => {
      if (timer) clearTimeout(timer);
      timer = null;
      if ((batch.size === 0 && !done) || ix.stopped) return;
      onBatch(batch, done);
      batch = new Map();
    };
    try {
      while (ix.queue.length > 0 && !ix.stopped) {
        const p = ix.queue.shift()!;
        let text: PageText;
        try {
          text = await textOf(pdf.bytes, ix, p);
        } catch {
          // The parse was released (the tab closed or was replaced): stop.
          if (ix.stopped) return;
          // One unreadable page isn't the document: it simply has no text.
          text = { fragments: [], fields: [] };
        }
        batch.set(p, text);
        // The first page read goes straight over (it's the one in view); the
        // rest are gathered for a moment — on a timer, not on the next page
        // arriving, so one slow page doesn't hold back the pages before it.
        if (first) {
          first = false;
          flush();
        } else if (!timer) timer = setTimeout(() => flush(), BATCH_MS);
      }
      flush(ix.queue.length === 0);
    } finally {
      ix.walking = false;
    }
  })();
}

/** Read this page next: it has scrolled into view. */
export function wantText(bytes: ArrayBuffer, pageIndex: number): void {
  const ix = indexes.get(bytes);
  if (!ix || ix.stopped) return;
  const at = ix.queue.indexOf(pageIndex);
  if (at > 0) {
    ix.queue.splice(at, 1);
    ix.queue.unshift(pageIndex);
  }
}

/** Stop reading `bytes` and forget what was read — its parse is being let go. */
export function stopIndexing(bytes: ArrayBuffer): void {
  const ix = indexes.get(bytes);
  if (ix) ix.stopped = true;
  indexes.delete(bytes);
}

/**
 * Pages with the text in `read` merged in. Pages not in it are returned as they
 * are (the same objects, so memo'd pages don't re-render); a page that already
 * has its text is left alone. Fragments a page gained while it waited (OCR's)
 * are kept after the read ones.
 */
export function fillPages(pages: PageData[], read: Map<number, PageText>): PageData[] {
  let changed = false;
  const next = pages.map((pg) => {
    const text = pg.textPending ? read.get(pg.pageIndex) : undefined;
    if (!text) return pg;
    changed = true;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- dropped on purpose
    const { textPending, ...rest } = pg;
    return { ...rest, fragments: [...text.fragments, ...pg.fragments], fields: text.fields };
  });
  return changed ? next : pages;
}

/** How many of a document's pages still wait for their text. */
export function pagesPending(pdf: LoadedPdf | null | undefined): number {
  let n = 0;
  if (pdf) for (const p of pdf.pages) if (p.textPending) n++;
  return n;
}

/**
 * `pdf` with every page's text read — the document as anything reading all of
 * it must see. Returns `pdf` itself when nothing is pending. Pages already read
 * in the background aren't read again.
 */
export async function completeText(pdf: LoadedPdf): Promise<LoadedPdf> {
  const pending = pdf.pages.filter((p) => p.textPending);
  if (pending.length === 0) return pdf;
  const ix = indexFor(pdf.bytes, pdf.pages.length);
  const read = new Map<number, PageText>();
  await Promise.all(
    pending.map(async (p) => {
      // A page pdf.js can't read has no text to give, exactly as the
      // background walk treats it — not a reason to refuse the whole file.
      read.set(p.pageIndex, await textOf(pdf.bytes, ix, p.pageIndex).catch(() => ({ fragments: [], fields: [] })));
    }),
  );
  return { ...pdf, pages: fillPages(pdf.pages, read) };
}
