import { PDFArray, PDFDict, PDFName, PDFRef, PDFStream, type PDFDocument, type PDFObject } from "pdf-lib";

/**
 * Whole-document bookkeeping for exporting *in place*.
 *
 * The exporter used to build a fresh document and `copyPages` into it, one
 * call per page. That lost everything that lives at catalog level — the
 * outline, page labels, the structure tree and `/Lang`, named destinations,
 * optional-content configuration, the form — and, because every `copyPages`
 * call has its own object copier, deep-copied every shared font and image once
 * *per page* (a 1.33 MB file exported at 182 MB). It now edits the loaded
 * source and saves that, which keeps all of it and shares what was shared.
 *
 * Editing in place inverts the privacy default, though: a rebuild carried only
 * what it copied, and a rewrite carries everything that is still reachable —
 * or, without help, everything in the file. So redacted pages are *replaced*
 * (never edited), and these helpers make sure nothing of a replaced page
 * survives by another route: references to it are moved to its replacement,
 * form fields that lived on it are removed, the structure tree (whose
 * `/ActualText` and `/Alt` repeat page text) is dropped when any page was
 * replaced, and finally every object no longer reachable from the trailer is
 * deleted, so the save can't write it.
 */

/** Look a value up through an indirect reference, or return it as is. */
function deref(doc: PDFDocument, obj: PDFObject | undefined): PDFObject | undefined {
  if (obj instanceof PDFRef) {
    try {
      return doc.context.lookup(obj);
    } catch {
      return undefined;
    }
  }
  return obj;
}

/** Call `visit` for every direct child of a dict, array or stream dict. */
function eachChild(
  obj: PDFObject | undefined,
  visit: (child: PDFObject, replace: (next: PDFObject) => void) => void,
): void {
  if (obj instanceof PDFStream) obj = obj.dict;
  if (obj instanceof PDFDict) {
    for (const [key, value] of obj.entries()) visit(value, (next) => obj.set(key, next));
  } else if (obj instanceof PDFArray) {
    for (let i = 0; i < obj.size(); i++) visit(obj.get(i), (next) => obj.set(i, next));
  }
}

/**
 * Point every reference to an old page at its replacement, anywhere in the
 * file: outline destinations, named destinations, `/GoTo` link actions on other
 * pages, `/OpenAction`-style arrays. Without this a link to a redacted page
 * lands on an object that no longer exists (and, worse, keeps it alive).
 *
 * Walks every indirect object rather than a list of known places, because the
 * places a page reference can appear are open-ended.
 */
export function retargetPageRefs(doc: PDFDocument, moved: Map<PDFRef, PDFRef>): void {
  if (moved.size === 0) return;
  const seen = new Set<PDFObject>();
  const walk = (obj: PDFObject | undefined) => {
    if (!obj || seen.has(obj)) return;
    seen.add(obj);
    eachChild(obj, (child, replace) => {
      if (child instanceof PDFRef) {
        const to = moved.get(child);
        if (to) replace(to);
      } else {
        walk(child);
      }
    });
  };
  for (const [, obj] of doc.context.enumerateIndirectObjects()) walk(obj);
}

/**
 * Remove from the AcroForm every field whose widget sat on a replaced page.
 *
 * A field's value is page content in all but name — `/V` on a field drawn on
 * a redacted page is the very text the redaction removed — and the AcroForm
 * reaches it from the catalog, so it would survive the page. A field with
 * widgets on other pages too keeps those and loses only the widgets that were
 * on the replaced page.
 */
export function pruneFieldsOnPages(doc: PDFDocument, oldPages: Set<PDFRef>): void {
  if (oldPages.size === 0) return;
  const acro = deref(doc, doc.catalog.get(PDFName.of("AcroForm")));
  if (!(acro instanceof PDFDict)) return;

  // Widgets of the replaced pages: listed in their /Annots, or pointing at them
  // through /P (a widget missing from /Annots is legal and common enough).
  const doomed = new Set<PDFRef>();
  for (const pageRef of oldPages) {
    const page = deref(doc, pageRef);
    if (!(page instanceof PDFDict)) continue;
    const annots = deref(doc, page.get(PDFName.of("Annots")));
    if (annots instanceof PDFArray) {
      for (let i = 0; i < annots.size(); i++) {
        const a = annots.get(i);
        if (a instanceof PDFRef) doomed.add(a);
      }
    }
  }
  const onOldPage = (ref: PDFRef, dict: PDFDict) => {
    if (doomed.has(ref)) return true;
    const p = dict.get(PDFName.of("P"));
    return p instanceof PDFRef && oldPages.has(p);
  };

  /** Filter a /Fields or /Kids array in place; true if anything is left. */
  const prune = (arr: PDFArray, depth: number): boolean => {
    for (let i = arr.size() - 1; i >= 0; i--) {
      const ref = arr.get(i);
      const node = deref(doc, ref);
      if (!(ref instanceof PDFRef) || !(node instanceof PDFDict) || depth > 32) {
        arr.remove(i);
        continue;
      }
      const kids = deref(doc, node.get(PDFName.of("Kids")));
      if (kids instanceof PDFArray && kids.size() > 0) {
        if (!prune(kids, depth + 1)) arr.remove(i);
      } else if (onOldPage(ref, node)) {
        arr.remove(i);
      }
    }
    return arr.size() > 0;
  };

  const fields = deref(doc, acro.get(PDFName.of("Fields")));
  if (fields instanceof PDFArray) prune(fields, 0);

  // The calculation order names fields directly; drop entries that went.
  const co = deref(doc, acro.get(PDFName.of("CO")));
  if (co instanceof PDFArray) {
    const live = new Set<PDFRef>();
    const collect = (arr: PDFArray, depth: number) => {
      for (let i = 0; i < arr.size(); i++) {
        const ref = arr.get(i);
        if (!(ref instanceof PDFRef) || depth > 32) continue;
        live.add(ref);
        const node = deref(doc, ref);
        const kids = node instanceof PDFDict ? deref(doc, node.get(PDFName.of("Kids"))) : undefined;
        if (kids instanceof PDFArray) collect(kids, depth + 1);
      }
    };
    if (fields instanceof PDFArray) collect(fields, 0);
    for (let i = co.size() - 1; i >= 0; i--) {
      const ref = co.get(i);
      if (!(ref instanceof PDFRef) || !live.has(ref)) co.remove(i);
    }
  }
}

/**
 * Drop the tagged-PDF structure tree.
 *
 * Only called when a page was replaced by a raster. Structure elements carry
 * `/ActualText`, `/Alt` and `/E` — text *about* the page's content, often the
 * content itself — and they hang off the catalog, so keeping the tree keeps the
 * redacted page's words. Pruning just that page's elements would mean trusting
 * every producer's `/Pg` and `/K` bookkeeping with the redaction; dropping the
 * tree is the answer that can't leak. `/Lang` is a catalog entry, not part of
 * the tree, and stays.
 */
export function dropStructureTree(doc: PDFDocument): void {
  doc.catalog.delete(PDFName.of("StructTreeRoot"));
  doc.catalog.delete(PDFName.of("MarkInfo"));
  for (const page of doc.getPages()) page.node.delete(PDFName.of("StructParents"));
  // Outline items can point into the tree too (/SE), which would keep it
  // reachable — and so in the file — after the catalog let go of it.
  forEachOutlineItem(doc, (item) => item.delete(PDFName.of("SE")));
}

/** Visit every item of the document outline (bookmarks), cycle-safe. */
export function forEachOutlineItem(doc: PDFDocument, visit: (item: PDFDict) => void): void {
  const root = deref(doc, doc.catalog.get(PDFName.of("Outlines")));
  if (!(root instanceof PDFDict)) return;
  const seen = new Set<PDFDict>();
  const stack: PDFObject[] = [root.get(PDFName.of("First"))].filter(Boolean) as PDFObject[];
  while (stack.length && seen.size < 100_000) {
    const item = deref(doc, stack.pop());
    if (!(item instanceof PDFDict) || seen.has(item)) continue;
    seen.add(item);
    visit(item);
    const next = item.get(PDFName.of("Next"));
    const first = item.get(PDFName.of("First"));
    if (next) stack.push(next);
    if (first) stack.push(first);
  }
}

/**
 * Delete every indirect object the trailer can no longer reach.
 *
 * pdf-lib writes *every* object in its context, referenced or not. A rebuilt
 * document only ever held what was copied into it, so this didn't matter; a
 * loaded one also holds whatever the original file carried — the content
 * streams of pages that were just replaced, objects orphaned by earlier
 * incremental saves (which routinely include *previous versions of the text*),
 * and anything the sanitiser just unhooked from the catalog. Unreachable is
 * exactly "nothing in the output points at it", so dropping it changes nothing
 * a reader can see and removes everything a reader shouldn't.
 *
 * Call after `flush()` so lazily-embedded fonts and images exist as objects.
 */
export function collectGarbage(doc: PDFDocument): number {
  const ctx = doc.context;
  const reachable = new Set<PDFRef>();
  const stack: PDFObject[] = [];
  const t = ctx.trailerInfo;
  for (const root of [t.Root, t.Info, t.Encrypt]) if (root) stack.push(root as PDFObject);
  const seen = new Set<PDFObject>();
  while (stack.length) {
    const obj = stack.pop()!;
    if (obj instanceof PDFRef) {
      if (reachable.has(obj)) continue;
      reachable.add(obj);
      const target = ctx.lookup(obj);
      if (target) stack.push(target);
      continue;
    }
    if (seen.has(obj)) continue;
    seen.add(obj);
    eachChild(obj, (child) => stack.push(child));
  }
  let removed = 0;
  for (const [ref] of ctx.enumerateIndirectObjects()) {
    if (!reachable.has(ref)) {
      ctx.delete(ref);
      removed++;
    }
  }
  return removed;
}
