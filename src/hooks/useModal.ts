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

/** What counts as "a field" for where a dialog puts focus on opening. */
/** A place to type. */
const TYPING =
  'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="range"])' +
  ':not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="file"]):not([type="color"]),' +
  ' textarea, [contenteditable="true"]';
/**
 * Where a dialog's work starts: a place to type, a list to pick from, or the
 * option a radio group has chosen. Not a checkbox or a slider: those are
 * settings that sit under the work (Sign's "Remember this signature" is below
 * the pad), and not an unchosen radio, which a screen reader would announce as
 * the choice.
 */
const FIELD = `${TYPING}, select, input[type="radio"]:checked`;

/**
 * The app's own history entries, in one place. Dialogs push one so Back
 * closes them, and so does the editor's phone "Back puts the selection
 * away" layer; each removes its entry with `history.back()` when closed from
 * the UI. One `popstate` listener tells those removals apart from a real Back:
 *
 * - **Removals are counted**, not flagged: two closing in one render are two
 *   pops, and a flag would take the second for the person pressing Back.
 * - **A push waits while a removal is on its way.** One dialog handing over
 *   to another in the same render (a form closing as the warning it triggers
 *   opens) runs `back()` and `pushState` back to back, and Chrome finishes the
 *   queued back *after* the push, discarding the new entry; the new dialog
 *   then steps the browser out of the app when it closes.
 * - **A real Back goes to the top dialog**, and only with none open to the
 *   editor's layer — never to both.
 */
export interface HistoryEntry {
  pushed: boolean;
  state: unknown;
}
let pendingPops = 0;
let waiting: HistoryEntry[] = [];
const strayBack = new Set<() => void>();

function push(entry: HistoryEntry) {
  entry.pushed = true;
  window.history.pushState(entry.state, "");
}

/** Add an entry of the app's own (now, or once a pending removal lands). */
export function pushHistory(state: unknown): HistoryEntry {
  const entry: HistoryEntry = { pushed: false, state };
  if (pendingPops > 0) waiting.push(entry);
  else push(entry);
  return entry;
}

/** Remove an entry added with `pushHistory`, closed from the UI. */
export function unwindHistory(entry: HistoryEntry) {
  if (!entry.pushed) {
    waiting = waiting.filter((w) => w !== entry);
    return;
  }
  entry.pushed = false;
  pendingPops++;
  window.history.back();
}

/** A real Back with no dialog open. Returns the unsubscribe. */
export function onStrayBack(fn: () => void): () => void {
  strayBack.add(fn);
  return () => strayBack.delete(fn);
}

interface ModalEntry {
  token: symbol;
  onClose: () => void;
  history: HistoryEntry;
}
const stack: ModalEntry[] = [];

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
  // One of our own removals landing — consume it silently.
  if (pendingPops > 0) {
    pendingPops--;
    if (pendingPops === 0) {
      const next = waiting;
      waiting = [];
      next.forEach(push);
    }
    return;
  }
  const top = stack[stack.length - 1];
  if (top) {
    // The browser already removed its entry.
    top.history.pushed = false;
    top.onClose();
    return;
  }
  strayBack.forEach((fn) => fn());
}

if (typeof window !== "undefined") window.addEventListener("popstate", handlePop);

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
/**
 * The opener of a dialog that closed while another took focus — one dialog
 * handing on to the next (Download with password → the covered-text warning).
 * The next one adopts it: its own opener, read as it rendered, was a button in
 * the dialog now gone.
 */
let handedOn: HTMLElement | null = null;

export function useModal<T extends HTMLElement = HTMLElement>(onClose: () => void) {
  const containerRef = useRef<T | null>(null);
  // Who had focus before the dialog: read while rendering, because by the time
  // an effect runs a child's `autoFocus` has already moved it inside, and
  // closing would hand focus back to a field that's gone — onto the page.
  const opener = useRef<HTMLElement | null | undefined>(undefined);
  if (opener.current === undefined) opener.current = document.activeElement as HTMLElement | null;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const container = containerRef.current;
    const placedAtOpen = document.activeElement as HTMLElement | null;
    let prevActive = opener.current ?? null;
    if (!prevActive?.isConnected) {
      prevActive = handedOn?.isConnected
        ? handedOn
        : placedAtOpen && placedAtOpen !== document.body && !container?.contains(placedAtOpen)
          ? placedAtOpen
          : null;
    }
    handedOn = null;
    const token = Symbol("modal");
    const entry: ModalEntry = { token, onClose: () => onCloseRef.current(), history: pushHistory({ __modal: true }) };
    stack.push(entry);

    const isTop = () => stack[stack.length - 1]?.token === token;

    const focusables = (): HTMLElement[] => {
      if (!container) return [];
      return Array.from(
        container.querySelectorAll<HTMLElement>(FOCUSABLE),
      ).filter((el) => el.getClientRects().length > 0);
    };

    // Move focus into the dialog — to where the work starts, not to Close.
    // Close leads the markup, so "the first focusable" put a ring on "close"
    // as the first thing the eye met. In order:
    // - where a child already put it (`autoFocus` runs before this effect);
    // - a control marked `data-autofocus` (the crop frame);
    // - the first field;
    // - else the dialog itself, so a screen reader reads its title and Tab
    //   goes on from the top.
    // Where a finger is the pointer, never a place to type: focusing one raises
    // the on-screen keyboard over a dialog the person hasn't started on yet.
    // So a dialog marks its field `data-autofocus` rather than `autoFocus`,
    // which would run first and can't be told. (The password to open a file
    // keeps `autoFocus`: typing it is all that dialog asks.)
    // Focus must not change anything either — a field that acts on focus (the
    // header slot chips type into) is marked rather than found.
    const placed = document.activeElement;
    if (!(container && placed && placed !== container && container.contains(placed))) {
      const finger = window.matchMedia?.("(pointer: coarse)").matches ?? false;
      const items = focusables().filter((el) => !(finger && el.matches(TYPING)));
      const target =
        items.find((el) => el.hasAttribute("data-autofocus")) ??
        items.find((el) => el.matches(FIELD)) ??
        container;
      target?.focus?.();
    }

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
      // Closed via the UI (not the Back gesture): remove the entry it added,
      // without that pop closing anything else.
      unwindHistory(entry.history);
      // Give focus back — unless something else already holds it: a dialog
      // opening as this one closes. Taking it from that dialog left it on its
      // box, and its own close then had nowhere to go. It inherits the opener.
      const now = document.activeElement;
      const free = !now || now === document.body || !now.isConnected || !!container?.contains(now);
      if (free) prevActive?.focus?.();
      else handedOn = prevActive;
    };
    // Run once for the modal's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return containerRef;
}
