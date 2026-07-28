/**
 * Behavioural checks for the invariants this app's value rests on.
 *
 * The repo has no unit-test runner, and the properties that matter most here
 * aren't unit-testable anyway — "the document never leaves the device", "a
 * redaction actually removes the text", "opening a 150-page file doesn't
 * allocate a gigabyte of canvas" are all statements about a real browser running
 * the built bundle. So they're asserted end-to-end, against `dist/`.
 *
 * Usage:
 *   npm run build
 *   npm run check          # starts its own preview server
 *   npm run check -- --keep-open
 */
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { chromium } from "playwright";

const PORT = 4173;
const BASE = `http://localhost:${PORT}/`;
const FIXTURES = new URL("../.fixtures/", import.meta.url);
const SAMPLE = new URL("sample.pdf", FIXTURES).pathname;
const LONG = new URL("long.pdf", FIXTURES).pathname;
const SCANNED = new URL("scanned.pdf", FIXTURES).pathname;
// The sandbox has Chromium pre-installed; fall back to Playwright's own lookup.
const EXEC = [
  "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  "/opt/pw-browsers/chromium/chrome-linux/chrome",
].find(existsSync);

if (!existsSync(SAMPLE) || !existsSync(LONG) || !existsSync(SCANNED)) {
  console.error("Missing fixtures — run `npm run fixtures` first.");
  process.exit(2);
}

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? `  (${detail})` : ""}`);
}

/** Start `vite preview` and resolve once it answers. */
async function startPreview() {
  const proc = spawn("npx", ["vite", "preview", "--port", String(PORT)], {
    stdio: "ignore",
    detached: false,
  });
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(BASE);
      if (res.ok) return proc;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  proc.kill();
  throw new Error("preview server did not start");
}

/** A page instrumented to record console errors and off-origin requests. */
async function instrument(ctx) {
  const page = await ctx.newPage();
  const errors = [];
  const external = [];
  page.on("console", (m) => {
    if (m.type() === "error" || /Content Security Policy|Refused to/i.test(m.text())) {
      errors.push(m.text());
    }
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("response", (r) => {
    if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url()}`);
  });
  page.on("request", (r) => {
    const u = r.url();
    if (!u.startsWith(BASE) && !u.startsWith("data:") && !u.startsWith("blob:")) {
      external.push(u);
    }
  });
  return { page, errors, external };
}

async function openDoc(page, file) {
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.setInputFiles("input[type=file]", file);
  await page.waitForSelector(".page canvas");
  await page.waitForFunction(
    () => [...document.querySelectorAll(".page canvas")].some((c) => c.width > 1),
    null,
    { timeout: 30_000 },
  );
  await page.waitForTimeout(1200);
}

const preview = await startPreview();
const browser = await chromium.launch(EXEC ? { executablePath: EXEC } : {});

try {
  // ---------------------------------------------------------------- privacy
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const { page, errors, external } = await instrument(ctx);
    await openDoc(page, SAMPLE);

    check("no off-origin network requests", external.length === 0, external.join(", "));
    check("no console errors or CSP violations", errors.length === 0, errors.slice(0, 2).join(" | "));

    const csp = await page.evaluate(
      () => document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content ?? "",
    );
    check("CSP restricts default-src to self", /default-src 'self'/.test(csp));
    check("CSP restricts connect-src to self", /connect-src 'self'/.test(csp));
    check("CSP forbids plugins and base-uri hijacking", /object-src 'none'/.test(csp) && /base-uri 'none'/.test(csp));
    // `link.href` is always absolute, so compare origins rather than pattern-
    // matching the scheme — a same-origin bundled stylesheet is expected.
    check(
      "no off-origin stylesheet or preconnect",
      await page.evaluate(() =>
        ![...document.querySelectorAll("link[href]")].some(
          (l) => new URL(l.href, location.href).origin !== location.origin,
        ),
      ),
    );

    await ctx.close();
  }

  // ------------------------------------------------------------- rendering
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const { page } = await instrument(ctx);
    await openDoc(page, LONG);

    const snapshot = () =>
      page.evaluate(() => {
        const canvases = [...document.querySelectorAll(".page canvas")];
        return {
          pages: document.querySelectorAll(".page").length,
          live: canvases.filter((c) => c.width > 1).length,
          megapixels: canvases.reduce((n, c) => n + c.width * c.height, 0) / 1e6,
        };
      });

    const top = await snapshot();
    check(
      "long document lays out every page",
      top.pages === 150,
      `${top.pages} page frames`,
    );
    check(
      "render window is bounded, not the whole document",
      top.live > 0 && top.live <= 8,
      `${top.live} of ${top.pages} rasterised, ${top.megapixels.toFixed(1)} MP`,
    );

    // Scrolling should slide the window, not accumulate canvases.
    await page.evaluate(() => {
      const s = document.querySelector(".viewer__scroll");
      s.scrollTop = s.scrollHeight;
    });
    await page.waitForTimeout(2000);
    const bottom = await snapshot();
    check(
      "canvas memory does not grow while scrolling",
      bottom.megapixels <= top.megapixels * 2.5,
      `${top.megapixels.toFixed(1)} MP → ${bottom.megapixels.toFixed(1)} MP`,
    );
    const lastPainted = await page.evaluate(() => {
      const pages = [...document.querySelectorAll(".page")];
      return pages[pages.length - 1].querySelector("canvas").width > 1;
    });
    check("the page scrolled to is actually painted", lastPainted);

    await ctx.close();
  }

  // ------------------------------------------------------- export integrity
  {
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      acceptDownloads: true,
    });
    const { page, errors } = await instrument(ctx);
    await openDoc(page, SAMPLE);

    // A link whose URL must never reach the file.
    await page.locator('.tooldock__btn[aria-label="Link"]').click();
    const frame = await page.locator(".page").first().boundingBox();
    await page.mouse.move(frame.x + 80, frame.y + 120);
    await page.mouse.down();
    await page.mouse.move(frame.x + 280, frame.y + 165, { steps: 8 });
    await page.mouse.up();
    await page.waitForSelector("#link-url");

    await page.fill("#link-url", "javascript:alert(1)");
    await page.waitForTimeout(200);
    check(
      "an unsafe URL scheme is flagged in the UI",
      (await page.getAttribute("#link-url", "aria-invalid")) === "true",
    );
    await page.fill("#link-url", "example.com/report");
    await page.waitForTimeout(200);
    check(
      "a bare hostname is accepted",
      (await page.getAttribute("#link-url", "aria-invalid")) !== "true",
    );
    // Leave an unsafe value in place — export must drop it.
    await page.fill("#link-url", "javascript:alert('pwned')");
    await page.waitForTimeout(200);

    // Redact a band on page 1, so page 1 takes the destructive raster path.
    await page.locator(".appbar__logo").click();
    await page.locator('.tooldock__btn[aria-label="Redact"]').click();
    await page.mouse.move(frame.x + 60, frame.y + 400);
    await page.mouse.down();
    await page.mouse.move(frame.x + 420, frame.y + 445, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    check("redaction is created on the page", (await page.locator(".redaction").count()) >= 1);

    const pending = page.waitForEvent("download", { timeout: 120_000 });
    await page.click(".appbar__download");
    const out = new URL("exported.pdf", FIXTURES).pathname;
    await (await pending).saveAs(out);
    const raw = readFileSync(out, "latin1");

    check("export produces a PDF", raw.startsWith("%PDF-"), raw.slice(0, 8));
    check("no javascript: URI reaches the exported file", !/javascript\s*:/i.test(raw));
    check(
      "no authoring metadata is written",
      !/\/Producer|\/Creator|\/ModDate|\/CreationDate/.test(raw),
    );
    check("export raised no console errors", errors.length === 0, errors.slice(0, 2).join(" | "));

    // The redacted page must have no recoverable text layer; its neighbours must
    // keep theirs (only redacted pages are rasterised).
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const doc = await pdfjs.getDocument({
      data: new Uint8Array(readFileSync(out)),
      useWorkerFetch: false,
      isEvalSupported: false,
    }).promise;
    const textOf = async (n) =>
      (await (await doc.getPage(n)).getTextContent()).items.map((i) => i.str).join(" ");
    check("redacted page has no extractable text", (await textOf(1)).trim() === "");
    check("unredacted pages keep selectable text", /quick brown fox/.test(await textOf(2)));

    await ctx.close();
  }

  // ------------------------------------------------------- on-device storage
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const { page } = await instrument(ctx);
    await openDoc(page, SAMPLE);
    // Make a change so autosave has something to store.
    await page.locator('.tooldock__btn[aria-label="Redact"]').click();
    const frame = await page.locator(".page").first().boundingBox();
    await page.mouse.move(frame.x + 60, frame.y + 300);
    await page.mouse.down();
    await page.mouse.move(frame.x + 300, frame.y + 340, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(2200);

    const keys = () =>
      page.evaluate(
        () =>
          new Promise((resolve) => {
            const req = indexedDB.open("pdf-editor", 1);
            req.onsuccess = () => {
              const tx = req.result.transaction("session", "readonly");
              const all = tx.objectStore("session").getAllKeys();
              all.onsuccess = () => resolve(all.result);
              tx.onerror = () => resolve(["<error>"]);
            };
            req.onerror = () => resolve(["<no db>"]);
          }),
      );
    check("a session is autosaved locally", (await keys()).length === 2, JSON.stringify(await keys()));

    await page.click('[aria-label="More actions"]');
    await page.locator('[role="menuitemcheckbox"]', { hasText: "Save session" }).click();
    await page.waitForTimeout(1600);
    check(
      "turning autosave off erases the stored copy",
      (await keys()).length === 0,
      JSON.stringify(await keys()),
    );

    await ctx.close();
  }

  // ------------------------------------------------------------------ OCR
  // Skipped rather than failed when the assets aren't installed, so the suite
  // still runs on a checkout that hasn't done `npm run setup-ocr`.
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const { page, errors, external } = await instrument(ctx);
    await page.goto(BASE, { waitUntil: "networkidle" });
    const assetsReady = await page.evaluate(async () => {
      try {
        const res = await fetch("./tessdata/eng.traineddata.gz", { method: "HEAD" });
        return res.ok && !(res.headers.get("content-type") ?? "").includes("text/html");
      } catch {
        return false;
      }
    });

    if (!assetsReady) {
      console.log("  skip  OCR checks (run `npm run setup-ocr` to include them)");
    } else {
      await openDoc(page, SCANNED);
      check(
        "a scanned page starts with no text layer",
        (await page.locator('.page [role="textbox"]').count()) === 0,
      );

      await page.click('[aria-label="More actions"]');
      await page.locator('[role="menuitem"]', { hasText: "OCR" }).click();
      // Wait for a terminal status rather than a fixed delay — engine start-up
      // dominates and varies.
      await page
        .locator(".snackbar__msg", { hasText: /OCR added|No recognisable|couldn't|isn't available|timed out/ })
        .waitFor({ timeout: 180_000 });
      const status = await page.locator(".snackbar__msg").innerText();

      const words = await page.evaluate(() =>
        [...document.querySelectorAll('.page [role="textbox"]')]
          .map((e) => e.textContent.trim())
          .filter(Boolean),
      );
      check("OCR recovers the words on a scan", words.includes("INVOICE"), `${status} → ${JSON.stringify(words)}`);
      check(
        "OCR assets load from our own origin only",
        external.length === 0,
        external.join(", "),
      );
      check("OCR raised no console errors or CSP violations", errors.length === 0, errors.slice(0, 2).join(" | "));

      // The whole point of the OCR layer: the scan becomes findable.
      await page.keyboard.press("Control+f");
      await page.locator(".findbar input").fill("INVOICE");
      await page.waitForTimeout(900);
      check(
        "the OCR'd text is findable",
        /\b1\/1\b/.test(await page.locator(".findbar").innerText()),
        (await page.locator(".findbar").innerText()).replace(/\s+/g, " "),
      );
    }
    await ctx.close();
  }

  // ------------------------------------------------------- find positioning
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const { page } = await instrument(ctx);
    await openDoc(page, SAMPLE);
    await page.keyboard.press("Control+f");
    // A phrase near the bottom of page 1 — centring the *page* would leave it
    // off screen, which is the regression this guards.
    await page.locator(".findbar input").fill("Line 24");
    await page.waitForTimeout(1500);
    const visible = await page.evaluate(() => {
      const hit = document.querySelector(".findhit--active");
      const scroller = document.querySelector(".viewer__scroll");
      if (!hit || !scroller) return null;
      const h = hit.getBoundingClientRect();
      const s = scroller.getBoundingClientRect();
      return { inside: h.top >= s.top && h.bottom <= s.bottom, clearOfFindBar: h.top > s.top + 60 };
    });
    check("the active find match is scrolled on screen", !!visible?.inside, JSON.stringify(visible));
    check("the active find match clears the find bar", !!visible?.clearOfFindBar);
    await ctx.close();
  }

  // --------------------------------------------- mobile layout collisions
  {
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 3,
      colorScheme: "dark",
    });
    const { page, errors } = await instrument(ctx);
    await openDoc(page, SAMPLE);
    const overlap = await page.evaluate(() => {
      const box = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      };
      const hits = (a, b) =>
        !!a && !!b && !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);
      const snack = box(".snackbar");
      return {
        zoom: hits(snack, box(".zoombar")),
        dock: hits(snack, box(".tooldock")),
      };
    });
    check("phone: status message clears the zoom control", !overlap.zoom);
    check("phone: status message clears the tool dock", !overlap.dock);
    check("phone: no console errors", errors.length === 0, errors.slice(0, 2).join(" | "));
    await ctx.close();
  }
} finally {
  await browser.close();
  if (!process.argv.includes("--keep-open")) preview.kill();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
