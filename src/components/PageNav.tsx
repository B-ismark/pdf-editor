import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { scrollToPage, useActivePage } from "../hooks/useActivePage";
import { Thumbnail } from "./Thumbnail";
import { Icon } from "./Icon";
import { OutlineTree } from "./OutlineTree";
import { segmentKey } from "../segmentKey";
import type { OutlineEntry } from "../pdf/outline";
import { plural } from "../plural";
import type { PageRef } from "../pdf/types";
import { dropPages, movePages, turnPages } from "../pdf/pagePlan";

interface Props {
  bytes: ArrayBuffer;
  /** The pages in shown order: source index and the turn the plan adds. */
  pages: PageRef[];
  /** Apply a new page plan as one undoable edit, and say what changed. */
  onArrange: (next: PageRef[], note: string) => void;
  /** Open the full-screen grid (Organise): merge, extract, big thumbnails. */
  onGrid: () => void;
  /** The phone overlay: a tap goes to the page and closes the sidebar, and
   * pages are picked by pressing and holding. Omitted on the desktop rail. */
  onClose?: () => void;
  /** The document's own bookmarks. When there are any, the sidebar can show
   * them instead of the pages. */
  outline?: OutlineEntry[];
  /** Which of the two the sidebar shows; kept by the editor so it survives
   * closing and reopening the sidebar. */
  view?: "pages" | "outline";
  onView?: (view: "pages" | "outline") => void;
}

/** How long a finger has to rest on a page before it picks the page up. */
const HOLD_MS = 400;

/**
 * The Pages sidebar: the document's pages in order, and the place to work on
 * them. Every change here — move, turn, delete — is an ordinary undoable edit
 * of the page plan (`DocState.pages`), live in the document beside it, with the
 * markup on each page going wherever the page goes.
 *
 * - Click a page to go to it (and select it). Shift-click selects a run,
 *   Ctrl/⌘-click adds or removes one.
 * - Drag a page, or the selection, to a new place. On a touch screen, press and
 *   hold first: a plain swipe scrolls the list.
 * - Keyboard: ↑/↓ move between pages (Shift extends), Alt+↑/↓ moves the
 *   selected pages, Delete deletes them, Ctrl/⌘+A selects every page, Escape
 *   clears the selection.
 *
 * Merging in other files and extracting pages stay in the grid view
 * (Organise): they make a different file rather than change this one.
 */
export function PageNav({ bytes, pages, onArrange, onGrid, onClose, outline = [], view = "pages", onView }: Props) {
  const hasOutline = outline.length > 0;
  const showOutline = hasOutline && view === "outline";
  const pageCount = pages.length;
  // Keyed on the list itself: a reorder keeps the count but moves every position.
  const active = useActivePage(pageCount, pages);
  const compact = !!onClose;

  // Pages are picked by their source index, which a move doesn't change.
  const [picked, setPicked] = useState<Set<number>>(() => new Set());
  const anchor = useRef<number | null>(null);
  const [focusKey, setFocusKey] = useState<number | null>(null);
  // Bumped to put keyboard focus back on the roving row after this render. A
  // counter, not a flag: a flag set by a key that changed nothing would linger
  // and steal focus on some later, unrelated render.
  const [refocusTick, setRefocusTick] = useState(0);
  const refocus = () => setRefocusTick((t) => t + 1);
  const navRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const posOf = useMemo(() => new Map(pages.map((p, i) => [p.index, i])), [pages]);
  // An undo can take a picked page back out of the document.
  const selected = useMemo(() => {
    const s = new Set<number>();
    picked.forEach((k) => posOf.has(k) && s.add(k));
    return s;
  }, [picked, posOf]);
  const n = selected.size;
  const all = n > 0 && n >= pageCount;

  const rovingKey = focusKey != null && posOf.has(focusKey) ? focusKey : pages[active]?.index ?? pages[0]?.index;

  // A page an undo or redo takes out of the document is let go of for good:
  // it mustn't come back already picked when a later undo restores it.
  useEffect(() => {
    setPicked((s) => {
      const kept = [...s].filter((k) => posOf.has(k));
      return kept.length === s.size ? s : new Set(kept);
    });
  }, [posOf]);

  // Keep keyboard focus on the page it was on across a re-order or delete: the
  // row moves (or goes) under it.
  useLayoutEffect(() => {
    if (refocusTick === 0) return;
    listRef.current?.querySelector<HTMLElement>(`[data-page-key="${rovingKey}"]`)?.focus();
    // Only the tick: rovingKey is read as of the render the tick came with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refocusTick]);

  // Working on the document hands the keyboard back to it. Canvas objects take
  // their pointer presses without moving focus, so a row would otherwise keep
  // it, and Delete meant for a selected box would delete a page instead.
  useEffect(() => {
    const leave = (e: PointerEvent) => {
      const nav = navRef.current;
      const at = document.activeElement;
      if (nav && at instanceof HTMLElement && nav.contains(at) && !nav.contains(e.target as Node)) at.blur();
    };
    window.addEventListener("pointerdown", leave, true);
    return () => window.removeEventListener("pointerdown", leave, true);
  }, []);

  const jump = (pos: number) => {
    scrollToPage(pos);
  };

  const pick = (keys: Iterable<number>) => setPicked(new Set(keys));
  const range = (from: number, to: number) => {
    const [a, b] = from < to ? [from, to] : [to, from];
    return pages.slice(a, b + 1).map((p) => p.index);
  };
  /** What an action applies to: the selection, else the page with focus. */
  const targets = (): Set<number> =>
    n > 0 ? new Set(selected) : rovingKey != null ? new Set([rovingKey]) : new Set();

  const pageWord = (keys: Set<number>) =>
    keys.size === 1 ? `page ${(posOf.get([...keys][0]) ?? 0) + 1}` : plural(keys.size, "page");

  const turn = (keys = targets()) => {
    if (keys.size === 0) return;
    onArrange(turnPages(pages, keys), `Turned ${pageWord(keys)}.`);
  };
  /** Deletes only what was picked, never just the row that has focus: a
   * stray Backspace must not cost a page. Returns whether anything went. */
  const remove = (keys = new Set(selected)): boolean => {
    if (keys.size === 0 || keys.size >= pageCount) return false;
    const first = Math.min(...[...keys].map((k) => posOf.get(k) ?? 0));
    const next = dropPages(pages, keys);
    const note = `Deleted ${pageWord(keys)}.`;
    pick([]);
    anchor.current = null;
    // Focus lands on the page that took the first deleted one's place.
    const land = next[Math.min(first, next.length - 1)];
    setFocusKey(land?.index ?? null);
    onArrange(next, note);
    return true;
  };
  const move = (keys: Set<number>, gap: number): boolean => {
    const next = movePages(pages, keys, gap);
    if (next.every((p, i) => p.index === pages[i].index)) return false;
    const to = Math.min(...[...keys].map((k) => next.findIndex((p) => p.index === k))) + 1;
    onArrange(next, `Moved ${pageWord(keys)} to position ${to}.`);
    return true;
  };
  // A press outlives the render it started in: what it acts on when it ends
  // has to be read then, not from the closure it was made in.
  const live = useRef({ move, selected });
  live.current = { move, selected };

  // ---- pointer: click to pick, drag to move, hold first on touch ----
  const [drag, setDragState] = useState<{ keys: Set<number>; gap: number | null } | null>(null);
  // Read when the press ends, outside any state updater: applying the move is
  // an edit, and an updater may run twice.
  const dragRef = useRef(drag);
  const setDrag = (d: typeof drag) => {
    dragRef.current = d;
    setDragState(d);
  };
  const press = useRef<{
    id: number;
    key: number;
    x: number;
    y: number;
    touch: boolean;
    armed: boolean;
    dragging: boolean;
    timer: number;
    cancel: () => void;
  } | null>(null);
  // The click the browser sends after a drag or a hold, on the page it
  // started on. It can come well after the pointer is up (a touch waits to
  // rule out a double tap), so it is matched by page and time, not swallowed
  // for one tick.
  const swallowClick = useRef<{ key: number; until: number } | null>(null);

  // Once a held finger has picked a page up, the list mustn't scroll under it.
  // Only a non-passive touchmove can stop that; pointer events can't.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const stop = (e: TouchEvent) => {
      if (press.current?.armed) e.preventDefault();
    };
    list.addEventListener("touchmove", stop, { passive: false });
    return () => list.removeEventListener("touchmove", stop);
  }, []);

  // The page plan changing under a drag (an undo, a redo) calls the drag off:
  // its gap was measured against rows that have since moved.
  useEffect(() => () => press.current?.cancel(), [pages]);

  /** The gap the pointer is over, or null when it is off the list: letting go
   * there puts the pages back where they were. */
  const gapAt = (clientX: number, clientY: number): number | null => {
    const box = listRef.current?.getBoundingClientRect();
    if (!box || clientX < box.left || clientX > box.right) return null;
    const rows = Array.from(listRef.current?.querySelectorAll<HTMLElement>("[data-page-key]") ?? []);
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i].getBoundingClientRect();
      if (clientY < r.top + r.height / 2) return i;
    }
    return rows.length;
  };

  const onPointerDown = (e: ReactPointerEvent, key: number) => {
    if (e.button !== 0 || press.current) return;
    const touch = e.pointerType === "touch";
    const p = {
      id: e.pointerId,
      key,
      x: e.clientX,
      y: e.clientY,
      touch,
      armed: !touch,
      dragging: false,
      timer: 0,
      cancel: () => end(false),
    };
    if (touch) {
      p.timer = window.setTimeout(() => {
        p.armed = true;
        navigator.vibrate?.(10);
      }, HOLD_MS);
    }
    press.current = p;

    const end = (commit: boolean) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey, true);
      window.clearTimeout(p.timer);
      if (press.current === p) press.current = null;
      const d = dragRef.current;
      setDrag(null);
      if (commit && d && d.gap != null) live.current.move(d.keys, d.gap);
    };
    // Escape puts a dragged page back; nothing else hears it.
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape" || !p.dragging) return;
      ev.preventDefault();
      ev.stopPropagation();
      end(false);
    };
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== p.id) return;
      const dist = Math.hypot(ev.clientX - p.x, ev.clientY - p.y);
      if (!p.dragging) {
        if (dist < 6) return;
        if (!p.armed) {
          // A swipe before the hold: the list scrolls, nothing is picked.
          end(false);
          return;
        }
        p.dragging = true;
        const sel = live.current.selected;
        const keys = sel.has(p.key) ? new Set(sel) : new Set([p.key]);
        setDrag({ keys, gap: null });
      }
      const list = listRef.current;
      if (list) {
        const r = list.getBoundingClientRect();
        if (ev.clientY < r.top + 32) list.scrollTop -= 12;
        else if (ev.clientY > r.bottom - 32) list.scrollTop += 12;
      }
      const gap = gapAt(ev.clientX, ev.clientY);
      const d = dragRef.current;
      if (d && d.gap !== gap) setDrag({ ...d, gap });
    };
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== p.id) return;
      const swallow = () => (swallowClick.current = { key: p.key, until: performance.now() + 800 });
      if (p.dragging) {
        swallow();
      } else if (p.touch && p.armed) {
        // Held without moving: pick the page, the touch way to start a selection.
        swallow();
        setPicked((s) => new Set(s).add(p.key));
        anchor.current = p.key;
        setFocusKey(p.key);
      }
      end(p.dragging);
    };
    const onCancel = (ev: PointerEvent) => {
      if (ev.pointerId === p.id) end(false);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey, true);
  };

  const onClick = (e: ReactMouseEvent, key: number, pos: number) => {
    const sw = swallowClick.current;
    swallowClick.current = null;
    if (sw && sw.key === key && performance.now() < sw.until) return;
    setFocusKey(key);
    if (e.shiftKey && anchor.current != null && posOf.has(anchor.current)) {
      pick(range(posOf.get(anchor.current)!, pos));
      return;
    }
    if (e.metaKey || e.ctrlKey || (compact && n > 0)) {
      const s = new Set(selected);
      s.has(key) ? s.delete(key) : s.add(key);
      pick(s);
      anchor.current = key;
      return;
    }
    anchor.current = key;
    if (compact) {
      // On a phone the sidebar covers the page: going there means closing it.
      jump(pos);
      onClose?.();
      return;
    }
    pick([key]);
    jump(pos);
  };

  // ---- keyboard ----
  const onKeyDown = (e: ReactKeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey;
    const pos = rovingKey != null ? posOf.get(rovingKey) ?? 0 : 0;
    const handled = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    const go = (to: number) => {
      const t = Math.max(0, Math.min(pageCount - 1, to));
      const key = pages[t].index;
      if (e.shiftKey) {
        if (anchor.current == null || !posOf.has(anchor.current)) anchor.current = rovingKey ?? key;
        pick(range(posOf.get(anchor.current)!, t));
      } else {
        anchor.current = key;
        if (!compact) pick([key]);
      }
      setFocusKey(key);
      refocus();
      jump(t);
    };
    if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      handled();
      const keys = targets();
      if (keys.size === 0) return;
      const at = [...keys].map((k) => posOf.get(k) ?? 0);
      const gap = e.key === "ArrowUp" ? Math.min(...at) - 1 : Math.max(...at) + 2;
      if (gap < 0 || gap > pageCount) return;
      if (!move(keys, gap)) return;
      if (n === 0 && rovingKey != null) pick([rovingKey]);
      refocus();
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      handled();
      go(pos + (e.key === "ArrowDown" ? 1 : -1));
    } else if (e.key === "Home" || e.key === "End") {
      handled();
      go(e.key === "Home" ? 0 : pageCount - 1);
    } else if (e.key === "Delete" || e.key === "Backspace") {
      handled();
      if (remove()) refocus();
    } else if (mod && e.key.toLowerCase() === "a") {
      handled();
      pick(pages.map((p) => p.index));
    } else if (e.key === " " && !mod) {
      handled();
      if (rovingKey == null) return;
      const s = new Set(selected);
      s.has(rovingKey) ? s.delete(rovingKey) : s.add(rovingKey);
      pick(s);
      anchor.current = rovingKey;
    } else if (e.key === "Enter") {
      handled();
      jump(pos);
      onClose?.();
    } else if (e.key === "Escape" && n > 0) {
      handled();
      pick([]);
    }
  };
  /** The bar goes with the selection, and the focused button with it: send
   * focus back to the page the keyboard was on. */
  const fromBar = (e: ReactMouseEvent, act: () => boolean) => {
    const hadFocus = e.currentTarget === document.activeElement;
    if (act() && hadFocus) refocus();
  };

  return (
    <nav ref={navRef} id="page-rail" className="pagenav" aria-label="Pages">
      <div className="pagenav__head">
        <span className="pagenav__title title-small">Pages</span>
        <span className="pagenav__count label-medium">{pageCount}</span>
        <span className="pagenav__tools">
          <button
            className="icon-btn icon-btn--sm"
            onClick={onGrid}
            aria-label="Grid view"
            aria-haspopup="dialog"
            data-tip="Grid view: merge and extract"
          >
            <Icon name="organize" size={18} />
          </button>
          {onClose && (
            <button className="icon-btn icon-btn--sm" onClick={onClose} aria-label="Close pages" data-tip="Close">
              <Icon name="close" size={18} />
            </button>
          )}
        </span>
      </div>
      {hasOutline && (
        <div
          className="segmented segmented--compact pagenav__views"
          role="tablist"
          aria-label="Sidebar"
          onKeyDown={(e) => {
            const views = ["pages", "outline"] as const;
            const to = segmentKey(e.key, views.indexOf(view), 2);
            if (to == null) return;
            e.preventDefault();
            onView?.(views[to]);
            const tabs = e.currentTarget.querySelectorAll<HTMLElement>("[role=tab]");
            tabs[to]?.focus();
          }}
        >
          {(["pages", "outline"] as const).map((v) => (
            <button
              key={v}
              role="tab"
              tabIndex={view === v ? 0 : -1}
              id={`pagenav-tab-${v}`}
              aria-selected={view === v}
              aria-controls={v === "pages" ? "pagenav-pages" : "pagenav-outline"}
              className={`segmented__btn${view === v ? " segmented__btn--on" : ""}`}
              onClick={() => onView?.(v)}
            >
              {v === "pages" ? "Pages" : "Outline"}
            </button>
          ))}
        </div>
      )}
      {/* Kept mounted while the pages show, so the sections opened stay open. */}
      {hasOutline && (
        <div id="pagenav-outline" className="pagenav__outline" role="tabpanel" aria-labelledby="pagenav-tab-outline" hidden={!showOutline}>
          <OutlineTree
            entries={outline}
            posOf={posOf}
            onGo={(pos) => {
              jump(pos);
              onClose?.();
            }}
          />
        </div>
      )}
      <div
        ref={listRef}
        id="pagenav-pages"
        hidden={showOutline}
        className={`pagenav__list${drag ? " pagenav__list--dragging" : ""}${drag?.gap === pageCount ? " pagenav__list--drop-end" : ""}`}
        role="listbox"
        aria-label="Pages"
        aria-multiselectable="true"
        onKeyDown={onKeyDown}
      >
        {pages.map((p, i) => {
          const on = i === active;
          const sel = selected.has(p.index);
          const cls = [
            "pagenav__item",
            on && "pagenav__item--on",
            sel && "pagenav__item--selected",
            drag?.keys.has(p.index) && "pagenav__item--lifted",
            drag?.gap === i && "pagenav__item--drop",
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <div
              key={p.index}
              data-page-key={p.index}
              className={cls}
              role="option"
              tabIndex={p.index === rovingKey ? 0 : -1}
              aria-selected={sel}
              aria-current={on ? "page" : undefined}
              // The page number is drawn as a chip on the thumbnail, so it is
              // decorative here — the accessible name has to carry it, and say
              // which page is the one you're on.
              aria-label={`Page ${i + 1} of ${pageCount}${on ? " (current)" : ""}`}
              onPointerDown={(e) => onPointerDown(e, p.index)}
              onClick={(e) => onClick(e, p.index, i)}
              onContextMenu={(e) => press.current?.touch && e.preventDefault()}
              onFocus={() => setFocusKey(p.index)}
            >
              <span className="pagenav__thumb">
                <Thumbnail bytes={bytes} index={p.index} rotation={p.rotate} crop={p.crop} />
                <span className="pagenav__num label-small" aria-hidden="true">
                  {i + 1}
                </span>
                {sel && (
                  <span className="pagenav__check" aria-hidden="true">
                    <Icon name="check" size={14} />
                  </span>
                )}
              </span>
            </div>
          );
        })}
      </div>
      {/* Mounted before there is anything to say, so the first count is read. */}
      <span className="sr-only" aria-live="polite">
        {n > 0 ? `${plural(n, "page")} selected` : ""}
      </span>
      {n > 0 && !showOutline && (
        <div className="pagenav__bar" role="toolbar" aria-label="Selected pages">
          {/* The rail is narrow: a tick and the number, read out in full. */}
          <span className="pagenav__picked label-large" aria-hidden="true">
            <Icon name="check" size={16} />
            {n}
          </span>
          <button className="icon-btn icon-btn--sm" onClick={() => turn()} aria-label="Rotate selected pages" data-tip="Rotate">
            <Icon name="rotate" size={18} />
          </button>
          <button
            className="icon-btn icon-btn--sm"
            onClick={(e) => fromBar(e, remove)}
            disabled={all}
            aria-label="Delete selected pages"
            data-tip={all ? "A document keeps at least one page" : "Delete"}
          >
            <Icon name="delete" size={18} />
          </button>
          <button className="icon-btn icon-btn--sm" onClick={(e) =>
              fromBar(e, () => {
                pick([]);
                return true;
              })
            }
            aria-label="Clear page selection" data-tip="Clear selection">
            <Icon name="close" size={18} />
          </button>
        </div>
      )}
    </nav>
  );
}
