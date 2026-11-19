import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./Icon";

/** Where a command belongs. The palette files its rows under it, as the ⋯
 * and Export menus do — one taxonomy, so a command can't be "Text" in one
 * place and "Finish" in another. */
export type CommandGroup =
  | "tools"
  | "draw"
  | "selection"
  | "edit"
  | "navigate"
  | "view"
  | "organise"
  | "text"
  | "finish"
  | "export"
  | "settings"
  | "file"
  | "documents";

export const GROUP_LABEL: Record<CommandGroup, string> = {
  tools: "Tool",
  draw: "Draw",
  selection: "Selection",
  edit: "Edit",
  navigate: "Go",
  view: "View",
  organise: "Organise",
  text: "Text",
  finish: "Finish",
  export: "Export",
  settings: "Settings",
  file: "File",
  documents: "Documents",
};

/**
 * One entry of the command registry (`commands` in `DocumentEditor.tsx`).
 *
 * Every command the app has is declared once, here-shaped, and every surface
 * that lists commands renders from that one list: the palette shows all of it,
 * the ⋯ menu and the Export menu pick their groups out of it. A label, icon,
 * shortcut or "this opens something" mark set here is the same everywhere, and
 * a command added here is in the palette without anyone remembering to add it.
 */
export interface Command {
  id: string;
  group: CommandGroup;
  label: string;
  icon?: string;
  /** Keyboard shortcut, as shown (e.g. "Ctrl+Z"). */
  shortcut?: string;
  /** Extra words to match against. */
  keywords?: string;
  /** Set when running this opens something rather than doing it, so every
   * surface marks it the same way. */
  opens?: "dialog" | "toolbar";
  /** A setting that is on or off: shown with a check, announced as checked. */
  checked?: boolean;
  /** A setting with a current value (Theme: Dark), shown beside the label. */
  value?: string;
  /** What it does, where the label alone doesn't say (a tooltip in the menus). */
  detail?: string;
  /** Exists but can't run right now (a file is being made). Greyed in a
   * menu; left out of the palette, which only lists what will run. */
  disabled?: boolean;
  /** Doesn't apply in this state (no selection to align). Not listed. */
  hidden?: boolean;
  /** In a menu, running it leaves the menu open so the change can be seen
   * (cycling the theme). */
  stays?: boolean;
  run: () => void;
}

interface Props {
  commands: Command[];
  onClose: () => void;
}

/** A shortcut as shown ("Ctrl+D", "Del") in `aria-keyshortcuts` form
 * ("Control+D", "Delete"). The visible hint is hidden from the accessible
 * name, so a row is announced by its label and its keys come from here. */
export function ariaKeys(shortcut: string | undefined): string | undefined {
  if (!shortcut) return undefined;
  return shortcut
    .replace(/\bCtrl\b/g, "Control")
    .replace(/^Del$/, "Delete")
    .replace(/^Esc$/, "Escape");
}

/** Fuzzy-ish (substring, all-terms) filter over label + keywords. */
function match(cmd: Command, q: string): boolean {
  if (!q) return true;
  const hay = `${cmd.label} ${cmd.value ?? ""} ${GROUP_LABEL[cmd.group]} ${cmd.shortcut ?? ""} ${cmd.keywords ?? ""}`.toLowerCase();
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

  // Filed under their groups, each group where its first command stands in
  // the registry. The right-hand column is for keys alone: it used to show a
  // command's group when it had no shortcut, so "V" and "Draw" stood in one
  // column as if they were the same kind of thing.
  const sections = useMemo(() => {
    const by = new Map<CommandGroup, Command[]>();
    for (const c of commands) {
      if (c.disabled || c.hidden || !match(c, q)) continue;
      const list = by.get(c.group);
      if (list) list.push(c);
      else by.set(c.group, [c]);
    }
    return [...by].map(([group, cmds]) => ({ group, cmds }));
  }, [commands, q]);
  // Arrow keys walk the rows in the order they are shown.
  const results = useMemo(() => sections.flatMap((s) => s.cmds), [sections]);

  // Focus goes back where it was when the palette closes, before the command
  // runs, so a command that moves focus itself (Find) still wins and one that
  // doesn't (Next match, Zoom in) leaves it where the person was, not on <body>.
  const returnTo = useRef<HTMLElement | null>(null);
  useEffect(() => {
    returnTo.current = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
  }, []);
  const close = () => {
    onClose();
    const back = returnTo.current;
    if (back && back.isConnected && back !== document.body) back.focus({ preventScroll: true });
  };
  useEffect(() => setActive(0), [q]);
  // Whether the highlight last moved by the arrow keys rather than the pointer.
  const byKeys = useRef(false);
  useEffect(() => {
    const row = listRef.current?.querySelector<HTMLElement>('[data-active="true"]');
    if (!row) return;
    // The first row of a group brings its heading with it, so walking up into
    // a group shows what the group is. Not under the pointer: the list would
    // slide beneath it.
    const group = row.closest('[role="group"]');
    if (byKeys.current && group && group.querySelector('[role="option"]') === row) {
      group.firstElementChild?.scrollIntoView({ block: "nearest" });
    }
    row.scrollIntoView({ block: "nearest" });
  }, [active]);

  const runAt = (i: number) => {
    // The list can shrink under the highlight while open (a file starts being
    // made and the exports go), so Enter runs the last row rather than nothing.
    const cmd = results[Math.min(i, results.length - 1)];
    if (!cmd) return;
    close();
    cmd.run();
  };

  return (
    <div className="cmdk-scrim" onPointerDown={close}>
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
            role="combobox"
            aria-label="Search commands"
            aria-expanded="true"
            aria-controls="cmdk-list"
            aria-activedescendant={results[active] ? `cmdk-o-${results[active].id}` : undefined}
            placeholder="Type a command…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                byKeys.current = true;
                setActive((i) => Math.min(results.length - 1, i + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                byKeys.current = true;
                setActive((i) => Math.max(0, i - 1));
              } else if (e.key === "Enter") {
                e.preventDefault();
                runAt(active);
              } else if (e.key === "Escape") {
                e.preventDefault();
                // Backing out of the palette is all this Escape does. Let
                // through, the editor's own Escape cleared the selection the
                // palette's Selection commands were about to act on.
                e.stopPropagation();
                close();
              }
            }}
          />
        </div>
        <div className="cmdk__list" id="cmdk-list" role="listbox" aria-label="Commands" ref={listRef}>
          {results.length === 0 && <div className="cmdk__empty">No matching commands</div>}
          {sections.map(({ group, cmds }) => (
            <div key={group} role="group" aria-labelledby={`cmdk-g-${group}`} className="cmdk__group">
              <div id={`cmdk-g-${group}`} className="cmdk__heading label-small" aria-hidden="true">
                {GROUP_LABEL[group]}
              </div>
              {cmds.map((c) => {
                const i = results.indexOf(c);
                return (
                  <button
                    key={c.id}
                    id={`cmdk-o-${c.id}`}
                    className={`cmdk__item${i === active ? " cmdk__item--on" : ""}`}
                    data-active={i === active}
                    data-cmd={c.id}
                    data-group={c.group}
                    role="option"
                    aria-selected={i === active}
                    aria-checked={c.checked}
                    aria-keyshortcuts={ariaKeys(c.shortcut)}
                    onPointerEnter={() => {
                      byKeys.current = false;
                      setActive(i);
                    }}
                    onClick={() => runAt(i)}
                  >
                    {c.icon && <Icon name={c.icon} size={18} />}
                    <span className="cmdk__label">{c.label}</span>
                    {c.value && <span className="cmdk__value label-medium">{c.value}</span>}
                    {c.checked && <Icon name="check" size={16} className="cmdk__check" />}
                    {c.shortcut && (
                      <kbd className="cmdk__hint label-medium" aria-hidden="true">
                        {c.shortcut}
                      </kbd>
                    )}
                    {/* The dialog mark is for dialogs only: Draw opens a
                        toolbar, which the dock marks its own way. */}
                    {c.opens === "dialog" && <Icon name="opens_dialog" size={16} className="opens-mark" />}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
