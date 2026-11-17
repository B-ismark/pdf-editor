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

let stale = false;
const listeners = new Set<() => void>();

/** Say the running build is out of date. Idempotent. */
export function reportStaleBuild(): void {
  if (stale) return;
  stale = true;
  for (const l of listeners) l();
}

/** True once any part of the app failed to load. */
export function useStaleBuild(): boolean {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => stale,
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
  reportStaleBuild();
  return "This part of the editor couldn't load — the app was updated. Reload to continue.";
}

/** Catch what nothing else does: a failed import in a promise nobody awaited,
 * and Vite's own preload failure event. Call once, at startup. */
export function watchForStaleBuild(): void {
  window.addEventListener("vite:preloadError", () => {
    // Not `preventDefault()`: that tells Vite to carry on as if the import
    // had worked, and the caller then gets `undefined` for a module — a
    // TypeError far from the cause. Let the import reject; every caller
    // handles that (and `lazyPart` turns it into a closed dialog).
    reportStaleBuild();
  });
  window.addEventListener("unhandledrejection", (e) => {
    if (isStaleBuildError(e.reason)) {
      e.preventDefault();
      reportStaleBuild();
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
 * One retry covers a dropped connection; if the file is really gone, the part
 * becomes `Unavailable` (closes itself) and the update banner is raised —
 * instead of the rejection unmounting the whole app.
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
        reportStaleBuild();
        return { default: Unavailable as unknown as ComponentType<P> };
      }
    }
  });
}
