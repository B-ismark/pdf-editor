import { PDFArray, PDFDict, PDFHexString, PDFName, PDFNull, PDFNumber, PDFRawStream, PDFRef, PDFStream, PDFString, decodePDFRawStream, type PDFDocument, type PDFObject } from "@cantoo/pdf-lib";

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

/** The annotations listed in each old page's `/Annots`. */
function annotsOf(doc: PDFDocument, pages: Iterable<PDFRef>): Set<PDFRef> {
  const out = new Set<PDFRef>();
  for (const pageRef of pages) {
    const page = deref(doc, pageRef);
    const annots = page instanceof PDFDict ? deref(doc, page.get(PDFName.of("Annots"))) : undefined;
    if (!(annots instanceof PDFArray)) continue;
    for (let i = 0; i < annots.size(); i++) {
      const a = annots.get(i);
      if (a instanceof PDFRef) out.add(a);
    }
  }
  return out;
}

/**
 * Cut the threads from a kept page's annotations back to a replaced page's.
 *
 * A reply (`/IRT`) on page 3 to a comment on redacted page 2 keeps that comment
 * — and its `/Contents` — reachable; so does a popup on page 3 whose `/Parent`
 * is a markup on page 2. The reply loses its "in reply to" and stays; the
 * popup, which is only a window onto the comment that went, goes.
 */
export function detachAnnotsOfPages(doc: PDFDocument, oldPages: Set<PDFRef>): void {
  const doomed = annotsOf(doc, oldPages);
  if (doomed.size === 0) return;
  for (const page of doc.getPages()) {
    if (oldPages.has(page.ref)) continue;
    const annots = deref(doc, page.node.get(PDFName.of("Annots")));
    if (!(annots instanceof PDFArray)) continue;
    for (let i = annots.size() - 1; i >= 0; i--) {
      const a = deref(doc, annots.get(i));
      if (!(a instanceof PDFDict)) continue;
      const parent = a.get(PDFName.of("Parent"));
      if (String(a.get(PDFName.of("Subtype"))) === "/Popup" && parent instanceof PDFRef && doomed.has(parent)) {
        annots.remove(i);
        continue;
      }
      const irt = a.get(PDFName.of("IRT"));
      if (irt instanceof PDFRef && doomed.has(irt)) a.delete(PDFName.of("IRT"));
    }
  }
}

/** Resolve a destination — explicit array, named (`/Dests` dict) or string
 * (`/Names /Dests` tree) — to the page it targets. */
function destPage(doc: PDFDocument, dest: PDFObject | undefined, depth = 0): PDFRef | undefined {
  const d = deref(doc, dest);
  if (depth > 4 || d === undefined) return undefined;
  if (d instanceof PDFArray) {
    const p = d.get(0);
    return p instanceof PDFRef ? p : undefined;
  }
  if (d instanceof PDFDict) return destPage(doc, d.get(PDFName.of("D")), depth + 1);
  if (d instanceof PDFName) {
    const dests = deref(doc, doc.catalog.get(PDFName.of("Dests")));
    return dests instanceof PDFDict ? destPage(doc, dests.get(d), depth + 1) : undefined;
  }
  if (d instanceof PDFString || d instanceof PDFHexString) {
    const names = deref(doc, doc.catalog.get(PDFName.of("Names")));
    const tree = names instanceof PDFDict ? deref(doc, names.get(PDFName.of("Dests"))) : undefined;
    const key = d.decodeText();
    const look = (node: PDFObject | undefined, level: number): PDFObject | undefined => {
      const n = deref(doc, node);
      if (!(n instanceof PDFDict) || level > 32) return undefined;
      const leaf = deref(doc, n.get(PDFName.of("Names")));
      if (leaf instanceof PDFArray) {
        for (let i = 0; i + 1 < leaf.size(); i += 2) {
          const k = deref(doc, leaf.get(i));
          if ((k instanceof PDFString || k instanceof PDFHexString) && k.decodeText() === key) return leaf.get(i + 1);
        }
      }
      const kids = deref(doc, n.get(PDFName.of("Kids")));
      if (kids instanceof PDFArray) {
        for (let i = 0; i < kids.size(); i++) {
          const hit = look(kids.get(i), level + 1);
          if (hit) return hit;
        }
      }
      return undefined;
    };
    return destPage(doc, look(tree, 0), depth + 1);
  }
  return undefined;
}

/**
 * Retitle bookmarks that lead to a replaced page as "Page N".
 *
 * Bookmarks are very often the page's own headings ("create bookmarks from
 * headings"), so a bookmark into a redacted page is likely to quote what was
 * redacted — and the app shows no outline, so the user can neither see nor
 * redact it. The bookmark keeps working; it just stops saying what it found.
 * Call after {@link retargetPageRefs}, with the *replacement* page refs.
 */
export function retitleOutlinesInto(doc: PDFDocument, newPages: Set<PDFRef>): void {
  const index = new Map(doc.getPages().map((p, i) => [p.ref, i] as const));
  forEachOutlineItem(doc, (item) => {
    let target = destPage(doc, item.get(PDFName.of("Dest")));
    if (!target) {
      const action = deref(doc, item.get(PDFName.of("A")));
      if (action instanceof PDFDict && String(action.get(PDFName.of("S"))) === "/GoTo") {
        target = destPage(doc, action.get(PDFName.of("D")));
      }
    }
    if (target && newPages.has(target)) {
      item.set(PDFName.of("Title"), PDFHexString.fromText(`Page ${(index.get(target) ?? 0) + 1}`));
    }
  });
}

/** A content stream's decoded bytes as text, or null if it can't be read. */
function streamText(stream: PDFObject | undefined): string | null {
  try {
    let bytes: Uint8Array | undefined;
    if (stream instanceof PDFRawStream) bytes = decodePDFRawStream(stream).decode();
    else if (stream instanceof PDFStream) {
      // pdf-lib's own content streams (what the exporter just drew).
      const own = stream as unknown as { getUnencodedContents?: () => Uint8Array };
      bytes = own.getUnencodedContents?.();
    }
    if (!bytes) return null;
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return s;
  } catch {
    return null;
  }
}

/** Names painted with `Do` in some content, decoded (`#xx` escapes resolved). */
function xobjectNamesIn(content: string, into: Set<string>): void {
  for (const m of content.matchAll(/\/([^\s/[\]()<>{}%]+)\s*Do(?![A-Za-z0-9])/g)) {
    into.add(m[1].replace(/#([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))));
  }
}

/**
 * Give every page (and every form it draws) an `/XObject` resource list naming
 * only what its content actually paints.
 *
 * Producers often share one resource dictionary between pages, or put it on
 * `/Pages` for every page to inherit. An image or form used *only* by a page
 * that was redacted is then still listed in the dictionary a kept page uses —
 * so it is reachable, survives the garbage collection, and ships: the scanned
 * page under the redaction, in full. Listing only what each page paints makes
 * "used by a kept page" and "in the file" the same thing again.
 *
 * Content that can't be decoded is left alone (with its resources as they
 * were), since cutting a resource it does use would break the page.
 */
export function isolatePageResources(doc: PDFDocument): void {
  const ctx = doc.context;
  const done = new Set<PDFObject>();

  /** Return a copy of `res` whose /XObject holds only `used`; recurse into the
   * forms it keeps. `inheritInto` collects names a form without resources of
   * its own draws from its parent's. */
  const narrowed = (res: PDFDict, used: Set<string>, depth: number): PDFDict => {
    const xo = deref(doc, res.get(PDFName.of("XObject")));
    const copy = ctx.obj({});
    for (const [k, v] of res.entries()) copy.set(k, v);
    if (!(xo instanceof PDFDict)) return copy;
    const kept = ctx.obj({});
    for (const [name, ref] of xo.entries()) {
      if (!used.has(name.decodeText())) continue;
      kept.set(name, ref);
      narrowForm(deref(doc, ref), depth + 1);
    }
    copy.set(PDFName.of("XObject"), kept);
    return copy;
  };

  const narrowForm = (form: PDFObject | undefined, depth: number): void => {
    if (!(form instanceof PDFStream) || done.has(form) || depth > 16) return;
    if (String(form.dict.get(PDFName.of("Subtype"))) !== "/Form") return;
    done.add(form);
    const res = deref(doc, form.dict.get(PDFName.of("Resources")));
    if (!(res instanceof PDFDict)) return;
    const text = streamText(form);
    if (text === null) return;
    const used = new Set<string>();
    xobjectNamesIn(text, used);
    form.dict.set(PDFName.of("Resources"), narrowed(res, used, depth));
  };

  /** Annotation appearances are forms too, and can name the shared dict. */
  const narrowAppearances = (annot: PDFObject | undefined) => {
    const a = deref(doc, annot);
    const ap = a instanceof PDFDict ? deref(doc, a.get(PDFName.of("AP"))) : undefined;
    if (!(ap instanceof PDFDict)) return;
    for (const [, state] of ap.entries()) {
      const s = deref(doc, state);
      if (s instanceof PDFStream) narrowForm(s, 0);
      else if (s instanceof PDFDict) for (const [, v] of s.entries()) narrowForm(deref(doc, v), 0);
    }
  };

  for (const page of doc.getPages()) {
    const node = page.node;
    const res = deref(doc, node.get(PDFName.of("Resources")));
    const contents = deref(doc, node.get(PDFName.of("Contents")));
    const streams: (PDFObject | undefined)[] =
      contents instanceof PDFArray ? Array.from({ length: contents.size() }, (_, i) => deref(doc, contents.get(i))) : [contents];
    let text = "";
    let readable = true;
    for (const st of streams) {
      if (st === undefined) continue;
      const t = streamText(st);
      if (t === null) readable = false;
      else text += t + "\n";
    }
    if (res instanceof PDFDict && readable) {
      const used = new Set<string>();
      xobjectNamesIn(text, used);
      // A form with no /Resources of its own paints from the page's; its
      // names count as the page's.
      const xo = deref(doc, res.get(PDFName.of("XObject")));
      if (xo instanceof PDFDict) {
        const pending = [...used];
        while (pending.length) {
          const f = deref(doc, xo.get(PDFName.of(pending.pop()!)));
          // Forms only: an image has no content to read, and decoding one to
          // look for names in it inflated every flate image a page drew — a
          // redacted page's raster is 13 MB of samples — on the page, for nothing.
          if (
            f instanceof PDFStream &&
            String(f.dict.get(PDFName.of("Subtype"))) === "/Form" &&
            !f.dict.has(PDFName.of("Resources"))
          ) {
            const ft = streamText(f);
            if (ft === null) continue;
            const more = new Set<string>();
            xobjectNamesIn(ft, more);
            for (const n of more) if (!used.has(n)) (used.add(n), pending.push(n));
          }
        }
      }
      node.set(PDFName.of("Resources"), narrowed(res, used, 0));
    }
    const annots = deref(doc, node.get(PDFName.of("Annots")));
    if (annots instanceof PDFArray) for (let i = 0; i < annots.size(); i++) narrowAppearances(annots.get(i));
  }
}

/**
 * Fail the export if any part of a tagged-PDF structure tree is still in the
 * file after it was dropped. The routes into the tree are open-ended (`/SE` on
 * a bookmark, `/SD` on a link, `/StructParent` lookups by producers that
 * inline them), and the tree repeats page text — so rather than trust that
 * every route was cut, check the result.
 */
export function assertNoStructureTree(doc: PDFDocument): void {
  const seen = new Set<PDFObject>();
  const check = (obj: PDFObject | undefined, depth: number) => {
    if (!obj || seen.has(obj) || depth > 64) return;
    seen.add(obj);
    const dict = obj instanceof PDFStream ? obj.dict : obj;
    if (dict instanceof PDFDict) {
      const type = String(dict.get(PDFName.of("Type")));
      if (type === "/StructElem" || type === "/StructTreeRoot") {
        throw new Error("A redacted page's accessibility tags couldn't be removed, so the file wasn't exported.");
      }
    }
    eachChild(obj, (child) => {
      if (!(child instanceof PDFRef)) check(child, depth + 1);
    });
  };
  for (const [, obj] of doc.context.enumerateIndirectObjects()) check(obj, 0);
}

/** The page an outline item or link points at, through `/Dest` or a `/GoTo`. */
function linkTarget(doc: PDFDocument, item: PDFDict): PDFRef | undefined {
  const direct = destPage(doc, item.get(PDFName.of("Dest")));
  if (direct) return direct;
  const action = deref(doc, item.get(PDFName.of("A")));
  if (action instanceof PDFDict && String(action.get(PDFName.of("S"))) === "/GoTo") {
    return destPage(doc, action.get(PDFName.of("D")));
  }
  return undefined;
}

/**
 * Cut every thread to pages the user deleted.
 *
 * Deleting a page is a promise that it isn't in the file — and editing in place
 * means a removed page is still in pdf-lib's context, reachable from anything
 * that names it. So: bookmarks that open it go (their children move up a
 * level, so a section whose heading page was deleted keeps its subsections),
 * links on kept pages that jump to it go, and any other reference left — a
 * named destination, an `/OpenAction`, a widget's `/P` — is replaced with
 * null, so `collectGarbage` can sweep the page and everything only it used.
 *
 * Call after the pages have been removed from the page tree.
 */
export function cutDeletedPages(doc: PDFDocument, gone: Set<PDFRef>): void {
  if (gone.size === 0) return;
  pruneOutline(doc, gone);

  for (const page of doc.getPages()) {
    const annots = deref(doc, page.node.get(PDFName.of("Annots")));
    if (!(annots instanceof PDFArray)) continue;
    for (let i = annots.size() - 1; i >= 0; i--) {
      const a = deref(doc, annots.get(i));
      if (!(a instanceof PDFDict) || String(a.get(PDFName.of("Subtype"))) !== "/Link") continue;
      const target = linkTarget(doc, a);
      if (target && gone.has(target)) annots.remove(i);
    }
  }

  const seen = new Set<PDFObject>();
  const walk = (obj: PDFObject | undefined) => {
    if (!obj || seen.has(obj)) return;
    seen.add(obj);
    eachChild(obj, (child, replace) => {
      if (child instanceof PDFRef) {
        if (gone.has(child)) replace(PDFNull);
      } else {
        walk(child);
      }
    });
  };
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    if (!gone.has(ref)) walk(obj);
  }
}

/** Remove outline items that open a deleted page, splicing their children into
 * their place, and relink what's left. */
function pruneOutline(doc: PDFDocument, gone: Set<PDFRef>): void {
  const rootRef = doc.catalog.get(PDFName.of("Outlines"));
  const root = deref(doc, rootRef);
  if (!(root instanceof PDFDict)) return;
  let hit = false;
  forEachOutlineItem(doc, (item) => {
    const t = linkTarget(doc, item);
    if (t && gone.has(t)) hit = true;
  });
  if (!hit) return;

  interface Kept { ref: PDFRef; dict: PDFDict; visible: number; open: boolean }
  const seen = new Set<PDFDict>();
  let budget = 100_000;

  /** The kept items of one level, each already relinked to its own kept kids. */
  const level = (parent: PDFDict, depth: number): Kept[] => {
    const out: Kept[] = [];
    let cur = parent.get(PDFName.of("First"));
    while (cur instanceof PDFRef && budget-- > 0) {
      const item = deref(doc, cur);
      if (!(item instanceof PDFDict) || seen.has(item)) break;
      seen.add(item);
      const next = item.get(PDFName.of("Next"));
      const kids = depth < 64 ? level(item, depth + 1) : [];
      const target = linkTarget(doc, item);
      if (target && gone.has(target)) {
        out.push(...kids);
      } else {
        const count = item.get(PDFName.of("Count"));
        const open = !(count instanceof PDFNumber && count.asNumber() < 0);
        const visible = link(cur, item, kids);
        if (kids.length) item.set(PDFName.of("Count"), PDFNumber.of(open ? visible : -visible));
        else item.delete(PDFName.of("Count"));
        out.push({ ref: cur, dict: item, visible, open });
      }
      cur = next;
    }
    return out;
  };

  /** Point `parent` at `kids` and the kids at each other; returns how many
   * items show under `parent` when it is open. */
  const link = (parentRef: PDFObject | undefined, parent: PDFDict, kids: Kept[]): number => {
    if (kids.length === 0) {
      parent.delete(PDFName.of("First"));
      parent.delete(PDFName.of("Last"));
      return 0;
    }
    parent.set(PDFName.of("First"), kids[0].ref);
    parent.set(PDFName.of("Last"), kids[kids.length - 1].ref);
    let visible = 0;
    kids.forEach((k, i) => {
      if (parentRef instanceof PDFRef) k.dict.set(PDFName.of("Parent"), parentRef);
      if (i > 0) k.dict.set(PDFName.of("Prev"), kids[i - 1].ref);
      else k.dict.delete(PDFName.of("Prev"));
      if (i < kids.length - 1) k.dict.set(PDFName.of("Next"), kids[i + 1].ref);
      else k.dict.delete(PDFName.of("Next"));
      visible += 1 + (k.open ? k.visible : 0);
    });
    return visible;
  };

  const top = level(root, 0);
  const visible = link(rootRef, root, top);
  if (top.length) root.set(PDFName.of("Count"), PDFNumber.of(visible));
  else root.delete(PDFName.of("Count"));
}

/**
 * Re-key `/PageLabels` for pages put in a new order. The number tree is keyed
 * by page *position*, so after a reorder or a deletion every label lands on
 * another page ("i" on what was page "ii"). `sources[i]` is the original
 * position of the page now at `i`; each new range restarts at exactly the
 * number that page had, so every page keeps its own label.
 */
export function remapPageLabels(doc: PDFDocument, sources: number[]): void {
  const key = PDFName.of("PageLabels");
  const tree = deref(doc, doc.catalog.get(key));
  if (!(tree instanceof PDFDict)) return;
  const ranges: { start: number; dict: PDFDict }[] = [];
  const walk = (node: PDFObject | undefined, depth: number) => {
    if (!(node instanceof PDFDict) || depth > 32 || ranges.length > 100_000) return;
    const nums = deref(doc, node.get(PDFName.of("Nums")));
    if (nums instanceof PDFArray) {
      for (let i = 0; i + 1 < nums.size(); i += 2) {
        const k = deref(doc, nums.get(i));
        const d = deref(doc, nums.get(i + 1));
        if (k instanceof PDFNumber && d instanceof PDFDict) ranges.push({ start: k.asNumber(), dict: d });
      }
    }
    const kids = deref(doc, node.get(PDFName.of("Kids")));
    if (kids instanceof PDFArray) for (let i = 0; i < kids.size(); i++) walk(deref(doc, kids.get(i)), depth + 1);
  };
  walk(tree, 0);
  ranges.sort((a, b) => a.start - b.start);
  const rangeOf = (k: number) => {
    let r: (typeof ranges)[number] | undefined;
    for (const x of ranges) if (x.start <= k) r = x;
    return r;
  };
  const out = doc.context.obj([]) as PDFArray;
  let prev: { k: number; r: unknown } | null = null;
  sources.forEach((k, i) => {
    const r = rangeOf(k);
    // Carries on from the page before it: the range already numbers it.
    if (prev && r && prev.r === r && prev.k + 1 === k) {
      prev = { k, r };
      return;
    }
    prev = { k, r };
    const d = doc.context.obj({}) as PDFDict;
    if (r) {
      for (const name of ["S", "P"]) {
        const v = r.dict.get(PDFName.of(name));
        if (v) d.set(PDFName.of(name), v);
      }
      const st = deref(doc, r.dict.get(PDFName.of("St")));
      d.set(PDFName.of("St"), PDFNumber.of((st instanceof PDFNumber ? st.asNumber() : 1) + (k - r.start)));
    }
    out.push(PDFNumber.of(i));
    out.push(d);
  });
  doc.catalog.set(key, doc.context.obj({ Nums: out }));
}
