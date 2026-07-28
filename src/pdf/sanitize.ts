import { PDFArray, PDFDict, PDFDocument, PDFName, PDFString, PDFHexString } from "pdf-lib";
import { isSafeExistingUri } from "./url";

/**
 * Action types allowed to survive on a copied annotation.
 *
 * Everything else is dropped, because the alternative — naming the dangerous
 * ones — misses a long tail that all execute something on the recipient's
 * machine: `/Launch` (run a program), `/SubmitForm` and `/ImportData` (send the
 * document's data to a URL), `/GoToR` and `/GoToE` (reach into another file),
 * `/Movie`, `/Sound`, `/Rendition`, `/RichMedia` (embedded players), and
 * `/JavaScript`. A viewer only needs `/URI` and the in-document jumps to make
 * ordinary links work, so that's the whole list.
 */
const ALLOWED_ACTIONS = new Set(["/URI", "/GoTo", "/Named"]);

/**
 * Strip identifying and potentially-active hidden data from a document before
 * it leaves the browser: document metadata (Info dictionary + XMP), creation/
 * modification timestamps, embedded JavaScript, embedded files, and auto-run
 * actions.
 *
 * This makes the app's privacy promise concrete — a downloaded copy should not
 * silently carry who made it, when, or with what tool, nor any active content
 * that runs when the file is opened. The exporter rebuilds into a fresh
 * document (which already drops the source's catalog-level metadata), so this
 * pass mainly (a) prevents pdf-lib stamping its own Producer/timestamps and
 * (b) scrubs page-level actions that ride along on copied pages.
 *
 * Best-effort and defensive: a malformed object anywhere is skipped rather than
 * failing the whole export. Callers MUST save with `updateMetadata: false` so
 * pdf-lib doesn't re-stamp Producer/CreationDate/ModDate afterwards.
 */
export function sanitizeDocument(doc: PDFDocument): void {
  const ctx = doc.context;
  const catalog = doc.catalog;
  const deref = (obj: unknown) => (obj ? ctx.lookup(obj as never) : undefined);

  // 1) Empty the Info dictionary — author/tool/timestamps and all. pdf-lib
  //    stamps its own Producer + CreationDate/ModDate when the output document
  //    is created, so deleting these here (just before save) is what actually
  //    keeps them out of the downloaded file.
  try {
    const info = deref(ctx.trailerInfo.Info);
    if (info instanceof PDFDict) {
      for (const key of [
        "Title",
        "Author",
        "Subject",
        "Keywords",
        "Creator",
        "Producer",
        "CreationDate",
        "ModDate",
        "Trapped",
      ]) {
        info.delete(PDFName.of(key));
      }
    }
  } catch {
    /* no / malformed Info dict */
  }

  // 2) Remove the XMP metadata stream and any document-level auto-run/extra
  //    actions (OpenAction and AA are common JavaScript triggers).
  for (const key of ["Metadata", "OpenAction", "AA"]) {
    try {
      catalog.delete(PDFName.of(key));
    } catch {
      /* ignore */
    }
  }

  // 3) Remove embedded JavaScript + embedded files from the Names tree, and XFA
  //    (which can carry active content) from any AcroForm.
  try {
    const names = deref(catalog.get(PDFName.of("Names")));
    if (names instanceof PDFDict) {
      names.delete(PDFName.of("JavaScript"));
      names.delete(PDFName.of("EmbeddedFiles"));
    }
  } catch {
    /* ignore */
  }
  try {
    const acro = deref(catalog.get(PDFName.of("AcroForm")));
    if (acro instanceof PDFDict) acro.delete(PDFName.of("XFA"));
  } catch {
    /* ignore */
  }

  // 4) Scrub page-level additional actions and every annotation action that
  //    isn't a plain link. Ordinary URI/GoTo links are preserved (and their
  //    URIs scheme-checked) so real links keep working.
  for (const page of doc.getPages()) {
    try {
      page.node.delete(PDFName.of("AA"));
    } catch {
      /* ignore */
    }
    let annots: unknown;
    try {
      annots = deref(page.node.get(PDFName.of("Annots")));
    } catch {
      annots = undefined;
    }
    if (!(annots instanceof PDFArray)) continue;
    for (let i = 0; i < annots.size(); i++) {
      let annot: unknown;
      try {
        annot = ctx.lookup(annots.get(i));
      } catch {
        continue;
      }
      if (!(annot instanceof PDFDict)) continue;
      try {
        annot.delete(PDFName.of("AA"));
      } catch {
        /* ignore */
      }
      try {
        const action = deref(annot.get(PDFName.of("A")));
        if (action instanceof PDFDict && !isSafeAction(action, deref)) {
          annot.delete(PDFName.of("A"));
        }
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * True when an action dictionary is a plain, inert link we're happy to keep.
 *
 * Three things have to hold, and the third is the one that's easy to miss: an
 * action can chain to further actions through `/Next`, so a permitted `/URI`
 * can tow a `/JavaScript` behind it. The chain is walked (with a depth cap, in
 * case a malformed file loops back on itself) and any disallowed link in it
 * rejects the whole action.
 */
function isSafeAction(
  action: PDFDict,
  deref: (obj: unknown) => unknown,
  depth = 0,
): boolean {
  if (depth > 8) return false;

  const s = action.get(PDFName.of("S"));
  if (!(s instanceof PDFName) || !ALLOWED_ACTIONS.has(s.toString())) return false;

  // A kept /URI must also point somewhere harmless.
  if (s.toString() === "/URI") {
    const uri = action.get(PDFName.of("URI"));
    const text =
      uri instanceof PDFString || uri instanceof PDFHexString
        ? uri.decodeText()
        : null;
    if (text === null || !isSafeExistingUri(text)) return false;
  }

  const next = deref(action.get(PDFName.of("Next")));
  if (next instanceof PDFDict) return isSafeAction(next, deref, depth + 1);
  if (next instanceof PDFArray) {
    for (let i = 0; i < next.size(); i++) {
      const item = deref(next.get(i));
      if (!(item instanceof PDFDict) || !isSafeAction(item, deref, depth + 1)) {
        return false;
      }
    }
  }
  return true;
}
