/// <reference types="vite/client" />

declare module "*?url" {
  const url: string;
  export default url;
}

/** Version of the installed tesseract.js / tesseract.js-core, injected by the
 * `define` in vite.config.ts. Names the OCR engine cache in public/sw.js. */
declare const __OCR_ASSET_VERSION__: string;
