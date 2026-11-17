import { PDFDict, PDFName, PDFNumber, PDFPageLeaf, PDFPageTree, PDFRef, type PDFDocument, type PDFObject, type PDFPage } from "@cantoo/pdf-lib";

/**
 * Make the file's page list exactly the pages the preview showed, in order.
 *
 * The preview is pdf.js; the exporter is pdf-lib; and on a malformed page tree
 * they don't agree on which object is "page 2". pdf.js treats a `/Kids` entry
 * with no `/Type` as a page and trusts `/Count`; pdf-lib skips untyped entries
 * and its insert/remove navigate by `/Count`. On such a file the exporter
 * rasterised the *wrong* page — and shipped the page the user had redacted,
 * text and all — or dropped a page and linked the raster in twice. And a page
 * the tree holds beyond what `/Count` admits was never shown but still shipped.
 *
 * So the exporter doesn't trust either walk. pdf.js reports the object it
 * rendered for every slot; this rebuilds `/Pages` as one flat node whose `/Kids`
 * are exactly those objects, with the attributes each inherited from its old
 * parents (`/Resources`, `/MediaBox`, `/CropBox`, `/Rotate`) copied onto it so
 * it renders the same without them. After this, pdf-lib's page *i* is the page
 * the user saw at position *i*, and its `/Count` arithmetic is honest. Anything
 * that can't be lined up throws: an export that fails is recoverable, a
 * redaction applied to the wrong page is not.
 *
 * Must run before anything asks pdf-lib for its pages — it caches the list.
 */
export function alignPageTree(doc: PDFDocument, refs: ({ num: number; gen: number } | null)[]): void {
  const ctx = doc.context;
  const damaged = (why: string) =>
    new Error(`This PDF's page list is damaged (${why}), so it can't be exported safely.`);

  const pageRefs = refs.map((r, i) => {
    if (!r) throw damaged(`page ${i + 1} has no object of its own`);
    return PDFRef.of(r.num, r.gen);
  });
  if (new Set(pageRefs).size !== pageRefs.length) throw damaged("a page appears twice");

  const INHERITED = ["Resources", "MediaBox", "CropBox", "Rotate"].map((k) => PDFName.of(k));
  const leaves = pageRefs.map((ref, i) => {
    const node = ctx.lookup(ref);
    if (!(node instanceof PDFDict) || node.has(PDFName.of("Kids"))) throw damaged(`page ${i + 1} isn't a page`);
    // Copy inherited attributes down from the nearest ancestor that has them.
    const own = new Map(node.entries());
    const seen = new Set<PDFObject>([node]);
    let parent = node.get(PDFName.of("Parent"));
    for (let depth = 0; parent && depth < 64; depth++) {
      const up = parent instanceof PDFRef ? ctx.lookup(parent) : parent;
      if (!(up instanceof PDFDict) || seen.has(up)) break;
      seen.add(up);
      for (const key of INHERITED) {
        const v = up.get(key);
        if (v !== undefined && !own.has(key)) own.set(key, v);
      }
      parent = up.get(PDFName.of("Parent"));
    }
    // pdf.js's defaults for a page that never says.
    if (!own.has(PDFName.of("MediaBox"))) own.set(PDFName.of("MediaBox"), ctx.obj([0, 0, 612, 792]));
    if (!own.has(PDFName.of("Resources"))) own.set(PDFName.of("Resources"), ctx.obj({}));
    own.set(PDFName.of("Type"), PDFName.of("Page"));
    return own;
  });

  // One flat root. Reuse the catalog's /Pages object number so nothing that
  // points at it (rare, but legal) dangles.
  const existing = doc.catalog.get(PDFName.of("Pages"));
  const rootRef = existing instanceof PDFRef ? existing : ctx.nextRef();
  doc.catalog.set(PDFName.of("Pages"), rootRef);
  const root = PDFPageTree.fromMapWithContext(
    new Map<PDFName, PDFObject>([
      [PDFName.of("Type"), PDFName.of("Pages")],
      [PDFName.of("Kids"), ctx.obj(pageRefs)],
      [PDFName.of("Count"), PDFNumber.of(pageRefs.length)],
    ]),
    ctx,
  );
  ctx.assign(rootRef, root);

  pageRefs.forEach((ref, i) => {
    const own = leaves[i];
    own.set(PDFName.of("Parent"), rootRef);
    // Re-create as pdf-lib's page class: an untyped dict was parsed as a plain
    // PDFDict, which pdf-lib's page walk doesn't recognise.
    ctx.assign(ref, PDFPageLeaf.fromMapWithContext(own, ctx));
  });

  // Trust, but verify: pdf-lib must now see exactly these pages, in order.
  const seen = doc.getPages().map((p) => p.ref);
  if (seen.length !== pageRefs.length || seen.some((r, i) => r !== pageRefs[i])) {
    throw damaged("the pages couldn't be lined up");
  }
}


/**
 * Make the document's pages exactly `pages`, in this order — reordering,
 * dropping and swapping in replacement pages in one step.
 *
 * Done by rewriting the flat root `alignPageTree` left, rather than with
 * pdf-lib's `removePage`/`insertPage`: the fork's `removePage` deletes the
 * page *object* as well as its slot, so a page moved that way is gone, and a
 * page removed that way can no longer be read to find the form fields and
 * comment threads that have to go with it. Here, a page left out simply stops
 * being reachable, and the exporter's structure pass cuts it loose and sweeps
 * it.
 *
 * pdf-lib caches its page list, and nothing public refreshes it without
 * deleting an object, so the cache is reset directly — then checked, so a
 * change in the library's internals fails the export instead of shipping the
 * wrong pages.
 */
export function setPageList(doc: PDFDocument, pages: PDFPage[]): void {
  const ctx = doc.context;
  const rootRef = doc.catalog.get(PDFName.of("Pages"));
  const root = rootRef instanceof PDFRef ? ctx.lookup(rootRef) : undefined;
  if (!(rootRef instanceof PDFRef) || !(root instanceof PDFPageTree)) {
    throw new Error("The pages couldn't be put in order, so the file wasn't exported.");
  }
  root.set(PDFName.of("Kids"), ctx.obj(pages.map((p) => p.ref)));
  root.set(PDFName.of("Count"), PDFNumber.of(pages.length));
  for (const page of pages) page.node.setParent(rootRef);

  const internals = doc as unknown as {
    pageMap?: Map<unknown, PDFPage>;
    pageCache?: { invalidate(): void };
    pageCount?: number;
  };
  for (const page of pages) internals.pageMap?.set(page.node, page);
  internals.pageCache?.invalidate();
  internals.pageCount = undefined;

  const seen = doc.getPages();
  if (doc.getPageCount() !== pages.length || seen.length !== pages.length || seen.some((p, i) => p.ref !== pages[i].ref)) {
    throw new Error("The pages couldn't be put in order, so the file wasn't exported.");
  }
}
