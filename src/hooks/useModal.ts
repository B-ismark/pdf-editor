import { useEffect, useRef } from "react";

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "textarea:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(",");

/**
 * Module-level modal stack so that with nested modals (e.g. a confirm dialog
 * opened from the full-screen organizer) only the TOP-most modal reacts to
 * Escape, the Back gesture, and the focus trap. A single shared `popstate`
 * listener keeps history handling correct regardless of nesting depth.
 */
interface ModalEntry {
  token: symbol;
  onClose: () => void;
  popClosed: boolean;
}
const stack: ModalEntry[] = [];
let selfPop = false; // true while we programmatically unwind our own entry
let listenerInstalled = false;

// Transient popovers (e.g. the colour picker) that own Escape while open.
// A modal defers its own Escape handling while any are active, so Escape
// closes the popover before the dialog beneath it — regardless of listener
// registration order.
let escapeLayers = 0;
export function acquireEscapeLayer() {
  escapeLayers++;
  return () => {
    escapeLayers = Math.max(0, escapeLayers - 1);
  };
}

function handlePop() {
  // A back() we issued ourselves to clean up an entry — consume it silently.
  if (selfPop) {
    selfPop = false;
    return;
  }
  const top = stack[stack.length - 1];
  if (top) {
    top.popClosed = true;
    top.onClose();
  }
}

function ensureListener() {
  if (listenerInstalled) return;
  window.addEventListener("popstate", handlePop);
  listenerInstalled = true;
}

function removeListenerIfEmpty() {
  if (stack.length === 0 && listenerInstalled) {
    window.removeEventListener("popstate", handlePop);
    listenerInstalled = false;
  }
}

/**
 * Shared modal behaviour for dialogs and full-screen surfaces:
 *
 * - **Focus trap** — Tab / Shift+Tab cycle within the container (WCAG 2.4.3).
 * - **Escape to close** and **focus restoration** to the element that had
 *   focus before the modal opened.
 * - **Platform Back integration** — pushes a history entry on open so the
 *   Android back gesture/button, iOS back, and the browser back button dismiss
 *   the (top-most) modal instead of navigating the app away (audit P-3).
 *
 * Attach the returned ref to the modal's container (give it `tabIndex={-1}` so
 * it can receive focus when it has no focusable children).
 */
export function useModal<T extends HTMLElement = HTMLElement>(onClose: () => void) {
  const containerRef = useRef<T | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const container = containerRef.current;
    const prevActive = document.activeElement as HTMLElement | null;
    const token = Symbol("modal");
    const entry: ModalEntry = { token, onClose: () => onCloseRef.current(), popClosed: false };
    stack.push(entry);
    ensureListener();
    window.history.pushState({ __modal: true }, "");

    const isTop = () => stack[stack.length - 1]?.token === token;

    const focusables = (): HTMLElement[] => {
      if (!container) return [];
      return Array.from(
        container.querySelectorAll<HTMLElement>(FOCUSABLE),
      ).filter((el) => el.getClientRects().length > 0);
    };

    // Move focus into the dialog (first focusable, else the container itself).
    const items = focusables();
    (items[0] ?? container)?.focus?.();

    const onKeyDown = (e: KeyboardEvent) => {
      if (!isTop()) return;
      if (e.key === "Escape") {
        // A transient popover (colour picker) is open — let it take Escape.
        if (escapeLayers > 0) return;
        e.preventDefault();
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab" || !container) return;
      const list = focusables();
      if (list.length === 0) {
        e.preventDefault();
        container.focus();
        return;
      }
      const first = list[0];
      const last = list[list.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && (active === first || !container.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);

    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      const i = stack.indexOf(entry);
      if (i !== -1) stack.splice(i, 1);
      // Closed via the UI (not the Back gesture) — unwind the history entry we
      // added. `selfPop` makes the resulting popstate a no-op so we never
      // cascade-close a parent modal.
      if (!entry.popClosed) {
        selfPop = true;
        window.history.back();
      }
      removeListenerIfEmpty();
      prevActive?.focus?.();
    };
    // Run once for the modal's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return containerRef;
}
