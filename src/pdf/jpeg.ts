/**
 * JPEG encoding for the compress path.
 *
 * Prefers **MozJPEG** (via `@jsquash/jpeg`, a self-hosted WASM build of the
 * codec) which produces meaningfully smaller files than the browser's built-in
 * `canvas.toDataURL("image/jpeg")` at the same visual quality. The WASM binary
 * is bundled by Vite (`new URL(..., import.meta.url)`) and fetched from the
 * app's own origin, so nothing leaves the device.
 *
 * If the codec can't be loaded or fails for any reason, we fall back to the
 * browser encoder — so compression always works, just a touch larger.
 */

/** A function that encodes a rendered page canvas to JPEG bytes. */
export type JpegEncoder = (canvas: HTMLCanvasElement) => Promise<Uint8Array>;

/** Convert a `data:` URL to raw bytes without a network round-trip. */
function dataUrlToBytes(dataUrl: string): Uint8Array {
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** Browser-native fallback encoder. */
function browserEncoder(quality01: number): JpegEncoder {
  return async (canvas) => dataUrlToBytes(canvas.toDataURL("image/jpeg", quality01));
}

/**
 * Resolve the best available JPEG encoder for the given quality (0..1). Loads
 * MozJPEG lazily; returns the browser encoder if the codec is unavailable.
 */
export async function loadJpegEncoder(quality01: number): Promise<JpegEncoder> {
  const quality = Math.max(1, Math.min(100, Math.round(quality01 * 100)));
  try {
    const { default: encode, init } = await import("@jsquash/jpeg/encode");
    // Surface a load/init failure here (not mid-loop) so we can fall back once.
    await init();
    const moz: JpegEncoder = async (canvas) => {
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("no 2d context");
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const buf = await encode(imageData, { quality });
      return new Uint8Array(buf);
    };
    // Smoke-test on a 1×1 canvas so a broken WASM instance falls back cleanly
    // rather than throwing on the first real page.
    const probe = document.createElement("canvas");
    probe.width = probe.height = 1;
    await moz(probe);
    return moz;
  } catch {
    return browserEncoder(quality01);
  }
}
