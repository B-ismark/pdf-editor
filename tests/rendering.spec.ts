import { test, expect } from "@playwright/test";
import { fixtures } from "./fixtures";
import { open, canvasStats } from "./helpers";

/**
 * Per-page rendering must cost the viewport, not the document.
 *
 * Every page used to rasterise itself on mount, so a 150-page file held ~170 MP
 * of canvas backing store (about 680 MB) at all times and re-rasterised all of it
 * on every zoom step. Layout stays eager — page frames keep their true size so
 * scroll anchors and the scrollbar are exact — and only the contents are windowed.
 */
test.describe("render window", () => {
  test("a long document lays out every page but rasterises few", async ({ page }) => {
    await open(page, (await fixtures()).long);
    const stats = await canvasStats(page);
    expect(stats.pages, "every page frame is laid out").toBe(150);
    expect(stats.live, "only a band around the viewport is rasterised").toBeGreaterThan(0);
    expect(stats.live).toBeLessThanOrEqual(8);
  });

  test("canvas memory does not grow while scrolling", async ({ page }) => {
    await open(page, (await fixtures()).long);
    const top = await canvasStats(page);

    await page.evaluate(() => {
      const s = document.querySelector(".viewer__scroll")!;
      s.scrollTop = s.scrollHeight / 2;
    });
    await page.waitForTimeout(1500);
    const middle = await canvasStats(page);

    await page.evaluate(() => {
      const s = document.querySelector(".viewer__scroll")!;
      s.scrollTop = s.scrollHeight;
    });
    await page.waitForTimeout(1500);
    const bottom = await canvasStats(page);

    // The window should slide, not accumulate. Generous factor: the band size
    // varies with where in the document you are, but not with how far you went.
    expect(middle.megapixels).toBeLessThanOrEqual(top.megapixels * 2.5);
    expect(bottom.megapixels).toBeLessThanOrEqual(top.megapixels * 2.5);
  });

  test("the page you scroll to is actually painted", async ({ page }) => {
    await open(page, (await fixtures()).long);
    await page.evaluate(() => {
      const s = document.querySelector(".viewer__scroll")!;
      s.scrollTop = s.scrollHeight;
    });
    // Guards the trap that made this look like it worked: `rootMargin` doesn't
    // expand an intervening scroll clip, so with the wrong observer root only the
    // page literally on screen renders and the user watches skeletons resolve.
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const pages = [...document.querySelectorAll(".page")];
            const last = pages[pages.length - 1];
            return (
              (last.querySelector("canvas") as HTMLCanvasElement).width > 1 &&
              !!last.querySelector(".page__overlay")
            );
          }),
        { timeout: 20_000 },
      )
      .toBe(true);
  });
});

/**
 * A keystroke re-renders the page it lands on, not the document.
 *
 * `PageView` is memo'd, but the memo used to be defeated on every keystroke and
 * every selection change: App's callbacks all depended on a history object that
 * was a fresh literal each render, and every page was handed the whole `edits`
 * map and the global selection. On a 150-page file that was 150 page renders per
 * character typed (TECH 2.3).
 *
 * The count comes from React itself: a stand-in for the DevTools hook sees every
 * commit, and a page "rendered" when its first hook object is new — React keeps
 * that object when a memo bails out and allocates a fresh one when the function
 * runs. Nothing in the app is instrumented for this.
 */
const COUNT_PAGE_RENDERS = () => {
  const w = window as unknown as { __pageRenders: number[]; __REACT_DEVTOOLS_GLOBAL_HOOK__: unknown };
  type Fiber = { tag: number; child: Fiber | null; sibling: Fiber | null; memoizedState: object | null; memoizedProps: { className?: string; page?: { pageIndex: number } } | null };
  const prevByRoot = new WeakMap<object, WeakSet<object>>();
  w.__pageRenders = [];
  let ids = 0;
  w.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    isDisabled: false,
    renderers: new Map(),
    inject: () => ++ids,
    checkDCE: () => {},
    onScheduleFiberRoot: () => {},
    onPostCommitFiberRoot: () => {},
    onCommitFiberUnmount: () => {},
    onCommitFiberRoot: (_id: number, root: { current: Fiber }) => {
      const prev = prevByRoot.get(root);
      const next = new WeakSet<object>();
      const stack: Fiber[] = [root.current];
      while (stack.length) {
        const f = stack.pop()!;
        // A memo'd function component (SimpleMemoComponent, tag 15) whose host
        // child is the `.page` frame: that's a PageView.
        if (f.tag === 15 && f.child?.tag === 5 && f.child.memoizedProps?.className === "page" && f.memoizedState) {
          next.add(f.memoizedState);
          if (prev && !prev.has(f.memoizedState)) w.__pageRenders.push(f.memoizedProps!.page!.pageIndex);
        }
        if (f.sibling) stack.push(f.sibling);
        if (f.child) stack.push(f.child);
      }
      prevByRoot.set(root, next);
    },
  };
};

/** Record the most `.page__overlay`s and thumbnail canvases ever in the DOM at
 * once, and how many thumbnail canvases were ever attached — from before the
 * app's first commit, so a one-frame burst can't slip between two polls. */
const WATCH_MOUNTS = () => {
  const w = window as unknown as { __peak: { overlays: number; thumbs: number; thumbsEver: number } };
  w.__peak = { overlays: 0, thumbs: 0, thumbsEver: 0 };
  new MutationObserver((records) => {
    for (const r of records)
      r.addedNodes.forEach((n) => {
        if (n instanceof HTMLCanvasElement && n.classList.contains("thumb__canvas")) w.__peak.thumbsEver++;
      });
    w.__peak.overlays = Math.max(w.__peak.overlays, document.querySelectorAll(".page__overlay").length);
    w.__peak.thumbs = Math.max(w.__peak.thumbs, document.querySelectorAll(".thumb__canvas").length);
  }).observe(document, { childList: true, subtree: true });
};
const peak = (page: import("@playwright/test").Page) =>
  page.evaluate(() => (window as unknown as { __peak: { overlays: number; thumbs: number; thumbsEver: number } }).__peak);

/**
 * Nothing mounts for the whole document, not even for one frame.
 *
 * `useRenderWindow` used to start every element as "near" and let the observer
 * correct it a frame later — so opening a long file mounted every page's
 * overlay at once (on 600 pages, ~15k text nodes in a 600 ms long task) only to
 * tear them down again. The same bug made opening the rail rasterise every
 * thumbnail (TECH 2.4).
 */
test.describe("first frame", () => {
  test("opening a long document never mounts every page's overlay", async ({ page }) => {
    await page.addInitScript(WATCH_MOUNTS);
    await open(page, (await fixtures()).long);
    const { overlays } = await peak(page);
    expect(overlays, "the overlays on screen do mount").toBeGreaterThan(0);
    expect(overlays, "but only a band around the viewport, even on the first commit").toBeLessThanOrEqual(10);
  });

  test("the page rail renders the thumbnails in view and lets go of the rest", async ({ page }) => {
    await page.addInitScript(WATCH_MOUNTS);
    await open(page, (await fixtures()).long);
    await page.getByRole("button", { name: "Show pages" }).click();
    await expect(page.locator(".pagenav .thumb__canvas").first()).toBeVisible({ timeout: 15_000 });
    const opened = await peak(page);
    expect(opened.thumbs, "opening the rail rasterises a band, not all 150").toBeLessThanOrEqual(30);

    // Fling the rail top to bottom in small steps, like a fast scroll does: the
    // thumbnails passed on the way must not each queue a render.
    await page.evaluate(async () => {
      const list = document.querySelector(".pagenav__list")!;
      for (let y = 0; y <= list.scrollHeight; y += 400) {
        list.scrollTop = y;
        await new Promise((r) => requestAnimationFrame(() => r(null)));
      }
      list.scrollTop = list.scrollHeight;
    });
    // The last page's thumbnail does arrive once the rail settles…
    await expect(page.locator(".pagenav__item").last().locator(".thumb__canvas")).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(500);
    const after = await peak(page);
    const live = await page.locator(".pagenav .thumb__canvas").count();
    // …the ones left behind are gone, not just hidden…
    expect(live, "only the band around the bottom of the rail is held").toBeLessThanOrEqual(30);
    expect(await page.locator(".pagenav__item").first().locator(".thumb__canvas").count()).toBe(0);
    // …and the fling itself rendered little more than the two bands it ended at.
    expect(after.thumbsEver, "thumbnails passed mid-fling were not rasterised").toBeLessThan(80);
  });
});

test("a thumbnail that failed and then renders doesn't take the app down", async ({ page }) => {
  // Low canvas memory (iOS Safari especially) makes `getContext` return null.
  // The thumbnail shows its error mark; when it later renders, the canvas went
  // into the same node React rendered the mark in, the mark's removal threw
  // `removeChild` NotFoundError, and React unmounted the whole app.
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    const real = HTMLCanvasElement.prototype.getContext;
    const w = window as unknown as { __starve: boolean };
    w.__starve = false;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, ...args: Parameters<typeof real>) {
      if (w.__starve && this.width < 400) return null;
      return real.apply(this, args);
    } as typeof real;
  });
  await open(page, (await fixtures()).long);
  await page.evaluate(() => ((window as unknown as { __starve: boolean }).__starve = true));
  await page.getByRole("button", { name: "Show pages" }).click();
  await expect(page.locator(".pagenav .thumb__err").first()).toBeVisible({ timeout: 15_000 });

  await page.evaluate(() => ((window as unknown as { __starve: boolean }).__starve = false));
  // Out of the window and back: the failed thumbnails render this time.
  await page.evaluate(() => (document.querySelector(".pagenav__list")!.scrollTop = 1e6));
  await page.waitForTimeout(800);
  await page.evaluate(() => (document.querySelector(".pagenav__list")!.scrollTop = 0));
  await expect(page.locator(".pagenav__item").first().locator(".thumb__canvas")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".pagenav__item").first().locator(".thumb__err")).toHaveCount(0);
  expect(errors).toEqual([]);
  expect(await page.locator(".page").count(), "the app is still mounted").toBe(150);
});

test.describe("page memo", () => {
  const renders = (page: import("@playwright/test").Page) =>
    page.evaluate(() => (window as unknown as { __pageRenders: number[] }).__pageRenders.splice(0));

  test("typing re-renders only the page being typed on", async ({ page }) => {
    await page.addInitScript(COUNT_PAGE_RENDERS);
    await open(page, (await fixtures()).long);
    await page.locator('.page[data-page-index="0"] .fragment').first().click();
    await page.waitForTimeout(300);
    await renders(page);

    await page.keyboard.type("abcde", { delay: 40 });
    await page.waitForTimeout(300);
    const typed = await renders(page);
    expect(typed.length, "the counter sees the page being typed on").toBeGreaterThan(0);
    expect([...new Set(typed)], "no other page re-renders per keystroke").toEqual([0]);
  });

  test("moving the selection re-renders only the two pages involved", async ({ page }) => {
    await page.addInitScript(COUNT_PAGE_RENDERS);
    await open(page, (await fixtures()).long);
    await page.locator('.page[data-page-index="0"] .fragment').first().click();
    await page.waitForTimeout(300);
    await renders(page);

    await page.locator('.page[data-page-index="1"] .fragment').first().click();
    await page.waitForTimeout(300);
    const moved = [...new Set(await renders(page))].sort((a, b) => a - b);
    expect(moved).toContain(0);
    expect(moved).toContain(1);
    // The click scrolls page 1 into view, which can slide the render window and
    // wake a neighbour through its own state — that's the window, not the memo.
    // Before the fix this was every one of the 150 pages.
    expect(moved.length, `re-rendered pages: ${moved.join(", ")}`).toBeLessThanOrEqual(4);
  });
});
