import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./Icon";

export interface Command {
  id: string;
  label: string;
  /** Right-aligned hint (shortcut or group). */
  hint?: string;
  icon?: string;
  /** Extra words to match against. */
  keywords?: string;
  run: () => void;
  disabled?: boolean;
}

interface Props {
  commands: Command[];
  onClose: () => void;
}

/** Fuzzy-ish (substring, all-terms) filter over label + keywords. */
function match(cmd: Command, q: string): boolean {
  if (!q) return true;
  const hay = `${cmd.label} ${cmd.hint ?? ""} ${cmd.keywords ?? ""}`.toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .every((term) => hay.includes(term));
}

/** Command palette (Ctrl/⌘+K) — one keyboard-first home for every action. */
export function CommandPalette({ commands, onClose }: Props) {
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const results = useMemo(
    () => commands.filter((c) => !c.disabled && match(c, q)),
    [commands, q],
  );

  useEffect(() => inputRef.current?.focus(), []);
  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>('[data-active="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const runAt = (i: number) => {
    const cmd = results[i];
    if (!cmd) return;
    onClose();
    cmd.run();
  };

  return (
    <div className="cmdk-scrim" onPointerDown={onClose}>
      <div
        className="cmdk"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="cmdk__search">
          <Icon name="command" size={18} className="cmdk__icon" />
          <input
            ref={inputRef}
            className="cmdk__input"
            placeholder="Type a command…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((i) => Math.min(results.length - 1, i + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((i) => Math.max(0, i - 1));
              } else if (e.key === "Enter") {
                e.preventDefault();
                runAt(active);
              } else if (e.key === "Escape") {
                e.preventDefault();
                onClose();
              }
            }}
          />
        </div>
        <div className="cmdk__list" role="listbox" ref={listRef}>
          {results.length === 0 && <div className="cmdk__empty">No matching commands</div>}
          {results.map((c, i) => (
            <button
              key={c.id}
              className={`cmdk__item${i === active ? " cmdk__item--on" : ""}`}
              data-active={i === active}
              role="option"
              aria-selected={i === active}
              onPointerEnter={() => setActive(i)}
              onClick={() => runAt(i)}
            >
              {c.icon && <Icon name={c.icon} size={18} />}
              <span className="cmdk__label">{c.label}</span>
              {c.hint && <span className="cmdk__hint label-medium">{c.hint}</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
