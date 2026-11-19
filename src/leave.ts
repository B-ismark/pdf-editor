import { useCallback, type RefObject } from "react";

/**
 * Exit motion for surfaces React removes outright.
 *
 * A dialog, menu or sheet is rendered while it's open and simply not rendered
 * when it closes, so there is nothing left on screen to animate: it blinks
 * out. Rather than keep every one of them mounted through a "closing" state
 * (twenty call sites, each a chance to leave a dead dialog holding focus), the
 * element is copied at the moment React lets go of it, and the copy plays the
 * exit. The copy is a picture, not a surface: inert, hidden from assistive
 * tech, stripped of ids, roles and labels so no role or label query finds it,
 * unclickable and unfocusable, and gone when the motion ends. It keeps its
 * classes (its styling needs them) and carries `.is-leaving`, so a class
 * query that must not see it says `:not(.is-leaving)`.
 *
 * Call it while the element is still in the page: from a callback ref's
 * cleanup or a layout effect's cleanup (both run before React removes the
 * node); the copy is only placed once the element has really gone. Under
 * reduced motion, or when the element is already hidden, it does nothing.
 */

/** Longest exit in styles.css (`--dur-short4`) plus slack for a busy frame. */
const MAX_EXIT_MS = 320;

const STRIP = ["id", "role", "name", "for", "tabindex", "autofocus", "data-autofocus", "data-tip", "href"];

export function leave(el: Element | null | undefined): void {
  // This runs inside React's commit (a ref or layout-effect cleanup): a throw
  // here would take the whole app down for the sake of a fade. Never let one out.
  try {
    play(el);
  } catch {
    /* no exit motion is always an acceptable outcome */
  }
}

function play(el: Element | null | undefined): void {
  if (!(el instanceof HTMLElement) || !el.isConnected || !el.parentNode) return;
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  if (el.getClientRects().length === 0) return;
  // Only what floats. A copy of a docked panel would take its room in the
  // layout for the length of the exit and shove the page sideways and back;
  // there the page taking the space back *is* the motion.
  const position = getComputedStyle(el).position;
  if (position !== "fixed" && position !== "absolute") return;

  const parent = el.parentNode;
  const next = el.nextSibling;
  const ghost = el.cloneNode(true) as HTMLElement;

  // What cloning doesn't carry: what was drawn, typed and scrolled. Each one
  // on its own, so one element that refuses can't cost the rest.
  const from = [el, ...el.querySelectorAll("*")];
  const to = [ghost, ...ghost.querySelectorAll("*")];
  const scrolls: [HTMLElement, number, number][] = [];
  from.forEach((src, i) => {
    const dst = to[i];
    if (!dst) return;
    try {
      if (src instanceof HTMLCanvasElement && dst instanceof HTMLCanvasElement && src.width > 0 && src.height > 0) {
        dst.getContext("2d")?.drawImage(src, 0, 0);
      } else if (src instanceof HTMLInputElement && dst instanceof HTMLInputElement) {
        // A file input's value can't be set by script (it throws); the copy
        // shows its label, which is all a picture needs.
        if (src.type !== "file") dst.value = src.value;
        dst.checked = src.checked;
      } else if (src instanceof HTMLTextAreaElement && dst instanceof HTMLTextAreaElement) {
        dst.value = src.value;
      } else if (src instanceof HTMLSelectElement && dst instanceof HTMLSelectElement) {
        dst.selectedIndex = src.selectedIndex;
      }
    } catch {
      /* a tainted canvas or an unsettable value just stays as cloned */
    }
    if (src instanceof HTMLElement && (src.scrollTop || src.scrollLeft)) scrolls.push([dst as HTMLElement, src.scrollTop, src.scrollLeft]);
    if (dst instanceof HTMLElement || dst instanceof SVGElement) {
      for (const a of STRIP) dst.removeAttribute(a);
      for (const a of [...dst.attributes]) if (a.name.startsWith("aria-")) dst.removeAttribute(a.name);
    }
  });

  ghost.setAttribute("aria-hidden", "true");
  ghost.setAttribute("data-leaving", "");
  ghost.inert = true;
  ghost.classList.add("is-leaving");

  // Only once React has actually removed it. A cleanup also runs when the
  // element stays: StrictMode's mount-unmount-mount in development, and a tab
  // going to the background, which hides its editor rather than removing it.
  // A microtask still lands before the next paint, so a real exit shows no gap.
  queueMicrotask(() => {
    try {
      if (el.isConnected || !parent.isConnected) return;
      parent.insertBefore(ghost, next && next.parentNode === parent ? next : null);
      for (const [d, top, left] of scrolls) {
        d.scrollTop = top;
        d.scrollLeft = left;
      }
      let done = false;
      const remove = () => {
        if (done) return;
        done = true;
        ghost.remove();
      };
      ghost.addEventListener("animationend", (e) => {
        if (e.target === ghost) remove();
      });
      window.setTimeout(remove, MAX_EXIT_MS);
    } catch {
      /* as above: never at the cost of the app */
    }
  });
}

/**
 * A callback ref that plays `leave` when its element is removed. Stable
 * identity matters: React calls a ref's cleanup whenever the callback itself
 * changes, so an inline arrow would play the exit on every render.
 */
export function leaveRef(el: HTMLElement | null): (() => void) | undefined {
  if (!el) return undefined;
  return () => leave(el);
}

/** `leaveRef` for an element that also has a ref object the code reads. */
export function useLeavingRef<T extends HTMLElement>(ref: RefObject<T | null>) {
  return useCallback(
    (el: T | null) => {
      ref.current = el;
      if (!el) return undefined;
      return () => {
        if (ref.current === el) ref.current = null;
        leave(el);
      };
    },
    [ref],
  );
}
