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
 * tech, stripped of ids and roles so nothing can find it, click it or focus
 * it, and gone when the motion ends.
 *
 * Call it while the element is still in the page: from a callback ref's
 * cleanup or a layout effect's cleanup (both run before React removes the
 * node). Under reduced motion, or when the element is already hidden (a tab
 * parked in the background), it does nothing.
 */

/** Longest exit in styles.css (`--dur-short4`) plus slack for a busy frame. */
const MAX_EXIT_MS = 320;

const STRIP = ["id", "role", "name", "for", "tabindex", "autofocus", "data-autofocus", "data-tip", "href"];

export function leave(el: Element | null | undefined): void {
  if (!(el instanceof HTMLElement) || !el.isConnected || !el.parentNode) return;
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  if (el.getClientRects().length === 0) return;
  // Only what floats. A copy of a docked panel would take its room in the
  // layout for the length of the exit and shove the page sideways and back;
  // there the page taking the space back *is* the motion.
  const position = getComputedStyle(el).position;
  if (position !== "fixed" && position !== "absolute") return;

  const ghost = el.cloneNode(true) as HTMLElement;

  // What cloning doesn't carry: what was drawn, typed and scrolled.
  const from = [el, ...el.querySelectorAll("*")];
  const to = [ghost, ...ghost.querySelectorAll("*")];
  from.forEach((src, i) => {
    const dst = to[i];
    if (!dst) return;
    if (src instanceof HTMLCanvasElement && dst instanceof HTMLCanvasElement && src.width > 0 && src.height > 0) {
      try {
        dst.getContext("2d")?.drawImage(src, 0, 0);
      } catch {
        /* a tainted or lost canvas just leaves blank */
      }
    } else if (src instanceof HTMLInputElement && dst instanceof HTMLInputElement) {
      dst.value = src.value;
      dst.checked = src.checked;
    } else if (src instanceof HTMLTextAreaElement && dst instanceof HTMLTextAreaElement) {
      dst.value = src.value;
    } else if (src instanceof HTMLSelectElement && dst instanceof HTMLSelectElement) {
      dst.selectedIndex = src.selectedIndex;
    }
    if (src instanceof HTMLElement && (src.scrollTop || src.scrollLeft)) {
      const top = src.scrollTop;
      const left = src.scrollLeft;
      requestAnimationFrame(() => {
        (dst as HTMLElement).scrollTop = top;
        (dst as HTMLElement).scrollLeft = left;
      });
    }
    if (dst instanceof HTMLElement || dst instanceof SVGElement) {
      for (const a of STRIP) dst.removeAttribute(a);
      for (const a of [...dst.attributes]) if (a.name.startsWith("aria-")) dst.removeAttribute(a.name);
    }
  });

  ghost.setAttribute("aria-hidden", "true");
  ghost.setAttribute("data-leaving", "");
  ghost.inert = true;
  ghost.classList.add("is-leaving");
  el.parentNode.insertBefore(ghost, el.nextSibling);

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
