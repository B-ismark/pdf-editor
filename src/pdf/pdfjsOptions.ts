/**
 * Options every `getDocument()` in the app passes.
 *
 * `wasmUrl`: where pdf.js's worker fetches its WebAssembly decoders (JPEG 2000,
 * JBIG2 and fax-coded scans, ICC colour profiles). They ship with the app — see
 * `pdfjsWasmPlugin` in vite.config.ts — and without this, those images aren't
 * painted at all. Absolute, because the worker resolves a relative URL against
 * its own script, not the page.
 */
export const pdfjsDocOptions = {
  wasmUrl: new URL(__PDFJS_ASSET_DIR__, document.baseURI).href,
} as const;
