import { expect, type Page } from "@playwright/test";

/** Requests and errors recorded for a page, so a spec can assert on them. */
export interface Watcher {
  /** Requests to anything other than our own origin (or data:/blob:). */
  external: string[];
  /** Console errors, page errors, CSP violations, and 4xx/5xx responses. */
  errors: string[];
  /** Every request URL, for asserting *where* assets came from. */
  requests: string[];
}

/**
 * Attach listeners that make the privacy and CSP invariants observable.
 *
 * Every spec that opens a document should watch: the failures this project has
 * actually shipped (a CDN font, a broken CSP relaxation, a 404 on a wasm variant)
 * were all invisible in the code and obvious in the request log.
 */
export function watch(page: Page, baseUrl = "http://localhost:4173/"): Watcher {
  const w: Watcher = { external: [], errors: [], requests: [] };
  page.on("console", (m) => {
    if (m.type() === "error" || /Content Security Policy|Refused to/i.test(m.text())) {
      w.errors.push(m.text());
    }
  });
  page.on("pageerror", (e) => w.errors.push(`pageerror: ${e.message}`));
  page.on("response", (r) => {
    if (r.status() >= 400) w.errors.push(`HTTP ${r.status()} ${r.url()}`);
  });
  page.on("request", (r) => {
    const u = r.url();
    w.requests.push(u);
    if (!u.startsWith(baseUrl) && !u.startsWith("data:") && !u.startsWith("blob:")) {
      w.external.push(u);
    }
  });
  return w;
}

/** Open a document and wait until at least one page has actually rasterised. */
export async function open(page: Page, file: string): Promise<void> {
  await page.goto("/");
  await page.setInputFiles("input[type=file]", file);
  await page.waitForSelector(".page canvas", { timeout: 30_000 });
  await page.waitForFunction(
    () => [...document.querySelectorAll("canvas")].some((c) => c.width > 1),
    null,
    { timeout: 30_000 },
  );
  await page.waitForTimeout(600);
}

/** Live canvas count and total backing-store size, for the render-window specs. */
export function canvasStats(page: Page) {
  return page.evaluate(() => {
    const canvases = [...document.querySelectorAll<HTMLCanvasElement>(".page canvas")];
    return {
      pages: document.querySelectorAll(".page").length,
      live: canvases.filter((c) => c.width > 1).length,
      megapixels: canvases.reduce((n, c) => n + c.width * c.height, 0) / 1e6,
    };
  });
}

/** Select a tool from the dock. Preferred over the single-key shortcut, which is
 * (correctly) ignored while a contentEditable overlay has focus. */
export async function pickTool(page: Page, label: string): Promise<void> {
  await page.locator(`.tooldock__btn[aria-label="${label}"]`).click();
}

/** Drag a rectangle on the first page's overlay, in overlay-relative pixels. */
export async function dragOnPage(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
): Promise<void> {
  const box = (await page.locator(".page").first().boundingBox())!;
  await page.mouse.move(box.x + from.x, box.y + from.y);
  await page.mouse.down();
  await page.mouse.move(box.x + to.x, box.y + to.y, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(250);
}

/** Assert nothing left the origin and nothing errored. */
export function expectClean(w: Watcher): void {
  expect(w.external, `off-origin requests: ${w.external.join(", ")}`).toEqual([]);
  expect(w.errors, `errors: ${w.errors.slice(0, 3).join(" | ")}`).toEqual([]);
}

/** Extract text per page from exported PDF bytes, using pdf.js in Node. */
export async function pageTexts(bytes: Buffer, pages: number[]): Promise<string[]> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(bytes),
    useWorkerFetch: false,
    isEvalSupported: false,
    // Standard-font data isn't needed to read the text layer, and pointing at it
    // would drag a network fetch into the assertion.
    stopAtErrors: false,
  }).promise;
  const out: string[] = [];
  for (const n of pages) {
    const content = await (await doc.getPage(n)).getTextContent();
    out.push(content.items.map((i) => ("str" in i ? i.str : "")).join(" "));
  }
  return out;
}
