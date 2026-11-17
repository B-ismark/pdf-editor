import { lazy, useEffect, useSyncExternalStore, type ComponentType } from "react";

/**
 * The app was updated while this page was open.
 *
 * Parts of the editor (the dialogs, the exporter, signing, OCR) are separate
 * files fetched the first time they're used, under content-hashed names. A
 * deploy replaces the whole site, so a page opened before it asks for files
 * that no longer exist. Unhandled, that was a `React.lazy` rejecting during
 * render with no error boundary: React unmounted the whole tree and the user
 * was left looking at an empty page — black, in dark mode — with the document
 * gone from screen.
 *
 * Now a part that can't load is reported here, the thing that asked for it
 * simply doesn't open, the document stays exactly where it was, and the shell
 * shows one calm "updated — reload" banner (see `App.tsx`).
 */

/** Why a part of the app couldn't load: the site was replaced by a newer
 * build (the file is gone for good), or the connection failed (the file is
 * there; a reload once back online fixes it). */
export type LoadTrouble = "updated" | "offline";

let trouble: LoadTrouble | null = null;
let diagnosing = false;
const listeners = new Set<() => void>();

function settle(kind: LoadTrouble): void {
  // "updated" is the stronger claim and, once proven, stays.
  if (trouble === "updated" || trouble === kind) return;
  trouble = kind;
  for (const l of listeners) l();
}

/** The code file an import error names, when the engine includes it
 * (Chromium and Firefox do; WebKit doesn't). */
function fileOf(err: unknown): string | null {
  const msg = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  const m = msg.match(/(https?:\/\/[^\s'"]+|\/[^\s'"]+?\.(?:m?js|css))/);
  if (!m) return null;
  try {
    return new URL(m[1], window.location.href).href;
  } catch {
    return null;
  }
}

/** Tell a deploy from a dropped connection — the banner must not say "the
 * app was updated" about a blip. Ask for the file again, bypassing every
 * cache: gone (404) is a deploy. Without a file name, compare the live entry
 * page's main script with this page's. Anything that can't be reached is the
 * connection. */
async function diagnose(err: unknown): Promise<LoadTrouble> {
  const file = fileOf(err);
  try {
    if (file) {
      const res = await fetch(file, { method: "HEAD", cache: "no-store" });
      return res.status === 404 || res.status === 410 ? "updated" : "offline";
    }
    const res = await fetch("./", { cache: "no-store" });
    if (!res.ok) return "offline";
    const live = (await res.text()).match(/assets\/index-[\w-]{8}\.js/)?.[0];
    const mine = [...document.querySelectorAll<HTMLScriptElement>("script[src]")]
      .map((sc) => sc.src)
      .find((src) => /assets\/index-[\w-]{8}\.js/.test(src));
    return live && mine && !mine.endsWith(live) ? "updated" : "offline";
  } catch {
    return "offline";
  }
}

/** Say a code file couldn't load. Works out why in the background, then
 * raises the banner. Idempotent. */
export function reportStaleBuild(err?: unknown): void {
  if (trouble === "updated" || diagnosing) return;
  diagnosing = true;
  void diagnose(err).then((kind) => {
    diagnosing = false;
    settle(kind);
  });
}

/** Why a part of the app couldn't load, once known; `null` while all is well. */
export function useStaleBuild(): LoadTrouble | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => trouble,
  );
}

/** Whether an error is a code file that couldn't be fetched — a module the
 * browser couldn't import, or a stylesheet/preload Vite couldn't fetch. The
 * wording differs by engine: Chromium, WebKit and Firefox respectively. */
export function isStaleBuildError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS|Failed to load module script/i.test(
    msg,
  );
}

/** For a `catch` that turns a failure into a status message: if the failure is
 * a missing code file, raise the banner too, and return the line to show in
 * place of the raw browser error. `null` when it's some other failure. */
export function staleBuildMessage(err: unknown): string | null {
  if (!isStaleBuildError(err)) return null;
  reportStaleBuild(err);
  // Neutral: whether it was a deploy or the connection is settled after this
  // line is shown, and the banner says which.
  return "This part of the editor couldn't load. Reload to continue.";
}

/** Catch what nothing else does: a failed import in a promise nobody awaited,
 * and Vite's own preload failure event. Call once, at startup. */
export function watchForStaleBuild(): void {
  window.addEventListener("vite:preloadError", (e) => {
    // Not `preventDefault()`: that tells Vite to carry on as if the import
    // had worked, and the caller then gets `undefined` for a module — a
    // TypeError far from the cause. Let the import reject; every caller
    // handles that (and `lazyPart` turns it into a closed dialog).
    // Vite routes *every* rejected dynamic import through this event, a module
    // that threw while starting up included — only a file that couldn't be
    // fetched is ours.
    const payload = (e as Event & { payload?: unknown }).payload;
    if (isStaleBuildError(payload)) reportStaleBuild(payload);
  });
  window.addEventListener("unhandledrejection", (e) => {
    if (isStaleBuildError(e.reason)) {
      e.preventDefault();
      reportStaleBuild(e.reason);
    }
  });
}

/** The stand-in for a dialog whose code couldn't be fetched: it closes itself
 * on mount, so whatever opened it goes back to "closed" and nothing is left
 * thinking a modal is up. */
function Unavailable(props: { onClose?: () => void; onCancel?: () => void }) {
  const close = props.onClose ?? props.onCancel;
  useEffect(() => {
    close?.();
    // Once, on mount: the closer only flips the owner's "open" flag.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * `React.lazy` for an on-demand part of the app, made safe against a deploy.
 * If the file can't be fetched, the part becomes `Unavailable` (closes itself)
 * and the banner is raised — instead of the rejection unmounting the whole
 * app. React keeps that answer until the page reloads, and Chromium remembers
 * a failed module fetch anyway (its retry below never reaches the network), so
 * the banner's Reload is the way back in both cases: a deploy and a dropped
 * connection. The retry still helps engines that do fetch again.
 */
export function lazyPart<P extends object>(load: () => Promise<ComponentType<P>>) {
  return lazy(async (): Promise<{ default: ComponentType<P> }> => {
    try {
      return { default: await load() };
    } catch {
      await wait(400);
      try {
        return { default: await load() };
      } catch (err) {
        if (!isStaleBuildError(err)) throw err;
        reportStaleBuild(err);
        return { default: Unavailable as unknown as ComponentType<P> };
      }
    }
  });
}
