// Copies the Tesseract worker + wasm core into public/tesseract and downloads
// the English language model into public/tessdata, so OCR runs entirely from
// the app's own origin (no CDN at runtime — privacy first).
//
// Run this once with network access (locally or in CI) before building:
//   npm run setup-ocr
//
// The assets it produces are git-ignored (they're large binaries); the deploy
// workflow runs this step so production bundles them.
import { mkdir, copyFile, writeFile, access } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const root = process.cwd();
const tessDir = join(root, "public", "tesseract");
const langDir = join(root, "public", "tessdata");

const LANG = "eng";
// tessdata_fast keeps the model small (~2 MB) while staying accurate enough.
const LANG_URL = `https://tessdata.projectnaptha.com/4.0.0_fast/${LANG}.traineddata.gz`;

async function main() {
  await mkdir(tessDir, { recursive: true });
  await mkdir(langDir, { recursive: true });

  // Worker + LSTM wasm cores. tesseract.js picks a core variant at RUNTIME
  // from the browser's CPU features: plain, `simd`, or `relaxedsimd`. Modern
  // Chrome/Edge/Safari support relaxed SIMD and request the `relaxedsimd`
  // core, so shipping only one variant makes OCR 404 (and fail) on most
  // devices. Copy every LSTM variant — whichever the browser chooses is then
  // present. (Each variant is a `.wasm.js` glue file plus its `.wasm`.)
  const worker = require.resolve("tesseract.js/dist/worker.min.js");
  await copyFile(worker, join(tessDir, "worker.min.js"));

  const CORE_VARIANTS = [
    "tesseract-core-lstm", // baseline (no SIMD)
    "tesseract-core-simd-lstm", // SIMD
    "tesseract-core-relaxedsimd-lstm", // relaxed SIMD (most modern browsers)
  ];
  for (const name of CORE_VARIANTS) {
    const coreJs = require.resolve(`tesseract.js-core/${name}.wasm.js`);
    const coreWasm = join(dirname(coreJs), `${name}.wasm`);
    await copyFile(coreJs, join(tessDir, `${name}.wasm.js`));
    await copyFile(coreWasm, join(tessDir, `${name}.wasm`));
  }
  console.log(`✓ Copied Tesseract worker + ${CORE_VARIANTS.length} wasm cores into public/tesseract`);

  const langFile = join(langDir, `${LANG}.traineddata.gz`);
  try {
    await access(langFile);
    console.log("✓ Language model already present");
  } catch {
    console.log(`↓ Downloading ${LANG} language model…`);
    const res = await fetch(LANG_URL);
    if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
    const buf = Buffer.from(await res.arrayBuffer());
    await writeFile(langFile, buf);
    console.log(`✓ Saved ${LANG}.traineddata.gz (${(buf.length / 1e6).toFixed(1)} MB)`);
  }

  console.log("\nOCR is ready. Rebuild the app to bundle the assets.");
}

main().catch((err) => {
  console.error("\nsetup-ocr failed:", err.message);
  console.error(
    "If your network blocks tessdata.projectnaptha.com, download\n" +
      `${LANG}.traineddata.gz manually into public/tessdata/ and re-run.`,
  );
  process.exit(1);
});
