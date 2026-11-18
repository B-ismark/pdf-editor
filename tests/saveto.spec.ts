import { test, expect, type Page } from "@playwright/test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { PDFDocument } from "pdf-lib";
import { fixtures, LOCKED_PASSWORD } from "./fixtures";
import { dragOnPage, expectClean, open, pageTexts, pickTool, watch } from "./helpers";

/**
 * Save in place, Save as, Share and Print: the browser's own file features.
 *
 * Playwright can't drive the system file pickers or share sheet (it gets no
 * `filechooser` for `showOpenFilePicker`), so each is stood in for by a stub
 * shaped like the real API, installed before the page loads. What a stub
 * records is what the app *gave* the browser: the bytes written to a file
 * handle, the File handed to the share sheet, the pages laid out for print.
 * Those bytes are then read by pdf.js in Node, independently of the app.
 */

interface StubFile {
  name: string;
  b64: string;
}
interface StubOpts {
  /** What `showOpenFilePicker` returns. */
  open?: StubFile[];
  /** The name `showSaveFilePicker` returns a handle for; omit to cancel it. */
  saveAs?: string;
  /** What `queryPermission` / `requestPermission` answer. */
  permission?: "granted" | "denied";
  /** Install a share sheet; "tap" refuses the first call as a browser does
   * once the click that asked for it has expired. */
  share?: "ok" | "tap";
  /** Make every write fail, as a full disk or a file locked elsewhere does. */
  failWrite?: boolean;
  /** A picked file that can't then be read (moved, deleted). */
  unreadable?: string;
}

const asStub = (path: string): StubFile => ({ name: basename(path), b64: readFileSync(path).toString("base64") });

async function installStubs(page: Page, opts: StubOpts): Promise<void> {
  await page.addInitScript((o: StubOpts) => {
    const w = window as unknown as Record<string, unknown>;
    const writes: { name: string; b64: string }[] = [];
    const calls = { open: 0, save: 0, share: 0, request: 0 };
    const shared: { name: string; type: string; b64: string }[] = [];
    w.__writes = writes;
    w.__calls = calls;
    w.__shared = shared;
    const toB64 = async (b: Blob) => {
      const u8 = new Uint8Array(await b.arrayBuffer());
      let s = "";
      for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
      return btoa(s);
    };
    const fromB64 = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const handle = (name: string, b64?: string) => ({
      kind: "file",
      name,
      getFile: async () => {
        if (o.unreadable === name) throw new DOMException("Gone", "NotFoundError");
        return new File([fromB64(b64 ?? "")], name, { type: "application/pdf" });
      },
      createWritable: async () => {
        const parts: BlobPart[] = [];
        return {
          write: async (d: BlobPart) => {
            if (o.failWrite) throw new DOMException("No space", "QuotaExceededError");
            parts.push(d);
          },
          close: async () => void writes.push({ name, b64: await toB64(new Blob(parts)) }),
          abort: async () => {},
        };
      },
      isSameEntry: async (other: { name: string }) => other.name === name,
      queryPermission: async () => o.permission ?? "granted",
      requestPermission: async () => {
        calls.request++;
        return o.permission ?? "granted";
      },
    });
    const abort = () => new DOMException("The user aborted a request.", "AbortError");
    if (o.open) {
      const files = o.open;
      w.showOpenFilePicker = async () => {
        calls.open++;
        return files.map((f) => handle(f.name, f.b64));
      };
    }
    const suggested: string[] = [];
    w.__suggested = suggested;
    w.showSaveFilePicker = async (opts?: { suggestedName?: string }) => {
      calls.save++;
      suggested.push(opts?.suggestedName ?? "");
      if (!o.saveAs) throw abort();
      return handle(o.saveAs);
    };
    if (o.share) {
      const nav = navigator as unknown as Record<string, unknown>;
      let refused = false;
      nav.canShare = (d: { files?: File[] }) => !!d.files?.length;
      nav.share = async (d: { files: File[] }) => {
        calls.share++;
        if (o.share === "tap" && !refused) {
          refused = true;
          throw new DOMException("Must be handling a user gesture", "NotAllowedError");
        }
        for (const f of d.files) shared.push({ name: f.name, type: f.type, b64: await toB64(f) });
      };
    }
  }, opts);
}

const writes = (page: Page) => page.evaluate(() => (window as unknown as { __writes: StubFile[] }).__writes);
const calls = (page: Page) =>
  page.evaluate(() => ({ ...(window as unknown as { __calls: Record<string, number> }).__calls }));
const counter = (page: Page) => page.locator(".appbar__changes");
const activeTab = (page: Page) => page.locator(".doctab--active");
const exportMenu = (page: Page) => page.getByRole("menu", { name: "Export" });

/** Open through the picker, as the landing page's button does on Chromium. */
async function openPicked(page: Page, wait = true): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: "Choose PDF" }).click();
  if (!wait) return;
  await page.waitForSelector(".page canvas", { timeout: 30_000 });
  await page.waitForFunction(() => [...document.querySelectorAll("canvas")].some((c) => c.width > 1), null, {
    timeout: 30_000,
  });
}

async function addText(page: Page, text: string) {
  const ov = (await page.locator(".page__overlay").first().boundingBox())!;
  await pickTool(page, "Add text");
  await page.mouse.click(ov.x + 150, ov.y + 150);
  await page.keyboard.type(text, { delay: 15 });
  await pickTool(page, "Select");
}

/** Fail the test if anything is downloaded: these saves never go to Downloads. */
function noDownloads(page: Page): string[] {
  const got: string[] = [];
  page.on("download", (d) => got.push(d.suggestedFilename()));
  return got;
}

test.describe("save in place", () => {
  test("a file opened from the picker saves back to itself with Ctrl+S", async ({ page }) => {
    const w = watch(page);
    const f = await fixtures();
    await installStubs(page, { open: [asStub(f.sample)] });
    const downloads = noDownloads(page);
    await openPicked(page);

    // The Export menu offers the file by name, with the shortcut.
    await page.getByRole("button", { name: "Export options" }).click();
    await expect(exportMenu(page).getByRole("menuitem", { name: /^Save to sample\.pdf/ })).toBeVisible();
    await page.keyboard.press("Escape");

    await addText(page, "Written back");
    await expect(activeTab(page).locator(".doctab__dirty")).toHaveCount(1);
    await page.keyboard.press("Control+s");
    await expect(counter(page)).toHaveText("Saved");
    await expect(activeTab(page).locator(".doctab__dirty")).toHaveCount(0);

    const out = await writes(page);
    expect(out.map((x) => x.name)).toEqual(["sample.pdf"]);
    const [text] = await pageTexts(Buffer.from(out[0].b64, "base64"), [1]);
    expect(text).toContain("Written back");
    expect(downloads).toEqual([]);

    // It's known to be on disk, so closing doesn't ask.
    await activeTab(page).locator(".doctab__close").click();
    await expect(page.locator('[aria-modal="true"]')).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Choose PDF" })).toBeVisible();
    expectClean(w);
  });

  test("when writing isn't allowed, nothing is written and it stays unsaved", async ({ page }) => {
    const f = await fixtures();
    await installStubs(page, { open: [asStub(f.sample)], permission: "denied" });
    await openPicked(page);
    await addText(page, "Not allowed");
    await page.keyboard.press("Control+s");
    await expect(page.getByRole("status").filter({ hasText: "wasn't allowed" }).first()).toBeVisible();
    expect(await writes(page)).toEqual([]);
    expect((await calls(page)).request).toBe(1);
    await expect(activeTab(page).locator(".doctab__dirty")).toHaveCount(1);
  });

  test("a file that opened with a password warns before it's saved over without one", async ({ page }) => {
    const f = await fixtures();
    await installStubs(page, { open: [asStub(f.locked)] });
    await openPicked(page, false);
    const pw = page.getByRole("dialog", { name: "This PDF is password-protected" });
    await pw.getByLabel("Password").fill(LOCKED_PASSWORD);
    await pw.getByLabel("Password").press("Enter");
    await page.waitForSelector(".page canvas", { timeout: 30_000 });
    await addText(page, "Unlocked");

    await page.keyboard.press("Control+s");
    const warn = page.getByRole("alertdialog", { name: "Save without its password?" });
    await expect(warn).toBeVisible();
    await warn.getByRole("button", { name: "Go back" }).click();
    expect(await writes(page)).toEqual([]);

    await page.keyboard.press("Control+s");
    await warn.getByRole("button", { name: "Save without password" }).click();
    await expect(counter(page)).toHaveText("Saved");
    expect((await writes(page)).map((x) => x.name)).toEqual(["locked.pdf"]);
  });
});

test.describe("save as", () => {
  test("without a file to go back to, Ctrl+S asks where — and then saves there", async ({ page }) => {
    const w = watch(page);
    const f = await fixtures();
    await installStubs(page, { saveAs: "report-final.pdf" });
    const downloads = noDownloads(page);
    await open(page, f.sample);
    await addText(page, "First save");
    await page.keyboard.press("Control+s");
    await expect(counter(page)).toHaveText("Saved");
    // The document is that file now: its tab says so, and Save goes there.
    await expect(activeTab(page)).toContainText("report-final.pdf");

    await addText(page, "Second save");
    await page.keyboard.press("Control+s");
    await expect(counter(page)).toHaveText("Saved");
    expect((await calls(page)).save, "the second Ctrl+S doesn't ask again").toBe(1);
    const out = await writes(page);
    expect(out.map((x) => x.name)).toEqual(["report-final.pdf", "report-final.pdf"]);
    const [text] = await pageTexts(Buffer.from(out[1].b64, "base64"), [1]);
    expect(text).toContain("First save");
    expect(text).toContain("Second save");
    expect(downloads).toEqual([]);
    expectClean(w);
  });

  test("closing the picker writes nothing and reports nothing", async ({ page }) => {
    const f = await fixtures();
    await installStubs(page, {});
    await open(page, f.sample);
    await addText(page, "Kept");
    // Every message shown from here on, as it's shown.
    await page.evaluate(() => {
      const seen: string[] = ((window as unknown as { __said: string[] }).__said = []);
      // What's already up (the load's "12 pages · …") isn't something Save said.
      const before = new Set([...document.querySelectorAll(".snackbar__msg")].map((m) => m.textContent));
      new MutationObserver(() => {
        for (const m of document.querySelectorAll(".snackbar__msg")) {
          if (!before.has(m.textContent)) seen.push(m.textContent ?? "");
        }
      }).observe(document.body, { subtree: true, childList: true, characterData: true });
    });
    await page.keyboard.press("Control+s");
    await expect.poll(async () => (await calls(page)).save).toBe(1);
    await page.waitForTimeout(800);
    expect(await writes(page)).toEqual([]);
    await expect(counter(page)).toHaveText("1 change");
    expect(await page.evaluate(() => (window as unknown as { __said: string[] }).__said)).toEqual([]);
  });

  test("where the browser can't pick a place, Ctrl+S downloads", async ({ page }) => {
    const f = await fixtures();
    await page.addInitScript(() => {
      delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
      delete (window as { showOpenFilePicker?: unknown }).showOpenFilePicker;
    });
    await open(page, f.sample);
    await addText(page, "Downloaded");
    const [d] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("Control+s")]);
    expect(d.suggestedFilename()).toMatch(/\.pdf$/);
    await expect(counter(page)).toHaveText("Downloaded");
    // And no "Save as…" row to promise what it can't do.
    await page.getByRole("button", { name: "Export options" }).click();
    await expect(exportMenu(page).getByRole("menuitem", { name: /Save/ })).toHaveCount(0);
  });
});

test.describe("share", () => {
  test("Share hands the finished PDF to the share sheet", async ({ page }) => {
    const f = await fixtures();
    await installStubs(page, { share: "ok" });
    await open(page, f.sample);
    await addText(page, "Shared text");
    await page.getByRole("button", { name: "Export options" }).click();
    await exportMenu(page).getByRole("menuitem", { name: "Share" }).click();
    await expect.poll(async () => (await calls(page)).share).toBe(1);
    // The stub reads the file after counting the call.
    await expect.poll(() => page.evaluate(() => (window as unknown as { __shared: unknown[] }).__shared.length)).toBe(1);
    const shared = await page.evaluate(() => (window as unknown as { __shared: { name: string; type: string; b64: string }[] }).__shared);
    // Named as a download is, so it isn't mistaken for the original.
    expect(shared.map((s) => [s.name, s.type])).toEqual([["sample-edited.pdf", "application/pdf"]]);
    const [text] = await pageTexts(Buffer.from(shared[0].b64, "base64"), [1]);
    expect(text).toContain("Shared text");
    // A share target may keep nothing ("Copy", a draft): it isn't a save.
    await expect(counter(page)).toHaveText("1 change");
  });

  test("when the browser wants a fresh tap, the file is ready behind one", async ({ page }) => {
    const f = await fixtures();
    await installStubs(page, { share: "tap" });
    await open(page, f.sample);
    await addText(page, "Shared later");
    await page.getByRole("button", { name: "Export options" }).click();
    await exportMenu(page).getByRole("menuitem", { name: "Share" }).click();
    const ready = page.getByRole("alertdialog", { name: "Ready to share" });
    await expect(ready).toBeVisible();
    await ready.getByRole("button", { name: "Share" }).click();
    await expect(ready).toHaveCount(0);
    expect((await calls(page)).share).toBe(2);
    const shared = await page.evaluate(() => (window as unknown as { __shared: { b64: string }[] }).__shared);
    expect(shared).toHaveLength(1);
    expect(Buffer.from(shared[0].b64, "base64").subarray(0, 5).toString()).toBe("%PDF-");
    // Shared through the second tap is no more a save than through the first.
    await expect(counter(page)).toHaveText("1 change");
  });

  test("without a share sheet that takes files, there's no Share", async ({ page }) => {
    const f = await fixtures();
    await open(page, f.sample);
    await page.getByRole("button", { name: "Export options" }).click();
    await expect(exportMenu(page).getByRole("menuitem", { name: "Share" })).toHaveCount(0);
  });
});

test.describe("print", () => {
  test("Ctrl+P prints the edited file, a sheet per page, and nothing of the app", async ({ page }) => {
    const w = watch(page);
    const f = await fixtures();
    // Record what's laid out when the dialog would open, instead of opening it.
    await page.addInitScript(() => {
      const w = window as unknown as Record<string, unknown>;
      w.print = () => {
        const imgs = [...document.querySelectorAll<HTMLImageElement>("#print-root img.print-page")];
        const first = imgs[0];
        w.__printed = {
          pages: imgs.length,
          sizes: [...new Set(imgs.map((i) => `${i.style.width} ${i.style.height}`))],
          px: first.naturalWidth,
          sheet: [...document.adoptedStyleSheets].map((s) => [...s.cssRules].map((r) => r.cssText).join(" ")).join(" "),
        };
      };
    });
    await open(page, f.sample);
    await pickTool(page, "Redact");
    await dragOnPage(page, { x: 40, y: 40 }, { x: 300, y: 200 });
    await expect(page.locator(".redaction")).toHaveCount(1);
    await pickTool(page, "Select");

    await page.keyboard.press("Control+p");
    await expect.poll(() => page.evaluate(() => !!(window as unknown as { __printed?: unknown }).__printed), { timeout: 60_000 }).toBe(true);
    const printed = await page.evaluate(() => (window as unknown as { __printed: Record<string, unknown> }).__printed);
    expect(printed.pages).toBe(12);
    expect(printed.sizes).toEqual(["595pt 842pt"]);
    // 150 dpi: an A4 page is 1240 pixels across.
    expect(printed.px).toBe(Math.round((595 * 150) / 72));
    // Sampled where the redaction was drawn, as a fraction of the page.
    const ov = (await page.locator(".page__overlay").first().boundingBox())!;
    const sample = (fx: number, fy: number) =>
      page.evaluate(([fx, fy]) => {
        const img = document.querySelector<HTMLImageElement>("#print-root img.print-page")!;
        const c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        const g = c.getContext("2d")!;
        g.drawImage(img, 0, 0);
        return [...g.getImageData(Math.round(fx * c.width), Math.round(fy * c.height), 1, 1).data].slice(0, 3);
      }, [fx, fy]);
    const [r, g, b] = await sample(170 / ov.width, 120 / ov.height);
    expect(r + g + b, "the redaction is in what's printed").toBeLessThan(60);
    expect(await sample(0.97, 0.98), "and the paper around it is paper").toEqual([255, 255, 255]);
    expect(printed.sheet).toContain("595pt 842pt");
    // And the app didn't leave a spinner behind.
    await expect(page.getByRole("status").filter({ hasText: "Preparing to print" })).toHaveCount(0);
    expectClean(w);
  });

  test("under print media the app hides and only the pages show", async ({ page }) => {
    const f = await fixtures();
    await page.addInitScript(() => {
      (window as unknown as Record<string, unknown>).print = () => {
        (window as unknown as Record<string, unknown>).__held = true;
      };
    });
    await open(page, f.sample);
    await page.keyboard.press("Control+p");
    await expect.poll(() => page.evaluate(() => !!(window as unknown as { __held?: boolean }).__held), { timeout: 60_000 }).toBe(true);
    await page.emulateMedia({ media: "print" });
    await expect(page.locator("#print-root")).toBeVisible();
    await expect(page.locator(".appbar")).toBeHidden();
    await expect(page.locator(".page canvas").first()).toBeHidden();
    // The pages go once printing is over.
    await page.evaluate(() => window.dispatchEvent(new Event("afterprint")));
    await expect(page.locator("#print-root")).toHaveCount(0);
  });
});

/** Found by review, each shown failing before its fix. */
test.describe("review fixes", () => {
  test("the same file picked again goes to its tab, not a second one that would save over it", async ({ page }) => {
    const f = await fixtures();
    await installStubs(page, { open: [asStub(f.sample)] });
    await openPicked(page);
    await page.keyboard.press("Control+o");
    await expect(page.getByRole("status").filter({ hasText: "sample.pdf is already open" }).first()).toBeVisible();
    await expect(page.locator(".doctab")).toHaveCount(1);
  });

  test("two Ctrl+S at once write the file once", async ({ page }) => {
    const f = await fixtures();
    await installStubs(page, { open: [asStub(f.sample)] });
    await openPicked(page);
    await addText(page, "Once");
    await page.evaluate(() => {
      for (let i = 0; i < 2; i++) window.dispatchEvent(new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true, cancelable: true }));
    });
    await expect(counter(page)).toHaveText("Saved");
    await page.waitForTimeout(1500);
    expect((await writes(page)).length).toBe(1);
  });

  test("once saved without its password, the file isn't warned about again", async ({ page }) => {
    const f = await fixtures();
    await installStubs(page, { open: [asStub(f.locked)] });
    await openPicked(page, false);
    const pw = page.getByRole("dialog", { name: "This PDF is password-protected" });
    await pw.getByLabel("Password").fill(LOCKED_PASSWORD);
    await pw.getByLabel("Password").press("Enter");
    await page.waitForSelector(".page canvas", { timeout: 30_000 });
    await addText(page, "One");
    await page.keyboard.press("Control+s");
    await page.getByRole("alertdialog", { name: "Save without its password?" }).getByRole("button", { name: "Save without password" }).click();
    await expect(counter(page)).toHaveText("Saved");
    await addText(page, "Two");
    await page.keyboard.press("Control+s");
    await expect(counter(page)).toHaveText("Saved");
    await expect(page.getByRole("alertdialog", { name: "Save without its password?" })).toHaveCount(0);
    expect((await writes(page)).length).toBe(2);
  });

  test("a print the browser starts itself prints the screen, not blank paper", async ({ page }) => {
    const f = await fixtures();
    await open(page, f.sample);
    await page.emulateMedia({ media: "print" });
    await expect(page.locator(".appbar")).toBeVisible();
  });

  test("a landscape page prints on a landscape sheet", async ({ page }) => {
    const d = await PDFDocument.create();
    d.addPage([595, 842]);
    d.addPage([842, 595]);
    const file = join(mkdtempSync(join(tmpdir(), "print-")), "mixed.pdf");
    writeFileSync(file, await d.save());
    await page.addInitScript(() => {
      const w = window as unknown as Record<string, unknown>;
      w.print = () => {
        const imgs = [...document.querySelectorAll<HTMLImageElement>("#print-root img.print-page")];
        const rules = [...document.adoptedStyleSheets].flatMap((s) => [...s.cssRules].map((r) => r.cssText));
        w.__printed = imgs.map((i) => {
          const name = i.style.getPropertyValue("page");
          return rules.find((r) => name && r.startsWith(`@page ${name} `)) ?? "";
        });
      };
    });
    await open(page, file);
    await page.keyboard.press("Control+p");
    await expect.poll(() => page.evaluate(() => (window as unknown as { __printed?: string[] }).__printed), { timeout: 60_000 }).toBeTruthy();
    const sheets = await page.evaluate(() => (window as unknown as { __printed: string[] }).__printed);
    expect(sheets[0]).toContain("595pt 842pt");
    expect(sheets[1]).toContain("842pt 595pt");
  });

  test("on a Mac, Ctrl+S is left to the text; ⌘S saves", async ({ page }) => {
    const f = await fixtures();
    await page.addInitScript(() => Object.defineProperty(navigator, "platform", { get: () => "MacIntel" }));
    await installStubs(page, { open: [asStub(f.sample)] });
    await openPicked(page);
    await addText(page, "Mac");
    await page.keyboard.press("Control+s");
    await page.waitForTimeout(800);
    expect(await writes(page)).toEqual([]);
    await page.keyboard.press("Meta+s");
    await expect(counter(page)).toHaveText("Saved");
  });
});

test.describe("save in place, with more open", () => {
  test("each tab saves to its own file", async ({ page }) => {
    const f = await fixtures();
    await installStubs(page, { open: [asStub(f.sample), asStub(f.typeset)] });
    await openPicked(page);
    await expect(page.locator(".doctab")).toHaveCount(2, { timeout: 30_000 });
    await page.locator(".doctab", { hasText: "sample.pdf" }).click();
    await page.waitForSelector(".page canvas");
    await addText(page, "Into sample");
    await page.keyboard.press("Control+s");
    await expect(counter(page)).toHaveText("Saved");
    const out = await writes(page);
    expect(out.map((x) => x.name)).toEqual(["sample.pdf"]);
    const [text] = await pageTexts(Buffer.from(out[0].b64, "base64"), [1]);
    expect(text).toContain("Into sample");
    expect(text).toContain("Confidential Report");
  });

  test("a write that fails leaves the work unsaved, and says the file is unchanged", async ({ page }) => {
    const f = await fixtures();
    await installStubs(page, { open: [asStub(f.sample)], failWrite: true });
    await openPicked(page);
    await addText(page, "Not written");
    await page.keyboard.press("Control+s");
    // An error, so announced as an alert rather than a status.
    await expect(page.locator(".snackbar__msg").filter({ hasText: "it's unchanged" }).first()).toBeVisible();
    await expect(counter(page)).toHaveText("1 change");
    await expect(activeTab(page).locator(".doctab__dirty")).toHaveCount(1);
  });

  test("after Save as on a password-opened file, Ctrl+S doesn't claim the new file has a password", async ({ page }) => {
    const f = await fixtures();
    await installStubs(page, { saveAs: "copy.pdf" });
    await page.addInitScript(() => delete (window as { showOpenFilePicker?: unknown }).showOpenFilePicker);
    await page.goto("/");
    await page.setInputFiles("input[data-open-input]", f.locked);
    const pw = page.getByRole("dialog", { name: "This PDF is password-protected" });
    await pw.getByLabel("Password").fill(LOCKED_PASSWORD);
    await pw.getByLabel("Password").press("Enter");
    await page.waitForSelector(".page canvas", { timeout: 30_000 });
    await addText(page, "One");
    await page.keyboard.press("Control+s");
    await expect(counter(page)).toHaveText("Saved");
    await addText(page, "Two");
    await page.keyboard.press("Control+s");
    await expect(counter(page)).toHaveText("Saved");
    await expect(page.getByRole("alertdialog", { name: "Save without its password?" })).toHaveCount(0);
    expect((await writes(page)).map((x) => x.name)).toEqual(["copy.pdf", "copy.pdf"]);
  });
});

test.describe("second review fixes", () => {
  test("Save as onto a file another tab has open is refused", async ({ page }) => {
    const f = await fixtures();
    await installStubs(page, { open: [asStub(f.sample), asStub(f.typeset)], saveAs: "sample.pdf" });
    await openPicked(page);
    await expect(page.locator(".doctab")).toHaveCount(2, { timeout: 30_000 });
    await page.locator(".doctab", { hasText: "typeset.pdf" }).click();
    await page.waitForSelector(".page canvas");
    await page.getByRole("button", { name: "Export options" }).click();
    await exportMenu(page).getByRole("menuitem", { name: /^Save as…/ }).click();
    await expect(page.locator(".snackbar__msg").filter({ hasText: "sample.pdf is open in another tab" }).first()).toBeVisible();
    expect(await writes(page)).toEqual([]);
    await expect(activeTab(page)).toContainText("typeset.pdf");
  });

  test("one unreadable file among several doesn't cost the others", async ({ page }) => {
    const f = await fixtures();
    await installStubs(page, { open: [asStub(f.sample), asStub(f.typeset)], unreadable: "typeset.pdf" });
    await openPicked(page);
    await expect(page.locator(".doctab")).toHaveCount(1);
    await expect(page.locator(".doctab")).toContainText("sample.pdf");
    await expect(page.locator(".snackbar__msg").filter({ hasText: 'Couldn\'t read "typeset.pdf"' }).first()).toBeVisible();
  });
});

test.describe("third review fixes", () => {
  test("Save as onto its own password-opened file warns, as Ctrl+S does", async ({ page }) => {
    const f = await fixtures();
    await installStubs(page, { open: [asStub(f.locked)], saveAs: "locked.pdf" });
    await openPicked(page, false);
    const pw = page.getByRole("dialog", { name: "This PDF is password-protected" });
    await pw.getByLabel("Password").fill(LOCKED_PASSWORD);
    await pw.getByLabel("Password").press("Enter");
    await page.waitForSelector(".page canvas", { timeout: 30_000 });
    await addText(page, "Unlocked");
    await page.getByRole("button", { name: "Export options" }).click();
    await exportMenu(page).getByRole("menuitem", { name: /^Save as…/ }).click();
    const warn = page.getByRole("alertdialog", { name: "Save without its password?" });
    await expect(warn).toBeVisible();
    await warn.getByRole("button", { name: "Go back" }).click();
    expect(await writes(page)).toEqual([]);
  });

  test("Save as on a file already named -edited doesn't offer its own name", async ({ page }) => {
    const f = await fixtures();
    await installStubs(page, { open: [{ ...asStub(f.sample), name: "sample-edited.pdf" }] });
    await openPicked(page);
    await page.getByRole("button", { name: "Export options" }).click();
    await exportMenu(page).getByRole("menuitem", { name: /^Save as…/ }).click();
    await expect.poll(async () => (await calls(page)).save).toBe(1);
    const suggested = await page.evaluate(() => (window as unknown as { __suggested: string[] }).__suggested);
    expect(suggested).toEqual(["sample-edited copy.pdf"]);
  });

  test("a file already open, picked with another, is said to be open", async ({ page }) => {
    const f = await fixtures();
    await installStubs(page, { open: [asStub(f.sample)] });
    await openPicked(page);
    await page.evaluate(
      ([a, b]) => {
        const w = window as unknown as { showOpenFilePicker: () => Promise<unknown[]> };
        const first = w.showOpenFilePicker;
        w.showOpenFilePicker = async () => {
          const [h] = (await first()) as { name: string }[];
          const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
          return [h, { kind: "file", name: a, getFile: async () => new File([fromB64(b)], a, { type: "application/pdf" }), isSameEntry: async (o: { name: string }) => o.name === a }];
        };
      },
      [asStub(f.typeset).name, asStub(f.typeset).b64],
    );
    await page.keyboard.press("Control+o");
    await expect(page.locator(".doctab")).toHaveCount(2, { timeout: 30_000 });
    await expect(page.locator(".snackbar__msg").filter({ hasText: "sample.pdf is already open." }).first()).toBeVisible();
  });

  test("an already-open file never talks over why another didn't open", async ({ page }) => {
    const f = await fixtures();
    await installStubs(page, { open: [asStub(f.sample)] });
    await openPicked(page);
    await page.evaluate(() => {
      const w = window as unknown as { showOpenFilePicker: () => Promise<unknown[]> };
      const first = w.showOpenFilePicker;
      w.showOpenFilePicker = async () => {
        const [h] = (await first()) as { name: string }[];
        const name = "notes.pdf";
        return [h, { kind: "file", name, getFile: async () => new File(["just text"], name, { type: "application/pdf" }), isSameEntry: async (o: { name: string }) => o.name === name }];
      };
    });
    await page.keyboard.press("Control+o");
    await expect(page.locator(".snackbar__msg").filter({ hasText: '"notes.pdf" isn\'t a PDF' }).first()).toBeVisible();
    await page.waitForTimeout(500);
    await expect(page.locator(".snackbar__msg").filter({ hasText: "already open" })).toHaveCount(0);
    await expect(page.locator(".doctab")).toHaveCount(1);
  });
});
