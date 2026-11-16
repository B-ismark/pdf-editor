import { useCallback, useEffect, useRef, type KeyboardEvent } from "react";
import { Icon } from "./Icon";

export interface DocTab {
  id: string;
  name: string;
  /** Unsaved work — the tab carries a dot, and closing it asks first. */
  dirty: boolean;
}

interface Props {
  tabs: DocTab[];
  activeId: string | null;
  /** Switching is refused while an export/OCR/load is running on the
   * document in front: that work belongs to it and would land on another. */
  disabled: boolean;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onOpen: () => void;
}

/**
 * The open documents, one tab each, plus the way to open another.
 *
 * Deliberately a `nav` of buttons with `aria-current`, not an ARIA tablist: each
 * tab carries its own close button, and a `role="tab"` may not contain another
 * interactive element. Arrow keys still move between documents, the way a tab
 * strip is expected to behave.
 *
 * The close glyph is always present (not hover-only): on a touch screen there
 * is no hover, and a control that exists only under a mouse is a control a phone
 * user can't find.
 */
export function DocTabs({ tabs, activeId, disabled, onSelect, onClose, onOpen }: Props) {
  const refocus = useRef(false);
  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLElement>) => {
      const i = tabs.findIndex((t) => t.id === activeId);
      if (i < 0) return;
      let next = -1;
      if (e.key === "ArrowRight") next = (i + 1) % tabs.length;
      else if (e.key === "ArrowLeft") next = (i - 1 + tabs.length) % tabs.length;
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = tabs.length - 1;
      else if (e.key === "Delete" && activeId) {
        e.preventDefault();
        // Closing removes the focused button; the keyboard has to land on the
        // tab that takes its place, not on <body>, or the next arrow does nothing.
        refocus.current = true;
        onClose(activeId);
        return;
      }
      if (next < 0 || disabled) return;
      e.preventDefault();
      const id = tabs[next].id;
      onSelect(id);
      // Focus follows, synchronously, for the same reason as the Inspector's
      // tabs: the next keystroke has to land on the tab this one moved to.
      e.currentTarget
        .querySelector<HTMLElement>(`[data-doc-tab="${CSS.escape(id)}"]`)
        ?.focus();
    },
    [tabs, activeId, disabled, onSelect, onClose],
  );

  // The strip scrolls sideways once it's full (always, on a phone), so the tab
  // in front has to be brought into view whenever it changes — a new document
  // opens at the end, past the edge.
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!activeId) return;
    listRef.current
      ?.querySelector(`[data-doc-tab="${CSS.escape(activeId)}"]`)
      ?.closest(".doctab")
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeId, tabs.length]);

  useEffect(() => {
    if (!refocus.current || !activeId) return;
    refocus.current = false;
    listRef.current?.querySelector<HTMLElement>(`[data-doc-tab="${CSS.escape(activeId)}"]`)?.focus();
  }, [activeId, tabs]);

  return (
    <nav className="doctabs" aria-label="Open documents">
      <div className="doctabs__list" ref={listRef} onKeyDown={onKeyDown}>
        {tabs.map((t) => {
          const active = t.id === activeId;
          return (
            <div key={t.id} className={`doctab${active ? " doctab--active" : ""}`}>
              <button
                type="button"
                className="doctab__btn"
                data-doc-tab={t.id}
                aria-current={active ? "page" : undefined}
                // One stop in the tab order for the strip; arrows do the rest.
                tabIndex={active ? 0 : -1}
                aria-keyshortcuts="ArrowLeft ArrowRight Home End Delete"
                disabled={disabled && !active}
                onClick={() => onSelect(t.id)}
                onAuxClick={(e) => {
                  // Middle-click closes, as it does on every tab strip people
                  // already know.
                  if (e.button === 1) {
                    e.preventDefault();
                    onClose(t.id);
                  }
                }}
                data-tip={t.dirty ? `${t.name} · unsaved changes` : t.name}
              >
                <Icon name="picture_as_pdf" size={15} className="doctab__icon" />
                <span className="doctab__name label-large">{t.name}</span>
                {t.dirty && (
                  <span className="doctab__dirty" aria-label="unsaved changes" role="img" />
                )}
              </button>
              <button
                type="button"
                className="doctab__close"
                tabIndex={-1}
                onClick={() => onClose(t.id)}
                aria-label={`Close ${t.name}`}
                data-tip="Close · Delete"
                disabled={disabled && active}
              >
                <Icon name="close" size={14} />
              </button>
            </div>
          );
        })}
      </div>
      <button
        type="button"
        className="icon-btn doctabs__add"
        onClick={onOpen}
        disabled={disabled}
        aria-label="Open another PDF in a new tab"
        data-tip="Open PDF · Ctrl+O"
      >
        <Icon name="add" size={18} />
      </button>
    </nav>
  );
}
