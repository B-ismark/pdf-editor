import type { PDFDocument, PDFFont } from "@cantoo/pdf-lib";

/** An embedded source font plus a coverage test for the text about to use it. */
export interface EmbeddedSourceFont {
  font: PDFFont;
  /** True only if the font has a glyph for every code point in `text`. */
  covers: (text: string) => boolean;
}

export interface SourceFontEmbedder {
  /** Embed the document's own font for a fragment (identified by page + the
   *  fragment's text-item index) into the output, or null if it can't be
   *  extracted / re-embedded — the caller then falls back to a standard font. */
  get: (pageIndex: number, itemIndex: number) => Promise<EmbeddedSourceFont | null>;
  destroy: () => Promise<void>;
}

/**
 * Re-embeds the SOURCE PDF's own fonts into the exported document so that
 * edited text keeps the document's typeface instead of a standard-font
 * approximation.
 *
 * PDF.js (with `fontExtraProperties` + `disableFontFace`) reconstructs each
 * embedded font into a valid sfnt exposed as `commonObjs.get(id).data` once the
 * page has been rendered; we hand those bytes to pdf-lib + fontkit, subsetting
 * to the glyphs actually drawn.
 *
 * A font's PDF.js `loadedName` (e.g. "g_d0_f1") is only stable *within one
 * getDocument() call*, so a name captured elsewhere can't be reused here —
 * instead we re-read each page's text content in this document and map the
 * fragment's `itemIndex` to the local font id.
 *
 * Everything is best-effort and lazily imported: if PDF.js/fontkit can't load,
 * a page won't render, or a glyph is missing, `get()` returns null and the
 * exporter uses a standard font — so export never fails because of this path.
 */
export async function createSourceFontEmbedder(
  bytes: ArrayBuffer,
  out: PDFDocument,
): Promise<SourceFontEmbedder> {
  const NOOP: SourceFontEmbedder = { get: async () => null, destroy: async () => {} };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fontkit: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let doc: any;
  try {
    const pdfjs = await import("pdfjs-dist");
    fontkit = (await import("@pdf-lib/fontkit")).default;
    out.registerFontkit(fontkit);
    doc = await pdfjs.getDocument({ data: bytes.slice(0), fontExtraProperties: true, disableFontFace: true }).promise;
  } catch {
    return NOOP;
  }

  // Per page: local text-item index -> this document's font id. Built lazily by
  // rendering the page (which resolves its fonts into commonObjs) then reading
  // its text content.
  const pageFonts = new Map<number, Map<number, string>>();
  const cache = new Map<string, EmbeddedSourceFont | null>();

  const preparePage = async (pageIndex: number): Promise<Map<number, string> | null> => {
    const cached = pageFonts.get(pageIndex);
    if (cached) return cached;
    const names = new Map<number, string>();
    pageFonts.set(pageIndex, names);
    try {
      const page = await doc.getPage(pageIndex + 1);
      // Render tiny (font loading is scale-independent) so PDF.js populates the
      // page's fonts into commonObjs. getOperatorList alone doesn't, in the
      // worker build.
      const viewport = page.getViewport({ scale: 0.2 });
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.ceil(viewport.width));
      canvas.height = Math.max(1, Math.ceil(viewport.height));
      const ctx = canvas.getContext("2d");
      if (ctx) await page.render({ canvasContext: ctx, viewport }).promise;
      const content = await page.getTextContent();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      content.items.forEach((item: any, i: number) => {
        if (item && typeof item.fontName === "string") names.set(i, item.fontName);
      });
    } catch {
      /* leave the map empty → every lookup falls back */
    }
    return names;
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const readData = (page: any, fontName: string): Promise<Uint8Array | null> =>
    new Promise((resolve) => {
      let settled = false;
      const finish = (v: Uint8Array | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(v);
      };
      const timer = setTimeout(() => finish(null), 4000);
      try {
        if (page.commonObjs.has(fontName)) {
          finish(page.commonObjs.get(fontName)?.data ?? null);
        } else {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          page.commonObjs.get(fontName, (o: any) => finish(o?.data ?? null));
        }
      } catch {
        finish(null);
      }
    });

  return {
    async get(pageIndex, itemIndex) {
      let result: EmbeddedSourceFont | null = null;
      try {
        const names = await preparePage(pageIndex);
        const fontName = names?.get(itemIndex);
        if (!fontName) return null;
        if (cache.has(fontName)) return cache.get(fontName)!;
        const page = await doc.getPage(pageIndex + 1);
        const data = await readData(page, fontName);
        if (data && data.length) {
          const bytesCopy = new Uint8Array(data);
          const font = await out.embedFont(bytesCopy, { subset: true });
          const kit = fontkit.create(bytesCopy);
          const covers = (text: string) => {
            for (const ch of text) {
              const cp = ch.codePointAt(0);
              // Whitespace is positioned by advance width, not a glyph — subset
              // fonts routinely omit a space glyph, so don't let it fail coverage.
              if (cp == null || cp <= 0x20) continue;
              if (!kit.hasGlyphForCodePoint(cp)) return false;
            }
            return true;
          };
          result = { font, covers };
        }
        cache.set(fontName, result);
      } catch {
        result = null;
      }
      return result;
    },
    async destroy() {
      try {
        await doc.destroy();
      } catch {
        /* ignore */
      }
    },
  };
}
