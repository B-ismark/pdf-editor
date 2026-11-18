import { useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Icon } from "./Icon";
import type { OutlineEntry } from "../pdf/outline";

interface Props {
  entries: OutlineEntry[];
  /** Source page index → its position in the document as shown. A page that
   * isn't there (deleted) has no position. */
  posOf: ReadonlyMap<number, number>;
  /** Go to a shown position. */
  onGo: (pos: number) => void;
}

interface Row {
  key: string;
  entry: OutlineEntry;
  level: number;
  parent: string | null;
  open: boolean;
}

/**
 * The document's own bookmarks as a tree. A bookmark goes to its page as the
 * document is now arranged (after moves), says so with the page number beside
 * it, and is shown but can't be followed when its page was deleted or it opens
 * nothing in this document. Keyboard: ↑/↓ between rows, → opens (or steps in),
 * ← closes (or steps out), Home/End, Enter goes.
 */
export function OutlineTree({ entries, posOf, onGo }: Props) {
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const rows = useMemo(() => {
    const out: Row[] = [];
    const add = (items: OutlineEntry[], level: number, parent: string | null) =>
      items.forEach((entry, i) => {
        const key = parent == null ? `${i}` : `${parent}.${i}`;
        const isOpen = open.has(key) && entry.items.length > 0;
        out.push({ key, entry, level, parent, open: isOpen });
        if (isOpen) add(entry.items, level + 1, key);
      });
    add(entries, 1, null);
    return out;
  }, [entries, open]);

  const roving = rows.some((r) => r.key === focusKey) ? focusKey : rows[0]?.key ?? null;

  const toggle = (key: string, to?: boolean) =>
    setOpen((s) => {
      const n = new Set(s);
      if (to ?? !n.has(key)) n.add(key);
      else n.delete(key);
      return n;
    });

  const focusRow = (key: string) => {
    setFocusKey(key);
    // After the render that may have just added the row.
    requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>(`[data-outline-key="${key}"]`)?.focus());
  };

  const go = (entry: OutlineEntry) => {
    const pos = entry.page == null ? undefined : posOf.get(entry.page);
    if (pos != null) onGo(pos);
  };

  const onKeyDown = (e: ReactKeyboardEvent) => {
    const at = rows.findIndex((r) => r.key === roving);
    if (at < 0) return;
    const row = rows[at];
    const handled = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      handled();
      const to = rows[Math.max(0, Math.min(rows.length - 1, at + (e.key === "ArrowDown" ? 1 : -1)))];
      focusRow(to.key);
    } else if (e.key === "Home" || e.key === "End") {
      handled();
      focusRow(rows[e.key === "Home" ? 0 : rows.length - 1].key);
    } else if (e.key === "ArrowRight") {
      handled();
      if (row.entry.items.length === 0) return;
      if (!row.open) toggle(row.key, true);
      else focusRow(`${row.key}.0`);
    } else if (e.key === "ArrowLeft") {
      handled();
      if (row.open) toggle(row.key, false);
      else if (row.parent != null) focusRow(row.parent);
    } else if (e.key === "Enter" || e.key === " ") {
      handled();
      go(row.entry);
    }
  };

  return (
    <div ref={listRef} className="outline" role="tree" aria-label="Outline" onKeyDown={onKeyDown}>
      {rows.map((r) => {
        const pos = r.entry.page == null ? undefined : posOf.get(r.entry.page);
        const gone = r.entry.page != null && pos == null;
        const dead = pos == null;
        const has = r.entry.items.length > 0;
        const note = gone ? "page deleted" : dead ? "no page in this document" : `page ${pos + 1}`;
        return (
          <div
            key={r.key}
            data-outline-key={r.key}
            className={`outline__row${dead ? " outline__row--dead" : ""}`}
            role="treeitem"
            aria-level={r.level}
            aria-expanded={has ? r.open : undefined}
            aria-disabled={dead || undefined}
            aria-label={`${r.entry.title}, ${note}`}
            tabIndex={r.key === roving ? 0 : -1}
            style={{ paddingInlineStart: `${4 + (r.level - 1) * 14}px` }}
            onFocus={() => setFocusKey(r.key)}
            onClick={() => {
              setFocusKey(r.key);
              go(r.entry);
            }}
          >
            {has ? (
              <span
                className={`outline__twisty${r.open ? " outline__twisty--open" : ""}`}
                aria-hidden="true"
                onClick={(e) => {
                  e.stopPropagation();
                  setFocusKey(r.key);
                  toggle(r.key);
                }}
              >
                <Icon name="chevron_right" size={16} />
              </span>
            ) : (
              <span className="outline__twisty" aria-hidden="true" />
            )}
            <span className="outline__title body-medium">{r.entry.title}</span>
            <span className="outline__page label-small" aria-hidden="true" data-tip={gone ? "This page was deleted" : undefined}>
              {gone ? "–" : dead ? "" : pos + 1}
            </span>
          </div>
        );
      })}
    </div>
  );
}
