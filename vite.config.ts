import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const require = createRequire(import.meta.url);

/**
 * Identity of the OCR engine bytes, injected into the app as
 * `__OCR_ASSET_VERSION__`.
 *
 * `public/sw.js` caches the Tesseract core, whose filenames are fixed by
 * tesseract.js (`getCore.js` builds them) and so carry no content hash. The app
 * registers the worker as `sw.js?v=<this>` and the cache is named from it, which
 * is what makes upgrading either package evict the old core instead of serving
 * it forever. Read from the installed packages rather than hard-coded, so a
 * `npm update` can't silently leave the two out of step.
 */
const ocrAssetVersion = [
  require("tesseract.js/package.json").version,
  require("tesseract.js-core/package.json").version,
].join("-");

/**
 * pdf.js's WebAssembly decoders, served from the app's own origin.
 *
 * pdf.js 5 decodes JPEG 2000 (OpenJPEG) and JBIG2 and fax-coded scans (one
 * module, `jbig2`) with WebAssembly modules fetched at runtime from the
 * `wasmUrl` document option, falling back to a script build of each fetched
 * from the same place. Unset, both fetches fail
 * and the image is quietly not painted — a scanned page opens blank. So the
 * modules ship as part of the app, under a folder named for the pdf.js version
 * (their file names are fixed by pdf.js, so the folder is what changes when
 * pdf.js does), and the app passes that folder as `wasmUrl`.
 *
 * The script fallbacks ship too: browsers with WebAssembly switched off (e.g.
 * a hardened "no JIT" mode) still decode, just slower. Not `quickjs-eval`: that
 * runs a document's own JavaScript, which this app never does. Not `qcms` (ICC
 * colour profiles) either: pdf.js uses it only when its worker fetches for
 * itself (`useWorkerFetch`, which also wants CMap and standard-font folders),
 * so ICC images keep drawing in their alternate colour space, as in pdf.js 4.
 */
const pdfjsVersion: string = require("pdfjs-dist/package.json").version;
const PDFJS_ASSET_DIR = `pdfjs-${pdfjsVersion}/`;
const PDFJS_WASM_FILES = [
  "openjpeg.wasm",
  "openjpeg_nowasm_fallback.js",
  "jbig2.wasm",
  "jbig2_nowasm_fallback.js",
  "LICENSE_OPENJPEG",
  "LICENSE_PDFJS_OPENJPEG",
  "LICENSE_JBIG2",
  "LICENSE_PDFJS_JBIG2",
];
const pdfjsWasmFile = (name: string) => require.resolve(`pdfjs-dist/wasm/${name}`);

function pdfjsWasmPlugin(): Plugin {
  const type = (name: string) =>
    name.endsWith(".wasm") ? "application/wasm" : name.endsWith(".js") ? "text/javascript" : "text/plain";
  return {
    name: "pdfjs-wasm-decoders",
    async generateBundle() {
      for (const name of PDFJS_WASM_FILES) {
        this.emitFile({ type: "asset", fileName: PDFJS_ASSET_DIR + name, source: await readFile(pdfjsWasmFile(name)) });
      }
    },
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const path = (req.url ?? "").split("?")[0];
        const name = path.startsWith(`/${PDFJS_ASSET_DIR}`) ? path.slice(PDFJS_ASSET_DIR.length + 1) : "";
        if (!PDFJS_WASM_FILES.includes(name)) return next();
        res.setHeader("Content-Type", type(name));
        res.end(await readFile(pdfjsWasmFile(name)));
      });
    },
  };
}

/**
 * Inject a Content-Security-Policy `<meta>` into index.html.
 *
 * The app's core promise is that the document never leaves the device. Today
 * that's upheld by convention — no `fetch` to anywhere, no CDN — which is a
 * property of the code as written, not something the browser enforces. A CSP
 * turns it into a rule the runtime applies: with `default-src 'self'` and
 * `connect-src 'self'`, a stray dependency, a compromised transitive package,
 * or an injection in a future refactor *cannot* reach an external host with the
 * user's PDF. It also blocks the classes of attack a file parser invites
 * (injected `<script>`, `<object>`, `<base>` hijacking).
 *
 * Notes on the specific relaxations, since a policy nobody understands is a
 * policy that gets deleted:
 *  - `'wasm-unsafe-eval'` — tesseract.js (OCR) and @jsquash/jpeg (compression)
 *    compile WebAssembly, which CSP treats as eval unless allowed explicitly.
 *  - `style-src 'unsafe-inline'` — every overlay is positioned with a React
 *    `style=` attribute. Inline *style attributes* require this; there is no
 *    hash mechanism for them, and injected CSS is not part of the threat model.
 *  - `img-src` / `connect-src` `data:` + `blob:` — page rasters, signature and
 *    image stamps, thumbnails, and the OCR worker bootstrap all use them, all
 *    locally generated.
 *  - Inline `<script>` is allowed only by SHA-256 hash, computed here from the
 *    actual file contents, so editing the theme bootstrap can't silently break
 *    the policy (or silently widen it).
 *
 * `frame-ancestors` is deliberately absent: it is ignored in a meta-tag policy.
 * It needs a real response header, which GitHub Pages doesn't let us set.
 */
function cspPlugin(): Plugin {
  return {
    name: "inject-csp",
    transformIndexHtml: {
      order: "post",
      handler(html, ctx) {
        const hashes = [
          ...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi),
        ]
          .map((m) => m[1])
          .filter((code) => code.trim().length > 0)
          .map((code) => `'sha256-${createHash("sha256").update(code).digest("base64")}'`);

        // The dev server needs its HMR websocket and injects its own inline
        // client code; production is the policy that matters and stays tight.
        const dev = !!ctx.server;
        const connect = dev ? "'self' ws: wss: data: blob:" : "'self' data: blob:";
        const script = dev
          ? "'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'"
          : ["'self'", "'wasm-unsafe-eval'", ...hashes].join(" ");

        const policy = [
          "default-src 'self'",
          `script-src ${script}`,
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data: blob:",
          "font-src 'self'",
          `connect-src ${connect}`,
          "worker-src 'self' blob:",
          "object-src 'none'",
          "base-uri 'none'",
          "form-action 'none'",
        ].join("; ");

        return {
          html,
          tags: [
            {
              tag: "meta",
              attrs: { "http-equiv": "Content-Security-Policy", content: policy },
              injectTo: "head-prepend",
            },
          ],
        };
      },
    },
  };
}

/**
 * Patch pdf.js's worker so a ligature can't take over a plain letter.
 *
 * pdf.js rebuilds every embedded font before handing it to the page, and adds a
 * cmap entry per glyph from the font's ToUnicode — so the face also works when
 * fed ordinary Unicode text. It keys that entry on the *first* code point of the
 * glyph's text, so the "fi" ligature (text "fi") is filed under "f" and, coming
 * later, replaces the real "f": every "f" typed in that face draws "fi"
 * ("from" → "firom"). (pdf.js 5 files the standard ligatures — "fi", "ffl",
 * U+FB00–FB4F — under their own code points instead; any other glyph whose
 * text is several characters, a "ct" or a "Th", still lands on its first.) pdf.js's own canvas never notices (it draws by private-use
 * codes); everything here that uses the face by Unicode does — the selected
 * overlay, the raster export's `ctx.font`, and the vector export, which embeds
 * these very bytes (`fontEmbed.ts`). So it is fixed once, at the source: a glyph
 * whose text is more than one character gets no Unicode entry.
 *
 * Same table, second gap: pdf.js treats a glyph with no outline as missing and
 * leaves it out — and a space has no outline. So the face had no space: the
 * overlay borrowed one from the fallback font, and the vector export drew the
 * face's .notdef box for every space in an edit. A glyph pdf.js skips now still
 * gets its Unicode entry when its text is one whitespace character (unless a
 * real glyph already has it). Only that Unicode entry: pdf.js's own canvas
 * draws through private-use codes, so what it renders is unchanged.
 *
 * Applied to the exact file the app imports (`pdf.worker.min.mjs?url`): as an
 * emitted asset in the build, and on the fly in dev. If a pdf.js upgrade moves
 * the code, the build fails rather than silently dropping the fix.
 */
const PDF_WORKER = /[\\/]pdfjs-dist[\\/]legacy[\\/]build[\\/]pdf\.worker\.min\.mjs$/;
/** `adjustMapping`'s ToUnicode lookup for a glyph whose text is more than one
 * UTF-16 unit: since pdf.js 5 a standard ligature (U+FB00–FB4F) gets its own
 * code point, and anything else falls back to the first code point. */
const FIRST_CODE_POINT = /(\w+)=(\w+)\.get\(\1\)\|\|\1\.codePointAt\(0\)\}if\(\1&&/g;
/** `adjustMapping`'s head, up to where it skips a glyph `hasGlyph` rejects:
 * names its ToUnicode map (4th parameter) and the extra Unicode map (2nd const). */
const SKIPPED_GLYPH =
  /function adjustMapping\((\w+),(\w+),(\w+),(\w+)\)\{const (\w+)=Object\.create\(null\),(\w+)=new Map,([^{}]*?)for\(const (\w+) in \1\)\{let (\w+)=\1\[\8\];if\(!\2\(\9\)\)continue;/g;

function replaceOnce(code: string, re: RegExp, what: string, fn: (...m: string[]) => string): string {
  const hits = [...code.matchAll(re)].length;
  if (hits !== 1) {
    throw new Error(
      `pdf.js worker patch: expected 1 ${what}, found ${hits}. ` +
        "pdf.js changed — re-check adjustMapping (see pdfWorkerPlugin in vite.config.ts).",
    );
  }
  return code.replace(re, fn as (m: string, ...rest: string[]) => string);
}

/** A composite (CID) font's charcode → glyph table, which drops a glyph
 * `hasGlyph` rejects before `adjustMapping` ever sees it. */
const CID_PREFILTER = /Max size of CID is 65,535"\);let (\w+)=-1;([^;]*);\1>=0&&\1<(\w+)&&hasGlyph\(\1\)&&\((\w+)\[(\w+)\]=\1\)/g;

function patchPdfWorker(code: string): string {
  // Composite fonts (Word's usual Identity-H): keep outline-less glyphs in the
  // table; `adjustMapping` already skips them for drawing (`hasGlyph` there),
  // and now gives a space its Unicode entry.
  const cid = replaceOnce(code, CID_PREFILTER, "composite-font glyph pre-filter", (_m, g, pick, n, map, cc) =>
    `Max size of CID is 65,535");let ${g}=-1;${pick};${g}>=0&&${g}<${n}&&(${map}[${cc}]=${g})`,
  );
  const ligatures = replaceOnce(
    cid, FIRST_CODE_POINT, "ToUnicode first-code-point site", (_m, u, ligs) =>
    // pdf.js's own: a standard ligature is filed under its own code point. Then
    // one code point (here, one outside the BMP: two UTF-16 units) keeps its
    // entry; more get none.
    `${u}=${ligs}.get(${u})||(${u}.length>(${u}.codePointAt(0)>65535?2:1)?void 0:${u}.codePointAt(0))}if(${u}&&`,
  );
  return replaceOnce(
    ligatures,
    SKIPPED_GLYPH,
    "adjustMapping missing-glyph skip",
    (_m, map, hasGlyph, zero, toUnicode, newMap, extra, rest, code_, glyph) =>
      `function adjustMapping(${map},${hasGlyph},${zero},${toUnicode}){const ${newMap}=Object.create(null),${extra}=new Map,${rest}` +
      `for(const ${code_} in ${map}){let ${glyph}=${map}[${code_}];if(!${hasGlyph}(${glyph})){` +
      // An outline-less glyph whose text is one whitespace character: a space.
      `const w=${toUnicode}.get(${code_});if("string"==typeof w&&/^\\s$/u.test(w)&&!${extra}.has(w.codePointAt(0)))${extra}.set(w.codePointAt(0),${glyph});` +
      `continue}`,
  );
}

function pdfWorkerPlugin(): Plugin {
  let serve = false;
  return {
    name: "pdfjs-worker-single-glyph-cmap",
    enforce: "pre",
    configResolved(c) {
      serve = c.command === "serve";
    },
    // Build: the `?url` import becomes an emitted asset — of the patched source.
    async load(id) {
      if (serve || !id.endsWith("?url")) return null;
      const file = id.slice(0, -"?url".length);
      if (!PDF_WORKER.test(file)) return null;
      const source = patchPdfWorker(await readFile(file, "utf8"));
      const ref = this.emitFile({ type: "asset", name: "pdf.worker.min.mjs", source });
      return `export default import.meta.ROLLUP_FILE_URL_${ref};`;
    },
    // Dev: the worker is fetched from /node_modules as a module; patch it there.
    transform(code, id) {
      // (Not the `?url` stub that only exports its address.)
      if (!serve || /[?&]url\b/.test(id) || !PDF_WORKER.test(id.split("?")[0])) return null;
      return { code: patchPdfWorker(code), map: null };
    },
  };
}

export default defineConfig({
  plugins: [react(), cspPlugin(), pdfWorkerPlugin(), pdfjsWasmPlugin()],
  base: "./",
  resolve: {
    // One PDF engine. The app writes with @cantoo/pdf-lib (the maintained
    // fork); @signpdf/placeholder-pdf-lib imports "pdf-lib" itself, and
    // objects from two copies of the library can't be mixed in one document
    // (the writer's instanceof checks fail). Upstream pdf-lib stays a
    // devDependency only, as the tests' independent reader.
    alias: [{ find: /^pdf-lib$/, replacement: "@cantoo/pdf-lib" }],
  },
  // Workers are created with `{ type: "module" }`, and the codec worker
  // lazy-loads MozJPEG with a dynamic import, which only an ES-module worker
  // bundle can split out.
  worker: { format: "es" },
  define: {
    __OCR_ASSET_VERSION__: JSON.stringify(ocrAssetVersion),
    __PDFJS_ASSET_DIR__: JSON.stringify(PDFJS_ASSET_DIR),
  },
  build: {
    rollupOptions: {
      output: {
        // Split the big third-party libraries into their own long-lived
        // chunks so they cache across deploys (app code changes far more
        // often than pdf.js / React), and the initial bundle isn't one
        // monolith. pdf-lib and tesseract.js are already lazy-loaded, so
        // they stay out of the initial graph on their own.
        manualChunks(id) {
          if (id.includes("node_modules")) {
            if (id.includes("pdfjs-dist")) return "pdfjs";
            if (id.includes("react") || id.includes("scheduler")) return "react";
          }
        },
      },
    },
  },
});
