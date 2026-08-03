/*
 * Service worker whose only job is to cache the OCR engine.
 *
 * Why this exists
 * ---------------
 * A first OCR run transfers ~4.25 MB: the Tesseract wasm core (~1.4 MB
 * gzipped), the English language model (2.82 MB, already compressed), and the
 * worker shim. tesseract.js caches the *language model* in IndexedDB itself, so
 * that 2.82 MB is a once-per-device cost. The core is not cached — it arrives
 * via `importScripts`, so it relies purely on the HTTP cache, and GitHub Pages
 * serves everything with `Cache-Control: max-age=600`. Ten minutes later the
 * same user re-downloads the same 1.4 MB. This makes the core persist like the
 * language model already does.
 *
 * Why it is scoped this narrowly
 * ------------------------------
 * The product's promise is that the document never leaves the device, and a
 * service worker is the one piece of this app that keeps running with the power
 * to see requests. So it handles exactly one thing: same-origin GETs under
 * `<scope>tesseract/`, a directory that by construction (see
 * `scripts/setup-ocr.mjs`) holds nothing but engine binaries. Every other
 * request — the app shell, page rasters, and above all the user's PDF — returns
 * from this handler untouched, meaning the browser fetches it exactly as if no
 * service worker existed. There is deliberately no offline app shell here: that
 * would mean caching the application itself, which is a much larger surface for
 * no benefit to this problem. `tests/ocr.spec.ts` asserts the cache contains
 * only `tesseract/` entries, so a future widening has to be deliberate.
 *
 * Cache invalidation
 * ------------------
 * The core filenames are fixed (`tesseract-core-*-lstm.wasm.js`) — tesseract.js
 * builds them itself in `getCore.js`, so they carry no content hash and a stale
 * entry would survive a dependency upgrade. The app therefore registers this
 * script as `sw.js?v=<tesseract.js>-<tesseract.js-core>` and the cache is named
 * from that `v`. Bumping either package changes the script URL (which triggers a
 * service-worker update) and the cache name (so the old bytes are dropped in
 * `activate`).
 */

const VERSION = new URL(self.location.href).searchParams.get("v") || "dev";
const CACHE_PREFIX = "ocr-core-";
const CACHE = `${CACHE_PREFIX}${VERSION}`;

/** Engine assets live here and nothing else does. `registration.scope` is an
 * absolute URL ending in `/`, so this stays correct under the project subpath
 * GitHub Pages serves the app from (`/pdf-editor/`) as well as at the root. */
const CORE_PREFIX = `${self.registration.scope}tesseract/`;

self.addEventListener("install", () => {
  // Take over as soon as possible rather than waiting for every tab using the
  // old worker to close: the app registers this lazily, on the first OCR run,
  // and then waits for control before booting Tesseract. Without skipWaiting
  // that wait would time out and the run it was registered for would go
  // uncached.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Drop other versions' caches — same reason the name is versioned.
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE).map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

/**
 * Whether to cache at all — **off until the app says otherwise**, and it says so
 * immediately before each OCR run (`ensureEngineCache`), only while "Save session
 * on this device" is on.
 *
 * Default-deny, for two reasons that both bit the first version of this file:
 *
 *  - `unregister()` does not stop an already-active worker from serving pages
 *    that are still open. A user who switched the toggle off and ran OCR again in
 *    the same tab got the engine written straight back.
 *  - A service worker is killed when idle and restarted on the next event, so any
 *    "disabled" state held in a variable evaporates. Defaulting to enabled and
 *    switching off on a message therefore silently un-disabled itself; defaulting
 *    to disabled fails the safe way, because a restart just means one OCR run
 *    goes uncached until the app arms it again.
 */
let caching = false;

self.addEventListener("message", (event) => {
  const type = event.data && event.data.type;
  if (type === "disable") caching = false;
  else if (type === "enable") caching = true;
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  // Returning without calling respondWith leaves the request completely alone.
  if (!caching) return;
  if (req.method !== "GET") return;
  if (!req.url.startsWith(CORE_PREFIX)) return;
  event.respondWith(cacheFirst(req));
});

/**
 * Serve the engine from the cache, falling back to the network and storing what
 * comes back. Cache-first (rather than revalidate) is right here because the
 * cache name already encodes the engine version: an entry can only be stale if
 * the version changed, and that produces a different cache.
 */
async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;

  const res = await fetch(req);
  // Only keep a complete, successful, same-origin response. Caching an opaque
  // or partial one would poison the cache with bytes that can't be replayed,
  // and a wasm core that half-loads is worse than one that re-downloads.
  if (res.ok && res.type === "basic") {
    // Not awaited: the response should not wait on the write, and a quota
    // failure must degrade to "uncached", never to "OCR is broken".
    cache.put(req, res.clone()).catch(() => {});
  }
  return res;
}
