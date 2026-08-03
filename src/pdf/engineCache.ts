/**
 * The OCR engine cache: register/teardown for `public/sw.js`.
 *
 * Kept in its own module — deliberately free of any import from `ocr.ts` — so
 * `App` can reach `clearEngineCache` without dragging tesseract.js and the
 * render path's OCR code into the initial bundle. The service worker itself is
 * documented in `public/sw.js`; this is only the app's half of the contract.
 *
 * The cache is treated as part of "Save session on this device", not as a
 * separate invisible store. It holds engine binaries rather than anything of the
 * user's, but a switch labelled "don't keep things on this device" that quietly
 * left 1.4 MB of wasm behind would be a switch that lies, so it's covered by the
 * same toggle.
 */

const BASE = import.meta.env.BASE_URL;

/** Version of the installed tesseract.js / tesseract.js-core (see
 * vite.config.ts) — names the cache, so an upgrade evicts the old core. */
const ASSET_VERSION = __OCR_ASSET_VERSION__;

/** Longest we'll wait for the worker to take control before starting OCR
 * anyway. Short on purpose — this is an optimisation, not a prerequisite. */
const CONTROL_TIMEOUT = 3_000;

/** Matches the naming in `public/sw.js`, which owns these caches. */
const CACHE_PREFIX = "ocr-core-";

/**
 * Make sure the engine cache is registered and controlling this page, then
 * resolve. Call this only when the user has on-device storage switched on.
 *
 * Registered here rather than at app startup so the only users who ever get a
 * service worker are the ones who actually run OCR; someone who just edits a PDF
 * keeps a browser profile with nothing installed in it.
 *
 * The wait matters. Tesseract fetches the core the instant its worker boots, and
 * a freshly-installed service worker doesn't control the page until it activates
 * — so without waiting, the very run that triggered registration would miss the
 * cache and store nothing. `sw.js` calls `skipWaiting()`/`clients.claim()` to
 * make that handoff quick.
 *
 * Every failure path is deliberately silent: no service worker support, a blocked
 * registration, or a slow activation all just mean OCR runs uncached.
 */
export async function ensureEngineCache(): Promise<void> {
  if (!("serviceWorker" in navigator)) return;
  try {
    // Scope defaults to the script's own directory, which is the app root under
    // both `/` and the `/pdf-editor/` subpath Pages serves from.
    await navigator.serviceWorker.register(`${BASE}sw.js?v=${ASSET_VERSION}`);
    if (!navigator.serviceWorker.controller) {
      await new Promise<void>((resolve) => {
        const settle = () => {
          clearTimeout(timer);
          navigator.serviceWorker.removeEventListener("controllerchange", settle);
          resolve();
        };
        const timer = setTimeout(settle, CONTROL_TIMEOUT);
        navigator.serviceWorker.addEventListener("controllerchange", settle);
      });
    }
    // Arm it. The worker caches nothing until told to, and forgets being told
    // whenever the browser recycles it, so this is sent before every run rather
    // than once at registration — see the `caching` flag in public/sw.js.
    navigator.serviceWorker.controller?.postMessage({ type: "enable" });
  } catch {
    /* Caching is an optimisation; OCR has to work without it. */
  }
}

/**
 * Erase the cached engine and stop caching it. Paired with the session toggle.
 *
 * Unregistering alone is not enough: it removes the registration, but the active
 * worker keeps controlling already-open pages until they unload, so OCR run again
 * in the same tab would write the engine straight back. What actually prevents
 * that is `sw.js` caching only while armed, and `ensureEngineCache` arming it
 * only when the pref is on — this function just stands the worker down for the
 * current page, drops the bytes, and makes sure nothing is installed next visit.
 */
export async function clearEngineCache(): Promise<void> {
  try {
    navigator.serviceWorker?.controller?.postMessage({ type: "disable" });
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n.startsWith(CACHE_PREFIX)).map((n) => caches.delete(n)));
    const regs = (await navigator.serviceWorker?.getRegistrations?.()) ?? [];
    await Promise.all(regs.map((r) => r.unregister()));
  } catch {
    /* Storage unavailable (private mode etc.) — nothing to erase. */
  }
}
