/**
 * One-off measurement: how big is a redacted-page raster under different
 * encodings? Draws a dense A4 text page (the realistic redaction case) at the
 * exporter's 3× scale and compares PNG (what we ship today), JPEG at a few
 * qualities, and a binarised 1-bit page (the input a JBIG2 encoder would take).
 *
 * Run: PW_EXECUTABLE_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome \
 *      node scripts/measure-raster-codecs.mjs
 */
import { chromium } from "playwright";

const browser = await chromium.launch({ executablePath: process.env.PW_EXECUTABLE_PATH });
const page = await browser.newPage();
await page.goto("about:blank");

const rows = await page.evaluate(async () => {
  const A4 = { w: 595, h: 842 };
  const out = [];

  const drawPage = (S, kind) => {
    const c = document.createElement("canvas");
    c.width = Math.round(A4.w * S);
    c.height = Math.round(A4.h * S);
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.fillStyle = "#000";
    ctx.font = `${16 * S}px serif`;
    const words = "the quick brown fox jumps over a lazy dog while parliament debated the appropriation of funds for infrastructure renewal across seventeen districts".split(" ");
    let y = 60 * S;
    let line = "";
    let wi = 0;
    while (y < c.height - 40 * S) {
      const next = line ? line + " " + words[wi % words.length] : words[wi % words.length];
      wi++;
      if (ctx.measureText(next).width > (A4.w - 100) * S) {
        ctx.fillText(line, 50 * S, y);
        y += 22 * S;
        line = "";
      } else line = next;
    }
    if (kind === "scan") {
      // A scan is never clean white: add sensor noise + a slight skew shadow.
      const img = ctx.getImageData(0, 0, c.width, c.height);
      for (let i = 0; i < img.data.length; i += 4) {
        const n = (Math.random() * 26) | 0;
        img.data[i] = Math.min(255, img.data[i] - 12 + n);
        img.data[i + 1] = Math.min(255, img.data[i + 1] - 12 + n);
        img.data[i + 2] = Math.min(255, img.data[i + 2] - 12 + n);
      }
      ctx.putImageData(img, 0, 0);
    }
    return c;
  };

  const binarise = (src) => {
    const c = document.createElement("canvas");
    c.width = src.width;
    c.height = src.height;
    const ctx = c.getContext("2d");
    ctx.drawImage(src, 0, 0);
    const img = ctx.getImageData(0, 0, c.width, c.height);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = img.data[i] * 0.299 + img.data[i + 1] * 0.587 + img.data[i + 2] * 0.114;
      const b = v < 160 ? 0 : 255;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = b;
    }
    ctx.putImageData(img, 0, 0);
    return c;
  };

  const bytes = (c, type, q) =>
    new Promise((res) => c.toBlob((b) => res(b.size), type, q));

  for (const kind of ["clean", "scan"]) {
    for (const S of [2, 3]) {
      const c = drawPage(S, kind);
      const bw = binarise(c);
      // 1-bit packed size — the raw bitmap a JBIG2/CCITT encoder compresses.
      const raw1bit = Math.ceil((c.width * c.height) / 8);
      out.push({
        kind,
        scale: S,
        mp: +((c.width * c.height) / 1e6).toFixed(1),
        png: await bytes(c, "image/png"),
        jpeg85: await bytes(c, "image/jpeg", 0.85),
        jpeg70: await bytes(c, "image/jpeg", 0.7),
        bwPng: await bytes(bw, "image/png"),
        raw1bit,
      });
    }
  }
  return out;
});

const kb = (n) => (n / 1024).toFixed(0) + " KB";
console.log("kind   scale   MP    PNG(now)   JPEG q85   JPEG q70   1-bit PNG   raw 1-bit");
for (const r of rows) {
  console.log(
    `${r.kind.padEnd(6)} ${String(r.scale).padEnd(6)} ${String(r.mp).padEnd(5)} ${kb(r.png).padStart(9)} ${kb(r.jpeg85).padStart(10)} ${kb(r.jpeg70).padStart(10)} ${kb(r.bwPng).padStart(11)} ${kb(r.raw1bit).padStart(11)}`,
  );
}
await browser.close();
