import { getCachedDoc, releaseDoc, renderPageToCanvas } from "./pdf/loader";

/**
 * Print a PDF — the finished file, edits and all — through the browser's own
 * print dialog.
 *
 * Each page is drawn by pdf.js at print resolution and laid out, a sheet each,
 * in a container that is the only thing on the printed page (the app hides
 * itself under `@media print`). That is how pdf.js's own viewer prints, and it
 * is the one way that behaves alike in every browser: printing a PDF in a
 * frame depends on a built-in viewer that phones and some browsers don't
 * have, and would need the page's content policy to allow framing blobs.
 */

/** Print resolution: 150 dots per inch, as pdf.js prints. */
const DPI = 150;
/** The most pixels one printed page gets — a poster-sized page would ask for
 * more than a canvas holds on a phone. */
const MAX_PAGE_PX = 12_000_000;

let current: (() => void) | null = null;

/** Put the printed pages away and give their memory back. */
function cleanUp(): void {
  current?.();
  current = null;
}

export async function printPdf(
  bytes: ArrayBuffer,
  onProgress: (page: number, total: number) => void,
): Promise<void> {
  cleanUp();
  const doc = await getCachedDoc(bytes);
  const root = document.createElement("div");
  root.id = "print-root";
  root.setAttribute("aria-hidden", "true");
  const urls: string[] = [];
  const sheet = new CSSStyleSheet();
  const printing = window.matchMedia("print");
  // `afterprint` isn't fired everywhere; leaving print media is the other sign.
  const onMedia = (e: MediaQueryListEvent) => {
    if (!e.matches) cleanUp();
  };
  current = () => {
    root.remove();
    document.body.classList.remove("printing-doc");
    for (const u of urls) URL.revokeObjectURL(u);
    document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== sheet);
    window.removeEventListener("afterprint", cleanUp);
    printing.removeEventListener("change", onMedia);
  };
  try {
    // One named page size per distinct page size, so a landscape page in a
    // portrait document prints on a landscape sheet, not clipped onto a
    // portrait one.
    const sizes = new Map<string, string>();
    for (let i = 0; i < doc.numPages; i++) {
      onProgress(i + 1, doc.numPages);
      const page = await doc.getPage(i + 1);
      const vp = page.getViewport({ scale: 1 });
      const size = `${vp.width}pt ${vp.height}pt`;
      if (!sizes.has(size)) sizes.set(size, `pdfsheet${sizes.size}`);
      const want = DPI / 72;
      const scale = Math.min(want, Math.sqrt(MAX_PAGE_PX / (vp.width * vp.height)));
      const canvas = await renderPageToCanvas(bytes, i, scale);
      const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/png"));
      canvas.width = canvas.height = 0;
      if (!blob) throw new Error("Couldn't draw a page for printing");
      const url = URL.createObjectURL(blob);
      urls.push(url);
      const img = document.createElement("img");
      img.className = "print-page";
      img.alt = "";
      img.src = url;
      // Sized in points, so it prints at the page's own size.
      img.style.width = `${vp.width}pt`;
      img.style.height = `${vp.height}pt`;
      img.style.setProperty("page", sizes.get(size)!);
      root.append(img);
      await img.decode().catch(() => {});
    }
    // The sheets the printer is asked for: each page's own size, no margins —
    // the page carries its own. The first size is also the default, for a
    // browser that doesn't know named pages. (A constructed sheet: no
    // <style> element to inject, and nothing left behind once it's removed.)
    const [firstSize] = sizes.keys();
    const rules = [...sizes].map(([size, name]) => `@page ${name} { size: ${size}; margin: 0; }`);
    if (firstSize) rules.unshift(`@page { size: ${firstSize}; margin: 0; }`);
    sheet.replaceSync(rules.join("\n"));
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    document.body.append(root);
    document.body.classList.add("printing-doc");
  } catch (e) {
    cleanUp();
    throw e;
  } finally {
    releaseDoc(bytes);
  }
  // Most browsers block on print(); some return at once and print later.
  // Either way the pages go when printing is over.
  window.addEventListener("afterprint", cleanUp, { once: true });
  printing.addEventListener("change", onMedia);
  window.print();
}
