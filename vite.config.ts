import { createHash } from "node:crypto";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

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

export default defineConfig({
  plugins: [react(), cspPlugin()],
  base: "./",
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
