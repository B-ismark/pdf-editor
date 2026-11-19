/**
 * Options every `getDocument()` in the app passes.
 *
 * `wasmUrl`: where pdf.js fetches its WebAssembly decoders (JPEG 2000, JBIG2
 * and fax-coded scans). They ship with the app — see `pdfjsWasmPlugin` in
 * vite.config.ts — and without this, those images aren't painted at all.
 * Absolute, so it means the same wherever pdf.js resolves it (page or worker).
 */
export const pdfjsDocOptions = {
  wasmUrl: new URL(__PDFJS_ASSET_DIR__, document.baseURI).href,
} as const;
